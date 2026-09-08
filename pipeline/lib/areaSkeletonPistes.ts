/**
 * Turn synthesised area skeletons into synthetic `NormPiste`s that `buildResortGraph` can consume.
 *
 * The alternative - inserting edges into an already-built `ResortGraph` and deleting the rim edges - 
 * would mean re-implementing node clustering, way segmentation, descent orientation, flat-traverse
 * handling and `srcWayId` tagging outside `buildGraph.ts`, and keeping them in step forever. Feeding
 * the skeleton in as ways instead makes all of that fall out of code that already exists and is
 * already tested:
 *
 *  - **the rim disappears** because the polygon way is simply not passed on; no edge surgery;
 *  - **portals stay connected** because a portal vertex keeps its real OSM `osmId`, so
 *    `buildCanonicalNodes` clusters it with the outside piste that shares it;
 *  - **portals keep their node id** because a cluster is named after its smallest `osmId` and
 *    synthetic ids are allocated above every real one;
 *  - **the spine splits at each arm** because the junction is emitted as a *shared* vertex on both
 *    ways, which makes it significant (`wayCount >= 2`) and `segmentWay` breaks the line there.
 */
import type { NormPiste, NormPoint } from './normalize';
import type { PolyResult } from './areaSkeleton';

/**
 * First synthetic `osmId`. Above every real OSM node id (the largest in use is ~1.3e10) so a portal
 * cluster is always named after its *real* id - node names stay greppable in OSM, and id-based
 * entries in `overrides/<id>.json` keep working.
 */
const SYNTH_BASE = 1e12;

/** Douglas-Peucker tolerance for skeleton geometry, per plan §3 step 4. */
const SIMPLIFY_M = 5;

/**
 * How close an arm's terminal point must come to a spine to be welded onto it. Arms are already
 * clipped to within `ARM_CLIP_M` (1 m) of the spine and every resort reports `maxGap 0m`, so this
 * is slack, not a search radius.
 */
const WELD_M = 2;

/**
 * How close a vertex must be to another line's terminal point to count as the junction between them
 * and be locked against simplification. The engine clips an arm to within `ARM_CLIP_M` (1 m) of what
 * it joins, so 1 m is the tightest value that still catches every genuine junction.
 */
const JUNCTION_M = 1;

type LL = [number, number];

function mx(lat: number): number {
  return Math.cos((lat * Math.PI) / 180) * 111320;
}

/** Douglas-Peucker that never drops a locked vertex, so welded junctions survive simplification. */
function simplify(pts: LL[], tolM: number, locked?: Set<number>): LL[] {
  if (pts.length < 3) return pts;
  const k = mx(pts[0][1]);
  const X = pts.map((p) => p[0] * k);
  const Y = pts.map((p) => p[1] * 110540);
  const keep = new Uint8Array(pts.length);
  keep[0] = 1;
  keep[pts.length - 1] = 1;
  if (locked) for (const i of locked) if (i >= 0 && i < pts.length) keep[i] = 1;
  // Run the recursion between consecutive locked vertices, which is what keeps them.
  const anchors: number[] = [];
  for (let i = 0; i < pts.length; i++) if (keep[i]) anchors.push(i);
  const stack: [number, number][] = [];
  for (let i = 1; i < anchors.length; i++) stack.push([anchors[i - 1], anchors[i]]);
  while (stack.length) {
    const [a, b] = stack.pop()!;
    if (b - a < 2) continue;
    const vx = X[b] - X[a];
    const vy = Y[b] - Y[a];
    const L = vx * vx + vy * vy;
    let best = -1;
    let bi = -1;
    for (let i = a + 1; i < b; i++) {
      const t = L > 0 ? Math.max(0, Math.min(1, ((X[i] - X[a]) * vx + (Y[i] - Y[a]) * vy) / L)) : 0;
      const d = Math.hypot(X[a] + vx * t - X[i], Y[a] + vy * t - Y[i]);
      if (d > best) {
        best = d;
        bi = i;
      }
    }
    if (best > tolM) {
      keep[bi] = 1;
      stack.push([a, bi], [bi, b]);
    }
  }
  return pts.filter((_, i) => keep[i]);
}

/** A polyline an arm may weld onto, plus the insertions queued against it. */
interface Target {
  pts: NormPoint[];
  /** Pending vertex insertions, applied once every weld has been located. */
  ins: { segIdx: number; t: number; pt: NormPoint; armPt?: NormPoint }[];
}

function project(q: LL, target: Target): { segIdx: number; t: number; at: LL; d: number } | null {
  const k = mx(q[1]);
  let best: { segIdx: number; t: number; at: LL; d: number } | null = null;
  for (let i = 1; i < target.pts.length; i++) {
    const a = target.pts[i - 1];
    const b = target.pts[i];
    const ax = a.lon * k;
    const ay = a.lat * 110540;
    const vx = b.lon * k - ax;
    const vy = b.lat * 110540 - ay;
    const L = vx * vx + vy * vy;
    const t = L > 0 ? Math.max(0, Math.min(1, ((q[0] * k - ax) * vx + (q[1] * 110540 - ay) * vy) / L)) : 0;
    const px = ax + vx * t;
    const py = ay + vy * t;
    const d = Math.hypot(px - q[0] * k, py - q[1] * 110540);
    if (!best || d < best.d) best = { segIdx: i, t, at: [px / k, py / 110540], d };
  }
  return best;
}

export interface SkeletonPistes {
  /** Synthetic ways to hand to `buildResortGraph` in place of the polygons. */
  pistes: NormPiste[];
  /** Polygon way ids whose rim is now represented by a skeleton and must not be passed on. */
  replaced: Set<number>;
  /** Every vertex that needs a real elevation fetch (plan §4b: never interpolate these). */
  newPoints: NormPoint[];
  welds: number;
  /** Arms whose terminal point found no spine to weld onto - must be 0. */
  unwelded: number;
}

/**
 * @param results  skeletons from `buildSkeletons`
 * @param pistes   the resort's normalised ways. **Mutated**: welding an arm onto a real centreline
 *                 inserts a vertex into that way. The inserted point is exactly on the existing
 *                 segment, so the geometry is unchanged - it only creates a node to split at.
 */
export function skeletonPistes(results: PolyResult[], pistes: NormPiste[]): SkeletonPistes {
  const byWay = new Map<number, NormPiste>();
  for (const p of pistes) byWay.set(p.wayId, p);

  let nextId = SYNTH_BASE;
  const fresh = (): number => nextId++;
  /**
   * Portals with no OSM node of their own: invented gateways (`gw…`) and snap nodes (`sn…`, minted
   * inside the graph build). Keyed by portal id so the two polygons meeting at a gateway allocate
   * the *same* id - otherwise each grows an arm to its own private node and the crossing that the
   * gateway exists to create silently does not happen.
   */
  const synthPortal = new Map<string, number>();
  const portalOsmId = (portalId: string): number => {
    const m = /^n(\d+)$/.exec(portalId);
    if (m) return Number(m[1]);
    let id = synthPortal.get(portalId);
    if (id == null) {
      id = fresh();
      synthPortal.set(portalId, id);
    }
    return id;
  };

  const out: NormPiste[] = [];
  const replaced = new Set<number>();
  const targets: Target[] = [];
  const realTargets = new Map<number, Target>();
  let welds = 0;
  let unwelded = 0;

  const mkPoint = (ll: LL, osmId: number): NormPoint => ({ osmId, lon: ll[0], lat: ll[1], ele: null });

  const emit = (poly: NormPiste, coords: LL[], ids: (number | null)[], skeletonArm = false): Target | null => {
    if (coords.length < 2) return null;
    const pts = coords.map((ll, i) => mkPoint(ll, ids[i] ?? fresh()));
    out.push({
      wayId: poly.wayId,
      color: poly.color,
      name: poly.name,
      ref: poly.ref,
      skeletonArm: skeletonArm || undefined,
      // NOT `area: true`: emit.ts drops area edges from geo.json, so these would route but never
      // render, breaking the "every route leg lies on a rendered line" invariant.
      area: false,
      points: pts,
    });
    const t: Target = { pts, ins: [] };
    targets.push(t);
    return t;
  };

  // Pass 1: lay down the spines and stitches, so arms have something to weld onto.
  const own = new Map<number, Target[]>();
  const lockers = new Map<number, (c: LL[]) => Set<number>>();
  for (const r of results) {
    const poly = byWay.get(r.wayId);
    if (!poly) continue;
    // Simplification must not move a line away from a point another line ends on. Arms terminate on
    // a spine or, where portals share an approach, on a *hub arm* - so every arm tip is a junction
    // that has to survive Douglas-Peucker, or the weld misses by up to the tolerance.
    const tips = r.skel.arms.map((a) => a.coords[a.coords.length - 1]);
    const lockTips = (coords: LL[]): Set<number> => {
      const s = new Set<number>();
      const k = mx(coords[0][1]);
      for (let i = 0; i < coords.length; i++) {
        for (const t of tips) {
          if (Math.hypot((coords[i][0] - t[0]) * k, (coords[i][1] - t[1]) * 110540) < JUNCTION_M) {
            s.add(i);
            break;
          }
        }
      }
      return s;
    };
    lockers.set(r.wayId, lockTips);
    const mine: Target[] = [];
    for (const s of r.skel.synthSpines) {
      const t = emit(poly, simplify(s, SIMPLIFY_M, lockTips(s)), []);
      if (t) mine.push(t);
    }
    for (const s of r.skel.stitches) {
      const t = emit(poly, s, []);
      if (t) mine.push(t);
    }
    // Classes A/B′ reuse a real OSM centreline, which is already a way in its own right.
    for (const w of r.spineWayIds) {
      const rp = byWay.get(w);
      if (!rp) continue;
      let t = realTargets.get(w);
      if (!t) {
        t = { pts: rp.points, ins: [] };
        realTargets.set(w, t);
      }
      mine.push(t);
    }
    own.set(r.wayId, mine);
    if (mine.length) replaced.add(r.wayId);
  }

  // Pass 2a: lay every arm down. Not all of them end on a spine — where several portals share one
  // approach the engine routes them through a *local hub*, so the secondary arms terminate on a hub
  // arm. Emitting first and welding second means an arm is always available as a weld target, so one
  // arm that fails to attach can no longer take its dependents down with it.
  interface Laid {
    r: PolyResult;
    arm: PolyResult['skel']['arms'][number];
    t: Target | null;
    tip: LL;
  }
  const laid: Laid[] = [];
  for (const r of results) {
    const poly = byWay.get(r.wayId);
    const mine = own.get(r.wayId);
    if (!poly || !mine?.length) continue;
    for (const arm of r.skel.arms) {
      const tip = arm.coords[arm.coords.length - 1];
      if (arm.coords.length === 1) {
        // The portal already sits on the spine: there is no arm to draw, only a node to create.
        laid.push({ r, arm, t: null, tip });
        continue;
      }
      const simplified = simplify(arm.coords, SIMPLIFY_M, lockers.get(r.wayId)?.(arm.coords));
      const ids: (number | null)[] = simplified.map(() => null);
      ids[0] = portalOsmId(arm.portalId);
      const t = emit(poly, simplified, ids, true);
      if (!t) continue;
      mine.push(t);
      laid.push({ r, arm, t, tip });
    }
  }

  // Pass 2b: weld each arm's tip onto the nearest thing in its own polygon that is not itself.
  for (const l of laid) {
    const mine = own.get(l.r.wayId)!;
    let best: { t: Target; p: NonNullable<ReturnType<typeof project>> } | null = null;
    for (const t of mine) {
      if (t === l.t) continue;
      const pr = project(l.tip, t);
      if (pr && (!best || pr.d < best.p.d)) best = { t, p: pr };
    }
    if (!best || best.p.d > WELD_M) {
      unwelded++;
      if (process.env.WELDDIAG) {
        // Distinguish "my simplification lost the junction" from "the engine never produced one": if
        // the tip is just as far from the RAW skeleton geometry, the defect is upstream.
        const raw: LL[][] = [
          ...l.r.skel.synthSpines,
          ...l.r.skel.stitches,
          ...l.r.skel.arms.map((a) => a.coords),
        ];
        let dRaw = Infinity;
        const k = mx(l.tip[1]);
        for (const line of raw) {
          if (line === l.arm.coords) continue;
          for (const c of line) dRaw = Math.min(dRaw, Math.hypot((c[0] - l.tip[0]) * k, (c[1] - l.tip[1]) * 110540));
        }
        console.log(
          `    unwelded w${l.r.wayId} portal=${l.arm.portalId} pts=${l.arm.coords.length} ` +
            `nearest=${best ? best.p.d.toFixed(1) : 'inf'}m rawVertex=${dRaw.toFixed(1)}m targets=${mine.length}`,
        );
      }
      continue;
    }
    if (!l.t) {
      best.t.ins.push({ segIdx: best.p.segIdx, t: best.p.t, pt: mkPoint(best.p.at, portalOsmId(l.arm.portalId)) });
      welds++;
      continue;
    }
    // Snap the arm's tip exactly onto the target and give both ends the same osmId, so the two ways
    // meet at one node instead of merely passing close to one another.
    const armPt = l.t.pts[l.t.pts.length - 1];
    armPt.lon = best.p.at[0];
    armPt.lat = best.p.at[1];
    best.t.ins.push({ segIdx: best.p.segIdx, t: best.p.t, pt: mkPoint(best.p.at, armPt.osmId), armPt });
    welds++;
  }

  // Pass 3: apply the insertions. Back to front so earlier indices stay valid. A weld that lands on
  // a vertex that is already there re-uses it rather than adding a duplicate - and an arm *adopts*
  // that vertex's id rather than renaming it, because overwriting would rewrite a real OSM node id
  // into a synthetic one and detach it from every other way that shares it.
  for (const t of [...targets, ...realTargets.values()]) {
    t.ins.sort((a, b) => b.segIdx - a.segIdx || b.t - a.t);
    for (const i of t.ins) {
      const k = mx(i.pt.lat);
      const near = (q: NormPoint): boolean =>
        Math.hypot((q.lon - i.pt.lon) * k, (q.lat - i.pt.lat) * 110540) < 0.05;
      const hit = near(t.pts[i.segIdx - 1]) ? t.pts[i.segIdx - 1] : near(t.pts[i.segIdx]) ? t.pts[i.segIdx] : null;
      if (hit) {
        if (i.armPt) {
          i.armPt.osmId = hit.osmId;
          i.armPt.lon = hit.lon;
          i.armPt.lat = hit.lat;
          continue;
        }
        // A portal weld has no arm to adjust: the portal must itself become the vertex. Only a
        // synthetic vertex may be renamed to it.
        if (hit.osmId === i.pt.osmId) continue;
        if (hit.osmId >= SYNTH_BASE) {
          hit.osmId = i.pt.osmId;
          continue;
        }
      }
      t.pts.splice(i.segIdx, 0, i.pt);
    }
  }

  // `newPoints` is derived from what actually survived, not from what was created: an insertion that
  // landed on an existing vertex is dropped in pass 3, and fetching elevation for a discarded point
  // would be wasted API budget.
  const live: NormPoint[] = [];
  const seen = new Set<NormPoint>();
  const collect = (pts: NormPoint[]): void => {
    for (const p of pts) if (p.ele == null && !seen.has(p)) {
      seen.add(p);
      live.push(p);
    }
  };
  for (const w of out) collect(w.points);
  for (const t of realTargets.values()) collect(t.pts);

  return { pistes: out, replaced, newPoints: live, welds, unwelded };
}

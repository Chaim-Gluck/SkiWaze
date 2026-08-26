// Graph assembly: significant-node detection, 3D snapping/merge, way segmentation,
// piste / lift / connector / flat edge construction, and meaningful-point extraction.
import type {
  DataWarning,
  GeoPoint,
  GraphEdge,
  GraphNode,
  LiftType,
  MeaningfulPoint,
  ResortGraph,
} from '../../src/types/domain';
import { DOWNLOADABLE_LIFT_TYPES } from '../../src/types/domain';
import type { GraphConstants } from '../../src/config/graphConstants';
import { haversineM, polylineLength3dM } from '../../src/utils/geo';
import type { NormPiste, NormLift, NormPoint } from './normalize';
import { inheritUnratedPisteColors } from './inferColors';

// ---- Union-Find -----------------------------------------------------------
class UnionFind {
  private parent = new Map<string, string>();
  find(x: string): string {
    let root = x;
    while (this.parent.get(root) !== undefined && this.parent.get(root) !== root) {
      root = this.parent.get(root)!;
    }
    if (this.parent.get(x) === undefined) this.parent.set(x, x);
    let cur = x;
    while (cur !== root) {
      const next = this.parent.get(cur)!;
      this.parent.set(cur, root);
      cur = next;
    }
    return root;
  }
  union(a: string, b: string): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent.set(ra, rb);
  }
}

function toGeo(p: NormPoint): GeoPoint {
  return { lon: p.lon, lat: p.lat, ele: p.ele };
}

/** Project point p onto segment a-b; returns the closest point, its distance (m), and t in [0,1]. */
function projectOnSegment(
  p: GeoPoint,
  a: GeoPoint,
  b: GeoPoint,
): { point: GeoPoint; dist: number; t: number } {
  const mLat = 111320;
  const mLon = 111320 * Math.cos((p.lat * Math.PI) / 180);
  const ax = (a.lon - p.lon) * mLon;
  const ay = (a.lat - p.lat) * mLat;
  const bx = (b.lon - p.lon) * mLon;
  const by = (b.lat - p.lat) * mLat;
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy || 1;
  let t = -(ax * dx + ay * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  const cx = ax + t * dx;
  const cy = ay + t * dy;
  const dist = Math.hypot(cx, cy);
  const lon = a.lon + t * (b.lon - a.lon);
  const lat = a.lat + t * (b.lat - a.lat);
  const ele = a.ele != null && b.ele != null ? a.ele + t * (b.ele - a.ele) : (a.ele ?? b.ele ?? null);
  return { point: { lon, lat, ele }, dist, t };
}

interface Provisional {
  osmId: number;
  lon: number;
  lat: number;
  ele: number | null;
  isLiftStation: boolean;
  /**
   * Set when the grid is holding already-built graph nodes rather than raw OSM points, so the
   * owning node can be looked up by its real id. Graph ids are not numeric, so they cannot be
   * smuggled through `osmId`.
   */
  nodeId?: string;
}

interface CanonNode {
  id: string;
  lon: number;
  lat: number;
  ele: number | null;
  isLiftStation: boolean;
  members: number[]; // osm ids
}

/** Spatial hash grid for neighbor queries in a small metric window. */
class Grid {
  private cell: number;
  private map = new Map<string, Provisional[]>();
  constructor(cellMeters: number) {
    // ~degrees per meter (latitude); good enough for a resort-scale bbox.
    this.cell = cellMeters / 111320;
  }
  private key(lon: number, lat: number): string {
    return `${Math.floor(lon / this.cell)}:${Math.floor(lat / this.cell)}`;
  }
  add(p: Provisional): void {
    const k = this.key(p.lon, p.lat);
    const arr = this.map.get(k);
    if (arr) arr.push(p);
    else this.map.set(k, [p]);
  }
  neighbors(lon: number, lat: number): Provisional[] {
    const out: Provisional[] = [];
    const cx = Math.floor(lon / this.cell);
    const cy = Math.floor(lat / this.cell);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const arr = this.map.get(`${cx + dx}:${cy + dy}`);
        if (arr) out.push(...arr);
      }
    }
    return out;
  }
}

/**
 * Detect significant nodes (way endpoints + nodes shared by >= 2 ways), then merge
 * provisional nodes that are within BOTH Hmerge and Vmerge into canonical nodes.
 */
function buildCanonicalNodes(
  pistes: NormPiste[],
  lifts: NormLift[],
  c: GraphConstants,
  warnings: DataWarning[],
): { canonicalOf: Map<number, string>; nodes: Map<string, CanonNode> } {
  const wayCount = new Map<number, number>(); // osmId -> distinct ways containing it
  const coord = new Map<number, NormPoint>();
  const liftStation = new Set<number>();

  const register = (points: NormPoint[], isLift: boolean) => {
    const seen = new Set<number>();
    for (const p of points) {
      if (!coord.has(p.osmId)) coord.set(p.osmId, p);
      if (!seen.has(p.osmId)) {
        seen.add(p.osmId);
        wayCount.set(p.osmId, (wayCount.get(p.osmId) ?? 0) + 1);
      }
    }
    if (isLift && points.length >= 2) {
      liftStation.add(points[0].osmId);
      liftStation.add(points[points.length - 1].osmId);
    }
  };
  for (const p of pistes) register(p.points, false);
  for (const l of lifts) register(l.points, true);

  // Significant = endpoint of a way (wayCount considered) OR shared by >= 2 ways.
  const significant = new Set<number>();
  const markEndpoints = (points: NormPoint[]) => {
    if (points.length) {
      significant.add(points[0].osmId);
      significant.add(points[points.length - 1].osmId);
    }
  };
  for (const p of pistes) markEndpoints(p.points);
  for (const l of lifts) markEndpoints(l.points);
  for (const [id, cnt] of wayCount) if (cnt >= 2) significant.add(id);

  // Cluster significant nodes.
  const provisionals: Provisional[] = [...significant].map((osmId) => {
    const pt = coord.get(osmId)!;
    return {
      osmId,
      lon: pt.lon,
      lat: pt.lat,
      ele: pt.ele,
      isLiftStation: liftStation.has(osmId),
    };
  });

  const grid = new Grid(c.Hmerge);
  for (const p of provisionals) grid.add(p);
  const uf = new UnionFind();
  for (const p of provisionals) uf.find(String(p.osmId));
  for (const p of provisionals) {
    for (const q of grid.neighbors(p.lon, p.lat)) {
      if (q.osmId <= p.osmId) continue;
      const h = haversineM(toGeo(p as unknown as NormPoint), toGeo(q as unknown as NormPoint));
      const v =
        p.ele != null && q.ele != null ? Math.abs(p.ele - q.ele) : 0;
      if (h <= c.Hmerge && v <= c.Vmerge) uf.union(String(p.osmId), String(q.osmId));
    }
  }

  // Build canonical nodes from clusters.
  const clusters = new Map<string, Provisional[]>();
  for (const p of provisionals) {
    const root = uf.find(String(p.osmId));
    const arr = clusters.get(root);
    if (arr) arr.push(p);
    else clusters.set(root, [p]);
  }

  const canonicalOf = new Map<number, string>();
  const nodes = new Map<string, CanonNode>();
  for (const members of clusters.values()) {
    // Name the node after the smallest OSM node id it merges. OSM ids are permanent, so this is
    // independent of processing order: re-fetching the resort cannot renumber the graph out from
    // under the id-based entries in overrides/<id>.json (the failure mode that produced multi-km
    // "teleport" connectors). Adding or removing OSM nodes only ever changes the ids of the
    // clusters they belong to, never everything after them. It also makes any canonical node
    // directly greppable in OSM, which is how these elevation problems get verified.
    const id = `n${members.reduce((min, m) => (m.osmId < min ? m.osmId : min), members[0].osmId)}`;
    // Clusters partition the points, so two clusters cannot share a minimum. Guard anyway: a
    // silent id collision would merge unrelated nodes and corrupt routing.
    if (nodes.has(id)) throw new Error(`node id collision: ${id} â€” clusters are not disjoint`);
    const lon = members.reduce((s, m) => s + m.lon, 0) / members.length;
    const lat = members.reduce((s, m) => s + m.lat, 0) / members.length;
    const eles = members.map((m) => m.ele).filter((e): e is number => e != null);
    const ele = eles.length ? eles.reduce((s, e) => s + e, 0) / eles.length : null;
    const node: CanonNode = {
      id,
      lon,
      lat,
      ele,
      isLiftStation: members.some((m) => m.isLiftStation),
      members: members.map((m) => m.osmId),
    };
    nodes.set(id, node);
    for (const m of members) canonicalOf.set(m.osmId, id);
    // Flag suspicious merges: a cluster spanning more vertical range than Vmerge
    // (can happen via transitive unions) may have wrongly merged stacked points.
    if (eles.length >= 2) {
      const span = Math.max(...eles) - Math.min(...eles);
      if (span > c.Vmerge * 1.5) {
        warnings.push({
          code: 'suspicious_merge',
          message: `Node ${id} merges points spanning ${span.toFixed(1)} m vertically (> Vmerge). Review in overrides.`,
          refs: [id],
        });
      }
    }
  }
  return { canonicalOf, nodes };
}

/** A raw segment of a way between two consecutive significant nodes. */
interface Segment {
  from: string;
  to: string;
  geometry: GeoPoint[];
}

/** Split a way's points into segments between significant (canonical-mapped) nodes. */
function segmentWay(points: NormPoint[], canonicalOf: Map<number, string>): Segment[] {
  const segs: Segment[] = [];
  let startIdx = 0;
  for (let i = 1; i < points.length; i++) {
    const canon = canonicalOf.get(points[i].osmId);
    const isSignificant = canon !== undefined && i !== startIdx;
    if (isSignificant || i === points.length - 1) {
      const fromCanon = canonicalOf.get(points[startIdx].osmId);
      const toCanon = canonicalOf.get(points[i].osmId);
      if (fromCanon && toCanon && fromCanon !== toCanon) {
        segs.push({
          from: fromCanon,
          to: toCanon,
          geometry: points.slice(startIdx, i + 1).map(toGeo),
        });
      }
      startIdx = i;
    }
  }
  return segs;
}

function isDownloadable(lt: LiftType): boolean {
  return DOWNLOADABLE_LIFT_TYPES.has(lt);
}

/** Nodes that can reach a lift station following directed edges (reverse BFS from stations). */
function reachLiftStations(edges: GraphEdge[], liftStationIds: string[]): Set<string> {
  const rev = new Map<string, string[]>();
  for (const e of edges) {
    const arr = rev.get(e.to);
    if (arr) arr.push(e.from);
    else rev.set(e.to, [e.from]);
  }
  const seen = new Set<string>(liftStationIds);
  const queue = [...liftStationIds];
  while (queue.length) {
    const cur = queue.shift()!;
    for (const prev of rev.get(cur) ?? []) {
      if (!seen.has(prev)) {
        seen.add(prev);
        queue.push(prev);
      }
    }
  }
  return seen;
}

/**
 * Nodes a skier can actually GET TO from a lift station (forward BFS along directed edges).
 * The mirror image of reachLiftStations: that one finds "trapped" nodes (you arrive but can
 * never leave), this one finds "orphan" nodes (perfectly good terrain that nothing leads into).
 */
function reachedFromLiftStations(edges: GraphEdge[], liftStationIds: string[]): Set<string> {
  const fwd = new Map<string, string[]>();
  for (const e of edges) {
    const arr = fwd.get(e.from);
    if (arr) arr.push(e.to);
    else fwd.set(e.from, [e.to]);
  }
  const seen = new Set<string>(liftStationIds);
  const queue = [...liftStationIds];
  while (queue.length) {
    const cur = queue.shift()!;
    for (const next of fwd.get(cur) ?? []) {
      if (!seen.has(next)) {
        seen.add(next);
        queue.push(next);
      }
    }
  }
  return seen;
}

/**
 * The published ride time, in seconds, or `undefined` when OSM doesn't say.
 *
 * Deliberately narrow: we pass on only what the `aerialway:duration` tag actually states and never
 * substitute a derived length/speed estimate. Baking an estimate into the data would freeze it â€”
 * lift speeds are a user preference, so the estimate has to stay the router's job.
 */
function osmRideSeconds(durationSec?: number): number | undefined {
  return durationSec && durationSec > 0 ? durationSec : undefined;
}

/**
 * Repair DEM "pothole"/"false-peak" nodes BEFORE edges are oriented. Piste direction is derived
 * purely from node elevations (buildResortGraph orients each segment high->low), so a single
 * mis-sampled interior node silently reverses a segment:
 *   - a node sampled BELOW all its piste neighbours becomes a false local minimum â€” the run past it
 *     reverses and both neighbouring pistes point INTO a dead-looking sink you could only leave by
 *     climbing (the "arrows into itself, no way out" artifact);
 *   - a node sampled ABOVE all its neighbours becomes a false local maximum â€” a phantom top you can
 *     ski away from but never legitimately reach.
 * Genuine tops/bottoms are piste ENDPOINTS (graph degree 1) or lift stations; an interior
 * through/junction node (degree >= 2) that is a strict local extremum is almost always DEM noise.
 * Pull each such node back between its two nearest neighbours so the run stays monotonic THROUGH it
 * (one downhill exit, inflow from the rest). Iterated a few passes so cascaded dips settle.
 *
 * The extremum test is gated on GRADIENT, not on the raw height difference. Neighbours here are
 * canonical *junction* nodes, which can be a kilometre apart â€” so "more than tol above every
 * neighbour" is also true of every genuine summit where two runs split and both descend. Comparing
 * rise/run instead separates the two cases: a real mountain top reaches its neighbours at piste
 * gradients (a black run is ~0.7), while a mis-sampled DEM cell stands impossibly proud of ground
 * a few tens of metres away. Without this gate an Ischgl ridge at 2789 m whose nearest junction was
 * 2 km away and 432 m lower was "repaired" down to 2357 m, inventing a 433 m uphill traverse.
 *
 * Repairs are written back into the source polyline points as well as the node (see the returned
 * `fixed` map). Node elevation and geometry elevation describe the same spot on the mountain, and
 * edge drops are measured from the geometry, so patching only the node leaves every edge touching
 * it reporting a drop that contradicts its own endpoints.
 */
function repairPotholeElevations(
  nodes: Map<string, CanonNode>,
  pistes: NormPiste[],
  canonicalOf: Map<number, string>,
  c: GraphConstants,
): { repaired: number; fixed: Map<number, number> } {
  const adj = new Map<string, Map<string, number>>();
  const link = (a: string, b: string, dist: number): void => {
    const m = adj.get(a) ?? adj.set(a, new Map<string, number>()).get(a)!;
    const prev = m.get(b);
    if (prev == null || dist < prev) m.set(b, dist);
  };
  for (const piste of pistes) {
    for (const seg of segmentWay(piste.points, canonicalOf)) {
      if (seg.from === seg.to) continue;
      const a = nodes.get(seg.from);
      const b = nodes.get(seg.to);
      if (!a || !b) continue;
      const dist = haversineM({ lon: a.lon, lat: a.lat }, { lon: b.lon, lat: b.lat });
      link(seg.from, seg.to, dist);
      link(seg.to, seg.from, dist);
    }
  }
  const tol = Math.max(2, c.pisteFlatTolerance); // ignore sub-tolerance elevation noise
  const repaired = new Set<string>();
  for (let pass = 0; pass < 6; pass++) {
    let changed = false;
    for (const [id, nbrs] of adj) {
      if (nbrs.size < 2) continue; // degree 1 = genuine run endpoint (top/bottom) â€” leave alone
      const n = nodes.get(id);
      if (!n || n.isLiftStation || n.ele == null) continue;
      const near = [...nbrs]
        .map(([x, dist]) => ({ ele: nodes.get(x)?.ele, dist }))
        .filter((e): e is { ele: number; dist: number } => e.ele != null)
        .sort((a, b) => a.ele - b.ele);
      if (near.length < 2) continue;
      const eles = near.map((e) => e.ele);
      const lowest = eles[0];
      const second = eles[1];
      const highest = eles[eles.length - 1];
      const secondHighest = eles[eles.length - 2];
      // A spike must be implausibly steep relative to EVERY neighbour, not merely higher/lower
      // than all of them â€” otherwise real summits and real basins get flattened.
      const steepToAll = (sign: 1 | -1): boolean =>
        near.every((e) => e.dist > 0 && (sign * (n.ele! - e.ele)) / e.dist > c.spikeGradeMax);
      if (n.ele < lowest - tol && steepToAll(-1)) {
        n.ele = (lowest + second) / 2; // false min: sit just above the lowest neighbour
        repaired.add(id);
        changed = true;
      } else if (n.ele > highest + tol && steepToAll(1)) {
        n.ele = (highest + secondHighest) / 2; // false peak: sit just below the highest neighbour
        repaired.add(id);
        changed = true;
      }
    }
    if (!changed) break;
  }
  const fixed = new Map<number, number>();
  for (const id of repaired) {
    const n = nodes.get(id);
    if (!n || n.ele == null) continue;
    for (const osmId of n.members) fixed.set(osmId, n.ele);
  }
  return { repaired: repaired.size, fixed };
}

/** Apply repaired node elevations to the raw way points, so geometry agrees with the node table. */
function applyElevationFixes(ways: { points: NormPoint[] }[], fixed: Map<number, number>): void {
  if (fixed.size === 0) return;
  for (const w of ways) {
    for (const p of w.points) {
      const ele = fixed.get(p.osmId);
      if (ele != null) p.ele = ele;
    }
  }
}

/**
 * Build the full resort graph: piste edges (descending), flat traverses (bidirectional),
 * lift edges (up, plus down for downloadable types), and inferred skiable connectors.
 */
export function buildResortGraph(
  resortId: string,
  pistes: NormPiste[],
  lifts: NormLift[],
  c: GraphConstants,
): ResortGraph {
  const warnings: DataWarning[] = [];
  const { canonicalOf, nodes } = buildCanonicalNodes(pistes, lifts, c, warnings);

  // Correct DEM false local-minima/maxima before edges are oriented (see repairPotholeElevations).
  const { repaired: repairedPotholes, fixed } = repairPotholeElevations(nodes, pistes, canonicalOf, c);
  applyElevationFixes([...pistes, ...lifts], fixed);
  if (repairedPotholes > 0) {
    warnings.push({
      code: 'pothole_repaired',
      message: `Repaired ${repairedPotholes} DEM false local-min/peak node(s) to keep runs descending monotonically.`,
    });
  }

  const edges: GraphEdge[] = [];
  let edgeIdx = 0;
  const nextEdgeId = () => `e${edgeIdx++}`;
  const node = (id: string) => nodes.get(id)!;
  const nodeGeo = (id: string): GeoPoint => {
    const n = node(id);
    return { lon: n.lon, lat: n.lat, ele: n.ele };
  };

  // Signed vertical change along a polyline, in the direction it is stored.
  //
  // Connectors used to be emitted with `dropM: 0` whenever they were not an outright descent,
  // which made every reverse cat-track and every inferred traverse look perfectly level even
  // when its two ends differ. Across the compiled resorts that hid ~12 km of real climbing, and
  // the longest-run search happily used it as free distance: a Madonna route skied 345 m down
  // piste 71 purely so it could climb a 126 m / +5 m traverse back onto piste 73 higher up.
  // Cost and score can only charge for a climb they can see, so record the truth here.
  const geomDrop = (g: GeoPoint[]): number =>
    g.length >= 2 ? (g[g.length - 1].ele ?? 0) - (g[0].ele ?? 0) : 0;

  // Emits one half of a split edge, repairing a direction the split has just falsified.
  //
  // A piste is oriented from its two ENDPOINT elevations alone (`dropM: -Math.abs(drop)` below),
  // so a way whose geometry is not monotonic passes as "descending" as long as it ends lower
  // than it starts. That is routine for an `area=yes` ring, which arcs over a rim: it drops into
  // a bowl and climbs back out, yet its two ends sit at nearly the same height. Split such a way
  // at an interior point and the halves inherit `kind: 'piste'` while one of them genuinely
  // CLIMBS â€” SÃ¶lden's e1031 rose 287 m as a one-way black run. cost.ts charges nothing to ascend
  // a piste, so that half is a free lift: it let a skier climb out of the glacier bowl instead of
  // riding the gondola beside it.
  //
  // Emit the offending half reversed, so the real descent it represents survives and only the
  // bogus ascent disappears. Rises within maxTraverseClimb are left alone: at that scale the
  // signal is DEM noise, and flipping a run because of it would be worse than the rise.
  const pushSplitHalf = (half: GraphEdge): void => {
    if (half.kind === 'piste' && half.dropM > c.maxTraverseClimb) {
      const geometry = [...half.geometry].reverse();
      edges.push({
        ...half,
        from: half.to,
        to: half.from,
        geometry,
        dropM: -half.dropM,
        gradient: half.gradient == null ? undefined : -half.gradient,
      });
      return;
    }
    edges.push(half);
  };

  // --- Piste + flat edges -------------------------------------------------
  const pisteEndpointNames: { nodeId: string; name: string; role: 'top' | 'bottom' }[] = [];
  for (const piste of pistes) {
    const armEdgeStart = edges.length;
    for (const seg of segmentWay(piste.points, canonicalOf)) {
      const a = node(seg.from);
      const b = node(seg.to);
      const lengthM = polylineLength3dM(seg.geometry);
      if (lengthM < 1) continue;
      const drop = a.ele != null && b.ele != null ? b.ele - a.ele : 0;

      if (Math.abs(drop) <= c.pisteFlatTolerance) {
        // Flat piste patch: bidirectional traverse (absorbs surrounding direction).
        for (const [from, to] of [
          [seg.from, seg.to],
          [seg.to, seg.from],
        ] as const) {
          const geometry = from === seg.from ? seg.geometry : [...seg.geometry].reverse();
          edges.push({
            id: nextEdgeId(),
            from,
            to,
            kind: 'connector',
            connectorKind: 'flat_traverse',
            geometry,
            lengthM,
            dropM: geomDrop(geometry),
            color: piste.color,
            pisteName: piste.name,
            pisteRef: piste.ref,
            area: piste.area || undefined,
            srcWayId: piste.wayId,
          });
        }
      } else {
        // Orient descending: high -> low.
        const descendFromA = drop < 0;
        const from = descendFromA ? seg.from : seg.to;
        const to = descendFromA ? seg.to : seg.from;
        const geometry = descendFromA ? seg.geometry : [...seg.geometry].reverse();
        edges.push({
          id: nextEdgeId(),
          from,
          to,
          kind: 'piste',
          geometry,
          lengthM,
          dropM: -Math.abs(drop),
          color: piste.color,
          pisteName: piste.name,
          pisteRef: piste.ref,
          area: piste.area || undefined,
          srcWayId: piste.wayId,
        });
        const label = piste.ref && piste.name ? `${piste.ref} ${piste.name}` : piste.ref ? `Piste ${piste.ref}` : piste.name;
        if (label) {
          pisteEndpointNames.push({ nodeId: from, name: label, role: 'top' });
          pisteEndpointNames.push({ nodeId: to, name: label, role: 'bottom' });
        }
        // Near-flat cat-track: also traversable in reverse (skate/pole the gentle rise),
        // but only when the actual rise is small â€” you can't climb toward a summit.
        //
        // A synthesised polygon arm skips the *gradient* half of the test (never the climb cap).
        // An arm is a 15-40 m app-invented stub joining a rim point to the polygon's centreline,
        // and the rim usually sits a few metres above the centreline, so a perfectly skateable
        // 3 m rise reads as a 10% grade and the arm silently becomes a one-way valve. Because the
        // two polygons at a shared gateway pick their weld points independently, that halved
        // lateral transfers across gateways. Synthetic endpoint-snap connectors below already use
        // this "climb cap only" rule. The cap is what keeps it safe: it is the reason this cannot
        // turn a long steep run into a free lift.
        const grade = Math.abs(drop) / lengthM;
        const gradeOk = grade <= c.flatGradeMax || (piste.skeletonArm === true && !process.env.SKEL_NOARMGRADE);
        if (gradeOk && Math.abs(drop) <= c.maxTraverseClimb) {
          const reverse = [...geometry].reverse();
          edges.push({
            id: nextEdgeId(),
            from: to,
            to: from,
            kind: 'connector',
            connectorKind: 'flat_traverse',
            geometry: reverse,
            lengthM,
            dropM: geomDrop(reverse),
            gradient: lengthM > 0 ? geomDrop(reverse) / lengthM : 0,
            color: piste.color,
            pisteName: piste.name,
            pisteRef: piste.ref,
            area: piste.area || undefined,
            srcWayId: piste.wayId,
          });
        }
      }
    }
    if (piste.skeletonArm === true && edges.length > armEdgeStart) {
      // Tag every edge this arm emits with its rim end. The prune pass runs last â€” after
      // overrides, which can still delete and re-issue edges â€” so it has to be able to rebuild
      // "this is one arm" from the edge list alone. `emit.ts` strips the tag on the way out.
      const portal = canonicalOf.get(piste.points[0].osmId);
      if (portal) for (let i = armEdgeStart; i < edges.length; i++) edges[i].armPortal = portal;
    }
  }

  // --- Lift edges ---------------------------------------------------------
  const liftStationNames: { nodeId: string; name: string; role: 'top' | 'bottom' }[] = [];
  for (const lift of lifts) {
    const segs = segmentWay(lift.points, canonicalOf);
    // Treat the whole lift as bottom-station to top-station using its overall endpoints.
    for (const seg of segs) {
      const a = node(seg.from);
      const b = node(seg.to);
      const lengthM = polylineLength3dM(seg.geometry);
      if (lengthM < 1) continue;
      const aEle = a.ele ?? 0;
      const bEle = b.ele ?? 0;
      // Bottom = lower station.
      const bottomId = aEle <= bEle ? seg.from : seg.to;
      const topId = aEle <= bEle ? seg.to : seg.from;
      const upGeom = bottomId === seg.from ? seg.geometry : [...seg.geometry].reverse();
      const ride = osmRideSeconds(lift.durationSec);
      const drop = Math.abs((b.ele ?? 0) - (a.ele ?? 0));

      const upEdge: GraphEdge = {
        id: nextEdgeId(),
        from: bottomId,
        to: topId,
        kind: 'lift',
        geometry: upGeom,
        lengthM,
        dropM: drop,
        liftType: lift.liftType,
        liftName: lift.name,
        isDownload: false,
        openingHours: lift.openingHours,
        rideSeconds: ride,
      };
      edges.push(upEdge);

      if (isDownloadable(lift.liftType)) {
        edges.push({
          id: nextEdgeId(),
          from: topId,
          to: bottomId,
          kind: 'lift',
          geometry: [...upGeom].reverse(),
          lengthM,
          dropM: -drop,
          liftType: lift.liftType,
          liftName: lift.name,
          isDownload: true,
          openingHours: lift.openingHours,
          rideSeconds: ride,
        });
      }

      if (lift.name) {
        liftStationNames.push({ nodeId: bottomId, name: lift.name, role: 'bottom' });
        liftStationNames.push({ nodeId: topId, name: lift.name, role: 'top' });
      }
      if (!lift.openingHours) {
        warnings.push({
          code: 'missing_opening_hours',
          message: `Lift "${lift.name ?? lift.wayId}" has no opening_hours in OSM.`,
        });
      }
    }
  }

  // --- Snap dead-end piste endpoints onto nearby piste lines (T-junctions) ------
  // OSM often draws a run that ends ON another run's line (not at a shared node), leaving
  // a routing gap. For each descent dead-end, if another piste's polyline passes within
  // snapToLineRadius, split that piste at the projection and add a short link. This closes
  // the "endpoint touches another run's middle" gap class.
  {
    const descOutSnap = new Set<string>();
    const descInSnap = new Set<string>();
    for (const e of edges) {
      // Arriving by piste OR lift deposits a skier who wants to ski on...
      if (e.kind === 'piste' || e.kind === 'lift' || (e.kind === 'connector' && e.connectorKind === 'skiable_down')) {
        descInSnap.add(e.to);
      }
      // ...but only a piste/skiable descent counts as being able to SKI onward (a lift back
      // down does not â€” a lift-only top must still be linked to the ski network).
      if (e.kind === 'piste' || (e.kind === 'connector' && e.connectorKind === 'skiable_down')) {
        descOutSnap.add(e.from);
      }
    }
    const deadEnds = [...nodes.values()].filter((n) => descInSnap.has(n.id) && !descOutSnap.has(n.id) && n.ele != null);
    let snapped = 0;
    for (const E of deadEnds) {
      const ep: GeoPoint = { lon: E.lon, lat: E.lat, ele: E.ele };
      let best: { edge: GraphEdge; segIdx: number; point: GeoPoint; dist: number } | null = null;
      for (const X of edges) {
        if (X.kind !== 'piste' || X.from === E.id || X.to === E.id) continue;
        for (let i = 1; i < X.geometry.length; i++) {
          const pr = projectOnSegment(ep, X.geometry[i - 1], X.geometry[i]);
          if (pr.dist <= c.snapToLineRadius && pr.dist < (best?.dist ?? Infinity)) {
            best = { edge: X, segIdx: i, point: pr.point, dist: pr.dist };
          }
        }
      }
      if (!best) continue;
      const X = best.edge;
      const P = best.point;
      // One snap node per dead-end, so name it after the dead-end it serves: deterministic and
      // stable across refreshes, unlike a running counter.
      const N = `s${E.id}`;
      if (nodes.has(N)) continue;
      nodes.set(N, { id: N, lon: P.lon, lat: P.lat, ele: P.ele, isLiftStation: false, members: [] });
      // Split X at P (preserving its downhill direction and attributes).
      const g1 = [...X.geometry.slice(0, best.segIdx), P];
      const g2 = [P, ...X.geometry.slice(best.segIdx)];
      const fromEle = nodes.get(X.from)?.ele ?? 0;
      const toEle = nodes.get(X.to)?.ele ?? 0;
      const idx = edges.indexOf(X);
      if (idx >= 0) edges.splice(idx, 1);
      pushSplitHalf({ ...X, id: nextEdgeId(), to: N, geometry: g1, lengthM: polylineLength3dM(g1), dropM: (P.ele ?? 0) - fromEle });
      pushSplitHalf({ ...X, id: nextEdgeId(), from: N, geometry: g2, lengthM: polylineLength3dM(g2), dropM: toEle - (P.ele ?? 0) });
      // Link the dead-end onto the run at N. A very close touch (<= Hmerge) is a real
      // junction (not flagged); a larger gap is an app guess (flagged synthetic).
      const dz = (P.ele ?? 0) - E.ele;
      const flagged = best.dist > c.Hmerge;
      if (dz < -c.maxTraverseClimb) {
        edges.push({ id: nextEdgeId(), from: E.id, to: N, kind: 'connector', connectorKind: 'skiable_down', geometry: [ep, P], lengthM: best.dist, dropM: -Math.abs(dz), synthetic: flagged });
      } else {
        edges.push({ id: nextEdgeId(), from: E.id, to: N, kind: 'connector', connectorKind: 'flat_traverse', geometry: [ep, P], lengthM: best.dist, dropM: geomDrop([ep, P]), synthetic: flagged });
        edges.push({ id: nextEdgeId(), from: N, to: E.id, kind: 'connector', connectorKind: 'flat_traverse', geometry: [P, ep], lengthM: best.dist, dropM: geomDrop([P, ep]), synthetic: flagged });
      }
      snapped++;
    }
    if (snapped > 0) {
      warnings.push({ code: 'inferred_connector', message: `Snapped ${snapped} dead-end run(s) onto a nearby piste line (T-junction).` });
    }
  }

  // --- Inferred skiable / flat connectors --------------------------------
  // Only bridge "stuck" nodes: a place a skier can reach but cannot continue from
  // (no outgoing piste/lift/connector). This avoids densely interlinking every nearby
  // pair while still closing genuine gaps (piste end near a lift base or another run).
  const nodeList = [...nodes.values()];
  const hasIncoming = new Set<string>();
  const canContinue = new Set<string>();
  for (const e of edges) {
    hasIncoming.add(e.to);
    // Only a piste/skiable descent counts as "can ski onward". A lift does NOT (a lift-only
    // top can't be skied off), and a flat traverse must not mask a missing descent.
    if (e.kind === 'piste' || (e.kind === 'connector' && e.connectorKind === 'skiable_down')) {
      canContinue.add(e.from);
    }
  }
  const cgrid = new Grid(c.bridgeRadius);
  for (const n of nodeList) {
    cgrid.add({ osmId: 0, nodeId: n.id, lon: n.lon, lat: n.lat, ele: n.ele, isLiftStation: n.isLiftStation });
  }
  const existingPair = new Set<string>();
  for (const e of edges) existingPair.add(`${e.from}->${e.to}`);

  let inferred = 0;
  const MAX_LINKS_PER_STUCK = 2;
  for (const a of nodeList) {
    // A node is "stuck" if something leads into it but nothing leads onward.
    const stuck = hasIncoming.has(a.id) && !canContinue.has(a.id);
    if (!stuck || a.ele == null) continue;

    const candidates: { b: CanonNode; h: number; dz: number; flat: boolean }[] = [];
    for (const nb of cgrid.neighbors(a.lon, a.lat)) {
      const b = nb.nodeId ? nodes.get(nb.nodeId) : undefined;
      if (!b || b.id === a.id || b.ele == null) continue;
      const h = haversineM({ lon: a.lon, lat: a.lat, ele: a.ele }, { lon: b.lon, lat: b.lat, ele: b.ele });
      if (h <= c.Hmerge || h > c.bridgeRadius) continue;
      // B must offer a way onward.
      if (!canContinue.has(b.id) && !b.isLiftStation) continue;
      const dz = b.ele - a.ele;
      const grade = Math.abs(dz) / h;
      const flat = Math.abs(dz) <= c.Vflat && h <= c.flatBridgeMax;
      // Skiable if descending (B lower) within grade limits, or a short near-flat traverse.
      const descend = dz < -c.Vflat && grade <= c.maxGrade;
      if (!flat && !descend) continue;
      candidates.push({ b, h, dz, flat });
    }
    // Prefer descending continuations, then the nearest.
    candidates.sort((x, y) => Number(x.flat) - Number(y.flat) || x.h - y.h);

    for (const { b, h, dz, flat } of candidates.slice(0, MAX_LINKS_PER_STUCK)) {
      if (flat) {
        for (const [from, to] of [[a.id, b.id], [b.id, a.id]] as const) {
          if (existingPair.has(`${from}->${to}`)) continue;
          existingPair.add(`${from}->${to}`);
          const geometry = [nodeGeo(from), nodeGeo(to)];
          edges.push({
            id: nextEdgeId(),
            from,
            to,
            kind: 'connector',
            connectorKind: 'flat_traverse',
            geometry,
            lengthM: h,
            dropM: geomDrop(geometry),
            gradient: h > 0 ? geomDrop(geometry) / h : 0,
            synthetic: true,
          });
        }
      } else {
        // a is the stuck (higher) end -> descend to b.
        if (existingPair.has(`${a.id}->${b.id}`)) continue;
        existingPair.add(`${a.id}->${b.id}`);
        edges.push({
          id: nextEdgeId(),
          from: a.id,
          to: b.id,
          kind: 'connector',
          connectorKind: 'skiable_down',
          geometry: [nodeGeo(a.id), nodeGeo(b.id)],
          lengthM: h,
          dropM: -Math.abs(dz),
          gradient: -Math.abs(dz) / h,
          synthetic: true,
        });
        canContinue.add(a.id); // a now has a real descent
      }
      inferred++;
    }
  }
  if (inferred > 0) {
    warnings.push({
      code: 'inferred_connector',
      message: `Inferred ${inferred} skiable/flat connector(s) to bridge stuck nodes.`,
    });
  }

  // --- Flat-junction pass -------------------------------------------------
  // Fill "dummy gaps": flat areas (restaurant aprons, lift bases, cols) where a run visibly
  // ends and another begins across a level patch, but OSM leaves a gap. To avoid wrongly
  // linking two *parallel* runs, only bridge a DANGLING piste end â€” a node where a run
  // terminates (arrives, nothing onward) or starts (leaves, nothing leads in) â€” to a partner
  // that supplies the missing direction, at ~the same elevation (DEM-noise tolerant).
  const descIn = new Set<string>();
  const descOut = new Set<string>();
  for (const e of edges) {
    if (e.kind === 'piste' || e.kind === 'lift' || (e.kind === 'connector' && e.connectorKind === 'skiable_down')) {
      descIn.add(e.to);
    }
    // Lift does not count as skiing onward (a lift-only top is a dangling end).
    if (e.kind === 'piste' || (e.kind === 'connector' && e.connectorKind === 'skiable_down')) {
      descOut.add(e.from);
    }
  }
  const fjGrid = new Grid(c.flatJunctionRadius);
  for (const n of nodeList) {
    fjGrid.add({ osmId: 0, nodeId: n.id, lon: n.lon, lat: n.lat, ele: n.ele, isLiftStation: n.isLiftStation });
  }
  let flatLinks = 0;
  for (const a of nodeList) {
    if (a.ele == null) continue;
    const deadEnd = descIn.has(a.id) && !descOut.has(a.id); // arrives, no way onward
    const deadStart = descOut.has(a.id) && !descIn.has(a.id); // leaves, nothing leads in
    if (!deadEnd && !deadStart) continue;

    const near: { b: CanonNode; h: number }[] = [];
    for (const nb of fjGrid.neighbors(a.lon, a.lat)) {
      const b = nb.nodeId ? nodes.get(nb.nodeId) : undefined;
      if (!b || b.id === a.id || b.ele == null) continue;
      if (Math.abs(b.ele - a.ele) > c.flatJunctionDV) continue; // not the same flat area
      const h = haversineM({ lon: a.lon, lat: a.lat, ele: a.ele }, { lon: b.lon, lat: b.lat, ele: b.ele });
      if (h <= c.Hmerge || h > c.flatJunctionRadius) continue;
      // Partner must supply the missing direction.
      if (deadEnd) {
        if (!descOut.has(b.id) && !b.isLiftStation) continue;
      } else {
        // deadStart: needs something that leads into it.
        if (!descIn.has(b.id)) continue;
      }
      near.push({ b, h });
    }
    near.sort((x, y) => x.h - y.h);
    for (const { b, h } of near.slice(0, c.flatJunctionK)) {
      for (const [from, to] of [[a.id, b.id], [b.id, a.id]] as const) {
        if (existingPair.has(`${from}->${to}`)) continue;
        existingPair.add(`${from}->${to}`);
        const geometry = [nodeGeo(from), nodeGeo(to)];
        edges.push({
          id: nextEdgeId(),
          from,
          to,
          kind: 'connector',
          connectorKind: 'flat_traverse',
          geometry,
          lengthM: h,
          dropM: geomDrop(geometry),
          gradient: h > 0 ? geomDrop(geometry) / h : 0,
          synthetic: true,
        });
      }
      // Mark so subsequent dangling ends see this node as connected.
      if (deadEnd) descOut.add(a.id);
      if (deadStart) descIn.add(a.id);
      flatLinks++;
    }
  }
  if (flatLinks > 0) {
    warnings.push({
      code: 'inferred_connector',
      message: `Added ${flatLinks} flat-junction traverse(s) bridging dangling run ends across level areas.`,
    });
  }

  // --- Plateau pass -------------------------------------------------------
  // Summit and base plateaus (lift-station aprons, cols, restaurant terraces) are one place a
  // skier can skate across in seconds, but OSM models them as several nodes a few metres apart
  // and every mapped link off them is one-way downhill. Snapping a start pin to the "wrong" node
  // of such a cluster then commits the skier to whichever couloir descends from it.
  //
  // Over a link this short the DEM gradient is noise rather than terrain (6 m between two cells
  // 22 m apart reads as a 27% slope on a dead-flat summit), so the flat-traverse gradient gate
  // can't be used here. Instead the pass is anchored on topology: at least one end must be a
  // real HUB â€” a lift station, or a node where three or more distinct neighbours meet. A point
  // in the middle of a piste has exactly two, so two parallel runs are never bridged.
  const neighbourSets = new Map<string, Set<string>>();
  const outAdj = new Map<string, { to: string; lengthM: number }[]>();
  for (const e of edges) {
    if (!neighbourSets.has(e.from)) neighbourSets.set(e.from, new Set());
    if (!neighbourSets.has(e.to)) neighbourSets.set(e.to, new Set());
    neighbourSets.get(e.from)!.add(e.to);
    neighbourSets.get(e.to)!.add(e.from);
    if (!outAdj.has(e.from)) outAdj.set(e.from, []);
    outAdj.get(e.from)!.push({ to: e.to, lengthM: e.lengthM });
  }
  const isHub = (n: CanonNode): boolean =>
    n.isLiftStation || (neighbourSets.get(n.id)?.size ?? 0) >= 3;

  // Out-neighbours as they stand *before* this pass, used by the cul-de-sac guard below. Taking a
  // snapshot (rather than reading the live `outAdj`) keeps the guard independent of the order the
  // candidates happen to be visited in.
  const realOut = new Map<string, Set<string>>();
  for (const e of edges) {
    if (!realOut.has(e.from)) realOut.set(e.from, new Set());
    realOut.get(e.from)!.add(e.to);
  }

  /** Nodes reachable from `startId` without travelling more than `budgetM` along existing edges. */
  const localReach = (startId: string, budgetM: number): Set<string> => {
    const seen = new Set<string>([startId]);
    const queue: { id: string; d: number }[] = [{ id: startId, d: 0 }];
    while (queue.length) {
      const cur = queue.shift()!;
      for (const nx of outAdj.get(cur.id) ?? []) {
        const d = cur.d + nx.lengthM;
        if (d > budgetM || seen.has(nx.to)) continue;
        seen.add(nx.to);
        queue.push({ id: nx.to, d });
      }
    }
    return seen;
  };

  const plGrid = new Grid(c.plateauRadius);
  for (const n of nodeList) {
    plGrid.add({ osmId: 0, nodeId: n.id, lon: n.lon, lat: n.lat, ele: n.ele, isLiftStation: n.isLiftStation });
  }
  const dbgPlateau = !!process.env.SKIWAZE_DBG;
  let plateauLinks = 0;
  for (const a of nodeList) {
    if (a.ele == null) continue;

    const near: { b: CanonNode; h: number; dz: number }[] = [];
    for (const nb of plGrid.neighbors(a.lon, a.lat)) {
      const b = nb.nodeId ? nodes.get(nb.nodeId) : undefined;
      if (!b || b.id === a.id || b.ele == null) continue;
      const dz = b.ele - a.ele;
      if (Math.abs(dz) > c.maxTraverseClimb) continue; // more than a skate â€” that's a real slope
      const h = haversineM({ lon: a.lon, lat: a.lat, ele: a.ele }, { lon: b.lon, lat: b.lat, ele: b.ele });
      if (h <= c.Hmerge || h > c.plateauRadius) continue;
      if (!isHub(a) && !isHub(b)) continue;
      near.push({ b, h, dz });
    }
    if (!near.length) continue;
    near.sort((x, y) => x.h - y.h);
    const budget = Math.max(c.plateauReachBudget, c.plateauRadius * 4);

    // Only worth adding when the pair is genuinely severed. If a skier can already get from a to
    // b (or back) with a short detour along mapped runs, the plateau is already connected and a
    // shortcut would just invent off-piste terrain â€” that's how parallel runs and switchbacks
    // would get wrongly bridged.
    for (const { b, h, dz } of near.slice(0, c.plateauK)) {
      if (localReach(a.id, budget).has(b.id) && localReach(b.id, budget).has(a.id)) continue;
      let added = false;
      for (const [from, to] of [[a.id, b.id], [b.id, a.id]] as const) {
        if (existingPair.has(`${from}->${to}`)) continue;
        // Cul-de-sac guard: skating across the apron to `to` is only worth anything if the skier
        // can then go somewhere new. If `to`'s only onward edge leads straight back to `from` it
        // is a pass-through node â€” the link would just offer a climb to a dead end (and, with a
        // plausible-looking detour saving, make the pass look more useful than it is).
        const onward = realOut.get(to);
        if (!onward || (onward.size === 1 && onward.has(from))) continue;
        existingPair.add(`${from}->${to}`);
        const geometry = [nodeGeo(from), nodeGeo(to)];
        edges.push({
          id: nextEdgeId(),
          from,
          to,
          kind: 'connector',
          connectorKind: 'flat_traverse',
          geometry,
          lengthM: h,
          dropM: geomDrop(geometry),
          gradient: h > 0 ? geomDrop(geometry) / h : 0,
          synthetic: true,
        });
        (outAdj.get(from) ?? outAdj.set(from, []).get(from)!).push({ to, lengthM: h });
        added = true;
      }
      if (!added) continue;
      plateauLinks++;
      if (dbgPlateau) {
        console.log(
          `plateau: ${a.id}@${Math.round(a.ele)} <-> ${b.id}@${Math.round(b.ele)}  ` +
            `${h.toFixed(1)}m dz=${dz.toFixed(1)}m  ` +
            `hub=${isHub(a) ? 'a' : ''}${isHub(b) ? 'b' : ''} ` +
            `lon=${a.lon.toFixed(5)} lat=${a.lat.toFixed(5)}`,
        );
      }
    }
  }
  if (plateauLinks > 0) {
    warnings.push({
      code: 'inferred_connector',
      message: `Added ${plateauLinks} plateau traverse(s) linking hub nodes on the same level apron.`,
    });
  }

  // --- Rescue pass: guarantee no run is a dead route ----------------------
  // A node is "trapped" if a skier can reach it (incoming) but from it cannot reach ANY
  // lift station via any edges. Link it to the best nearby escape, preferring lower/level
  // exits (short skate/traverse). Repeat for small chains.
  //
  // The escape may be another *node*, or a point in the middle of a piste *line*. Considering
  // only nodes is how this pass used to work, and it is wrong for the same reason the endpoint
  // snap above exists: runs meet mid-line far more often than end-to-end. A Madonna dead end at
  // 1653 m has piste 78 passing 49 m away, 84% of the way along one of its edges â€” invisible to
  // a node search, which instead reached 194 m across the valley to a node that is not connected
  // to it on the snow at all. Projecting onto the line finds the link a skier would actually use,
  // and being 4x shorter it wins on distance alone, so no special-casing is needed.
  const liftStationIds = nodeList.filter((n) => n.isLiftStation).map((n) => n.id);
  const rgrid = new Grid(c.rescueRadius);
  for (const n of nodeList) {
    rgrid.add({ osmId: 0, nodeId: n.id, lon: n.lon, lat: n.lat, ele: n.ele, isLiftStation: n.isLiftStation });
  }
  let rescued = 0;
  let rescuedOntoLine = 0;
  for (let pass = 0; pass < 3; pass++) {
    const canReach = reachLiftStations(edges, liftStationIds);
    let passRescued = 0;
    for (const a of nodeList) {
      if (a.isLiftStation || a.ele == null) continue;
      if (!hasIncoming.has(a.id) || canReach.has(a.id)) continue;
      const ap: GeoPoint = { lon: a.lon, lat: a.lat, ele: a.ele };
      // Score both kinds of escape on the same scale: distance, with a climb charged heavily.
      const scoreOf = (h: number, targetEle: number) => h + Math.max(0, targetEle - a.ele!) * 6;

      // (a) Nearest reachable node.
      let best: CanonNode | undefined;
      let bestScore = Infinity;
      let bestH = 0;
      for (const nb of rgrid.neighbors(a.lon, a.lat)) {
        const b = nb.nodeId ? nodes.get(nb.nodeId) : undefined;
        if (!b || b.id === a.id || b.ele == null || !canReach.has(b.id)) continue;
        const h = haversineM(ap, { lon: b.lon, lat: b.lat, ele: b.ele });
        if (h <= c.Hmerge || h > c.rescueRadius) continue;
        if (b.ele - a.ele > c.maxTraverseClimb) continue; // never rescue via an impossible uphill link
        const score = scoreOf(h, b.ele);
        if (score < bestScore) {
          bestScore = score;
          best = b;
          bestH = h;
        }
      }

      // (b) Nearest point on a reachable piste line. Only pistes: a projection onto an inferred
      // connector would be a guess built on a guess.
      let bestLine: { edge: GraphEdge; segIdx: number; point: GeoPoint; dist: number } | null = null;
      let bestLineScore = Infinity;
      for (const X of edges) {
        if (X.kind !== 'piste' || X.from === a.id || X.to === a.id) continue;
        if (!canReach.has(X.to)) continue; // joining here must actually lead somewhere
        for (let i = 1; i < X.geometry.length; i++) {
          const pr = projectOnSegment(ap, X.geometry[i - 1], X.geometry[i]);
          if (pr.dist <= c.Hmerge || pr.dist > c.rescueLineRadius) continue;
          const pe = pr.point.ele ?? 0;
          if (pe - a.ele > c.maxTraverseClimb) continue;
          const score = scoreOf(pr.dist, pe);
          if (score < bestLineScore) {
            bestLineScore = score;
            bestLine = { edge: X, segIdx: i, point: pr.point, dist: pr.dist };
          }
        }
      }

      // Resolve the winning line projection to a node, splitting the piste if it lands mid-edge.
      let lineTargetId: string | undefined;
      if (bestLine && bestLineScore < bestScore) {
        const X = bestLine.edge;
        const P = bestLine.point;
        const fromN = nodes.get(X.from)!;
        const toN = nodes.get(X.to)!;
        const dFrom = haversineM(P, { lon: fromN.lon, lat: fromN.lat, ele: fromN.ele });
        const dTo = haversineM(P, { lon: toN.lon, lat: toN.lat, ele: toN.ele });
        if (dFrom <= 3) {
          lineTargetId = X.from;
        } else if (dTo <= 3) {
          lineTargetId = X.to;
        } else {
          // One rescue node per trapped node, named after it: stable across refreshes, unlike a
          // running counter (see the snap and ski-out passes).
          const N = `r${a.id}`;
          if (!nodes.has(N)) {
            nodes.set(N, { id: N, lon: P.lon, lat: P.lat, ele: P.ele, isLiftStation: false, members: [] });
            const g1 = [...X.geometry.slice(0, bestLine.segIdx), P];
            const g2 = [P, ...X.geometry.slice(bestLine.segIdx)];
            const idx = edges.indexOf(X);
            if (idx >= 0) edges.splice(idx, 1);
            pushSplitHalf({ ...X, id: nextEdgeId(), to: N, geometry: g1, lengthM: polylineLength3dM(g1), dropM: geomDrop(g1) });
            pushSplitHalf({ ...X, id: nextEdgeId(), from: N, geometry: g2, lengthM: polylineLength3dM(g2), dropM: geomDrop(g2) });
            lineTargetId = N;
          }
        }
        if (lineTargetId) {
          best = nodes.get(lineTargetId);
          bestH = bestLine.dist;
          rescuedOntoLine++;
        }
      }

      if (best) {
        const dz = best.ele! - a.ele; // a = trapped node
        // If a descends significantly to its escaper, make it a ONE-WAY skiable link so the
        // reverse direction can't be abused to climb. Only near-level links stay bidirectional.
        const oneWayDown = dz < -c.maxTraverseClimb;
        const dirs: [string, string][] = oneWayDown
          ? [[a.id, best.id]]
          : [[a.id, best.id], [best.id, a.id]];
        for (const [from, to] of dirs) {
          if (existingPair.has(`${from}->${to}`)) continue;
          existingPair.add(`${from}->${to}`);
          const geometry = [nodeGeo(from), nodeGeo(to)];
          edges.push({
            id: nextEdgeId(),
            from,
            to,
            kind: 'connector',
            connectorKind: oneWayDown ? 'skiable_down' : 'flat_traverse',
            geometry,
            lengthM: bestH,
            dropM: oneWayDown ? -Math.abs(dz) : geomDrop(geometry),
            gradient: bestH > 0 ? (oneWayDown ? -Math.abs(dz) : geomDrop(geometry)) / bestH : 0,
            synthetic: true,
          });
        }
        rescued++;
        passRescued++;
      }
    }
    if (passRescued === 0) break;
  }
  if (rescued > 0) {
    warnings.push({
      code: 'inferred_connector',
      message: `Rescued ${rescued} trapped node(s) with a forced traverse to the nearest reachable point (${rescuedOntoLine} onto a piste line).`,
    });
  }

  // --- Lift-top ski-out snap ---------------------------------------------
  // A lift top you can only ride back down (no ski-out at all) but a piste passes within
  // liftSkiOutRadius mid-edge. Unlike the general 45m endpoint snap (node-to-line) and the
  // node-to-node bridge/rescue passes, this targets lift tops specifically with a larger
  // radius and projects onto the nearest downhill point of a piste line (splitting it).
  {
    const liftTops = new Set<string>();
    for (const e of edges) if (e.kind === 'lift' && !e.isDownload) liftTops.add(e.to);
    const hasNonLiftOut = new Set<string>();
    for (const e of edges) if (e.kind !== 'lift') hasNonLiftOut.add(e.from);
    let linked = 0;
    for (const topId of liftTops) {
      if (hasNonLiftOut.has(topId)) continue; // already has a ski-out
      const T = nodes.get(topId);
      if (!T || T.ele == null) continue;
      const tp: GeoPoint = { lon: T.lon, lat: T.lat, ele: T.ele };
      let best: { edge: GraphEdge; segIdx: number; point: GeoPoint; dist: number } | null = null;
      for (const X of edges) {
        if (X.kind !== 'piste' || X.from === topId || X.to === topId) continue;
        for (let i = 1; i < X.geometry.length; i++) {
          const pr = projectOnSegment(tp, X.geometry[i - 1], X.geometry[i]);
          // Only a downhill ski-on: the projected point must be at/below the lift top.
          if ((pr.point.ele ?? 0) > T.ele + 2) continue;
          if (pr.dist <= c.liftSkiOutRadius && pr.dist < (best?.dist ?? Infinity)) {
            best = { edge: X, segIdx: i, point: pr.point, dist: pr.dist };
          }
        }
      }
      if (!best) continue;
      const X = best.edge;
      const P = best.point;

      // Reuse an existing endpoint if the projection lands on it; otherwise split X.
      const fromN = nodes.get(X.from)!;
      const toN = nodes.get(X.to)!;
      const dFrom = haversineM(P, { lon: fromN.lon, lat: fromN.lat, ele: fromN.ele });
      const dTo = haversineM(P, { lon: toN.lon, lat: toN.lat, ele: toN.ele });
      let N: string;
      if (dFrom <= 3) {
        N = X.from;
      } else if (dTo <= 3) {
        N = X.to;
      } else {
        // One ski-out node per lift top, named after that top for the same reason as the snap
        // nodes above: a counter would renumber on every refresh.
        N = `k${topId}`;
        if (nodes.has(N)) continue;
        nodes.set(N, { id: N, lon: P.lon, lat: P.lat, ele: P.ele, isLiftStation: false, members: [] });
        const g1 = [...X.geometry.slice(0, best.segIdx), P];
        const g2 = [P, ...X.geometry.slice(best.segIdx)];
        const fromEle = fromN.ele ?? 0;
        const toEle = toN.ele ?? 0;
        const idx = edges.indexOf(X);
        if (idx >= 0) edges.splice(idx, 1);
        pushSplitHalf({ ...X, id: nextEdgeId(), to: N, geometry: g1, lengthM: polylineLength3dM(g1), dropM: (P.ele ?? 0) - fromEle });
        pushSplitHalf({ ...X, id: nextEdgeId(), from: N, geometry: g2, lengthM: polylineLength3dM(g2), dropM: toEle - (P.ele ?? 0) });
      }

      const dz = (P.ele ?? 0) - T.ele; // typically <= 0 (ski down onto the run)
      const oneWayDown = dz < -c.maxTraverseClimb;
      const nGeo: GeoPoint = { lon: nodes.get(N)!.lon, lat: nodes.get(N)!.lat, ele: nodes.get(N)!.ele };
      edges.push({
        id: nextEdgeId(),
        from: topId,
        to: N,
        kind: 'connector',
        connectorKind: oneWayDown ? 'skiable_down' : 'flat_traverse',
        geometry: [tp, nGeo],
        lengthM: best.dist,
        dropM: oneWayDown ? -Math.abs(dz) : geomDrop([tp, nGeo]),
        gradient: best.dist > 0 ? dz / best.dist : 0,
        synthetic: true,
      });
      if (!oneWayDown) {
        edges.push({
          id: nextEdgeId(),
          from: N,
          to: topId,
          kind: 'connector',
          connectorKind: 'flat_traverse',
          geometry: [nGeo, tp],
          lengthM: best.dist,
          dropM: geomDrop([nGeo, tp]),
          gradient: best.dist > 0 ? geomDrop([nGeo, tp]) / best.dist : 0,
          synthetic: true,
        });
      }
      linked++;
    }
    if (linked > 0) {
      warnings.push({
        code: 'inferred_connector',
        message: `Linked ${linked} lift top(s) with no ski-out onto a nearby piste line.`,
      });
    }
  }

  // --- Orphan pass: guarantee no run is unreachable -----------------------
  // The mirror image of the rescue pass above. Rescue fixes nodes a skier can reach but never
  // leave ("trapped"); this fixes nodes a skier can leave but never reach ("orphan") â€” real
  // terrain with a perfectly good way DOWN that nothing on the mountain leads INTO. Both are
  // the same OSM defect (runs meet mid-line, not end-to-end) seen from opposite directions.
  //
  // This became load-bearing with synthesised area centrelines. Deleting a polygon's rim can
  // remove the only inbound edge a zone had, and the existing endpoint-snap can't restore it:
  // that pass only fires on nodes which cannot ski ONWARD, and a node on a spine always can.
  // Alpe d'Huez's 27-node Pic Blanc summit orphaned exactly this way â€” it kept all 10 of its
  // exits and lost its single entrance.
  //
  // Safety is the same argument as everywhere else: entering may never climb more than
  // maxTraverseClimb, and a link that descends into the zone is one-way so it can't be
  // abused as a free ascent. One link per orphan component, best-scoring, so this adds the
  // minimum number of edges rather than one per node.
  if (!process.env.NO_ORPHAN_FIX) {
    const ogrid = new Grid(c.rescueRadius);
    for (const n of nodeList) {
      ogrid.add({ osmId: 0, nodeId: n.id, lon: n.lon, lat: n.lat, ele: n.ele, isLiftStation: n.isLiftStation });
    }
    let adopted = 0;
    let adoptedOntoLine = 0;
    for (let pass = 0; pass < 3; pass++) {
      const reached = reachedFromLiftStations(edges, liftStationIds);
      // A zone is only worth an entrance if a skier can get back OUT of it to a lift.
      const canReach = reachLiftStations(edges, liftStationIds);
      // Group the unreachable nodes into connected components (undirected): one entrance
      // makes an entire component reachable, so linking every node would be pure noise.
      const orphanIds = nodeList.filter((n) => !reached.has(n.id) && n.ele != null && !n.isLiftStation).map((n) => n.id);
      if (orphanIds.length === 0) break;
      const orphanSet = new Set(orphanIds);
      const undirected = new Map<string, string[]>();
      for (const e of edges) {
        if (!orphanSet.has(e.from) || !orphanSet.has(e.to)) continue;
        (undirected.get(e.from) ?? undirected.set(e.from, []).get(e.from)!).push(e.to);
        (undirected.get(e.to) ?? undirected.set(e.to, []).get(e.to)!).push(e.from);
      }
      const componentOf = new Map<string, number>();
      const components: string[][] = [];
      for (const id of orphanIds) {
        if (componentOf.has(id)) continue;
        const members: string[] = [];
        const stack = [id];
        componentOf.set(id, components.length);
        while (stack.length) {
          const cur = stack.pop()!;
          members.push(cur);
          for (const nb of undirected.get(cur) ?? []) {
            if (!componentOf.has(nb)) {
              componentOf.set(nb, components.length);
              stack.push(nb);
            }
          }
        }
        components.push(members);
      }

      let passAdopted = 0;
      for (const members of components) {
        // Best entrance over the WHOLE component, not per node.
        let win: { a: CanonNode; node?: CanonNode; line?: { edge: GraphEdge; segIdx: number; point: GeoPoint; dist: number }; score: number; h: number } | null = null;
        for (const id of members) {
          const a = nodes.get(id);
          if (!a || a.ele == null) continue;
          const ap: GeoPoint = { lon: a.lon, lat: a.lat, ele: a.ele };
          // Climb is charged heavily, exactly as the rescue pass scores its escapes.
          const scoreOf = (h: number, sourceEle: number) => h + Math.max(0, a.ele! - sourceEle) * 6;

          for (const nb of ogrid.neighbors(a.lon, a.lat)) {
            const b = nb.nodeId ? nodes.get(nb.nodeId) : undefined;
            if (!b || b.id === a.id || b.ele == null || !reached.has(b.id)) continue;
            const h = haversineM(ap, { lon: b.lon, lat: b.lat, ele: b.ele });
            if (h <= c.Hmerge || h > c.rescueRadius) continue;
            if (a.ele - b.ele > c.maxTraverseClimb) continue; // entering may never be a real climb
            const score = scoreOf(h, b.ele);
            if (score < (win?.score ?? Infinity)) win = { a, node: b, score, h };
          }

          // A point mid-way along a piste that is itself reachable. Pistes only: projecting
          // onto an inferred connector would be a guess built on a guess.
          for (const X of edges) {
            if (X.kind !== 'piste' || X.from === a.id || X.to === a.id) continue;
            if (!reached.has(X.from)) continue; // you must be able to GET to the joining point
            for (let i = 1; i < X.geometry.length; i++) {
              const pr = projectOnSegment(ap, X.geometry[i - 1], X.geometry[i]);
              if (pr.dist <= c.Hmerge || pr.dist > c.rescueLineRadius) continue;
              const pe = pr.point.ele ?? 0;
              if (a.ele - pe > c.maxTraverseClimb) continue;
              const score = scoreOf(pr.dist, pe);
              if (score < (win?.score ?? Infinity)) {
                win = { a, line: { edge: X, segIdx: i, point: pr.point, dist: pr.dist }, score, h: pr.dist };
              }
            }
          }
        }
        if (!win) continue;

        // A one-way entrance is the only case that can create a trap: the skier drops in and
        // the link cannot carry them back out. Unless the zone can already reach a lift under
        // its own steam, leave it sealed â€” an unreachable zone is bad, a zone you can enter and
        // never leave is worse. A two-way entrance is always safe: it IS the way out.
        // Decided here, before any piste is split, so a rejected zone leaves no stray node.
        const winSourceEle = win.line ? (win.line.point.ele ?? 0) : win.node!.ele!;
        if (win.a.ele! - winSourceEle < -c.maxTraverseClimb && !members.some((id) => canReach.has(id))) continue;

        // Resolve a winning line projection to a node, splitting the piste if it lands mid-edge.
        let source = win.node;
        if (win.line) {
          const X = win.line.edge;
          const P = win.line.point;
          const fromN = nodes.get(X.from)!;
          const toN = nodes.get(X.to)!;
          if (haversineM(P, { lon: fromN.lon, lat: fromN.lat, ele: fromN.ele }) <= 3) {
            source = fromN;
          } else if (haversineM(P, { lon: toN.lon, lat: toN.lat, ele: toN.ele }) <= 3) {
            source = toN;
          } else {
            // One entrance node per adopted orphan, named after it: stable across refreshes,
            // unlike a running counter (see the snap, rescue and ski-out passes).
            const N = `o${win.a.id}`;
            if (!nodes.has(N)) {
              nodes.set(N, { id: N, lon: P.lon, lat: P.lat, ele: P.ele, isLiftStation: false, members: [] });
              const g1 = [...X.geometry.slice(0, win.line.segIdx), P];
              const g2 = [P, ...X.geometry.slice(win.line.segIdx)];
              const idx = edges.indexOf(X);
              if (idx >= 0) edges.splice(idx, 1);
              pushSplitHalf({ ...X, id: nextEdgeId(), to: N, geometry: g1, lengthM: polylineLength3dM(g1), dropM: geomDrop(g1) });
              pushSplitHalf({ ...X, id: nextEdgeId(), from: N, geometry: g2, lengthM: polylineLength3dM(g2), dropM: geomDrop(g2) });
            }
            source = nodes.get(N);
          }
          if (source) adoptedOntoLine++;
        }
        if (!source || source.ele == null) continue;

        const a = win.a;
        const dz = a.ele! - source.ele; // negative => the zone sits below its entrance
        // A real descent into the zone is ONE-WAY, so the reverse can't be abused to climb.
        const oneWayDown = dz < -c.maxTraverseClimb;
        const dirs: [string, string][] = oneWayDown
          ? [[source.id, a.id]]
          : [[source.id, a.id], [a.id, source.id]];
        let added = false;
        for (const [from, to] of dirs) {
          if (existingPair.has(`${from}->${to}`)) continue;
          existingPair.add(`${from}->${to}`);
          const geometry = [nodeGeo(from), nodeGeo(to)];
          edges.push({
            id: nextEdgeId(),
            from,
            to,
            kind: 'connector',
            connectorKind: oneWayDown ? 'skiable_down' : 'flat_traverse',
            geometry,
            lengthM: win.h,
            dropM: oneWayDown ? -Math.abs(dz) : geomDrop(geometry),
            gradient: win.h > 0 ? (oneWayDown ? -Math.abs(dz) : geomDrop(geometry)) / win.h : 0,
            synthetic: true,
          });
          added = true;
        }
        if (added) {
          adopted++;
          passAdopted++;
        }
      }
      if (passAdopted === 0) break;
    }
    if (adopted > 0) {
      warnings.push({
        code: 'inferred_connector',
        message: `Linked ${adopted} unreachable zone(s) to the nearest point a skier can already get to (${adoptedOntoLine} onto a piste line).`,
      });
    }
  }

  // --- Infer difficulty for unrated pistes (global rule) -----------------
  // Untagged downhill runs import as color `unknown`, which the router treats as harder than
  // black and filters out â€” orphaning any section only reachable through one. Give them their
  // rated neighbours' difficulty (easiest feeder; guarded sole-feeder downstream; else hardest
  // neighbour). See inferColors.ts.
  const coloredUnrated = inheritUnratedPisteColors(edges);
  if (coloredUnrated > 0) {
    console.log(`  inferred difficulty for ${coloredUnrated} unrated piste segment(s)`);
  }

  // --- Finalize nodes -----------------------------------------------------
  const degree = new Map<string, number>();
  for (const e of edges) {
    degree.set(e.from, (degree.get(e.from) ?? 0) + 1);
    degree.set(e.to, (degree.get(e.to) ?? 0) + 1);
  }
  // Drop nodes no edge touches. A node with no edges is not terrain â€” it is left over from a
  // way that lost all its segments (too short, pruned as a redundant arm, or dropped by an
  // override). Keeping them costs nothing at runtime but they are permanently both "trapped"
  // and "orphan", so they inflate every connectivity report with dust that can never be fixed.
  // Lift stations are exempt: one with no edges is a real defect and should stay visible.
  let dropped = 0;
  for (const [id, n] of nodes) {
    if ((degree.get(id) ?? 0) === 0 && !n.isLiftStation) {
      nodes.delete(id);
      dropped++;
    }
  }
  if (dropped > 0) console.log(`  dropped ${dropped} edgeless node(s)`);
  // Iterate the live node map (not the earlier `nodeList` snapshot) so nodes created by
  // late passes (e.g. lift-top ski-out splits) are included â€” otherwise their edges dangle.
  const graphNodes: GraphNode[] = [...nodes.values()].map((n) => ({
    id: n.id,
    point: { lon: n.lon, lat: n.lat, ele: n.ele },
    kind: n.isLiftStation
      ? 'lift_station'
      : (degree.get(n.id) ?? 0) >= 3
        ? 'junction'
        : 'piste_endpoint',
    name: undefined,
  }));

  // --- Meaningful points (A/B picker) ------------------------------------
  const points = buildMeaningfulPoints(nodes, liftStationNames, pisteEndpointNames);

  return {
    resortId,
    generatedAt: new Date().toISOString(),
    nodes: graphNodes,
    edges,
    points,
    warnings,
  };
}

function buildMeaningfulPoints(
  nodes: Map<string, CanonNode>,
  liftStations: { nodeId: string; name: string; role: 'top' | 'bottom' }[],
  pisteEndpoints: { nodeId: string; name: string; role: 'top' | 'bottom' }[],
): MeaningfulPoint[] {
  type Cat = 'lift' | 'piste';
  interface Pick { nodeId: string; name: string; role: 'top' | 'bottom'; cat: Cat }

  // A run/lift is usually split into many segments, producing many "top"/"bottom" points.
  // Collapse each (category, name, role) to a SINGLE extreme node: the highest-elevation
  // node for "top", the lowest for "bottom". This removes confusing duplicate entries.
  const pick = new Map<string, Pick>();
  const consider = (nodeId: string, name: string, role: 'top' | 'bottom', cat: Cat) => {
    const n = nodes.get(nodeId);
    if (!n || n.ele == null) return;
    const key = `${cat}|${name}|${role}`;
    const cur = pick.get(key);
    if (!cur) {
      pick.set(key, { nodeId, name, role, cat });
      return;
    }
    const curEle = nodes.get(cur.nodeId)?.ele ?? 0;
    const better = role === 'top' ? n.ele > curEle : n.ele < curEle;
    if (better) pick.set(key, { nodeId, name, role, cat });
  };
  for (const s of liftStations) consider(s.nodeId, s.name, s.role, 'lift');
  for (const p of pisteEndpoints) consider(p.nodeId, p.name, p.role, 'piste');

  const out: MeaningfulPoint[] = [];
  const usedNode = new Set<string>();
  // Prefer lift labels when a node is shared between a lift and a piste endpoint.
  const entries = [...pick.values()].sort((a, b) => (a.cat === 'lift' ? 0 : 1) - (b.cat === 'lift' ? 0 : 1));
  for (const e of entries) {
    if (usedNode.has(e.nodeId)) continue;
    const n = nodes.get(e.nodeId)!;
    usedNode.add(e.nodeId);
    const type: MeaningfulPoint['type'] =
      e.cat === 'lift'
        ? e.role === 'top' ? 'lift_top' : 'lift_bottom'
        : e.role === 'top' ? 'piste_top' : 'piste_bottom';
    const eleTag = n.ele != null ? ` \u00b7 ${Math.round(n.ele)} m` : '';
    out.push({
      id: `p${out.length}`,
      name: `${e.name} (${e.role})${eleTag}`,
      type,
      nodeId: e.nodeId,
      point: { lon: n.lon, lat: n.lat, ele: n.ele },
    });
  }
  out.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  return out;
}

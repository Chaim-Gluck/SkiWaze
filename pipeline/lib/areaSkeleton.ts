/**
 * Interior-skeleton synthesis for `area=yes` piste polygons â€” the engine behind plan Â§3.
 *
 * An `area=yes` piste is a polygon, so the only thing the router can follow is its *perimeter*:
 * crossing a bowl means skiing around its rim. That is not merely ugly — the rim is often
 * *straighter* than the real run, so it **wins on cost**, and where a centreline also exists the
 * route visibly zig-zags between the two. This module replaces that rim with an interior
 * **spine** plus **arms** that carry every boundary portal in to it.
 *
 * ## Polygon classes
 *
 * `PolyResult.cls` reports which of these a polygon fell into. The call is made **per polygon,
 * never per edge**: one ring's edges are legitimately at very different distances from the run's
 * centreline (a wide polygon's far side is 100 m+ away), so deciding edge by edge would delete
 * half a ring and fragment the graph.
 *
 *   A   a real centreline for the same run already exists under the WHOLE polygon
 *       -> the rim is pure duplication; delete it and attach its portals to the real line.
 *   B   a corridor (a ribbon of skiable width) with no centreline at all
 *       -> a centreline has to be SYNTHESISED before the rim can go.
 *   B'  a PARTIAL twin: a centreline exists, but the rim wanders off it where the ribbon widens.
 *       Tempting to treat as A. Do not — see the invariant below. Handled like B, except the
 *       existing centreline is reused as the spine instead of synthesising a second line beside it.
 *   C   genuinely open terrain (aspect ratio below `BOWL_RATIO`)
 *       -> no single line represents it; leave exactly as today. Currently matches nothing.
 *   D   inert: contributes no graph edge at all. A closed ring sharing no node with any other way
 *       collapses to a self-loop and `segmentWay` drops it (it requires `fromCanon !== toCanon`).
 *       Such a polygon still paints as an area fill, but the router has never been able to enter
 *       or cross it, so it is neither a defect to fix nor a candidate for synthesis — there are no
 *       portals to connect.
 *
 * The arms are *routed through an interior sampling grid*, never drawn as straight connectors.
 * That is the whole point: a routed arm only ever touches points that passed a point-in-polygon
 * test, so every metre of new geometry lies on ground OSM has confirmed is piste â€” however long
 * the arm turns out to be. A straight connector has no such guarantee, which is why the earlier
 * projection-based draft needed a distance cap and this one does not.
 *
 * Portals do not move. They are the routing *sources*, so they end up as skeleton endpoints by
 * construction and connectivity is preserved without any re-attachment step.
 *
 * Elevation is deliberately absent: the search is purely 2D (centredness, not gradient). Real
 * elevation is fetched for the final vertices by the caller, never interpolated (plan Â§4b).
 *
 * `pipeline/build.ts` feeds this into the graph as synthetic pistes, and emits the same geometry to
 * `spines.json` for the debug map's `spines`/`arms` layers.
 */
import type { GeoPoint, GraphEdge, ResortGraph } from '../../src/types/domain';
import type { NormPiste } from './normalize';
import { sharedRimChains, pinchNodes } from './sharedRim';
import { SKEL_COLORS } from './skelColors';

const R = 6371000;
const toRad = (d: number): number => (d * Math.PI) / 180;

/** Interior sampling resolution. 12 m is roughly a piste's width tolerance, per plan Ã‚Â§3. */
const GRID_M = 12;
/**
 * How hard the router is pushed towards the middle. A grid step costs its length multiplied by
 * (CENTRE_REF_M / clearance) ^ CENTRE_P, so halving the distance to the rim multiplies the cost
 * by 2^CENTRE_P wherever you are -- the penalty is a ratio, never measured against the polygon's
 * widest point, because that left narrow sections with no centring force at all. Clearance above
 * CENTRE_REF_M earns no further discount, so a wide spot cannot lure the spine into a detour.
 */
const CENTRE_REF_M = Number(process.env.CENTRE_REF_M ?? 25);
const CENTRE_P = Number(process.env.CENTRE_P ?? 1);

/**
 * Shortest shared boundary that earns a gateway node.
 *
 * This was 30 m on the argument that below it, crossing at a corner is not much of a detour. That
 * only weighed the extra *distance*, and missed the bigger effect: with no gateway the spine has
 * nowhere to end but a corner, so it exits along the rim instead of down the middle. Two polygons
 * meeting end-to-end across a 20 m ribbon are the commonest case of all and were all being skipped.
 * At 8 m the corners are within 4 m of the mid-point, which really is negligible.
 */
const MIN_GATEWAY_M = 8;

/**
 * How close an arm has to come to the spine to count as having reached it, in metres. Arms are
 * sampled at ~1 m while looking for the cut, so anything below that would let a transverse crossing
 * slip between two samples; 1 m is the smallest value the sampling can actually resolve.
 *
 * Widening this does *not* remove arms that run parallel to the spine: measured at Ischgl, raising
 * it to 8 m moved redundant arm length the wrong way (29.4% -> 32.1% within 5 m of a spine), because
 * the parallel line is not the arm at all -- it is the gateway *fork* (see {@link FORK_M}), which is
 * emitted in place of the clipped arm and is 40 m long by design.
 */
const ARM_CLIP_M = 1;

/**
 * How much farther the polygon's true extremity has to be than the best portal before the spine
 * terminates there instead.
 *
 * Ends are normally restricted to portals, so a spine finishes where traffic actually carries on
 * rather than dead-ending mid-slope. That only holds while the portals span the polygon. Where they
 * huddle -- an unnamed ribbon its neighbours touch only in the middle -- the spine stops with them
 * and the ends of the polygon get no centreline. Above this ratio the portals are demonstrably not
 * describing the polygon's extent, so the extremity wins. Swept fleet-wide; see `check:spines`.
 */
const EXTEND_TO_EXTREMITY = Number(process.env.SKEL_EXTEND ?? 1.25);

/**
 * How far along the spine, in metres, a *gateway* arm's two forks are placed either side of the
 * arm's natural foot.
 *
 * An arm takes its direction from elevation like any other piste, and a single arm welded at the
 * spine's nearest approach is therefore a one-way valve whose direction is decided by an accident
 * of geometry: measured on SÃ¶lden, only 14 of 54 gateway transfers between adjacent polygons worked
 * both ways. Forking the arm to a point either side of the foot fixes that without knowing any
 * elevation, because gravity sorts the two out â€” on steep ground the forks straddle the gateway in
 * height, giving one arm in and one arm out, and on gentle ground both fall under the graph's
 * near-flat thresholds and become bidirectional traverses. 40 m is the shortest distance that still
 * clears `maxTraverseClimb` (8 m) on a typical bowl gradient, so the two regimes meet rather than
 * leaving a band of gradients that satisfies neither.
 */
const FORK_M = 40;

/**
 * Fallback fork distances, tried longest first, when {@link FORK_M} has no line of sight inside the
 * polygon. Tight or strongly curved polygons cannot see 40 m along their own spine, and on SÃ¶lden
 * that cost 32 of 79 gateway arms their fork. Shorter forks degrade gracefully rather than weakly:
 * they place the fork closer to the portal in height, which makes the pair *more* likely to clear
 * the near-flat thresholds and become bidirectional outright.
 */
const FORK_FALLBACK_M = [FORK_M, 25, 15, 10];

/** Least separation between a gateway arm's two forks for the pair to be worth emitting, in metres. */
const FORK_MIN_SEP_M = 8;

/**
 * When a polygon stops being a run and becomes merely the join between its neighbours.
 *
 * `chord^2 / (2 * area)` is the polygon's chord over its mean width. Measured: the two known
 * corridors sit at 1.34 and 1.36, while the ribbons that must never qualify -- including a ribbon
 * sandwiched between two other ribbons, which is the case most easily confused with a corridor --
 * run from 3.3 to 16. Nothing observed lies between 2 and 3.3, so 2 separates them with room to
 * spare. Fleet-wide the pair of gates below admits 84 of 1076 area polygons (7.8 %).
 */
const CORRIDOR_ASPECT_MAX = 2;
/**
 * Hard length cap on a corridor, independent of shape. A long polygon must never be treated as a
 * corridor however squat it measures, because getting that wrong truncates a real run's spine.
 */
const CORRIDOR_MAX_CHORD_M = 250;
/**
 * Fraction of the polygon's chord the chosen gateway pair must span. Below this the two gateways
 * are effectively in the same place, so a spine between them would not cross the polygon at all.
 * The known corridors span 0.48 and 0.68.
 */
const CORRIDOR_MIN_GATEWAY_SPAN = 0.35;

/**
 * How far inside its own rim a portal's graph search is anchored, in metres. Portals are boundary
 * points, so the interior test on them is arbitrary; seating strictly inside removes the ambiguity.
 * Small enough that the anchor stays within the lattice cell it would otherwise have used.
 */
const SEAT_INSIDE_M = 0.05;

/** SKELDIAG only: per-vertex local centredness, tagged with the local turn angle. */
export const CENTRED: { r: number; bend: number }[] = [];

/** Laplacian smoothing passes over the synthesised spine (grid paths are stair-stepped). */
const SMOOTH_PASSES = Number(process.env.SMOOTH_PASSES ?? 3);
/** How much clearance a smoothing step may give up, in metres. See the smoothing guard. */
const SMOOTH_TOL_M = Number(process.env.SMOOTH_TOL_M ?? 0.25);

/**
 * Floor for grid refinement, and the ceiling on how many interior samples one polygon may spend.
 * A 5 m wide ribbon needs a lattice finer than 12 m or its samples never become neighbours, but
 * refinement is exponential in cost so it has to stop somewhere.
 */
const MIN_GRID_M = 2;
const MAX_SAMPLES = 60000;

/**
 * Spine stitching. Two drawn spine pieces closer than SPINE_TOUCH_M are the same centreline cut in
 * two by the ring clip (it grazes outside for a metre and comes back), so they need no link. Beyond
 * that and up to STITCH_MAX_M the pieces are genuinely distinct -- typically a real OSM piste through
 * one end of the polygon alongside a synthesised spine -- and a short straight link makes the polygon
 * crossable. The ceiling is deliberately low: measured over the fleet the split-spine gaps are
 * strongly bimodal, a cluster under 40 m and then separate lobes at 60-900 m, and inventing a
 * several-hundred-metre link across a lobe boundary would be fictional terrain.
 */
const SPINE_TOUCH_M = 1;
const STITCH_MAX_M = 30;
/**
 * Ceiling for the second, *routed* stitch tier.
 *
 * The bimodality above is real but it is not the whole picture: it describes gaps measured as a
 * straight chord, and it missed a third population -- genuine holes inside ONE ribbon at 60-105 m,
 * where adopted OSM pieces simply stop and restart. Measured on Tignes w220915727, whose spine came
 * out in five fragments with holes of 26, 63 and 105 m. A straight chord is the wrong instrument for
 * those, which is why raising STITCH_MAX_M alone would be reckless: it cannot tell a hole in a ribbon
 * from a link across a lobe boundary.
 *
 * Routing the link through the polygon's interior can tell them apart. If two pieces are 105 m apart
 * and the interior route between them is also about 105 m, they are the same ribbon and the hole is
 * an artefact. If the interior route is several hundred metres the long way round, they are separate
 * lobes and nothing should be invented. So the detour ratio is the test, and the drawn link follows
 * the routed path rather than a chord, which keeps it inside the ring by construction.
 */
/**
 * Ceiling for the routed stitch tier, and the detour ratio that actually gates it.
 *
 * 150 was too tight and was rejecting real holes before the detour test ever ran: measured gaps of
 * 159 m (Tignes w220915727) and 195 m (Les 2 Alpes w1217422010) were thrown out on length alone.
 * The ratio, not the ceiling, is the test that tells a hole in a ribbon from a leap across a lobe,
 * so the ceiling only needs to be loose enough to let the ratio speak. Swept fleet-wide against
 * union coverage, polygons under 0.9 went 150 -> 175, 250 -> 170, 400 -> 169, 600 -> 169: the knee
 * is 250 and nothing is gained past 400. 250 also takes w220915727 from 88% to 97%.
 */
const STITCH_ROUTE_MAX_M = Number(process.env.SKEL_STITCH_MAX ?? 250);
const STITCH_DETOUR_MAX = Number(process.env.SKEL_STITCH_DETOUR ?? 1.6);

/** Lattice neighbours: right, up, and the two diagonals. The mirrored four come for free. */
const OFFS: [number, number][] = [
  [1, 0],
  [0, 1],
  [1, 1],
  [1, -1],
];


/**
 * Metres of a line that lie inside a ring.
 *
 * Sampling, not a vertex count: OSM vertices can be 100 m+ apart, so a way can cross a polygon
 * clean through without placing a single vertex inside it, and conversely one stray vertex inside
 * a huge polygon says nothing about coverage. Walking the line in short steps measures the thing we
 * actually care about â€” how much centreline this polygon really contains.
 */
function insideLenM(line: { lon: number; lat: number }[], ring: [number, number][]): number {
  if (line.length < 2) return 0;
  const inRing = (x: number, y: number): boolean => {
    let c = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i];
      const [xj, yj] = ring[j];
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
    }
    return c;
  };
  const k = Math.cos((line[0].lat * Math.PI) / 180);
  let total = 0;
  for (let i = 0; i + 1 < line.length; i++) {
    const a = line[i];
    const b = line[i + 1];
    const segM = Math.hypot((b.lon - a.lon) * k, b.lat - a.lat) * 111_320;
    if (segM <= 0) continue;
    const steps = Math.max(1, Math.ceil(segM / 10));
    const stepM = segM / steps;
    for (let s = 0; s < steps; s++) {
      const t = (s + 0.5) / steps;
      if (inRing(a.lon + (b.lon - a.lon) * t, a.lat + (b.lat - a.lat) * t)) total += stepM;
    }
  }
  return total;
}

/**
 * How much centreline a polygon must contain before that line is adopted as part of its spine.
 *
 * The absolute floor rejects a way that merely grazes a corner or shares a single rim vertex. The
 * relative term rejects a line that genuinely enters a huge polygon but only clips through one end
 * of it â€” adopting that would anchor the whole fan-out on a stub, which is the failure this pass
 * exists to prevent.
 */
const ADOPT_MIN_M = 15;
const ADOPT_MIN_FRAC = 0.1;

type XY = { x: number; y: number };

/** Even-odd ray casting in projected metres. */
function inside(p: XY, ring: XY[]): boolean {
  let hit = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i];
    const b = ring[j];
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) {
      hit = !hit;
    }
  }
  return hit;
}

/** Distance from a point to the ring, i.e. how much room the skeleton has at that sample. */
function clearance(p: XY, ring: XY[]): number {
  let best = Infinity;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i];
    const b = ring[j];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const l2 = dx * dx + dy * dy;
    let t = l2 > 0 ? ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2 : 0;
    t = Math.max(0, Math.min(1, t));
    const d = Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
    if (d < best) best = d;
  }
  return best;
}

export interface OverlayLine {
  coords: [number, number][];
  color: string;
  width: number;
  way?: number;
}

/**
 * One portal's connection to the spine.
 *
 * `coords` has a single entry when the portal already sits on the spine and needs no arm â€” that is
 * a correct result, but the caller must still weld that point into the spine, or deleting the rim
 * would leave the portal touching nothing.
 */
export interface SkelArm {
  /** Graph node id (`nâ€¦`) for a real portal, or `gw<wayA>-<wayB>-<i>` for an invented gateway. */
  portalId: string;
  gateway: boolean;
  coords: [number, number][];
}

/**
 * The skeleton as structured geometry rather than drawable lines.
 *
 * The overlay distinguishes spine from arm by *colour*, which is fine for looking at but far too
 * fragile to build a routing graph from. Roles and junction identity are therefore reported
 * explicitly.
 */
export interface SkelGeom {
  /** Spine pieces this polygon *invented* (case B). Class A/Bâ€² reuse a real OSM way instead. */
  synthSpines: [number, number][][];
  /**
   * Every spine piece this polygon actually ended up with, whichever way it got one â€” the clipped
   * OSM centreline (class A/Bâ€²) *and* the synthesised line (case B). `synthSpines` only covers the
   * invented case, and the adopted case otherwise exists solely as a drawn line, which the overlay
   * tells apart by colour â€” far too fragile to audit against. Reported so a check can ask whether
   * the spine really crosses its polygon.
   */
  spinePieces: [number, number][][];
  /** Short links joining spine pieces that were otherwise separate components. */
  stitches: [number, number][][];
  /**
   * MEASUREMENT ONLY -- never emitted as graph geometry, never drawn as skiable line.
   *
   * Where one OSM piste leaves its polygon and comes back, the ring clip cuts its centreline into
   * two spine pieces with an unpainted gap between them. Nothing is wrong: both pieces are the same
   * way, so the run is a single continuous edge in the routing graph and no link is needed (that is
   * why the stitch pass unions them without drawing anything). But a coverage check sees a hole and
   * scores the polygon as defective -- measured over the fleet this happens 113 times, 59 of them
   * over 30 m, which was enough to bury the genuine defects in false positives. Recording the
   * bridged span lets a check count it as covered without inventing anything.
   */
  wayBridges: [number, number][][];
  arms: SkelArm[];
}
export interface OverlayPoint {
  at: [number, number];
  color: string;
  r?: number;
  tag?: string;
  label?: string;
}

export interface PolyResult {
  wayId: number;
  label: string;
  cls: string;
  portals: number;
  routed: number;
  /** Portals the grid could not reach â€” the number that matters for connectivity. */
  stranded: number;
  armM: number;
  /** Worst distance from a pink arm's terminal point to the spine. Should be ~0. */
  maxGap: number;
  /** How many pink arms end more than 1 m off the spine. */
  gapped: number;
  /** True when the polygon's run has no usable centreline, so there is no spine to fan in to. */
  noSpine: boolean;
  /** True when the spine was invented (case B) rather than clipped from an OSM centreline. */
  synth: boolean;
  /** True when the synthesised spine's termini came from the corridor override, not the extremity sweep. */
  corridor: boolean;
  /** Extent of the OSM centreline found inside, over the polygon's own length. 0 when class B. */
  spanFrac: number;
  /** The polygon's length, taken as half its perimeter (same convention as the classifier). */
  polyLenM: number;
  /** Mid-boundary gateway portals added for this polygon. */
  gateways: number;
  /** Short links added to join spine pieces that were separate components. */
  stitches: number;
  /** Spine components still separate after stitching (0 = one connected spine). */
  splitComps: number;
  lines: OverlayLine[];
  points: OverlayPoint[];
  /** Same skeleton, expressed by role so `build.ts` can turn it into pistes. */
  skel: SkelGeom;
  /**
   * OSM ways carrying this polygon's real centreline (classes A/Bâ€²), empty for a synthesised one.
   * An arm welds onto one of these, never onto whatever piste happens to pass within tolerance â€”
   * an unrelated parallel run would otherwise gain a junction that does not exist on the ground.
   */
  spineWayIds: number[];
  /** Fall-line fact check on the spine this polygon ended up with. */
  fall: FallCheck;
}

/**
 * Build the grid, route every portal in to the spine, and return the drawable result.
 * Returns null when the polygon is too small to hold a single interior sample.
 */
function skeleton(
  ring: [number, number][],
  portalPts: { id: string; lon: number; lat: number; gateway?: boolean }[],
  spine: GeoPoint[][],
  tag = '',
): Omit<PolyResult, 'wayId' | 'label' | 'cls' | 'spineWayIds' | 'fall'> | null {
  const lat0 = ring.reduce((s, p) => s + p[1], 0) / ring.length;
  const kx = (Math.PI / 180) * R * Math.cos(toRad(lat0));
  const ky = (Math.PI / 180) * R;
  const toXY = (lon: number, lat: number): XY => ({ x: lon * kx, y: lat * ky });
  const toLL = (p: XY): [number, number] => [p.x / kx, p.y / ky];

  const rXY = ring.map(([lon, lat]) => toXY(lon, lat));
  const minX = Math.min(...rXY.map((p) => p.x));
  const maxX = Math.max(...rXY.map((p) => p.x));
  const minY = Math.min(...rXY.map((p) => p.y));
  const maxY = Math.max(...rXY.map((p) => p.y));

  // --- interior samples ---
  // A narrow polygon can swallow a 12 m lattice entirely, which used to strand its portals.
  // Refining on sample COUNT is not enough: a 2 km ribbon 7 m wide yields plenty of samples at
  // 12 m, but they are isolated dots with no lattice neighbours, so the interior graph is
  // fragmented and no path can cross the polygon. Refine until the interior is *connected*.
  // Samples are found by scanline span-filling the ring rather than point-in-polygon testing
  // every lattice point, which is what makes a 2 m grid on a long ribbon affordable.
  interface Grid {
    cols: number;
    rows: number;
    cell: Map<number, number>;
    nx: number[];
    ny: number[];
    nclear: number[];
  }
  const buildGrid = (s: number): Grid => {
    const cols = Math.max(1, Math.ceil((maxX - minX) / s));
    const rows = Math.max(1, Math.ceil((maxY - minY) / s));
    const cell = new Map<number, number>();
    const nx: number[] = [];
    const ny: number[] = [];
    const nclear: number[] = [];
    for (let j = 0; j <= rows; j++) {
      const y = minY + j * s;
      const xs: number[] = [];
      for (let i = 0, k = rXY.length - 1; i < rXY.length; k = i++) {
        const a = rXY[i];
        const b = rXY[k];
        if (a.y > y !== b.y > y) xs.push(((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x);
      }
      if (xs.length < 2) continue;
      xs.sort((p, q) => p - q);
      for (let t = 0; t + 1 < xs.length; t += 2) {
        const x0 = xs[t];
        const x1 = xs[t + 1];
        for (let i = Math.max(0, Math.ceil((x0 - minX) / s)); i <= cols; i++) {
          const x = minX + i * s;
          if (x <= x0) continue;
          if (x >= x1) break;
          cell.set(j * (cols + 1) + i, nx.length);
          nx.push(x);
          ny.push(y);
          nclear.push(clearance({ x, y }, rXY));
        }
      }
    }
    return { cols, rows, cell, nx, ny, nclear };
  };
  /** Lattice-connected component ids for a grid, plus the size of the largest. */
  const components = (g: Grid): { root: (i: number) => number; best: number } => {
    const n = g.nx.length;
    const par = new Int32Array(n);
    for (let i = 0; i < n; i++) par[i] = i;
    const find = (a: number): number => {
      let r = a;
      while (par[r] !== r) r = par[r];
      while (par[a] !== r) {
        const nxt = par[a];
        par[a] = r;
        a = nxt;
      }
      return r;
    };
    for (const [key, a] of g.cell) {
      const i = key % (g.cols + 1);
      const j = (key - i) / (g.cols + 1);
      for (const [di, dj] of OFFS) {
        const b = g.cell.get((j + dj) * (g.cols + 1) + (i + di));
        if (b == null) continue;
        const ra = find(a);
        const rb = find(b);
        if (ra !== rb) par[ra] = rb;
      }
    }
    const cnt = new Map<number, number>();
    let best = 0;
    for (let i = 0; i < n; i++) {
      const r = find(i);
      const c = (cnt.get(r) ?? 0) + 1;
      cnt.set(r, c);
      if (c > best) best = c;
    }
    return { root: find, best };
  };
  /** Size of the biggest lattice-connected group of samples. */
  const largestGroup = (g: Grid): number => components(g).best;
  /**
   * Can every portal reach every other one through the lattice? This, not "the interior is mostly
   * connected", is what the skeleton actually needs. A 6.5 m wide ribbon sampled at 6 m is >90%
   * connected and still pinches into two halves, so the 90% test passed and the two end portals
   * could never see each other -- the polygon came out with no spine at all.
   */
  const portalsJoined = (g: Grid, s: number): boolean => {
    if (!g.nx.length) return false;
    const { root } = components(g);
    let common: Set<number> | null = null;
    for (const p of portalPts) {
      const q = toXY(p.lon, p.lat);
      const near = new Set<number>();
      let bd = Infinity;
      let bi = -1;
      for (let i = 0; i < g.nx.length; i++) {
        const d = Math.hypot(g.nx[i] - q.x, g.ny[i] - q.y);
        if (d <= 2.2 * s) near.add(root(i));
        if (d < bd) {
          bd = d;
          bi = i;
        }
      }
      // Mirrors the linking fallback: a portal with nothing in radius still attaches to the
      // nearest sample it can see, so judge it on that one.
      if (!near.size && bi >= 0) near.add(root(bi));
      if (!near.size) return false;
      if (common === null) common = near;
      else {
        const both = new Set<number>();
        for (const r of near) if (common.has(r)) both.add(r);
        if (!both.size) return false;
        common = both;
      }
    }
    return true;
  };
  let step = GRID_M;
  let grid = buildGrid(step);
  for (;;) {
    if (grid.nx.length >= 24 && largestGroup(grid) >= 0.9 * grid.nx.length && portalsJoined(grid, step)) break;
    if (step <= MIN_GRID_M) break;
    const finer = buildGrid(step / 2);
    if (finer.nx.length > MAX_SAMPLES) break;
    step /= 2;
    grid = finer;
  }
  const { cols, cell } = grid;
  const nx = grid.nx;
  const ny = grid.ny;
  const nclear = grid.nclear;
  if (nx.length < 2) return null;
  const gridCount = nx.length;
  if (process.env.SKELDIAG)
    console.log(
      `    grid w${tag} samples=${gridCount} step=${Math.round(step)}m largestComp=${(largestGroup(grid) / Math.max(1, gridCount)).toFixed(2)}`,
    );

  // Nearest point ON the ring, with its distance. Used both to police the skeleton and to re-seat
  // portals that do not quite land on their own ring.
  const nearestOnRing = (q: XY): { x: number; y: number; d: number } => {
    let bx = rXY[0].x;
    let by = rXY[0].y;
    let bd = Infinity;
    for (let i = 1; i < rXY.length; i++) {
      const a = rXY[i - 1];
      const b = rXY[i];
      const vx = b.x - a.x;
      const vy = b.y - a.y;
      const L = vx * vx + vy * vy;
      const t = L > 0 ? Math.max(0, Math.min(1, ((q.x - a.x) * vx + (q.y - a.y) * vy) / L)) : 0;
      const px = a.x + vx * t;
      const py = a.y + vy * t;
      const d = Math.hypot(px - q.x, py - q.y);
      if (d < bd) {
        bd = d;
        bx = px;
        by = py;
      }
    }
    return { x: bx, y: by, d: bd };
  };
  const distToRing = (q: XY): number => nearestOnRing(q).d;

  // Portals are sources, not samples: they sit ON the boundary, so they never survive the
  // point-in-polygon test and must be added explicitly.
  //
  // A portal is a graph NODE, and its polygon's ring is OSM GEOMETRY; buildGraph merges endpoints
  // onto a shared node without moving the geometry, so a portal can sit metres off its own ring.
  // Gateways can too, being the midpoint of a boundary shared with a neighbour whose rim is only
  // coincident to within a few metres. Such a portal is outside the ring, so every candidate link
  // fails the interior test, and it then becomes its own "local hub" -- routed, no red dot, and
  // silently no arm at all. That was 169 portals fleet-wide. Anchor the graph search at the
  // portal's FOOT on the ring instead, just inside, and put the real portal position back on the
  // front of the finished arm so the drawn arm still reaches it.
  const portalIdx: number[] = [];
  const gatewayIdx = new Set<number>();
  /** True position of each portal, where that differs from the node the search is anchored at. */
  const portalTrue = new Map<number, XY>();
  /** Where each re-seated portal's arm should cross the rim, so the stub does not cut the corner. */
  const portalFoot = new Map<number, XY>();
  const seatDiag = new Map<number, string>();
  for (const p of portalPts) {
    const q = toXY(p.lon, p.lat);
    let seat = q;
    // A portal lies ON the boundary, so point-in-polygon on it is a coin flip -- 1345 of 1428
    // gateways land within 5 cm of their own rim. Anchoring the search on the rim makes every
    // candidate chord fragile: at a convex corner it leaves the polygon immediately and the portal
    // ends up its own local hub with no arm. Seat strictly inside whichever way the test fell.
    if (!inside(q, rXY) || distToRing(q) < SEAT_INSIDE_M) {
      const f = nearestOnRing(q);
      // Step INWARD from the foot. Three families, tried at increasing distance so the seat stays
      // as close to the true portal as possible:
      //   ray     - continue along portal->foot. Works for a foot in the middle of a rim edge, but
      //             is degenerate when the portal is exactly ON the rim (f == q, no direction), and
      //             points the wrong way when the foot is a convex VERTEX: extending past the corner
      //             leaves the polygon again. Those two cases were 23 of the 27 armless portals.
      //   normal  - perpendicular to each rim edge that touches the foot, both signs. Handles the
      //             degenerate and vertex cases, since a corner has two incident edges.
      //   lattice - nearest interior grid node. The grid is scanline-filled, so it is always inside;
      //             this is the guaranteed backstop for a spike too thin to admit any offset seat.
      const ux = f.x - q.x;
      const uy = f.y - q.y;
      const L = Math.hypot(ux, uy);
      const normals: XY[] = [];
      for (let i = 1; i < rXY.length; i++) {
        const a = rXY[i - 1];
        const b = rXY[i];
        const vx = b.x - a.x;
        const vy = b.y - a.y;
        const LL = vx * vx + vy * vy;
        if (LL <= 0) continue;
        const t = Math.max(0, Math.min(1, ((f.x - a.x) * vx + (f.y - a.y) * vy) / LL));
        if (Math.hypot(a.x + vx * t - f.x, a.y + vy * t - f.y) > 0.05) continue;
        const nL = Math.sqrt(LL);
        normals.push({ x: -vy / nL, y: vx / nL });
      }
      for (const eps of [0.25, 0.5, 1, 2, 4, 8]) {
        if (L > 1e-6) {
          const c = { x: f.x + (ux / L) * eps, y: f.y + (uy / L) * eps };
          if (inside(c, rXY)) {
            seat = c;
            break;
          }
        }
        let hit: XY | null = null;
        for (const n of normals) {
          for (const sgn of [1, -1]) {
            const c = { x: f.x + n.x * sgn * eps, y: f.y + n.y * sgn * eps };
            if (inside(c, rXY)) {
              hit = c;
              break;
            }
          }
          if (hit) break;
        }
        if (hit) {
          seat = hit;
          break;
        }
      }
      if (seat === q) {
        let bi = -1;
        let bd = Infinity;
        for (let i = 0; i < gridCount; i++) {
          const d = Math.hypot(nx[i] - q.x, ny[i] - q.y);
          if (d < bd) {
            bd = d;
            bi = i;
          }
        }
        if (bi >= 0) seat = { x: nx[bi], y: ny[bi] };
      }
      if (process.env.PORTDIAG && seat === q) seatDiag.set(nx.length, `noseat gridNodes=${gridCount}`);
      if (seat !== q) portalFoot.set(nx.length, f);
    }
    if (seat !== q) portalTrue.set(nx.length, q);
    if (p.gateway) gatewayIdx.add(nx.length);
    portalIdx.push(nx.length);
    nx.push(seat.x);
    ny.push(seat.y);
    nclear.push(0);
  }

  if (process.env.PORTDIAG) {
    for (const p of portalPts) {
      const q = toXY(p.lon, p.lat);
      if (p.gateway) console.log(`    gwdist ${p.id} d=${distToRing(q).toFixed(2)}m inside=${inside(q, rXY)}`);
      else if (!inside(q, rXY)) console.log(`    outside portal ${p.id} d=${distToRing(q).toFixed(2)}m`);
    }
  }

  // --- adjacency ---
  // Samples about every metre, so it does not step over a narrow neck the way a coarser stride can.
  const segInside = (a: XY, b: XY): boolean => {
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    const n = Math.min(40, Math.max(2, Math.ceil(len)));
    for (let i = 1; i < n; i++) {
      const t = i / n;
      if (!inside({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }, rXY)) return false;
    }
    return true;
  };
  /**
   * De-stair-step a lattice path in place. A Dijkstra path over the sampling grid can only step
   * between neighbouring grid nodes, so it comes out as a visible zig-zag staircase. Laplacian
   * smoothing straightens it, but a Laplacian pass also pulls a vertex toward the chord of its
   * neighbours, which on a bend means toward the inside rim -- so a move is accepted only when it
   * keeps its clearance AND leaves both of the segments it creates inside the ring. The passes run
   * in place rather than Jacobi-style so every check sees the current neighbours; the grid path is
   * inside by construction, so the whole path stays inside by induction.
   */
  const smoothPath = (raw: XY[]): XY[] => {
    for (let pass = 0; pass < SMOOTH_PASSES && raw.length > 2; pass++) {
      for (let i = 1; i < raw.length - 1; i++) {
        const q = {
          x: (raw[i - 1].x + 2 * raw[i].x + raw[i + 1].x) / 4,
          y: (raw[i - 1].y + 2 * raw[i].y + raw[i + 1].y) / 4,
        };
        if (!inside(q, rXY)) continue;
        if (clearance(q, rXY) < clearance(raw[i], rXY) - SMOOTH_TOL_M) continue;
        if (!segInside(raw[i - 1], q) || !segInside(q, raw[i + 1])) continue;
        raw[i] = q;
      }
    }
    return raw;
  };
  /**
   * Is the straight line between two interior samples itself interior? Both endpoints being inside
   * is NOT enough: across a concave notch or a hairpin the chord between two inside samples leaves
   * the ring, and since every spine and arm is a path over these links, the skeleton inherits the
   * excursion. Clearance is 1-Lipschitz, so if either endpoint is farther from the boundary than the
   * link is long the chord cannot reach the boundary and no sampling is needed -- which is the case
   * for the overwhelming majority of links, well away from the rim.
   */
  const linkInside = (a: number, b: number): boolean => {
    const len = Math.hypot(nx[a] - nx[b], ny[a] - ny[b]);
    if (Math.max(nclear[a], nclear[b]) > len) return true;
    return segInside({ x: nx[a], y: ny[a] }, { x: nx[b], y: ny[b] });
  };
  const adj: { to: number; w: number; len: number }[][] = Array.from({ length: nx.length }, () => []);
  // Cost per metre falls off as a power of the clearance. This is deliberately SCALE-FREE: an
  // earlier version normalised against the polygon's widest point, so in a polygon that is broad
  // in one place and narrow in another the whole narrow half scored near-zero and there was no
  // centring force left at all -- measurably, half the spines ran at under half the room
  // available to them. A ratio has no such reference: halving the clearance always costs the
  // same multiple, wherever you are in the polygon.
  const cfloor = Math.max(1, step / 2);
  const stepCost = (a: number, b: number): number => {
    const len = Math.hypot(nx[a] - nx[b], ny[a] - ny[b]);
    const c = Math.min(nclear[a], nclear[b]);
    // Clearance beyond the reference earns nothing more, so a wide bowl cannot lure the spine
    // into a detour just to touch its widest point.
    const eff = Math.min(Math.max(c, cfloor), CENTRE_REF_M);
    return len * Math.pow(CENTRE_REF_M / eff, CENTRE_P);
  };
  const link = (a: number, b: number): void => {
    const w = stepCost(a, b);
    const len = Math.hypot(nx[a] - nx[b], ny[a] - ny[b]);
    adj[a].push({ to: b, w, len });
    adj[b].push({ to: a, w, len });
  };
  for (const [key, a] of cell) {
    const i = key % (cols + 1);
    const j = (key - i) / (cols + 1);
    for (const [di, dj] of OFFS) {
      const b = cell.get((j + dj) * (cols + 1) + (i + di));
      if (b != null && linkInside(a, b)) link(a, b);
    }
  }
  // Attach each portal to the interior. Radius alone stranded portals in narrow necks, so fall
  // back to the nearest samples the portal can *see* (segment stays inside the ring) at any
  // distance -- the link is still on confirmed piste, which is the whole point of the fan-out.
  const visible = (a: XY, b: XY): boolean => {
    const n = Math.max(2, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / 5));
    for (let i = 1; i < n; i++) {
      const t = i / n;
      if (!inside({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }, rXY)) return false;
    }
    return true;
  };
  for (const pi of portalIdx) {
    const q = { x: nx[pi], y: ny[pi] };
    let linked = 0;
    const order: { g: number; d: number }[] = [];
    for (let g = 0; g < gridCount; g++) {
      const d = Math.hypot(nx[pi] - nx[g], ny[pi] - ny[g]);
      if (d <= 2.2 * step) {
        // A portal sits ON the rim, so its clearance is 0 and the Lipschitz shortcut never applies:
        // every one of these short links has to be checked, or an arm can start by cutting across
        // the outside of a corner the portal happens to sit on.
        if (!segInside(q, { x: nx[g], y: ny[g] })) continue;
        link(pi, g);
        linked++;
      } else order.push({ g, d });
    }
    if (linked) continue;
    order.sort((a, b) => a.d - b.d);
    for (const { g } of order) {
      if (!visible(q, { x: nx[g], y: ny[g] })) continue;
      link(pi, g);
      if (++linked >= 3) break;
    }
  }

  // --- targets: the existing centreline, wherever it passes through this polygon ---
  const targets: number[] = [];
  // Where a target sample stands in for a real centreline vertex, remember that vertex so the arm
  // can end exactly ON the blue line instead of up to one cell short of it.
  const anchor = new Map<number, XY>();
  /** Distance from each target grid node to the spine point currently anchored to it. */
  const anchorD = new Map<number, number>();
  // Densify first: OSM centreline vertices can be 100 m+ apart, and a target only exists where a
  // vertex happens to fall. Without this a portal beside a long straight stretch of spine has no
  // nearby target and has to walk to the next vertex, which is the "arm joins a far part of the
  // blue line" artefact.
  const addTarget = (q: XY): void => {
    if (!inside(q, rXY)) return;
    let best = -1;
    let bd = Infinity;
    for (let g = 0; g < gridCount; g++) {
      const d = Math.hypot(nx[g] - q.x, ny[g] - q.y);
      if (d < bd) {
        bd = d;
        best = g;
      }
    }
    // Many densified spine points can collapse onto the same grid node. Keep the NEAREST one:
    // first-wins sends the arm to whichever vertex happened to be visited first, which can be up to
    // 2*step away, and the arm then runs past its own attachment point and doubles back.
    if (best < 0 || bd > 2 * step) return;
    const had = anchorD.get(best);
    if (had === undefined) targets.push(best);
    else if (had <= bd) return;
    anchorD.set(best, bd);
    anchor.set(best, q);
  };
  /**
   * Nearest interior lattice sample to a point, or -1 when the point is too far from the lattice to
   * be represented by one. Same search and same tolerance as `addTarget`.
   */
  const nearestNode = (q: XY): number => {
    let best = -1;
    let bd = Infinity;
    for (let g = 0; g < gridCount; g++) {
      const d = Math.hypot(nx[g] - q.x, ny[g] - q.y);
      if (d < bd) {
        bd = d;
        best = g;
      }
    }
    return best >= 0 && bd <= 2 * step ? best : -1;
  };
  for (const seg of spine) {
    for (let i = 0; i < seg.length; i++) {
      const a = toXY(seg[i].lon, seg[i].lat);
      addTarget(a);
      if (i + 1 >= seg.length) continue;
      const b = toXY(seg[i + 1].lon, seg[i + 1].lat);
      const n = Math.floor(Math.hypot(b.x - a.x, b.y - a.y) / (step / 2));
      for (let k = 1; k < n; k++) {
        const t = k / n;
        addTarget({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
      }
    }
  }
  // How much of the polygon does the OSM centreline actually cover? "Class A" is decided by an OSM
  // line *touching* the polygon, which lets a 7 m graze of one corner count as a centreline: the
  // whole 2.5 km ribbon then fans every portal 2.4 km up to that stub instead of synthesising a
  // spine. Measure the span of what we found against the polygon's own length so we can tell a real
  // centreline from a graze.
  let ax0 = Infinity;
  let ay0 = Infinity;
  let ax1 = -Infinity;
  let ay1 = -Infinity;
  for (const q of anchor.values()) {
    ax0 = Math.min(ax0, q.x);
    ay0 = Math.min(ay0, q.y);
    ax1 = Math.max(ax1, q.x);
    ay1 = Math.max(ay1, q.y);
  }
  const spineExtent = anchor.size ? Math.hypot(ax1 - ax0, ay1 - ay0) : 0;
  let perimM = 0;
  for (let i = 1; i < rXY.length; i++) perimM += Math.hypot(rXY[i].x - rXY[i - 1].x, rXY[i].y - rXY[i - 1].y);
  // Same convention as the classifier: a ribbon's length is about half its perimeter.
  const polyLenM = perimM / 2;
  const spanFrac = polyLenM > 0 ? spineExtent / polyLenM : 0;
  /**
   * Dijkstra over the interior sample lattice, optionally with the centring bias.
   *
   * `src` may be a single sample or a whole set. The multi-source form is what lets the tail pass
   * below ask "how far is the farthest point of this polygon from the spine *as a whole*" in one
   * sweep, with `prev` already pointing back to whichever part of the spine is nearest.
   */
  const dij = (src: number | number[], bias: boolean): { dist: number[]; prev: number[] } => {
    const d = new Array<number>(nx.length).fill(Infinity);
    const pv = new Array<number>(nx.length).fill(-1);
    const h: [number, number][] = [];
    const hpush = (k: number, n: number): void => {
      h.push([k, n]);
      let i = h.length - 1;
      while (i > 0) {
        const p = (i - 1) >> 1;
        if (h[p][0] <= h[i][0]) break;
        [h[p], h[i]] = [h[i], h[p]];
        i = p;
      }
    };
    const hpop = (): [number, number] | undefined => {
      if (!h.length) return undefined;
      const top = h[0];
      const last = h.pop()!;
      if (h.length) {
        h[0] = last;
        let i = 0;
        for (;;) {
          const l = 2 * i + 1;
          const r = l + 1;
          let s = i;
          if (l < h.length && h[l][0] < h[s][0]) s = l;
          if (r < h.length && h[r][0] < h[s][0]) s = r;
          if (s === i) break;
          [h[s], h[i]] = [h[i], h[s]];
          i = s;
        }
      }
      return top;
    };
    for (const s of Array.isArray(src) ? src : [src]) {
      if (d[s] === 0) continue;
      d[s] = 0;
      hpush(0, s);
    }
    for (;;) {
      const top = hpop();
      if (!top) break;
      const [dd, n] = top;
      if (dd > d[n]) continue;
      for (const e of adj[n]) {
        const nd = dd + (bias ? e.w : e.len);
        if (nd < d[e.to]) {
          d[e.to] = nd;
          pv[e.to] = n;
          hpush(nd, e.to);
        }
      }
    }
    return { dist: d, prev: pv };
  };
  // Case B: no OSM centreline runs through this polygon, so there is nothing to clip and no spine to
  // fan in to. Synthesise one instead of degrading to a single arbitrary hub: the spine of a ribbon
  // is the centre-biased path between its two ends, and the two ends are the geodesically most
  // distant pair of portals. Double sweep (farthest from any portal, then farthest from that) finds
  // the pair in two passes; the third pass re-routes it with the centring bias so the line runs down
  // the middle rather than along whichever rim is shorter.
  /**
   * How much of a polygon's length an OSM centreline must span before it is accepted as the spine
   * on its own. Below this the polygon *also* gets a synthesised spine, which is added alongside the
   * adopted pieces rather than replacing them.
   *
   * "Class A" is decided by an OSM line *touching* the polygon, which let a 7 m graze of one corner
   * count as the centreline of a 2.5 km ribbon: every portal then fanned 2.4 km up to that stub.
   * 0.4 was chosen to separate real centrelines (>=0.75) from grazes (<=0.29).
   *
   * Raised to 0.6 once `check:spines` could measure axis *coverage*. The gap 0.4 left was not
   * grazes, it was runs that genuinely cross the polygon and then simply stop inside it, leaving one
   * end with no centreline -- adopted at 0.4, so never synthesised for, and invisible to every check
   * that only asked whether the spine descends. Swept fleet-wide: 0.4 -> 0.6 took the flagged count
   * from 10 to 3 and is the knee of the curve; 0.75 and 0.9 buy almost nothing and invent more.
   */
  const SPAN_MIN = Number(process.env.SKEL_SPAN_MIN ?? 0.6);
  /**
   * How long an uncovered stretch beyond the end of the spine has to be before it is worth growing
   * the spine into it, as a fraction of the polygon's length and as an absolute floor.
   *
   * See the tail pass below for why this exists as a separate lever from `SPAN_MIN`.
   *
   * Swept fleet-wide over the 887 polygons whose axis is long enough for coverage to mean anything,
   * counting how many are covered less than 90%: disabled 200, 0.25 -> 198, 0.15 -> 192, 0.10 -> 181,
   * 0.08 -> 175, 0.05 -> 168, 0.03 -> 167. The curve flattens at 0.05, where `TAIL_MIN_M` takes over
   * as the binding constraint -- below ~60 m an uncovered stub is not worth inventing geometry for.
   * Mean coverage 0.934 -> 0.940 and the fall-line check stays at zero throughout, so the tails that
   * get added descend like the spines they extend.
   */
  const TAIL_MIN_FRAC = Number(process.env.SKEL_TAIL ?? 0.05);
  const TAIL_MIN_M = 60;
  /**
   * How many times the polygon's half-width a candidate tail must run before it is worth adding.
   *
   * This replaced a test on the tip's own clearance -- "far from the spine but close to the rim" --
   * which read plausibly and was structurally incapable of rejecting anything: the farthest point
   * from a spine is essentially always ON the rim, where clearance is ~0, so the comparison passed
   * every time. Sweeping it over 1.5..4.0 moved not one polygon, which was the evidence that it
   * never fired, misread at the time as the length floor simply binding first.
   *
   * Width is the honest discriminator. On a wide slope the farthest point from a centred spine is
   * sideways at about half the width, so a tail there is ~1x half-width and adds nothing -- the spine
   * already runs down the middle of that terrain. A genuine lobe or unserved stretch runs many times
   * the half-width before it ends. Confirmed on Sölden, where the sideways spurs that created the
   * trapped nodes are exactly the ~1x case.
   */
  const TAIL_WIDTH_RATIO = Number(process.env.SKEL_TAILWIDTH ?? 2);
  /** Safety stop for the coverage loop; it normally runs dry well before this. */
  const TAIL_MAX_PASSES = 8;
  let synth: XY[] | null = null;
  let corridorUsed = false;
  if ((!targets.length || spanFrac < SPAN_MIN) && portalIdx.length >= 1) {
    // A gateway is where traffic actually crosses into the neighbouring polygon, so when the spine
    // reaches the end of the polygon it should finish at the gateway rather than at a rim corner
    // beside it: at an end cap the two CORNERS are always farther apart than the mid-point between
    // them, so plain distance picks a corner every time and the gateway gets demoted to an arm.
    //
    // That preference is strictly LOCAL. Scoring it as `distance x 1.5` made it global, so any
    // gateway at >=67% of the polygon's length beat the true far end - a side branch-off part way
    // along a long polygon truncated the spine there instead of letting it run to the end. Pick the
    // terminus by true geodesic extremity, then snap it to a gateway only if that gateway is at the
    // same end cap: nearly as far away AND physically beside the extremal portal.
    const GATEWAY_SNAP_FRAC = 0.85;
    const gatewaySnapM = Math.max(3 * step, 40);
    // Portals are the PREFERRED termini, not a precondition. A cul-de-sac pocket with a single
    // portal, or a ribbon whose two portals sit in separate interior lobes, still has to get a
    // spine: leaving it rim-only means phase 6 keeps a ring whose far side climbs, which is the
    // hugging this whole exercise exists to remove. So fall back to the farthest interior sample.
    // Candidate termini. A spine that ends where nothing carries on is a dead end mid-slope: the
    // polygon's real junction then hangs off a long arm instead of being on the spine. Restricting
    // the ENDS to through-connected portals is not the old `distance x 1.5` gateway preference that
    // truncated ribbons -- that was a multiplicative score which let a nearer crossing outrank the
    // true far end. Here the extremity search is untouched; only dead ends are struck from the
    // candidate list. Needs two survivors to define a pair, else fall back to every portal.
    const farthest = (from: number): number => {
      const { dist: d } = dij(from, false);
      let best = -1;
      for (const pi of portalIdx) {
        if (pi === from || !isFinite(d[pi])) continue;
        if (best < 0 || d[pi] > d[best]) best = pi;
      }
      // The farthest reachable point of the polygon, portal or not.
      let anyBest = -1;
      for (let i = 0; i < nx.length; i++) {
        if (i === from || !isFinite(d[i])) continue;
        if (anyBest < 0 || d[i] > d[anyBest]) anyBest = i;
      }
      if (best < 0) return anyBest;
      // Restricting the ends to portals assumes the portals reach the ends. On a ribbon whose
      // portals all cluster in one stretch -- typically an unnamed polygon touched by its neighbours
      // only in the middle -- that assumption fails silently: the spine terminates at the cluster
      // and the rest of the polygon gets no centreline at all, which is what `cover` catches. When
      // the true extremity is substantially farther than any portal, the portals are not describing
      // this polygon's extent and the extremity is the honest terminus.
      if (anyBest >= 0 && d[anyBest] > EXTEND_TO_EXTREMITY * d[best]) return anyBest;
      if (gatewayIdx.has(best)) return best;
      let snapped = -1;
      for (const pi of portalIdx) {
        if (pi === from || !isFinite(d[pi]) || !gatewayIdx.has(pi)) continue;
        if (d[pi] < GATEWAY_SNAP_FRAC * d[best]) continue;
        if (Math.hypot(nx[pi] - nx[best], ny[pi] - ny[best]) > gatewaySnapM) continue;
        if (snapped < 0 || d[pi] > d[snapped]) snapped = pi;
      }
      return snapped >= 0 ? snapped : best;
    };

    // --- corridor test (see the override below) ---
    // Shape, not size. The two known corridors differ by ~10x in area (0.07 ha and 0.66 ha), so no
    // absolute cap separates them from the ribbons that must never qualify -- one of the ribbons is
    // smaller than one of the corridors. What does separate them is squatness: both corridors have
    // chord/meanWidth ~= 1.35, while every ribbon checked is >= 3.3. Taking meanWidth = 2*area/chord,
    // that ratio is chord^2 / (2*area), so the whole test is two multiplications on the ring.
    let area2 = 0;
    for (let i = 1; i < rXY.length; i++) area2 += rXY[i - 1].x * rXY[i].y - rXY[i].x * rXY[i - 1].y;
    const ringArea = Math.abs(area2) / 2;
    // O(n^2), so decimate: a corridor's ring is short, and on a long ring the answer is "not squat"
    // whichever vertices are sampled.
    const stride = Math.max(1, Math.ceil(rXY.length / 300));
    let maxChord = 0;
    for (let i = 0; i < rXY.length; i += stride)
      for (let j = i + stride; j < rXY.length; j += stride)
        maxChord = Math.max(maxChord, Math.hypot(rXY[i].x - rXY[j].x, rXY[i].y - rXY[j].y));
    const aspect = ringArea > 0 ? (maxChord * maxChord) / (2 * ringArea) : Infinity;
    // The length cap is a second, independent guard: the user's hard requirement is that a long
    // polygon can never be read as a corridor, not even a long one wedged between two others.
    const corridor = aspect <= CORRIDOR_ASPECT_MAX && maxChord <= CORRIDOR_MAX_CHORD_M;

    /**
     * The two gateways farthest apart through the polygon's interior, or null.
     *
     * Null when there are fewer than two reachable gateways, or when the best pair sits huddled in
     * one part of the ring -- a pair that spans almost none of the polygon is not the line traffic
     * takes across it, and the ordinary extremity sweep is the better answer there.
     */
    const farthestGatewayPair = (): [number, number] | null => {
      const gws = portalIdx.filter((i) => gatewayIdx.has(i));
      if (gws.length < 2 || gws.length > 12) return null;
      let bestPair: [number, number] | null = null;
      let bestD = -1;
      for (const g of gws) {
        const { dist } = dij(g, false);
        for (const h of gws) {
          if (h === g || !isFinite(dist[h]) || dist[h] <= bestD) continue;
          bestD = dist[h];
          bestPair = [g, h];
        }
      }
      if (!bestPair) return null;
      const [a, b] = bestPair;
      const sep = Math.hypot(nx[a] - nx[b], ny[a] - ny[b]);
      return sep >= CORRIDOR_MIN_GATEWAY_SPAN * maxChord ? bestPair : null;
    };
    // Seed the sweep from any portal that can actually reach another. Seeding blindly from the
    // first one silently produced no spine at all whenever that portal sat in an isolated pocket.
    let u = -1;
    for (const seed of portalIdx) {
      u = farthest(seed);
      if (u >= 0) break;
    }
    let v = u >= 0 ? farthest(u) : -1;

    // Corridor override. On a long ribbon the extremity sweep is right: the spine should run its
    // whole length. On a SQUAT polygon it is wrong, because such a polygon is not a slope in its own
    // right -- it is the join between its neighbours, and what matters is not how far the spine
    // reaches but that it connects the places traffic actually enters and leaves by. The sweep
    // maximises length, so on a corridor it ends at whichever rim CORNERS are farthest apart and the
    // gateways get demoted to arms; a route crossing the corridor then has to detour out to a corner
    // and back. Measured on the two known cases, the gateway pair is the line a skier would take and
    // the extremity pair is not. So when the polygon is squat enough that no reading of it as a run
    // survives, take the termini from the gateways instead.
    const gwPair = corridor ? farthestGatewayPair() : null;
    if (gwPair) {
      [u, v] = gwPair;
      corridorUsed = true;
    }
    if (process.env.SKELDIAG && !(u >= 0 && v >= 0 && v !== u)) {
      console.log(`    synthfail samples=${gridCount} step=${Math.round(step)}m portals=${portalIdx.length} u=${u} v=${v}`);
    }
    if (process.env.SKELDIAG && u >= 0 && v >= 0 && v !== u) {
      // Does the portal pair actually reach the polygon's ends? Compare the geodesic span of the
      // chosen termini against the farthest interior sample from each of them.
      const du = dij(u, false).dist;
      const dv = dij(v, false).dist;
      let interior = 0;
      for (let i = 0; i < nx.length; i++) {
        if (isFinite(du[i])) interior = Math.max(interior, du[i]);
        if (isFinite(dv[i])) interior = Math.max(interior, dv[i]);
      }
      console.log(
        `    span w${tag} portalSpan=${Math.round(du[v])}m interiorMax=${Math.round(interior)}m portals=${portalIdx.length} gw=${gatewayIdx.size}`,
      );
    }
    if (u >= 0 && v >= 0 && v !== u) {
      const { dist: d, prev: pv } = dij(u, true);
      if (isFinite(d[v])) {
        const raw: XY[] = [];
        for (let n = v; n !== -1; n = pv[n]) raw.push({ x: nx[n], y: ny[n] });
        // The 8-neighbour lattice makes the path a staircase. Smooth it rather than string-pull it:
        // a string-pull only checks that a shortcut stays inside, so on a bend it happily drags the
        // spine onto the inner rim -- the exact thing this whole exercise exists to stop.
        // Clearance near the ends is ~0 by construction (portals sit ON the rim), so measure the
        // interior only or the number is meaningless.
        const midClear = (ps: XY[]): number => {
          const c: number[] = [];
          for (let i = 0; i < ps.length; i++) {
            const dEnd = Math.min(i, ps.length - 1 - i);
            if (dEnd < 3) continue;
            c.push(clearance(ps[i], rXY));
          }
          if (!c.length) return -1;
          c.sort((a, b) => a - b);
          return c[c.length >> 2];
        };
        const minClear = (ps: XY[]): number => ps.reduce((m, p) => Math.min(m, clearance(p, rXY)), Infinity);
        const clearBefore = minClear(raw);
        const midBefore = midClear(raw);
        smoothPath(raw);
        if (process.env.SKELDIAG) {
          // Is the spine centred *locally*? Comparing against the polygon's widest point is
          // meaningless on a ribbon that bulges once. For a sample of interior vertices, compare
          // the clearance the spine has with the best clearance available nearby. Record the local
          // turn angle too: cutting the inside of a bend is shorter, so if centring is traded away
          // anywhere it should be there.
          const stride = Math.max(1, Math.floor(raw.length / 40));
          for (let i = 3; i < raw.length - 3; i += stride) {
            const v = raw[i];
            const c = clearance(v, rXY);
            let best = c;
            for (let g = 0; g < gridCount; g++) {
              if (nclear[g] <= best) continue;
              if (Math.hypot(nx[g] - v.x, ny[g] - v.y) <= 25) best = nclear[g];
            }
            if (best <= 0) continue;
            const a = raw[i - 3];
            const b = raw[i + 3];
            const t1 = Math.atan2(v.y - a.y, v.x - a.x);
            const t2 = Math.atan2(b.y - v.y, b.x - v.x);
            let dt = Math.abs(t2 - t1);
            if (dt > Math.PI) dt = 2 * Math.PI - dt;
            CENTRED.push({ r: c / best, bend: (dt * 180) / Math.PI });
          }
          const ratios = CENTRED.slice(-40).map((x) => x.r).sort((a, b) => a - b);
          const med = ratios.length ? ratios[ratios.length >> 1] : -1;
          console.log(
            `    synthclear min ${clearBefore.toFixed(1)}->${minClear(raw).toFixed(1)}m  q1mid ${midBefore.toFixed(1)}->${midClear(raw).toFixed(1)}m  localCentred=${med.toFixed(2)} verts=${raw.length}`,
          );
        }
        if (raw.length >= 2) {
          synth = raw;
          for (let i = 0; i + 1 < raw.length; i++) {
            addTarget(raw[i]);
            const a = raw[i];
            const b = raw[i + 1];
            const n = Math.floor(Math.hypot(b.x - a.x, b.y - a.y) / (step / 2));
            for (let k = 1; k < n; k++) {
              const t = k / n;
              addTarget({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
            }
          }
          addTarget(raw[raw.length - 1]);
        }
      }
    }
  }

  // --- spine coverage pass ---
  // Adoption is all-or-nothing about *coverage*. A run that crosses most of a polygon clears
  // SPAN_MIN and is taken as the spine even when it stops well inside the ring, leaving a long
  // stretch with no centreline at all; every portal down there then fans hundreds of metres back up
  // to wherever the run happened to end. Measured on Tignes w94382148, a 1995 m ribbon: the adopted
  // pair of runs covers 12..1556 m and the last 439 m gets nothing.
  //
  // Lowering SPAN_MIN is the wrong lever -- it re-synthesises a whole second spine for polygons
  // whose adopted line is perfectly good. Grow the spine we already have instead: sweep from the
  // whole spine at once and the farthest interior sample IS the far end of the worst-served stretch,
  // with its parent chain already running back to the nearest part of the spine.
  //
  // Three things this has to get right, each learned from a case that broke a simpler version:
  //
  // 1. ITERATE. The first pass covers the worst stretch, but the point that is now farthest from the
  //    spine may lie beyond the piece just added -- a tail of the tail. One-shot left Val Thorens
  //    w142388478 still short at the top. Re-seeding from the grown spine each round fixes it, and
  //    the loop ends on its own when nothing is left far enough to qualify.
  //
  // 2. DO NOT GUARD ON THE POLYGON'S AXIS. The obvious guard -- only extend past the ends of the
  //    spine, projected on its long axis -- is blind to exactly the polygons that need this most. A
  //    twisting polygon folds back on itself, so an unserved lobe projects onto axis positions the
  //    spine already covers and reads as "covered". w142388478 measured 99% covered by axis while
  //    visibly missing its top lobe. Interior gaps BETWEEN adopted pieces (Tignes w220915727 had
  //    holes of 26 m, 63 m and 215 m) are invisible to an ends-only test for the same reason.
  //
  // 3. GUARD ON WIDTH, NOT ON THE TIP'S CLEARANCE. Distance alone would cut a spur sideways across
  //    a wide polygon, because on one of those the farthest point from a centred spine is simply
  //    half the width away, and the spine already serves that terrain perfectly well. The tail must
  //    therefore be long relative to the polygon's own half-width. (An earlier version compared the
  //    tip's distance-from-spine against its distance-from-rim; see TAIL_WIDTH_RATIO for why that
  //    could never reject anything.)
  const tails: XY[][] = [];
  if (targets.length) {
    // Mean width of the polygon: area over length. A tail must beat a multiple of HALF that, which
    // is how far a sideways spur from a centred spine would reach.
    let a2 = 0;
    for (let i = 1; i < rXY.length; i++) a2 += rXY[i - 1].x * rXY[i].y - rXY[i].x * rXY[i - 1].y;
    const halfWidthM = polyLenM > 0 ? Math.abs(a2) / 2 / polyLenM / 2 : 0;
    const need = Math.max(TAIL_MIN_M, TAIL_MIN_FRAC * polyLenM, TAIL_WIDTH_RATIO * halfWidthM);
    // 4. THE TIP MUST BE A PORTAL. The spine termini are restricted to portals for a reason spelled
    //    out at `farthest()`: a spine that ends where nothing carries on is a dead end mid-slope.
    //    Growing a tail into a portal-less pocket breaks that rule and invents terrain a skier can
    //    enter and not leave -- measured on Sölden, it created five trapped nodes, one of them the
    //    foot of a 139 m descent with no way out, plus a two-node island joined only to itself. A
    //    pocket with no portal has no exit even in principle, since phase 6 removes the rim, so the
    //    honest answer there is to leave it uncovered rather than to fabricate a trap.
    const portalSet = new Set(portalIdx);
    const tipAnywhere = process.env.SKEL_TAILANY === '1';
    for (let iter = 0; iter < TAIL_MAX_PASSES; iter++) {
      const plain = dij(targets, false).dist;
      let far = -1;
      let farD = 0;
      for (let i = 0; i < nx.length; i++) {
        const d = plain[i];
        if (!isFinite(d) || d < need || d <= farD) continue;
        if (!tipAnywhere && !portalSet.has(i)) continue;
        farD = d;
        far = i;
      }
      if (far < 0) break;
      const { dist: bd, prev: bp } = dij(targets, true);
      if (!isFinite(bd[far])) break;
      const raw: XY[] = [];
      for (let n = far; n !== -1; n = bp[n]) raw.push({ x: nx[n], y: ny[n] });
      // Same de-stair-stepping as the synthesised spine, and for the same reason.
      smoothPath(raw);
      if (raw.length < 2) break;
      tails.push(raw);
      if (process.env.SKELDIAG) {
        console.log(`    tail w${tag} #${iter + 1} +${Math.round(farD)}m (need ${Math.round(need)}m) verts=${raw.length}`);
      }
      // Fold the new piece into the spine so the next pass measures against it too. This is what
      // makes the loop terminate: every round the uncovered remainder gets strictly smaller.
      for (let i = 0; i + 1 < raw.length; i++) {
        addTarget(raw[i]);
        const a = raw[i];
        const b = raw[i + 1];
        const n = Math.floor(Math.hypot(b.x - a.x, b.y - a.y) / (step / 2));
        for (let k = 1; k < n; k++) {
          const t = k / n;
          addTarget({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
        }
      }
      addTarget(raw[raw.length - 1]);
    }
  }

  // No spine inside the ring (a B' polygon whose centreline runs outside it): fall back to
  // portal-to-portal, which is exactly what case B will do. Anchor on the first portal.
  const sources = targets.length ? targets : portalIdx.slice(0, 1);
  if (!sources.length) return null;

  // --- multi-source Dijkstra; every portal then walks its parent chain back to the spine ---
  const dist = new Array<number>(nx.length).fill(Infinity);
  const prev = new Array<number>(nx.length).fill(-1);
  const heap: [number, number][] = [];
  const push = (d: number, n: number): void => {
    heap.push([d, n]);
    let i = heap.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (heap[p][0] <= heap[i][0]) break;
      [heap[p], heap[i]] = [heap[i], heap[p]];
      i = p;
    }
  };
  const pop = (): [number, number] | undefined => {
    if (!heap.length) return undefined;
    const top = heap[0];
    const last = heap.pop()!;
    if (heap.length) {
      heap[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let s = i;
        if (l < heap.length && heap[l][0] < heap[s][0]) s = l;
        if (r < heap.length && heap[r][0] < heap[s][0]) s = r;
        if (s === i) break;
        [heap[s], heap[i]] = [heap[i], heap[s]];
        i = s;
      }
    }
    return top;
  };
  const relax = (): void => {
    heap.length = 0;
    for (const s of sources) {
      // Seed with the cost of the final hop onto the spine, not 0. A target grid node is only a
      // stand-in for its anchor point; charging 0 makes the search compare targets on grid cost
      // alone, so it can settle on a node that is cheap to reach but sits beyond the anchor -- the
      // arm then overshoots and comes back.
      const seed = anchorD.get(s) ?? 0;
      if (dist[s] !== seed) {
        dist[s] = seed;
        prev[s] = -1;
      }
      push(seed, s);
    }
    for (;;) {
      const top = pop();
      if (!top) break;
      const [d, n] = top;
      if (d > dist[n]) continue;
      for (const e of adj[n]) {
        const nd = d + e.w;
        if (nd < dist[e.to]) {
          dist[e.to] = nd;
          prev[e.to] = n;
          push(nd, e.to);
        }
      }
    }
  };
  relax();

  // Repair pass: a polygon with a neck narrower than the lattice can leave an interior island that
  // holds portals but no spine. Bridge each such portal to the nearest reachable node it can see.
  let repaired = 0;
  for (const pi of portalIdx) {
    if (isFinite(dist[pi])) continue;
    const q = { x: nx[pi], y: ny[pi] };
    const cand: { g: number; d: number }[] = [];
    for (let g = 0; g < nx.length; g++) {
      if (g === pi || !isFinite(dist[g])) continue;
      cand.push({ g, d: Math.hypot(nx[g] - q.x, ny[g] - q.y) });
    }
    cand.sort((a, b) => a.d - b.d);
    for (const { g } of cand.slice(0, 40)) {
      if (!visible(q, { x: nx[g], y: ny[g] })) continue;
      link(pi, g);
      repaired++;
      break;
    }
  }
  if (repaired) relax();

  // A polygon can genuinely split into interior lobes joined only outside itself. A lobe holding no
  // spine has no interior path to one, so it gets its own local hub (its most central sample) and
  // its portals fan out to that instead -- the same thing case B will do everywhere.
  const localHubs = new Set<number>();
  for (let guard = 0; guard < 24; guard++) {
    const orphan = portalIdx.find((pi) => !isFinite(dist[pi]));
    if (orphan == null) break;
    const comp: number[] = [];
    const stack = [orphan];
    const vis = new Set(stack);
    while (stack.length) {
      const n = stack.pop()!;
      comp.push(n);
      for (const e of adj[n]) {
        if (!vis.has(e.to) && !isFinite(dist[e.to])) {
          vis.add(e.to);
          stack.push(e.to);
        }
      }
    }
    let hub = comp[0];
    for (const n of comp) if (nclear[n] > nclear[hub]) hub = n;
    localHubs.add(hub);
    sources.push(hub);
    dist[hub] = 0;
    prev[hub] = -1;
    relax();
  }

  // --- draw ---
  const lines: OverlayLine[] = [];
  const points: OverlayPoint[] = [];
  const skel: SkelGeom = { synthSpines: [], spinePieces: [], stitches: [], wayBridges: [], arms: [] };
  lines.push({ coords: ring.map(([lon, lat]) => [lon, lat]), color: SKEL_COLORS.rim, width: 1 });
  // Clip each centreline to the ring properly. Filtering to inside *vertices* is wrong twice over:
  // OSM vertices can be 100 m+ apart, so a stretch that is genuinely inside gets dropped whenever
  // neither of its endpoints is (making the blue line look short and the arms look like they stop
  // before it), and a centreline that leaves and re-enters gets joined by a chord across the outside.
  const clipSrc: number[] = [];
  for (let segIdx = 0; segIdx < spine.length; segIdx++) {
    const seg = spine[segIdx];
    const segXY = seg.map((v) => toXY(v.lon, v.lat));
    // Boundary crossing between an inside and an outside sample, to ~0.5 m.
    const cross = (a: XY, b: XY, aIn: boolean): XY => {
      let lo = 0;
      let hi = 1;
      for (let it = 0; it < 24; it++) {
        const t = (lo + hi) / 2;
        const q = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
        if (inside(q, rXY) === aIn) lo = t;
        else hi = t;
      }
      return { x: a.x + (b.x - a.x) * lo, y: a.y + (b.y - a.y) * lo };
    };
    let run: XY[] = [];
    const flush = (): void => {
      if (run.length >= 2) {
        lines.push({ coords: run.map(toLL), color: SKEL_COLORS.spine, width: 4 });
        skel.spinePieces.push(run.map(toLL));
        clipSrc.push(segIdx);
      }
      run = [];
    };
    let prevQ: XY | null = null;
    let prevIn = false;
    for (let i = 0; i + 1 < segXY.length; i++) {
      const a = segXY[i];
      const b = segXY[i + 1];
      const n = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / Math.min(step / 2, 5)));
      for (let k = 0; k <= n; k++) {
        if (i > 0 && k === 0) continue;
        const t = k / n;
        const q = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
        const qIn = inside(q, rXY);
        if (prevQ && qIn !== prevIn) {
          const edge = cross(prevQ, q, prevIn);
          if (prevIn) {
            run.push(edge);
            flush();
          } else {
            run = [edge];
          }
        }
        if (qIn) run.push(q);
        prevQ = q;
        prevIn = qIn;
      }
    }
    flush();
  }
  // Synthesised spine (case B). Drawn in a lighter blue so it is obvious which polygons have a real
  // OSM centreline and which are carrying an invented one.
  if (synth) {
    lines.push({ coords: synth.map(toLL), color: SKEL_COLORS.spineSynth, width: 4 });
    skel.synthSpines.push(synth.map(toLL));
    skel.spinePieces.push(synth.map(toLL));
  }
  // Tail extensions are synthesised too, so they carry the same lighter blue.
  for (const t of tails) {
    lines.push({ coords: t.map(toLL), color: SKEL_COLORS.spineSynth, width: 4 });
    skel.synthSpines.push(t.map(toLL));
    skel.spinePieces.push(t.map(toLL));
  }
  // --- stitch disconnected spine pieces ---
  // A polygon can end up with more than one spine piece: a real OSM centreline that only crosses part
  // of the ring, plus a synthesised spine covering the rest. Each piece is independently wired into
  // the wider graph, so phase 6 strands nothing, but a skier cannot cross the polygon *between* the
  // pieces -- the router has to leave the area and come back. Join pieces whose closest approach is
  // short enough that a straight link is obviously skiable and provably inside the ring. Genuinely
  // separate lobes (tens to hundreds of metres apart) are left alone: a long invented link there
  // would be exactly the kind of fictional terrain this whole exercise exists to avoid.
  let stitches = 0;
  let splitComps = 0;
  {
    const pieces: XY[][] = [];
    // Which OSM centreline each drawn piece came from (-1 = the synthesised spine). Two runs of the
    // same centreline are one continuous piste in the graph -- the clip only broke them apart for
    // drawing where the line grazes outside the ring -- so they must never be treated as separate
    // components, and a chord between them would run outside the polygon anyway.
    const src: number[] = [];
    let clipN = 0;
    for (const l of lines) {
      if (l.color !== SKEL_COLORS.spine && l.color !== SKEL_COLORS.spineSynth) continue;
      pieces.push(l.coords.map(([lo, la]) => toXY(lo, la)));
      src.push(l.color === SKEL_COLORS.spine ? clipSrc[clipN++] : -1);
    }
    // Closest approach between two polylines, plus the two points that realise it.
    const approach = (A: XY[], B: XY[]): { d: number; a: XY; b: XY } => {
      let best = { d: Infinity, a: A[0], b: B[0] };
      const scan = (pts: XY[], seg: XY[], flip: boolean): void => {
        for (const p of pts) {
          for (let i = 1; i < seg.length; i++) {
            const s = seg[i - 1];
            const e = seg[i];
            const vx = e.x - s.x;
            const vy = e.y - s.y;
            const L = vx * vx + vy * vy;
            const t = L > 0 ? Math.max(0, Math.min(1, ((p.x - s.x) * vx + (p.y - s.y) * vy) / L)) : 0;
            const q = { x: s.x + vx * t, y: s.y + vy * t };
            const d = Math.hypot(q.x - p.x, q.y - p.y);
            if (d < best.d) best = { d, a: flip ? q : p, b: flip ? p : q };
          }
        }
      };
      scan(A, B, false);
      scan(B, A, true);
      return best;
    };
    const par = pieces.map((_, i) => i);
    const find = (x: number): number => {
      while (par[x] !== x) x = par[x] = par[par[x]];
      return x;
    };
    const cand: { d: number; a: XY; b: XY; i: number; j: number; route: boolean }[] = [];
    for (let i = 0; i < pieces.length; i++) {
      for (let j = i + 1; j < pieces.length; j++) {
        if (pieces[i].length < 2 || pieces[j].length < 2) continue;
        if (src[i] >= 0 && src[i] === src[j]) {
          const r = approach(pieces[i], pieces[j]);
          // Measurement only -- not pushed to `lines` and not a stitch, so nothing is drawn or built.
          if (r.d > SPINE_TOUCH_M) skel.wayBridges.push([toLL(r.a), toLL(r.b)]);
          if (process.env.SKELDIAG) {
            const mid = toLL({ x: (r.a.x + r.b.x) / 2, y: (r.a.y + r.b.y) / 2 });
            console.log(
              `    stitch w${tag} ${i}-${j} SAME SOURCE WAY ${src[i]} (${Math.round(r.d)}m apart, no link needed) at ${mid[0].toFixed(5)},${mid[1].toFixed(5)}`,
            );
          }
          par[find(i)] = find(j);
          continue;
        }
        const r = approach(pieces[i], pieces[j]);
        // Already touching (the clip splits one centreline into runs): same component, no link.
        if (r.d <= SPINE_TOUCH_M) par[find(i)] = find(j);
        else if (r.d <= STITCH_MAX_M) cand.push({ ...r, i, j, route: false });
        else if (r.d <= STITCH_ROUTE_MAX_M) cand.push({ ...r, i, j, route: true });
        else if (process.env.SKELDIAG)
          console.log(`    stitch w${tag} ${i}-${j} TOO FAR ${Math.round(r.d)}m (max ${STITCH_ROUTE_MAX_M}m)`);
      }
    }
    // Shortest link first, and only ever between pieces that are still separate: this is a minimum
    // spanning forest, so N pieces get at most N-1 links rather than every pair being joined.
    cand.sort((x, y) => x.d - y.d);
    for (const c of cand) {
      const a = find(c.i);
      const b = find(c.j);
      if (a === b) continue;
      let link: XY[] | null = null;
      if (!c.route) {
        if (!visible(c.a, c.b)) continue;
        link = [c.a, c.b];
      } else {
        // Longer gap: only accept it if the polygon's own interior agrees the two pieces are
        // neighbours. A hole in a ribbon routes almost straight; a lobe boundary routes the long way
        // round and is rejected by the detour ratio.
        const s = nearestNode(c.a);
        const t = nearestNode(c.b);
        if (s < 0 || t < 0) {
          if (process.env.SKELDIAG)
            console.log(`    stitch w${tag} ${c.i}-${c.j} ${Math.round(c.d)}m NO LATTICE NODE (s=${s} t=${t})`);
          continue;
        }
        const { dist: rd, prev: rp } = dij(s, false);
        if (!isFinite(rd[t]) || rd[t] > STITCH_DETOUR_MAX * c.d) {
          if (process.env.SKELDIAG)
            console.log(
              `    stitch w${tag} ${c.i}-${c.j} ${Math.round(c.d)}m DETOUR route=${isFinite(rd[t]) ? Math.round(rd[t]) + 'm' : 'unreachable'} ratio=${isFinite(rd[t]) ? (rd[t] / c.d).toFixed(2) : 'inf'} (max ${STITCH_DETOUR_MAX})`,
            );
          continue;
        }
        const path: XY[] = [];
        for (let n = t; n !== -1; n = rp[n]) path.push({ x: nx[n], y: ny[n] });
        if (path.length < 2) continue;
        // The routed link is a raw grid path, so it stair-steps exactly like a synthesised spine
        // does; smooth it the same way or the stitch is drawn as a visible zig-zag.
        link = smoothPath(path);
        // The path runs between LATTICE nodes, which sit up to a cell away from the actual piece
        // endpoints, so anchor both ends onto the pieces themselves rather than leaving a stub gap.
        // path[0] is at `t` (the c.b end) and the last vertex is at `s` (the c.a end). The lattice
        // node can overshoot the true endpoint, so drop any trailing vertex that is not making
        // progress towards the anchor first -- otherwise the link visibly doubles back on itself.
        const anchor = (q: XY, atFront: boolean): void => {
          const at = () => (atFront ? link![0] : link![link!.length - 1]);
          const nextIn = () => (atFront ? link![1] : link![link!.length - 2]);
          const dropOne = () => (atFront ? link!.shift() : link!.pop());
          const d2 = (a: XY, b: XY) => (a.x - b.x) ** 2 + (a.y - b.y) ** 2;
          while (link!.length >= 2 && d2(nextIn(), q) <= d2(nextIn(), at())) dropOne();
          if (segInside(q, at())) {
            if (atFront) link!.unshift(q);
            else link!.push(q);
          }
        };
        anchor(c.b, true);
        anchor(c.a, false);
      }
      par[a] = b;
      lines.push({ coords: link.map(toLL), color: SKEL_COLORS.stitch, width: 4 });
      skel.stitches.push(link.map(toLL));
      stitches++;
    }
    const roots = new Set<number>();
    for (let i = 0; i < pieces.length; i++) if (pieces[i].length >= 2) roots.add(find(i));
    splitComps = Math.max(0, roots.size - 1);
  }
  let routed = 0;
  let stranded = 0;
  let armM = 0;
  let maxGap = 0;
  let gapped = 0;
  let forked = 0;
  let unforked = 0;
  // Distance from an arm's terminal point to the nearest point ON the spine. Measure against the
  // UNCLIPPED centreline, not the drawn one: the drawn line is sampled at <=5 m, so a stretch that
  // only grazes the inside of the ring for a metre or two is never emitted, and an arm landing
  // exactly on it looked like a 73 m hole. Phase 6 attaches to the real piste geometry, which is
  // there whether or not the clip drew it.
  const spineXY = lines
    .filter((l) => l.color === SKEL_COLORS.spineSynth || l.color === SKEL_COLORS.stitch)
    .map((l) => l.coords.map(([lo, la]) => toXY(lo, la)))
    .concat(spine.map((seg) => seg.map((v) => toXY(v.lon, v.lat))));
  const nearestOnSpine = (p: XY): { at: XY; d: number; li: number; si: number; t: number } => {
    let best = Infinity;
    let at: XY = p;
    let li = -1;
    let si = -1;
    let bt = 0;
    for (let l = 0; l < spineXY.length; l++) {
      const s = spineXY[l];
      for (let i = 1; i < s.length; i++) {
        const a = s[i - 1];
        const b = s[i];
        const vx = b.x - a.x;
        const vy = b.y - a.y;
        const L = vx * vx + vy * vy;
        const t = L > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * vx + (p.y - a.y) * vy) / L)) : 0;
        const fx = a.x + vx * t;
        const fy = a.y + vy * t;
        const d = Math.hypot(fx - p.x, fy - p.y);
        if (d < best) {
          best = d;
          at = { x: fx, y: fy };
          li = l;
          si = i;
          bt = t;
        }
      }
    }
    return { at, d: isFinite(best) ? best : 0, li, si, t: bt };
  };
  const gapToSpine = (p: XY): number => nearestOnSpine(p).d;
  /**
   * Walk `d` metres along the spine polyline from a point located by `nearestOnSpine`, forwards for
   * a positive `d` and backwards for a negative one. Clamped to the spine's ends: a spine shorter
   * than the requested distance still yields a usable point, and the caller rejects the pair if the
   * two ends up too close together to be distinct.
   */
  const walkSpine = (loc: { li: number; si: number; t: number }, d: number): XY | null => {
    const s = spineXY[loc.li];
    if (!s || loc.si < 1) return null;
    const a = s[loc.si - 1];
    const b = s[loc.si];
    let cur: XY = { x: a.x + (b.x - a.x) * loc.t, y: a.y + (b.y - a.y) * loc.t };
    let rem = Math.abs(d);
    const step = d >= 0 ? 1 : -1;
    for (let i = d >= 0 ? loc.si : loc.si - 1; i >= 0 && i < s.length; i += step) {
      const nxt = s[i];
      const segd = Math.hypot(nxt.x - cur.x, nxt.y - cur.y);
      if (segd >= rem) {
        const f = segd > 0 ? rem / segd : 0;
        return { x: cur.x + (nxt.x - cur.x) * f, y: cur.y + (nxt.y - cur.y) * f };
      }
      rem -= segd;
      cur = nxt;
    }
    return cur;
  };
  for (let k = 0; k < portalIdx.length; k++) {
    const pi = portalIdx[k];
    const p = portalPts[k];
    if (!isFinite(dist[pi])) {
      stranded++;
      if (process.env.SKELDIAG) {
        const q = { x: nx[pi], y: ny[pi] };
        let bd = Infinity;
        let bg = -1;
        for (let g = 0; g < gridCount; g++) {
          const d = Math.hypot(nx[g] - q.x, ny[g] - q.y);
          if (d < bd) {
            bd = d;
            bg = g;
          }
        }
        const n = 20;
        let ins = 0;
        for (let i = 1; i < n; i++) {
          const t = i / n;
          if (inside({ x: q.x + (nx[bg] - q.x) * t, y: q.y + (ny[bg] - q.y) * t }, rXY)) ins++;
        }
        console.log(
          `    diag ${p.id} samples=${gridCount} step=${Math.round(step)}m nearest=${Math.round(bd)}m visFrac=${(ins / (n - 1)).toFixed(2)} portalInside=${inside(q, rXY)}`,
        );
      }
      points.push({ at: [p.lon, p.lat], color: SKEL_COLORS.stranded, r: 13, label: `stranded portal ${p.id}` });
      continue;
    }
    const raw: XY[] = [];
    let last = pi;
    for (let n = pi; n !== -1; n = prev[n]) {
      raw.push({ x: nx[n], y: ny[n] });
      last = n;
    }
    const a = anchor.get(last);
    if (a) raw.push(a);
    // String-pull: the 8-neighbour lattice can only turn in 45 degree steps, which is what makes the
    // arms look "twisted". Collapse any run of vertices whose endpoints can see each other through
    // the polygon -- the result is straighter and still provably inside.
    const chain: XY[] = [raw[0]];
    for (let i = 0; i < raw.length - 1; ) {
      let j = raw.length - 1;
      for (; j > i + 1; j--) if (visible(raw[i], raw[j])) break;
      chain.push(raw[j]);
      i = j;
    }
    // The search was anchored at this portal's foot on the ring; put the portal itself back so the
    // arm visibly reaches the dot. The stub is the crossing of the sliver between the two rims.
    const tp = portalTrue.get(pi);
    if (tp && Math.hypot(tp.x - chain[0].x, tp.y - chain[0].y) > 0.01) {
      // A portal seated well away from its own rim (a spike too thin for any offset seat) would
      // otherwise be joined to the interior by a straight stub that cuts across open ground outside
      // the polygon. Route the stub through the rim foot so the arm enters where the portal
      // actually touches the boundary.
      const ft = portalFoot.get(pi);
      if (ft && Math.hypot(tp.x - chain[0].x, tp.y - chain[0].y) > 2 && Math.hypot(ft.x - chain[0].x, ft.y - chain[0].y) > 0.01 && Math.hypot(ft.x - tp.x, ft.y - tp.y) > 0.01)
        chain.unshift(ft);
      chain.unshift(tp);
    }
    // An arm ends at a lattice target, but the lattice has no node where the polygon narrows, so an
    // arm can run tens of metres back along a spine it is already sitting on -- 1795 arms were
    // wholly redundant fleet-wide. Cut the arm where it FIRST reaches the spine: the
    // remainder was never a connection, only a second copy of the centreline. Phase 6 must split the
    // spine at the cut point so the arm still attaches to a real vertex.
    let clipped = false;
    let footLoc: { li: number; si: number; t: number } | null = null;
    if (spineXY.length) {
      let cut = -1;
      let foot: XY | null = null;
      search: for (let i = 0; i + 1 < chain.length; i++) {
        const A = chain[i];
        const B = chain[i + 1];
        const segL = Math.hypot(B.x - A.x, B.y - A.y);
        const n = Math.min(60, Math.max(1, Math.ceil(segL)));
        for (let s = 0; s <= n; s++) {
          const t = s / n;
          const q = { x: A.x + (B.x - A.x) * t, y: A.y + (B.y - A.y) * t };
          const near = nearestOnSpine(q);
          if (near.d <= ARM_CLIP_M) {
            cut = i;
            foot = near.at;
            footLoc = { li: near.li, si: near.si, t: near.t };
            break search;
          }
        }
      }
      if (cut >= 0 && foot) {
        chain.length = cut + 1;
        chain.push(foot);
        clipped = true;
        let L = 0;
        for (let i = 1; i < chain.length; i++) L += Math.hypot(chain[i].x - chain[i - 1].x, chain[i].y - chain[i - 1].y);
        // A portal that already sits on the spine needs no arm at all. That is a correct result, not
        // a missing one, so it must not be counted with the genuinely unattached portals.
        if (L < 0.5) chain.length = 1;
      }
    }
    // A gateway's arm is forked to two points either side of its foot so the crossing works in both
    // directions whatever the terrain does (see FORK_M). The forks diverge from the last interior
    // vertex rather than from the foot itself, so neither one merely retraces the spine.
    let forks: XY[][] | null = null;
    if (!process.env.SKEL_NOFORK && p.gateway && clipped && footLoc && chain.length >= 2) {
      const base = Math.max(0, chain.length - 2);
      const pair: XY[][] = [];
      const ends: XY[] = [];
      for (const sign of [1, -1]) {
        // Longest first: a distant fork straddles the gateway in height on steep ground, and only
        // where the polygon cannot see that far do we settle for a nearer one.
        for (const dist of FORK_FALLBACK_M) {
          const q = walkSpine(footLoc, sign * dist);
          if (!q) continue;
          let i = base;
          for (; i >= 0; i--) if (visible(chain[i], q)) break;
          if (i < 0) continue;
          pair.push([...chain.slice(0, i + 1), q]);
          ends.push(q);
          break;
        }
      }
      if (pair.length === 2 && Math.hypot(ends[0].x - ends[1].x, ends[0].y - ends[1].y) >= FORK_MIN_SEP_M) {
        forks = pair;
        forked++;
      } else unforked++;
    }
    const emitted: XY[][] = forks ?? (chain.length >= 2 || clipped ? [chain] : []);
    for (const em of emitted) {
      for (let i = 1; i < em.length; i++) {
        armM += Math.hypot(em[i].x - em[i - 1].x, em[i].y - em[i - 1].y);
      }
      if (targets.length && !localHubs.has(last)) {
        const g = gapToSpine(em[em.length - 1]);
        if (g > maxGap) maxGap = g;
        if (g > 1) {
          gapped++;
          if (process.env.SKELDIAG) {
            const [glo, gla] = toLL(em[em.length - 1]);
            const end = em[em.length - 1];
            let raww = Infinity;
            for (const seg of spine)
              for (let i = 1; i < seg.length; i++) {
                const a = toXY(seg[i - 1].lon, seg[i - 1].lat);
                const b = toXY(seg[i].lon, seg[i].lat);
                const vx = b.x - a.x;
                const vy = b.y - a.y;
                const L = vx * vx + vy * vy;
                const t = L > 0 ? Math.max(0, Math.min(1, ((end.x - a.x) * vx + (end.y - a.y) * vy) / L)) : 0;
                raww = Math.min(raww, Math.hypot(a.x + vx * t - end.x, a.y + vy * t - end.y));
              }
            console.log(
              `    gap ${p.id} drawn=${g.toFixed(1)}m unclipped=${isFinite(raww) ? raww.toFixed(1) : 'inf'}m end=${glo.toFixed(5)},${gla.toFixed(5)} anchored=${!!a}`,
            );
          }
        }
      }
      if (em.length >= 2)
        lines.push({
          coords: em.map(toLL),
          color: !targets.length ? SKEL_COLORS.armNoTarget : localHubs.has(last) ? SKEL_COLORS.armHub : SKEL_COLORS.arm,
          width: 3,
        });
      // A one-point "arm" means the portal already sits on the spine. It still has to be reported, or
      // the caller has nothing to weld into the spine and deleting the rim would leave the portal
      // touching nothing at all. Only a genuinely unreachable portal is omitted.
      if (em.length >= 2 || clipped) skel.arms.push({ portalId: p.id, gateway: !!p.gateway, coords: em.map(toLL) });
    }
    if (process.env.PORTDIAG && chain.length >= 2) {
      // Re-seating a portal can only ever be as good as the stub that reaches it, so measure how
      // much of the emitted arm actually lies outside its own polygon.
      let outM = 0;
      for (let i = 1; i < chain.length; i++) {
        const seg = Math.hypot(chain[i].x - chain[i - 1].x, chain[i].y - chain[i - 1].y);
        const n = Math.max(1, Math.min(200, Math.ceil(seg)));
        let bad = 0;
        for (let k = 0; k < n; k++) {
          const t = (k + 0.5) / n;
          if (!inside({ x: chain[i - 1].x + (chain[i].x - chain[i - 1].x) * t, y: chain[i - 1].y + (chain[i].y - chain[i - 1].y) * t }, rXY)) bad++;
        }
        outM += (seg * bad) / n;
      }
      let chainM = 0;
      for (let i = 1; i < chain.length; i++) chainM += Math.hypot(chain[i].x - chain[i - 1].x, chain[i].y - chain[i - 1].y);
      if (outM > 0.5) console.log(`    armout ${p.id} w${tag} outside=${outM.toFixed(1)}m of ${chainM.toFixed(1)}m`);
    }
    if (chain.length < 2 && process.env.PORTDIAG && !clipped)
      console.log(`    armless ${p.gateway ? 'gateway' : 'portal'} ${p.id} w${tag} outsideBy=${distToRing({ x: nx[pi], y: ny[pi] }).toFixed(2)}m inside=${inside({ x: nx[pi], y: ny[pi] }, rXY)} ${seatDiag.get(pi) ?? 'seated'}`);
    points.push({
      at: [p.lon, p.lat],
      color: p.gateway ? SKEL_COLORS.gateway : SKEL_COLORS.portal,
      r: 11,
      label: p.gateway ? `gateway ${p.id}` : `portal ${p.id}`,
    });
    routed++;
  }

  if (process.env.SKELDIAG && (forked || unforked))
    console.log(`    fork gateways forked=${forked} unforked=${unforked}`);

  return {
    portals: portalPts.length,
    routed,
    stranded,
    armM,
    maxGap,
    gapped,
    noSpine: !targets.length,
    spanFrac,
    polyLenM,
    synth: !!synth || tails.length > 0,
    corridor: corridorUsed,
    gateways: portalPts.filter((p) => p.gateway).length,
    stitches,
    splitComps,
    lines,
    points,
    skel,
  };
}


/**
 * Smallest length:width ratio a polygon may have and still be collapsed to a centreline.
 *
 * Dormant guard (plan Â§5): not one polygon in 1 004 measures below 3 â€” the squattest is 3.7:1 â€”
 * so nothing in today's data is excluded. It exists so a future resort with genuinely open bowl
 * terrain is left with its perimeter rather than silently reduced to a line.
 */
export const BOWL_RATIO = 3;

/**
 * Ribbon length and aspect ratio. Width is the
 * equivalent-rectangle width `2A/P`, and length is derived as `A/width` rather than measured along
 * the ring, so a hairpin corridor does not read as "short and fat" just because its ends double
 * back. Any deviation here silently reclassifies polygons â€” an earlier `2A/(P/2)` halved every
 * ratio and dropped 60 of 1 004 polygons that the classifier had passed.
 */
function ringMetrics(ring: { lon: number; lat: number }[]): { lenM: number; ratio: number } {
  const k = Math.cos((ring[0].lat * Math.PI) / 180);
  const X = ring.map((p) => p.lon * k * 111320);
  const Y = ring.map((p) => p.lat * 110540);
  let perimM = 0;
  let cross = 0;
  for (let i = 1; i < ring.length; i++) {
    perimM += Math.hypot(X[i] - X[i - 1], Y[i] - Y[i - 1]);
    cross += X[i - 1] * Y[i] - X[i] * Y[i - 1];
  }
  const areaM2 = Math.abs(cross) / 2;
  const width = perimM > 0 ? (2 * areaM2) / perimM : 0;
  const lenM = width > 0 ? areaM2 / width : 0;
  return { lenM, ratio: width > 0 ? lenM / width : Infinity };
}

export interface SkeletonOpts {
  /** Restrict to these polygon way ids. Omit to take every eligible polygon. */
  want?: Set<number>;
}

/** A spine's descent measured against its polygon's, plus how far off the fall line it points. */
export interface FallCheck {
  /** Spine drop over polygon drop. Near 0 means the spine does not descend the polygon at all. */
  dropRatio: number;
  spineDropM: number;
  polyDropM: number;
  /**
   * Angle between the spine's end-to-end vector and the polygon's fall line. Reported for context
   * only, never to judge: a cat-track ribbon or a flat shelf legitimately runs across the slope, so
   * angle alone condemns correct spines. The drop is the honest signal.
   */
  angleDeg: number;
}

/**
 * Does this spine actually descend its polygon?
 *
 * The polygon's own fall line is its highest ring point to its lowest; the spine's is its own
 * highest point to its own lowest. A spine worth having covers most of the polygon's drop.
 */
function fallLineCheck(
  ring: { lon: number; lat: number }[],
  pieces: [number, number][][],
  eleAt: (lon: number, lat: number) => number | null,
): FallCheck {
  const none: FallCheck = { dropRatio: 0, spineDropM: 0, polyDropM: 0, angleDeg: 0 };
  if (!ring.length) return none;
  let hi: { lon: number; lat: number; ele: number } | null = null;
  let lo: { lon: number; lat: number; ele: number } | null = null;
  for (const q of ring) {
    const e = eleAt(q.lon, q.lat);
    if (e == null) continue;
    if (!hi || e > hi.ele) hi = { lon: q.lon, lat: q.lat, ele: e };
    if (!lo || e < lo.ele) lo = { lon: q.lon, lat: q.lat, ele: e };
  }
  if (!hi || !lo) return none;
  const polyDropM = hi.ele - lo.ele;
  let sHi: [number, number] | null = null;
  let sLo: [number, number] | null = null;
  let sHiE = -Infinity;
  let sLoE = Infinity;
  for (const piece of pieces)
    for (const [lon, lat] of piece) {
      const e = eleAt(lon, lat);
      if (e == null) continue;
      if (e > sHiE) {
        sHiE = e;
        sHi = [lon, lat];
      }
      if (e < sLoE) {
        sLoE = e;
        sLo = [lon, lat];
      }
    }
  if (!sHi || !sLo) return { ...none, polyDropM };
  const spineDropM = sHiE - sLoE;
  const k = Math.cos((hi.lat * Math.PI) / 180);
  const fx = (lo.lon - hi.lon) * k;
  const fy = lo.lat - hi.lat;
  const sx = (sLo[0] - sHi[0]) * k;
  const sy = sLo[1] - sHi[1];
  const fl = Math.hypot(fx, fy);
  const sl = Math.hypot(sx, sy);
  const angleDeg =
    fl > 0 && sl > 0 ? (Math.acos(Math.max(-1, Math.min(1, (fx * sx + fy * sy) / (fl * sl)))) * 180) / Math.PI : 0;
  return { dropRatio: polyDropM > 0 ? spineDropM / polyDropM : 0, spineDropM, polyDropM, angleDeg };
}

/**
 * Synthesise a skeleton for every eligible `area=yes` polygon in a built graph.
 *
 * Takes an already-built `ResortGraph` because portals are defined by what a ring node touches
 * *outside* its own polygon, and the spine (classes A/Bâ€²) is an existing OSM centreline â€” both are
 * properties of the assembled graph, not of the raw ways. `build.ts` therefore builds once to
 * discover them, then rebuilds with the skeletons swapped in.
 */
export function buildSkeletons(graph: ResortGraph, pistes: NormPiste[], opts: SkeletonOpts = {}): PolyResult[] {
  // Elevation anywhere inside a polygon, by nearest graph node. A spine vertex is synthesised
  // geometry and carries no elevation of its own, but every polygon is ringed by nodes that do and
  // a spine point lies inside that ring, so the nearest one is a fair sample â€” and it is the
  // *shipped* elevation, so this judges the spine against the numbers the router will actually use.
  const eleNodes = graph.nodes
    .filter((n) => n.point.ele != null)
    .map((n) => ({ lon: n.point.lon, lat: n.point.lat, ele: n.point.ele as number }));
  const eleAt = (lon: number, lat: number): number | null => {
    const k = Math.cos((lat * Math.PI) / 180);
    let best: number | null = null;
    let bd = Infinity;
    for (const p of eleNodes) {
      const d = Math.hypot((p.lon - lon) * k, p.lat - lat);
      if (d < bd) {
        bd = d;
        best = p.ele;
      }
    }
    return best;
  };
  const byWay = new Map<number, GraphEdge[]>();
  for (const e of graph.edges) {
    if (!e.area || e.srcWayId == null) continue;
    if (!byWay.has(e.srcWayId)) byWay.set(e.srcWayId, []);
    byWay.get(e.srcWayId)!.push(e);
  }
  // Candidate centrelines, chosen by GEOMETRY. This used to be keyed on the polygon's own
  // `ref`/`name` via `runKeys(edges[0])`, which failed in two ways that between them accounted for
  // every polygon the fall-line check flagged:
  //   - 76% of area polygons carry no name at all, so the lookup returned NOTHING and the spine was
  //     synthesised from portals alone -- even where a single run covered 96% of the polygon
  //     (Sella Ronda w1249541237 / "9 Diego", Val Thorens w1044470307 / "Bouchet").
  //   - a named polygon matched ONE name, but a run is routinely split across several named ways:
  //     Sella Ronda w1337115698 is covered end to end by "6 Pian Frataces" then "1 Sass BecÃ¨", and
  //     Val Thorens w46717811 by "Lac Blanc" then "Boulevard Lauzes". One name can never span it.
  // A line that lies inside the ring IS this polygon's centreline regardless of what it is called,
  // so ask the geometry. Name matching is not kept as a fallback: it adds nothing a geometric test
  // misses, and keeping it would reintroduce the single-name truncation above.
  const lineEdges: { e: GraphEdge; x0: number; y0: number; x1: number; y1: number }[] = [];
  for (const e of graph.edges) {
    if (e.area || e.kind !== 'piste' || !e.geometry || e.geometry.length < 2) continue;
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const g of e.geometry) {
      x0 = Math.min(x0, g.lon);
      x1 = Math.max(x1, g.lon);
      y0 = Math.min(y0, g.lat);
      y1 = Math.max(y1, g.lat);
    }
    lineEdges.push({ e, x0, y0, x1, y1 });
  }
  const touch = new Map<string, number>();
  for (const e of graph.edges) {
    touch.set(e.from, (touch.get(e.from) ?? 0) + 1);
    touch.set(e.to, (touch.get(e.to) ?? 0) + 1);
  }
  const nodeById = new Map(graph.nodes.map((n) => [n.id, n]));

  // Mid-boundary gateways. Two neighbouring polygons only share the graph nodes OSM happens to have
  // in common on their joint boundary - usually just its two ends - so once the rim edges go, the
  // only crossing left is at a corner and a route down the middle of one polygon has to detour to
  // the corner and back. A gateway is an extra portal at the midpoint of the shared boundary,
  // registered for both polygons, so the fan-out grows an arm to it from each spine and the
  // crossing happens mid-boundary. Corner portals stay: an inside-corner line is sometimes the
  // better one, e.g. when middle-to-middle would turn a descent into a flat traverse.
  const pos = new Map(graph.nodes.map((n) => [n.id, { lon: n.point.lon, lat: n.point.lat }]));
  const gatewaysByWay = new Map<number, { id: string; lon: number; lat: number; gateway: true }[]>();
  const chains = sharedRimChains(byWay, pos);
  // Where two polygons meet at a single node instead of along a rim, that node already belongs to
  // both and is the crossing; it just needs to be recognised as one rather than synthesised.
  const pinch = pinchNodes(byWay, chains, pos);
  // A chain follows ONE of the two polygons' rims (whichever edge carried the geometry) and has its
  // ends pinned to node positions, so its midpoint can sit metres off the *other* polygon's rim --
  // measurably, 602 of 3109 gateway instances were more than 0.5 m off their own rim, worst 23.7 m.
  // A gateway that is not on the shared boundary is not a crossing point: the polygon it falls
  // outside of cannot grow an arm to it, so the crossing silently does not exist. Re-seat it on the
  // boundary by projecting onto BOTH rims and taking the midpoint of the two feet, which is the one
  // position that treats the two polygons symmetrically.
  const ringByWay = new Map<number, { lon: number; lat: number }[]>();
  for (const p of pistes) if (p.area && p.points.length >= 3) ringByWay.set(p.wayId, p.points);
  const footOnRing = (q: { lon: number; lat: number }, ring: { lon: number; lat: number }[]): { lon: number; lat: number } | null => {
    const k = Math.cos((q.lat * Math.PI) / 180);
    let best: { lon: number; lat: number } | null = null;
    let bd = Infinity;
    for (let i = 1; i < ring.length; i++) {
      const a = ring[i - 1];
      const b = ring[i];
      const ax = a.lon * k;
      const ay = a.lat;
      const vx = b.lon * k - ax;
      const vy = b.lat - ay;
      const L = vx * vx + vy * vy;
      const t = L > 0 ? Math.max(0, Math.min(1, ((q.lon * k - ax) * vx + (q.lat - ay) * vy) / L)) : 0;
      const px = ax + vx * t;
      const py = ay + vy * t;
      const d = Math.hypot(px - q.lon * k, py - q.lat);
      if (d < bd) {
        bd = d;
        best = { lon: px / k, lat: py };
      }
    }
    return best;
  };
  for (let i = 0; i < chains.length; i++) {
    const c = chains[i];
    if (c.lengthM < MIN_GATEWAY_M) continue;
    let { lon, lat } = c.mid;
    const fa = ringByWay.has(c.wayA) ? footOnRing(c.mid, ringByWay.get(c.wayA)!) : null;
    const fb = ringByWay.has(c.wayB) ? footOnRing(c.mid, ringByWay.get(c.wayB)!) : null;
    if (fa && fb) {
      lon = (fa.lon + fb.lon) / 2;
      lat = (fa.lat + fb.lat) / 2;
    } else if (fa || fb) {
      const f = (fa ?? fb)!;
      lon = f.lon;
      lat = f.lat;
    }
    const g = { id: `gw${c.wayA}-${c.wayB}-${i}`, lon, lat, gateway: true as const };
    for (const w of [c.wayA, c.wayB]) {
      if (!gatewaysByWay.has(w)) gatewaysByWay.set(w, []);
      gatewaysByWay.get(w)!.push(g);
    }
  }

  const out: PolyResult[] = [];
  for (const p of pistes) {
    if (!p.area || p.points.length < 3) continue;
    if (opts.want && !opts.want.has(p.wayId)) continue;
    const edges = byWay.get(p.wayId) ?? [];
    // Class D: the ring shares no node with any other way, so `segmentWay` dropped it as a
    // self-loop and the router has never entered it. Nothing to replace.
    if (!edges.length) continue;
    if (ringMetrics(p.points).ratio < BOWL_RATIO) continue;

    const own = new Map<string, number>();
    for (const e of edges) {
      own.set(e.from, (own.get(e.from) ?? 0) + 1);
      own.set(e.to, (own.get(e.to) ?? 0) + 1);
    }
    const portalPts: { id: string; lon: number; lat: number; gateway?: boolean }[] = [];
    for (const [id, c] of own) {
      if ((touch.get(id) ?? 0) <= c) continue;
      const n = nodeById.get(id);
      if (n) portalPts.push({ id, lon: n.point.lon, lat: n.point.lat, gateway: pinch.get(p.wayId)?.has(id) || undefined });
    }
    portalPts.push(...(gatewaysByWay.get(p.wayId) ?? []));
    if (!portalPts.length) continue;

    const ring = p.points.map((pt) => [pt.lon, pt.lat] as [number, number]);
    // Adopt every real centreline this polygon actually contains (see `lineEdges` above). A run is
    // mapped as many ways and most lie elsewhere on the mountain, so bbox-reject those first, then
    // measure how much of each survivor is genuinely inside the ring.
    let rx0 = Infinity;
    let ry0 = Infinity;
    let rx1 = -Infinity;
    let ry1 = -Infinity;
    let perimDeg = 0;
    for (let i = 0; i < ring.length; i++) {
      rx0 = Math.min(rx0, ring[i][0]);
      rx1 = Math.max(rx1, ring[i][0]);
      ry0 = Math.min(ry0, ring[i][1]);
      ry1 = Math.max(ry1, ring[i][1]);
    }
    const kLat = Math.cos((((ry0 + ry1) / 2) * Math.PI) / 180);
    for (let i = 1; i < ring.length; i++)
      perimDeg += Math.hypot((ring[i][0] - ring[i - 1][0]) * kLat, ring[i][1] - ring[i - 1][1]);
    // Same convention as the classifier and the span test: a ribbon's length is about half its
    // perimeter. Used only to scale the "is this more than a clip-through" threshold.
    const polyLenM = (perimDeg * 111_320) / 2;
    const minAdoptM = Math.max(ADOPT_MIN_M, ADOPT_MIN_FRAC * polyLenM);
    // Score candidates per *way*, not per edge. `graph.edges` splits a run at every junction, so a
    // centreline that crosses the whole polygon arrives as a handful of fragments; testing each one
    // against a threshold scaled to the whole polygon rejects them one by one and leaves a spine
    // covering half the shape. Measured on Tignes `w94382148`: two ways were adopted yet the spine
    // spanned 49% of the axis, because the fragments that would have carried it from 12m to 493m
    // each fell under the bar on their own. Summing by way asks the question that was always meant:
    // does this *run* do more than clip through the polygon?
    const byCand = new Map<number | string, { edges: GraphEdge[]; inside: number }>();
    for (const c of lineEdges) {
      if (c.x1 < rx0 || c.x0 > rx1 || c.y1 < ry0 || c.y0 > ry1) continue;
      if (c.e.srcWayId === p.wayId) continue;
      const len = insideLenM(c.e.geometry, ring);
      if (len <= 0) continue;
      // An edge with no source way cannot be grouped, so it stands alone under its own id.
      const key = c.e.srcWayId ?? `e:${c.e.from}>${c.e.to}`;
      const g = byCand.get(key);
      if (g) {
        g.edges.push(c.e);
        g.inside += len;
      } else byCand.set(key, { edges: [c.e], inside: len });
    }
    const runEdges: GraphEdge[] = [];
    for (const g of byCand.values()) if (g.inside >= minAdoptM) runEdges.push(...g.edges);
    const spine = runEdges.map((e) => e.geometry);

    const res = skeleton(ring, portalPts, spine, String(p.wayId));
    if (!res) continue;
    // Fall-line fact check. Nothing has ever verified that the adopted centreline actually crosses
    // this polygon: the spine is whichever OSM way of the same named run happens to touch the ring,
    // so a run that clips a corner, or a few stubs around one junction, can become the "centreline"
    // of a polygon it never descends. Measure the spine's own drop against the polygon's own drop â€”
    // a spine that descends nothing is carrying nobody down the mountain, whatever its shape.
    const fall = fallLineCheck(p.points, res.skel.spinePieces, eleAt);
    if (!res) continue;
    // Stamp the owning polygon on every line so the debug page can isolate one way by id --
    // at resort zoom the overlay is a thicket and there is otherwise no way to tell which
    // shape is the one under discussion.
    for (const l of res.lines) l.way = p.wayId;
    out.push({
      wayId: p.wayId,
      label: [p.ref, p.name].filter(Boolean).join(' ') || '(unnamed)',
      cls: '?',
      ...res,
      fall,
      spineWayIds: [...new Set(runEdges.map((e) => e.srcWayId).filter((w): w is number => w != null))],
    });
  }
  return out;
}

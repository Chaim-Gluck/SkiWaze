/**
 * A surface lift is proof that its own direction is not self-propelled.
 *
 * Nobody builds a magic carpet, rope tow or drag lift along a stretch a skier can simply glide, so
 * wherever we have emitted a **flat traverse in a surface lift's uphill direction between that
 * lift's own two stations**, the traverse contradicts the lift's existence and is wrong.
 *
 * We cannot reach this conclusion through elevation. The case that found it is Madonna's "Tapis
 * Roulant Grostè Express - Fortini", a carpet over a road viaduct: the deck rises westward but both
 * our field and the independent Terrarium raster read the two ends within 1 m of each other, because
 * a short abrupt step over ~135 m is exactly what a 30 m DEM erases. An `area=yes`-style height fix
 * is forbidden here (both rasters agree and nothing reverses — see the sink rule in AGENTS.md), and
 * the flat reading is what earned the parallel footway (`w395885465`, tagged `highway=footway` +
 * `bridge=viaduct` + `piste:type=downhill`) a reverse traverse at 1.5% grade. That traverse handed
 * skiers a free crossing in the one direction that actually requires the carpet, and an A→B route
 * across the bridge reported "0 lifts". The lift beside it is the evidence the DEM cannot supply.
 *
 * The shape removed is a traverse sharing the lift's own node pair, in the lift's uphill sense.
 * Fleet-wide this is rare and clean: **50** edges duplicate a surface lift's node pair and direction,
 * and most carry the lift's own name (Grenouilles, Replat, Dromonts, Baby Wold, Slow Vallon,
 * Tourbière) — beginner-area corridors where the marked line and the tow share ground.
 *
 * **Do not widen this to a proximity or reachability test.** It was tried, three ways, chasing the
 * remaining free crossings at the Madonna viaduct, and every version failed the same way — no knee
 * in the sweep, so no threshold is defensible: "both endpoints within R of the two stations" gives
 * 45 / 110 / 558 edges at R = 1 / 20 / 40 m, and "arrives at the top station from anywhere that can
 * reach the base without a lift" gives 324 / 462 / 625 at a 100 / 200 / 400 m walking budget. Those
 * numbers are dominated by nursery slopes where a skier genuinely *can* step around a 20 m carpet,
 * so a wider rule deletes real terrain. When free crossings survive this pass the cause is upstream —
 * an elevation the DEM cannot see (see `setNodeElevation` in the resort override) — not a rule that
 * needs loosening.
 *
 * Three guards, each deliberate:
 *
 * 1. **Flat traverses only.** A `skiable_down` connector or a `piste` edge is a claim that terrain
 *    genuinely descends that way; if it descends along a lift's uphill line then one of the two is
 *    misoriented, and silently deleting the run would hide the real defect. Those 3 cases fleet-wide
 *    are left alone and are worth a look (`st-anton-arlberg` Furka-Steinmähder / Balmengratlift).
 * 2. **Surface lifts only** (`SURFACE_LIFT_TYPES`). An aerial lift flies over terrain and proves
 *    nothing about the ground beneath it — a gondola routinely parallels a perfectly skiable run.
 * 3. **Never strand.** A traverse is only dropped if the graph is no less connected without it. The
 *    same principle as the elevation-consensus pass: the only safe invariant is reachability, so a
 *    drop that takes terrain out of the lift network is reverted rather than argued with. Only the
 *    uphill direction is ever dropped, so the paired downhill traverse always survives.
 */
import type { GraphEdge, ResortGraph } from '../../src/types/domain';

/** Lifts you stand on the snow for. An aerial lift overflies terrain and proves nothing about it. */
const SURFACE_LIFT_TYPES = new Set(['magic_carpet', 'rope_tow', 'drag_lift', 'platter', 't-bar', 'j-bar', 'people_mover', 'tow']);

function reachableFromLifts(g: ResortGraph): Set<string> {
  const rev = new Map<string, string[]>();
  for (const e of g.edges) (rev.get(e.to) ?? rev.set(e.to, []).get(e.to)!).push(e.from);
  const seeds = g.nodes.filter((n) => n.kind === 'lift_station').map((n) => n.id);
  const seen = new Set<string>(seeds);
  const queue = [...seeds];
  for (let i = 0; i < queue.length; i++) for (const p of rev.get(queue[i]) ?? []) if (!seen.has(p)) { seen.add(p); queue.push(p); }
  return seen;
}

export interface SurfaceLiftParallelResult {
  graph: ResortGraph;
  dropped: { edgeId: string; liftName: string; lengthM: number }[];
  keptStranding: number;
}

export function dropTraversesAlongSurfaceLifts(graph: ResortGraph): SurfaceLiftParallelResult {
  const byDirection = new Map<string, GraphEdge>();
  for (const e of graph.edges) {
    if (e.kind !== 'lift' || !SURFACE_LIFT_TYPES.has(String(e.liftType))) continue;
    byDirection.set(`${e.from}>${e.to}`, e);
  }
  if (byDirection.size === 0) return { graph, dropped: [], keptStranding: 0 };

  const contradicts = (e: GraphEdge): GraphEdge | undefined =>
    e.kind === 'connector' && e.connectorKind === 'flat_traverse' ? byDirection.get(`${e.from}>${e.to}`) : undefined;

  const candidates = graph.edges.filter((e) => contradicts(e) !== undefined);
  if (candidates.length === 0) return { graph, dropped: [], keptStranding: 0 };

  // Reachability is judged once against the graph we started from, then re-checked after the whole
  // set is removed. Dropping them one at a time would let an earlier drop excuse a later one.
  const before = reachableFromLifts(graph);
  const drop = new Set(candidates.map((e) => e.id));
  let trial: ResortGraph = { ...graph, edges: graph.edges.filter((e) => !drop.has(e.id)) };
  let keptStranding = 0;

  let after = reachableFromLifts(trial);
  while (true) {
    const lost = graph.nodes.filter((n) => before.has(n.id) && !after.has(n.id)).map((n) => n.id);
    if (lost.length === 0) break;
    // Something needed one of these. Put back every traverse touching a stranded node and re-test,
    // rather than abandoning the whole pass over one dependency.
    const lostSet = new Set(lost);
    const restore = candidates.filter((e) => drop.has(e.id) && (lostSet.has(e.from) || lostSet.has(e.to)));
    if (restore.length === 0) {
      // No candidate explains the loss — refuse to guess and keep the graph as it was.
      return { graph, dropped: [], keptStranding: candidates.length };
    }
    for (const e of restore) drop.delete(e.id);
    keptStranding += restore.length;
    trial = { ...graph, edges: graph.edges.filter((e) => !drop.has(e.id)) };
    after = reachableFromLifts(trial);
  }

  const dropped = candidates
    .filter((e) => drop.has(e.id))
    .map((e) => ({ edgeId: e.id, liftName: contradicts(e)?.liftName ?? '', lengthM: e.lengthM }));
  return { graph: trial, dropped, keptStranding };
}

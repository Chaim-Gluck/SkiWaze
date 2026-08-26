/**
 * Automatic elevation reversal repair — the second opinion, applied.
 *
 * Piste direction is derived purely from endpoint elevations, so one mis-sampled DEM point can
 * silently reverse a run. `repairPotholeElevations` in buildGraph catches the subset that is a
 * strict local extremum at a junction, using only internal consistency; it deliberately leaves run
 * ENDPOINTS and lift stations alone, and that is exactly where the rest live. Those were fixed by
 * hand for years — 117 `setNodeElevation` entries across 12 resorts, every one of them a human
 * copying a second DEM's reading off the audit output.
 *
 * This does that mechanically. It is deliberately conservative:
 *   - only piste edges (never areas, whose "direction" is meaningless);
 *   - only where BOTH the Terrarium point sample and its smoothed neighbourhood agree that the flow
 *     runs the other way by a clear margin ("strong" in the audit) — a single-pixel spike in the
 *     second source must not become our new truth;
 *   - only edges we did not already sample as clearly descending;
 *   - `ignoreReversals` in the override still wins, so a spot a human checked on the map and
 *     confirmed we have RIGHT is never "repaired" back to wrong.
 *
 * THE GUARD (do not remove): adopting the second opinion verbatim is ~80% right and the other 20%
 * is harmful. Sölden n3229643842 is the worked example — raw Terrarium says 2659, which ties its
 * uphill neighbour exactly. A tie is not a descent, so the piste INTO the node stops descending and
 * the node becomes an orphan: we would have traded a reversed edge for a disconnected one. Where an
 * adopted value fails to leave room for its neighbours, we instead take the height a straight
 * monotonic slope between the neighbours would give at that node's distance along it — which is how
 * the human arrived at 2656 by hand.
 */
import type { ResortGraph } from '../../src/types/domain';
import { sampleTerrarium } from './terrarium';

/** Only skip clearly-steep pistes; a smaller fake gradient can still be a flip. */
const FLAT_EDGE = 60;
/** Second source must disagree on flow direction by at least this many metres. */
const DIR = 10;
/** A descent must be strictly downhill by at least this much to count as one. */
const MIN_DROP = 1;
/** How far a monotonic seat may stray from the second DEM's reading before we distrust it. */
const RESEAT_MAX_M = 20;

export interface EleCorrection {
  node: string;
  ele: number;
  why: string;
}

const pairKey = (a: string, b: string): string => [a, b].sort().join('~');

function haversineM(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const R = 6371000,
    dLat = ((bLat - aLat) * Math.PI) / 180,
    dLon = ((bLon - aLon) * Math.PI) / 180;
  const la = (aLat * Math.PI) / 180,
    lb = (bLat * Math.PI) / 180;
  return (
    2 *
    R *
    Math.asin(
      Math.sqrt(
        Math.sin(dLat / 2) ** 2 + Math.cos(la) * Math.cos(lb) * Math.sin(dLon / 2) ** 2,
      ),
    )
  );
}

/**
 * Apply corrections, but never at the cost of stranding terrain.
 *
 * The narrow harm a reversal repair can do is to turn a mid-mountain node into a top nothing can
 * reach: Sölden n3229643842 adopted 2659 m, rose above both its neighbours, and both its piste
 * edges then pointed outward — a reversed edge traded for an orphaned one. A node legitimately
 * BECOMING a top is fine (that is what a reversal repair does) as long as something still reaches
 * it, so the test is reachability from the lift network, not local degree — the distinction that
 * makes this safe to run unattended.
 *
 * Corrections are dropped greedily: each round reverts the ones touching newly-stranded nodes and
 * re-tests, so one bad node can't cost us the rest of the repairs.
 */
/**
 * Height a straight slope between a node's highest and lowest piste neighbours reaches at that
 * node, weighted by distance along it. This is the value a human derives by hand when the raw
 * second-DEM reading is unusable — it keeps one edge descending in and one descending out.
 */
function seatMonotonic(graph: ResortGraph, nodeId: string): number | null {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const self = byId.get(nodeId);
  if (!self || self.point.ele == null) return null;
  const around: { ele: number; dist: number }[] = [];
  const seen = new Set<string>();
  for (const e of graph.edges) {
    if (e.kind !== 'piste' || e.area) continue;
    const other = e.from === nodeId ? e.to : e.to === nodeId ? e.from : null;
    if (!other || seen.has(other)) continue;
    const n = byId.get(other);
    if (!n || n.point.ele == null) continue;
    seen.add(other);
    around.push({
      ele: n.point.ele,
      dist: Math.max(1, haversineM(self.point.lat, self.point.lon, n.point.lat, n.point.lon)),
    });
  }
  if (around.length < 2) return null;
  around.sort((a, b) => b.ele - a.ele);
  const hi = around[0];
  const lo = around[around.length - 1];
  if (hi.ele - lo.ele < 2 * MIN_DROP) return null; // neighbours are level — nothing to seat between
  const t = hi.dist / (hi.dist + lo.dist);
  return Math.round(hi.ele + (lo.ele - hi.ele) * t);
}

export function applyCorrectionsGuarded(
  graph: ResortGraph,
  corrections: EleCorrection[],
  apply: (g: ResortGraph, c: EleCorrection[]) => ResortGraph,
  reachable: (g: ResortGraph) => Set<string>,
): { graph: ResortGraph; kept: EleCorrection[]; reverted: EleCorrection[] } {
  if (!corrections.length) return { graph, kept: [], reverted: [] };

  const strandedBefore = new Set(
    graph.nodes.map((n) => n.id).filter((id) => !reachable(graph).has(id)),
  );
  // Which corrected nodes sit next to a given node — used to blame a stranding on a correction.
  const touch = new Map<string, Set<string>>();
  for (const e of graph.edges) {
    for (const [a, b] of [
      [e.from, e.to],
      [e.to, e.from],
    ] as const) {
      const s = touch.get(a) ?? touch.set(a, new Set()).get(a)!;
      s.add(b);
    }
  }

  let kept = [...corrections];
  const reverted: EleCorrection[] = [];
  /** Nodes we have already tried to reseat, so a stubborn one can't loop. */
  const reseatCount = new Map<string, number>();
  for (let round = 0; round < 8 && kept.length; round++) {
    const next = apply(graph, kept);
    const now = reachable(next);
    const newlyStranded = next.nodes
      .map((n) => n.id)
      .filter((id) => !now.has(id) && !strandedBefore.has(id));
    if (!newlyStranded.length) return { graph: next, kept, reverted };

    // Before giving up on a correction, try the move a human makes here: instead of the second
    // DEM's raw reading, seat the node on a straight slope between its highest and lowest piste
    // neighbours. Sölden n3229643842 is the worked example — raw 2659 m makes it a top nothing can
    // reach, the seated value keeps one edge in and one out. Only if that also strands do we revert.
    const strandedSet = new Set(newlyStranded);
    let blame = new Set(kept.filter((c) => strandedSet.has(c.node)).map((c) => c.node));
    if (!blame.size) {
      blame = new Set<string>();
      for (const id of newlyStranded) for (const nb of touch.get(id) ?? []) blame.add(nb);
    }

    const reseated: EleCorrection[] = [];
    const stillBlamed = new Set<string>();
    for (const c of kept) {
      if (!blame.has(c.node)) continue;
      const raw = reseatCount.get(c.node) ? null : seatMonotonic(next, c.node);
      // A seat is a topology repair, not a measurement. Accept it only when it stays near the second
      // DEM's actual reading; a seat tens of metres away is inventing terrain to satisfy the graph,
      // which is worse than leaving the reversal for a human to judge.
      const seat = raw != null && Math.abs(raw - c.ele) <= RESEAT_MAX_M ? raw : null;
      if (seat != null && Math.abs(seat - c.ele) >= MIN_DROP) {
        reseatCount.set(c.node, 1);
        reseated.push({
          ...c,
          ele: seat,
          why: `second DEM ${c.ele}m would strand terrain; seated on a monotonic slope between its neighbours`,
        });
      } else {
        stillBlamed.add(c.node);
      }
    }
    if (reseated.length) {
      kept = kept
        .filter((c) => !blame.has(c.node))
        .concat(reseated)
        .concat(kept.filter((c) => blame.has(c.node) && !reseated.some((r) => r.node === c.node) && !stillBlamed.has(c.node)));
      continue;
    }

    const survivors = kept.filter((c) => !blame.has(c.node));
    if (survivors.length === kept.length) break; // can't attribute it — drop the lot below
    reverted.push(...kept.filter((c) => blame.has(c.node)));
    kept = survivors;
  }

  // Nothing attributable: prefer the original graph over a stranding.
  reverted.push(...kept);
  return { graph, kept: [], reverted };
}

export async function proposeElevationCorrections(
  graph: ResortGraph,
  ignoreReversals: { from: string; to: string }[] = [],
): Promise<{ corrections: EleCorrection[]; sampled: number; flips: number }> {
  const ignored = new Set(ignoreReversals.map((r) => pairKey(r.from, r.to)));

  // --- 1. Second opinion for every node ---------------------------------------------------------
  const S = new Map<string, { our: number; terr: number; smooth: number; lat: number; lon: number }>();
  for (const n of graph.nodes) {
    if (n.point.ele == null) continue;
    const { point, smooth } = await sampleTerrarium(n.point.lat, n.point.lon);
    if (point == null || smooth == null) continue;
    S.set(n.id, {
      our: n.point.ele,
      terr: point,
      smooth,
      lat: n.point.lat,
      lon: n.point.lon,
    });
  }

  // --- 2. Piste edges the second source says run the other way -----------------------------------
  const flipped = new Set<string>();
  for (const e of graph.edges) {
    if (e.kind !== 'piste' || e.area) continue;
    if (ignored.has(pairKey(e.from, e.to))) continue;
    const A = S.get(e.from);
    const B = S.get(e.to);
    if (!A || !B) continue;
    if (A.our - B.our > FLAT_EDGE) continue; // clearly descending as sampled — trust it
    // Require BOTH the point sample and the smoothed neighbourhood to agree on the reverse.
    if (A.terr - B.terr < -DIR && A.smooth - B.smooth < -DIR) {
      flipped.add(e.from);
      flipped.add(e.to);
    }
  }
  if (!flipped.size) return { corrections: [], sampled: S.size, flips: 0 };

  // --- 3. Adopt the second opinion at those nodes -------------------------------------------------
  const adopted = new Map<string, number>();
  for (const id of flipped) adopted.set(id, S.get(id)!.terr);

  // Piste neighbours of each corrected node, under the field as it will stand after adoption.
  const eleAfter = (id: string): number | null => adopted.get(id) ?? S.get(id)?.our ?? null;
  const nbrs = new Map<string, { id: string; dist: number }[]>();
  for (const e of graph.edges) {
    if (e.kind !== 'piste' || e.area) continue;
    for (const [a, b] of [
      [e.from, e.to],
      [e.to, e.from],
    ] as const) {
      if (!flipped.has(a)) continue;
      const A = S.get(a);
      const B = S.get(b);
      if (!A || !B) continue;
      const list = nbrs.get(a) ?? nbrs.set(a, []).get(a)!;
      if (!list.some((x) => x.id === b))
        list.push({ id: b, dist: Math.max(1, haversineM(A.lat, A.lon, B.lat, B.lon)) });
    }
  }

  // --- 4. The guard: an adopted value must not TIE a neighbour ------------------------------------
  // Adopting the second opinion legitimately turns some nodes into the high end of their run — that
  // is the whole point of a reversal repair, and must not be "corrected" back. The narrow failure to
  // guard against is a TIE: a node landing level with a neighbour, where the touching piste is then
  // neither a descent nor an ascent and the node strands. Fire only on that.
  const corrections: EleCorrection[] = [];
  const changed = new Set<string>();
  for (let pass = 0; pass < 3; pass++) {
    let moved = false;
    for (const id of flipped) {
      const cur = adopted.get(id)!;
      const around = nbrs.get(id) ?? [];
      if (around.length < 2) continue;
      const tied = around.some((n) => Math.abs((eleAfter(n.id) ?? cur) - cur) < MIN_DROP);
      if (!tied) continue;
      const sorted = [...around].sort((a, b) => (eleAfter(b.id) ?? 0) - (eleAfter(a.id) ?? 0));
      const hi = sorted[0];
      const lo = sorted[sorted.length - 1];
      const hiE = eleAfter(hi.id) ?? cur;
      const loE = eleAfter(lo.id) ?? cur;
      if (hiE - loE < 2 * MIN_DROP) continue; // neighbours themselves are level — nothing to seat between
      // Height a straight slope from the highest to the lowest neighbour reaches at this node.
      const t = hi.dist / (hi.dist + lo.dist);
      const seated = Math.round(hiE + (loE - hiE) * t);
      if (seated === cur) continue;
      adopted.set(id, seated);
      changed.add(id);
      moved = true;
    }
    if (!moved) break;
  }

  for (const id of flipped) {
    const value = adopted.get(id)!;
    const our = S.get(id)?.our ?? value;
    if (Math.abs(value - our) < MIN_DROP) continue; // nothing to change
    corrections.push({
      node: id,
      ele: Math.round(value),
      why: changed.has(id)
        ? `second DEM ${Math.round(S.get(id)!.terr)}m would tie a neighbour; seated on a monotonic slope instead`
        : 'second DEM',
    });
  }

  return { corrections, sampled: S.size, flips: flipped.size };
}

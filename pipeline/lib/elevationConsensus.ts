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

/**
 * A "ski sink" is a node every skiable edge ARRIVES at and none leaves: you ski in and can only get
 * out by riding a lift or by climbing. Most are real (a valley station, the bottom of a bowl). The
 * ones that are not are single mis-sampled points sitting in a dip they invented, and they strand
 * every run above them — Sölden's Giggijoch station read 2262 m against a true ~2274 m, and that
 * alone trapped a 13-node basin: at -13 m over 44 m its cat-track is too steep to earn a reverse
 * traverse, while at -3 m it is flat enough to walk back up.
 *
 * The tell is NOT topology (a genuine valley bottom looks identical) but that the node is an
 * ISOLATED outlier: it disagrees with the second DEM by a clear margin while every neighbour agrees
 * with it. At a real bottom both sources agree, so nothing fires. Lift stations are included on
 * purpose — `repairPotholeElevations` skips them by design, so this is the only pass that can catch
 * a mis-seated station, and a station is exactly where a whole sector's runs converge.
 */
const SINK_MIN = 8;
/** ...and only when the ground around it agrees with the second DEM this closely (m). */
const SINK_NBR_AGREE = 5;
/**
 * One neighbour a little over SINK_NBR_AGREE does not make a disagreement systematic. Where the
 * median neighbour still agrees, a node may pass on being a clear OUTLIER instead: its own
 * disagreement must be at least this multiple of the worst neighbour's.
 */
const SINK_OUTLIER_RATIO = 2;
/** A link rising more than this (m) under the current field is not counted as a way out. */
const SINK_OUT_CLIMB = 2;

/**
 * A run's COLOUR is a published fact from the resort, and a colour has a physical ceiling — a blue
 * is not a 75% wall. So a piste edge measured far beyond its colour's ceiling is evidence of a bad
 * elevation at one of its ends, arrived at WITHOUT consulting a second DEM at all. That independence
 * is the whole point: it gives this pass a trigger it did not have.
 *
 * The two categories above both fire on a *reversal* (an edge, or a sink, whose flow is wrong). A
 * contiguous patch of nodes that is uniformly too low stays monotonic — every arrow still points
 * downhill — so it is structurally invisible to them, and the pass correctly declines. Portes du
 * Soleil's Nyon/Chamossière pocket is the worked example: five nodes read 19–76 m below the true
 * surface, turning a near-flat blue traverse ("Bleue d'Arare") into a 78% gully. Nothing reversed,
 * so nothing fired, while `check:audit` reported the residue as two unrelated pothole sinks.
 *
 * Ceilings are deliberately generous — well above the steepest real-world pitch of each colour — so
 * this reports faults, not steep-but-legal terrain.
 */
const COLOUR_GRADE_CEILING: Record<string, number> = {
  green: 0.35,
  blue: 0.45,
  red: 0.65,
  black: 1.0,
};
/**
 * Rank by EXCESS DROP (metres of implied error), never by gradient. A 21 m edge at 48% implies
 * about a metre of error and is noise; a 67 m edge at 75% implies 20 m and is a fault. Measured
 * fleet-wide the two populations separate cleanly at ~5 m: 8 edges across 4 resorts sit above it,
 * and everything below is ≤5.7 m and short.
 */
const STEEP_EXCESS_M = 5;
/** Below this length a metre of DEM noise is itself a huge fake gradient, so the test is meaningless. */
const STEEP_MIN_LEN = 20;
/** The second source must actually disagree at one end, or there is nothing to adopt. */
const STEEP_MIN_M = 8;

/**
 * How far a node must sit from the second DEM to count as part of the same fault. A colour-ceiling
 * complaint fires at the EDGE where a sunken patch meets sound ground, so the seed is always at the
 * patch's rim — repairing only the seed lifts the rim and opens a step into the untouched interior.
 */
const PATCH_DISAGREE_M = 8;

/**
 * A connector the builder emitted in BOTH directions is, by construction, a link it judged traversable
 * on the flat (`flatGradeMax`, 6%). If a proposed correction turns one into a real pitch, the
 * correction is wrong — not the connector. 2x slack, because the label was assigned from the old field.
 */
const PATCH_FLAT_CEILING = 0.12;

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
): Promise<{ corrections: EleCorrection[]; sampled: number; flips: number; steep: number }> {
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
  // --- 2b. Ski sinks the second source says are simply seated too low -----------------------------
  // See SINK_MIN. Skiable = piste/connector; lift edges are ignored, because "you can only leave by
  // lift" is precisely the symptom, not a refutation.
  //
  // App-invented PLUMBING does not count as a way out. A polygon skeleton arm is exempt from the
  // flat-traverse grade cap by design (see buildGraph: an arm may be emitted in both directions on a
  // real pitch, so a gateway does not become a one-way valve), which means a single arm reaching a
  // node hands it a fake out-edge and hides it from this test. Worked example, found by a user's eye
  // when every detector passed: Paradiski n1000000001983 sits 16 m below the second DEM with three
  // real runs arriving and nothing leaving but arm e4897 — a 20% "flat traverse". That one fake
  // out-edge is the only reason the node was not reported, and it pointed Kamikaze up the hill.
  const plumbing = (e: { skeletonArm?: boolean; spineDuplicate?: boolean }): boolean =>
    e.skeletonArm === true || e.spineDuplicate === true;
  const skiNbrs = new Map<string, Set<string>>();
  for (const e of graph.edges) {
    if (e.kind === 'lift' || e.area) continue;
    for (const [a, b] of [
      [e.from, e.to],
      [e.to, e.from],
    ] as const)
      (skiNbrs.get(a) ?? skiNbrs.set(a, new Set()).get(a)!).add(b);
  }

  // The detector must judge the field as it will STAND, not as it arrived: category 1 is about to
  // move nodes, and moving one end of a run re-orients it. Paradiski n1000000001983 is the worked
  // example — while its downhill neighbour n669482305 still read 15 m low, the node had two
  // out-edges and was no sink; the instant that neighbour was repaired it became one. So the field
  // is read through `cur`, and a piste's direction is IMPLIED by `cur` rather than taken from the
  // stored orientation, which build.ts has not yet redone.
  const sunk = new Set<string>();
  const cur = (id: string): number | undefined => {
    const s = S.get(id);
    if (!s) return undefined;
    return flipped.has(id) || sunk.has(id) ? s.terr : s.our;
  };
  const findSinks = (): boolean => {
    const skiIn = new Map<string, number>();
    const skiOut = new Map<string, number>();
    const note = (m: Map<string, number>, k: string): void => m.set(k, (m.get(k) ?? 0) + 1);
    for (const e of graph.edges) {
      if (e.kind === 'lift' || e.area || plumbing(e)) continue;
      let [from, to] = [e.from, e.to];
      const a = cur(from);
      const b = cur(to);
      // A piste's direction is decided by its endpoints, so read it off the field rather than the
      // stored orientation, which build.ts has not redone yet.
      if (e.kind === 'piste' && a !== undefined && b !== undefined && b > a) [from, to] = [to, from];
      // A link that CLIMBS is not a way out. You cannot ski up it — cost.ts charges 12 s/m to push —
      // so counting it hides exactly the node this test exists to find. This also covers polygon
      // skeleton arms, which reach here before `skeletonArm` is stamped on them and are emitted in
      // both directions regardless of grade: Paradiski's n1000000001983 was masked by one climbing
      // 8 m, and the sunken node then pointed Kamikaze up the hill.
      const rise = a !== undefined && b !== undefined ? cur(to)! - cur(from)! : 0;
      if (rise > SINK_OUT_CLIMB) continue;
      note(skiOut, from);
      note(skiIn, to);
    }
    let found = false;
    for (const n of graph.nodes) {
      const self = S.get(n.id);
      if (!self || flipped.has(n.id) || sunk.has(n.id)) continue;
      if ((skiOut.get(n.id) ?? 0) > 0 || (skiIn.get(n.id) ?? 0) < 2) continue; // not a sink
      // Both readings must put us clearly too low, and no lower than the ground around us.
      if (self.terr - self.our < SINK_MIN || self.smooth - self.our < SINK_MIN) continue;
      const around = [...(skiNbrs.get(n.id) ?? [])]
        .map((id) => {
          const s = S.get(id);
          return s ? Math.abs(s.terr - (cur(id) ?? s.our)) : null;
        })
        .filter((x): x is number => x != null)
        .sort((p, q) => p - q);
      if (around.length < 2) continue;
      // The isolation test: if the ground around us disagrees with the second DEM too, this is a
      // systematic offset between two datasets over the whole area, not one bad point we may safely
      // replace. A single neighbour a little over the line does not make it systematic, though — so
      // the median must agree AND we must be a clear outlier against the worst of them.
      const median = around[Math.floor(around.length / 2)];
      const worst = around[around.length - 1];
      if (median > SINK_NBR_AGREE) continue;
      if (worst > SINK_NBR_AGREE && self.terr - self.our < SINK_OUTLIER_RATIO * worst) continue;
      sunk.add(n.id);
      found = true;
    }
    return found;
  };
  // Each repair can expose the next one downstream, so keep going until it settles. Bounded, because
  // a bound is cheaper than proving termination on data we do not control.
  for (let round = 0; round < 4 && findSinks(); round++);

  // --- 2c. Piste edges far too steep for their published colour ----------------------------------
  // See COLOUR_GRADE_CEILING. Unlike 2 and 2b this does not need the flow to be wrong, only the
  // shape to be impossible — which is what makes it catch a uniformly-sunken patch.
  const steep = new Set<string>();
  for (const e of graph.edges) {
    if (e.kind !== 'piste' || e.area) continue;
    if (ignored.has(pairKey(e.from, e.to))) continue;
    const ceil = COLOUR_GRADE_CEILING[e.color ?? ''];
    if (ceil === undefined) continue; // an unrated run has no published ceiling to test against
    if (!e.lengthM || e.lengthM < STEEP_MIN_LEN) continue;
    const A = S.get(e.from);
    const B = S.get(e.to);
    if (!A || !B) continue;
    const excess = (Math.abs(A.our - B.our) / e.lengthM - ceil) * e.lengthM;
    if (excess < STEEP_EXCESS_M) continue;
    // Self-validating: only adopt where adopting actually RESOLVES the complaint. If the second
    // source thinks the pitch is impossible too, it is not the arbiter here and we leave it for a
    // human — the same "decline rather than guess" rule the other two categories follow.
    if (Math.abs(A.terr - B.terr) / e.lengthM > ceil) continue;
    if (Math.abs(A.smooth - B.smooth) / e.lengthM > ceil) continue;
    if (Math.abs(A.terr - A.our) < STEEP_MIN_M && Math.abs(B.terr - B.our) < STEEP_MIN_M) continue;
    steep.add(e.from);
    steep.add(e.to);
  }

  // --- 2d. Atomic patches: repair a whole fault or none of it ------------------------------------
  // Half a repair is worse than none. A colour-ceiling complaint fires where a sunken patch MEETS
  // sound ground, so correcting only the flagged nodes raises the rim and drops a step into the
  // interior. Worked example (Avoriaz, portes-du-soleil): 15 nodes read 8-64 m low; repairing the 5
  // that broke a blue's ceiling left the lift top n4578135789 20 m below the runs around it, so every
  // ski arrow pointed INTO it. So: grow each seed to the connected set that disagrees with the second
  // DEM, then price EVERY touching edge under the fully-corrected field. If any of them comes out
  // implausible, the second DEM is not a competent arbiter over this patch and we decline all of it.
  const patchOf = (seeds: Set<string>): Set<string>[] => {
    const adj = new Map<string, string[]>();
    for (const e of graph.edges) {
      if (e.area) continue;
      (adj.get(e.from) ?? adj.set(e.from, []).get(e.from)!).push(e.to);
      (adj.get(e.to) ?? adj.set(e.to, []).get(e.to)!).push(e.from);
    }
    const seen = new Set<string>();
    const out: Set<string>[] = [];
    for (const seed of seeds) {
      if (seen.has(seed)) continue;
      const patch = new Set<string>([seed]);
      const queue = [seed];
      seen.add(seed);
      while (queue.length) {
        for (const nb of adj.get(queue.pop()!) ?? []) {
          if (patch.has(nb)) continue;
          const s = S.get(nb);
          if (!s || Math.abs(s.terr - s.our) < PATCH_DISAGREE_M) continue;
          patch.add(nb);
          seen.add(nb);
          queue.push(nb);
        }
      }
      out.push(patch);
    }
    return out;
  };

  const twoWay = new Set<string>();
  const seenDir = new Set<string>();
  for (const e of graph.edges) {
    if (e.kind !== 'connector' || plumbing(e)) continue;
    if (seenDir.has(`${e.to}>${e.from}`)) twoWay.add(pairKey(e.from, e.to));
    seenDir.add(`${e.from}>${e.to}`);
  }

  const rejected = new Set<string>();
  for (const patch of patchOf(steep)) {
    const after = (id: string): number | undefined =>
      patch.has(id) ? S.get(id)?.terr : S.get(id)?.our;
    let ok = true;
    for (const e of graph.edges) {
      if (e.area || !e.lengthM) continue;
      if (!patch.has(e.from) && !patch.has(e.to)) continue;
      const a = after(e.from);
      const b = after(e.to);
      if (a === undefined || b === undefined) continue;
      const grade = Math.abs(a - b) / e.lengthM;
      if (e.kind === 'piste') {
        const ceil = COLOUR_GRADE_CEILING[e.color ?? ''];
        if (ceil !== undefined && e.lengthM >= STEEP_MIN_LEN && (grade - ceil) * e.lengthM >= STEEP_EXCESS_M)
          ok = false;
      } else if (e.kind === 'connector' && twoWay.has(pairKey(e.from, e.to))) {
        // Skeleton arms are EXEMPT: buildGraph emits an arm in both directions on a real pitch on
        // purpose, so "two-way" proves nothing about its grade. Only an ordinary two-way connector
        // carries the flat-traverse promise this test relies on.
        if (!plumbing(e) && grade > PATCH_FLAT_CEILING) ok = false;
      }
      if (!ok) break;
    }
    if (ok) for (const id of patch) steep.add(id);
    else for (const id of patch) rejected.add(id);
  }
  for (const id of rejected) steep.delete(id);
  if (rejected.size)
    console.log(
      `  elevation consensus: declined ${rejected.size} node(s) — the second DEM cannot repair that patch consistently`,
    );

  const suspect = new Set([...flipped, ...sunk, ...steep]);
  if (!suspect.size) return { corrections: [], sampled: S.size, flips: 0, steep: 0 };
  // --- 3. Adopt the second opinion at those nodes -------------------------------------------------
  const adopted = new Map<string, number>();
  for (const id of suspect) adopted.set(id, S.get(id)!.terr);
  // Piste neighbours of each corrected node, under the field as it will stand after adoption.
  const eleAfter = (id: string): number | null => adopted.get(id) ?? S.get(id)?.our ?? null;
  const nbrs = new Map<string, { id: string; dist: number }[]>();
  for (const e of graph.edges) {
    if (e.kind !== 'piste' || e.area) continue;
    for (const [a, b] of [
      [e.from, e.to],
      [e.to, e.from],
    ] as const) {
      if (!suspect.has(a)) continue;
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
    for (const id of suspect) {
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

  for (const id of suspect) {
    const value = adopted.get(id)!;
    const our = S.get(id)?.our ?? value;
    if (Math.abs(value - our) < MIN_DROP) continue; // nothing to change
    const kind = sunk.has(id)
      ? 'ski sink, isolated low outlier'
      : steep.has(id) && !flipped.has(id)
        ? 'impossible gradient for the run colour'
        : 'second DEM';
    corrections.push({
      node: id,
      ele: Math.round(value),
      why: changed.has(id)
        ? `${kind}: ${Math.round(S.get(id)!.terr)}m would tie a neighbour; seated on a monotonic slope instead`
        : kind,
    });
  }

  return { corrections, sampled: S.size, flips: flipped.size + sunk.size, steep: steep.size };
}

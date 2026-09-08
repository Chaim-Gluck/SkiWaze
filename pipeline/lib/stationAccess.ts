/**
 * Two rules about the links the app invents between a lift station and the snow.
 *
 * `buildGraph`'s dead-end snap marks the links it draws out of a lift station `stationAccess`. That
 * pass answers "can a skier ski onward from here", and it runs BEFORE the lift-top ski-out pass, so
 * at snap time a lift top with no ski-out still looks stranded. The snap therefore invents a ramp,
 * the ski-out pass then adds the correct descending exit, and nothing ever removes the first answer.
 * Both rules below are the cleanup: they only ever REMOVE a link the app itself invented, never a
 * mapped way, and never a direction that is the last one holding terrain on.
 *
 * **Rule C - a station-access link that CLIMBS is redundant once the station has a real descending
 * exit.** St. Anton's Kindlisfeldlift top is the case a user found by eye: the ski-out pass gave the
 * station two one-way descents onto the runs below (`e2364`, `e2365`), and beside them the snap had
 * left a two-way ramp climbing 9.6 m over 15 m (`e2008`/`e2009`) - a 64% push up to reach terrain
 * you can already ski down onto. Their question is the rule: *if there is one that goes down, why do
 * we also need the one that goes up?*
 *
 * Only the CLIMBING half is dropped. Its twin descends INTO the station, which is the ski-in - the
 * thing `liftSkiIn.ts` exists to guarantee - so removing that would undo a separate rule. Most
 * `stationAccess` links are near-level (fleet median 0.0 m) and those are a station's ordinary
 * attachment to the snow; the rule must not touch them.
 *
 * Threshold is `maxTraverseClimb`, not a swept number: the sweep has no knee (0.5 m drops 311,
 * 2 m 164, 4 m 62, 8 m 13), so the honest choice is the constant the BUILDER already uses for
 * "can a skier get back up this" rather than a value picked to make a count look good. Same
 * discipline as `POTHOLE_CLIMB_TOL`.
 *
 * **Rule D - station-access direction follows the lift's own direction.** At the top of an up-only
 * lift the station is a SOURCE: you cannot board there, so a link arriving at it can never be used
 * to reach the lift and only offers a dead end. Verbier's "en projet" chair top is the case - `e1365`
 * climbs 9 m out of the station and `e1366` descends the same 9 m back into it, and the second is
 * unusable by construction. Guarded on the node being the `to` of an ascending lift and the `from`
 * of NO lift: a downloadable gondola's top has a lift edge leaving it, and a node that is also
 * another lift's base is a place you really can board.
 *
 * **Never strand, in BOTH directions.** Walking backwards from the lift stations answers "can this
 * node still get back to a lift"; walking forwards answers "can a skier still get here". They are
 * different questions and a single link can be the only thing providing either - `roadCrossing.ts`
 * shipped guarding backwards only and silently stranded 12 nodes. A station top is exactly the kind
 * of node that can double as a through-point between two runs, which is what makes rule D the
 * riskier of the two, so both rules re-test both directions and restore whatever is load-bearing.
 */
import type { GraphEdge, ResortGraph } from '../../src/types/domain';

function adjacency(edges: GraphEdge[]) {
  const fwd = new Map<string, string[]>();
  const rev = new Map<string, string[]>();
  for (const e of edges) {
    (fwd.get(e.from) ?? fwd.set(e.from, []).get(e.from)!).push(e.to);
    (rev.get(e.to) ?? rev.set(e.to, []).get(e.to)!).push(e.from);
  }
  return { fwd, rev };
}

function walk(seeds: string[], adj: Map<string, string[]>): Set<string> {
  const seen = new Set(seeds);
  const queue = [...seeds];
  for (let i = 0; i < queue.length; i++) {
    for (const n of adj.get(queue[i]) ?? []) if (!seen.has(n)) { seen.add(n); queue.push(n); }
  }
  return seen;
}

/** Nodes that can reach a lift, and nodes a skier can reach from one. Both must not shrink. */
function connectivity(g: ResortGraph): { back: Set<string>; fwd: Set<string> } {
  const { fwd, rev } = adjacency(g.edges);
  const seeds = g.nodes.filter((n) => n.kind === 'lift_station').map((n) => n.id);
  return { back: walk(seeds, rev), fwd: walk(seeds, fwd) };
}

/**
 * Remove `candidates` as a set, restoring any whose absence costs connectivity in either direction.
 * Judged once against the graph we started from, then re-tested after the whole set is gone -
 * dropping one at a time would let an earlier drop excuse a later one.
 */
function dropGuarded(graph: ResortGraph, candidates: GraphEdge[]): { graph: ResortGraph; dropped: GraphEdge[]; kept: number } {
  if (candidates.length === 0) return { graph, dropped: [], kept: 0 };
  const before = connectivity(graph);
  const drop = new Set(candidates.map((e) => e.id));
  let trial: ResortGraph = { ...graph, edges: graph.edges.filter((e) => !drop.has(e.id)) };
  let kept = 0;

  for (;;) {
    const after = connectivity(trial);
    const lost = graph.nodes
      .filter((n) => (before.back.has(n.id) && !after.back.has(n.id)) || (before.fwd.has(n.id) && !after.fwd.has(n.id)))
      .map((n) => n.id);
    if (lost.length === 0) break;
    const lostSet = new Set(lost);
    const restore = candidates.filter((e) => drop.has(e.id) && (lostSet.has(e.from) || lostSet.has(e.to)));
    if (restore.length === 0) {
      // No candidate explains the loss. Refuse to guess and leave the graph exactly as it was.
      return { graph, dropped: [], kept: candidates.length };
    }
    for (const e of restore) drop.delete(e.id);
    kept += restore.length;
    trial = { ...graph, edges: graph.edges.filter((e) => !drop.has(e.id)) };
  }

  return { graph: trial, dropped: candidates.filter((e) => drop.has(e.id)), kept };
}

export interface StationAccessResult {
  graph: ResortGraph;
  redundantClimbs: { edgeId: string; station: string; climbM: number; lengthM: number }[];
  unboardableInbound: { edgeId: string; station: string; liftName: string }[];
  keptStranding: number;
}

export function tidyStationAccessLinks(graph: ResortGraph, maxTraverseClimb: number): StationAccessResult {
  const stations = new Set(graph.nodes.filter((n) => n.kind === 'lift_station').map((n) => n.id));
  let keptStranding = 0;

  // --- Rule C ------------------------------------------------------------
  // A station with any non-lift exit that loses height can be left on skis without pushing, so a
  // station-access link that climbs out of it is not the way off the mountain - it is a leftover.
  const hasDescendingExit = new Set<string>();
  for (const e of graph.edges) {
    if (e.kind === 'lift' || e.stationAccess || e.dropM >= 0) continue;
    hasDescendingExit.add(e.from);
  }
  const climbs = graph.edges.filter(
    (e) => e.stationAccess && stations.has(e.from) && e.dropM > maxTraverseClimb && hasDescendingExit.has(e.from),
  );
  const c = dropGuarded(graph, climbs);
  keptStranding += c.kept;

  // --- Rule D ------------------------------------------------------------
  // Recomputed against the post-C graph so the two rules cannot both claim the same edge.
  const arrivesAscending = new Set<string>();
  const departsByLift = new Set<string>();
  for (const e of c.graph.edges) {
    if (e.kind !== 'lift') continue;
    departsByLift.add(e.from);
    if (e.dropM > 0) arrivesAscending.add(e.to);
  }
  const liftNameAt = new Map<string, string>();
  for (const e of c.graph.edges) if (e.kind === 'lift' && e.liftName) liftNameAt.set(e.to, e.liftName);

  const inbound = c.graph.edges.filter(
    (e) => e.stationAccess && stations.has(e.to) && arrivesAscending.has(e.to) && !departsByLift.has(e.to),
  );
  const d = dropGuarded(c.graph, inbound);
  keptStranding += d.kept;

  return {
    graph: d.graph,
    redundantClimbs: c.dropped.map((e) => ({ edgeId: e.id, station: e.from, climbM: e.dropM, lengthM: e.lengthM })),
    unboardableInbound: d.dropped.map((e) => ({ edgeId: e.id, station: e.to, liftName: liftNameAt.get(e.to) ?? '' })),
    keptStranding,
  };
}

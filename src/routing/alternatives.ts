import type { GraphEdge, Preferences, RouteObjective } from '../types/domain';
import type { GraphIndex } from './graphIndex';
import { shortestPath } from './dijkstra';
import { edgeCost } from './cost';

/**
 * How far along the route (in metres) a shortcut may reach when straightening a detour.
 * Deliberately short: we want to erase cosmetic wiggles, not re-optimise the route and collapse
 * a genuinely different alternative back onto the fastest one.
 */
const SMOOTH_WINDOW_M = 400;
/** A shortcut must cost no more than this fraction of the stretch it replaces. */
const SMOOTH_MAX_RATIO = 0.8;
/** ...and must save at least this much cost (~seconds), so we ignore rounding-level wins. */
const SMOOTH_MIN_GAIN = 10;
/** Safety bound on repeated smoothing passes. */
const SMOOTH_MAX_PASSES = 4;

interface LegCost {
  weight: number;
  seconds: number;
  /** Elapsed seconds when this leg starts (lift hours are time-dependent). */
  elapsed: number;
}

function legCosts(
  edges: GraphEdge[],
  prefs: Preferences,
  startDate: Date,
  objective: RouteObjective,
): LegCost[] {
  let elapsed = 0;
  return edges.map((e) => {
    const c = edgeCost(e, prefs, new Date(startDate.getTime() + elapsed * 1000), objective);
    const leg = { weight: c.weight, seconds: c.seconds, elapsed };
    elapsed += c.seconds;
    return leg;
  });
}

/**
 * Unpenalised Dijkstra from `startId`, abandoning any branch that costs more than `cutoff`.
 * The cutoff is what keeps this cheap enough to run for every node of every candidate route.
 */
function boundedSearch(
  index: GraphIndex,
  startId: string,
  prefs: Preferences,
  startDate: Date,
  cutoff: number,
  closedEdgeIds: ReadonlySet<string> | undefined,
  objective: RouteObjective,
): { weight: Map<string, number>; prev: Map<string, GraphEdge> } {
  const weight = new Map<string, number>([[startId, 0]]);
  const timeAt = new Map<string, number>([[startId, 0]]);
  const prev = new Map<string, GraphEdge>();
  // Small frontier (the cutoff keeps it tiny), so a sorted array beats heap bookkeeping.
  const queue: [number, string][] = [[0, startId]];
  const done = new Set<string>();

  while (queue.length > 0) {
    queue.sort((a, b) => a[0] - b[0]);
    const [w, cur] = queue.shift()!;
    if (done.has(cur)) continue;
    done.add(cur);
    const elapsed = timeAt.get(cur) ?? 0;
    const arrival = new Date(startDate.getTime() + elapsed * 1000);

    for (const edge of index.outEdges(cur)) {
      if (closedEdgeIds?.has(edge.id)) continue;
      const cost = edgeCost(edge, prefs, arrival, objective);
      if (!cost.allowed || !Number.isFinite(cost.weight)) continue;
      const next = w + cost.weight;
      if (next > cutoff) continue;
      if (next < (weight.get(edge.to) ?? Infinity)) {
        weight.set(edge.to, next);
        timeAt.set(edge.to, elapsed + cost.seconds);
        prev.set(edge.to, edge);
        queue.push([next, edge.to]);
      }
    }
  }
  return { weight, prev };
}

function reconstruct(prev: Map<string, GraphEdge>, from: string, to: string): GraphEdge[] | null {
  const out: GraphEdge[] = [];
  let node = to;
  const guard = new Set<string>();
  while (node !== from) {
    const e = prev.get(node);
    if (!e || guard.has(node)) return null;
    guard.add(node);
    out.push(e);
    node = e.from;
  }
  out.reverse();
  return out;
}

/** One left-to-right sweep; returns the improved route, or null if nothing was worth splicing. */
function smoothOnce(
  index: GraphIndex,
  edges: GraphEdge[],
  prefs: Preferences,
  startDate: Date,
  closedEdgeIds: ReadonlySet<string> | undefined,
  objective: RouteObjective,
): GraphEdge[] | null {
  if (edges.length < 2) return null;
  const costs = legCosts(edges, prefs, startDate, objective);
  const nodes = [edges[0].from, ...edges.map((e) => e.to)];

  for (let i = 0; i < nodes.length - 2; i++) {
    // Every node reachable within the window, with the route's own cost of getting there.
    const targets = new Map<string, { j: number; weight: number }>();
    let dist = 0;
    let w = 0;
    for (let j = i; j < edges.length; j++) {
      dist += edges[j].lengthM;
      w += costs[j].weight;
      if (dist > SMOOTH_WINDOW_M) break;
      targets.set(nodes[j + 1], { j: j + 1, weight: w });
    }
    if (targets.size === 0) continue;

    const cutoff = Math.max(...[...targets.values()].map((t) => t.weight));
    const arrival = new Date(startDate.getTime() + costs[i].elapsed * 1000);
    const { weight, prev } = boundedSearch(index, nodes[i], prefs, arrival, cutoff, closedEdgeIds, objective);

    // Prefer the longest splice that clears the bar — it removes the most of the detour at once.
    let best: { j: number; nodeId: string } | null = null;
    for (const [nodeId, t] of targets) {
      const found = weight.get(nodeId);
      if (found == null) continue;
      if (found <= t.weight * SMOOTH_MAX_RATIO && t.weight - found >= SMOOTH_MIN_GAIN) {
        if (!best || t.j > best.j) best = { j: t.j, nodeId };
      }
    }
    if (!best) continue;

    const replacement = reconstruct(prev, nodes[i], best.nodeId);
    if (!replacement || replacement.length === 0) continue;
    // Never let a splice touch ground the route already covers elsewhere — that would trade a
    // detour for a genuine doubling-back.
    const outside = new Set([...nodes.slice(0, i), ...nodes.slice(best.j + 1)]);
    if (replacement.some((e) => outside.has(e.from) || outside.has(e.to))) continue;

    return [...edges.slice(0, i), ...replacement, ...edges.slice(best.j)];
  }
  return null;
}

/**
 * Straighten out detours the penalty method introduces.
 *
 * Penalising an accepted route's edges pushes the next search off terrain that may have been
 * *forced* — the single sensible exit from a lift top, say. The search then buys its way around
 * with a short out-and-back that rejoins immediately, which reads as a bug on the map even though
 * the rest of the route is a legitimately different line. So we re-check every short stretch of a
 * candidate against an *unpenalised* search and splice in anything clearly cheaper. The window is
 * kept small on purpose: it erases the wiggle without re-optimising the route into a copy of the
 * fastest one.
 */
export function smoothDetours(
  index: GraphIndex,
  edges: GraphEdge[],
  prefs: Preferences,
  startDate: Date,
  closedEdgeIds?: ReadonlySet<string>,
  objective: RouteObjective = 'fastest',
): GraphEdge[] {
  let current = edges;
  for (let pass = 0; pass < SMOOTH_MAX_PASSES; pass++) {
    const next = smoothOnce(index, current, prefs, startDate, closedEdgeIds, objective);
    if (!next) break;
    current = next;
  }
  return current;
}

/** Overlap ratio (by distance) between a candidate and already-accepted routes. */
function overlapRatio(candidate: GraphEdge[], accepted: GraphEdge[][]): number {
  const candLen = candidate.reduce((s, e) => s + e.lengthM, 0) || 1;
  const candIds = new Set(candidate.map((e) => e.id));
  let maxShared = 0;
  for (const route of accepted) {
    let shared = 0;
    for (const e of route) if (candIds.has(e.id)) shared += e.lengthM;
    maxShared = Math.max(maxShared, shared / candLen);
  }
  return maxShared;
}

/**
 * Produce up to `k` diverse routes using a penalty method: after each found route,
 * multiply the weight of its edges so the next search is pushed onto different terrain.
 * Rejects candidates that overlap an accepted route by more than `maxOverlap`.
 */
export function alternativeRoutes(
  index: GraphIndex,
  startId: string,
  goalId: string,
  prefs: Preferences,
  startDate: Date,
  k = 3,
  maxOverlap = 0.7,
  closedEdgeIds?: ReadonlySet<string>,
  objective: RouteObjective = 'fastest',
): GraphEdge[][] {
  const accepted: GraphEdge[][] = [];
  const penalties = new Map<string, number>();
  const maxAttempts = k * 4;

  for (let attempt = 0; attempt < maxAttempts && accepted.length < k; attempt++) {
    const result = shortestPath(index, startId, goalId, prefs, startDate, penalties, closedEdgeIds, objective);
    if (!result || result.edges.length === 0) break;

    // Judge (and keep) the straightened version, but penalise what the search actually found —
    // penalties exist to push the *next* search onto new terrain, and the detour is terrain it
    // should not try again.
    const candidate = smoothDetours(index, result.edges, prefs, startDate, closedEdgeIds, objective);

    const isDuplicate = accepted.some(
      (r) => r.length === candidate.length && r.every((e, i) => e.id === candidate[i].id),
    );
    const overlap = overlapRatio(candidate, accepted);

    if (!isDuplicate && (accepted.length === 0 || overlap <= maxOverlap)) {
      accepted.push(candidate);
    }
    // Penalize this route's edges so the next search diverges.
    for (const e of result.edges) {
      penalties.set(e.id, (penalties.get(e.id) ?? 1) * 3);
    }
  }
  return accepted;
}

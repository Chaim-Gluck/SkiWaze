import type { GraphEdge, MeaningfulPoint, Preferences, Route, RouteRequest, ResortGraph, PisteColor } from '../types/domain';
import { PISTE_COLOR_ORDER } from '../types/domain';
import { GraphIndex } from './graphIndex';
import { shortestPath } from './dijkstra';
import { alternativeRoutes } from './alternatives';
import { longestDownhillStreak, longestDownhillRuns } from './longestStreak';
import { buildRoute } from './buildRoute';
import { resolveClosedEdgeIds } from './closures';
import { haversineM } from '../utils/geo';

export interface PlanResult {
  routes: Route[];
  /** Present when no route could be found. */
  error?: string;
  /** True when no lift-free ski route to the destination exists at the user's level. */
  noLiftFreeRoute?: boolean;
  /** Nearest ski-reachable (lift-free) named destination, suggested when noLiftFreeRoute. */
  nearestSkiDestination?: { name: string; nodeId: string };
}

/** The resort's single longest lift-free descent, anywhere in the resort. */
export interface LongestRun {
  distanceM: number;
  descentM: number;
  startNodeId: string;
  endNodeId: string;
  coords: [number, number][];
  /** The exact ordered edge chain of the run (for rendering it as a route). */
  edges: GraphEdge[];
}

/** Find the longest possible ski run (no lift) across the whole resort, within the user's level. */
export function findLongestRun(graph: ResortGraph, prefs: Preferences): LongestRun | null {
  return findLongestRuns(graph, prefs, 1)[0] ?? null;
}

/** Build a Route object from an explicit edge chain (e.g. to display a longest run as a route). */
export function routeForEdges(graph: ResortGraph, prefs: Preferences, edges: GraphEdge[], id = 'longest-run'): Route {
  const index = new GraphIndex(graph);
  return buildRoute(index, edges, prefs, new Date(), 'fastest', id);
}

/** Find up to `k` diverse longest lift-free runs across the resort, within the user's level. */
export function findLongestRuns(graph: ResortGraph, prefs: Preferences, k = 3): LongestRun[] {
  const index = new GraphIndex(graph);
  const chains = longestDownhillRuns(index, colorRank(prefs.maxDifficulty), k);
  return chains.map((chain) => {
    let distanceM = 0;
    let descentM = 0;
    const coords: [number, number][] = [];
    chain.forEach((e, i) => {
      distanceM += e.lengthM;
      descentM += e.dropM < 0 ? -e.dropM : 0;
      e.geometry.forEach((p, j) => {
        if (i === 0 || j > 0) coords.push([p.lon, p.lat]);
      });
    });
    return {
      distanceM,
      descentM,
      startNodeId: chain[0].from,
      endNodeId: chain[chain.length - 1].to,
      coords,
      edges: chain,
    };
  });
}

function colorRank(c: PisteColor | undefined): number {
  if (!c || c === 'unknown') return PISTE_COLOR_ORDER.length;
  return PISTE_COLOR_ORDER.indexOf(c);
}

/** Sort key for route options. When preferring skiing, put routes with fewer lifts first. */
function rankRoute(r: Route, prefs: Preferences): number {
  if (prefs.preferSkiing) return r.stats.liftCount * 100000 + r.stats.totalDurationS;
  return r.stats.totalDurationS;
}

/** Nodes reachable from `startId` using skiing only (pistes within level + connectors, no lifts). */
function skiOnlyReachable(index: GraphIndex, startId: string, prefs: Preferences, closedEdgeIds: ReadonlySet<string>): Set<string> {
  const maxRank = colorRank(prefs.maxDifficulty);
  const seen = new Set<string>([startId]);
  const queue = [startId];
  while (queue.length) {
    const cur = queue.shift()!;
    for (const e of index.outEdges(cur)) {
      if (closedEdgeIds.has(e.id)) continue;
      if (e.kind === 'lift') continue;
      if (e.kind === 'piste' && colorRank(e.color) > maxRank) continue;
      if (prefs.avoidSyntheticBridges && e.synthetic && !e.custom) continue;
      if (!seen.has(e.to)) {
        seen.add(e.to);
        queue.push(e.to);
      }
    }
  }
  return seen;
}

/** Find the nearest ski-reachable named destination to `toNodeId` (for a helpful suggestion). */
function nearestSkiDestination(
  graph: ResortGraph,
  index: GraphIndex,
  fromNodeId: string,
  toNodeId: string,
  prefs: Preferences,
  closedEdgeIds: ReadonlySet<string>,
): { skiable: boolean; suggestion?: { name: string; nodeId: string } } {
  const reachable = skiOnlyReachable(index, fromNodeId, prefs, closedEdgeIds);
  if (reachable.has(toNodeId)) return { skiable: true };

  const toNode = index.node(toNodeId);
  if (!toNode) return { skiable: false };
  // Prefer "bottom" destinations you can ski to, nearest to the intended target.
  let best: MeaningfulPoint | undefined;
  let bestD = Infinity;
  for (const p of graph.points) {
    if (p.nodeId === fromNodeId || p.nodeId === toNodeId) continue;
    if (!reachable.has(p.nodeId)) continue;
    if (p.type !== 'lift_bottom' && p.type !== 'piste_bottom') continue;
    const d = haversineM(toNode.point, p.point);
    if (d < bestD) {
      bestD = d;
      best = p;
    }
  }
  return { skiable: false, suggestion: best ? { name: best.name, nodeId: best.nodeId } : undefined };
}

/** Plan 2-3 route options for a request, honoring objective and timing. */
export function planRoutes(graph: ResortGraph, request: RouteRequest): PlanResult {
  const index = new GraphIndex(graph);
  const { fromNodeId, toNodeId, prefs, objective, timing } = request;
  const closedEdgeIds = resolveClosedEdgeIds(graph, request.closedKeys ?? []);

  if (!index.node(fromNodeId)) return { routes: [], error: 'Start point not found.' };
  if (!index.node(toNodeId)) return { routes: [], error: 'Destination not found.' };

  const now = new Date();
  const target = timing.mode === 'arrive_by' && timing.time ? new Date(timing.time) : null;
  // Provisional start used only to discover durations / evaluate lift hours initially.
  const provisionalStart = target ?? now;

  // Build a Route from an edge list, setting absolute start so it arrives by `target`
  // (arrive_by) or departs now.
  const finalize = (edges: GraphEdge[], id: string): Route => {
    if (target) {
      const probe = buildRoute(index, edges, prefs, target, objective, id);
      const start = new Date(target.getTime() - probe.stats.totalDurationS * 1000);
      return buildRoute(index, edges, prefs, start, objective, id);
    }
    return buildRoute(index, edges, prefs, now, objective, id);
  };

  if (objective === 'longest_streak') {
    return planLongestStreak(index, fromNodeId, prefs, provisionalStart, finalize, closedEdgeIds);
  }

  const paths = alternativeRoutes(index, fromNodeId, toNodeId, prefs, provisionalStart, 3, 0.7, closedEdgeIds);
  if (paths.length === 0) {
    const anyClosed = closedEdgeIds.size > 0;
    return {
      routes: [],
      error: anyClosed
        ? 'No route found — some lifts/runs on the way are marked closed. Try reopening one, or relax difficulty / lift types.'
        : 'No route found with your current preferences (try relaxing difficulty, lift types, or turning off "Avoid app-added bridges").',
    };
  }
  const routes = paths
    .map((edges, i) => finalize(edges, `route-${i + 1}`))
    // Prefer-skiing ranks fewer lifts first; otherwise rank by time.
    .sort((a, b) => rankRoute(a, prefs) - rankRoute(b, prefs));

  // Note when no lift-free ski route exists to this destination, with a suggestion.
  const ski = nearestSkiDestination(graph, index, fromNodeId, toNodeId, prefs, closedEdgeIds);
  if (!ski.skiable) {
    return { routes, noLiftFreeRoute: true, nearestSkiDestination: ski.suggestion };
  }
  return { routes };
}

function planLongestStreak(
  index: GraphIndex,
  fromNodeId: string,
  prefs: RouteRequest['prefs'],
  provisionalStart: Date,
  finalize: (edges: GraphEdge[], id: string) => Route,
  closedEdgeIds: ReadonlySet<string>,
): PlanResult {
  const streak = longestDownhillStreak(index);
  if (streak.length === 0) {
    return { routes: [], error: 'No lift-free descending run could be found in this resort data.' };
  }
  const streakTop = streak[0].from;
  const streakBottom = streak[streak.length - 1].to;

  let combined: GraphEdge[];
  if (fromNodeId === streakTop) {
    combined = streak;
  } else {
    const approach = shortestPath(index, fromNodeId, streakTop, prefs, provisionalStart, undefined, closedEdgeIds);
    if (!approach) {
      // Can't reach the streak top; offer the streak alone.
      combined = streak;
    } else {
      combined = [...approach.edges, ...streak];
    }
  }

  const routes: Route[] = [finalize(combined, 'longest-streak')];

  // Offer the pure streak as a second option when the approach added detours.
  if (combined.length !== streak.length) {
    routes.push(finalize(streak, 'streak-only'));
  }
  void streakBottom;
  return { routes };
}

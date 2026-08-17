import type { GraphEdge, MeaningfulPoint, Preferences, Route, RouteRequest, ResortGraph, PisteColor, RouteObjective } from '../types/domain';
import { PISTE_COLOR_ORDER } from '../types/domain';
import { GraphIndex } from './graphIndex';
import { alternativeRoutes } from './alternatives';
import { longestDownhillRuns, longestDownhillPath, longestDownhillPaths } from './longestStreak';
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

const OBJECTIVE_LABEL: Record<RouteObjective, string> = {
  fastest: 'Fastest',
  fewest_lifts: 'Fewest lifts',
  preferred: 'Preferred runs',
  longest_ab: 'Longest',
};

/** True when the skier actually restricts preferred colors (so a "preferred" route can differ). */
function hasColorPreference(prefs: Preferences): boolean {
  const all: PisteColor[] = ['green', 'blue', 'red', 'black'];
  return all.some((c) => !prefs.preferredColors.includes(c));
}

/** Identity key for a route's exact edge chain (for dedupe). */
function pathKey(edges: GraphEdge[]): string {
  return edges.map((e) => e.id).join('>');
}

function noRouteResult(closedEdgeIds: ReadonlySet<string>): PlanResult {
  const anyClosed = closedEdgeIds.size > 0;
  return {
    routes: [],
    error: anyClosed
      ? 'No route found — some lifts/runs on the way are marked closed. Try reopening one, or relax difficulty / lift types.'
      : 'No route found with your current preferences (try relaxing difficulty, lift types, or turning off "Avoid app-added bridges").',
  };
}

/**
 * Plan route option(s) for a request. `prefs.routeType` picks the mode: `balanced` shows one
 * best route per objective (deduped, each labeled); an individual type shows up to 3 distinct
 * routes optimised for that one objective. Every option honors both A and B.
 */
export function planRoutes(graph: ResortGraph, request: RouteRequest): PlanResult {
  const index = new GraphIndex(graph);
  const { fromNodeId, toNodeId, prefs, timing } = request;
  const closedEdgeIds = resolveClosedEdgeIds(graph, request.closedKeys ?? []);

  if (!index.node(fromNodeId)) return { routes: [], error: 'Start point not found.' };
  if (!index.node(toNodeId)) return { routes: [], error: 'Destination not found.' };

  const now = new Date();
  const target = timing.mode === 'arrive_by' && timing.time ? new Date(timing.time) : null;
  const provisionalStart = target ?? now;

  // Build a Route from an edge list, setting absolute start so it arrives by `target` or now.
  const finalize = (edges: GraphEdge[], objective: RouteObjective, id: string): Route => {
    if (target) {
      const probe = buildRoute(index, edges, prefs, target, objective, id);
      const start = new Date(target.getTime() - probe.stats.totalDurationS * 1000);
      return buildRoute(index, edges, prefs, start, objective, id);
    }
    return buildRoute(index, edges, prefs, now, objective, id);
  };

  const maxRank = colorRank(prefs.maxDifficulty);
  const routeType = prefs.routeType ?? 'balanced';
  const best = (objective: RouteObjective): GraphEdge[] | undefined =>
    alternativeRoutes(index, fromNodeId, toNodeId, prefs, provisionalStart, 1, 0.7, closedEdgeIds, objective)[0];

  const withSkiNote = (routes: Route[]): PlanResult => {
    const ski = nearestSkiDestination(graph, index, fromNodeId, toNodeId, prefs, closedEdgeIds);
    if (!ski.skiable) return { routes, noLiftFreeRoute: true, nearestSkiDestination: ski.suggestion };
    return { routes };
  };

  if (routeType === 'balanced') {
    // One best route per objective, deduped by exact path (merging labels).
    const byKey = new Map<string, { edges: GraphEdge[]; objective: RouteObjective; labels: string[]; order: number }>();
    const add = (edges: GraphEdge[] | undefined, objective: RouteObjective, order: number) => {
      if (!edges || edges.length === 0) return;
      const key = pathKey(edges);
      const existing = byKey.get(key);
      if (existing) {
        if (!existing.labels.includes(OBJECTIVE_LABEL[objective])) existing.labels.push(OBJECTIVE_LABEL[objective]);
      } else {
        byKey.set(key, { edges, objective, labels: [OBJECTIVE_LABEL[objective]], order });
      }
    };

    add(best('fastest'), 'fastest', 0);
    add(best('fewest_lifts'), 'fewest_lifts', 1);
    if (hasColorPreference(prefs)) add(best('preferred'), 'preferred', 2);
    add(longestDownhillPath(index, fromNodeId, toNodeId, maxRank), 'longest_ab', 3);

    if (byKey.size === 0) return noRouteResult(closedEdgeIds);
    const routes = [...byKey.values()]
      .sort((a, b) => a.order - b.order)
      .map((v, i) => {
        const r = finalize(v.edges, v.objective, `route-${i + 1}`);
        r.labels = v.labels;
        return r;
      });
    return withSkiNote(routes);
  }

  if (routeType === 'longest') {
    const chains = longestDownhillPaths(index, fromNodeId, toNodeId, maxRank, 3);
    if (chains.length === 0) {
      // Only when B can't be reached lift-free do we allow a lift.
      const withLift = best('fewest_lifts');
      if (!withLift) return noRouteResult(closedEdgeIds);
      const r = finalize(withLift, 'longest_ab', 'route-1');
      r.labels = ['Longest (needs a lift)'];
      return { routes: [r] };
    }
    const routes = chains.map((edges, i) => {
      const r = finalize(edges, 'longest_ab', `route-${i + 1}`);
      r.labels = [OBJECTIVE_LABEL.longest_ab];
      return r;
    });
    return { routes };
  }

  // Individual fastest / fewest_lifts / preferred: up to 3 distinct routes of that objective.
  const objective: RouteObjective = routeType;
  const paths = alternativeRoutes(index, fromNodeId, toNodeId, prefs, provisionalStart, 3, 0.7, closedEdgeIds, objective);
  if (paths.length === 0) return noRouteResult(closedEdgeIds);
  const routes = paths
    .map((edges, i) => {
      const r = finalize(edges, objective, `route-${i + 1}`);
      r.labels = [OBJECTIVE_LABEL[objective]];
      return r;
    })
    .sort((a, b) => rankRoute(a, prefs) - rankRoute(b, prefs));
  return withSkiNote(routes);
}

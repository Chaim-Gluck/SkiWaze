import type { GraphEdge, MeaningfulPoint, Preferences, Route, RouteRequest, ResortGraph, PisteColor, RouteObjective, RouteLabel, TextRef } from '../types/domain';
import { PISTE_COLOR_ORDER } from '../types/domain';
import { GraphIndex } from './graphIndex';
import { alternativeRoutes } from './alternatives';
import { longestDownhillRuns, longestDownhillPaths, longestDownhillPath } from './longestStreak';
import { buildRoute } from './buildRoute';
import { resolveClosedEdgeIds } from './closures';
import { makeRouteComparator, pisteMetres, skiingTolerance } from './ranking';
import { haversineM } from '../utils/geo';

export interface PlanResult {
  routes: Route[];
  /** Present when no route could be found. A catalogue key, not a sentence — see TextRef. */
  error?: TextRef;
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
  // Same gate as the A→B longest search: this walks the graph directly, so without it the card
  // advertises unpatrolled freeride terrain to a skier who never opted into it.
  const chains = longestDownhillRuns(
    index,
    colorRank(prefs.maxDifficulty),
    k,
    (e) => (prefs.allowOffPiste || !e.offPiste) && !(prefs.avoidSyntheticBridges && e.synthetic && !e.custom),
    prefs.allowPoling,
  );
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

/**
 * A route's badge is its objective KEY. There is deliberately no English here: `reconcileLabels`
 * below compares badges, so a display string would make this routing logic that breaks when the UI
 * is translated. Words are attached in `utils/routeLabels.ts`.
 */
/**
 * True when the skier actually restricts preferred colors (so a "preferred" route can differ).
 */
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
      ? { key: 'plan.error.noneClosures' }
      : { key: 'plan.error.nonePrefs' },
  };
}

/**
 * Last-step guarantee that a badge never contradicts the number printed beside it.
 *
 * Badges are assigned per objective from a candidate *pool*, but the final card list is not that
 * pool: the "Alternative" fallback is drawn from a wider set and appended afterwards, so a route
 * the fastest comparator never saw can end up on screen showing fewer minutes than the card badged
 * "Fastest". That is what Mount Hermon showed the user — 8 min badged Fastest above a 7 min
 * sibling. Rather than widen the pool (which would change which routes are offered), the label is
 * moved to whichever shown card actually wins on the badge's own metric.
 *
 * Comparison is at DISPLAY resolution — whole minutes, 0.1 km — because a margin the user cannot
 * see is not a contradiction, and re-badging on it would just make the ordering look random.
 */
function reconcileLabels(routes: Route[]): void {
  const move = (label: RouteLabel, better: (a: Route, b: Route) => boolean) => {
    const holder = routes.find((r) => r.labels?.includes(label));
    if (!holder) return;
    let winner = holder;
    for (const r of routes) if (r !== holder && better(r, winner)) winner = r;
    if (winner === holder) return;
    holder.labels = (holder.labels ?? []).filter((l) => l !== label);
    if (holder.labels.length === 0) holder.labels = ['alternative'];
    winner.labels = [label, ...(winner.labels ?? []).filter((l) => l !== label && l !== 'alternative')];
  };
  const mins = (r: Route) => Math.round(r.stats.totalDurationS / 60);
  const skiHm = (r: Route) => Math.round(pisteMetres(r) / 100);
  move('fastest', (a, b) => mins(a) < mins(b));
  move('fewest_lifts', (a, b) => a.stats.liftCount < b.stats.liftCount);
  move('longest_ab', (a, b) => skiHm(a) > skiHm(b));
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

  if (!index.node(fromNodeId)) return { routes: [], error: { key: 'plan.error.noStart' } };
  if (!index.node(toNodeId)) return { routes: [], error: { key: 'plan.error.noDest' } };

  const now = new Date();
  const target = timing.mode === 'arrive_by' && timing.time ? new Date(timing.time) : null;
  const provisionalStart = target ?? now;

  // Build a Route from an edge list, setting absolute start so it arrives by `target` or now.
  const finalize = (edges: GraphEdge[], objective: RouteObjective, id: string): Route => {
    if (target) {
      const probe = buildRoute(index, edges, prefs, target, objective, id);
      const start = new Date(target.getTime() - probe.stats.totalDurationS * 1000);
      const route = buildRoute(index, edges, prefs, start, objective, id);
      route.stats.timingMode = 'arrive_by';
      return route;
    }
    return buildRoute(index, edges, prefs, now, objective, id);
  };

  const maxRank = colorRank(prefs.maxDifficulty);
  const routeType = prefs.routeType ?? 'balanced';

  /**
   * The gate the longest-descent search must respect, on top of its own colour-rank test.
   *
   * `longestDownhillPaths` walks the graph directly rather than through `edgeCost`, so without
   * this it was the only search in the app that ignored closures, the avoid-bridges preference and
   * — worst — the off-piste opt-out, returning routes over unpatrolled freeride terrain that
   * `buildRoute` then priced at 0 s because `edgeCost` refuses them.
   */
  const allowForLongest = (e: GraphEdge): boolean => {
    if (closedEdgeIds.has(e.id)) return false;
    if (!prefs.allowOffPiste && e.offPiste) return false;
    if (prefs.avoidSyntheticBridges && e.synthetic && !e.custom) return false;
    return true;
  };

  /**
   * Re-solve every lift-free stretch of a route for maximum descent, keeping its lifts as they are.
   *
   * When B is only reachable by lift, "longest" still has a meaning on each side of that lift: ski
   * the longest line down to the station, ride up, then ski the longest line to B. The lift chain
   * itself is taken as given (from the fewest-lifts search) — searching over lift chains as well
   * would be a different, much larger problem, and the point here is that no stretch of the route
   * is silently left as the *short* way down.
   *
   * A stretch is only replaced when it genuinely skis further, so this can never make a route worse.
   */
  const maximiseBetweenLifts = (edges: GraphEdge[]): GraphEdge[] => {
    const pisteM = (es: GraphEdge[]): number =>
      es.reduce((m, e) => (e.kind === 'piste' ? m + e.lengthM : m), 0);

    const out: GraphEdge[] = [];
    let segment: GraphEdge[] = [];
    const flushSegment = () => {
      if (segment.length === 0) return;
      const from = segment[0].from;
      const to = segment[segment.length - 1].to;
      const better = longestDownhillPath(index, from, to, maxRank, undefined, allowForLongest);
      out.push(...(better.length && pisteM(better) > pisteM(segment) ? better : segment));
      segment = [];
    };

    for (const e of edges) {
      if (e.kind === 'lift') {
        flushSegment();
        out.push(e);
      } else {
        segment.push(e);
      }
    }
    flushSegment();
    return out;
  };

  const withSkiNote = (routes: Route[]): PlanResult => {    const ski = nearestSkiDestination(graph, index, fromNodeId, toNodeId, prefs, closedEdgeIds);
    if (!ski.skiable) return { routes, noLiftFreeRoute: true, nearestSkiDestination: ski.suggestion };
    return { routes };
  };

  // Finalize a set of edge-paths into deduped Route objects.
  const toRoutes = (paths: GraphEdge[][], objective: RouteObjective): Route[] => {
    const seen = new Set<string>();
    const out: Route[] = [];
    for (const edges of paths) {
      if (edges.length === 0) continue;
      const key = pathKey(edges);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(finalize(edges, objective, `c${out.length}`));
    }
    return out;
  };
  /**
   * Identity of a route as a *skier* experiences it: the ordered sequence of named pistes and
   * lifts it uses. Connectors are ignored on purpose — two options that differ only in which
   * app-added bridge or gap-fill they cross are not a choice anyone can act on, so they must
   * collapse to one option. Consecutive legs of the same named run collapse too, since a run
   * split into several graph edges is still one run.
   */
  const terrainKey = (r: Route): string => {
    const parts: string[] = [];
    for (const leg of r.legs) {
      if (leg.kind === 'connector') continue;
      const e = index.edgeById.get(leg.edgeId);
      const name =
        leg.kind === 'lift'
          ? e?.liftName
          : e?.pisteRef || e?.pisteName
            ? `${e?.pisteRef ?? ''}~${e?.pisteName ?? ''}`
            : undefined;
      // Unnamed terrain has no shareable identity, so fall back to the edge — distinct by design.
      const token = `${leg.kind}:${name ?? leg.edgeId}`;
      if (parts[parts.length - 1] !== token) parts.push(token);
    }
    return parts.join('>');
  };
  /** Keep only routes a skier would call different: first one wins per terrain signature. */
  const distinctTerrain = (routes: Route[]): Route[] => {
    const seen = new Set<string>();
    return routes.filter((r) => {
      const k = terrainKey(r);
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  };

  const genAlts = (objective: RouteObjective, k: number): GraphEdge[][] =>
    alternativeRoutes(index, fromNodeId, toNodeId, prefs, provisionalStart, k, 0.7, closedEdgeIds, objective);

  // Longest is a special lift-free DAG search — handle it on its own.
  if (routeType === 'longest') {
    const longRoutes = toRoutes(longestDownhillPaths(index, fromNodeId, toNodeId, maxRank, 3, 0.7, allowForLongest, prefs.allowPoling), 'longest_ab');
    if (longRoutes.length === 0) {
      // B can't be reached lift-free, so a lift is unavoidable. Take the fewest-lifts chain and
      // then maximise the descent on each side of every lift it rides — "longest" should still mean
      // the longest skiing available, not whatever line the fewest-lifts search happened to pick.
      const withLift = genAlts('fewest_lifts', 1)[0];
      if (!withLift) return noRouteResult(closedEdgeIds);
      const r = finalize(maximiseBetweenLifts(withLift), 'longest_ab', 'route-1');
      // Just "Longest" — the card already shows a lift icon and count, so spelling out "(needs a
      // lift)" in the badge only repeats what is printed right below it.
      r.labels = ['longest_ab'];
      return { routes: [r] };
    }
    const routes = distinctTerrain(longRoutes.sort(makeRouteComparator('longest_ab', prefs)))
      .slice(0, 3)
      .map((r, i) => { r.id = `route-${i + 1}`; r.labels = ['longest_ab']; return r; });
    return { routes };
  }

  // One shared candidate pool for fastest / fewest_lifts / preferred (used by Balanced too), so
  // ranking is consistent across modes. It covers each objective's optimum plus preference
  // variants, letting the tolerance tie-break surface a "just-as-good but nicer" route.
  const pool = toRoutes(
    [...genAlts('fastest', 3), ...genAlts('fewest_lifts', 2), ...(hasColorPreference(prefs) ? genAlts('preferred', 3) : [])],
    'fastest',
  );
  if (pool.length === 0) return noRouteResult(closedEdgeIds);
  const bestOf = (routes: Route[], objective: RouteObjective): Route | undefined =>
    routes.slice().sort(makeRouteComparator(objective, prefs))[0];

  if (routeType === 'balanced') {
    const longRoutes = toRoutes(longestDownhillPaths(index, fromNodeId, toNodeId, maxRank, 3, 0.7, allowForLongest, prefs.allowPoling), 'longest_ab');
    const byKey = new Map<string, { route: Route; objective: RouteObjective; labels: RouteLabel[]; order: number }>();
    const consider = (route: Route | undefined, objective: RouteObjective, order: number) => {
      if (!route) return;
      const key = terrainKey(route);
      const existing = byKey.get(key);
      if (existing) {
        if (!existing.labels.includes(objective)) existing.labels.push(objective);
      } else {
        byKey.set(key, { route, objective, labels: [objective], order });
      }
    };

    consider(bestOf(pool, 'fastest'), 'fastest', 0);
    consider(bestOf(pool, 'fewest_lifts'), 'fewest_lifts', 1);
    if (hasColorPreference(prefs)) consider(bestOf(pool, 'preferred'), 'preferred', 2);
    // A "Longest" option only means something when it actually buys measurably more skiing than
    // the others. Without this gate a 40 m hop with no real descent anywhere still got badged
    // "Longest", which is noise dressed up as a choice.
    const longBest = bestOf(longRoutes, 'longest_ab');
    if (longBest) {
      const longSki = pisteMetres(longBest);
      const poolSki = pool.reduce((m, r) => Math.max(m, pisteMetres(r)), 0);
      if (longSki - poolSki > skiingTolerance(longSki, poolSki)) consider(longBest, 'longest_ab', 3);
    }

    if (byKey.size === 0) return noRouteResult(closedEdgeIds);
    const routes = [...byKey.values()]
      .sort((a, b) => a.order - b.order)
      .map((v) => {
        v.route.objective = v.objective;
        v.route.labels = v.labels;
        return v.route;
      });
    // When every objective collapses to the same route, Balanced would show a single card — offer
    // the next-best distinct route (from the pool or a longest variant) as an alternative so the
    // user still gets a choice.
    if (routes.length < 2) {
      const shown = new Set(routes.map(terrainKey));
      const alt = [...pool, ...longRoutes]
        .slice()
        .sort(makeRouteComparator('fastest', prefs))
        .find((r) => !shown.has(terrainKey(r)));
      if (alt) {
        alt.objective = 'fastest';
        alt.labels = ['alternative'];
        routes.push(alt);
      }
    }
    reconcileLabels(routes);
    routes.forEach((r, i) => { r.id = `route-${i + 1}`; });
    return withSkiNote(routes);
  }

  // Individual fastest / fewest_lifts / preferred: rank the shared pool, take up to 3 distinct.
  const objective: RouteObjective = routeType;
  const routes = distinctTerrain(pool.slice().sort(makeRouteComparator(objective, prefs)))
    .slice(0, 3)
    .map((r, i) => { r.id = `route-${i + 1}`; r.objective = objective; r.labels = [objective]; return r; });
  return withSkiNote(routes);
}

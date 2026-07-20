import type {
  GraphEdge,
  Preferences,
  Route,
  RouteLeg,
  RouteObjective,
  RouteStats,
  RouteWarning,
} from '../types/domain';
import type { GraphIndex } from './graphIndex';
import { edgeCost } from './cost';

function pisteLabel(edge: GraphEdge): string {
  const ref = edge.pisteRef;
  const name = edge.pisteName;
  if (ref && name) return `${ref} \u00b7 ${name}`;
  if (ref) return `piste ${ref}`;
  if (name) return `"${name}"`;
  return 'run';
}

function legDescription(edge: GraphEdge, index: GraphIndex): string {
  const dist = Math.round(edge.lengthM);
  if (edge.kind === 'piste') {
    return `Ski ${pisteLabel(edge)} (${edge.color ?? 'unknown'}) \u2013 ${dist} m`;
  }
  if (edge.kind === 'lift') {
    const name = edge.liftName ? `"${edge.liftName}"` : 'lift';
    const dir = edge.isDownload ? 'down' : 'up';
    return `Take ${name} (${(edge.liftType ?? 'lift').replace('_', ' ')}) ${dir} \u2013 ${dist} m`;
  }
  const toName = index.node(edge.to)?.name;
  if (edge.connectorKind === 'flat_traverse') {
    if (edge.pisteName || edge.pisteRef) {
      return `Traverse ${pisteLabel(edge)} \u2013 ${dist} m`;
    }
    return `Traverse flat section \u2013 ${dist} m${toName ? ` to ${toName}` : ''}`;
  }
  return `Ski connector \u2013 ${dist} m`;
}

/**
 * Turn an ordered edge list into a full Route: per-leg timing/warnings, aggregate
 * stats (distance, descent/ascent, lifts, color breakdown, longest lift-free streak),
 * and absolute start/arrival times.
 */
export function buildRoute(
  index: GraphIndex,
  edges: GraphEdge[],
  prefs: Preferences,
  startDate: Date,
  objective: RouteObjective,
  id: string,
): Route {
  const legs: RouteLeg[] = [];
  const routeWarnings: RouteWarning[] = [];
  let elapsed = 0;
  let totalDistance = 0;
  let descent = 0;
  let ascent = 0;
  let liftCount = 0;
  const liftTypes = new Set<GraphEdge['liftType']>();
  const colorBreakdownM: RouteStats['colorBreakdownM'] = {};

  let currentStreak = 0;
  let longestStreak = 0;

  for (const edge of edges) {
    const arrival = new Date(startDate.getTime() + elapsed * 1000);
    const cost = edgeCost(edge, prefs, arrival);
    legs.push({
      edgeId: edge.id,
      kind: edge.kind,
      fromNodeId: edge.from,
      toNodeId: edge.to,
      description: legDescription(edge, index),
      distanceM: cost.distanceM,
      durationS: cost.seconds,
      color: edge.color,
      liftType: edge.liftType,
      isDownload: edge.isDownload,
      synthetic: edge.synthetic,
      custom: edge.custom,
      warnings: cost.warnings,
    });
    for (const w of cost.warnings) routeWarnings.push(w);
    if (edge.custom) {
      routeWarnings.push({
        code: 'custom_edge',
        message: 'This route uses one of your custom links (dotted cyan on the map).',
      });
    } else if (edge.synthetic) {
      routeWarnings.push({
        code: 'questionable_edge',
        message: 'This route uses an app-added bridge across a mapped gap (dotted magenta) that may not be exactly skiable.',
      });
    }

    elapsed += cost.seconds;
    totalDistance += cost.distanceM;
    descent += cost.descentM;
    ascent += cost.ascentM;

    if (edge.kind === 'lift') {
      liftCount += 1;
      liftTypes.add(edge.liftType);
      currentStreak = 0; // any lift ride (up or download) breaks a skiable streak
    } else {
      // pistes and connectors count toward continuous skiing
      currentStreak += cost.distanceM;
      if (currentStreak > longestStreak) longestStreak = currentStreak;
    }

    if (edge.color) {
      colorBreakdownM[edge.color] = (colorBreakdownM[edge.color] ?? 0) + cost.distanceM;
    }
  }

  const arriveDate = new Date(startDate.getTime() + elapsed * 1000);
  const stats: RouteStats = {
    totalDistanceM: Math.round(totalDistance),
    totalDurationS: Math.round(elapsed),
    descentM: Math.round(descent),
    ascentM: Math.round(ascent),
    liftCount,
    liftTypes: [...liftTypes].filter((t): t is NonNullable<typeof t> => t != null),
    colorBreakdownM,
    longestDownhillStreakM: Math.round(longestStreak),
    startTime: startDate.toISOString(),
    arriveTime: arriveDate.toISOString(),
  };

  // Deduplicate warnings by code+message.
  const seen = new Set<string>();
  const warnings = routeWarnings.filter((w) => {
    const k = `${w.code}:${w.message}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  return { id, objective, legs, stats, warnings };
}

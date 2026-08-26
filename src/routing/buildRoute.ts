import type {
  GraphEdge,
  Preferences,
  Route,
  RouteLeg,
  RouteObjective,
  RouteStats,
  RouteWarning,
  DisplayStep,
} from '../types/domain';
import type { GraphIndex } from './graphIndex';
import { edgeCost } from './cost';
import { liftClosureKey, pisteClosureKey } from './closures';

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
      plumbing: edge.skeletonArm || edge.spineDuplicate,
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

  return { id, objective, legs, steps: groupSteps(edges, legs), stats, warnings };
}

const SHORT_CONNECTOR_M = 40;

function stepKeyForEdge(e: GraphEdge): string {
  if (e.kind === 'piste') return `piste|${e.pisteRef ?? e.pisteName ?? ''}|${e.color ?? ''}`;
  if (e.kind === 'lift') return `lift|${e.liftName ?? ''}|${e.isDownload ? 'd' : 'u'}`;
  return 'conn';
}

function stepLabelForEdge(e: GraphEdge): string {
  if (e.kind === 'piste') return `Ski ${pisteLabel(e)} (${e.color ?? 'unknown'})`;
  if (e.kind === 'lift') {
    const name = e.liftName ? `"${e.liftName}"` : 'lift';
    return `Take ${name} (${(e.liftType ?? 'lift').replace('_', ' ')}) ${e.isDownload ? 'down' : 'up'}`;
  }
  return 'Traverse';
}

function closureForEdge(e: GraphEdge): { key: string | null; label: string | null } {
  if (e.kind === 'lift') {
    const key = liftClosureKey(e);
    if (key) return { key, label: `Lift: ${e.liftName}` };
  }
  if (e.kind === 'piste') {
    const key = pisteClosureKey(e);
    if (key) return { key, label: `Run: ${pisteLabel(e)}` };
  }
  return { key: null, label: null };
}

/**
 * Consolidate consecutive legs into readable steps: merge same-run / same-lift legs, and
 * absorb short (<40 m) connectors into the current step. Display-only; leg indices are
 * preserved via [fromLeg, toLeg] so a step can still highlight its edges on the map.
 */
function groupSteps(edges: GraphEdge[], legs: RouteLeg[]): DisplayStep[] {
  const steps: DisplayStep[] = [];
  let cur: DisplayStep | null = null;
  let curKey = '';

  edges.forEach((e, i) => {
    const shortConnector = e.kind === 'connector' && e.lengthM < SHORT_CONNECTOR_M;
    const key = stepKeyForEdge(e);
    if (cur && (shortConnector || key === curKey)) {
      cur.distanceM += legs[i].distanceM;
      cur.durationS += legs[i].durationS;
      cur.toLeg = i;
      cur.synthetic = cur.synthetic || !!e.synthetic;
      cur.custom = cur.custom || !!e.custom;
    } else {
      const cl = closureForEdge(e);
      cur = {
        kind: e.kind,
        label: stepLabelForEdge(e),
        distanceM: legs[i].distanceM,
        durationS: legs[i].durationS,
        color: e.color,
        ref: e.pisteRef,
        isDownload: e.isDownload,
        synthetic: !!e.synthetic,
        custom: !!e.custom,
        fromLeg: i,
        toLeg: i,
        closureKey: cl.key,
        closureLabel: cl.label,
      };
      steps.push(cur);
      curKey = key;
    }
  });

  return steps;
}

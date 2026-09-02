import type {
  GraphEdge,
  Preferences,
  Route,
  RouteLeg,
  RouteObjective,
  RouteStats,
  RouteWarning,
  DisplayStep,
  TextRef,
} from '../types/domain';
import type { GraphIndex } from './graphIndex';
import { edgeCost } from './cost';
import { liftClosureKey, pisteClosureKey } from './closures';
import { bidiName } from '../utils/format';

/**
 * How a run is named in prose: "12 · Ruggenhof", "piste 12", "\"Ruggenhof\"", or just "run".
 * The run's own name is never translated (it has to match the signage on the mountain);
 * only the wrapper words around it are.
 */
function pisteLabel(edge: GraphEdge): TextRef {
  // Isolated, because a Latin run name dropped into a Hebrew sentence otherwise has its brackets
  // mirrored by the bidi algorithm.
  const ref = bidiName(edge.pisteRef);
  const name = bidiName(edge.pisteName);
  if (ref && name) return { key: 'step.piste.refName', params: { ref, name } };
  if (ref) return { key: 'step.piste.ref', params: { ref } };
  if (name) return { key: 'step.piste.name', params: { name } };
  return { key: 'step.piste.any' };
}

function liftLabel(edge: GraphEdge): TextRef {
  return edge.liftName ? { key: 'step.lift.name', params: { name: bidiName(edge.liftName) } } : { key: 'step.lift.any' };
}

/** Lift type as a word ("chair lift"), falling back to a generic "lift" when untagged. */
function liftTypeLabel(edge: GraphEdge): TextRef {
  return edge.liftType ? { key: `liftType.${edge.liftType}` } : { key: 'step.lift.any' };
}

function legDescription(edge: GraphEdge, index: GraphIndex): TextRef {
  const dist = Math.round(edge.lengthM);
  if (edge.kind === 'piste') {
    return {
      key: 'leg.ski',
      params: { piste: pisteLabel(edge), color: { key: `color.${edge.color ?? 'unknown'}` }, dist },
    };
  }
  if (edge.kind === 'lift') {
    return {
      key: edge.isDownload ? 'leg.liftDown' : 'leg.liftUp',
      params: { name: liftLabel(edge), liftType: liftTypeLabel(edge), dist },
    };
  }
  const toName = bidiName(index.node(edge.to)?.name);
  if (edge.connectorKind === 'flat_traverse') {
    if (edge.pisteName || edge.pisteRef) {
      return { key: 'leg.traverseNamed', params: { piste: pisteLabel(edge), dist } };
    }
    return toName
      ? { key: 'leg.traverseFlatTo', params: { dist, to: toName } }
      : { key: 'leg.traverseFlat', params: { dist } };
  }
  return { key: 'leg.connector', params: { dist } };
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
        message: { key: 'warn.customEdge' },
      });
    } else if (edge.synthetic) {
      routeWarnings.push({
        code: 'questionable_edge',
        message: { key: 'warn.syntheticEdge' },
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

  // Deduplicate warnings by code + resolved text (key and params).
  const seen = new Set<string>();
  let warnings = routeWarnings.filter((w) => {
    const k = `${w.code}:${w.message.key}:${JSON.stringify(w.message.params ?? {})}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  // Naming each lift whose hours we don't know is only useful as a CONTRAST — "these are the ones
  // we can't vouch for". When we know the hours of none of them there is no contrast to draw, just
  // the same sentence N times, and since the card shows at most four warnings those copies push out
  // the ones that matter (a lift closing soon, a synthetic bridge). So say it once.
  const liftEdges = edges.filter((e) => e.kind === 'lift');
  if (liftEdges.length > 1 && liftEdges.every((e) => !e.openingHours)) {
    let kept = false;
    warnings = warnings.flatMap((w) => {
      if (w.code !== 'missing_opening_hours') return [w];
      if (kept) return [];
      kept = true;
      return [{ code: w.code, message: { key: 'warn.hoursAll' } }];
    });
  }

  return { id, objective, legs, steps: groupSteps(edges, legs), stats, warnings };
}

const SHORT_CONNECTOR_M = 40;

function stepKeyForEdge(e: GraphEdge): string {
  if (e.kind === 'piste') return `piste|${e.pisteRef ?? e.pisteName ?? ''}|${e.color ?? ''}`;
  if (e.kind === 'lift') return `lift|${e.liftName ?? ''}|${e.isDownload ? 'd' : 'u'}`;
  return 'conn';
}

function stepLabelForEdge(e: GraphEdge): { label: TextRef; short: TextRef } {
  if (e.kind === 'piste') {
    const piste = pisteLabel(e);
    return {
      label: { key: 'step.ski', params: { piste, color: { key: `color.${e.color ?? 'unknown'}` } } },
      short: { key: 'step.skiShort', params: { piste } },
    };
  }
  if (e.kind === 'lift') {
    const params = { name: liftLabel(e), liftType: liftTypeLabel(e) };
    const key = e.isDownload ? 'step.liftDown' : 'step.liftUp';
    return { label: { key, params }, short: { key, params } };
  }
  return { label: { key: 'step.traverse' }, short: { key: 'step.traverse' } };
}

function closureForEdge(e: GraphEdge): { key: string | null; label: TextRef | null } {
  if (e.kind === 'lift') {
    const key = liftClosureKey(e);
    if (key) return { key, label: { key: 'closure.lift', params: { name: bidiName(e.liftName ?? '') } } };
  }
  if (e.kind === 'piste') {
    const key = pisteClosureKey(e);
    if (key) return { key, label: { key: 'closure.run', params: { piste: pisteLabel(e) } } };
  }
  return { key: null, label: null };
}

const pisteId = (e: GraphEdge): string => e.pisteRef ?? e.pisteName ?? '';

/**
 * Is this piste edge the same descent as the step we are already writing, only missing its name?
 *
 * OSM names a run way by way, so one continuous descent routinely arrives as
 * `<unnamed> | 60 Menuires | <unnamed>` and used to print as three steps of ~60 m each. It is the
 * same snow at the same grade, so we merge and adopt whichever name exists. The colour must match:
 * that is the safety-bearing half of the label, and an unnamed edge of a *different* colour is a
 * different run whatever OSM forgot to tag.
 */
function sameRunMissingName(cur: DisplayStep, curKey: string, e: GraphEdge): boolean {
  if (cur.kind !== 'piste' || e.kind !== 'piste') return false;
  if ((cur.color ?? '') !== (e.color ?? '')) return false;
  const curNamed = curKey.split('|')[1] !== '';
  const eNamed = pisteId(e) !== '';
  return curNamed !== eNamed;
}

/**
 * A traverse that leaves a run and rejoins the *same* run is not a move the skier has to make a
 * decision about — they simply keep going — so it is absorbed instead of splitting the run in
 * three. Only the same run counts: a traverse between two *different* runs is often the only link
 * between them and must stay visible.
 */
function bridgesSameRun(edges: GraphEdge[], i: number, cur: DisplayStep, curKey: string): boolean {
  if (edges[i].kind !== 'connector' || cur.kind !== 'piste') return false;
  let j = i;
  while (j < edges.length && edges[j].kind === 'connector') j++;
  const next = edges[j];
  if (!next || next.kind !== 'piste') return false;
  return stepKeyForEdge(next) === curKey || sameRunMissingName(cur, curKey, next);
}

/**
 * Consolidate consecutive legs into readable steps: merge same-run / same-lift legs, absorb short
 * (<40 m) connectors into the current step, and apply the two merges above. Display-only; leg
 * indices are preserved via [fromLeg, toLeg] so a step can still highlight all its edges on the map.
 */
function groupSteps(edges: GraphEdge[], legs: RouteLeg[]): DisplayStep[] {
  const steps: DisplayStep[] = [];
  let cur: DisplayStep | null = null;
  let curKey = '';

  edges.forEach((e, i) => {
    const shortConnector = e.kind === 'connector' && e.lengthM < SHORT_CONNECTOR_M;
    const key = stepKeyForEdge(e);
    const adoptName = !!cur && sameRunMissingName(cur, curKey, e) && pisteId(e) !== '';
    const merge =
      !!cur &&
      (shortConnector ||
        key === curKey ||
        sameRunMissingName(cur, curKey, e) ||
        bridgesSameRun(edges, i, cur, curKey));
    if (cur && merge) {
      cur.distanceM += legs[i].distanceM;
      cur.durationS += legs[i].durationS;
      cur.toLeg = i;
      cur.synthetic = cur.synthetic || !!e.synthetic;
      cur.custom = cur.custom || !!e.custom;
      if (adoptName) {
        const lab = stepLabelForEdge(e);
        const cl = closureForEdge(e);
        cur.label = lab.label;
        cur.labelShort = lab.short;
        cur.name = bidiName(e.pisteName);
        cur.ref = bidiName(e.pisteRef);
        cur.closureKey = cl.key;
        cur.closureLabel = cl.label;
        curKey = key;
      }
    } else {
      const cl = closureForEdge(e);
      const lab = stepLabelForEdge(e);
      cur = {
        kind: e.kind,
        label: lab.label,
        labelShort: lab.short,
        name: bidiName(e.kind === 'lift' ? e.liftName : e.pisteName),
        distanceM: legs[i].distanceM,
        durationS: legs[i].durationS,
        color: e.color,
        ref: bidiName(e.pisteRef),
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

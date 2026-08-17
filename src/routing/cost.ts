import type { GraphEdge, Preferences, PisteColor, RouteWarning, RouteObjective } from '../types/domain';
import { PISTE_COLOR_ORDER } from '../types/domain';
import { SKILL_SPEED_MULTIPLIER } from '../config/defaults';
import { parseDailyWindows, isOpenAt, minutesUntilClose } from './openingHours';

/** Minutes-before-close under which we warn the user to hurry. */
export const CLOSING_SOON_MIN = 20;

/** Penalty multiplier applied to pistes whose color is not in the user's preferred set. */
const NON_PREFERRED_PENALTY = 1.6;

/** Penalty multiplier so routing prefers real terrain over auto-added / custom links. */
const SYNTHETIC_PENALTY = 2.5;

/**
 * Lexicographic penalties for single-objective planning. They dwarf any realistic time cost so
 * the objective's primary key (lift count / non-preferred distance) is minimised first, then
 * time acts as the tie-breaker. Only applied for the matching `objective`.
 */
const FEWEST_LIFTS_PENALTY = 1e6; // per lift boarded
const PREFERRED_OFF_COLOR_PENALTY = 1e4; // per metre skied on a non-preferred colour

export interface EdgeCost {
  allowed: boolean;
  seconds: number;
  distanceM: number;
  descentM: number;
  ascentM: number;
  /** Cost used for optimization (may include preference penalties). */
  weight: number;
  warnings: RouteWarning[];
}

function colorRank(c: PisteColor | undefined): number {
  if (!c || c === 'unknown') return PISTE_COLOR_ORDER.length; // unknown treated as hardest-unknown
  return PISTE_COLOR_ORDER.indexOf(c);
}

function skiSpeedFor(color: PisteColor | undefined, prefs: Preferences): { speed: number; usedDefault: boolean } {
  // All skiing speeds scale with the skier's self-rated pace (lifts are unaffected).
  const mult = SKILL_SPEED_MULTIPLIER[prefs.skillLevel] ?? 1;
  if (color && color !== 'unknown') {
    return { speed: prefs.speeds.skiSpeedByColor[color] * mult, usedDefault: false };
  }
  return { speed: prefs.speeds.fallbackSkiSpeed * mult, usedDefault: true };
}

/**
 * Compute the traversal cost of an edge, honoring the user's max difficulty,
 * preferred colors, allowed lift types, and lift opening hours at `arrival`.
 */
export function edgeCost(edge: GraphEdge, prefs: Preferences, arrival: Date, objective: RouteObjective = 'fastest'): EdgeCost {
  const warnings: RouteWarning[] = [];
  const distanceM = edge.lengthM;
  const descentM = edge.dropM < 0 ? -edge.dropM : 0;
  const ascentM = edge.dropM > 0 ? edge.dropM : 0;

  // Optionally refuse app-added bridges (user's own custom links stay allowed).
  if (prefs.avoidSyntheticBridges && edge.synthetic && !edge.custom) {
    return { allowed: false, seconds: 0, distanceM, descentM, ascentM, weight: Infinity, warnings };
  }

  if (edge.kind === 'piste') {
    // Difficulty filter.
    if (colorRank(edge.color) > colorRank(prefs.maxDifficulty)) {
      return { allowed: false, seconds: 0, distanceM, descentM, ascentM, weight: Infinity, warnings };
    }
    const { speed, usedDefault } = skiSpeedFor(edge.color, prefs);
    const seconds = distanceM / speed;
    let weight = seconds;
    if (edge.color && edge.color !== 'unknown' && !prefs.preferredColors.includes(edge.color)) {
      weight *= NON_PREFERRED_PENALTY;
      // In "My preferred runs" mode, minimise non-preferred distance first (then time).
      if (objective === 'preferred') weight += PREFERRED_OFF_COLOR_PENALTY * distanceM;
      warnings.push({
        code: 'above_preferred_color',
        message: `${edge.pisteName ?? 'Run'} is ${edge.color}, outside your preferred colors.`,
      });
    }
    if (usedDefault) {
      warnings.push({ code: 'using_default_speed', message: 'Using a default ski speed (piste color unknown).' });
    }
    return { allowed: true, seconds, distanceM, descentM, ascentM, weight, warnings };
  }

  if (edge.kind === 'lift') {
    if (edge.liftType && !prefs.allowedLiftTypes.includes(edge.liftType)) {
      return { allowed: false, seconds: 0, distanceM, descentM, ascentM, weight: Infinity, warnings };
    }
    const windows = parseDailyWindows(edge.openingHours);
    if (edge.openingHours && !isOpenAt(windows, arrival)) {
      return { allowed: false, seconds: 0, distanceM, descentM, ascentM, weight: Infinity, warnings };
    }
    if (!edge.openingHours) {
      warnings.push({ code: 'missing_opening_hours', message: `Opening hours unknown for ${edge.liftName ?? 'this lift'}.` });
    } else {
      const untilClose = minutesUntilClose(windows, arrival);
      if (untilClose != null && untilClose <= CLOSING_SOON_MIN) {
        warnings.push({
          code: 'lift_closing_soon',
          message: `${edge.liftName ?? 'Lift'} closes in ~${Math.round(untilClose)} min \u2014 hurry!`,
        });
      }
    }
    const speed = edge.liftType
      ? prefs.speeds.liftSpeedByType[edge.liftType] ?? prefs.speeds.fallbackLiftSpeed
      : prefs.speeds.fallbackLiftSpeed;
    const waitCfg = edge.liftType ? prefs.speeds.liftWaitByType[edge.liftType] : undefined;
    const wait = waitCfg ?? prefs.speeds.fallbackLiftWait;
    if (waitCfg == null) {
      warnings.push({ code: 'using_default_wait', message: `Using a default wait time for ${edge.liftName ?? 'this lift'}.` });
    }
    const seconds = distanceM / speed + wait;
    // Prefer-skiing: make riding a lift downhill a last resort, and nudge away from
    // unnecessary up-lifts, so a ski-only route wins whenever one exists.
    let weight = seconds;
    if (prefs.preferSkiing) {
      weight *= edge.isDownload ? 40 : 1.8;
    }
    // In "Fewest lifts" mode, minimise the number of lifts boarded first (then time).
    if (objective === 'fewest_lifts') weight += FEWEST_LIFTS_PENALTY;
    return { allowed: true, seconds, distanceM, descentM, ascentM, weight, warnings };
  }

  // connector
  const penalty = edge.synthetic && !edge.custom ? SYNTHETIC_PENALTY : 1;
  const skiMult = SKILL_SPEED_MULTIPLIER[prefs.skillLevel] ?? 1;
  if (edge.connectorKind === 'flat_traverse') {
    const seconds = distanceM / (prefs.speeds.flatTraverseSpeed * skiMult);
    return { allowed: true, seconds, distanceM, descentM, ascentM, weight: seconds * penalty, warnings };
  }
  // skiable_down connector: treat like an unknown-color short run.
  const seconds = distanceM / (prefs.speeds.fallbackSkiSpeed * skiMult);
  return { allowed: true, seconds, distanceM, descentM, ascentM, weight: seconds * penalty, warnings };
}

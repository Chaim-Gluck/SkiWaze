import type { GraphEdge, Preferences, PisteColor, RouteWarning, RouteObjective } from '../types/domain';
import { PISTE_COLOR_ORDER } from '../types/domain';
import { progressSpeedMps, paceMultiplier, isSpeedColor } from '../config/speedModel';
import { parseDailyWindows, isOpenAt, minutesUntilClose } from './openingHours';
import { DEFAULT_GRAPH_CONSTANTS } from '../config/graphConstants';

/** Minutes-before-close under which we warn the user to hurry. */
export const CLOSING_SOON_MIN = 20;

/** Penalty multiplier so routing prefers real terrain over auto-added / custom links. */
const SYNTHETIC_PENALTY = 2.5;

/**
 * Penalty multiplier for a polygon line that merely retraces the centreline its own polygon adopted
 * as a spine (`spineDuplicate`). Two copies of one run, cross-linked by arms, otherwise let the
 * router hop between them — the visible "broken lines" weave.
 *
 * Kept mild on purpose: a duplicate is genuinely skiable and may be the only thing an arm hangs
 * off, so it must stay usable and simply lose every tie against the real named run underneath it.
 *
 * Deliberately NOT extended to `skeletonArm`. Arms were tried here and reverted: an arm is often the
 * only link through a rim portal, so pricing one makes the router go the long way round instead —
 * measured on Sella Ronda, where options containing a local detour went 9.3% -> 17.1%. Arms are
 * handled where they actually cause trouble, in the longest-run scorer, by earning no distance
 * credit rather than by costing more.
 */
const SPINE_DUPLICATE_PENALTY = 1.5;

/**
 * Arms are priced too, but only just.
 *
 * This was tried once before and reverted on a measurement that turned out to be wrong: the old
 * `_wiggle` probe sampled node pairs by id, so adding or removing nodes silently changed the test
 * set, and it counted `longest_ab` options as detours by construction. It reported arms taking
 * Sella from 9.3% to 17.1% local detours. Re-measured with the corrected probe, a 1.25x charge
 * *improves* every metric on every resort tested — Sella 36.2% -> 34.3% detours (mean 453 m ->
 * 384 m) while plumbing use drops 0.62% -> 0.42% of route metres; Val Thorens 2.19% -> 1.52%
 * plumbing with detours flat (23.3% -> 23.0%); Soelden 1.33% -> 0.74% with detours 19.8% -> 16.0%.
 *
 * Kept at 1.25 rather than higher because an arm is often the only link through a rim portal, and
 * above ~1.5 the router starts going the long way round instead (Val Thorens detours rise to 26.7%
 * at 1.5 and 28.9% at 2). This is enough to lose a tie against the real line beside it, which is
 * all we want: the spine should win whenever it is genuinely an option.
 */
const ARM_PENALTY = 1.25;

function plumbingPenalty(edge: GraphEdge): number {
  if (edge.spineDuplicate) return SPINE_DUPLICATE_PENALTY;
  if (edge.skeletonArm) return ARM_PENALTY;
  return 1;
}

/**
 * Lexicographic penalty used only to *generate* a "preferred" candidate: it dwarfs any realistic
 * time cost so that objective's search minimises non-preferred distance first, then time. Final
 * ranking across all objectives is done purely on real metrics in ranking.ts.
 */
const PREFERRED_OFF_COLOR_PENALTY = 1e4; // per metre skied on a non-preferred colour
const FEWEST_LIFTS_PENALTY = 1e6; // per lift boarded — generates a "fewest lifts" candidate

/**
 * Extra seconds charged per vertical metre gained on a traverse.
 *
 * A connector that rises is never free: on skis you skate, pole or sidestep it, at something
 * like 300 vertical metres an hour. Charging only its horizontal length made short climbs look
 * like flat gliding, which the longest-run search exploited as cheap extra distance.
 */
const CLIMB_SECONDS_PER_M = 12;

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
  // Base PROGRESS speed comes from the model (colour + skill); a per-colour measured override
  // (already converted to a progress speed) wins when present. Lifts are unaffected.
  if (isSpeedColor(color)) {
    const override = prefs.speeds.skiSpeedByColor[color];
    return { speed: override ?? progressSpeedMps(color, prefs.skillLevel), usedDefault: false };
  }
  return { speed: prefs.speeds.fallbackSkiSpeed * paceMultiplier(prefs.skillLevel), usedDefault: true };
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

  // Refuse off-piste/freeride terrain unless the skier has explicitly opted in. This is unmarked,
  // unpatrolled, avalanche-exposed ground that OSM tags `piste:difficulty=freeride|extreme`; we
  // used to import it as an ordinary black run and route over it silently.
  if (!prefs.allowOffPiste && edge.offPiste) {
    return { allowed: false, seconds: 0, distanceM, descentM, ascentM, weight: Infinity, warnings };
  }
  if (edge.offPiste) {
    warnings.push({
      code: 'off_piste',
      message: edge.pisteName
        ? { key: 'warn.offPisteNamed', params: { name: edge.pisteName } }
        : { key: 'warn.offPiste' },
    });
  }

  if (edge.kind === 'piste') {
    // Difficulty filter.
    if (colorRank(edge.color) > colorRank(prefs.maxDifficulty)) {
      return { allowed: false, seconds: 0, distanceM, descentM, ascentM, weight: Infinity, warnings };
    }
    const { speed, usedDefault } = skiSpeedFor(edge.color, prefs);
    // Climbing costs the same on a piste as anywhere else. This used to be charged only on
    // connectors, which let a *rising* piste act as a free lift: arriving 9 m from Deux Lacs
    // (Val Thorens) the direct 9.5 m link climbs 1.1 m and so paid 13 s, while a 45 m dogleg that
    // climbed the same 1.1 m on a piste paid nothing — 18.6 s against 11.1 s, so the route took
    // the dogleg and drew a hairpin on the map right at the destination.
    const seconds = distanceM / speed + ascentM * CLIMB_SECONDS_PER_M;
    let weight = seconds;
    weight *= plumbingPenalty(edge);
    if (edge.color && edge.color !== 'unknown' && !prefs.preferredColors.includes(edge.color)) {
      // Route *selection* handles colour preference lexicographically (see ranking.ts); here we
      // only add the strong term for the `preferred` objective so its candidate search actually
      // finds a preference-minimising path. Other objectives keep pure costs (no colour bias),
      // but still surface the informational warning below.
      if (objective === 'preferred') weight += PREFERRED_OFF_COLOR_PENALTY * distanceM;
      warnings.push({
        code: 'above_preferred_color',
        message: edge.pisteName
          ? { key: 'warn.colorNamed', params: { name: edge.pisteName, color: { key: `color.${edge.color}` } } }
          : { key: 'warn.color', params: { color: { key: `color.${edge.color}` } } },
      });
    }
    if (usedDefault) {
      warnings.push({ code: 'using_default_speed', message: { key: 'warn.defaultSpeed' } });
    }
    return { allowed: true, seconds, distanceM, descentM, ascentM, weight, warnings };
  }

  if (edge.kind === 'lift') {
    // `people_mover` is exempt: it is resort plumbing (an escalator between two parts of the
    // mountain), never offered in the prefs UI, and absent from every persisted `allowedLiftTypes`
    // array — gating it would strand the sector behind it for every returning user.
    if (edge.liftType && edge.liftType !== 'people_mover' && !prefs.allowedLiftTypes.includes(edge.liftType)) {
      return { allowed: false, seconds: 0, distanceM, descentM, ascentM, weight: Infinity, warnings };
    }
    const windows = parseDailyWindows(edge.openingHours);
    if (edge.openingHours && !isOpenAt(windows, arrival)) {
      return { allowed: false, seconds: 0, distanceM, descentM, ascentM, weight: Infinity, warnings };
    }
    if (!edge.openingHours) {
      warnings.push({
        code: 'missing_opening_hours',
        message: edge.liftName
          ? { key: 'warn.hoursNamed', params: { name: edge.liftName } }
          : { key: 'warn.hours' },
      });
    } else {
      const untilClose = minutesUntilClose(windows, arrival);
      if (untilClose != null && untilClose <= CLOSING_SOON_MIN) {
        warnings.push({
          code: 'lift_closing_soon',
          message: edge.liftName
            ? { key: 'warn.closingNamed', params: { name: edge.liftName, min: Math.round(untilClose) } }
            : { key: 'warn.closing', params: { min: Math.round(untilClose) } },
        });
      }
    }
    const speed = edge.liftType
      ? prefs.speeds.liftSpeedByType[edge.liftType] ?? prefs.speeds.fallbackLiftSpeed
      : prefs.speeds.fallbackLiftSpeed;
    const waitCfg = edge.liftType ? prefs.speeds.liftWaitByType[edge.liftType] : undefined;
    const wait = waitCfg ?? prefs.speeds.fallbackLiftWait;
    if (waitCfg == null) {
      warnings.push({
        code: 'using_default_wait',
        message: edge.liftName
          ? { key: 'warn.defaultWaitNamed', params: { name: edge.liftName } }
          : { key: 'warn.defaultWait' },
      });
    }
    // Prefer the operator's published ride time (OSM `aerialway:duration`) over our per-type speed
    // estimate: it is a measured fact and already includes the terminal acceleration/deceleration
    // that a flat line-speed misses. 86% of the chairs and gondolas in our resorts carry it, so the
    // per-type speeds below are really only a fallback for the remaining ~14%.
    const rideSeconds = edge.rideSeconds && edge.rideSeconds > 0 ? edge.rideSeconds : distanceM / speed;
    const seconds = rideSeconds + wait;
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
  const penalty =
    (edge.synthetic && !edge.custom ? SYNTHETIC_PENALTY : 1) * plumbingPenalty(edge);
  const skiMult = paceMultiplier(prefs.skillLevel);
  // A station-access link's vertical is inside the terminal building (stairs, escalator), so it is
  // not a climb on snow and is not charged as one. See `GraphEdge.stationAccess` for why this is
  // gated on the lift having a building at all. The horizontal term still applies, which prices
  // walking through the station at flat-traverse pace.
  const climbSeconds = edge.stationAccess === 'building' ? 0 : ascentM * CLIMB_SECONDS_PER_M;
  // Price a connector by the gradient it actually has, not by the label it was given.
  //
  // The pipeline picks `connectorKind` from *direction* alone (`oneWayDown ? 'skiable_down' :
  // 'flat_traverse'`), so any segment it keeps bidirectional is tagged a flat traverse however
  // steep it is. Flat-traverse pace is 1.875 m/s against 8.75 for skiing, so a mislabel makes a
  // stretch ~4.7x more expensive — and it lands hardest on exactly the lines we most want routes
  // to follow. Val Thorens' Combe de Thorens spine has a 12.3 m segment dropping 2.0 m (16%)
  // tagged flat: at 6.54 s it lost to a 14.7 m detour onto the parallel polygon copy at 4.71 s,
  // which is the "why won't it stay on the spine" weave.
  //
  // Anything descending at or beyond `flatGradeMax` — the pipeline's own definition of "too steep
  // to be flat" — is therefore costed as skiing. Direction semantics are untouched: a bidirectional
  // link stays bidirectional, and going up it still pays `climbSeconds`.
  const grade = distanceM > 0 ? -edge.dropM / distanceM : 0; // > 0 descending
  const skiable = edge.connectorKind === 'skiable_down' || grade >= DEFAULT_GRAPH_CONSTANTS.flatGradeMax;
  const pace = skiable ? prefs.speeds.fallbackSkiSpeed : prefs.speeds.flatTraverseSpeed;
  const seconds = distanceM / (pace * skiMult) + climbSeconds;
  return { allowed: true, seconds, distanceM, descentM, ascentM, weight: seconds * penalty, warnings };
}



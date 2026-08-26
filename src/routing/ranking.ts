import type { PisteColor, Preferences, Route, RouteObjective } from '../types/domain';

/**
 * Route selection is lexicographic over four keys, in a single BASE order; the active objective
 * just promotes its key to the front and the rest keep the base order. Time is the *least*
 * important key by default (skiing isn't driving) — it only leads when the user picks "Fastest".
 *
 *   base order:  Preference → Lifts → Skiing → Time
 *   Fastest      Time → Preference → Lifts → Skiing
 *   Fewest lifts Lifts → Preference → Skiing → Time
 *   Preferred    Preference → Lifts → Skiing → Time
 *   Longest      Skiing → Preference → Lifts → Time
 *
 * Each key is compared within a tolerance, so "effectively tied" falls through to the next key.
 * `distance` is appended after all four as an exact last resort: without it two routes that tie on
 * every key are ordered arbitrarily, which is how a 200 m detour once beat the 40 m direct line.
 */
type RankKey = 'preference' | 'lifts' | 'skiing' | 'time' | 'distance';

const BASE_ORDER: RankKey[] = ['preference', 'lifts', 'skiing', 'time'];

const PROMOTED: Record<RouteObjective, RankKey> = {
  fastest: 'time',
  fewest_lifts: 'lifts',
  preferred: 'preference',
  longest_ab: 'skiing',
};

/** The full key order for an objective: its key first, then the base order for the rest. */
export function keyOrderFor(objective: RouteObjective): RankKey[] {
  const lead = PROMOTED[objective];
  return [lead, ...BASE_ORDER.filter((k) => k !== lead), 'distance'];
}

interface RouteMetrics {
  timeS: number;
  lifts: number;
  /** Metres skied on colours outside the user's preferred set (less is better). */
  offPrefM: number;
  /**
   * Metres skied on real pistes; more is better.
   *
   * Connectors are deliberately excluded. They are app-inferred gap-fills, not runs, so counting
   * them made a chain of bridges look like extra skiing and let a long twisty connector route
   * outrank a short direct one on the "Skiing" key — which sits above Time in the base order.
   *
   * `plumbing` legs are excluded for exactly the same reason, one level deeper: polygon skeleton
   * arms and spine duplicates are app-invented too, but they are *emitted as piste*, so they slip
   * past the connector test. That let the Longest search's own judgement be undone at the last
   * step — its DAG scores an arm at ~0 (see makeDescentScorer) and duly returned the clean spine
   * line, but this comparator then re-ranked its three candidates on raw piste metres and picked
   * the one that zig-zagged spine → arm → arm → spine to bank the invented distance
   * (Val Thorens, Deux Lacs top → bottom: 3393 m of weave beat a 3332 m clean run).
   */
  skiM: number;
  /** Total ground covered, lifts included — exact final tie-break only. */
  distanceM: number;
}

function metricsOf(route: Route, prefs: Preferences): RouteMetrics {
  let offPrefM = 0;
  for (const [color, m] of Object.entries(route.stats.colorBreakdownM)) {
    if (color !== 'unknown' && !prefs.preferredColors.includes(color as PisteColor)) offPrefM += m ?? 0;
  }
  let skiM = 0;
  for (const leg of route.legs) if (leg.kind === 'piste' && !leg.plumbing) skiM += leg.distanceM;
  return {
    timeS: route.stats.totalDurationS,
    lifts: route.stats.liftCount,
    offPrefM,
    skiM,
    distanceM: route.stats.totalDistanceM,
  };
}

/** Compare one key; 0 when within tolerance (a tie → fall through to the next key). */
function compareKey(key: RankKey, a: RouteMetrics, b: RouteMetrics): number {
  switch (key) {
    case 'time': {
      const tol = Math.max(60, 0.08 * Math.min(a.timeS, b.timeS)); // 60 s or 8%
      return Math.abs(a.timeS - b.timeS) <= tol ? 0 : a.timeS - b.timeS; // less is better
    }
    case 'lifts':
      return a.lifts - b.lifts; // exact — one lift always matters
    case 'preference': {
      const tol = Math.max(30, 0.03 * Math.min(a.offPrefM, b.offPrefM)); // 30 m or 3%
      return Math.abs(a.offPrefM - b.offPrefM) <= tol ? 0 : a.offPrefM - b.offPrefM; // less is better
    }
    case 'skiing': {
      const tol = Math.max(100, 0.05 * Math.min(a.skiM, b.skiM)); // 100 m or 5%
      return Math.abs(a.skiM - b.skiM) <= tol ? 0 : b.skiM - a.skiM; // MORE is better
    }
    case 'distance':
      return a.distanceM - b.distanceM; // exact, last resort — less is better
  }
}

/** The "skiing" tolerance, exposed so callers can ask whether a skiing margin is real. */
export function skiingTolerance(aSkiM: number, bSkiM: number): number {
  return Math.max(100, 0.05 * Math.min(aSkiM, bSkiM));
}

/** Metres skied on real pistes (connectors and lifts excluded). */
export function pisteMetres(route: Route): number {
  let m = 0;
  for (const leg of route.legs) if (leg.kind === 'piste') m += leg.distanceM;
  return m;
}

/** A comparator (usable with Array.sort) that ranks routes best-first for the given objective. */
export function makeRouteComparator(objective: RouteObjective, prefs: Preferences): (a: Route, b: Route) => number {
  const order = keyOrderFor(objective);
  return (ra, rb) => {
    const a = metricsOf(ra, prefs);
    const b = metricsOf(rb, prefs);
    for (const key of order) {
      const c = compareKey(key, a, b);
      if (c !== 0) return c;
    }
    return 0;
  };
}

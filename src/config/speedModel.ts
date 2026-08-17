import type { PisteColor, SkillLevel } from '../types/domain';

/**
 * SKI SPEED MODEL — the single source of truth for how run times are estimated.
 *
 * Times come from `piste_centerline_length ÷ speed`. But a skier never goes straight down the
 * centerline — they make S-turns, so their real path is longer than the centerline, and steeper
 * runs need MORE turns. That means two different "speeds" that must not be confused:
 *
 *   • PROGRESS speed  = centerline metres advanced ÷ time  → used for ROUTING (time = length/this).
 *   • TRUE move speed = real GPS path metres ÷ time        → what we SHOW the user ("your speed").
 *
 * They're bridged by a per-colour SNAKE FACTOR = real-path ÷ centerline (≥1, larger for steeper
 * runs):   trueSpeed = progressSpeed × snakeFactor.
 *
 * Because harder runs are snakier, PROGRESS speed is a *hump*, not a ramp: slow on greens (gentle,
 * some pushing on flats), fastest on blues (the cruising sweet spot), a bit less on reds, and back
 * down on blacks (heavy snaking + caution). Base numbers below are for an AVERAGE skier.
 *
 * SKILL doesn't just scale everything uniformly — better skiers also *flatten the steep penalty*
 * (they snake blacks far less than a cautious skier). So skill has two knobs: an overall PACE
 * multiplier, and a STEEP-LIFT that raises red/black more (positive) for advanced/expert and
 * lowers them further (negative) for cautious.
 *
 *   progress(colour, skill) = BASE_PROGRESS[colour] × pace(skill) × (1 + steepness(colour)·lift(skill))
 *
 * MEASURED speeds (from live GPS) are TRUE speeds, so they must be divided by the snake factor
 * before they feed the router (see measuredTrueToProgressMps). Everything the user *sees* is a
 * TRUE speed; everything the router *uses* is a PROGRESS speed.
 */
export type SpeedColor = Exclude<PisteColor, 'unknown'>;

const KMH_TO_MPS = 1 / 3.6;

/** Average-skier PROGRESS speeds (km/h) — the hump: blue fastest, black ≈ green. */
const BASE_PROGRESS_KMH: Record<SpeedColor, number> = {
  green: 19,
  blue: 27,
  red: 25,
  black: 20,
};

/** How much each colour is affected by the skill steep-lift (0 = flat green, 0.5 = steep black). */
const STEEPNESS: Record<SpeedColor, number> = {
  green: 0,
  blue: 0.1,
  red: 0.3,
  black: 0.5,
};

/** Overall pace by skill (also used for flat traverses / fallback). */
const SKILL_PACE: Record<SkillLevel, number> = {
  cautious: 0.85,
  average: 1.0,
  advanced: 1.12,
  expert: 1.22,
};

/** Steep-lift by skill: experts lose less on steep runs; cautious lose more. */
const SKILL_STEEP_LIFT: Record<SkillLevel, number> = {
  cautious: -0.25,
  average: 0,
  advanced: 0.35,
  expert: 0.7,
};

/** Real-path ÷ centerline ratio per colour (snakier = steeper). Global (terrain, not skier). */
export const SNAKE_FACTOR: Record<SpeedColor, number> = {
  green: 1.05,
  blue: 1.15,
  red: 1.3,
  black: 1.45,
};

export function isSpeedColor(c: PisteColor | undefined): c is SpeedColor {
  return c === 'green' || c === 'blue' || c === 'red' || c === 'black';
}

/** Overall pace multiplier for a skill level (for flat traverses / fallback speeds). */
export function paceMultiplier(skill: SkillLevel): number {
  return SKILL_PACE[skill] ?? 1;
}

/** PROGRESS speed (km/h) down the centerline for a colour + skill. Used for routing time. */
export function progressSpeedKmh(color: SpeedColor, skill: SkillLevel): number {
  return BASE_PROGRESS_KMH[color] * SKILL_PACE[skill] * (1 + STEEPNESS[color] * SKILL_STEEP_LIFT[skill]);
}

/** PROGRESS speed in m/s (what the router divides the centerline length by). */
export function progressSpeedMps(color: SpeedColor, skill: SkillLevel): number {
  return progressSpeedKmh(color, skill) * KMH_TO_MPS;
}

/** TRUE move speed in m/s (progress × snake factor) — what we display as "your speed". */
export function trueSpeedMps(color: SpeedColor, skill: SkillLevel): number {
  return progressSpeedMps(color, skill) * SNAKE_FACTOR[color];
}

/** Convert a measured TRUE GPS speed (m/s) to the PROGRESS speed the router needs. */
export function measuredTrueToProgressMps(trueMps: number, color: SpeedColor): number {
  return trueMps / SNAKE_FACTOR[color];
}

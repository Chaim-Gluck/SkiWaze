import type { LiftType, Preferences, SkillLevel, SpeedConfig } from '../types/domain';

/**
 * Base average skiing speeds and lift waits. These are reference placeholders: the actual
 * ski speed used is these values scaled by the skier's SKILL level (see SKILL_SPEED_MULTIPLIER),
 * and the app shows a popup whenever it falls back to a default (unknown color / wait / hours).
 * Lift ride speeds and waits are mechanical/queue estimates and are NOT scaled by skill.
 */
export const DEFAULT_SPEEDS: SpeedConfig = {
  skiSpeedByColor: {
    green: 6.25, // ~22.5 km/h (average skier)
    blue: 8.75, // ~31.5 km/h
    red: 10.0, // ~36 km/h
    black: 10.625, // ~38 km/h
  },
  liftSpeedByType: {
    gondola: 5.0,
    cable_car: 8.0,
    funicular: 8.0,
    chair_lift: 2.5,
    t_bar: 2.0,
    drag_lift: 2.0,
    platter: 2.0,
    rope_tow: 1.5,
    magic_carpet: 0.7,
    mixed_lift: 4.0,
  },
  liftWaitByType: {
    gondola: 180,
    cable_car: 300,
    funicular: 120,
    chair_lift: 120,
    t_bar: 90,
    drag_lift: 90,
    platter: 90,
    rope_tow: 30,
    magic_carpet: 20,
    mixed_lift: 150,
  },
  fallbackSkiSpeed: 8.75,
  fallbackLiftSpeed: 3.0,
  fallbackLiftWait: 120,
  flatTraverseSpeed: 1.875,
};

export const ALL_LIFT_TYPES: LiftType[] = [
  'gondola',
  'cable_car',
  'funicular',
  'chair_lift',
  't_bar',
  'drag_lift',
  'platter',
  'rope_tow',
  'magic_carpet',
  'mixed_lift',
];

/**
 * Multiplier applied to all *skiing* speeds (pistes, flat traverses, skiable connectors,
 * fallback ski speed) based on the skier's self-rated pace. Lift ride speeds and waits are
 * unaffected. 'average' is the default. Tune these to taste — they scale the whole model.
 */
export const SKILL_SPEED_MULTIPLIER: Record<SkillLevel, number> = {
  cautious: 0.75,
  average: 1.0,
  advanced: 1.25,
  expert: 1.5,
};

export const DEFAULT_PREFERENCES: Preferences = {
  // No restriction by default; the user tightens this to their level.
  maxDifficulty: 'black',
  // All colors preferred by default (no penalty).
  preferredColors: ['green', 'blue', 'red', 'black'],
  // All lift types allowed by default.
  allowedLiftTypes: [...ALL_LIFT_TYPES],
  avoidSyntheticBridges: false,
  preferSkiing: false,
  // Balanced by default: one best route per objective, deduped.
  routeType: 'balanced',
  // Average skier pace by default.
  skillLevel: 'average',
  speeds: DEFAULT_SPEEDS,
};

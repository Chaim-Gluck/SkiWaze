import type { LiftType, Preferences, SpeedConfig } from '../types/domain';

/**
 * Base average skiing speeds and lift waits. These are reference placeholders: the actual
 * ski speed used is these values scaled by the skier's SKILL level (see SKILL_SPEED_MULTIPLIER),
 * and the app shows a popup whenever it falls back to a default (unknown color / wait / hours).
 * Lift ride speeds and waits are mechanical/queue estimates and are NOT scaled by skill.
 */
export const DEFAULT_SPEEDS: SpeedConfig = {
  // Base ski speed is derived per colour+skill from config/speedModel.ts; this is only a
  // (usually empty) measured-speed override slot.
  skiSpeedByColor: {},
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
  // Use the derived model speeds by default (not measured overrides).
  useMeasuredSpeeds: false,
  // Average skier pace by default.
  skillLevel: 'average',
  speeds: DEFAULT_SPEEDS,
};

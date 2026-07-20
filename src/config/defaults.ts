import type { LiftType, Preferences, SpeedConfig } from '../types/domain';

/**
 * Default average speeds and lift waits. These are placeholders (the app shows a
 * popup when it falls back to them) until per-user data (e.g. Strava) exists.
 * All values are configurable in the preferences panel.
 */
export const DEFAULT_SPEEDS: SpeedConfig = {
  skiSpeedByColor: {
    green: 5.0, // ~18 km/h
    blue: 7.0, // ~25 km/h
    red: 8.0, // ~29 km/h
    black: 8.5, // ~31 km/h
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
  fallbackSkiSpeed: 7.0,
  fallbackLiftSpeed: 3.0,
  fallbackLiftWait: 120,
  flatTraverseSpeed: 1.5,
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
  speeds: DEFAULT_SPEEDS,
};

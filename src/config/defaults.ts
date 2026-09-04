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
    // Effective end-to-end speeds, measured from OSM `aerialway:duration` across our own resorts
    // (`npm run probe:liftspeed` re-derives this table; medians over 568 tagged lifts). They are
    // *effective*, not line speeds — the published duration already includes the slow crawl through
    // the terminals — which is why e.g. chairs land below the 5 m/s line speed of a detachable.
    //
    // These only apply to the ~40% of lifts with no duration tag; where OSM states a time, the
    // router uses that instead (`GraphEdge.rideSeconds`).
    gondola: 4.7, // measured 4.67 (n=138)
    cable_car: 6.9, // measured 6.86 (n=31)
    funicular: 8.0, // too few tagged (n=1) to measure — left as a mechanical estimate
    // A blend, deliberately. The old 2.5 was the *fixed-grip* speed applied to every chair, which
    // made chairs 73% too slow; the distribution is bimodal (p25 2.57 fixed-grip, p75 4.74
    // detachable) and Alpine fleets are mostly detachable. `aerialway:detachable` can't split them:
    // only 11% of chairs carry it.
    chair_lift: 4.3, // measured 4.33 (n=287)
    t_bar: 3.0, // measured 2.96 (n=22)
    drag_lift: 2.65, // measured 2.65 (n=6)
    platter: 2.75, // measured 2.76 (n=69)
    rope_tow: 1.5, // too few tagged to measure
    magic_carpet: 1.05, // measured 1.08 (n=15)
    mixed_lift: 4.65, // measured 4.65 (n=10)
    // Escalator/moving walkway: standard escalator pace, and you stand still on it.
    people_mover: 0.65,
  },
  // Typical, NOT peak. A rush-hour queue can be far longer, but guessing high here would make every
  // route pessimistic all day; peak queues belong with live lift status, where a real figure is
  // available. Nothing measures these — they are judgement, unlike the speeds above.
  liftWaitByType: {
    gondola: 120,
    cable_car: 180, // pulsed, so the wait is roughly half the headway rather than a moving queue
    funicular: 120, // pulsed, as above
    chair_lift: 90,
    // Surface lifts load continuously and gather short queues.
    t_bar: 60,
    drag_lift: 60,
    platter: 60,
    rope_tow: 30,
    magic_carpet: 20,
    mixed_lift: 120,
    // You step straight on - an escalator has no queue in any meaningful sense.
    people_mover: 5,
  },
  fallbackSkiSpeed: 8.75,
  fallbackLiftSpeed: 3.0,
  fallbackLiftWait: 90, // match the chair: it's much the commonest lift type
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
  // Off-piste stays OFF by default: freeride terrain is unmarked, ungroomed and unpatrolled, so a
  // skier has to ask for it rather than be routed onto it.
  allowOffPiste: false,
  // Poling stays ON by default: the whole point of "Longest run" is length, and scoring a shallow
  // named piste as padding rejects genuine signposted terrain (Paradiski's 18.7 km Vallée de
  // l'Arc / Villaroger descent). A skier who only counts the pitch can turn it off.
  allowPoling: true,
  preferSkiing: false,
  // Balanced by default: one best route per objective, deduped.
  routeType: 'balanced',
  // Use the derived model speeds by default (not measured overrides).
  useMeasuredSpeeds: false,
  // Average skier pace by default.
  skillLevel: 'average',
  speeds: DEFAULT_SPEEDS,
};

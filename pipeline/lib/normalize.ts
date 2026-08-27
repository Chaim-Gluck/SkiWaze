import type { LiftType, PisteColor } from '../../src/types/domain';
import { AERIAL_LIFT_TYPES, DOWNLOADABLE_LIFT_TYPES } from '../../src/types/domain';
import type { RawWay } from './overpass';
import { isPisteArea, RAIL_LIFT_TYPES } from './overpass';

/** A vertex carrying its OSM node id (for topology) and coordinates (+ elevation later). */
export interface NormPoint {
  osmId: number;
  lon: number;
  lat: number;
  ele: number | null;
}

export interface NormPiste {
  wayId: number;
  color: PisteColor;
  name?: string;
  /** Piste number/reference (e.g. "56"), from piste:ref/ref. */
  ref?: string;
  /** True when this piste is an OSM area=yes polygon (kept for routing, hidden from render). */
  area: boolean;
  /**
   * True for a synthesised polygon *arm* (portal/gateway stub linking a rim point to the spine).
   * An arm is a few tens of metres of app-invented link, not a real run, so it is exempt from the
   * near-flat gradient test that governs a real piste's reverse traverse. See buildGraph.
   */
  skeletonArm?: boolean;
  /** See `levelKeyFor`. */
  levelKey?: string;
  points: NormPoint[];
}

export interface NormLift {
  wayId: number;
  liftType: LiftType;
  name?: string;
  openingHours?: string;
  /** Ride duration in seconds when the OSM `aerialway:duration` tag is present. */
  durationSec?: number;
  /**
   * OSM explicitly says this lift runs both ways (`oneway=no` / `aerialway:oneway=no`), so skiers
   * can download on it. Only ever *grants* a downhill direction — see `bidirectionalFor`.
   */
  bidirectional?: boolean;
  /** See `levelKeyFor`. */
  levelKey?: string;
  points: NormPoint[];
}

/**
 * Grade-separation signature, used to decide whether two ways that touch at a point really meet.
 *
 * Two ways crossing on a bridge or in a tunnel are at different heights and must never be welded
 * into a junction. OSM records that with `layer`/`bridge`/`tunnel`, so ways whose signatures differ
 * are treated as passing over/under each other. Ways with no such tags all share the default key
 * and are assumed to be on the same snow — which is the normal case.
 */
function levelKeyFor(tags: Record<string, string>): string | undefined {
  const layer = tags['layer'];
  const bridge = tags['bridge'];
  const tunnel = tags['tunnel'];
  if (!layer && !bridge && !tunnel) return undefined;
  const on = (v: string | undefined) => (v && v !== 'no' ? v : '');
  return `${layer ?? ''}|${on(bridge)}|${on(tunnel)}`;
}

const DIFFICULTY_TO_COLOR: Record<string, PisteColor> = {
  novice: 'green',
  easy: 'blue',
  intermediate: 'red',
  advanced: 'black',
  expert: 'black',
  freeride: 'black',
  extreme: 'black',
  green: 'green',
  blue: 'blue',
  red: 'red',
  black: 'black',
};

const AERIALWAY_TO_LIFT: Record<string, LiftType> = {
  gondola: 'gondola',
  cable_car: 'cable_car',
  mixed_lift: 'mixed_lift',
  chair_lift: 'chair_lift',
  't-bar': 't_bar',
  'j-bar': 't_bar',
  drag_lift: 'drag_lift',
  platter: 'platter',
  rope_tow: 'rope_tow',
  magic_carpet: 'magic_carpet',
};

function colorFor(tags: Record<string, string>): PisteColor {
  const d = tags['piste:difficulty'];
  if (d && DIFFICULTY_TO_COLOR[d]) return DIFFICULTY_TO_COLOR[d];
  return 'unknown';
}

function liftTypeFor(tags: Record<string, string>): LiftType {
  const a = tags['aerialway'];
  if (a && AERIALWAY_TO_LIFT[a]) return AERIALWAY_TO_LIFT[a];
  // Ground-running lifts (see RAIL_LIFT_TYPES in overpass.ts). A rack railway is modelled as a
  // funicular: for routing purposes both are a fixed track that carries skiers in both directions.
  if (RAIL_LIFT_TYPES.has(tags['railway'])) return 'funicular';
  return 'unknown';
}

/** Parse `aerialway:duration` which may be "M:SS", "M.m" (minutes) or "M" (minutes). */
export function parseDurationSec(v: string | undefined): number | undefined {
  if (!v) return undefined;
  const trimmed = v.trim();
  if (trimmed.includes(':')) {
    const [m, s] = trimmed.split(':').map((x) => Number(x));
    if (Number.isFinite(m) && Number.isFinite(s)) return m * 60 + s;
    return undefined;
  }
  const minutes = Number(trimmed);
  if (Number.isFinite(minutes)) return Math.round(minutes * 60);
  return undefined;
}

function toPoints(w: RawWay): NormPoint[] {
  return w.geometry.map((g, i) => ({
    osmId: w.nodes[i],
    lon: g.lon,
    lat: g.lat,
    ele: null,
  }));
}

export function normalizePiste(w: RawWay): NormPiste {
  return {
    wayId: w.id,
    color: colorFor(w.tags),
    name: w.tags['name'] || w.tags['piste:name'],
    ref: w.tags['piste:ref'] || w.tags['ref'],
    area: isPisteArea(w),
    levelKey: levelKeyFor(w.tags),
    points: toPoints(w),
  };
}

/**
 * A lift you can also ride *down*, per OSM rather than per type.
 *
 * Our default is "up-only, except gondolas/cable-cars/funiculars". That default silently strands
 * whole sectors: the Sella Ronda circuit only worked clockwise because **Arabba Fly** — a chair
 * that really does carry skiers both ways — was modelled up-only, and the entire Alta Badia side
 * (437 nodes, 42 lifts) could be skied into and never left.
 *
 * `oneway=no` on a chairlift is a deliberate minority signal, not an editor default: across the
 * fleet only 32 of 347 chairs carry it, against 103 tagged `oneway=yes`, and **no** drag lift
 * claims it. Mappers in these areas clearly distinguish, so the tag is worth honouring.
 *
 * Deliberately one-directional: this only ever *grants* a downhill direction, never removes one.
 * `oneway=yes` on a gondola usually just records the way's drawn direction rather than a ban on
 * downloading, so believing it would strand terrain on the strength of an ambiguous tag.
 */
function bidirectionalFor(tags: Record<string, string>, liftType: LiftType): boolean | undefined {
  // You cannot ride a surface lift downhill however it is tagged.
  if (!DOWNLOADABLE_LIFT_TYPES.has(liftType) && !AERIAL_LIFT_TYPES.has(liftType)) return undefined;
  if (tags['aerialway:oneway'] === 'no' || tags['oneway'] === 'no') return true;
  return undefined;
}

export function normalizeLift(w: RawWay): NormLift {
  const liftType = liftTypeFor(w.tags);
  return {
    wayId: w.id,
    liftType,
    name: w.tags['name'],
    openingHours: w.tags['opening_hours'],
    durationSec: parseDurationSec(w.tags['aerialway:duration']),
    bidirectional: bidirectionalFor(w.tags, liftType),
    levelKey: levelKeyFor(w.tags),
    points: toPoints(w),
  };
}

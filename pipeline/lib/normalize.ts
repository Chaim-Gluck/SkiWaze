import type { LiftType, PisteColor } from '../../src/types/domain';
import type { RawWay } from './overpass';

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
  points: NormPoint[];
}

export interface NormLift {
  wayId: number;
  liftType: LiftType;
  name?: string;
  openingHours?: string;
  /** Ride duration in seconds when the OSM `aerialway:duration` tag is present. */
  durationSec?: number;
  points: NormPoint[];
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
    points: toPoints(w),
  };
}

export function normalizeLift(w: RawWay): NormLift {
  return {
    wayId: w.id,
    liftType: liftTypeFor(w.tags),
    name: w.tags['name'],
    openingHours: w.tags['opening_hours'],
    durationSec: parseDurationSec(w.tags['aerialway:duration']),
    points: toPoints(w),
  };
}

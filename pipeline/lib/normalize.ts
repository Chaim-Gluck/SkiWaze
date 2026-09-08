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
  /**
   * OSM explicitly says this run is two-way (`oneway=no`), so it may be traversed back up even
   * where its gradient exceeds `flatGradeMax`. Only ever *grants* a reverse direction — see
   * `pisteBidirectionalFor`.
   */
  bidirectional?: boolean;
  /**
   * True when OSM says this is not a piste at all but off-piste/freeride terrain.
   *
   * We used to map `piste:difficulty=freeride|extreme` straight to black and route on it like any
   * other run, which is a safety problem: it puts unmarked, unpatrolled, avalanche-exposed terrain
   * into a suggested route with no signal to the skier. It also produced phantom "trapped basins" —
   * Tignes' Balme couloirs and Leisse are freeride lines you can only ski into, and both were
   * reported as connectivity defects when nothing was missing at all. Leisse even carries
   * `patrolled=no`, `piste:grooming=backcountry` and `note="Off-piste. Under your responsability."`,
   * i.e. three explicit warnings we ignored.
   *
   * The trigger is **difficulty**, plus one conjunction. `piste:grooming=backcountry` on its own is
   * how mappers tag a
   * signposted *ski route* (an itinéraire — marked and part of the advertised network, just ungroomed
   * and unpatrolled); it covers 169 fleet ways and 17% of St. Anton, whose Skirouten are real terrain
   * the user has already reviewed and kept. Freeride/extreme is 205 ways (2.5%) and means "this is
   * not a piste". Measured with offpiste-census. The single exception is `expert` **together with**
   * `backcountry` — see `isExpertBackcountry`.
   */
  offPiste?: boolean;
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
  // Resort escalators / moving walkways (see isPeopleMover in overpass.ts).
  if (tags['conveying'] && tags['conveying'] !== 'no') return 'people_mover';
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

const OFF_PISTE_DIFFICULTIES = new Set(['freeride', 'extreme']);

/**
 * `expert` is the one difficulty that means different things on its own and in company.
 * Alone it is just "the hardest graded run here" — a legitimate marked black. Combined with
 * `piste:grooming=backcountry` it is how mappers record high-alpine terrain: 29 ways fleet-wide
 * (tignes 12, paradiski 10, les-deux-alpes 4, then singles) against 182 backcountry-without-expert,
 * which are the signposted Skirouten/itinéraires the comment above says must never trigger.
 * Found via Verbier's Rosablanche, where a single ski-mountaineering glacier descent is mapped as
 * two ways: the lower half `extreme` (correctly hidden) and the upper half off the summit
 * `expert` + `backcountry`, which we drew and routed as an ordinary black piste.
 */
function isExpertBackcountry(tags: Record<string, string>): boolean {
  return tags['piste:difficulty'] === 'expert' && tags['piste:grooming'] === 'backcountry';
}

/**
 * A run OSM explicitly marks two-way (`oneway=no`).
 *
 * A piste is one-way downhill by default, and it also earns a reverse traverse when it is gentle
 * enough (`flatGradeMax`). That gradient test is our inference; `oneway=no` is the mapper telling
 * us directly, and it was being thrown away — `oneway` was read for lifts only. Madonna's link
 * from the Fortini gondola base to the Grostè carpet (w1131930104, novice, `oneway=no`) drops 4 m
 * over 66 m, a 6.06% grade that misses the 6% cut-off by a hair, so it shipped one-way against an
 * explicit statement that it is not.
 *
 * Like the lift rule, this is a deliberate minority signal rather than an editor default: 349 of
 * 9986 downhill/connection ways carry it, against 1449 tagged `oneway=yes`. Alpe d'Huez settles
 * what it means there — nine ways named "zone plate" (flat zone) all carry it.
 *
 * Deliberately one-directional, exactly as `bidirectionalFor` is for lifts: this only ever *grants*
 * the reverse traverse, and only by waiving the *gradient* half of the test. The absolute
 * `maxTraverseClimb` cap still applies, so it can never turn a real descent into a free climb, and
 * `oneway=yes` is never honoured in the other direction — on a piste it usually just restates the
 * default, so believing it would strand terrain on no evidence.
 */
function pisteBidirectionalFor(tags: Record<string, string>): boolean | undefined {
  return tags['oneway'] === 'no' ? true : undefined;
}

/**
 * A name that merely repeats the ref carries no information, and it is not harmless: the closure
 * key is `piste:<ref>~<name>` when both exist and `piste:<ref>` when only the ref does, so a run
 * whose ways are inconsistently tagged splits into two keys and closing one leaves the other half
 * open. Ischgl and Soelden tag `piste:ref=2` **and** `piste:name=2` on most of their runs (1423
 * edges fleet-wide), which is how a user came to see "2" and "2 - 2" as separate entries in the
 * Closed picker. Dropping the name can only ever merge a key with the bare-ref key denoting the
 * same number, so unlike adopting a *different* sibling's name it needs no ambiguity guard.
 */
function dropSelfRefName(name: string | undefined, ref: string | undefined): string | undefined {
  if (!name || !ref) return name;
  return name.trim().toLowerCase() === ref.trim().toLowerCase() ? undefined : name;
}

export function normalizePiste(w: RawWay): NormPiste {
  const difficulty = w.tags['piste:difficulty'];
  const offPiste =
    difficulty === undefined
      ? undefined
      : OFF_PISTE_DIFFICULTIES.has(difficulty) || isExpertBackcountry(w.tags);
  // `piste:name` wins over `name`, exactly as `piste:ref` wins over `ref`.
  // Many runs are mapped on top of a road or track, which carries the ROAD's name:
  // the Avoriaz->Les Lindarets blue is `name=Route des Lindarets` + `ref=D 228` but
  // `piste:name=Parchets`, so we were labelling a piste with a departmental road
  // number and it read as a service road rather than a run. Fleet-wide 143 of the
  // 256 downhill ways carrying both tags disagree (Zermatt "Moosstrasse" vs "Moos",
  // Alpe d'Huez "Lac Blanc" vs "Retour 1800"). The skiing name is the right one.
  const ref = w.tags['piste:ref'] || w.tags['ref'];
  return {
    wayId: w.id,
    color: colorFor(w.tags),
    name: dropSelfRefName(w.tags['piste:name'] || w.tags['name'], ref),
    ref,
    area: isPisteArea(w),
    levelKey: levelKeyFor(w.tags),
    offPiste,
    bidirectional: pisteBidirectionalFor(w.tags),
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
 *
 * A **people mover is the one surface lift that can run both ways**, and OSM says so in its own
 * vocabulary rather than in `oneway`: `conveying=both`. A village escalator or moving walkway in a
 * pedestrian tunnel is a pair of belts, not a single uphill belt, and modelling it up-only removes
 * half the service it exists to provide - Ischgl's **Dorftunnel** (`w137094192`, 199 m under the
 * village, no slope anywhere near it) and both halves of Ortisei's **La Curta** (`w29910707`,
 * `w29912017`) are the fleet's entire population of the tag, 3 ways in total.
 *
 * Three guards, each the reason this cannot be widened:
 * - **`both` only.** `conveying=yes|forward|backward` state a single direction, and `reversible`
 *   (Mayrhofen `w320793573`) means one direction *at a time* - the opposite of both at once.
 * - **`people_mover` only.** A magic carpet is one belt and physically cannot reverse, so a
 *   `conveying=both` on an `aerialway=magic_carpet` is contradictory tagging we decline to believe.
 * - **Grant-only**, exactly as above: no value of `conveying` ever removes a direction.
 */
function bidirectionalFor(tags: Record<string, string>, liftType: LiftType): boolean | undefined {
  if (liftType === 'people_mover') return tags['conveying'] === 'both' ? true : undefined;
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

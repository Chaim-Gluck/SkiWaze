// Overpass API client: fetch downhill pistes and aerialway lifts for a bbox.
import type { Resort } from '../../src/types/domain';
import { readCache, writeCache, DEFAULT_TTL_DAYS } from './cache';

const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
];

const USER_AGENT = 'SkiWaze/0.1 (ski routing dev tool)';

/** A single OSM way with parallel node-id / coordinate arrays (from `out geom`). */
export interface RawWay {
  id: number;
  tags: Record<string, string>;
  /** OSM node ids in order. */
  nodes: number[];
  /** Coordinates in the same order as `nodes`. */
  geometry: { lat: number; lon: number }[];
}

export interface OverpassResult {
  pistes: RawWay[];
  lifts: RawWay[];
}

/**
 * True when a piste way is an AREA polygon (OSM `area=yes` or a closed ring) rather
 * than a centreline. Rendering an area's perimeter as a line draws two parallel lines
 * down each side of the run, so these are excluded from the RENDER and emitted as polygon
 * fills instead — but they are kept in the routing graph, because there is no reliable
 * centreline twin: dropping every area edge strands ~1 276 nodes across the fleet (Val
 * Thorens alone has more area edges than it has nodes). Their perimeters do make awkward
 * routing edges; see the split-direction invariant in AGENTS.md for the one that bit us.
 */
export function isPisteArea(w: RawWay): boolean {
  if (w.tags['area'] === 'yes') return true;
  const n = w.nodes;
  return n.length > 3 && n[0] === n[n.length - 1];
}

function buildQuery(r: Resort): string {
  const { minLat, minLon, maxLat, maxLon } = r.bbox;
  const bbox = `${minLat},${minLon},${maxLat},${maxLon}`;
  // Downhill (and connection) pistes + all aerialway lift ways, PLUS ground-running lifts, which
  // OSM tags as `railway`, not `aerialway` — see RAIL_LIFT_TYPES.
  return `[out:json][timeout:120];
(
  way["piste:type"="downhill"](${bbox});
  way["piste:type"="connection"](${bbox});
  way["aerialway"](${bbox});
  way["railway"~"^(funicular|rack)$"](${bbox});
);
out geom;`;
}

async function postOverpass(endpoint: string, query: string): Promise<RawWay[]> {
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
      'User-Agent': USER_AGENT,
    },
    body: 'data=' + encodeURIComponent(query),
  });
  if (!res.ok) {
    throw new Error(`Overpass ${endpoint} returned HTTP ${res.status}`);
  }
  const json = (await res.json()) as {
    elements: {
      type: string;
      id: number;
      tags?: Record<string, string>;
      nodes?: number[];
      geometry?: { lat: number; lon: number }[];
    }[];
  };
  return json.elements
    .filter((e) => e.type === 'way' && e.geometry && e.geometry.length >= 2)
    .map((e) => ({
      id: e.id,
      tags: e.tags ?? {},
      nodes: e.nodes ?? e.geometry!.map((_, i) => -(e.id * 10000 + i)),
      geometry: e.geometry!,
    }));
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Fetch pistes + lifts for a resort, using the disk cache first and retrying on failure. */
export async function fetchResortOsm(
  r: Resort,
  opts: { refresh?: boolean; ttlDays?: number } = {},
): Promise<OverpassResult> {
  const ttlDays = opts.ttlDays ?? DEFAULT_TTL_DAYS;
  const cacheKey = `overpass-${r.id}`;

  if (!opts.refresh) {
    const cached = readCache<RawWay[]>(cacheKey, ttlDays);
    if (cached) {
      console.log(`  using cached OSM (< ${ttlDays}d old)`);
      return splitWays(cached);
    }
  }

  const query = buildQuery(r);
  let lastErr: unknown;
  // Retry across endpoints with exponential backoff (handles 504 rate-limits).
  for (let attempt = 0; attempt < 6; attempt++) {
    const endpoint = OVERPASS_ENDPOINTS[attempt % OVERPASS_ENDPOINTS.length];
    try {
      const ways = await postOverpass(endpoint, query);
      writeCache(cacheKey, ways);
      return splitWays(ways);
    } catch (err) {
      lastErr = err;
      const backoff = Math.min(30000, 3000 * 2 ** Math.floor(attempt / OVERPASS_ENDPOINTS.length));
      console.warn(`  Overpass failed (${endpoint}); retrying in ${backoff / 1000}s: ${String(err)}`);
      await sleep(backoff);
    }
  }
  throw new Error(`All Overpass attempts failed: ${String(lastErr)}`);
}

/**
 * Lifts that run on the ground rather than on a cable, which OSM tags under `railway` — so a query
 * for `aerialway` alone silently misses them. They are ordinary ski lifts to a skier and several are
 * a sector's ONLY way back up: without them Les Arcs' valley return, Tignes' Funival to the Grande
 * Motte glacier and Zermatt's Sunnegga all read as terrain you can ski into but never leave. `rack`
 * (cogwheel mountain railway) is included for the same reason.
 */
export const RAIL_LIFT_TYPES: ReadonlySet<string> = new Set(['funicular', 'rack']);

/**
 * `aerialway` values that never carry a skier between two points on the mountain. We used to accept
 * any `aerialway=*` tag, which quietly made a private cargo ropeway to a hamlet (Zmutt, above
 * Zermatt: `aerialway=goods` + `access=private`) a perfectly good leg of a ski route, and did the
 * same for zip lines, avalanche-control ropeways and dismantled lifts. `station` and `pylon` are
 * here because our query asks for WAYS: a station tagged on a way is its building outline and a
 * pylon is its footprint, neither of which is a line anyone travels along.
 */
export const NON_PASSENGER_AERIALWAYS: ReadonlySet<string> = new Set([
  'goods',
  'zip_line',
  'explosive',
  'avalanche',
  'abandoned',
  'disused',
  'construction',
  'proposed',
  'planned',
  'station',
  'pylon',
]);

/**
 * Access values that put a lift off-limits to the skiing public. `permissive` and `customers` stay
 * routable — a resort lift is exactly "customers only".
 */
const CLOSED_ACCESS: ReadonlySet<string> = new Set(['private', 'no']);

/** True when a lift way is usable by a skier travelling through the resort. */
export function isPassengerLift(w: RawWay): boolean {
  const aerialway = w.tags['aerialway'];
  if (aerialway && NON_PASSENGER_AERIALWAYS.has(aerialway)) return false;
  if (CLOSED_ACCESS.has(w.tags['access'])) return false;
  // A station building tagged `aerialway=yes` instead of `aerialway=station`. The `station`
  // value catches most of them, but plenty of mappers put the generic `yes` on the outline and
  // record the real nature in `building` / `public_transport`. Those are polygons, and a lift is
  // never a polygon, so this can't reject a genuine lift line. Left unfiltered they become
  // zero-length "lifts" that also weld together everything the outline touches (see the
  // aerialway=station note above) — around Schröcken they produced a stranded orphan node.
  if (w.tags['building'] && w.tags['building'] !== 'no') return false;
  if (w.tags['public_transport'] === 'station') return false;
  return true;
}

function splitWays(ways: RawWay[]): OverpassResult {
  const lifts = ways.filter((w) => w.tags['aerialway'] || RAIL_LIFT_TYPES.has(w.tags['railway']));
  return {
    pistes: ways.filter((w) => w.tags['piste:type']),
    lifts: lifts.filter(isPassengerLift),
  };
}

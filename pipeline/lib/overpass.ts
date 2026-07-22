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
 * down each side of the run, and its perimeter makes bogus routing edges — so these are
 * excluded from the graph. Runs mapped as areas are, by OSM convention, also mapped as
 * centreline ways, which are kept.
 */
export function isPisteArea(w: RawWay): boolean {
  if (w.tags['area'] === 'yes') return true;
  const n = w.nodes;
  return n.length > 3 && n[0] === n[n.length - 1];
}

function buildQuery(r: Resort): string {
  const { minLat, minLon, maxLat, maxLon } = r.bbox;
  const bbox = `${minLat},${minLon},${maxLat},${maxLon}`;
  // Downhill (and connection) pistes + all aerialway lift ways.
  return `[out:json][timeout:120];
(
  way["piste:type"="downhill"](${bbox});
  way["piste:type"="connection"](${bbox});
  way["aerialway"](${bbox});
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

function splitWays(ways: RawWay[]): OverpassResult {
  return {
    pistes: ways.filter((w) => w.tags['piste:type']),
    lifts: ways.filter((w) => w.tags['aerialway']),
  };
}

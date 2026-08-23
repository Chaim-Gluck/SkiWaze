import type { NormPoint } from './normalize';
import { getCachedElevation, setCachedElevation, saveElevationCache } from './cache';

/**
 * Namespace for cached samples. Bump this whenever the provider chain below changes
 * so a rebuild re-samples instead of reusing the previous DEM's values.
 */
export const ELEVATION_SOURCE = 'eudem25m+srtm30m';

type Provider =
  | { id: string; kind: 'opentopodata'; dataset: string; delayMs: number }
  | { id: string; kind: 'open-elevation'; url: string; delayMs: number };

/**
 * Elevation providers in priority order.
 *
 * open-elevation was the original primary and is now the last resort: across the Alps it
 * returns long runs of one repeated value, which flattens real relief into shelves and
 * concentrates the whole drop into single vertices. Downstream that reads as a piste which
 * is level for 300 m, plunges at -100%, then *climbs* back — phantom bumps that make the
 * routing and longest-run scorers reject perfectly good runs.
 *
 * EU-DEM 25 m is markedly more faithful over Europe; SRTM 30 m covers what falls outside
 * its footprint (Gudauri, Mount Hermon) and backstops nodata holes.
 */
const PROVIDERS: Provider[] = [
  { id: 'eudem25m', kind: 'opentopodata', dataset: 'eudem25m', delayMs: 1100 },
  { id: 'srtm30m', kind: 'opentopodata', dataset: 'srtm30m', delayMs: 1100 },
  {
    id: 'open-elevation',
    kind: 'open-elevation',
    url: 'https://api.open-elevation.com/api/v1/lookup',
    delayMs: 250,
  },
];

const BATCH = 100; // opentopodata's public cap is 100 locations per request

interface LookupResult {
  status?: string;
  error?: string;
  results?: { elevation: number | null }[];
}

type Loc = { latitude: number; longitude: number };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function fetchFrom(p: Provider, locs: Loc[]): Promise<(number | null)[]> {
  const url = p.kind === 'opentopodata' ? `https://api.opentopodata.org/v1/${p.dataset}` : p.url;
  const body =
    p.kind === 'opentopodata'
      ? JSON.stringify({ locations: locs.map((l) => `${l.latitude},${l.longitude}`).join('|') })
      : JSON.stringify({ locations: locs });

  let lastErr: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body,
      });
      // 429 is the public rate limiter, 5xx is transient — both are worth backing off for.
      if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as LookupResult;
      if (json.status && json.status !== 'OK') throw new Error(json.error ?? json.status);
      if (!json.results || json.results.length !== locs.length) {
        throw new Error('elevation result count mismatch');
      }
      await sleep(p.delayMs);
      return json.results.map((r) => (typeof r.elevation === 'number' ? r.elevation : null));
    } catch (err) {
      lastErr = err;
      await sleep(p.delayMs * (attempt + 2));
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

/**
 * Resolve a batch, falling through the provider chain for any location the previous
 * provider could not answer (nodata holes and out-of-footprint points).
 */
async function lookupBatch(locations: Loc[]): Promise<(number | null)[]> {
  const out: (number | null)[] = locations.map(() => null);
  let pending = locations.map((_, i) => i);
  let lastErr: unknown;

  for (const p of PROVIDERS) {
    if (pending.length === 0) break;
    let got: (number | null)[];
    try {
      got = await fetchFrom(
        p,
        pending.map((i) => locations[i]),
      );
    } catch (err) {
      lastErr = err;
      continue;
    }
    const next: number[] = [];
    pending.forEach((srcIdx, k) => {
      const v = got[k];
      if (v == null) next.push(srcIdx);
      else out[srcIdx] = v;
    });
    pending = next;
  }
  if (pending.length > 0) {
    console.warn(
      `  elevation: ${pending.length} point(s) unresolved by all providers${
        lastErr ? ` (last error: ${String(lastErr)})` : ''
      }`,
    );
  }
  return out;
}

/**
 * Fill `.ele` on every point in-place using a batched elevation API.
 * Points are deduplicated by OSM node id so each physical node is looked up once.
 * Returns the count of points that still lack elevation (for warnings).
 */
export async function enrichElevations(allPoints: NormPoint[][]): Promise<number> {
  // Deduplicate by osm node id.
  const byId = new Map<number, NormPoint[]>();
  for (const arr of allPoints) {
    for (const p of arr) {
      const list = byId.get(p.osmId);
      if (list) list.push(p);
      else byId.set(p.osmId, [p]);
    }
  }
  const unique = [...byId.entries()];
  let missing = 0;

  // First, satisfy from the persistent elevation cache; only look up the rest.
  const toLookup: [number, NormPoint[]][] = [];
  let cachedCount = 0;
  for (const entry of unique) {
    const pts = entry[1];
    const hit = getCachedElevation(pts[0].lat, pts[0].lon, ELEVATION_SOURCE);
    if (hit != null) {
      for (const p of pts) p.ele = hit;
      cachedCount += 1;
    } else {
      toLookup.push(entry);
    }
  }
  if (cachedCount > 0) {
    console.log(`  elevation: ${cachedCount}/${unique.length} from cache`);
  }

  for (let i = 0; i < toLookup.length; i += BATCH) {
    const slice = toLookup.slice(i, i + BATCH);
    const locations = slice.map(([, pts]) => ({
      latitude: pts[0].lat,
      longitude: pts[0].lon,
    }));
    const elevations = await lookupBatch(locations);
    slice.forEach(([, pts], idx) => {
      const raw = elevations[idx];
      // opentopodata returns sub-metre floats; the graph and all tuned thresholds
      // (pisteFlatTolerance, maxTraverseClimb, …) are metre-scale, so normalise here.
      const ele = raw == null ? null : Math.round(raw);
      if (ele == null) {
        missing += 1;
      } else {
        setCachedElevation(pts[0].lat, pts[0].lon, ele, ELEVATION_SOURCE);
      }
      for (const p of pts) p.ele = ele;
    });
    process.stdout.write(
      `\r  elevation: ${Math.min(i + BATCH, toLookup.length)}/${toLookup.length} looked up`,
    );
    // Providers self-throttle in fetchFrom, so no extra delay here.
    // Persist incrementally: a public-API rate limit part-way through a large resort
    // should not throw away everything already fetched.
    if (i % (BATCH * 20) === 0) saveElevationCache();
  }
  if (toLookup.length > 0) process.stdout.write('\n');
  saveElevationCache();
  return missing;
}

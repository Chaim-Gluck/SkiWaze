import type { NormPoint } from './normalize';
import { getCachedElevation, setCachedElevation, saveElevationCache } from './cache';

const ELEVATION_ENDPOINTS = [
  'https://api.open-elevation.com/api/v1/lookup',
  'https://api.opentopodata.org/v1/srtm30m',
];

const BATCH = 100;

interface LookupResult {
  results?: { latitude: number; longitude: number; elevation: number | null }[];
}

async function lookupBatch(
  locations: { latitude: number; longitude: number }[],
): Promise<(number | null)[]> {
  let lastErr: unknown;
  for (const endpoint of ELEVATION_ENDPOINTS) {
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ locations }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as LookupResult;
      if (!json.results || json.results.length !== locations.length) {
        throw new Error('elevation result count mismatch');
      }
      return json.results.map((r) => (typeof r.elevation === 'number' ? r.elevation : null));
    } catch (err) {
      lastErr = err;
    }
  }
  console.warn(`  elevation batch failed on all endpoints: ${String(lastErr)}`);
  return locations.map(() => null);
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
    const hit = getCachedElevation(pts[0].lat, pts[0].lon);
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
      const ele = elevations[idx];
      if (ele == null) {
        missing += 1;
      } else {
        setCachedElevation(pts[0].lat, pts[0].lon, ele);
      }
      for (const p of pts) p.ele = ele;
    });
    process.stdout.write(
      `\r  elevation: ${Math.min(i + BATCH, toLookup.length)}/${toLookup.length} looked up`,
    );
    // Be polite to the public API.
    await new Promise((r) => setTimeout(r, 250));
  }
  if (toLookup.length > 0) process.stdout.write('\n');
  saveElevationCache();
  return missing;
}

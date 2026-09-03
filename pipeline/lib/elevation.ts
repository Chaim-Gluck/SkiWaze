import type { NormPoint } from './normalize';
import { getCachedElevation, setCachedElevation, saveElevationCache } from './cache';

/**
 * Namespace for cached samples. Bump this whenever the provider chain below changes
 * so a rebuild re-samples instead of reusing the previous DEM's values.
 */
export const ELEVATION_SOURCE = 'median3:eudem25m+srtm30m+cop90.v2';

type Provider =
  | { id: string; kind: 'opentopodata'; dataset: string; delayMs: number }
  | { id: string; kind: 'open-meteo'; url: string; delayMs: number }
  | { id: string; kind: 'open-elevation'; url: string; delayMs: number };

/**
 * Elevation is resolved by CONSENSUS: every provider below is asked for every point and
 * the median is taken. A single DEM's local failure therefore cannot decide anything.
 *
 * This replaced a first-answer-wins chain headed by EU-DEM 25 m, which was measured
 * catastrophically wrong over glacier: against OpenTopoMap contours and OSM spot heights
 * at five points on the Plateau Rosa icefield it scored 14.3 m mean absolute error while
 * srtm30m scored 2.6 m, Copernicus 90 m 3.4 m and aster30m 4.6 m — and it was the lone
 * outlier at every single point, always low. Because its error was NOT a uniform offset
 * (-27 m to +13 m across eleven adjacent nodes) it flipped edges: it manufactured a
 * mid-run node that two runs left and none arrived at, reversed the head of a red run so
 * it pointed away from the rest of itself, and compressed a 21 m / 14% red pitch into
 * 7 m / 4.7%, which is under `flatGradeMax` and so earned a reverse traverse — letting
 * the router send a skier UP a red run.
 *
 * None of our guards caught any of it: `check:elevation` compares against one second
 * opinion at a ±40 m threshold, and exactly 1 node in that whole resort cleared that bar.
 * A median needs no ground truth to be right and degrades gracefully, which is why it is
 * preferred over simply promoting whichever DEM won this particular contest.
 *
 * The three are deliberately from DIFFERENT sensors/products (fused EU-DEM, SRTM radar,
 * TanDEM-X) so their errors are not correlated, and Copernicus comes from a different
 * host so two of the three do not share opentopodata's 1000-call/day public cap.
 */
const CONSENSUS: Provider[] = [
  { id: 'eudem25m', kind: 'opentopodata', dataset: 'eudem25m', delayMs: 1100 },
  { id: 'srtm30m', kind: 'opentopodata', dataset: 'srtm30m', delayMs: 1100 },
  {
    id: 'copernicus90',
    kind: 'open-meteo',
    url: 'https://api.open-meteo.com/v1/elevation',
    delayMs: 400,
  },
];

/**
 * Last resort for points no consensus provider can answer at all. open-elevation returns
 * long runs of one repeated value across the Alps, which flattens real relief into shelves
 * and concentrates a whole descent into single vertices — phantom bumps that make the
 * routing and longest-run scorers reject good runs. It must never outvote the others; it
 * only fills holes none of them could.
 */
const FALLBACK: Provider[] = [
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
  // open-meteo is a GET with parallel latitude/longitude lists; the others are POST.
  if (p.kind === 'open-meteo') {
    const qs =
      `?latitude=${locs.map((l) => l.latitude).join(',')}` +
      `&longitude=${locs.map((l) => l.longitude).join(',')}`;
    let lastErr: unknown;
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        const res = await fetch(p.url + qs, { headers: { Accept: 'application/json' } });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = (await res.json()) as { elevation?: (number | null)[] };
        if (!json.elevation || json.elevation.length !== locs.length) {
          throw new Error('elevation result count mismatch');
        }
        await sleep(p.delayMs);
        return json.elevation.map((v) => (typeof v === 'number' ? v : null));
      } catch (err) {
        lastErr = err;
        // open-meteo limits per MINUTE, so a sub-second backoff just burns retries and
        // silently drops this provider's vote out of the median. Wait it out instead.
        await sleep(String(err).includes('429') ? 20_000 : p.delayMs * (attempt + 2));
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  }

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

let degradedPoints = 0;

function median(vals: number[]): number {  const s = [...vals].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * Resolve a batch by CONSENSUS: ask every provider for every point and take the median of
 * the answers, so no single DEM's local failure can decide an elevation. Points that no
 * consensus provider can answer (outside every footprint, or a nodata hole in all three)
 * fall through to FALLBACK.
 */
async function lookupBatch(locations: Loc[]): Promise<(number | null)[]> {
  const out: (number | null)[] = locations.map(() => null);
  const votes: number[][] = locations.map(() => []);
  let lastErr: unknown;

  for (const p of CONSENSUS) {
    let got: (number | null)[];
    try {
      got = await fetchFrom(p, locations);
    } catch (err) {
      // A provider being down must not silently degrade the median — say so.
      lastErr = err;
      console.warn(`\n  elevation: provider ${p.id} failed (${String(err)}), continuing`);
      continue;
    }
    got.forEach((v, i) => {
      if (v != null) votes[i].push(v);
    });
  }

  let pending = locations.map((_, i) => i).filter((i) => votes[i].length === 0);
  for (let i = 0; i < locations.length; i++) {
    if (votes[i].length > 0) {
      out[i] = median(votes[i]);
      // A median of two is a mean, which splits the difference with a bad DEM instead of
      // outvoting it — the whole point of the pass. Count it so it cannot pass unnoticed.
      if (votes[i].length < CONSENSUS.length) degradedPoints += 1;
    }
  }

  for (const p of FALLBACK) {
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
  if (degradedPoints > 0) {
    console.warn(
      `  elevation: ${degradedPoints} point(s) resolved by fewer than ${CONSENSUS.length} providers`,
    );
    degradedPoints = 0;
  }
  saveElevationCache();
  return missing;
}

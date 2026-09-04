import type { NormPoint } from './normalize';
import { getCachedElevation, setCachedElevation, saveElevationCache } from './cache';
import { sampleSkadi } from './skadi';
import { sampleTerrarium } from './terrarium';

/**
 * Namespace for cached samples. Bump this whenever the provider chain below changes
 * so a rebuild re-samples instead of reusing the previous DEM's values.
 */
export const ELEVATION_SOURCE = 'agree2:skadi+terrarium~aster30m.v1';

type Provider =
  | { id: string; kind: 'opentopodata'; dataset: string; delayMs: number }
  | { id: string; kind: 'open-meteo'; url: string; delayMs: number }
  | { id: string; kind: 'open-elevation'; url: string; delayMs: number };

/**
 * Elevation is resolved by two INDEPENDENT free DEMs that agree, with a third called only to
 * break a disagreement.
 *
 * The problem this replaced: a straight median of three, two of which were served by
 * opentopodata's 1000-call/day public API. Re-sampling the fleet's 220k points cost 4240 calls —
 * five days — so resorts inevitably shipped on different DEMs, which is exactly the per-resort
 * inconsistency this project refuses everywhere else. open-meteo is no escape either: its cap is
 * DAILY and one resort exhausted it in under two hours.
 *
 * The two primaries are therefore both raw rasters on AWS Open Data, downloaded once and sampled
 * locally forever — no key, no cap, and offline after the first build:
 *   - `skadi`     SRTM 1-arcsec. Verified to reproduce opentopodata's `srtm30m` to 0.4 m (their
 *                 integer rounding), so this is a hosting change, not a data change.
 *   - `terrarium` Mapzen/AWS terrain tiles, already used by `check:elevation`.
 *
 * They are genuinely independent, which was measured rather than assumed — over Cervinia, Sölden
 * and St. Anton only 8-10% of nodes agree within 0.5 m, the median difference is 3-4 m and the p99
 * is ~20 m. Had Terrarium turned out to be SRTM repackaged here, the two would share their errors
 * and could out-vote a correct third DEM.
 *
 * Where they agree within AGREE_M their mean is taken and nothing else is called. A spread that
 * small cannot flip a slope's direction, which is the failure the consensus exists to prevent
 * (EU-DEM's -27..+13 m error reversed a red run's head and flattened a 14% pitch to 4.7%). Where
 * they disagree, TIEBREAK is asked and the median of the three is taken. Measured tiebreak rates
 * are 6.7% (Sölden), 11.0% (St. Anton) and 21.8% (Cervinia, glacier being the hard case), so the
 * whole fleet costs ~300-500 capped calls — one day's budget, spent in hours.
 *
 * TIEBREAK is ASTER, not EU-DEM: using our worst-measured DEM to decide precisely the hard cases
 * is backwards. At five Plateau Rosa points ASTER scored 4.6 m mean absolute error and EU-DEM
 * 14.3 m, always low and always the lone outlier.
 */
const AGREE_M = 8;

const TIEBREAK: Provider = {
  id: 'aster30m',
  kind: 'opentopodata',
  dataset: 'aster30m',
  delayMs: 1100,
};

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

/**
 * Points resolved per pass. Large on purpose: the two primaries are local raster reads, so a pass
 * costs nothing, and the only network work is the tiebreak. Tiebreaks are gathered across the
 * whole pass and sent in TIEBREAK_BATCH-sized requests — with a small pass the ~20% of points that
 * disagree would put at least one tiebreak in EVERY batch, turning a ~500-call fleet refresh back
 * into a ~2100-call one, which is the daily cap we are escaping.
 */
const BATCH = 2000;
/** opentopodata's public cap is 100 locations per request. */
const TIEBREAK_BATCH = 100;

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
let tiebreakPoints = 0;

function median(vals: number[]): number {
  const s = [...vals].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * Resolve a batch from the two local rasters, calling TIEBREAK only where they disagree.
 *
 * `trusted` is false when TIEBREAK **errored** for this batch — it is down, or we have hit its
 * daily cap. That is categorically different from a provider returning null because it genuinely
 * has no data at a point: the outage is transient, so the answer must not be written to the
 * elevation cache, where a degraded value would silently outlive the outage and poison every
 * future build of that resort.
 */
async function lookupBatch(
  locations: Loc[],
): Promise<{ values: (number | null)[]; trusted: boolean }> {
  const out: (number | null)[] = locations.map(() => null);
  const needTiebreak: number[] = [];
  const localVotes: number[][] = locations.map(() => []);
  let lastErr: unknown;
  let outage = false;

  for (let i = 0; i < locations.length; i++) {
    const { latitude: lat, longitude: lon } = locations[i];
    // Both are local disk reads after the first tile, so this costs nothing per point.
    const [a, b] = await Promise.all([
      sampleSkadi(lat, lon),
      sampleTerrarium(lat, lon).then((r) => r.point),
    ]);
    if (a != null) localVotes[i].push(a);
    if (b != null) localVotes[i].push(b);

    if (a != null && b != null && Math.abs(a - b) <= AGREE_M) {
      out[i] = (a + b) / 2;
    } else {
      // Disagreement, or only one raster could answer — either way one opinion is not enough.
      needTiebreak.push(i);
    }
  }

  if (needTiebreak.length > 0) {
    tiebreakPoints += needTiebreak.length;
    const got: (number | null)[] = [];
    for (let s = 0; s < needTiebreak.length; s += TIEBREAK_BATCH) {
      const chunk = needTiebreak.slice(s, s + TIEBREAK_BATCH);
      try {
        got.push(
          ...(await fetchFrom(
            TIEBREAK,
            chunk.map((i) => locations[i]),
          )),
        );
      } catch (err) {
        lastErr = err;
        outage = true;
        console.warn(`\n  elevation: tiebreak ${TIEBREAK.id} failed (${String(err)}), continuing`);
        got.push(...chunk.map(() => null));
      }
    }
    needTiebreak.forEach((srcIdx, k) => {
      const v = got[k];
      const votes = v == null ? localVotes[srcIdx] : [...localVotes[srcIdx], v];
      if (votes.length === 0) return; // falls through to FALLBACK below
      out[srcIdx] = median(votes);
      // A median of two is a mean, which splits the difference with a bad DEM instead of
      // outvoting it — the whole point of the pass. Count it so it cannot pass unnoticed.
      if (votes.length < 3) degradedPoints += 1;
    });
  }

  let pending = locations.map((_, i) => i).filter((i) => out[i] == null);

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
  return { values: out, trusted: !outage };
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
  let untrusted = 0;

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
    const { values: elevations, trusted } = await lookupBatch(locations);
    if (!trusted) untrusted += slice.length;
    slice.forEach(([, pts], idx) => {
      const raw = elevations[idx];
      // opentopodata returns sub-metre floats; the graph and all tuned thresholds
      // (pisteFlatTolerance, maxTraverseClimb, …) are metre-scale, so normalise here.
      const ele = raw == null ? null : Math.round(raw);
      if (ele == null) {
        missing += 1;
      } else if (trusted) {
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
  if (tiebreakPoints > 0) {
    console.log(
      `  elevation: ${tiebreakPoints}/${toLookup.length} point(s) needed the ${TIEBREAK.id} tiebreak` +
        ` (${((tiebreakPoints / Math.max(toLookup.length, 1)) * 100).toFixed(1)}%)`,
    );
    tiebreakPoints = 0;
  }
  if (degradedPoints > 0) {
    console.warn(`  elevation: ${degradedPoints} point(s) resolved by fewer than 3 DEMs`);
    degradedPoints = 0;
  }
  saveElevationCache();
  // Stop rather than emit a resort whose elevations rest on a provider outage. Nothing untrusted
  // was cached, so re-running resumes from the trusted points already stored and costs only the
  // remainder — which is what makes a fleet-wide refresh survivable against a daily API cap.
  if (untrusted > 0) {
    throw new Error(
      `elevation: ${untrusted} point(s) resolved while the tiebreak DEM was down or rate-limited. ` +
        `They were NOT cached. Re-run this resort later to finish it (already-fetched points are cached).`,
    );
  }
  return missing;
}

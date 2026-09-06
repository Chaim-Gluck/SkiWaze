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
  // OSM tags as `railway`, not `aerialway` — see RAIL_LIFT_TYPES. The fourth family is `conveying`:
  // resort escalators and moving walkways, tagged on a `highway=steps`/`footway`, which carry
  // skiers uphill between two parts of a ski area. See isPeopleMover.
  return `[out:json][timeout:120];
(
  way["piste:type"="downhill"](${bbox});
  way["piste:type"="connection"](${bbox});
  way["aerialway"](${bbox});
  way["railway"~"^(funicular|rack)$"](${bbox});
  way["conveying"](${bbox});
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
 * Public roads carrying motor traffic. Deliberately excludes `service`, `track` and `path`: a
 * resort access track or car-park aisle is routinely skied straight across, and treating one as a
 * barrier would delete real links.
 */
const ROAD_HIGHWAYS = 'motorway|trunk|primary|secondary|tertiary|unclassified|residential';

/**
 * Roads are fetched and cached UNDER THEIR OWN KEY, not folded into `buildQuery`. The piste/lift
 * cache is keyed by resort id and TTL only, so extending that query would silently serve stale data
 * until every resort was force-refreshed (see the cache gotcha in AGENTS.md). A separate key lets
 * roads arrive for an already-built resort without re-fetching its terrain.
 *
 * Returns `null` — not `[]` — when Overpass cannot be reached, so the caller can skip the pass with
 * a warning instead of quietly emitting a graph that was never checked against roads.
 */
export async function fetchResortRoads(
  r: Resort,
  opts: { refresh?: boolean; ttlDays?: number } = {},
): Promise<RawWay[] | null> {
  const ttlDays = opts.ttlDays ?? DEFAULT_TTL_DAYS;
  const cacheKey = `roads-${r.id}`;

  if (!opts.refresh) {
    const cached = readCache<RawWay[]>(cacheKey, ttlDays);
    if (cached) return cached;
  }

  const { minLat, minLon, maxLat, maxLon } = r.bbox;
  const query = `[out:json][timeout:180];way["highway"~"^(${ROAD_HIGHWAYS})$"](${minLat},${minLon},${maxLat},${maxLon});out geom;`;
  for (let attempt = 0; attempt < 4; attempt++) {
    const endpoint = OVERPASS_ENDPOINTS[attempt % OVERPASS_ENDPOINTS.length];
    try {
      const ways = await postOverpass(endpoint, query);
      writeCache(cacheKey, ways);
      return ways;
    } catch (err) {
      const backoff = Math.min(30000, 3000 * 2 ** Math.floor(attempt / OVERPASS_ENDPOINTS.length));
      console.warn(`  road fetch failed (${endpoint}); retrying in ${backoff / 1000}s: ${String(err)}`);
      await sleep(backoff);
    }
  }
  return null;
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
  // A non-revenue railway track. OSM's `service=yard|siding|spur|crossover` marks a track that
  // exists to move equipment around a works, never passengers, so it can never be a ski lift.
  // Above Perrères in Cervinia this is the 600 mm dam-construction incline "Piano Inclinato"
  // (`w167161897`) plus two unnamed siblings: all three are `railway=funicular`, so the `disused`
  // and `abandoned` ways beside them that we already skip did NOT catch them, and they arrived as
  // unnamed 0.9-1.6 km "lifts" drawn in lift purple with direction arrows, touching no piste at all.
  // Measured over the fleet this matches exactly those 3 of 64 rail-lift ways — every named
  // passenger funicular (Funival, Sunnegga, Les Arcs' Express, Gardena Ronda Express, Rasciesa)
  // is untouched. Deliberately NOT keyed on `usage=industrial` (it would also take an unreviewed
  // Verbier way, and real funiculars carry `usage=tourism`) nor on `gauge=600` (coincidental —
  // genuine funiculars here run 1200-2000 mm).
  if (RAIL_LIFT_TYPES.has(w.tags['railway']) && w.tags['service']) return false;
  return true;
}

/**
 * A resort escalator / moving walkway: OSM tags it `conveying=yes|forward|backward|both` on an
 * ordinary `highway=steps` or `highway=footway`, so all three of our other families miss it.
 *
 * This is not a curiosity. Ortisei's **La Curta** escalator (`w29910707` + `w29912017` +
 * `w1123139686`) is the link between the village and the Alpe di Siusi side, and without it the
 * whole 181-node / 23-lift Alpe di Siusi sector reads as terrain you can ski into and never leave.
 * The outside node it should reach is literally named "La Curta (top)".
 *
 * It must be modelled as a **lift**, not a connector: `maxTraverseClimb` is 8 m and every
 * connector-creation path in buildGraph is gated on it, while the La Curta chain climbs 56 m. A
 * lift is also the honest model — you stand still and it carries you up.
 *
 * Two guards keep town escalators out. The query is already bbox-limited to the resort, and
 * `access=private|no` is rejected exactly as it is for aerialways. Beyond that we rely on the fact
 * that an escalator which touches no piste or lift node simply becomes an isolated two-node
 * fragment: nothing can route *to* it, so it is inert rather than dangerous. It is deliberately NOT
 * filtered on connectivity here, because connectivity is not known until the graph is built.
 */
export function isPeopleMover(w: RawWay): boolean {
  const conveying = w.tags['conveying'];
  if (!conveying || conveying === 'no') return false;
  if (CLOSED_ACCESS.has(w.tags['access'])) return false;
  const highway = w.tags['highway'];
  return highway === 'steps' || highway === 'footway' || highway === 'path';
}

/**
 * A private hiking track that someone also flagged as a piste connection — a forest road, not
 * skiable terrain. All four signals are required, and each one is load-bearing:
 *
 *   `piste:type=connection`  it is not a run in its own right (it carries no difficulty), merely
 *                            something a mapper marked as a link between runs;
 *   `highway=track`          an unpaved farm/forest road;
 *   `sac_scale=*`            a HIKING difficulty scale — the mapper is classifying it as a walk;
 *   `vehicle|access=private` not a public way.
 *
 * Dropping any one of them breaks it, which is why the conjunction is not negotiable:
 *  - without `connection`, it swallows 619 fleet-wide `downhill` ways on forest roads — 21.6% of
 *    Paradiski — which are genuine named runs (Citta dei Sassi, Reservoir, piste 27, Charly);
 *  - without the private tag it takes two more that a human reviewed on the map and kept, one of
 *    them a paved village path in Mayrhofen (`surface=paving_stones`, `smoothness=good`).
 *
 * As tuned it matches 18 ways fleet-wide, all in Sella Ronda, and they are one thing: the Monte
 * Pana gravel forest road above Santa Cristina (`sac_scale=hiking`, `vehicle=private`) plus the
 * Saltria tracks. Reviewed on the debug map way by way and confirmed non-skiable.
 *
 * This generalises a fix that was previously made by hand. The Monte Pana road was already being
 * deleted by `removePistes` name+bbox entries in the Sella Ronda override, but a hand-drawn bbox
 * only caught the middle of it: the upper 1.8 km survived as a 7-node trapped basin with no entry
 * edges at all, and a 3-node stub hung off the main body. Removing the whole road by its tags costs
 * nothing else — measured on the built graph, the main SCC moves 1606 -> 1605 and the only nodes
 * that lose reachability are that same road's stub.
 */
export function isPrivateHikingTrack(w: RawWay): boolean {
  if (w.tags['piste:type'] !== 'connection') return false;
  if (w.tags['highway'] !== 'track') return false;
  if (!w.tags['sac_scale']) return false;
  return w.tags['vehicle'] === 'private' || w.tags['access'] === 'private';
}

function splitWays(ways: RawWay[]): OverpassResult {
  const lifts = ways.filter(
    (w) => w.tags['aerialway'] || RAIL_LIFT_TYPES.has(w.tags['railway']) || isPeopleMover(w),
  );
  return {
    // A conveying way is a lift, never a piste — it can carry `piste:type` in theory but the
    // moving walkway is what a skier actually uses.
    pistes: ways.filter(
      (w) => w.tags['piste:type'] && !isPeopleMover(w) && !isPrivateHikingTrack(w),
    ),
    lifts: lifts.filter(isPassengerLift),
  };
}

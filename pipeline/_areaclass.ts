/**
 * Report-only classification of every OSM `area=yes` piste polygon.
 *
 * Background: a run mapped as a polygon has no centreline, so the router is forced to ski its
 * PERIMETER. That rim is often straighter than the real run, so it wins on cost and the route
 * visibly hugs the edge of the piste — or zig-zags between rim and centreline where both exist.
 * Before changing anything we need to know how the 1000+ polygons split by shape, because the
 * remedy differs per shape and a wrong call here is a routing regression, not a cosmetic one.
 *
 *   A  a real centreline for the same run already exists under the WHOLE polygon
 *      -> the rim is pure duplication; it can be deleted and its portals attached to the real line.
 *   B  a corridor (a ribbon of skiable width) with no centreline at all
 *      -> a centreline has to be SYNTHESISED before the rim can go.
 *   B' a PARTIAL twin: a centreline exists but the rim wanders off it where the ribbon widens.
 *      Tempting to treat as A, but measured across all 73 of them the uncovered arc ALWAYS
 *      carries portals (371 in total, 0 exceptions), so deleting the rim would strand real
 *      connections. Handled like B, except the existing centreline is reused as the spine
 *      instead of synthesising a second line beside it.
 *   C  genuinely open terrain (aspect ratio below BOWL_RATIO)
 *      -> no single line represents it; leave exactly as today. Currently matches nothing.
 *   D  inert: contributes no graph edge at all.
 *      A closed ring that shares no node with any other way collapses to a self-loop, and
 *      segmentWay drops it (it requires fromCanon !== toCanon). Such a polygon still paints as
 *      an area fill but the router has never been able to enter or cross it, so it is neither a
 *      problem to fix nor a candidate for synthesis — there are no portals to connect.
 *
 * The A/B/C call is made PER POLYGON, never per edge: one ring's edges are legitimately at very
 * different distances from the run's centreline (a wide polygon's far side is 100m+ away), so
 * deciding edge by edge would delete half a ring and fragment the graph.
 *
 * Usage: npm run check:areaclass [resortId]   (no id = every resort)
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RESORTS } from '../src/config/resorts';
import type { GraphEdge, GeoPoint, ResortGraph } from '../src/types/domain';
import { fetchResortOsm } from './lib/overpass';
import { normalizePiste, type NormPiste } from './lib/normalize';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

/**
 * Aspect ratio (length:width) below which a polygon is genuinely open terrain rather than a
 * ribbon, so no single centreline could represent it. Measured across all 13 resorts, NOTHING
 * scores below 3 — the squattest polygon is 3.4:1 and 776 of 1004 are wider than 10:1. Width
 * alone was the wrong test: the widest polygon in the fleet (160 m) is also 2.3 km long. This
 * guard therefore matches nothing today; it exists so a future resort with a real bowl is left
 * alone instead of being silently collapsed to a line.
 */
const BOWL_RATIO = 3;
/** How far a centreline may sit from the rim and still count as the same run. */
const TWIN_TOL_M = 60;

const R = 6371000;
const toRad = (d: number): number => (d * Math.PI) / 180;

function distM(a: { lon: number; lat: number }, b: { lon: number; lat: number }): number {
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/** Planar area + perimeter of a ring, via a local equirectangular projection (fine at piste scale). */
function ringMetrics(ring: [number, number][]): { areaM2: number; perimM: number } {
  const lat0 = ring.reduce((s, p) => s + p[1], 0) / ring.length;
  const kx = (Math.PI / 180) * R * Math.cos(toRad(lat0));
  const ky = (Math.PI / 180) * R;
  const xy = ring.map(([lon, lat]) => [lon * kx, lat * ky] as [number, number]);
  let a = 0;
  let p = 0;
  for (let i = 0; i < xy.length; i++) {
    const [x1, y1] = xy[i];
    const [x2, y2] = xy[(i + 1) % xy.length];
    a += x1 * y2 - x2 * y1;
    p += Math.hypot(x2 - x1, y2 - y1);
  }
  return { areaM2: Math.abs(a) / 2, perimM: p };
}

/** Run identity: prefer the piste ref, else the name. A polygon and its centreline share one. */
function runKey(e: { pisteRef?: string; pisteName?: string }): string | null {
  const r = (e.pisteRef ?? '').trim().toLowerCase();
  if (r) return 'r:' + r;
  const n = (e.pisteName ?? '').trim().toLowerCase();
  return n ? 'n:' + n : null;
}

/** Endpoints plus a handful of interior vertices, so a long edge is tested along its whole length. */
function samples(g: GeoPoint[]): GeoPoint[] {
  if (g.length <= 2) return g;
  const out: GeoPoint[] = [g[0]];
  const step = Math.max(1, Math.floor(g.length / 6));
  for (let i = step; i < g.length - 1; i += step) out.push(g[i]);
  out.push(g[g.length - 1]);
  return out;
}

type PolyClass = 'A' | 'B' | "B'" | 'C' | 'D';

interface PolyReport {
  wayId: number;
  label: string;
  areaM2: number;
  perimM: number;
  widthM: number;
  /** Ribbon length, derived as area/width — see the note where it is computed. */
  lengthM: number;
  ratio: number;
  dropM: number;
  edges: number;
  portals: number;
  twinPct: number;
  cls: PolyClass;
}

function classifyResort(pistes: NormPiste[], graph: ResortGraph): PolyReport[] {
  const areaEdges = graph.edges.filter((e) => e.area && e.srcWayId != null);
  const byWay = new Map<number, GraphEdge[]>();
  for (const e of areaEdges) {
    const w = e.srcWayId!;
    if (!byWay.has(w)) byWay.set(w, []);
    byWay.get(w)!.push(e);
  }

  // Centrelines available to match against, indexed by run identity.
  const byRun = new Map<string, GraphEdge[]>();
  for (const e of graph.edges) {
    if (e.area || e.kind === 'lift') continue;
    const k = runKey(e);
    if (!k) continue;
    if (!byRun.has(k)) byRun.set(k, []);
    byRun.get(k)!.push(e);
  }

  // Degree over every edge, so a "portal" is a ring node that also touches the world outside.
  const touchCount = new Map<string, number>();
  for (const e of graph.edges) {
    touchCount.set(e.from, (touchCount.get(e.from) ?? 0) + 1);
    touchCount.set(e.to, (touchCount.get(e.to) ?? 0) + 1);
  }

  const out: PolyReport[] = [];
  for (const p of pistes) {
    if (!p.area || p.points.length < 3) continue;
    const edges = byWay.get(p.wayId) ?? [];
    const ring = p.points.map((pt) => [pt.lon, pt.lat] as [number, number]);
    const { areaM2, perimM } = ringMetrics(ring);
    const width = perimM > 0 ? (2 * areaM2) / perimM : 0;

    // Elevation lives on the built graph, not on the cached OSM ring (the pipeline enriches
    // after normalize), so take the polygon's drop from its own edges' geometry.
    let hi = -Infinity;
    let lo = Infinity;
    for (const e of edges) {
      for (const q of e.geometry) {
        if (q.ele == null) continue;
        if (q.ele > hi) hi = q.ele;
        if (q.ele < lo) lo = q.ele;
      }
    }
    const drop = hi > lo ? hi - lo : 0;

    // Portals: ring nodes with more edges than this polygon's own.
    const own = new Map<string, number>();
    for (const e of edges) {
      own.set(e.from, (own.get(e.from) ?? 0) + 1);
      own.set(e.to, (own.get(e.to) ?? 0) + 1);
    }
    let portals = 0;
    for (const [n, c] of own) if ((touchCount.get(n) ?? 0) > c) portals++;

    // Twin coverage: share of this polygon's edges that lie wholly within TWIN_TOL_M of a
    // same-run centreline. Whole-polygon rule -> only 100% counts as A.
    const key = edges.length ? runKey(edges[0]) : runKey({ pisteRef: p.ref, pisteName: p.name });
    const cands = key ? byRun.get(key) : undefined;
    let covered = 0;
    if (cands?.length) {
      for (const e of edges) {
        let ok = true;
        for (const s of samples(e.geometry)) {
          let best = Infinity;
          for (const c of cands) {
            for (const q of c.geometry) {
              const d = distM(s, q);
              if (d < best) best = d;
              if (best <= TWIN_TOL_M) break;
            }
            if (best <= TWIN_TOL_M) break;
          }
          if (best > TWIN_TOL_M) {
            ok = false;
            break;
          }
        }
        if (ok) covered++;
      }
    }
    const twinPct = edges.length ? (100 * covered) / edges.length : 0;

    // Length is derived from area/width rather than measured along the ring, so a hairpin
    // corridor doesn't read as "short and fat" just because its ends double back.
    const lengthM = width > 0 ? areaM2 / width : 0;
    const ratio = width > 0 ? lengthM / width : Infinity;

    // Order matters: a genuine bowl stays untouched even if it happens to twin a line.
    const cls: PolyClass =
      edges.length === 0
        ? 'D'
        : ratio < BOWL_RATIO
          ? 'C'
          : twinPct >= 100
            ? 'A'
            : twinPct > 0
              ? "B'"
              : 'B';

    out.push({
      wayId: p.wayId,
      label: [p.ref, p.name].filter(Boolean).join(' ') || '(unnamed)',
      areaM2,
      perimM,
      widthM: width,
      lengthM,
      ratio,
      dropM: drop,
      edges: edges.length,
      portals,
      twinPct,
      cls,
    });
  }
  return out;
}

async function main(): Promise<void> {
  const want = process.argv.slice(2).find((a) => !a.startsWith('--'));
  const list = want ? RESORTS.filter((r) => r.id === want) : RESORTS;
  if (list.length === 0) {
    console.error(`unknown resort: ${want}`);
    process.exit(1);
  }

  const rows: (PolyReport & { resort: string })[] = [];
  for (const resort of list) {
    const gp = path.join(ROOT, 'public', 'resorts', resort.id, 'graph.json');
    if (!fs.existsSync(gp)) continue;
    const graph = JSON.parse(fs.readFileSync(gp, 'utf8')) as ResortGraph;
    // Cached Overpass read: we need the original rings + way ids, which the graph has lost.
    const osm = await fetchResortOsm(resort, { refresh: false, ttlDays: 3650 });
    const pistes = osm.pistes.map(normalizePiste);
    for (const r of classifyResort(pistes, graph)) rows.push({ ...r, resort: resort.id });
  }

  const CLASSES: PolyClass[] = ['A', 'B', "B'", 'C', 'D'];
  const cell = (s: string | number): string => String(s).padStart(6);
  const hdr =
    'resort'.padEnd(22) + CLASSES.map(cell).join('') + '|' +
    CLASSES.filter((c) => c !== 'D').map((c) => cell('e' + c)).join('');
  console.log(hdr);
  console.log('-'.repeat(hdr.length));
  const totN = new Map<PolyClass, number>(CLASSES.map((c) => [c, 0]));
  const totE = new Map<PolyClass, number>(CLASSES.map((c) => [c, 0]));
  for (const resort of list) {
    const rs = rows.filter((r) => r.resort === resort.id);
    if (!rs.length) continue;
    const n = (c: PolyClass): number => rs.filter((r) => r.cls === c).length;
    const e = (c: PolyClass): number =>
      rs.filter((r) => r.cls === c).reduce((s, r) => s + r.edges, 0);
    console.log(
      resort.id.padEnd(22) + CLASSES.map((c) => cell(n(c))).join('') + '|' +
        CLASSES.filter((c) => c !== 'D').map((c) => cell(e(c))).join(''),
    );
    for (const c of CLASSES) {
      totN.set(c, totN.get(c)! + n(c));
      totE.set(c, totE.get(c)! + e(c));
    }
  }
  console.log('-'.repeat(hdr.length));
  console.log(
    'TOTAL'.padEnd(22) + CLASSES.map((c) => cell(totN.get(c)!)).join('') + '|' +
      CLASSES.filter((c) => c !== 'D').map((c) => cell(totE.get(c)!)).join(''),
  );

  // B' is the population that looks like A but cannot be treated as one: its rim only partly
  // shadows a real centreline. Report how far off the uncovered part strays, since that is what
  // the spine has to reach out to when the portals are reattached.
  const partial = rows.filter((r) => r.cls === "B'");
  console.log(
    `\nB' partial twins: ${partial.length} polys, ` +
      `${partial.reduce((s, r) => s + r.edges, 0)} edges, ` +
      `median twin coverage ${
        partial.length
          ? Math.round(partial.map((r) => r.twinPct).sort((a, b) => a - b)[partial.length >> 1])
          : 0
      }%`,
  );

  // Widest / most-connected B polygons drive the synthesis design, so surface them.
  const bs = rows.filter((r) => r.cls === 'B').sort((a, b) => b.areaM2 - a.areaM2).slice(0, 15);
  console.log('\nlargest case-B polygons (the ones synthesis must handle well):');
  console.log('  resort'.padEnd(24) + 'label'.padEnd(28) + 'areaM2'.padStart(9) + 'width'.padStart(7) + 'ratio'.padStart(7) + 'drop'.padStart(6) + 'portals'.padStart(8) + 'edges'.padStart(6));
  for (const r of bs) {
    console.log(
      '  ' + r.resort.padEnd(22) + r.label.slice(0, 26).padEnd(28) +
        String(Math.round(r.areaM2)).padStart(9) + String(Math.round(r.widthM)).padStart(7) +
        r.ratio.toFixed(1).padStart(7) +
        String(Math.round(r.dropM)).padStart(6) + String(r.portals).padStart(8) + String(r.edges).padStart(6),
    );
  }

  // The bowl guard only earns its keep if we can see how far the fleet sits from tripping it.
  const squat = rows.filter((r) => r.cls !== 'D').sort((a, b) => a.ratio - b.ratio).slice(0, 8);
  console.log(`\nsquattest polygons (case C triggers below ratio ${BOWL_RATIO}):`);
  for (const r of squat) {
    console.log(
      '  ' + r.resort.padEnd(22) + r.label.slice(0, 26).padEnd(28) +
        'ratio ' + r.ratio.toFixed(1).padStart(5) +
        '  w' + String(Math.round(r.widthM)).padStart(4) +
        '  len' + String(Math.round(r.lengthM)).padStart(5) +
        '  ' + r.cls,
    );
  }

  const outPath = path.join(ROOT, 'pipeline', '.cache', 'areaclass.json');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(rows, null, 1));
  console.log(`\nfull per-polygon report: ${outPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

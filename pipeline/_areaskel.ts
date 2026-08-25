/**
 * Report-only: render the synthesised area-polygon skeletons to a mapdebug overlay.
 *
 * The synthesis itself lives in `lib/areaSkeleton.ts` because `build.ts` feeds the same geometry
 * into the routing graph -- this file must stay a pure viewer, so that what is reviewed on the
 * debug map is byte-for-byte what ships.
 *
 * Usage: npx tsx pipeline/_areaskel.ts [resortId]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RESORTS } from '../src/config/resorts';
import { DEFAULT_GRAPH_CONSTANTS } from '../src/config/graphConstants';
import { fetchResortOsm } from './lib/overpass';
import { normalizeLift, normalizePiste } from './lib/normalize';
import { enrichElevations } from './lib/elevation';
import { buildResortGraph } from './lib/buildGraph';
import { buildSkeletons, CENTRED } from './lib/areaSkeleton';
import type { OverlayLine, OverlayPoint, PolyResult } from './lib/areaSkeleton';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

/**
 * Rebuild the FIRST-PASS graph, the one that still contains the polygons.
 *
 * Reading `public/resorts/<id>/graph.json` instead is what this used to do, and it silently stopped
 * working: the shipped graph is the *second* pass, in which every `area=yes` perimeter has already
 * been replaced by its skeleton, so it holds zero area edges and `buildSkeletons` had nothing to
 * chew on -- the overlay came out empty. Reproducing `build.ts`'s first pass is the only way to see
 * the polygons, and it also means the overlay shows the same spines that ship.
 */
async function run(resort: (typeof RESORTS)[number], want: Set<number>, clsByWay: Map<number, string>): Promise<PolyResult[]> {
  const osm = await fetchResortOsm(resort, { refresh: false, ttlDays: 3650 });
  if (!osm.pistes.length) return [];
  const pistes = osm.pistes.map(normalizePiste);
  const lifts = osm.lifts.map(normalizeLift);
  await enrichElevations([...pistes.map((p) => p.points), ...lifts.map((l) => l.points)]);
  const graph = buildResortGraph(resort.id, pistes, lifts, DEFAULT_GRAPH_CONSTANTS);
  const res = buildSkeletons(graph, pistes, { want });
  for (const r of res) r.cls = clsByWay.get(r.wayId) ?? '?';
  return res;
}

interface OverlayEntry {
  lines: OverlayLine[];
  points: OverlayPoint[];
  notes: string;
  /** Without this mapdebug never moves the camera when switching resorts. */
  focus: { bounds: [[number, number], [number, number]] };
}

async function main(): Promise<void> {
  // `all` is how every other check in this pipeline spells "no filter"; treating it as a resort id
  // silently matched nothing and wrote an empty overlay.
  const arg = process.argv.slice(2).find((a) => !a.startsWith('--'));
  const want = arg === 'all' ? undefined : arg;
  const clsPath = path.join(ROOT, 'pipeline', '.cache', 'areaclass.json');
  if (!fs.existsSync(clsPath)) {
    console.error('run `npm run check:areaclass` first (needs pipeline/.cache/areaclass.json)');
    process.exit(1);
  }
  const cls = JSON.parse(fs.readFileSync(clsPath, 'utf8')) as {
    resort: string;
    wayId: number;
    cls: string;
  }[];

  const waysByResort = new Map<string, Set<number>>();
  const clsByResort = new Map<string, Map<number, string>>();
  for (const r of cls) {
    if (r.cls !== 'A' && r.cls !== "B'" && r.cls !== 'B') continue;
    if (want && r.resort !== want) continue;
    if (!waysByResort.has(r.resort)) waysByResort.set(r.resort, new Set());
    waysByResort.get(r.resort)!.add(r.wayId);
    if (!clsByResort.has(r.resort)) clsByResort.set(r.resort, new Map());
    clsByResort.get(r.resort)!.set(r.wayId, r.cls);
  }

  const overlay: Record<string, OverlayEntry> = {};
  let totPoly = 0;
  let totPortals = 0;
  let totStranded = 0;
  let totGateways = 0;

  console.log('resort'.padEnd(24) + 'polys'.padStart(7) + 'portals'.padStart(9) + 'gateway'.padStart(9) + 'stranded'.padStart(10) + 'medArm'.padStart(9) + 'offSpine'.padStart(10) + 'maxGap'.padStart(9) + 'synth'.padStart(8) + 'noSpine'.padStart(9) + 'stitch'.padStart(8) + 'split'.padStart(7));
  for (const resort of RESORTS) {
    const ways = waysByResort.get(resort.id);
    if (!ways?.size) continue;
    const res = await run(resort, ways, clsByResort.get(resort.id)!);
    if (!res.length) continue;

    const lines: OverlayLine[] = [];
    const points: OverlayPoint[] = [];
    for (const r of res) {
      lines.push(...r.lines);
      points.push(...r.points);
    }
    const portals = res.reduce((s, r) => s + r.portals, 0);
    const stranded = res.reduce((s, r) => s + r.stranded, 0);
    const gapped = res.reduce((s, r) => s + r.gapped, 0);
    const maxGap = res.reduce((s, r) => Math.max(s, r.maxGap), 0);
    const noSpine = res.filter((r) => r.noSpine).length;
    const synth = res.filter((r) => r.synth).length;
    const gateways = res.reduce((s, r) => s + r.gateways, 0);
    const corridors = res.filter((r) => r.corridor).length;
    const stitches = res.reduce((s, r) => s + r.stitches, 0);
    const split = res.filter((r) => r.splitComps > 0).length;
    const arms = res.map((r) => (r.routed ? r.armM / r.routed : 0)).sort((a, b) => a - b);
    totPoly += res.length;
    totPortals += portals;
    totStranded += stranded;
    totGateways += gateways;

    const worst = [...res].sort((a, b) => b.stranded - a.stranded || b.armM - a.armM).slice(0, 6);
    let w = Infinity;
    let s = Infinity;
    let e = -Infinity;
    let n = -Infinity;
    for (const l of lines) {
      for (const [lon, lat] of l.coords) {
        if (lon < w) w = lon;
        if (lon > e) e = lon;
        if (lat < s) s = lat;
        if (lat > n) n = lat;
      }
    }
    overlay[resort.id] = {
      lines,
      points,
      focus: { bounds: [[w, s], [e, n]] },
      notes:
        `<b>Area skeletons</b> &mdash; ${res.length} polygons (A + B' + B), ${portals} portals ` +
        `(${gateways} mid-boundary gateways), <b>${stranded} stranded</b>, ${synth} synthesised spines, ` +
        `${corridors} of them spined gateway-to-gateway because the polygon is too squat to be a run in ` +
        `its own right (a corridor between its neighbours), ` +
        `${stitches} spine stitches (${split} polygons still split).<br>` +
        `dark blue = existing centreline (reused spine) &middot; ` +
        `light blue = synthesised spine (case B: no centreline exists, so one is invented down the middle) &middot; ` +
        `turquoise = stitch joining two spine pieces that were otherwise separate components &middot; ` +
        `pink = synthesised fan-out arm &middot; ` +
        `purple = arm to a local hub (an interior lobe with no centreline of its own) &middot; ` +
        `teal = polygon with no centreline through it at all, so arms link portal-to-portal &middot; ` +
        `grey = polygon rim (for reference) &middot; orange dot = portal &middot; ` +
        `green dot = gateway: either the mid-point of a genuinely shared rim (one new node serving ` +
        `both polygons) or an existing node where two polygons touch at a single point &middot; ` +
        `red dot = stranded portal.<br>` +
        `Biggest: ` +
        worst.map((w) => `${w.label} (${w.cls}, ${w.portals}p, ${Math.round(w.armM)} m)`).join(' · '),
    };
    console.log(
      resort.id.padEnd(24) + String(res.length).padStart(7) + String(portals).padStart(9) +
        String(gateways).padStart(9) +
        String(stranded).padStart(10) + (arms.length ? Math.round(arms[arms.length >> 1]) + 'm' : '-').padStart(9) +
        String(gapped).padStart(10) + (Math.round(maxGap) + 'm').padStart(9) + String(synth).padStart(8) + String(noSpine).padStart(9) +
        String(stitches).padStart(8) + String(split).padStart(7),
    );
    if (process.env.SKELDIAG) {
      const spans = res.filter((x) => !x.noSpine && !x.synth);
      const bk = [0, 0.05, 0.15, 0.3, 0.5, 0.75];
      const hist = bk.map((lo, i) => spans.filter((s) => s.spanFrac >= lo && (i + 1 >= bk.length || s.spanFrac < bk[i + 1])).length);
      console.log('   span ' + bk.map((lo, i) => `>=${lo}:${hist[i]}`).join(' '));
      for (const r of spans.filter((x) => x.spanFrac < 0.3 && x.polyLenM > 150).sort((a, b) => a.spanFrac - b.spanFrac).slice(0, 6)) {
        console.log(
          `   graze w${r.wayId} span=${r.spanFrac.toFixed(3)} len=${Math.round(r.polyLenM)}m ${r.portals}p ${r.label}`,
        );
      }
      for (const r of res.filter((x) => x.noSpine)) {
        const rim = r.lines.find((l) => l.color === '#9aa4b2');
        let at = '';
        if (rim && rim.coords.length) {
          const n = rim.coords.length;
          const lo = rim.coords.reduce((a, c) => a + c[0], 0) / n;
          const la = rim.coords.reduce((a, c) => a + c[1], 0) / n;
          at = ` #${lo.toFixed(6)},${la.toFixed(6)},17`;
        }
        console.log(`   noSpine w${r.wayId} ${r.cls} ${r.portals}p ${r.label}${at}`);
      }
    }
  }

  console.log(
    `\nTOTAL`.padEnd(24) + String(totPoly).padStart(7) + String(totPortals).padStart(9) +
      String(totGateways).padStart(9) + String(totStranded).padStart(10),
  );

  const dir = path.join(ROOT, 'public', 'devtools', 'overlays');
  fs.writeFileSync(path.join(dir, 'area-skeletons.json'), JSON.stringify(overlay));
  const idxPath = path.join(dir, 'index.json');
  const idx = JSON.parse(fs.readFileSync(idxPath, 'utf8')) as { id: string }[];
  if (!idx.some((o) => o.id === 'area-skeletons')) {
    idx.unshift({
      id: 'area-skeletons',
      label: 'Area skeletons (proposed)',
      file: 'area-skeletons.json',
      description:
        "Report-only preview of the polygon-centreline plan for classes A and B'. Blue = the run's existing centreline, reused as the spine. Pink = synthesised fan-out arms, routed through an interior 12 m grid so they never leave the polygon. Orange = portals (they do not move); red = a portal the grid could not reach. Grey = the rim these would replace.",
    } as { id: string });
    fs.writeFileSync(idxPath, JSON.stringify(idx, null, 2));
  }
  console.log(`\noverlay written: ${path.join(dir, 'area-skeletons.json')}`);
  if (process.env.SKELDIAG && CENTRED.length) {
    const q = (xs: number[], p: number): string =>
      xs.length ? xs[Math.min(xs.length - 1, Math.floor(xs.length * p))].toFixed(2) : '-';
    const row = (label: string, xs: { r: number; bend: number }[]): void => {
      const rs = xs.map((x) => x.r).sort((a, b) => a - b);
      const bad = rs.filter((r) => r < 0.5).length;
      console.log(
        `  ${label.padEnd(22)} n=${String(rs.length).padStart(6)}  p10=${q(rs, 0.1)}  med=${q(rs, 0.5)}  <0.5: ${((100 * bad) / rs.length).toFixed(1)}%`,
      );
    };
    console.log('\ncentredness by local turn angle (1.00 = best clearance available within 25 m):');
    row('straight (<10 deg)', CENTRED.filter((x) => x.bend < 10));
    row('gentle (10-30 deg)', CENTRED.filter((x) => x.bend >= 10 && x.bend < 30));
    row('bend (30-60 deg)', CENTRED.filter((x) => x.bend >= 30 && x.bend < 60));
    row('sharp (>=60 deg)', CENTRED.filter((x) => x.bend >= 60));
    row('ALL', CENTRED);
  }
  console.log('open http://localhost:5173/devtools/mapdebug.html and pick "Area skeletons (proposed)"');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

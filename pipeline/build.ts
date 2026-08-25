// SkiWaze data pipeline orchestrator.
// Usage: tsx pipeline/build.ts <resortId|all>
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RESORTS } from '../src/config/resorts';
import { DEFAULT_GRAPH_CONSTANTS } from '../src/config/graphConstants';
import type { Resort } from '../src/types/domain';
import { fetchResortOsm } from './lib/overpass';
import { normalizeLift, normalizePiste } from './lib/normalize';
import { enrichElevations } from './lib/elevation';
import { buildResortGraph } from './lib/buildGraph';
import { buildSkeletons } from './lib/areaSkeleton';
import { skeletonPistes } from './lib/areaSkeletonPistes';
import { applyOverrides, loadOverrides } from './lib/overrides';
import { pruneRedundantArms } from './lib/pruneArms';
import { printReport, validateGraph } from './lib/validate';
import { emitResort } from './lib/emit';
import { auditGraph, auditSummary } from './_phantoms';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PUBLIC_DIR = path.join(ROOT, 'public');
const OVERRIDES_DIR = path.join(ROOT, 'pipeline', 'overrides');

async function buildResort(resort: Resort, opts: { refresh: boolean; ttlDays: number }): Promise<void> {
  console.log(`\n=== ${resort.name} (${resort.id}) ===`);

  console.log('  fetching OSM (Overpass)...');
  const osm = await fetchResortOsm(resort, opts);
  console.log(`  pistes=${osm.pistes.length} lifts=${osm.lifts.length}`);
  if (osm.pistes.length === 0 && osm.lifts.length === 0) {
    console.warn('  no data returned; skipping.');
    return;
  }

  const pistes = osm.pistes.map(normalizePiste);
  const lifts = osm.lifts.map(normalizeLift);

  console.log('  enriching elevation...');
  const missing = await enrichElevations([
    ...pistes.map((p) => p.points),
    ...lifts.map((l) => l.points),
  ]);
  if (missing > 0) console.warn(`  ${missing} node(s) still missing elevation.`);

  console.log('  building graph...');
  let graph = buildResortGraph(resort.id, pistes, lifts, DEFAULT_GRAPH_CONSTANTS);

  // Replace `area=yes` polygons with an interior skeleton (plan §3). The polygon's *perimeter* is
  // what the router can follow today, so crossing a bowl means skiing around its rim. Two passes
  // are needed because a portal is defined by what a ring node touches OUTSIDE its own polygon, and
  // the spine of a class A/B′ polygon is an existing centreline — both are properties of the
  // assembled graph, not of the raw ways. So: build once to discover them, then rebuild with the
  // skeletons in place of the polygons.
  const skels = buildSkeletons(graph, pistes);
  const corridors = skels.filter((s) => s.corridor);
  if (corridors.length)
    console.log(
      `  corridors: ${corridors.length} squat polygon(s) spined gateway-to-gateway` +
        ` (${corridors.map((s) => 'w' + s.wayId).slice(0, 12).join(' ')}${corridors.length > 12 ? ' …' : ''})`,
    );
  // Fall-line fact check: how many polygons ended up with a spine that does not descend them? A
  // spine is adopted from whichever OSM way of the same run touches the ring, and nothing has ever
  // verified it crosses the polygon — so this counts the ones where the adopted centreline is
  // demonstrably the wrong line. Report only for now; the number decides what to do about it.
  const FALL_MIN = 0.35;
  const graded = skels.filter((s) => s.fall.polyDropM >= 15);
  const flat = graded.filter((s) => s.fall.dropRatio < FALL_MIN);
  if (graded.length)
    console.log(
      `  fall-line: ${flat.length}/${graded.length} polygon(s) with a spine that barely descends` +
        ` (drop ratio < ${FALL_MIN})`,
    );
  if (process.env.FALLDIAG)
    for (const s of (process.env.FALLDIAG === 'all' ? [...graded] : [...flat]).sort((a, b) => a.fall.dropRatio - b.fall.dropRatio).slice(0, 60))
      console.log(
        `    w${s.wayId} drop=${s.fall.dropRatio.toFixed(2)} (${s.fall.spineDropM.toFixed(0)}m of ${s.fall.polyDropM.toFixed(0)}m)` +
          ` angle=${s.fall.angleDeg.toFixed(0)}° span=${s.spanFrac.toFixed(2)}${s.synth ? ' synth' : ''}  ${s.label}`,
      );
  const sk = skeletonPistes(skels, pistes);
  if (sk.pistes.length) {
    // Elevation for the new vertices is FETCHED, never interpolated: interpolated values reverse
    // ~3.8 % of segments (plan §4b), and a piste is emitted one-way descending, so a reversed
    // segment severs the run and hands the router a fake way to gain height.
    console.log(`  skeletons: ${sk.replaced.size} polygons, ${sk.pistes.length} ways, ${sk.newPoints.length} new vertices`);
    if (sk.unwelded) console.warn(`  ${sk.unwelded} arm(s) found no spine to weld onto`);
    const skMissing = await enrichElevations([sk.newPoints]);
    if (skMissing > 0) console.warn(`  ${skMissing} skeleton vertex/vertices still missing elevation.`);
    const kept = pistes.filter((p) => !sk.replaced.has(p.wayId));
    graph = buildResortGraph(resort.id, [...kept, ...sk.pistes], lifts, DEFAULT_GRAPH_CONSTANTS);
  }

  const ov = loadOverrides(resort.id, OVERRIDES_DIR);
  if (ov) {
    console.log('  applying overrides...');
    graph = applyOverrides(graph, ov);
  }

  // Last of all, and deliberately so: pruning proves an arm redundant against the graph around it,
  // and that proof is only worth anything if nothing moves afterwards. Overrides re-issue edges,
  // so this cannot live inside buildGraph. See pruneArms.ts.
  graph = pruneRedundantArms(graph, DEFAULT_GRAPH_CONSTANTS);

  const report = validateGraph(graph);
  printReport(report);

  // Surface likely data issues (false-elevation reversals / non-skiable long connections)
  // so they're caught when adding or refreshing a resort. Review with: npm run check:audit <id>
  const summary = auditSummary(auditGraph(graph));
  if (summary) console.warn(`  audit: ${summary} to review — run: npm run check:audit ${resort.id}`);

  const areaPolys = pistes
    .filter((p) => p.area && p.points.length >= 3)
    .map((p) => ({
      color: p.color,
      name: p.name,
      ref: p.ref,
      wayId: p.wayId,
      coordinates: p.points.map((pt) => [pt.lon, pt.lat] as [number, number]),
    }));
  emitResort(resort, graph, report, PUBLIC_DIR, areaPolys);
}

function writeIndex(built: Resort[]): void {
  const dir = path.join(PUBLIC_DIR, 'resorts');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'index.json'),
    JSON.stringify(
      built.map((r) => ({ id: r.id, name: r.name, country: r.country, center: r.center })),
      null,
      2,
    ),
  );
  // Build stamp used by the app for version-based cache-busting (fresh only after a rebuild).
  fs.writeFileSync(path.join(dir, 'build.json'), JSON.stringify({ builtAt: Date.now() }));
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const arg = args.find((a) => !a.startsWith('--'));
  const refresh = args.includes('--refresh');
  const ttlArg = args.find((a) => a.startsWith('--ttl-days='));
  const ttlDays = ttlArg ? Number(ttlArg.split('=')[1]) : 30;
  if (!arg) {
    console.error('Usage: tsx pipeline/build.ts <resortId|all> [--refresh] [--ttl-days=N]');
    process.exit(1);
  }
  const targets =
    arg === 'all' ? RESORTS : RESORTS.filter((r) => r.id === arg);
  if (targets.length === 0) {
    console.error(`Unknown resort "${arg}". Known: ${RESORTS.map((r) => r.id).join(', ')}`);
    process.exit(1);
  }

  const built: Resort[] = [];
  const failed: { id: string; err: string }[] = [];
  for (const resort of targets) {
    try {
      await buildResort(resort, { refresh, ttlDays });
      built.push(resort);
    } catch (err) {
      console.error(`  FAILED ${resort.id}: ${String(err)}`);
      failed.push({ id: resort.id, err: String(err) });
    }
  }
  // Merge with any previously built resorts so the index stays complete.
  const existingIds = new Set(built.map((r) => r.id));
  for (const r of RESORTS) {
    if (!existingIds.has(r.id) && fs.existsSync(path.join(PUBLIC_DIR, 'resorts', r.id, 'graph.json'))) {
      built.push(r);
    }
  }
  writeIndex(built);
  console.log(`\nDone. Built ${existingIds.size} resort(s).`);
  if (failed.length > 0) {
    // Exit non-zero so a partial `data:all` can't look like a success. A per-resort failure used
    // to be buried mid-log while the run still exited 0, which made a locked file (Windows keeps
    // graph.json open while the dev server serves it) look like the resort had been skipped.
    console.error(`\n${failed.length} resort(s) FAILED and were NOT written:`);
    for (const f of failed) console.error(`  - ${f.id}: ${f.err}`);
    console.error('\nStale data is still on disk for these. Re-run them individually; if the error');
    console.error("is an UNKNOWN/EPERM open, stop the dev server first — it's holding the file.");
    process.exit(1);
  }
}

main();

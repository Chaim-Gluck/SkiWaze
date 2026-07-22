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
import { applyOverrides, loadOverrides } from './lib/overrides';
import { printReport, validateGraph } from './lib/validate';
import { emitResort } from './lib/emit';

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

  const ov = loadOverrides(resort.id, OVERRIDES_DIR);
  if (ov) {
    console.log('  applying overrides...');
    graph = applyOverrides(graph, ov);
  }

  const report = validateGraph(graph);
  printReport(report);

  const areaPolys = pistes
    .filter((p) => p.area && p.points.length >= 3)
    .map((p) => ({
      color: p.color,
      name: p.name,
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
  for (const resort of targets) {
    try {
      await buildResort(resort, { refresh, ttlDays });
      built.push(resort);
    } catch (err) {
      console.error(`  FAILED ${resort.id}: ${String(err)}`);
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
}

main();

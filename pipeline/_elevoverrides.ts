/**
 * Are our `setNodeElevation` overrides still doing anything?
 *
 * Most were hand-written against an older DEM. For each entry we compare the override value
 * with what the *current* provider chain actually samples at that node's coordinate (read
 * straight from the shared elevation cache, namespaced by DEM). An entry whose override is
 * within `AGREE_M` of the live sample is dead weight: the pipeline already produces it.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ELEVATION_SOURCE } from './lib/elevation';
import { getCachedElevation } from './lib/cache';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const AGREE_M = 3;

interface GNode {
  id: string;
  point: { lon: number; lat: number; ele: number };
}

let totals = { entries: 0, redundant: 0, active: 0, missing: 0 };
const activeByResort: Record<string, number> = {};

const files = fs
  .readdirSync(path.join(ROOT, 'pipeline', 'overrides'))
  .filter((f) => f.endsWith('.json') && !f.includes('example'));

for (const f of files) {
  const id = f.replace(/\.json$/, '');
  const ov = JSON.parse(fs.readFileSync(path.join(ROOT, 'pipeline', 'overrides', f), 'utf8'));
  const list: { node: string; ele: number }[] = ov.setNodeElevation ?? [];
  if (!list.length) continue;

  const graphPath = path.join(ROOT, 'public', 'resorts', id, 'graph.json');
  if (!fs.existsSync(graphPath)) continue;
  const graph = JSON.parse(fs.readFileSync(graphPath, 'utf8')) as { nodes: GNode[] };
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));

  let redundant = 0;
  let active = 0;
  let missing = 0;
  const details: string[] = [];

  for (const e of list) {
    totals.entries++;
    const n = byId.get(e.node);
    if (!n) {
      missing++;
      totals.missing++;
      details.push(`  ?  ${e.node} -> node no longer in graph (stale entry)`);
      continue;
    }
    const raw = getCachedElevation(n.point.lat, n.point.lon, ELEVATION_SOURCE);
    if (raw === undefined) {
      missing++;
      totals.missing++;
      details.push(`  ?  ${e.node} -> no cached ${ELEVATION_SOURCE} sample`);
      continue;
    }
    const delta = e.ele - raw;
    if (Math.abs(delta) <= AGREE_M) {
      redundant++;
      totals.redundant++;
    } else {
      active++;
      totals.active++;
      details.push(
        `  !  ${e.node}  override ${e.ele}m  vs live DEM ${Math.round(raw)}m  (${delta > 0 ? '+' : ''}${Math.round(delta)}m)`,
      );
    }
  }

  activeByResort[id] = active;
  console.log(
    `${id.padEnd(24)} ${String(list.length).padStart(3)} entries  ${String(redundant).padStart(3)} redundant  ${String(active).padStart(3)} still-active  ${missing} unknown`,
  );
  if (process.argv.includes('--details')) for (const d of details) console.log(d);
}

console.log(
  `\nTOTAL ${totals.entries} entries: ${totals.redundant} redundant (${Math.round((100 * totals.redundant) / totals.entries)}%), ${totals.active} still-active, ${totals.missing} unknown`,
);

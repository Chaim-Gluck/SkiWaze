/**
 * Per-node elevation probe.
 *
 * `check:elevation` only reports edges it is confident enough to flag. When a human
 * spots a suspicious arrow on the map that the audit stayed quiet about, this prints
 * the full neighbourhood of a node — every incident edge, our elevation vs the DEM
 * for both ends, and whether the edge climbs — so the disagreement is visible.
 *
 * Usage: npm run probe:elevation <resortId> <nodeId> [nodeId...]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ResortGraph } from '../src/types/domain';
import { sampleNode } from './_elevaudit';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

function bearing(from: { lat: number; lon: number }, to: { lat: number; lon: number }): string {
  const dx = (to.lon - from.lon) * Math.cos((from.lat * Math.PI) / 180);
  const dy = to.lat - from.lat;
  const a = ((Math.atan2(dx, dy) * 180) / Math.PI + 360) % 360;
  return ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][Math.round(a / 45) % 8];
}

async function main(): Promise<void> {
  const id = process.argv[2];
  const nodeIds = process.argv.slice(3);
  if (!id || !nodeIds.length) {
    console.error('Usage: tsx pipeline/_elevprobe.ts <resortId> <nodeId> [nodeId...]');
    process.exit(1);
  }
  const gp = path.join(ROOT, 'public', 'resorts', id, 'graph.json');
  if (!fs.existsSync(gp)) { console.error(`No graph at ${gp} — run: npm run data ${id}`); process.exit(1); }
  const graph = JSON.parse(fs.readFileSync(gp, 'utf8')) as ResortGraph;
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));

  // Sample every node we are about to print, including the neighbours, so both ends
  // of each edge can be compared against the DEM.
  const wanted = new Set<string>();
  for (const nid of nodeIds) {
    wanted.add(nid);
    for (const e of graph.edges) {
      if (e.from === nid) wanted.add(e.to);
      if (e.to === nid) wanted.add(e.from);
    }
  }
  const dem = new Map<string, number | null>();
  for (const nid of wanted) {
    const n = byId.get(nid);
    if (!n) continue;
    const s = await sampleNode(n.point.lat, n.point.lon);
    dem.set(nid, s.point);
  }

  const fmt = (nid: string): string => {
    const n = byId.get(nid);
    if (!n) return `${nid}(missing)`;
    const d = dem.get(nid);
    const ours = Math.round(n.point.ele);
    const delta = d == null ? '' : ` ${Math.round(d) - ours >= 0 ? '+' : ''}${Math.round(d) - ours}`;
    return `${nid} ${ours}m~dem${d == null ? '?' : Math.round(d)}${delta}`;
  };

  for (const nid of nodeIds) {
    const n = byId.get(nid);
    if (!n) { console.log(`\n${nid}: not found in ${id}`); continue; }
    console.log(`\n=== ${id} ${fmt(nid)} (${n.kind}) ===`);
    const incident = graph.edges.filter((e) => e.from === nid || e.to === nid);
    if (!incident.length) { console.log('  (no edges)'); continue; }
    for (const e of incident) {
      const other = e.from === nid ? e.to : e.from;
      const on = byId.get(other);
      const rise = Math.round(byId.get(e.to)!.point.ele - byId.get(e.from)!.point.ele);
      const df = dem.get(e.from), dt = dem.get(e.to);
      const demRise = df == null || dt == null ? null : Math.round(dt - df);
      // The interesting case: our field and the DEM disagree about which way it runs.
      const flag = demRise != null && Math.sign(demRise) !== Math.sign(rise) && Math.abs(demRise) > 3 ? '  <-- DEM DISAGREES' : rise > 0 ? '  <-- climbs' : '';
      console.log(
        `  ${e.from}->${e.to} ${e.kind}${e.connectorKind ? '/' + e.connectorKind : ''}` +
        ` ${on ? bearing(n.point, on.point) : '?'} ${Math.round(e.lengthM)}m` +
        ` rise=${rise > 0 ? '+' : ''}${rise}m demRise=${demRise == null ? '?' : (demRise > 0 ? '+' : '') + demRise}m` +
        `${e.name ? ' "' + e.name + '"' : ''}${flag}`,
      );
      console.log(`      other: ${fmt(other)}`);
    }
  }
}

main();

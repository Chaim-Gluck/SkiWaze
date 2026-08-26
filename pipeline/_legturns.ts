/** Per-leg dump with coordinates and the turn angle at each leg boundary.
 *   npx tsx pipeline/_legturns.ts <resortId> <from> <to> [optionIndex]
 *
 * _zigzag.ts smooths over 25 m spans, which hides a staircase built from 12-40 m segments --
 * exactly the "broken lines" shape. This looks at the joins themselves.
 */
import { readFileSync } from 'node:fs';
import { planRoutes } from '../src/routing/plan';
import { DEFAULT_PREFERENCES } from '../src/config/defaults';
import type { ResortGraph } from '../src/types/domain';

const [id, from, to, optArg] = process.argv.slice(2);
if (!id || !from || !to) throw new Error('usage: _legturns.ts <resortId> <from> <to> [option]');

const graph: ResortGraph = JSON.parse(readFileSync(`public/resorts/${id}/graph.json`, 'utf8'));
const byId = new Map(graph.nodes.map((n) => [n.id, n]));
const edgeById = new Map(graph.edges.map((e) => [e.id, e]));

const res = planRoutes(graph, {
  fromNodeId: from,
  toNodeId: to,
  prefs: DEFAULT_PREFERENCES,
  timing: { mode: 'now' },
});

interface P { lon: number; lat: number }
function bearing(a: P, b: P): number {
  const la = (a.lat * Math.PI) / 180;
  const lb = (b.lat * Math.PI) / 180;
  const dl = ((b.lon - a.lon) * Math.PI) / 180;
  const y = Math.sin(dl) * Math.cos(lb);
  const x = Math.cos(la) * Math.sin(lb) - Math.sin(la) * Math.cos(lb) * Math.cos(dl);
  return (Math.atan2(y, x) * 180) / Math.PI;
}

res.routes.forEach((r, i) => {
  if (optArg && i !== Number(optArg) - 1) return;
  console.log(`\n=== option ${i + 1}/${res.routes.length} ${(r.stats.totalDistanceM / 1000).toFixed(2)} km legs ${r.legs.length}`);
  const dirs: (number | null)[] = [];
  for (const l of r.legs) {
    const e = edgeById.get(l.edgeId!);
    const a = byId.get(e!.from)!.point;
    const b = byId.get(e!.to)!.point;
    dirs.push(bearing(a, b));
  }
  r.legs.forEach((l, k) => {
    const e = edgeById.get(l.edgeId!)!;
    const a = byId.get(e.from)!.point;
    let turn = '';
    if (k > 0) {
      let d = Math.abs(dirs[k]! - dirs[k - 1]!);
      if (d > 180) d = 360 - d;
      turn = `${d.toFixed(0).padStart(3)}deg`;
      if (d >= 75) turn += ' <<<';
    }
    console.log(
      `  ${String(k).padStart(2)} ${l.edgeId?.padEnd(7)} ${l.kind.padEnd(9)} ` +
        `${String(e.color ?? e.connectorKind ?? '').padEnd(13)} ${l.distanceM.toFixed(0).padStart(4)}m ` +
        `@${a.lat.toFixed(5)},${a.lon.toFixed(5)} way=${String(e.srcWayId ?? '-').padEnd(11)} ` +
        `${turn}  ${(e.name ?? l.name ?? '')}`,
    );
  });
});

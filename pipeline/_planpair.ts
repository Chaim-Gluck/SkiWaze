/** Dump every option the planner returns for one A->B pair, leg by leg.
 *   npx tsx pipeline/_planpair.ts <resortId> <fromNodeId> <toNodeId>
 */
import { readFileSync } from 'node:fs';
import { planRoutes } from '../src/routing/plan';
import { DEFAULT_PREFERENCES } from '../src/config/defaults';
import type { ResortGraph } from '../src/types/domain';

const [id, from, to] = process.argv.slice(2);
if (!id || !from || !to) throw new Error('usage: _planpair.ts <resortId> <from> <to>');

const graph: ResortGraph = JSON.parse(readFileSync(`public/resorts/${id}/graph.json`, 'utf8'));
const res = planRoutes(graph, {
  fromNodeId: from,
  toNodeId: to,
  prefs: DEFAULT_PREFERENCES,
  timing: { mode: 'now' },
});

res.routes.forEach((r, i) => {
  console.log(
    `\n=== option ${i + 1}/${res.routes.length}  ${(r.stats.totalDistanceM / 1000).toFixed(2)} km  ` +
      `${Math.round(r.stats.totalTimeS / 60)} min  drop ${Math.round(r.stats.totalDropM)} m  legs ${r.legs.length}`,
  );
  for (const l of r.legs) {
    const e = graph.edges.find((x) => x.id === l.edgeId);
    console.log(
      `  ${l.edgeId?.padEnd(7)} ${l.kind.padEnd(9)} ${String(e?.color ?? e?.connectorKind ?? '').padEnd(14)} ` +
        `${l.distanceM.toFixed(0).padStart(5)}m  drop ${String(Math.round(e?.dropM ?? 0)).padStart(5)}m  ` +
        `${e?.from} -> ${e?.to}  ${e?.synthetic ? '[synthetic] ' : ''}${l.name ?? e?.name ?? ''}`,
    );
  }
});

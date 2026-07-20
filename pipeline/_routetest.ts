// Routing smoke test for a compiled resort graph.
// Usage:
//   tsx pipeline/_routetest.ts <resortId>                       # highest point -> every bottom
//   tsx pipeline/_routetest.ts <resortId> <fromNodeId> <toNodeId>  # a specific A -> B
//
// Loads public/resorts/<id>/graph.json and exercises the real routing engine so you can
// confirm a freshly-built resort actually routes end-to-end.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ResortGraph, Route } from '../src/types/domain';
import { DEFAULT_PREFERENCES } from '../src/config/defaults';
import { planRoutes } from '../src/routing/plan';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

function loadGraph(id: string): ResortGraph {
  const p = path.join(ROOT, 'public', 'resorts', id, 'graph.json');
  if (!fs.existsSync(p)) {
    console.error(`No compiled graph at ${p}. Run: npm run data ${id}`);
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(p, 'utf8')) as ResortGraph;
}

function summarize(r: Route): string {
  const s = r.stats;
  return `${(s.totalDistanceM / 1000).toFixed(2)} km · ${Math.round(s.totalDurationS / 60)} min · ${s.liftCount} lift(s) · ↓${Math.round(s.descentM)} m · streak ${(s.longestDownhillStreakM / 1000).toFixed(2)} km`;
}

function route(graph: ResortGraph, fromNodeId: string, toNodeId: string) {
  return planRoutes(graph, {
    resortId: graph.resortId,
    fromNodeId,
    toNodeId,
    objective: 'fastest',
    timing: { mode: 'now' },
    prefs: DEFAULT_PREFERENCES,
  });
}

function main(): void {
  const [id, fromArg, toArg] = process.argv.slice(2);
  if (!id) {
    console.error('Usage: tsx pipeline/_routetest.ts <resortId> [fromNodeId] [toNodeId]');
    process.exit(1);
  }
  const graph = loadGraph(id);
  const label = (nid: string) => graph.points.find((x) => x.nodeId === nid)?.name ?? nid;

  if (fromArg && toArg) {
    const res = route(graph, fromArg, toArg);
    console.log(`=== routetest ${id}: ${label(fromArg)} -> ${label(toArg)} ===`);
    if (res.error) {
      console.log('  NO ROUTE: ' + res.error);
      return;
    }
    res.routes.forEach((r, i) => console.log(`  option ${i + 1}: ${summarize(r)}`));
    return;
  }

  // Smoke test: highest meaningful point -> every bottom-type point.
  const withEle = graph.points
    .map((p) => ({ p, ele: graph.nodes.find((n) => n.id === p.nodeId)?.point.ele ?? 0 }))
    .sort((a, b) => b.ele - a.ele);
  const top = withEle[0];
  const bottoms = graph.points.filter((p) => p.type === 'lift_bottom' || p.type === 'piste_bottom');
  if (!top || bottoms.length === 0) {
    console.log('Not enough meaningful points to smoke-test.');
    return;
  }
  console.log(`=== routetest ${id}: from "${top.p.name}" to ${bottoms.length} bottoms ===`);
  let ok = 0;
  const fails: string[] = [];
  for (const b of bottoms) {
    if (b.nodeId === top.p.nodeId) continue;
    const res = route(graph, top.p.nodeId, b.nodeId);
    if (res.error || res.routes.length === 0) fails.push(b.name);
    else ok++;
  }
  console.log(`  routed OK: ${ok}/${ok + fails.length}`);
  if (fails.length) console.log('  no route to: ' + fails.slice(0, 20).join(', ') + (fails.length > 20 ? ' …' : ''));
}

main();

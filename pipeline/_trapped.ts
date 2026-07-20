// Connectivity audit for a compiled resort graph.
// Usage: tsx pipeline/_trapped.ts <resortId>
//
// Reports two kinds of connectivity problems on public/resorts/<id>/graph.json:
//   - "trapped": nodes from which a skier CANNOT reach any lift station (they'd get stuck
//     at the bottom of a fragment with no way back up / onward).
//   - "orphan":  nodes NOT reachable FROM the lift network (you can never get there).
// Use this after `npm run data <id>` to find genuinely isolated fragments, then fix them
// via pipeline/overrides/<id>.json.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ResortGraph } from '../src/types/domain';

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

function bfs(adj: Map<string, string[]>, seeds: string[]): Set<string> {
  const seen = new Set<string>(seeds);
  const queue = [...seeds];
  while (queue.length) {
    const cur = queue.shift()!;
    for (const next of adj.get(cur) ?? []) {
      if (!seen.has(next)) {
        seen.add(next);
        queue.push(next);
      }
    }
  }
  return seen;
}

function main(): void {
  const id = process.argv[2];
  if (!id) {
    console.error('Usage: tsx pipeline/_trapped.ts <resortId>');
    process.exit(1);
  }
  const graph = loadGraph(id);
  const nodeById = new Map(graph.nodes.map((n) => [n.id, n]));

  const fwd = new Map<string, string[]>();
  const rev = new Map<string, string[]>();
  for (const e of graph.edges) {
    (fwd.get(e.from) ?? fwd.set(e.from, []).get(e.from)!).push(e.to);
    (rev.get(e.to) ?? rev.set(e.to, []).get(e.to)!).push(e.from);
  }

  const liftStations = graph.nodes.filter((n) => n.kind === 'lift_station').map((n) => n.id);
  const canReachLift = bfs(rev, liftStations); // can get FROM node TO a lift
  const reachableFromLift = bfs(fwd, liftStations); // can get FROM a lift TO node

  const trapped = graph.nodes.filter((n) => !canReachLift.has(n.id));
  const orphan = graph.nodes.filter((n) => !reachableFromLift.has(n.id));

  const label = (nid: string): string => {
    const p = graph.points.find((x) => x.nodeId === nid);
    const n = nodeById.get(nid);
    return `${p ? p.name : nid} · ${Math.round(n?.point.ele ?? 0)} m`;
  };

  console.log(`=== check:trapped ${id} ===`);
  console.log(`nodes=${graph.nodes.length} edges=${graph.edges.length} lift_stations=${liftStations.length}`);
  console.log(`\ntrapped (can't reach any lift → skier gets stuck): ${trapped.length}`);
  trapped.slice(0, 30).forEach((n) => console.log('  - ' + label(n.id)));
  if (trapped.length > 30) console.log(`  … and ${trapped.length - 30} more`);
  console.log(`\norphan (unreachable from the lift network): ${orphan.length}`);
  orphan.slice(0, 30).forEach((n) => console.log('  - ' + label(n.id)));
  if (orphan.length > 30) console.log(`  … and ${orphan.length - 30} more`);
  if (!trapped.length && !orphan.length) {
    console.log('\nOK: every node connects to the lift network both ways.');
  }
}

main();

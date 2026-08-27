// Connectivity audit for a compiled resort graph.
// Usage: tsx pipeline/_trapped.ts <resortId>
//
// Reports two kinds of connectivity problems on public/resorts/<id>/graph.json:
//   - "trapped": nodes from which a skier CANNOT reach any lift station (they'd get stuck
//     at the bottom of a fragment with no way back up / onward).
//   - "orphan":  nodes NOT reachable FROM the lift network (you can never get there).
//   - "trapped basin": terrain you can ski into that can never get back to the resort's main
//     body. `trapped` misses these because the skier *can* reach a lift; it simply doesn't get
//     them out. See lib/trappedBasins.ts for why this replaced a narrower "one-way pocket" test.
// Use this after `npm run data <id>` to find genuinely isolated fragments, then fix them
// via pipeline/overrides/<id>.json.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ResortGraph } from '../src/types/domain';
import { basinLabel, findTrappedBasins } from './lib/trappedBasins';

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
    return `${p ? p.name : nid} Â· ${Math.round(n?.point.ele ?? 0)} m`;
  };

  console.log(`=== check:trapped ${id} ===`);
  console.log(`nodes=${graph.nodes.length} edges=${graph.edges.length} lift_stations=${liftStations.length}`);
  console.log(`\ntrapped (can't reach any lift â†’ skier gets stuck): ${trapped.length}`);
  trapped.slice(0, 30).forEach((n) => console.log('  - ' + label(n.id)));
  if (trapped.length > 30) console.log(`  â€¦ and ${trapped.length - 30} more`);
  console.log(`\norphan (unreachable from the lift network): ${orphan.length}`);
  orphan.slice(0, 30).forEach((n) => console.log('  - ' + label(n.id)));
  if (orphan.length > 30) console.log(`  â€¦ and ${orphan.length - 30} more`);

  // Trapped basins: terrain you can ski into that can never get back to the main mountain.
  const report = findTrappedBasins(graph, id);
  console.log(
    `\ntrapped basins (ski in, no way back to the main body): ${report.significant.length}` +
      ` â€” ${report.significantNodes} stranded node(s)` +
      (report.basins.length > report.significant.length
        ? `, plus ${report.basins.length - report.significant.length} lone dead-end node(s)`
        : ''),
  );
  console.log(
    `main body: ${report.mainSize}/${graph.nodes.length} nodes (${(report.mainShare * 100).toFixed(0)}%)`,
  );
  report.significant.slice(0, 15).forEach((b) => {
    console.log(
      `  - ${String(b.nodes.length).padStart(4)} node(s), ${b.lifts.length} lift(s), ` +
        `gap ${b.gapM}m, exit ${b.climbM >= 0 ? '+' : ''}${b.climbM}m â€” ${basinLabel(b)}` +
        ` (e.g. ${label(b.exit.id)})`,
    );
  });
  if (report.significant.length > 15)
    console.log(`  â€¦ and ${report.significant.length - 15} more`);

  console.log(
    `\nsummary: trapped=${trapped.length} orphan=${orphan.length}` +
      ` basins=${report.significant.length} strandedNodes=${report.significantNodes}`,
  );
  if (!trapped.length && !orphan.length && !report.significant.length) {
    console.log('\nOK: every node connects to the lift network both ways.');
  }
}

main();

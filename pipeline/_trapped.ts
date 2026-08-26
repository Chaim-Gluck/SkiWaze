// Connectivity audit for a compiled resort graph.
// Usage: tsx pipeline/_trapped.ts <resortId>
//
// Reports two kinds of connectivity problems on public/resorts/<id>/graph.json:
//   - "trapped": nodes from which a skier CANNOT reach any lift station (they'd get stuck
//     at the bottom of a fragment with no way back up / onward).
//   - "orphan":  nodes NOT reachable FROM the lift network (you can never get there).
//   - "one-way pocket": a group you can ski into, that has a lift inside it, and that you
//     still cannot leave — riding the lift just returns you to the same pocket. `trapped`
//     misses these because the skier *can* reach a lift; it simply doesn't get them out.
//     The resort's own main body is absorbing too (nothing leaves a resort), so the largest
//     pocket is excluded as the expected drain.
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

/** Kosaraju strongly-connected components, iterative so a 5k-node resort can't blow the stack. */
function stronglyConnected(
  nodeIds: string[],
  fwd: Map<string, string[]>,
  rev: Map<string, string[]>,
): Map<string, number> {
  const order: string[] = [];
  const seen = new Set<string>();
  for (const start of nodeIds) {
    if (seen.has(start)) continue;
    seen.add(start);
    const stack: [string, number][] = [[start, 0]];
    while (stack.length) {
      const top = stack[stack.length - 1];
      const outs = fwd.get(top[0]) ?? [];
      if (top[1] < outs.length) {
        const next = outs[top[1]++];
        if (!seen.has(next)) {
          seen.add(next);
          stack.push([next, 0]);
        }
      } else {
        order.push(top[0]);
        stack.pop();
      }
    }
  }
  const comp = new Map<string, number>();
  let c = 0;
  for (let i = order.length - 1; i >= 0; i--) {
    const seed = order[i];
    if (comp.has(seed)) continue;
    const stack = [seed];
    comp.set(seed, c);
    while (stack.length) {
      const cur = stack.pop()!;
      for (const prev of rev.get(cur) ?? []) {
        if (!comp.has(prev)) {
          comp.set(prev, c);
          stack.push(prev);
        }
      }
    }
    c++;
  }
  return comp;
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

  // One-way pockets: you can get in, there's a lift, and you still can't get out.
  const comp = stronglyConnected(
    graph.nodes.map((n) => n.id),
    fwd,
    rev,
  );
  const members = new Map<number, string[]>();
  for (const n of graph.nodes) {
    const c = comp.get(n.id)!;
    (members.get(c) ?? members.set(c, []).get(c)!).push(n.id);
  }
  const pockets: { ids: string[]; lifts: string[] }[] = [];
  for (const ids of members.values()) {
    const inside = new Set(ids);
    const escapes = ids.some((id) => (fwd.get(id) ?? []).some((v) => !inside.has(v)));
    const entered = ids.some((id) => (rev.get(id) ?? []).some((v) => !inside.has(v)));
    if (escapes || !entered) continue;
    const lifts = [
      ...new Set(
        graph.edges
          .filter((e) => e.kind === 'lift' && inside.has(e.from) && inside.has(e.to))
          .map((e) => e.liftName ?? 'unnamed lift'),
      ),
    ];
    if (lifts.length) pockets.push({ ids, lifts });
  }
  // Everything drains into the resort's main body and nothing leaves a resort, so a pocket
  // holding a large share of the mountain is the expected drain, not a defect.
  const suspect = pockets.filter((p) => p.ids.length < graph.nodes.length * 0.25);
  console.log(`\none-way pockets (ski in, lift inside, no way out): ${suspect.length}`);
  suspect.slice(0, 15).forEach((p) => {
    console.log(`  - ${p.ids.length} node(s) via ${p.lifts.join(', ')} — e.g. ${label(p.ids[0])}`);
  });
  if (suspect.length > 15) console.log(`  … and ${suspect.length - 15} more`);

  console.log(
    `\nsummary: trapped=${trapped.length} orphan=${orphan.length} oneWayPockets=${suspect.length}`,
  );
  if (!trapped.length && !orphan.length && !suspect.length) {
    console.log('\nOK: every node connects to the lift network both ways.');
  }
}

main();

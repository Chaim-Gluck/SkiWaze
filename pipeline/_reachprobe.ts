// Raw forward-reachability probe: BFS from the highest node over ALL out-edges,
// ignoring routing preferences. Answers "did the graph lose connectivity?" separately
// from "did the planner reject the new edges?".
// Usage: tsx pipeline/_reachprobe.ts <graph.json> [label]
import fs from 'node:fs';
import type { ResortGraph } from '../src/types/domain';

const file = process.argv[2];
const label = process.argv[3] ?? file;
const g = JSON.parse(fs.readFileSync(file, 'utf8')) as ResortGraph;

const out = new Map<string, string[]>();
for (const e of g.edges) {
  if (!out.has(e.from)) out.set(e.from, []);
  out.get(e.from)!.push(e.to);
}

let top = g.nodes[0];
for (const n of g.nodes) if (n.point.ele > top.point.ele) top = n;

const seen = new Set<string>([top.id]);
const q = [top.id];
while (q.length) {
  const cur = q.pop()!;
  for (const nx of out.get(cur) ?? []) if (!seen.has(nx)) { seen.add(nx); q.push(nx); }
}

console.log(`${label}: from ${top.id} (${Math.round(top.point.ele)} m) reaches ${seen.size}/${g.nodes.length} nodes`);
const miss = g.nodes.filter((n) => !seen.has(n.id));
console.log(`  unreachable: ${miss.length}`);
console.log(`  sample: ${miss.slice(0, 15).map((n) => `${n.id}@${Math.round(n.point.ele)}`).join(' ')}`);

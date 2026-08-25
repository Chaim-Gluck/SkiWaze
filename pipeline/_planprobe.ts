/**
 * Throwaway probe for the routing backlog (free connectors / weak dedup).
 *
 * The question is narrow: **when a shorter feasible path exists, does the planner still return a
 * longer one?** So the yardstick is not straight-line distance (pistes are one-way, so a 40 m gap
 * can legitimately cost a 4 km loop) but the shortest path the graph actually allows, found with
 * the same edge filter the planner uses and weighted by metres.
 *
 *   npx tsx pipeline/_planprobe.ts <resortId> [maxPairs]
 */
import { readFileSync } from 'node:fs';
import { planRoutes } from '../src/routing/plan';
import { GraphIndex } from '../src/routing/graphIndex';
import { edgeCost } from '../src/routing/cost';
import { DEFAULT_PREFERENCES } from '../src/config/defaults';
import type { ResortGraph } from '../src/types/domain';

const id = process.argv[2];
const maxPairs = Number(process.argv[3] ?? 200);
if (!id) throw new Error('usage: _planprobe.ts <resortId> [maxPairs]');

const graph: ResortGraph = JSON.parse(readFileSync(`public/resorts/${id}/graph.json`, 'utf8'));
const index = new GraphIndex(graph);
const now = new Date();

/** Shortest allowed path by metres (not by time) — the floor any option should be measured against. */
function shortestMetres(from: string, to: string): number {
  const dist = new Map<string, number>([[from, 0]]);
  const queue: [number, string][] = [[0, from]];
  const done = new Set<string>();
  while (queue.length) {
    queue.sort((a, b) => a[0] - b[0]);
    const [d, cur] = queue.shift()!;
    if (done.has(cur)) continue;
    done.add(cur);
    if (cur === to) return d;
    for (const e of index.outEdges(cur)) {
      if (!edgeCost(e, DEFAULT_PREFERENCES, now).allowed) continue;
      const nd = d + e.lengthM;
      if (nd < (dist.get(e.to) ?? Infinity)) {
        dist.set(e.to, nd);
        queue.push([nd, e.to]);
      }
    }
  }
  return Infinity;
}

function hav(a: { lon: number; lat: number }, b: { lon: number; lat: number }): number {
  const k = Math.cos(((a.lat + b.lat) / 2) * (Math.PI / 180));
  return Math.hypot((a.lon - b.lon) * k, a.lat - b.lat) * 111320;
}

// Deterministic pair selection so before/after runs compare the same hops.
const nodes = [...graph.nodes].sort((a, b) => (a.id < b.id ? -1 : 1));
const pairs: [string, string][] = [];
for (let i = 0; i < nodes.length && pairs.length < maxPairs; i += Math.max(1, Math.floor(nodes.length / maxPairs))) {
  const a = nodes[i];
  let best: string | undefined;
  let bestD = Infinity;
  for (const b of nodes) {
    if (b.id === a.id) continue;
    const d = hav(a.point, b.point);
    if (d > 40 && d < 400 && d < bestD) {
      bestD = d;
      best = b.id;
    }
  }
  if (best) pairs.push([a.id, best]);
}

let planned = 0;
let optCount = 0;
let connFrac = 0;
let excess = 0;
let overLong = 0;
let worst = { pair: '', ratio: 0, m: 0, floor: 0 };

for (const [from, to] of pairs) {
  const floor = shortestMetres(from, to);
  if (!Number.isFinite(floor) || floor <= 0) continue;
  const res = planRoutes(graph, { fromNodeId: from, toNodeId: to, prefs: DEFAULT_PREFERENCES, timing: { mode: 'now' } });
  const r = res.routes[0];
  if (!r) continue;
  planned++;
  optCount += res.routes.length;
  const conn = r.legs.filter((l) => l.kind === 'connector').reduce((s, l) => s + l.distanceM, 0);
  connFrac += conn / Math.max(1, r.stats.totalDistanceM);
  const ratio = r.stats.totalDistanceM / floor;
  excess += ratio;
  if (ratio > 1.25) overLong++;
  if (ratio > worst.ratio) worst = { pair: `${from}->${to}`, ratio, m: r.stats.totalDistanceM, floor };
}

console.log(
  `${id}: pairs=${planned} meanOptions=${(optCount / planned).toFixed(2)} ` +
    `meanConnectorShare=${((connFrac / planned) * 100).toFixed(1)}% ` +
    `meanOption1/shortest=${(excess / planned).toFixed(3)}x ` +
    `over1.25x=${overLong}`,
);
console.log(`  worst ${worst.ratio.toFixed(2)}x  ${worst.m.toFixed(0)}m vs ${worst.floor.toFixed(0)}m shortest  ${worst.pair}`);

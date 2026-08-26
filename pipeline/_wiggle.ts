/**
 * Measure the penalty-method artefact directly: how often does a returned option contain a
 * stretch that a plain unpenalised search would have done more cheaply?
 *
 * That is the "why did it wiggle out and straight back" defect, and unlike option-1 distance it
 * is unaffected by which candidate happens to rank first. Self-contained (imports only cost /
 * graphIndex / plan) so the same file runs against any revision of alternatives.ts.
 *
 * Two things here exist to make an A/B across two *datasets* honest, and both were learned the
 * hard way when this probe reported that the weld pass had doubled Sella's detour rate:
 *
 *  - Pairs are sampled by **position**, not by node id. Sorting by id and stepping through the
 *    list means any pass that adds or removes nodes silently samples a different set of pairs,
 *    so the two sides of the A/B are not the same test.
 *  - Only `fastest` options are scored. `cost.ts` special-cases just `preferred` and
 *    `fewest_lifts`, so a `longest_ab` option gets priced as if it were `fastest` — it is
 *    deliberately not the cheapest path and would count as a detour every single time.
 *
 *   npx tsx pipeline/_wiggle.ts <resortId> [maxPairs]
 */
import { readFileSync } from 'node:fs';
import { planRoutes } from '../src/routing/plan';
import { GraphIndex } from '../src/routing/graphIndex';
import { edgeCost } from '../src/routing/cost';
import { DEFAULT_PREFERENCES } from '../src/config/defaults';
import type { GraphEdge, ResortGraph } from '../src/types/domain';

const id = process.argv[2];
const maxPairs = Number(process.argv[3] ?? 100);
if (!id) throw new Error('usage: _wiggle.ts <resortId> [maxPairs]');

const graph: ResortGraph = JSON.parse(readFileSync(`public/resorts/${id}/graph.json`, 'utf8'));
const index = new GraphIndex(graph);
const now = new Date();
const byId = new Map(graph.edges.map((e) => [e.id, e]));

let OBJ: any = 'fastest';
const WINDOW_M = 400;
const RATIO = 0.8;
const MIN_GAIN = 10;

function cheapestWithin(start: string, cutoff: number): Map<string, number> {
  const weight = new Map<string, number>([[start, 0]]);
  const queue: [number, string][] = [[0, start]];
  const done = new Set<string>();
  while (queue.length) {
    queue.sort((a, b) => a[0] - b[0]);
    const [w, cur] = queue.shift()!;
    if (done.has(cur)) continue;
    done.add(cur);
    for (const e of index.outEdges(cur)) {
      const c = edgeCost(e, DEFAULT_PREFERENCES, now, OBJ);
      if (!c.allowed || !Number.isFinite(c.weight)) continue;
      const next = w + c.weight;
      if (next > cutoff) continue;
      if (next < (weight.get(e.to) ?? Infinity)) {
        weight.set(e.to, next);
        queue.push([next, e.to]);
      }
    }
  }
  return weight;
}

/** Metres of the route that a cheaper local shortcut could have replaced. */
function detourMetres(edges: GraphEdge[]): number {
  const nodes = [edges[0].from, ...edges.map((e) => e.to)];
  const w = edges.map((e) => edgeCost(e, DEFAULT_PREFERENCES, now, OBJ).weight);
  let worst = 0;
  for (let i = 0; i < nodes.length - 2; i++) {
    const targets = new Map<string, { j: number; weight: number; dist: number }>();
    let dist = 0;
    let acc = 0;
    for (let j = i; j < edges.length; j++) {
      dist += edges[j].lengthM;
      acc += w[j];
      if (dist > WINDOW_M) break;
      targets.set(nodes[j + 1], { j: j + 1, weight: acc, dist });
    }
    if (!targets.size) continue;
    const cutoff = Math.max(...[...targets.values()].map((t) => t.weight));
    const reach = cheapestWithin(nodes[i], cutoff);
    for (const [nid, t] of targets) {
      const got = reach.get(nid);
      if (got == null) continue;
      if (got <= t.weight * RATIO && t.weight - got >= MIN_GAIN) worst = Math.max(worst, t.dist);
    }
  }
  return worst;
}

function hav(a: { lon: number; lat: number }, b: { lon: number; lat: number }): number {
  const k = Math.cos(((a.lat + b.lat) / 2) * (Math.PI / 180));
  return Math.hypot((a.lon - b.lon) * k, a.lat - b.lat) * 111320;
}

const nodes = [...graph.nodes].sort((a, b) => a.point.lat - b.point.lat || a.point.lon - b.point.lon);
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

let options = 0;
let withDetour = 0;
let totalDetour = 0;
let worst = 0;
for (const [from, to] of pairs) {
  const res = planRoutes(graph, { fromNodeId: from, toNodeId: to, prefs: DEFAULT_PREFERENCES, timing: { mode: 'now' } });
  for (const r of res.routes) {
    const edges = r.legs.map((l) => byId.get(l.edgeId!)).filter(Boolean) as GraphEdge[];
    if (edges.length < 2) continue;
    if (r.objective !== 'fastest') continue;
    options++;
    OBJ = r.objective;
    const d = detourMetres(edges);
    if (d > 0) {
      withDetour++;
      totalDetour += d;
      worst = Math.max(worst, d);
    }
  }
}
console.log(
  `${id}: options=${options} withDetour=${withDetour} (${((withDetour / options) * 100).toFixed(1)}%) ` +
    `meanDetourM=${(totalDetour / Math.max(1, withDetour)).toFixed(0)} worstM=${worst.toFixed(0)}`,
);

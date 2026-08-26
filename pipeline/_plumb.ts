/**
 * How much invented plumbing (polygon arms / spine duplicates) ends up inside Longest A->B
 * routes, with and without the smoothing pass.
 *
 * "before" replicates the old longestDownhillPaths loop (raw DP + 0.55 diversity penalty, no
 * smoothing); "after" calls the real function. Reports the share of options that contain any
 * plumbing and the mean plumbing metres per option.
 *
 *   npx tsx pipeline/_plumb.ts <resortId> [maxPairs]
 */
import { readFileSync } from 'node:fs';
import { GraphIndex } from '../src/routing/graphIndex';
import { longestDownhillPath, longestDownhillPaths } from '../src/routing/longestStreak';
import type { ResortGraph, GraphEdge } from '../src/types/domain';

const id = process.argv[2];
const maxPairs = Number(process.argv[3] ?? 60);
const graph: ResortGraph = JSON.parse(readFileSync(`public/resorts/${id}/graph.json`, 'utf8'));
const minDrop = Number(process.argv[4] ?? 120);
const index = new GraphIndex(graph);

const isPlumbing = (e: GraphEdge) => !!(e.skeletonArm || e.spineDuplicate);

/** The pre-fix loop, kept here so the A/B runs in one process against one dataset. */
function oldPaths(from: string, to: string, k = 3): GraphEdge[][] {
  const accepted: GraphEdge[][] = [];
  const penalties = new Map<string, number>();
  for (let attempt = 0; attempt < k * 4 && accepted.length < k; attempt++) {
    const chain = longestDownhillPath(index, from, to, Infinity, penalties);
    if (chain.length === 0) break;
    const dup = accepted.some((r) => r.length === chain.length && r.every((e, i) => e.id === chain[i].id));
    const candLen = chain.reduce((s, e) => s + e.lengthM, 0) || 1;
    const ids = new Set(chain.map((e) => e.id));
    let overlap = 0;
    for (const r of accepted) {
      let shared = 0;
      for (const e of r) if (ids.has(e.id)) shared += e.lengthM;
      overlap = Math.max(overlap, shared / candLen);
    }
    if (!dup && (accepted.length === 0 || overlap <= 0.7)) accepted.push(chain);
    for (const e of chain) penalties.set(e.id, (penalties.get(e.id) ?? 1) * 0.55);
  }
  return accepted;
}

// Pick a *nearby* lower node: an A->B pair only has a lift-free descent when B is downhill and
// reasonably close, so a far-flung partner just returns nothing and wastes the sample.
const nodes = [...graph.nodes].sort((a, b) => a.point.lat - b.point.lat || a.point.lon - b.point.lon);
const pairs: [string, string][] = [];
for (let i = 0; i < nodes.length && pairs.length < maxPairs; i++) {
  const a = nodes[i];
  for (let d = 5; d <= 400; d += 5) {
    const b = nodes[i + d];
    if (b && a.point.ele - b.point.ele > minDrop) {
      pairs.push([a.id, b.id]);
      break;
    }
  }
}

const tally = { opts: 0, withPlumb: 0, plumbM: 0 };
const stats = { before: { ...tally }, after: { ...tally } };
for (const [from, to] of pairs) {
  for (const [key, paths] of [
    ['before', oldPaths(from, to)],
    ['after', longestDownhillPaths(index, from, to, Infinity, 3)],
  ] as const) {
    for (const p of paths) {
      const m = p.filter(isPlumbing).reduce((s, e) => s + e.lengthM, 0);
      stats[key].opts++;
      if (m > 0) stats[key].withPlumb++;
      stats[key].plumbM += m;
    }
  }
}

for (const key of ['before', 'after'] as const) {
  const s = stats[key];
  console.log(
    `${id} ${key.padEnd(6)} options=${s.opts} withPlumbing=${s.withPlumb} ` +
      `(${((s.withPlumb / Math.max(1, s.opts)) * 100).toFixed(1)}%) meanPlumbingM=${(s.plumbM / Math.max(1, s.opts)).toFixed(0)}`,
  );
}

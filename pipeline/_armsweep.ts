/**
 * Sweep the arm penalty in cost.ts and report, per value, both the thing we want to improve
 * (how much invented plumbing routes actually use) and the thing that could regress (local
 * detours, i.e. a route buying its way around a priced arm the long way).
 *
 * Run as a child process per value so each gets a fresh module graph:
 *   npx tsx pipeline/_armsweep.ts <resortId> [maxPairs]
 */
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const id = process.argv[2];
const maxPairs = Number(process.argv[3] ?? 120);
const value = process.env.ARMP;

if (!value) {
  for (const v of ['1', '1.25', '1.5', '2', '3']) {
    const out = execFileSync(process.execPath, ['--import', 'tsx', process.argv[1], id, String(maxPairs)], {
      env: { ...process.env, ARMP: v },
      encoding: 'utf8',
    });
    process.stdout.write(out);
  }
} else {
  (globalThis as Record<string, unknown>).__SKIWAZE_ARM_PENALTY = Number(value);
  const { GraphIndex } = await import('../src/routing/graphIndex');
  const { planRoutes } = await import('../src/routing/plan');
  const { DEFAULT_PREFERENCES } = await import('../src/config/defaults');
  const { edgeCost } = await import('../src/routing/cost');
  const { shortestPath } = await import('../src/routing/dijkstra');
  type G = import('../src/types/domain').ResortGraph;
  type E = import('../src/types/domain').GraphEdge;

  const graph: G = JSON.parse(readFileSync(`public/resorts/${id}/graph.json`, 'utf8'));
  const index = new GraphIndex(graph);
  const byId = new Map(graph.edges.map((e) => [e.id, e]));
  const start = new Date();

  const nodes = [...graph.nodes].sort((a, b) => a.point.lat - b.point.lat || a.point.lon - b.point.lon);
  const pairs: [string, string][] = [];
  for (let i = 0; i < nodes.length && pairs.length < maxPairs; i += Math.max(1, Math.floor(nodes.length / maxPairs))) {
    const a = nodes[i];
    const b = nodes[(i + Math.floor(nodes.length / 3)) % nodes.length];
    if (a && b && a.id !== b.id) pairs.push([a.id, b.id]);
  }

  const w = (e: E) => { const c = edgeCost(e, DEFAULT_PREFERENCES, start); return c.allowed ? c.weight : Infinity; };
  const isPlumb = (e: E) => !!(e.skeletonArm || e.spineDuplicate);

  let opts = 0, plumbM = 0, totalM = 0, detours = 0, detourM = 0;
  for (const [from, to] of pairs) {
    const res = planRoutes(graph, { fromNodeId: from, toNodeId: to, prefs: DEFAULT_PREFERENCES, timing: { mode: 'now' } });
    for (const r of res.routes) {
      if (r.objective !== 'fastest') continue;
      const edges = r.legs.map((l) => byId.get(l.edgeId!)).filter(Boolean) as E[];
      if (edges.length < 2) continue;
      opts++;
      for (const e of edges) { totalM += e.lengthM; if (isPlumb(e)) plumbM += e.lengthM; }
      // Local detour: any sub-stretch a plain unpenalised search would do more cheaply.
      let worst = 0;
      for (let i = 0; i < edges.length; i++) {
        for (let j = i + 2; j <= Math.min(edges.length, i + 8); j++) {
          const seg = edges.slice(i, j);
          const cost = seg.reduce((s, e) => s + w(e), 0);
          if (!isFinite(cost)) continue;
          const alt = shortestPath(index, seg[0].from, seg[seg.length - 1].to, DEFAULT_PREFERENCES, start);
          if (!alt || !alt.edges.length) continue;
          const altCost = alt.edges.reduce((s, e) => s + w(e), 0);
          if (cost - altCost > 10) {
            const gap = seg.reduce((s, e) => s + e.lengthM, 0) - alt.edges.reduce((s, e) => s + e.lengthM, 0);
            worst = Math.max(worst, gap);
          }
        }
      }
      if (worst > 0) { detours++; detourM += worst; }
    }
  }
  console.log(
    `armPenalty=${String(value).padEnd(5)} options=${opts} plumbingShare=${((plumbM / Math.max(1, totalM)) * 100).toFixed(2)}% ` +
      `detours=${detours} (${((detours / Math.max(1, opts)) * 100).toFixed(1)}%) meanDetourM=${(detourM / Math.max(1, detours)).toFixed(0)}`,
  );
}

import type { GraphEdge } from '../types/domain';
import type { GraphIndex } from './graphIndex';

/**
 * Extract up to `k` diverse longest lift-free runs. Builds the DAG/DP once, then greedily
 * picks the highest-scoring start nodes whose reconstructed chain does not substantially
 * overlap an already-chosen run, so the carousel shows genuinely different runs.
 */
export function longestDownhillRuns(index: GraphIndex, maxColorRank = Infinity, k = 3): GraphEdge[][] {
  const eleOf = new Map<string, number>();
  for (const [id, n] of index.nodes) eleOf.set(id, n.point.ele ?? 0);

  const colorRank = (e: GraphEdge): number => {
    if (e.kind !== 'piste') return 0; // connectors carry no colour restriction
    switch (e.color) {
      case 'green': return 0;
      case 'blue': return 1;
      case 'red': return 2;
      case 'black': return 3;
      default: return 4;
    }
  };

  // Candidate adjacency: every non-lift edge within the user's colour rank.
  const adj = new Map<string, GraphEdge[]>();
  for (const [from, edges] of index.out) {
    const kept = edges.filter((e) => e.kind !== 'lift' && colorRank(e) <= maxColorRank);
    if (kept.length) adj.set(from, kept);
  }

  // DFS roots ordered high elevation first so the DAG follows gravity.
  const roots = [...index.nodes.keys()].sort(
    (a, b) => eleOf.get(b)! - eleOf.get(a)! || (a < b ? -1 : a > b ? 1 : 0),
  );

  // Iterative DFS. state: 0 unvisited, 1 on-stack (grey), 2 done (black).
  // Edges to grey nodes are back-edges (would form a cycle) and are dropped; all other
  // edges are kept, yielding a DAG. Post-order (finish order) is reverse-topological.
  const state = new Map<string, number>();
  const dagOut = new Map<string, GraphEdge[]>();
  const finished: string[] = [];

  for (const root of roots) {
    if (state.get(root)) continue;
    const stack: { id: string; i: number }[] = [{ id: root, i: 0 }];
    state.set(root, 1);
    while (stack.length) {
      const top = stack[stack.length - 1];
      const edges = adj.get(top.id) ?? [];
      if (top.i < edges.length) {
        const e = edges[top.i++];
        const s = state.get(e.to) ?? 0;
        if (s === 1) continue; // back-edge -> drop to keep acyclic
        let out = dagOut.get(top.id);
        if (!out) dagOut.set(top.id, (out = []));
        out.push(e);
        if (s === 0) {
          state.set(e.to, 1);
          stack.push({ id: e.to, i: 0 });
        }
      } else {
        state.set(top.id, 2);
        finished.push(top.id);
        stack.pop();
      }
    }
  }

  // Longest-path DP over the DAG. Finish order is reverse-topological, so a node's DAG
  // targets are already resolved when we process it.
  // Score used to pick the "best" run. We reward actual downhill skiing distance and
  // penalise flat/connector padding and app-added (synthetic) bridges, so the longest run
  // is a natural continuous descent rather than a distance-maximising zig-zag that weaves
  // through lift-base junctions to rack up metres. Penalised edges are still allowed (for
  // connectivity) — they just don't inflate the score.
  const scoreOf = (e: GraphEdge): number => {
    let s = e.dropM < -1 ? e.lengthM : -0.75 * e.lengthM;
    if (e.synthetic) s -= 3 * e.lengthM;
    return s;
  };

  const dp = new Map<string, number>();
  const choice = new Map<string, GraphEdge>();
  for (const id of finished) {
    let best = 0;
    let bestEdge: GraphEdge | undefined;
    for (const e of dagOut.get(id) ?? []) {
      const cand = scoreOf(e) + (dp.get(e.to) ?? 0);
      if (cand > best) {
        best = cand;
        bestEdge = e;
      }
    }
    dp.set(id, best);
    if (bestEdge) choice.set(id, bestEdge);
  }

  const reconstruct = (start: string): GraphEdge[] => {
    const chain: GraphEdge[] = [];
    let cur: string | undefined = start;
    const guard = new Set<string>();
    while (cur && choice.has(cur) && !guard.has(cur)) {
      guard.add(cur);
      const e: GraphEdge = choice.get(cur)!;
      chain.push(e);
      cur = e.to;
    }
    return chain;
  };

  // Candidate starts by descending run length.
  const starts = [...dp.entries()]
    .filter(([, d]) => d > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([id]) => id);

  const runs: GraphEdge[][] = [];
  const usedEdges = new Set<string>();
  for (const s of starts) {
    if (runs.length >= k) break;
    const chain = reconstruct(s);
    if (chain.length === 0) continue;
    let overlap = 0;
    for (const e of chain) if (usedEdges.has(e.id)) overlap++;
    // Reject near-duplicates (mostly sub-chains of an already-chosen run).
    if (runs.length > 0 && overlap / chain.length > 0.6) continue;
    runs.push(chain);
    for (const e of chain) usedEdges.add(e.id);
  }
  return runs;
}

/**
 * Find the single longest uninterrupted (lift-free) run in the graph — the longest chain of
 * pistes, skiable connectors AND flat/near-flat traverses (cat-tracks), matching how a
 * route's "longest streak" stat is counted (any non-lift leg continues the run).
 *
 * The non-lift sub-graph is almost a DAG (gravity-oriented pistes) but flat_traverse and
 * capped cat-track edges are bidirectional, so a naive elevation ordering drops legs that
 * a real route would ski (a run can cross a flat or coast over a small rise). We instead
 * build a DAG by running DFS from the highest nodes downward and dropping only genuine
 * back-edges; that orients flats/small climbs in the descent direction and never cuts a
 * run short at a cat-track. Longest path is then a simple DP over the DAG.
 *
 * Returns the ordered edge chain of the run (empty if none).
 */
export function longestDownhillStreak(index: GraphIndex, maxColorRank = Infinity): GraphEdge[] {
  return longestDownhillRuns(index, maxColorRank, 1)[0] ?? [];
}

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
  // Per-edge geometry stats: straight-line progress and internal uphill. A well-formed
  // descent leg drops monotonically along a roughly direct line. Some OSM piste ways (or
  // pipeline-concatenated ways) switchback or self-cross: they ski down into a dip and climb
  // back out, so the edge has large internal uphill and its path length far exceeds the
  // straight-line progress. The DAG/DP would otherwise LOVE those edges because raw length is
  // rewarded — producing the "doubling-back" loops the map shows. We cache the stats here and
  // use them in scoreOf to reward straight-line progress rather than winding length, and to
  // penalise internal climbing.
  const mBetween = (a: { lon: number; lat: number }, b: { lon: number; lat: number }) =>
    Math.hypot((a.lon - b.lon) * Math.cos((a.lat * Math.PI) / 180) * 111320, (a.lat - b.lat) * 110540);
  const straightOf = new Map<string, number>();
  const uphillOf = new Map<string, number>();
  for (const e of index.edgeById.values()) {
    const g = e.geometry;
    straightOf.set(e.id, g.length >= 2 ? mBetween(g[0], g[g.length - 1]) : e.lengthM);
    let up = 0;
    for (let i = 1; i < g.length; i++) {
      const d = (g[i].ele ?? 0) - (g[i - 1].ele ?? 0);
      if (d > 0) up += d;
    }
    uphillOf.set(e.id, up);
  }

  const scoreOf = (e: GraphEdge): number => {
    // Reward real downhill skiing distance; lightly discourage flat/connector padding so the
    // run stays a natural descent; still kill pipeline-inferred bridge padding (−3×) — but
    // never penalise the user's own custom links (they're deliberately drawn = real terrain).
    // Reward the STRAIGHT-LINE progress an edge makes plus only a small credit for the extra
    // winding length, so a piste that switchbacks/loops back on itself is not preferred over a
    // straight alternative just because it racks up metres. Penalise internal uphill hard
    // (climbing mid-piste is the visible "doubling-back"): each metre climbed costs 8×.
    const straight = straightOf.get(e.id) ?? e.lengthM;
    const wind = Math.max(0, e.lengthM - straight); // extra length beyond a straight line
    let s =
      e.dropM < -1 ? straight + 0.25 * wind : -0.75 * e.lengthM;
    s -= 8 * (uphillOf.get(e.id) ?? 0);
    if (e.synthetic && !e.custom) s -= 3 * e.lengthM;
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

  const posOf = (id: string) => index.node(id)?.point;
  const bearingOf = (e: GraphEdge): number => {
    const g = e.geometry;
    const a = g[0];
    const b = g[g.length - 1];
    return Math.atan2(b.lon - a.lon, b.lat - a.lat);
  };
  const reverses = (prev: GraphEdge | undefined, e: GraphEdge): boolean => {
    if (!prev) return false;
    let d = Math.abs(bearingOf(prev) - bearingOf(e));
    d = Math.min(d, 2 * Math.PI - d);
    return d > 1.9; // > ~109°: the leg turns back on the previous one (flat-junction hook)
  };
  const reconstruct = (start: string): GraphEdge[] => {
    const chain: GraphEdge[] = [];
    const guard = new Set<string>();
    const visitedPos: { lon: number; lat: number }[] = [];
    const RET = 22; // metres — a continuation whose target lands this close to an
    const startPos = posOf(start);
    if (startPos) visitedPos.push(startPos);
    // earlier-visited node (older than the last 2) is treated as doubling back.
    const returnsNearVisited = (id: string): boolean => {
      const p = posOf(id);
      if (!p) return false;
      for (let i = 0; i < visitedPos.length - 2; i++) {
        const q = visitedPos[i];
        const dx = (p.lon - q.lon) * Math.cos((p.lat * Math.PI) / 180) * 111320;
        const dy = (p.lat - q.lat) * 110540;
        if (Math.hypot(dx, dy) < RET) return true;
      }
      return false;
    };
    let cur: string | undefined = start;
    let prevEdge: GraphEdge | undefined;
    while (cur && !guard.has(cur)) {
      guard.add(cur);
      const opt = choice.get(cur);
      if (!opt) break;
      const optVal = scoreOf(opt) + (dp.get(opt.to) ?? 0);
      // A step "doubles back" if it returns near an earlier-visited node OR sharply reverses
      // the previous leg's direction (the flat-junction hook). When the DP-optimal step does,
      // prefer the best continuation that doesn't — but only when it's nearly as long (>=85%),
      // so we never trade a much longer descent for a marginally cleaner line.
      const doublesBack = (e: GraphEdge): boolean => returnsNearVisited(e.to) || reverses(prevEdge, e);
      let next = opt;
      if (doublesBack(opt)) {
        let bestClean: GraphEdge | undefined;
        let bestCleanVal = 0;
        for (const e of dagOut.get(cur) ?? []) {
          if (doublesBack(e)) continue;
          const val = scoreOf(e) + (dp.get(e.to) ?? 0);
          if (val > bestCleanVal) {
            bestCleanVal = val;
            bestClean = e;
          }
        }
        if (bestClean && bestCleanVal >= optVal * 0.85) next = bestClean;
      }
      chain.push(next);
      prevEdge = next;
      cur = next.to;
      const np = posOf(cur);
      if (np) visitedPos.push(np);
    }
    return chain;
  };

  // Flat-smoothing post-pass. OSM maps flat junction areas (lift bases, mid-mountain
  // plateaus) as a dense mesh of near-zero-slope traverse edges. The DAG/DP threads through
  // that mesh to reach the continuing descent and often overshoots then doubles back (a
  // "flat-junction hook"): every leg sits at the same elevation, so it is padding, not
  // skiing. For each maximal run of flat legs (no real descent) we substitute the shortest
  // flat crossing between the run's entry and exit nodes. This strips zig-zags/spurs without
  // touching any descent leg (so vertical drop and the real ski distance are preserved) and
  // can never disconnect the chain (entry and exit are unchanged, the crossing stays inside
  // the same flat sub-mesh). Non-custom synthetic bridges are excluded so smoothing never
  // introduces a dotted-magenta warning edge the original run didn't already use.
  const isFlatLeg = (e: GraphEdge) =>
    e.kind !== 'lift' && e.dropM > -2 && colorRank(e) <= maxColorRank && !(e.synthetic && !e.custom);
  const shortestFlat = (entry: string, exit: string): GraphEdge[] | null => {
    if (entry === exit) return [];
    const dist = new Map<string, number>([[entry, 0]]);
    const prevE = new Map<string, GraphEdge>();
    const pq: { d: number; id: string }[] = [{ d: 0, id: entry }];
    while (pq.length) {
      let bi = 0;
      for (let i = 1; i < pq.length; i++) if (pq[i].d < pq[bi].d) bi = i;
      const { d, id: u } = pq.splice(bi, 1)[0];
      if (u === exit) break;
      if (d > (dist.get(u) ?? Infinity)) continue;
      for (const e of index.outEdges(u)) {
        if (!isFlatLeg(e)) continue;
        const nd = d + e.lengthM;
        if (nd < (dist.get(e.to) ?? Infinity)) {
          dist.set(e.to, nd);
          prevE.set(e.to, e);
          pq.push({ d: nd, id: e.to });
        }
      }
    }
    if (!dist.has(exit)) return null;
    const path: GraphEdge[] = [];
    let c = exit;
    while (c !== entry) {
      const e = prevE.get(c);
      if (!e) return null;
      path.unshift(e);
      c = e.from;
    }
    return path;
  };
  const smoothFlats = (chain: GraphEdge[]): GraphEdge[] => {
    const out: GraphEdge[] = [];
    let i = 0;
    while (i < chain.length) {
      if (!isFlatLeg(chain[i])) {
        out.push(chain[i]);
        i++;
        continue;
      }
      let j = i;
      while (j < chain.length && isFlatLeg(chain[j])) j++;
      const orig = chain.slice(i, j);
      const origLen = orig.reduce((s, e) => s + e.lengthM, 0);
      const shortcut = shortestFlat(chain[i].from, chain[j - 1].to);
      if (shortcut && shortcut.reduce((s, e) => s + e.lengthM, 0) < origLen - 1) {
        out.push(...shortcut);
      } else {
        out.push(...orig);
      }
      i = j;
    }
    return out;
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
    const chain = smoothFlats(reconstruct(s));
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

/**
 * Longest lift-free descent from `fromId` to `toId`, maximising total skied distance (km).
 *
 * The lift-free downhill sub-graph is a DAG (edges only descend), so this is exact and O(V+E):
 * DFS from A dropping back-edges → a DAG whose post-order is reverse-topological; then a
 * longest-distance DP toward B. Returns [] when B isn't reachable from A without a lift (the
 * caller falls back to allowing a lift only in that case).
 */
export function longestDownhillPath(
  index: GraphIndex,
  fromId: string,
  toId: string,
  maxColorRank = Infinity,
  penalties?: Map<string, number>,
): GraphEdge[] {
  if (fromId === toId) return [];

  const colorRank = (e: GraphEdge): number => {
    if (e.kind !== 'piste') return 0;
    switch (e.color) {
      case 'green': return 0;
      case 'blue': return 1;
      case 'red': return 2;
      case 'black': return 3;
      default: return 4;
    }
  };

  // Candidate adjacency: non-lift edges within the user's colour rank.
  const adj = new Map<string, GraphEdge[]>();
  for (const [from, edges] of index.out) {
    const kept = edges.filter((e) => e.kind !== 'lift' && colorRank(e) <= maxColorRank);
    if (kept.length) adj.set(from, kept);
  }

  // DAG rooted at A (only nodes reachable downhill from A matter); drop back-edges (cycles).
  const state = new Map<string, number>(); // 0 unseen, 1 on-stack, 2 done
  const dagOut = new Map<string, GraphEdge[]>();
  const finished: string[] = []; // reverse-topological (descendants first)
  const stack: { id: string; i: number }[] = [{ id: fromId, i: 0 }];
  state.set(fromId, 1);
  while (stack.length) {
    const top = stack[stack.length - 1];
    const edges = adj.get(top.id) ?? [];
    if (top.i < edges.length) {
      const e = edges[top.i++];
      const s = state.get(e.to) ?? 0;
      if (s === 1) continue; // back-edge → drop to stay acyclic
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

  if (!state.has(toId)) return []; // B not reachable lift-free from A

  // Longest-distance DP toward B. Processing in `finished` order resolves successors first.
  const bestTo = new Map<string, number>([[toId, 0]]);
  const choice = new Map<string, GraphEdge>();
  for (const u of finished) {
    if (u === toId) continue;
    let best = -Infinity;
    let bestE: GraphEdge | undefined;
    for (const e of dagOut.get(u) ?? []) {
      const t = bestTo.get(e.to);
      if (t === undefined) continue; // e.to can't reach B
      // Effective length lets callers de-prioritise already-used edges (diversity), while the
      // returned chain always carries the real edges. penalty < 1 shrinks an edge's contribution.
      const cand = e.lengthM * (penalties?.get(e.id) ?? 1) + t;
      if (cand > best) {
        best = cand;
        bestE = e;
      }
    }
    if (bestE) {
      bestTo.set(u, best);
      choice.set(u, bestE);
    }
  }
  if (!choice.has(fromId)) return [];

  const chain: GraphEdge[] = [];
  const guard = new Set<string>();
  let cur = fromId;
  while (cur !== toId) {
    if (guard.has(cur)) break;
    guard.add(cur);
    const e = choice.get(cur);
    if (!e) break;
    chain.push(e);
    cur = e.to;
  }
  return cur === toId ? chain : [];
}

/**
 * Up to `k` diverse longest lift-free A→B descents. After each found run, its edges are
 * penalised so the next longest search is pushed onto different terrain; runs overlapping an
 * accepted one by more than `maxOverlap` (by distance) are rejected. Returns [] if B isn't
 * reachable from A without a lift.
 */
export function longestDownhillPaths(
  index: GraphIndex,
  fromId: string,
  toId: string,
  maxColorRank = Infinity,
  k = 3,
  maxOverlap = 0.7,
): GraphEdge[][] {
  const accepted: GraphEdge[][] = [];
  const penalties = new Map<string, number>();
  const maxAttempts = k * 4;

  for (let attempt = 0; attempt < maxAttempts && accepted.length < k; attempt++) {
    const chain = longestDownhillPath(index, fromId, toId, maxColorRank, penalties);
    if (chain.length === 0) break;

    const isDup = accepted.some(
      (r) => r.length === chain.length && r.every((e, i) => e.id === chain[i].id),
    );
    const candLen = chain.reduce((s, e) => s + e.lengthM, 0) || 1;
    const candIds = new Set(chain.map((e) => e.id));
    let overlap = 0;
    for (const r of accepted) {
      let shared = 0;
      for (const e of r) if (candIds.has(e.id)) shared += e.lengthM;
      overlap = Math.max(overlap, shared / candLen);
    }
    if (!isDup && (accepted.length === 0 || overlap <= maxOverlap)) accepted.push(chain);
    // Shrink this run's edges so the next search diverges — but only partly, so a variant that
    // shares a common top trunk then splits off (e.g. a different bottom via another piste) can
    // still reuse the trunk and surface instead of being forced onto unrelated terrain.
    for (const e of chain) penalties.set(e.id, (penalties.get(e.id) ?? 1) * 0.55);
  }
  return accepted;
}

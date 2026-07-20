import type { GraphEdge, Preferences } from '../types/domain';
import type { GraphIndex } from './graphIndex';
import { edgeCost } from './cost';

/** Binary min-heap keyed by number priority. */
class MinHeap<T> {
  private items: { key: number; val: T }[] = [];
  get size(): number {
    return this.items.length;
  }
  push(key: number, val: T): void {
    const a = this.items;
    a.push({ key, val });
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (a[p].key <= a[i].key) break;
      [a[p], a[i]] = [a[i], a[p]];
      i = p;
    }
  }
  pop(): T | undefined {
    const a = this.items;
    if (a.length === 0) return undefined;
    const top = a[0];
    const last = a.pop()!;
    if (a.length > 0) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = 2 * i + 2;
        let s = i;
        if (l < a.length && a[l].key < a[s].key) s = l;
        if (r < a.length && a[r].key < a[s].key) s = r;
        if (s === i) break;
        [a[s], a[i]] = [a[i], a[s]];
        i = s;
      }
    }
    return top.val;
  }
}

export interface PathResult {
  edges: GraphEdge[];
  totalSeconds: number;
}

/**
 * Time-dependent shortest path. Priority = accumulated weighted cost (with optional
 * per-edge penalties for alternative-route generation). Real elapsed seconds are tracked
 * separately so lift opening hours are evaluated at the actual arrival time.
 */
export function shortestPath(
  index: GraphIndex,
  startId: string,
  goalId: string,
  prefs: Preferences,
  startDate: Date,
  penalties?: Map<string, number>,
): PathResult | null {
  const bestWeight = new Map<string, number>();
  const timeAt = new Map<string, number>();
  const prevEdge = new Map<string, GraphEdge>();
  const heap = new MinHeap<string>();

  bestWeight.set(startId, 0);
  timeAt.set(startId, 0);
  heap.push(0, startId);

  while (heap.size > 0) {
    const cur = heap.pop()!;
    const curWeight = bestWeight.get(cur) ?? Infinity;
    if (cur === goalId) break;
    const elapsed = timeAt.get(cur) ?? 0;
    const arrival = new Date(startDate.getTime() + elapsed * 1000);

    for (const edge of index.outEdges(cur)) {
      const cost = edgeCost(edge, prefs, arrival);
      if (!cost.allowed || !Number.isFinite(cost.weight)) continue;
      const penalty = penalties?.get(edge.id) ?? 1;
      const newWeight = curWeight + cost.weight * penalty;
      if (newWeight < (bestWeight.get(edge.to) ?? Infinity)) {
        bestWeight.set(edge.to, newWeight);
        timeAt.set(edge.to, elapsed + cost.seconds);
        prevEdge.set(edge.to, edge);
        heap.push(newWeight, edge.to);
      }
    }
  }

  if (!prevEdge.has(goalId) && startId !== goalId) return null;
  if (startId === goalId) return { edges: [], totalSeconds: 0 };

  // Reconstruct.
  const edges: GraphEdge[] = [];
  let node = goalId;
  const guard = new Set<string>();
  while (node !== startId) {
    const e = prevEdge.get(node);
    if (!e || guard.has(node)) return null;
    guard.add(node);
    edges.push(e);
    node = e.from;
  }
  edges.reverse();
  return { edges, totalSeconds: timeAt.get(goalId) ?? 0 };
}

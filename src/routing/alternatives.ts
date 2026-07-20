import type { GraphEdge, Preferences } from '../types/domain';
import type { GraphIndex } from './graphIndex';
import { shortestPath } from './dijkstra';

/** Overlap ratio (by distance) between a candidate and already-accepted routes. */
function overlapRatio(candidate: GraphEdge[], accepted: GraphEdge[][]): number {
  const candLen = candidate.reduce((s, e) => s + e.lengthM, 0) || 1;
  const candIds = new Set(candidate.map((e) => e.id));
  let maxShared = 0;
  for (const route of accepted) {
    let shared = 0;
    for (const e of route) if (candIds.has(e.id)) shared += e.lengthM;
    maxShared = Math.max(maxShared, shared / candLen);
  }
  return maxShared;
}

/**
 * Produce up to `k` diverse routes using a penalty method: after each found route,
 * multiply the weight of its edges so the next search is pushed onto different terrain.
 * Rejects candidates that overlap an accepted route by more than `maxOverlap`.
 */
export function alternativeRoutes(
  index: GraphIndex,
  startId: string,
  goalId: string,
  prefs: Preferences,
  startDate: Date,
  k = 3,
  maxOverlap = 0.7,
): GraphEdge[][] {
  const accepted: GraphEdge[][] = [];
  const penalties = new Map<string, number>();
  const maxAttempts = k * 4;

  for (let attempt = 0; attempt < maxAttempts && accepted.length < k; attempt++) {
    const result = shortestPath(index, startId, goalId, prefs, startDate, penalties);
    if (!result || result.edges.length === 0) break;

    const isDuplicate = accepted.some(
      (r) => r.length === result.edges.length && r.every((e, i) => e.id === result.edges[i].id),
    );
    const overlap = overlapRatio(result.edges, accepted);

    if (!isDuplicate && (accepted.length === 0 || overlap <= maxOverlap)) {
      accepted.push(result.edges);
    }
    // Penalize this route's edges so the next search diverges.
    for (const e of result.edges) {
      penalties.set(e.id, (penalties.get(e.id) ?? 1) * 3);
    }
  }
  return accepted;
}

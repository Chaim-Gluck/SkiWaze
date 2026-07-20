import type { GraphEdge } from '../types/domain';

const KEY = (resortId: string) => `skiwaze.customEdges.${resortId}`;

export function loadCustomEdges(resortId: string): GraphEdge[] {
  try {
    const raw = localStorage.getItem(KEY(resortId));
    if (!raw) return [];
    const parsed = JSON.parse(raw) as GraphEdge[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function saveCustomEdges(resortId: string, edges: GraphEdge[]): void {
  try {
    localStorage.setItem(KEY(resortId), JSON.stringify(edges));
  } catch {
    // ignore quota / private-mode errors
  }
}

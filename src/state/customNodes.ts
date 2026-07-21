import type { GeoPoint } from '../types/domain';

/**
 * A user-created graph node at an arbitrary map point. When `attachEdgeId` is set the node
 * sits on that base piste edge and the effective graph splits that edge through it (so a
 * point drawn mid-slope integrates into the slope). Free nodes (no attach) only connect via
 * the custom links the user draws.
 */
export interface CustomNode {
  id: string;
  point: GeoPoint;
  attachEdgeId?: string;
}

const KEY = (resortId: string) => `skiwaze.customNodes.${resortId}`;

export function loadCustomNodes(resortId: string): CustomNode[] {
  try {
    const raw = localStorage.getItem(KEY(resortId));
    if (!raw) return [];
    const parsed = JSON.parse(raw) as CustomNode[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function saveCustomNodes(resortId: string, nodes: CustomNode[]): void {
  try {
    localStorage.setItem(KEY(resortId), JSON.stringify(nodes));
  } catch {
    // ignore quota / private-mode errors
  }
}

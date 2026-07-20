import type { GraphNode, ResortGraph } from '../types/domain';
import type { ResortIndexEntry } from '../data/resortData';
import { haversineM } from './geo';

/** Nearest resort to a coordinate (by center distance). */
export function nearestResort(
  entries: ResortIndexEntry[],
  lon: number,
  lat: number,
): ResortIndexEntry | undefined {
  let best: ResortIndexEntry | undefined;
  let bestD = Infinity;
  for (const e of entries) {
    const d = haversineM({ lon, lat, ele: null }, { lon: e.center.lon, lat: e.center.lat, ele: null });
    if (d < bestD) {
      bestD = d;
      best = e;
    }
  }
  return best;
}

/** Nearest graph node to a coordinate; returns null if the graph is empty. */
export function nearestNode(graph: ResortGraph, lon: number, lat: number): GraphNode | null {
  let best: GraphNode | null = null;
  let bestD = Infinity;
  const from = { lon, lat, ele: null };
  for (const n of graph.nodes) {
    const d = haversineM(from, { lon: n.point.lon, lat: n.point.lat, ele: null });
    if (d < bestD) {
      bestD = d;
      best = n;
    }
  }
  return best;
}

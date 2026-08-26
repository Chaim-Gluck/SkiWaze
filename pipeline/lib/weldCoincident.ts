/**
 * Weld node pairs that occupy the same spot.
 *
 * Node merging happens inside `buildResortGraph`, but the endpoint→line snap and the polygon
 * skeleton both *invent* nodes afterwards, so a split point can land exactly on a node that
 * already existed. The result is a pair of distinct ids at the same coordinates joined by a
 * zero-length edge — 252 of them in Val Thorens, every one within 1 m both horizontally and
 * vertically, far inside the normal merge tolerances.
 *
 * Those twins are rungs: the longest-run search hops off a line, skis a few tens of metres of a
 * neighbouring line, then takes a 0 m edge back onto the twin of the node it started from, banking
 * the detour as free distance. It reads on the map as a run "twisting into broken lines".
 *
 * Deliberately conservative: only pairs that are **already joined by an edge** are welded. Two
 * unconnected nodes that merely coincide might be genuinely separate terrain (a bridge over a run),
 * and nothing here needs to touch them.
 */
import type { GraphEdge, ResortGraph } from '../../src/types/domain';

/** Horizontal and vertical tolerance, in metres. Far tighter than the graph's merge constants. */
const WELD_H_M = 1;
const WELD_V_M = 1;

function metresBetween(
  a: { lon: number; lat: number },
  b: { lon: number; lat: number },
): number {
  const k = Math.cos(((a.lat + b.lat) / 2) * (Math.PI / 180));
  return Math.hypot((a.lon - b.lon) * k, a.lat - b.lat) * 111320;
}

/**
 * Which id survives a weld. Ids are stable and load-bearing (overrides and user localStorage key
 * off them), so the choice must not depend on iteration order: prefer a plain OSM-derived `n<id>`
 * over an invented `sn…`/`on…`/`k…`, then the smallest number, then lexicographic.
 */
function preferredId(a: string, b: string): string {
  const plain = (s: string) => /^n\d+$/.test(s);
  if (plain(a) !== plain(b)) return plain(a) ? a : b;
  const num = (s: string) => {
    const m = s.match(/(\d+)/);
    return m ? Number(m[1]) : Number.MAX_SAFE_INTEGER;
  };
  if (num(a) !== num(b)) return num(a) < num(b) ? a : b;
  return a < b ? a : b;
}

export interface WeldResult {
  graph: ResortGraph;
  welded: number;
  droppedEdges: number;
}

export function weldCoincidentNodes(graph: ResortGraph): WeldResult {
  const nodeById = new Map(graph.nodes.map((n) => [n.id, n]));

  // Union-find over coincident, already-connected pairs.
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    let r = x;
    while ((parent.get(r) ?? r) !== r) r = parent.get(r)!;
    while ((parent.get(x) ?? x) !== x) {
      const next = parent.get(x)!;
      parent.set(x, r);
      x = next;
    }
    return r;
  };
  const union = (a: string, b: string): void => {
    const ra = find(a);
    const rb = find(b);
    if (ra === rb) return;
    // Keep the preferred id as the root so the representative is order-independent.
    const keep = preferredId(ra, rb);
    parent.set(keep === ra ? rb : ra, keep);
  };
  for (const id of nodeById.keys()) parent.set(id, id);

  for (const e of graph.edges) {
    const a = nodeById.get(e.from);
    const b = nodeById.get(e.to);
    if (!a || !b) continue;
    if (metresBetween(a.point, b.point) > WELD_H_M) continue;
    if (Math.abs((a.point.ele ?? 0) - (b.point.ele ?? 0)) > WELD_V_M) continue;
    union(e.from, e.to);
  }

  let welded = 0;
  for (const id of nodeById.keys()) if (find(id) !== id) welded++;
  if (welded === 0) return { graph, welded: 0, droppedEdges: 0 };

  const before = graph.edges.length;
  const edges: GraphEdge[] = [];
  for (const e of graph.edges) {
    const from = find(e.from);
    const to = find(e.to);
    if (from === to) continue; // the zero-length rung itself
    edges.push(from === e.from && to === e.to ? e : { ...e, from, to });
  }

  const nodes = graph.nodes.filter((n) => find(n.id) === n.id);
  const points = graph.points.map((p) =>
    p.nodeId && find(p.nodeId) !== p.nodeId ? { ...p, nodeId: find(p.nodeId) } : p,
  );

  return { graph: { ...graph, nodes, edges, points }, welded, droppedEdges: before - edges.length };
}

import type { GraphEdge, ResortGraph, TextRef } from '../types/domain';

/** Canonical closure key for a piste (ref + name so different runs sharing a ref stay distinct). */
export function pisteClosureKey(edge: GraphEdge): string | null {
  const ref = edge.pisteRef;
  const name = edge.pisteName;
  if (ref && name) return `piste:${ref}~${name}`;
  if (name) return `piste:${name}`;
  if (ref) return `piste:${ref}`;
  return null;
}

/** Canonical closure key for a lift. */
export function liftClosureKey(edge: GraphEdge): string | null {
  return edge.liftName ? `lift:${edge.liftName}` : null;
}

/**
 * All closure keys that identify an edge. Marking any of these keys "closed" removes
 * this edge from routing. Every edge also has an `edge:<id>` key so unnamed segments can
 * still be closed individually.
 */
export function edgeClosureKeys(edge: GraphEdge): string[] {
  const keys: string[] = [`edge:${edge.id}`];
  if (edge.kind === 'lift') {
    const k = liftClosureKey(edge);
    if (k) keys.push(k);
  }
  if (edge.kind === 'piste') {
    const k = pisteClosureKey(edge);
    if (k) keys.push(k);
  }
  return keys;
}

/** Resolve human closure keys to the set of edge ids they close. */
export function resolveClosedEdgeIds(graph: ResortGraph, closedKeys: Iterable<string>): Set<string> {
  const closed = new Set(closedKeys);
  const ids = new Set<string>();
  if (closed.size === 0) return ids;
  for (const e of graph.edges) {
    if (edgeClosureKeys(e).some((k) => closed.has(k))) ids.add(e.id);
  }
  return ids;
}

/** Combined lon/lat geometry of every edge a closure key affects (for locating on the map). */
export function geometryForClosure(graph: ResortGraph, key: string): [number, number][] {
  const coords: [number, number][] = [];
  for (const e of graph.edges) {
    if (edgeClosureKeys(e).includes(key)) {
      for (const p of e.geometry) coords.push([p.lon, p.lat]);
    }
  }
  return coords;
}

/**
 * Human label for a closure key, as a catalogue key + params. The run/lift name inside it is
 * never translated; only the "Lift:" / "Run:" prefix is.
 */
export function closureLabel(key: string): TextRef {
  if (key.startsWith('lift:')) return { key: 'closure.lift', params: { name: key.slice(5) } };
  if (key.startsWith('piste:')) return { key: 'closure.run', params: { piste: key.slice(6).replace('~', ' \u00b7 ') } };
  return { key: 'closure.segment' };
}

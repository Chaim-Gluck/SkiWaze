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
 * One polyline per affected edge, for every closure key. Deliberately NOT `geometryForClosure`:
 * that flattens every matching edge into a single coordinate list, which is harmless for fitting a
 * camera to bounds (its only caller) but would draw a straight jump between disconnected segments
 * if handed to the map as a LineString. Drawing needs the edges kept apart.
 */
export function closedGeometries(graph: ResortGraph, closedKeys: Iterable<string>): [number, number][][] {
  const closed = new Set(closedKeys);
  if (closed.size === 0) return [];
  const out: [number, number][][] = [];
  for (const e of graph.edges) {
    if (!edgeClosureKeys(e).some((k) => closed.has(k))) continue;
    if (e.geometry.length < 2) continue;
    out.push(e.geometry.map((p) => [p.lon, p.lat] as [number, number]));
  }
  return out;
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

/** One closable named lift or run, for the Closed panel's pickers. */
export interface ClosableItem {
  key: string;
  kind: 'lift' | 'piste';
  /** Display text: the OSM name, prefixed by the run's ref where it has one. Never translated. */
  label: string;
  color?: GraphEdge['color'];
  liftType?: GraphEdge['liftType'];
}

/**
 * Every named lift and run in the graph, as closure keys the user can pick directly.
 *
 * Before this, the only way to close something was to route through it and click the sign on the
 * step - so a skier who already knew a lift was shut had to first plan a route over it, and a run
 * that no route happened to use could not be closed at all.
 *
 * Deliberately excludes **synthetic** edges as a *source* of names: those are links the app
 * invented (snap, rescue, ski-out, skeleton arms), not terrain anyone signposted, and offering them
 * as closable would present the app's own plumbing as if it were a run. A name that also exists on
 * a real edge still appears, and closing it still closes the synthetic copies, because
 * `resolveClosedEdgeIds` matches on the key rather than on this list.
 */
export function closableItems(graph: ResortGraph): ClosableItem[] {
  const byKey = new Map<string, ClosableItem>();
  for (const e of graph.edges) {
    if (e.synthetic || e.custom) continue;
    if (e.kind === 'lift') {
      const key = liftClosureKey(e);
      if (key && !byKey.has(key)) byKey.set(key, { key, kind: 'lift', label: e.liftName!, liftType: e.liftType });
    } else if (e.kind === 'piste') {
      const key = pisteClosureKey(e);
      if (!key) continue;
      // A run split across ways can carry the colour on one piece and not another, so fill in a
      // colour we learn later rather than trusting whichever edge we met first.
      const seen = byKey.get(key);
      if (seen) { if (!seen.color && e.color) seen.color = e.color; continue; }
      const label = e.pisteRef && e.pisteName ? `${e.pisteRef} \u00b7 ${e.pisteName}` : (e.pisteName ?? e.pisteRef!);
      byKey.set(key, { key, kind: 'piste', label, color: e.color });
    }
  }
  const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
  return [...byKey.values()].sort((a, b) => collator.compare(a.label, b.label));
}

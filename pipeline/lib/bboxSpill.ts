import type { Resort, ResortGraph } from '../../src/types/domain';

/**
 * Drop terrain that belongs to a neighbouring resort.
 *
 * Overpass returns a way in full when *any* of its nodes falls inside the query bbox, so a lift or
 * run straddling the boundary arrives complete and lands in the wrong resort's dataset. Cervinia
 * was carrying Monterosa's Sant'Anna - Colle Betta chairlift and the B1 Pistone Betta run that way,
 * showing them to users as Cervinia terrain and inflating its trapped/orphan counts.
 *
 * The test is deliberately two-part, because either half alone is wrong:
 *   - "wholly outside the bbox" is too weak. The Colle Betta top station sits 11 m inside Cervinia's
 *     bbox, so grazing the boundary at one node was enough to keep the whole fragment.
 *   - "majority outside the bbox" alone would bite legitimate terrain, since the main body of a
 *     resort routinely spills past a hand-drawn bbox.
 * Requiring a *disconnected* component whose nodes are mostly outside catches only real spill: on
 * the 14-resort fleet it flags 3 fragments, all of them another resort's.
 */
export function dropOutOfAreaSpill(
  graph: ResortGraph,
  resort: Resort,
): { graph: ResortGraph; dropped: { nodes: number; label: string }[] } {
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r)!;
    while (parent.get(x) !== r) {
      const next = parent.get(x)!;
      parent.set(x, r);
      x = next;
    }
    return r;
  };
  for (const n of graph.nodes) parent.set(n.id, n.id);
  for (const e of graph.edges) {
    const a = find(e.from);
    const b = find(e.to);
    if (a !== b) parent.set(a, b);
  }

  const components = new Map<string, string[]>();
  for (const n of graph.nodes) {
    const root = find(n.id);
    (components.get(root) ?? components.set(root, []).get(root)!).push(n.id);
  }
  if (components.size < 2) return { graph, dropped: [] };

  const biggest = [...components.values()].sort((a, b) => b.length - a.length)[0];
  const pointById = new Map(graph.nodes.map((n) => [n.id, n.point]));
  const { bbox } = resort;
  const inBbox = (id: string): boolean => {
    const p = pointById.get(id);
    return (
      !!p &&
      p.lon >= bbox.minLon &&
      p.lon <= bbox.maxLon &&
      p.lat >= bbox.minLat &&
      p.lat <= bbox.maxLat
    );
  };

  const doomed = new Set<string>();
  const dropped: { nodes: number; label: string }[] = [];
  for (const ids of components.values()) {
    if (ids === biggest) continue;
    const outside = ids.filter((id) => !inBbox(id)).length;
    if (outside * 2 <= ids.length) continue;
    for (const id of ids) doomed.add(id);
    const named = graph.points?.find((p) => ids.includes(p.nodeId));
    dropped.push({ nodes: ids.length, label: named?.name ?? ids[0] });
  }
  if (!doomed.size) return { graph, dropped: [] };

  return {
    graph: {
      ...graph,
      nodes: graph.nodes.filter((n) => !doomed.has(n.id)),
      edges: graph.edges.filter((e) => !doomed.has(e.from) && !doomed.has(e.to)),
      points: (graph.points ?? []).filter((p) => !doomed.has(p.nodeId)),
    },
    dropped,
  };
}

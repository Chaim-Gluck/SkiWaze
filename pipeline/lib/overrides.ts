// Apply an optional per-resort overrides.json to correct heuristic mistakes.
// Applied LAST so humans can fix wrong auto-decisions without changing code.
import fs from 'node:fs';
import path from 'node:path';
import type { GraphEdge, ResortGraph } from '../../src/types/domain';
import { haversineM, polylineLength3dM } from '../../src/utils/geo';

export interface Overrides {
  /** Groups of node ids to force-merge into a single node. */
  mergeNodes?: string[][];
  /** Edge ids to delete. */
  removeEdges?: string[];
  /** Extra connectors to add. */
  addConnectors?: {
    from: string;
    to: string;
    kind: 'skiable_down' | 'flat_traverse';
    bidirectional?: boolean;
  }[];
  /** Force a lift's download capability on/off by lift name. */
  setLiftDownload?: { liftName: string; canDownload: boolean }[];
}

export function loadOverrides(resortId: string, dir: string): Overrides | null {
  const file = path.join(dir, `${resortId}.json`);
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf8')) as Overrides;
}

export function applyOverrides(graph: ResortGraph, ov: Overrides): ResortGraph {
  let nodes = graph.nodes;
  let edges = graph.edges;

  // 1. Merge nodes: remap all members to the first id, drop the rest, average position.
  if (ov.mergeNodes?.length) {
    const remap = new Map<string, string>();
    for (const group of ov.mergeNodes) {
      if (group.length < 2) continue;
      const keep = group[0];
      for (const other of group.slice(1)) remap.set(other, keep);
    }
    const resolve = (id: string) => remap.get(id) ?? id;
    edges = edges.map((e) => ({ ...e, from: resolve(e.from), to: resolve(e.to) }))
      .filter((e) => e.from !== e.to);
    nodes = nodes.filter((n) => !remap.has(n.id));
  }

  // 2. Remove edges.
  if (ov.removeEdges?.length) {
    const dead = new Set(ov.removeEdges);
    edges = edges.filter((e) => !dead.has(e.id));
  }

  // 3. Set lift download capability by name.
  if (ov.setLiftDownload?.length) {
    const byName = new Map(ov.setLiftDownload.map((s) => [s.liftName, s.canDownload]));
    const additions: GraphEdge[] = [];
    let idx = edges.length;
    for (const e of edges) {
      if (e.kind !== 'lift' || !e.liftName) continue;
      const want = byName.get(e.liftName);
      if (want === true && !e.isDownload) {
        // Ensure a paired download edge exists.
        const hasDown = edges.some(
          (x) => x.kind === 'lift' && x.liftName === e.liftName && x.isDownload,
        );
        if (!hasDown && !e.isDownload) {
          additions.push({
            ...e,
            id: `eov${idx++}`,
            from: e.to,
            to: e.from,
            geometry: [...e.geometry].reverse(),
            dropM: -e.dropM,
            isDownload: true,
          });
        }
      }
    }
    edges = [...edges, ...additions];
    if (byName.size) {
      // Remove download edges explicitly disabled.
      edges = edges.filter(
        (e) => !(e.kind === 'lift' && e.isDownload && byName.get(e.liftName ?? '') === false),
      );
    }
  }

  // 4. Add connectors.
  if (ov.addConnectors?.length) {
    const nodeById = new Map(nodes.map((n) => [n.id, n]));
    let idx = 0;
    for (const c of ov.addConnectors) {
      const a = nodeById.get(c.from);
      const b = nodeById.get(c.to);
      if (!a || !b) continue;
      const geometry = [a.point, b.point];
      const lengthM = polylineLength3dM(geometry);
      const dz = (b.point.ele ?? 0) - (a.point.ele ?? 0);
      const pairs: [string, string][] = c.bidirectional
        ? [[c.from, c.to], [c.to, c.from]]
        : [[c.from, c.to]];
      for (const [from, to] of pairs) {
        edges.push({
          id: `eovc${idx++}`,
          from,
          to,
          kind: 'connector',
          connectorKind: c.kind,
          geometry: from === c.from ? geometry : [...geometry].reverse(),
          lengthM,
          dropM: c.kind === 'flat_traverse' ? 0 : -Math.abs(dz),
          gradient: c.kind === 'flat_traverse' ? 0 : -Math.abs(dz) / Math.max(1, haversineM(a.point, b.point)),
        });
      }
    }
  }

  return { ...graph, nodes, edges };
}

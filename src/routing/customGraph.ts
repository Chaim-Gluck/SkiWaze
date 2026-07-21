import type { GraphEdge, GraphNode, ResortGraph } from '../types/domain';
import type { CustomNode } from '../state/customNodes';
import { polylineLength3dM, projectOnPolyline } from '../utils/geo';

/**
 * Build the routable graph including user custom nodes and links.
 *
 * - Custom nodes attached to a base piste edge split that edge through the node, so a point
 *   drawn on a slope becomes a real, skiable junction on it (both sub-edges keep the piste's
 *   colour/direction).
 * - Free custom nodes are added as-is (only reachable via custom links).
 * - Custom link edges are appended last.
 */
export function buildEffectiveGraph(
  graph: ResortGraph,
  customNodes: CustomNode[],
  customEdges: GraphEdge[],
): ResortGraph {
  if (customNodes.length === 0 && customEdges.length === 0) return graph;

  const nodes: GraphNode[] = [...graph.nodes];
  for (const cn of customNodes) {
    nodes.push({ id: cn.id, point: cn.point, kind: 'junction', name: undefined });
  }

  // Group attached custom nodes by the base edge they split.
  const byEdge = new Map<string, CustomNode[]>();
  for (const cn of customNodes) {
    if (!cn.attachEdgeId) continue;
    const arr = byEdge.get(cn.attachEdgeId);
    if (arr) arr.push(cn);
    else byEdge.set(cn.attachEdgeId, [cn]);
  }

  let splitCounter = 0;
  const edges: GraphEdge[] = [];
  for (const e of graph.edges) {
    const attached = byEdge.get(e.id);
    if (!attached || attached.length === 0 || e.kind !== 'piste' || e.geometry.length < 2) {
      edges.push(e);
      continue;
    }
    // Locate each cut along the edge, then split in order.
    const cuts = attached
      .map((cn) => {
        const loc = projectOnPolyline(cn.point, e.geometry);
        return { cn, segIdx: loc.segIdx, t: loc.t, point: loc.point };
      })
      .sort((a, b) => a.segIdx - b.segIdx || a.t - b.t);

    const mk = (from: string, to: string, pts: typeof e.geometry): GraphEdge => ({
      ...e,
      id: `ceff-${e.id}-${splitCounter++}`,
      from,
      to,
      geometry: pts,
      lengthM: polylineLength3dM(pts),
      dropM: (pts[pts.length - 1].ele ?? 0) - (pts[0].ele ?? 0),
    });

    let subPts: typeof e.geometry = [e.geometry[0]];
    let fromId = e.from;
    let gIdx = 1;
    for (const cut of cuts) {
      while (gIdx <= cut.segIdx - 1) {
        subPts.push(e.geometry[gIdx]);
        gIdx++;
      }
      subPts.push(cut.point);
      edges.push(mk(fromId, cut.cn.id, subPts));
      fromId = cut.cn.id;
      subPts = [cut.point];
    }
    while (gIdx < e.geometry.length) {
      subPts.push(e.geometry[gIdx]);
      gIdx++;
    }
    edges.push(mk(fromId, e.to, subPts));
  }

  for (const ce of customEdges) edges.push(ce);

  return { ...graph, nodes, edges };
}

import type { GraphEdge, GraphNode, ResortGraph } from '../types/domain';

/** In-memory index over a ResortGraph for fast routing. */
export class GraphIndex {
  readonly nodes: Map<string, GraphNode>;
  readonly out: Map<string, GraphEdge[]>;
  readonly edgeById: Map<string, GraphEdge>;

  constructor(graph: ResortGraph) {
    this.nodes = new Map(graph.nodes.map((n) => [n.id, n]));
    this.edgeById = new Map(graph.edges.map((e) => [e.id, e]));
    this.out = new Map();
    for (const e of graph.edges) {
      const arr = this.out.get(e.from);
      if (arr) arr.push(e);
      else this.out.set(e.from, [e]);
    }
  }

  outEdges(nodeId: string): GraphEdge[] {
    return this.out.get(nodeId) ?? [];
  }

  node(id: string): GraphNode | undefined {
    return this.nodes.get(id);
  }
}

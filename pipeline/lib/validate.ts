// Post-build validation: connectivity, unreachable components, and a summary report.
import type { DataWarning, ResortGraph } from '../../src/types/domain';

export interface ValidationReport {
  resortId: string;
  nodeCount: number;
  edgeCount: number;
  pisteEdges: number;
  liftEdges: number;
  connectorEdges: number;
  meaningfulPoints: number;
  reachableFromLifts: number;
  unreachableNodes: number;
  warningsByCode: Record<string, number>;
}

/** BFS reachability from all lift-station nodes over directed edges. */
export function reachableFromLiftStations(graph: ResortGraph): Set<string> {
  const adj = new Map<string, string[]>();
  for (const e of graph.edges) {
    const arr = adj.get(e.from);
    if (arr) arr.push(e.to);
    else adj.set(e.from, [e.to]);
  }
  const seeds = graph.nodes.filter((n) => n.kind === 'lift_station').map((n) => n.id);
  const seen = new Set<string>(seeds);
  const queue = [...seeds];
  while (queue.length) {
    const cur = queue.shift()!;
    for (const next of adj.get(cur) ?? []) {
      if (!seen.has(next)) {
        seen.add(next);
        queue.push(next);
      }
    }
  }
  return seen;
}

export function validateGraph(graph: ResortGraph): ValidationReport {
  const reachable = reachableFromLiftStations(graph);
  const unreachable = graph.nodes.filter((n) => !reachable.has(n.id));

  if (unreachable.length > 0) {
    graph.warnings.push({
      code: 'unreachable_component',
      message: `${unreachable.length} node(s) unreachable from the main lift network.`,
      refs: unreachable.slice(0, 20).map((n) => n.id),
    } satisfies DataWarning);
  }

  const warningsByCode: Record<string, number> = {};
  for (const w of graph.warnings) {
    warningsByCode[w.code] = (warningsByCode[w.code] ?? 0) + 1;
  }

  return {
    resortId: graph.resortId,
    nodeCount: graph.nodes.length,
    edgeCount: graph.edges.length,
    pisteEdges: graph.edges.filter((e) => e.kind === 'piste').length,
    liftEdges: graph.edges.filter((e) => e.kind === 'lift').length,
    connectorEdges: graph.edges.filter((e) => e.kind === 'connector').length,
    meaningfulPoints: graph.points.length,
    reachableFromLifts: reachable.size,
    unreachableNodes: unreachable.length,
    warningsByCode,
  };
}

export function printReport(r: ValidationReport): void {
  console.log(`  --- validation: ${r.resortId} ---`);
  console.log(`  nodes=${r.nodeCount} edges=${r.edgeCount} (piste=${r.pisteEdges} lift=${r.liftEdges} connector=${r.connectorEdges})`);
  console.log(`  meaningful points=${r.meaningfulPoints}`);
  console.log(`  reachable from lifts=${r.reachableFromLifts} unreachable=${r.unreachableNodes}`);
  const codes = Object.entries(r.warningsByCode);
  if (codes.length) {
    console.log('  warnings: ' + codes.map(([k, v]) => `${k}=${v}`).join(' '));
  }
}

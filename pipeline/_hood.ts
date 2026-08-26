/**
 * Dump every node and edge inside a small bbox, so a weave can be read as a local graph
 * rather than as a route. Shows each edge's direction, source way, and flags.
 *
 *   npx tsx pipeline/_hood.ts <resortId> <latMin> <latMax> <lonMin> <lonMax>
 */
import { readFileSync } from 'node:fs';
import type { ResortGraph, GraphEdge, GraphNode } from '../src/types/domain';

const [id, latMin, latMax, lonMin, lonMax] = process.argv.slice(2);
const graph: ResortGraph = JSON.parse(readFileSync(`public/resorts/${id}/graph.json`, 'utf8'));

const inBox = (n: GraphNode) =>
  n.point.lat >= +latMin && n.point.lat <= +latMax && n.point.lon >= +lonMin && n.point.lon <= +lonMax;

const nodes = new Map<string, GraphNode>();
for (const n of graph.nodes) if (inBox(n)) nodes.set(n.id, n);

console.log(`nodes in box: ${nodes.size}`);
for (const n of [...nodes.values()].sort((a, b) => b.point.ele - a.point.ele)) {
  console.log(`  ${n.id.padEnd(18)} ${n.point.ele.toFixed(1).padStart(7)}m ${n.point.lat.toFixed(5)},${n.point.lon.toFixed(5)} ${n.kind}`);
}

const rel = graph.edges.filter((e) => nodes.has(e.from) || nodes.has(e.to));
console.log(`\nedges touching box: ${rel.length}`);
for (const e of rel as GraphEdge[]) {
  const a = graph.nodes.find((n) => n.id === e.from)!;
  const b = graph.nodes.find((n) => n.id === e.to)!;
  const flags = [
    e.spineDuplicate ? 'DUP' : '',
    e.skeletonArm ? 'ARM' : '',
    e.synthetic ? `syn:${e.synthetic}` : '',
    e.area ? 'AREA' : '',
  ]
    .filter(Boolean)
    .join(',');
  console.log(
    `  ${e.id.padEnd(8)} ${e.from.padEnd(18)} -> ${e.to.padEnd(18)} ` +
      `${e.kind.padEnd(9)} ${String(e.color ?? e.connectorKind ?? '').padEnd(14)} ` +
      `${e.lengthM.toFixed(0).padStart(5)}m  ${(a.point.ele - b.point.ele).toFixed(1).padStart(6)}m  ` +
      `way=${String(e.srcWayId ?? '-').padEnd(12)} ${flags}`,
  );
}

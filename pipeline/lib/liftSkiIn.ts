/**
 * Lift-base ski-in snap — the mirror of `buildGraph`'s lift-TOP ski-out pass.
 *
 * A lift base you can ski AWAY from but never ski TO. Nothing else catches it: the rescue pass
 * fixes nodes that cannot leave, the orphan pass fixes whole components with no entrance, and a
 * lift base always has both an exit (the cable) and a component (the whole mountain). So it slips
 * past every existing guard while being useless in practice — the router can never put that lift
 * in a route, and `check:basins` cannot see it because nothing is stranded.
 *
 * WHY THIS IS NOT INSIDE `buildResortGraph`, unlike its ski-out twin. Whether a base has a ski-in
 * is a question about edge DIRECTION, and direction is re-derived twice after the graph is built:
 * by `applyOverrides` (`setNodeElevation`) and by the elevation-consensus pass. Avoriaz's Surf
 * platter is the worked case — inside `buildResortGraph` the base looked fine, because on the raw
 * DEM the shelf below it read HIGHER than it is and the runs pointed inward; the hand pins then
 * flipped all three outward and left the base with zero ways in. Running here, after every pass
 * that can re-orient an edge, is the only place the question has a stable answer.
 *
 * Safety is the ski-out pass's argument reflected: the projected point must be at or above the
 * base (you ski DOWN into a lift), and the link is one-way down whenever the drop exceeds
 * `maxTraverseClimb`, so it can never be abused as a free ascent.
 */
import type { ResortGraph, GraphEdge, GeoPoint } from '../../src/types/domain';
import type { GraphConstants } from '../../src/config/graphConstants';
import { haversineM, polylineLength3dM, projectOnSegment } from '../../src/utils/geo';

function drop(points: GeoPoint[]): number {
  return (points[points.length - 1].ele ?? 0) - (points[0].ele ?? 0);
}

export function linkLiftBaseSkiIns(
  graph: ResortGraph,
  c: GraphConstants,
): { graph: ResortGraph; linked: { base: string; liftName?: string; onto: string; distM: number; twoWay: boolean }[] } {
  const nodes = graph.nodes.map((n) => ({ ...n }));
  const byId = new Map(nodes.map((n) => [n.id, n]));
  let edges = graph.edges.slice();

  const liftBases = new Map<string, string | undefined>();
  for (const e of edges) if (e.kind === 'lift' && !e.isDownload) liftBases.set(e.from, e.liftName);
  const hasNonLiftIn = new Set<string>();
  for (const e of edges) if (e.kind !== 'lift') hasNonLiftIn.add(e.to);

  const linked: { base: string; liftName?: string; onto: string; distM: number; twoWay: boolean }[] = [];
  let synth = 0;
  const nextId = () => `bi${synth++}`;

  for (const [baseId, liftName] of liftBases) {
    if (hasNonLiftIn.has(baseId)) continue;
    const B = byId.get(baseId);
    if (!B || B.point.ele == null) continue;
    const bp: GeoPoint = { ...B.point };

    let best: { edge: GraphEdge; segIdx: number; point: GeoPoint; dist: number } | null = null;
    for (const X of edges) {
      if (X.kind !== 'piste' || X.area || X.from === baseId || X.to === baseId) continue;
      for (let i = 1; i < X.geometry.length; i++) {
        const pr = projectOnSegment(bp, X.geometry[i - 1], X.geometry[i]);
        // Only a downhill ski-in: the projected point must be at/above the base.
        if ((pr.point.ele ?? 0) < (bp.ele ?? 0) - 2) continue;
        if (pr.dist <= c.liftSkiOutRadius && pr.dist < (best?.dist ?? Infinity)) {
          best = { edge: X, segIdx: i, point: pr.point, dist: pr.dist };
        }
      }
    }
    if (!best) continue;
    const X = best.edge;
    const P = best.point;

    // Never split a line at its own endpoint — that leaves a zero-length half which a later pass
    // drops, orphaning the real node (the Monte Pana lesson). Hmerge is "same place" here.
    const fromN = byId.get(X.from)!;
    const toN = byId.get(X.to)!;
    let N: string;
    if (haversineM(P, fromN.point) <= c.Hmerge) {
      N = X.from;
    } else if (haversineM(P, toN.point) <= c.Hmerge) {
      N = X.to;
    } else {
      // One ski-in node per lift base, named after that base so a refresh cannot renumber it.
      N = `b${baseId}`;
      if (byId.has(N)) continue;
      const node = { id: N, point: P, kind: 'junction' as const };
      nodes.push(node);
      byId.set(N, node);
      const g1 = [...X.geometry.slice(0, best.segIdx), P];
      const g2 = [P, ...X.geometry.slice(best.segIdx)];
      edges = edges.filter((e) => e !== X);
      edges.push({ ...X, id: nextId(), to: N, geometry: g1, lengthM: polylineLength3dM(g1), dropM: drop(g1) });
      edges.push({ ...X, id: nextId(), from: N, geometry: g2, lengthM: polylineLength3dM(g2), dropM: drop(g2) });
    }

    const nGeo: GeoPoint = { ...byId.get(N)!.point };
    // Recompute: when we reused an endpoint the attachment moved off the projection.
    const linkM = haversineM(nGeo, bp);
    const dz = (bp.ele ?? 0) - (nGeo.ele ?? 0); // <= 0 when the run point is above the base
    const oneWayDown = dz < -c.maxTraverseClimb;
    edges.push({
      id: nextId(),
      from: N,
      to: baseId,
      kind: 'connector',
      connectorKind: oneWayDown ? 'skiable_down' : 'flat_traverse',
      geometry: [nGeo, bp],
      lengthM: linkM,
      dropM: oneWayDown ? -Math.abs(dz) : drop([nGeo, bp]),
      gradient: linkM > 0 ? dz / linkM : 0,
      synthetic: true,
    });
    if (!oneWayDown) {
      edges.push({
        id: nextId(),
        from: baseId,
        to: N,
        kind: 'connector',
        connectorKind: 'flat_traverse',
        geometry: [bp, nGeo],
        lengthM: linkM,
        dropM: drop([bp, nGeo]),
        gradient: linkM > 0 ? drop([bp, nGeo]) / linkM : 0,
        synthetic: true,
      });
    }
    hasNonLiftIn.add(baseId);
    linked.push({ base: baseId, liftName, onto: X.pisteName ?? X.srcWayId?.toString() ?? X.id, distM: linkM, twoWay: !oneWayDown });
  }

  return { graph: { ...graph, nodes, edges }, linked };
}

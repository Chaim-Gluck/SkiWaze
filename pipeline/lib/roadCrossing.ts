/**
 * The app may not invent a way across a road.
 *
 * Every synthetic edge is a guess: a dead-end snapped onto a nearby line, a rescue link, a lift-top
 * ski-out, a plateau bridge. The guess is always "these two points are close, so a skier can get
 * between them" — a purely geometric claim that is blind to what lies in between. Where a public
 * road lies in between, the claim is simply false, and worse it is *plausible*: the link is short,
 * near-flat and lands exactly where a skier wants to go, so the router loves it.
 *
 * Madonna's Grostè hub is the case that found it. The resort has a carpet and a parallel footway
 * over a **dedicated viaduct** (`w395885465`, `bridge=viaduct`) precisely because the road below
 * cannot be crossed on skis. We had nevertheless minted three synthetic links straight across the
 * carriageway — `n3986751322 -> n296143996` (88 m), the same to the piste-79 snap (111 m), and
 * `n3986751317 -> n296143996` (103 m) — so a route from the east side to the west reported "0
 * lifts" while the only real crossing is the carpet. Deleting those three by hand in the override
 * would have fixed one hub; roads are the general cause.
 *
 * We could not see this before because **roads were never fetched at all** — the Overpass query
 * asks for pistes, aerialways, rail lifts and conveyors, so the barrier was simply absent from the
 * data. They now arrive under a separate cache key (see `fetchResortRoads`).
 *
 * Blast radius is small and consistent, which is what makes the rule safe: synthetic edges crossing
 * a road are **4.8%** at madonna (15/310), **6.5%** at sella-ronda (121/1859), **3.3%** at
 * val-thorens (150/4515) and **0.7%** at ischgl (11/1558) — of the order of 300 fleet-wide.
 *
 * Four guards, each one a way the rule could destroy real terrain:
 *
 * 1. **Synthetic edges only.** A mapped OSM way crossing a road is evidence, not a guess: mappers
 *    draw a piste over a road exactly where there is a bridge, an underpass or a marked crossing.
 *    User `custom` links are deliberate and are likewise never touched.
 * 2. **Tunnels and covered roads are not barriers.** A road you ski over the top of constrains
 *    nothing, so `tunnel`/`covered` road segments are skipped.
 * 3. **Road bridges are not barriers either — the reverse case.** Where the ROAD is on a bridge,
 *    the terrain passes underneath it and a link across the map footprint is perfectly skiable.
 * 4. **Service roads, tracks and paths are not roads.** Resort access tracks and car-park aisles are
 *    skied straight across all day; only public motor-traffic classes count (`ROAD_HIGHWAYS`).
 *
 * And the standing invariant, as everywhere else in this pipeline: **never strand.** Reachability is
 * judged once against the starting graph and re-checked after the whole set is removed; anything
 * whose removal takes terrain out of the lift network is put back. Some road crossings genuinely
 * are the only way through — a village where skiers walk across a street — and the honest fix there
 * is upstream in OSM, not a link we invented.
 */
import type { GraphEdge, ResortGraph } from '../../src/types/domain';
import type { RawWay } from './overpass';

interface Pt {
  lon: number;
  lat: number;
}

/** Orientation sign of the triangle p->q->r. */
function side(p: Pt, q: Pt, r: Pt): number {
  return Math.sign((q.lon - p.lon) * (r.lat - p.lat) - (q.lat - p.lat) * (r.lon - p.lon));
}

/**
 * Strictly-crossing segments only. Collinear or touching-at-an-endpoint cases are deliberately NOT
 * crossings: a link that merely *ends* on a road is a skier stepping onto it, which is normal at a
 * lift base, and treating that as a barrier would cut the resort off from its own valley stations.
 */
function segmentsCross(a: Pt, b: Pt, c: Pt, d: Pt): boolean {
  const d1 = side(a, b, c);
  const d2 = side(a, b, d);
  const d3 = side(c, d, a);
  const d4 = side(c, d, b);
  return d1 !== d2 && d3 !== d4 && d1 !== 0 && d2 !== 0 && d3 !== 0 && d4 !== 0;
}

/**
 * Reachability, in one direction or the other. **Both** matter and they are different questions:
 * walking edges backwards from the lift stations answers "can this node get back to a lift", while
 * walking forwards answers "can a skier ever get here". A link can be the only thing providing
 * either one. Guarding only the backward direction let this pass silently strand 12 nodes fleet-wide
 * (sella-ronda 9, ischgl/portes/val-thorens 1 each) that could still reach a lift but could no
 * longer be reached from one. `surfaceLiftParallel.ts` guards backwards only; it happens never to
 * have tripped this, but the same latent gap is there.
 */
function reachable(g: ResortGraph, forward: boolean): Set<string> {
  const adj = new Map<string, string[]>();
  for (const e of g.edges) {
    const [k, v] = forward ? [e.from, e.to] : [e.to, e.from];
    (adj.get(k) ?? adj.set(k, []).get(k)!).push(v);
  }
  const seeds = g.nodes.filter((n) => n.kind === 'lift_station').map((n) => n.id);
  const seen = new Set<string>(seeds);
  const queue = [...seeds];
  for (let i = 0; i < queue.length; i++) {
    for (const p of adj.get(queue[i]) ?? []) if (!seen.has(p)) { seen.add(p); queue.push(p); }
  }
  return seen;
}

/** Nodes that lost reachability in EITHER direction. */
function strandedBy(
  graph: ResortGraph,
  before: [Set<string>, Set<string>],
  trial: ResortGraph,
): string[] {
  const afterBack = reachable(trial, false);
  const afterFwd = reachable(trial, true);
  return graph.nodes
    .filter(
      (n) =>
        (before[0].has(n.id) && !afterBack.has(n.id)) || (before[1].has(n.id) && !afterFwd.has(n.id)),
    )
    .map((n) => n.id);
}

export interface RoadCrossingResult {
  graph: ResortGraph;
  dropped: { edgeId: string; kind: string; lengthM: number; roadWayId: number }[];
  keptStranding: number;
}

/**
 * A coarse lon/lat bucket index over road segments. The fleet's biggest resorts carry tens of
 * thousands of road segments against thousands of synthetic edges, and the naive product is slow
 * enough to dominate the build.
 */
const CELL = 0.002; // ~150-220 m depending on latitude

function cellsFor(a: Pt, b: Pt): string[] {
  const lo = (v: number) => Math.floor(v / CELL);
  const x0 = Math.min(lo(a.lon), lo(b.lon));
  const x1 = Math.max(lo(a.lon), lo(b.lon));
  const y0 = Math.min(lo(a.lat), lo(b.lat));
  const y1 = Math.max(lo(a.lat), lo(b.lat));
  const out: string[] = [];
  for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) out.push(`${x}:${y}`);
  return out;
}

export function dropSyntheticRoadCrossings(graph: ResortGraph, roads: RawWay[]): RoadCrossingResult {
  const index = new Map<string, [Pt, Pt, number][]>();
  for (const w of roads) {
    const t = w.tags ?? {};
    if (t.tunnel && t.tunnel !== 'no') continue;
    if (t.covered && t.covered !== 'no') continue;
    if (t.bridge && t.bridge !== 'no') continue;
    const g = w.geometry ?? [];
    for (let i = 1; i < g.length; i++) {
      const seg: [Pt, Pt, number] = [g[i - 1], g[i], w.id];
      for (const c of cellsFor(g[i - 1], g[i])) (index.get(c) ?? index.set(c, []).get(c)!).push(seg);
    }
  }
  if (index.size === 0) return { graph, dropped: [], keptStranding: 0 };

  const crossedRoad = (e: GraphEdge): number | undefined => {
    if (!e.synthetic || e.custom) return undefined;
    const gm = e.geometry ?? [];
    for (let i = 1; i < gm.length; i++) {
      const a = gm[i - 1];
      const b = gm[i];
      const seen = new Set<[Pt, Pt, number]>();
      for (const c of cellsFor(a, b)) {
        for (const seg of index.get(c) ?? []) {
          if (seen.has(seg)) continue;
          seen.add(seg);
          if (segmentsCross(a, b, seg[0], seg[1])) return seg[2];
        }
      }
    }
    return undefined;
  };

  const hits = new Map<string, number>();
  for (const e of graph.edges) {
    const road = crossedRoad(e);
    if (road !== undefined) hits.set(e.id, road);
  }
  if (hits.size === 0) return { graph, dropped: [], keptStranding: 0 };

  const before: [Set<string>, Set<string>] = [reachable(graph, false), reachable(graph, true)];
  const drop = new Set(hits.keys());
  let trial: ResortGraph = { ...graph, edges: graph.edges.filter((e) => !drop.has(e.id)) };
  let keptStranding = 0;

  while (true) {
    const lost = strandedBy(graph, before, trial);
    if (lost.length === 0) break;
    const lostSet = new Set(lost);
    const restore = graph.edges.filter(
      (e) => drop.has(e.id) && (lostSet.has(e.from) || lostSet.has(e.to)),
    );
    if (restore.length === 0) {
      // No candidate explains the loss — refuse to guess and keep the graph as it was.
      return { graph, dropped: [], keptStranding: hits.size };
    }
    for (const e of restore) drop.delete(e.id);
    keptStranding += restore.length;
    trial = { ...graph, edges: graph.edges.filter((e) => !drop.has(e.id)) };
  }

  const dropped = graph.edges
    .filter((e) => drop.has(e.id))
    .map((e) => ({ edgeId: e.id, kind: e.kind, lengthM: e.lengthM, roadWayId: hits.get(e.id)! }));
  return { graph: trial, dropped, keptStranding };
}

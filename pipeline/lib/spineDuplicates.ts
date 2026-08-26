/**
 * Flag polygon geometry that duplicates the centreline the same polygon adopted as its spine.
 *
 * A class A/B′ polygon adopts a real OSM way as its spine, but `areaSkeletonPistes` still emits the
 * polygon's own skeleton lines. Those two frequently describe the *same* piece of terrain: on Val
 * Thorens `w22868803` (spine = Combe de Thorens `w99075767`) 50 of 68 polygon edges sit within 25 m
 * of the adopted line and many sit exactly on it. Cross-linked by short arms, the pair forms a
 * ladder the router climbs sideways, producing the visible "broken lines" weave.
 *
 * We deliberately mark rather than delete. An arm hanging off a duplicate may be the only thing
 * carrying a rim portal inwards, so removing the duplicate could strand it; pricing it instead
 * cannot disconnect anything. Deletion is a possible follow-up once the arms are re-parented.
 *
 * Runs before `weldCoincidentNodes`/`pruneRedundantArms` only because it needs `srcWayId`, which
 * every pass preserves — order is otherwise not significant.
 */
import type { ResortGraph, GraphEdge } from '../../src/types/domain';
import type { PolyResult } from './areaSkeleton';

/**
 * How close a polygon edge must stay to the adopted centreline, along its whole length, to count as
 * a duplicate of it. Deliberately tight: this must catch lines laid on top of the spine without
 * swallowing a genuine skeleton branch that merely starts near it.
 */
const DUP_M = 10;

interface LL {
  lon: number;
  lat: number;
}

/** Metres per degree of longitude at this latitude; latitude is a near-constant 110540. */
function mx(lat: number): number {
  return 111320 * Math.cos((lat * Math.PI) / 180);
}

/** Squared distance from `p` to segment `a`-`b`, in metres², in a local equirectangular frame. */
function segDist2(p: LL, a: LL, b: LL, k: number): number {
  const px = p.lon * k;
  const py = p.lat * 110540;
  const ax = a.lon * k;
  const ay = a.lat * 110540;
  const bx = b.lon * k;
  const by = b.lat * 110540;
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const qx = ax + t * dx;
  const qy = ay + t * dy;
  return (px - qx) ** 2 + (py - qy) ** 2;
}

function geometryOf(e: GraphEdge): LL[] {
  return (e.geometry ?? []) as unknown as LL[];
}

export interface DuplicateReport {
  edges: number;
  lengthM: number;
  polygons: number;
}

export function markSpineDuplicates(graph: ResortGraph, skels: PolyResult[]): DuplicateReport {
  const byWay = new Map<number, GraphEdge[]>();
  for (const e of graph.edges) {
    if (e.srcWayId == null) continue;
    let list = byWay.get(e.srcWayId);
    if (!list) byWay.set(e.srcWayId, (list = []));
    list.push(e);
  }

  const report: DuplicateReport = { edges: 0, lengthM: 0, polygons: 0 };

  for (const poly of skels) {
    // Only a polygon that adopted *someone else's* centreline can have a duplicate of it. A fully
    // synthesised spine (class B) is the only line there is, and must never be penalised.
    const adopted = poly.spineWayIds.filter((w) => w !== poly.wayId);
    if (!adopted.length) continue;

    const spine: LL[][] = [];
    for (const w of adopted) {
      for (const e of byWay.get(w) ?? []) {
        const g = geometryOf(e);
        if (g.length >= 2) spine.push(g);
      }
    }
    if (!spine.length) continue;

    const own = byWay.get(poly.wayId);
    if (!own?.length) continue;

    let hit = 0;
    for (const e of own) {
      if (e.spineDuplicate) continue;
      const g = geometryOf(e);
      if (g.length < 2) continue;
      const k = mx(g[0].lat);
      const lim = DUP_M * DUP_M;
      // Every vertex must be near the adopted line. One stray vertex means the edge leaves the
      // spine and is doing real work somewhere else.
      let all = true;
      for (const p of g) {
        let best = Infinity;
        for (const line of spine) {
          for (let i = 1; i < line.length && best > lim; i++) {
            const d2 = segDist2(p, line[i - 1], line[i], k);
            if (d2 < best) best = d2;
          }
          if (best <= lim) break;
        }
        if (best > lim) {
          all = false;
          break;
        }
      }
      if (!all) continue;
      e.spineDuplicate = true;
      report.edges++;
      report.lengthM += e.lengthM;
      hit++;
    }
    if (hit) report.polygons++;
  }

  return report;
}

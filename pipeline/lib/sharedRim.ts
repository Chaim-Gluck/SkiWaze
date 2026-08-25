/**
 * Shared-boundary ("gateway") detection for area polygons.
 *
 * Two neighbouring `area=yes` piste polygons meet along a run of rim edges that both ways carry, so
 * the same unordered node-id pair appears twice in the graph. Grouping those shared edges into
 * maximal chains gives us the joint boundary of each polygon pair, and the arc-length midpoint of a
 * chain is where a route should cross from one polygon to the other -- mid-boundary rather than at
 * a corner, which is what the raw OSM node sharing would otherwise force.
 *
 * This is detection only; it writes nothing and knows nothing about skeletons.
 */
import type { GraphEdge } from '../../src/types/domain';

const R = 6371000;
const toRad = (d: number): number => (d * Math.PI) / 180;

/** How far apart two ways' rim geometry may sit and still count as the same boundary. */
const COINCIDENT_M = 6;

interface SharedEdge {
  from: string;
  to: string;
  geometry: LL[];
}

export interface LL {
  lon: number;
  lat: number;
}

export interface RimChain {
  wayA: number;
  wayB: number;
  /** Graph node ids along the shared boundary, in order. */
  nodes: string[];
  /** The boundary itself, following the rim edges' own geometry rather than node-to-node chords. */
  polyline: LL[];
  lengthM: number;
  /** Arc-length midpoint of the chain: the gateway position. */
  mid: LL;
}

function distM(a: LL, b: LL): number {
  const mx = (Math.PI / 180) * R * Math.cos(toRad((a.lat + b.lat) / 2));
  const my = (Math.PI / 180) * R;
  return Math.hypot((a.lon - b.lon) * mx, (a.lat - b.lat) * my);
}

const pairKey = (a: string, b: string): string => (a < b ? a + '|' + b : b + '|' + a);

/** How close two node ids must sit to be the same physical point on the rim. */
const CANON_M = 1;

/**
 * Turn at a chain node beyond which the shared boundary counts as two boundaries, not one.
 *
 * A polygon can meet the *same* neighbour along two of its sides -- a corridor wedged into a notch
 * of a bigger polygon touches it left and right, with free rim only across the gap. Those two
 * contacts share the corner node between them, so a plain walk strings them into one chain and
 * drops a single gateway at its arc midpoint, which lands on the corner: a point that was already
 * a portal of both polygons, while the two real mid-boundary crossings get no gateway at all. The
 * corner is the giveaway -- a boundary that reverses direction there is not one stretch of rim.
 * Measured fleet-wide, 88 % of chain corners are under 30 deg and only 3 % of chains have one at or
 * past this threshold, so it separates a genuine curve from a corner without disturbing the rest.
 */
const CORNER_DEG = 60;

/** Angle between the incoming and outgoing directions at `b`; 0 = straight on. */
function deflectionDeg(a: LL, b: LL, c: LL): number {
  const k = Math.cos(toRad(b.lat));
  const ix = (b.lon - a.lon) * k;
  const iy = b.lat - a.lat;
  const ox = (c.lon - b.lon) * k;
  const oy = c.lat - b.lat;
  const li = Math.hypot(ix, iy);
  const lo = Math.hypot(ox, oy);
  if (li === 0 || lo === 0) return 0;
  const cos = (ix * ox + iy * oy) / (li * lo);
  return (Math.acos(Math.max(-1, Math.min(1, cos))) * 180) / Math.PI;
}

/**
 * Collapse coincident node ids to one representative.
 *
 * Two polygons that share a rim do not necessarily share its node *ids*: splitting a way at a
 * junction mints a new id at the same coordinates as the original, so one way carries `nXXX` and
 * its neighbour `snYYY` for the very same metre of boundary. Matching rim edges by id pair then
 * misses that stretch, which cuts the shared chain short, drags its gateway off the true midpoint
 * and leaves the orphaned chain end looking like an unexplained shared node - i.e. a false pinch
 * gateway. Canonicalising is used for *matching* only; callers still report their own raw ids.
 */
function canonIds(pos: Map<string, LL>): Map<string, string> {
  const my = (Math.PI / 180) * R;
  const cells = new Map<string, string[]>();
  const out = new Map<string, string>();
  // Sorted so the representative of a cluster does not depend on map insertion order.
  for (const id of [...pos.keys()].sort()) {
    const p = pos.get(id)!;
    const mx = my * Math.cos(toRad(p.lat));
    const cx = Math.floor((p.lon * mx) / CANON_M);
    const cy = Math.floor((p.lat * my) / CANON_M);
    let rep: string | undefined;
    for (let dx = -1; dx <= 1 && !rep; dx++) {
      for (let dy = -1; dy <= 1 && !rep; dy++) {
        for (const cand of cells.get(`${cx + dx}:${cy + dy}`) ?? []) {
          if (distM(p, pos.get(cand)!) <= CANON_M) {
            rep = cand;
            break;
          }
        }
      }
    }
    if (!rep) {
      rep = id;
      const k = `${cx}:${cy}`;
      if (!cells.has(k)) cells.set(k, []);
      cells.get(k)!.push(id);
    }
    out.set(id, rep);
  }
  return out;
}

/** Distance from p to the segment ab. */
function distToSeg(p: LL, a: LL, b: LL): number {
  const mx = (Math.PI / 180) * R * Math.cos(toRad(p.lat));
  const my = (Math.PI / 180) * R;
  const px = p.lon * mx;
  const py = p.lat * my;
  const ax = a.lon * mx;
  const ay = a.lat * my;
  const bx = b.lon * mx;
  const by = b.lat * my;
  const dx = bx - ax;
  const dy = by - ay;
  const d2 = dx * dx + dy * dy;
  const t = d2 > 0 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / d2)) : 0;
  return Math.hypot(px - (ax + dx * t), py - (ay + dy * t));
}

function distToPolyline(p: LL, line: LL[]): number {
  let best = Infinity;
  for (let i = 1; i < line.length; i++) best = Math.min(best, distToSeg(p, line[i - 1], line[i]));
  return best;
}

function lengthOf(line: LL[]): number {
  let t = 0;
  for (let i = 1; i < line.length; i++) t += distM(line[i - 1], line[i]);
  return t;
}

/**
 * Do two ways run along the *same* rim between the same two nodes?
 *
 * Sharing a node pair is not enough. The graph keeps only junction nodes and folds the rest of a
 * way into `geometry`, so polygons that merely touch at two isolated points still produce the same
 * unordered node pair while each bulges away along its own rim. Treating that as a shared boundary
 * welds unrelated touch points into one chain and drops the gateway on a rim nobody shares.
 */
function sameRim(a: LL[], b: LL[]): boolean {
  const la = lengthOf(a);
  const lb = lengthOf(b);
  if (la < 1 && lb < 1) return true;
  const longer = Math.max(la, lb);
  if (Math.abs(la - lb) > 0.25 * longer) return false;
  const tol = Math.max(COINCIDENT_M, 0.05 * longer);
  for (const p of a) if (distToPolyline(p, b) > tol) return false;
  for (const p of b) if (distToPolyline(p, a) > tol) return false;
  return true;
}

function walkChains(
  wayA: number,
  wayB: number,
  edges: SharedEdge[],
  pos: Map<string, LL>,
): RimChain[] {
  const geomOf = new Map<string, LL[]>();
  for (const e of edges) geomOf.set(pairKey(e.from, e.to), e.geometry);
  const adj = new Map<string, string[]>();
  const push = (a: string, b: string): void => {
    if (!adj.has(a)) adj.set(a, []);
    adj.get(a)!.push(b);
  };
  for (const e of edges) {
    push(e.from, e.to);
    push(e.to, e.from);
  }

  const seenEdge = new Set<string>();
  const out: RimChain[] = [];

  // One chain from one run of nodes: rim-following polyline plus its arc-length midpoint.
  const emit = (nodes: string[]): void => {
    if (nodes.length < 2) return;
    // Follow the rim's own vertices: on a long curved boundary the node-to-node chord can leave
    // the polygon entirely, and a gateway that sits off the rim is not a crossing point.
    const poly: LL[] = [];
    for (let i = 1; i < nodes.length; i++) {
      const a = pos.get(nodes[i - 1]);
      const b = pos.get(nodes[i]);
      if (!a || !b) continue;
      const g = geomOf.get(pairKey(nodes[i - 1], nodes[i]));
      let seg = g ? [...g] : [a, b];
      // Stored geometry runs in the edge's own direction, which may be against the walk.
      if (seg.length > 1) {
        const headToA = distM(seg[0], a);
        const tailToA = distM(seg[seg.length - 1], a);
        if (tailToA < headToA) seg = seg.reverse();
      }
      // Node merging in buildGraph collapses endpoints that fall within the horizontal tolerance
      // onto one node, but leaves each edge's stored geometry at its original coordinates. Fleet
      // wide that leaves 8.8% of edge endpoints (15.5% on area edges) more than 1 m from their own
      // node, up to 42 m. Portals, arms and spines all live in node-position space, so a chain
      // measured in geometry space is systematically biased against them: on a short chain the
      // offset can exceed half its length and the gateway then lands nowhere near midway between
      // its two portals. Keep the geometry's shape - it is the real rim, and a chord across a
      // curved boundary can leave the polygon - but pin the ends to the nodes the chain is
      // actually between.
      if (seg.length > 1) {
        seg = [...seg];
        seg[0] = a;
        seg[seg.length - 1] = b;
      }
      for (const p of seg) {
        const prevPt = poly[poly.length - 1];
        if (prevPt && distM(prevPt, p) < 0.01) continue;
        poly.push(p);
      }
    }
    if (poly.length < 2) return;

    let total = 0;
    const cum = [0];
    for (let i = 1; i < poly.length; i++) {
      total += distM(poly[i - 1], poly[i]);
      cum.push(total);
    }
    let mid: LL = poly[0];
    const half = total / 2;
    for (let i = 1; i < poly.length; i++) {
      if (cum[i] < half) continue;
      const seg = cum[i] - cum[i - 1];
      const t = seg > 0 ? (half - cum[i - 1]) / seg : 0;
      const a = poly[i - 1];
      const b = poly[i];
      mid = { lon: a.lon + (b.lon - a.lon) * t, lat: a.lat + (b.lat - a.lat) * t };
      break;
    }
    out.push({ wayA, wayB, nodes, polyline: poly, lengthM: total, mid });
  };

  // Start from the loose ends so a chain is walked in one piece; a boundary that happens to be a
  // closed ring has none, so fall back to any node.
  const ends = [...adj.keys()].filter((n) => adj.get(n)!.length === 1);
  const starts = ends.length ? ends : [...adj.keys()];

  for (const s of starts) {
    for (const first of adj.get(s)!) {
      if (seenEdge.has(pairKey(s, first))) continue;
      const nodes = [s];
      let prev = s;
      let cur = first;
      for (;;) {
        seenEdge.add(pairKey(prev, cur));
        nodes.push(cur);
        const nexts = (adj.get(cur) ?? []).filter((n) => !seenEdge.has(pairKey(cur, n)));
        // More than one continuation means the shared boundary branches here; stop rather than
        // guess, so each gateway sits on an unambiguous stretch.
        if (nexts.length !== 1) break;
        prev = cur;
        cur = nexts[0];
      }
      if (nodes.length < 2) continue;

      // Cut the walk at every corner (see CORNER_DEG) so each straight-ish stretch of shared rim
      // gets its own gateway. The corner node itself stays in both halves: it is a real node of
      // both polygons and remains available as an ordinary corner portal.
      let start = 0;
      for (let i = 1; i < nodes.length - 1; i++) {
        const a = pos.get(nodes[i - 1]);
        const b = pos.get(nodes[i]);
        const c = pos.get(nodes[i + 1]);
        if (!a || !b || !c) continue;
        if (deflectionDeg(a, b, c) < CORNER_DEG) continue;
        emit(nodes.slice(start, i + 1));
        start = i;
      }
      emit(nodes.slice(start));
    }
  }
  return out;
}

/**
 * Nodes where two polygons touch at a point rather than along a boundary: the ways share the node
 * but no shared rim chain runs through it. These are already portals of both polygons, so they are
 * crossing points as they stand -- nothing is synthesised, they are just identified as gateways.
 *
 * Keyed by way, because a pinch is a property of a *pair*: a node may be a pinch between B and C
 * while polygon A, which also owns it, reaches both along proper shared rims. A must keep it as an
 * ordinary corner portal.
 */
export function pinchNodes(
  byWay: Map<number, GraphEdge[]>,
  chains: RimChain[],
  pos: Map<string, LL>,
): Map<number, Set<string>> {
  const canon = canonIds(pos);
  const cid = (x: string): string => canon.get(x) ?? x;
  // Canonical node -> way -> the raw ids that way uses for that point.
  const waysOfNode = new Map<string, Map<number, Set<string>>>();
  for (const [wayId, edges] of byWay) {
    for (const e of edges) {
      for (const id of [e.from, e.to]) {
        const c = cid(id);
        if (!waysOfNode.has(c)) waysOfNode.set(c, new Map());
        const w = waysOfNode.get(c)!;
        if (!w.has(wayId)) w.set(wayId, new Set());
        w.get(wayId)!.add(id);
      }
    }
  }
  const onChain = new Set<string>();
  for (const c of chains) {
    const pk = c.wayA + '|' + c.wayB;
    for (const n of c.nodes) onChain.add(pk + '|' + n);
  }

  const out = new Map<number, Set<string>>();
  const mark = (way: number, ids: Set<string>): void => {
    if (!out.has(way)) out.set(way, new Set());
    for (const id of ids) out.get(way)!.add(id);
  };
  for (const [id, ways] of waysOfNode) {
    if (ways.size < 2) continue;
    const list = [...ways.keys()].sort((x, y) => x - y);
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        if (onChain.has(list[i] + '|' + list[j] + '|' + id)) continue;
        mark(list[i], ways.get(list[i])!);
        mark(list[j], ways.get(list[j])!);
      }
    }
  }
  return out;
}

/**
 * All shared-boundary chains in a resort. The caller filters by way.
 * `byWay` must hold only area rim edges, grouped by `srcWayId`.
 */
export function sharedRimChains(byWay: Map<number, GraphEdge[]>, pos: Map<string, LL>): RimChain[] {
  const canon = canonIds(pos);
  const cid = (x: string): string => canon.get(x) ?? x;
  const waysOfEdge = new Map<string, Map<number, LL[]>>();
  for (const [wayId, edges] of byWay) {
    for (const e of edges) {
      const a = cid(e.from);
      const b = cid(e.to);
      if (a === b) continue;
      const k = pairKey(a, b);
      if (!waysOfEdge.has(k)) waysOfEdge.set(k, new Map());
      const g = e.geometry.length > 1
        ? e.geometry.map((p) => ({ lon: p.lon, lat: p.lat }))
        : [pos.get(e.from), pos.get(e.to)].filter((p): p is LL => !!p);
      waysOfEdge.get(k)!.set(wayId, g);
    }
  }

  const byPair = new Map<string, { a: number; b: number; edges: SharedEdge[] }>();
  for (const [k, ways] of waysOfEdge) {
    if (ways.size < 2) continue;
    const list = [...ways.keys()].sort((x, y) => x - y);
    const [from, to] = k.split('|');
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const ga = ways.get(list[i])!;
        const gb = ways.get(list[j])!;
        if (!sameRim(ga, gb)) continue;
        const pk = list[i] + '|' + list[j];
        if (!byPair.has(pk)) byPair.set(pk, { a: list[i], b: list[j], edges: [] });
        byPair.get(pk)!.edges.push({ from, to, geometry: ga });
      }
    }
  }

  const out: RimChain[] = [];
  for (const { a, b, edges } of byPair.values()) out.push(...walkChains(a, b, edges, pos));
  return out;
}

// Graph assembly: significant-node detection, 3D snapping/merge, way segmentation,
// piste / lift / connector / flat edge construction, and meaningful-point extraction.
import type {
  DataWarning,
  GeoPoint,
  GraphEdge,
  GraphNode,
  LiftType,
  MeaningfulPoint,
  ResortGraph,
} from '../../src/types/domain';
import { DOWNLOADABLE_LIFT_TYPES } from '../../src/types/domain';
import type { GraphConstants } from '../../src/config/graphConstants';
import { DEFAULT_SPEEDS } from '../../src/config/defaults';
import { haversineM, polylineLength3dM } from '../../src/utils/geo';
import type { NormPiste, NormLift, NormPoint } from './normalize';

// ---- Union-Find -----------------------------------------------------------
class UnionFind {
  private parent = new Map<string, string>();
  find(x: string): string {
    let root = x;
    while (this.parent.get(root) !== undefined && this.parent.get(root) !== root) {
      root = this.parent.get(root)!;
    }
    if (this.parent.get(x) === undefined) this.parent.set(x, x);
    let cur = x;
    while (cur !== root) {
      const next = this.parent.get(cur)!;
      this.parent.set(cur, root);
      cur = next;
    }
    return root;
  }
  union(a: string, b: string): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent.set(ra, rb);
  }
}

function toGeo(p: NormPoint): GeoPoint {
  return { lon: p.lon, lat: p.lat, ele: p.ele };
}

/** Project point p onto segment a-b; returns the closest point, its distance (m), and t in [0,1]. */
function projectOnSegment(
  p: GeoPoint,
  a: GeoPoint,
  b: GeoPoint,
): { point: GeoPoint; dist: number; t: number } {
  const mLat = 111320;
  const mLon = 111320 * Math.cos((p.lat * Math.PI) / 180);
  const ax = (a.lon - p.lon) * mLon;
  const ay = (a.lat - p.lat) * mLat;
  const bx = (b.lon - p.lon) * mLon;
  const by = (b.lat - p.lat) * mLat;
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy || 1;
  let t = -(ax * dx + ay * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  const cx = ax + t * dx;
  const cy = ay + t * dy;
  const dist = Math.hypot(cx, cy);
  const lon = a.lon + t * (b.lon - a.lon);
  const lat = a.lat + t * (b.lat - a.lat);
  const ele = a.ele != null && b.ele != null ? a.ele + t * (b.ele - a.ele) : (a.ele ?? b.ele ?? null);
  return { point: { lon, lat, ele }, dist, t };
}

interface Provisional {
  osmId: number;
  lon: number;
  lat: number;
  ele: number | null;
  isLiftStation: boolean;
}

interface CanonNode {
  id: string;
  lon: number;
  lat: number;
  ele: number | null;
  isLiftStation: boolean;
  members: number[]; // osm ids
}

/** Spatial hash grid for neighbor queries in a small metric window. */
class Grid {
  private cell: number;
  private map = new Map<string, Provisional[]>();
  constructor(cellMeters: number) {
    // ~degrees per meter (latitude); good enough for a resort-scale bbox.
    this.cell = cellMeters / 111320;
  }
  private key(lon: number, lat: number): string {
    return `${Math.floor(lon / this.cell)}:${Math.floor(lat / this.cell)}`;
  }
  add(p: Provisional): void {
    const k = this.key(p.lon, p.lat);
    const arr = this.map.get(k);
    if (arr) arr.push(p);
    else this.map.set(k, [p]);
  }
  neighbors(lon: number, lat: number): Provisional[] {
    const out: Provisional[] = [];
    const cx = Math.floor(lon / this.cell);
    const cy = Math.floor(lat / this.cell);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const arr = this.map.get(`${cx + dx}:${cy + dy}`);
        if (arr) out.push(...arr);
      }
    }
    return out;
  }
}

/**
 * Detect significant nodes (way endpoints + nodes shared by >= 2 ways), then merge
 * provisional nodes that are within BOTH Hmerge and Vmerge into canonical nodes.
 */
function buildCanonicalNodes(
  pistes: NormPiste[],
  lifts: NormLift[],
  c: GraphConstants,
  warnings: DataWarning[],
): { canonicalOf: Map<number, string>; nodes: Map<string, CanonNode> } {
  const wayCount = new Map<number, number>(); // osmId -> distinct ways containing it
  const coord = new Map<number, NormPoint>();
  const liftStation = new Set<number>();

  const register = (points: NormPoint[], isLift: boolean) => {
    const seen = new Set<number>();
    for (const p of points) {
      if (!coord.has(p.osmId)) coord.set(p.osmId, p);
      if (!seen.has(p.osmId)) {
        seen.add(p.osmId);
        wayCount.set(p.osmId, (wayCount.get(p.osmId) ?? 0) + 1);
      }
    }
    if (isLift && points.length >= 2) {
      liftStation.add(points[0].osmId);
      liftStation.add(points[points.length - 1].osmId);
    }
  };
  for (const p of pistes) register(p.points, false);
  for (const l of lifts) register(l.points, true);

  // Significant = endpoint of a way (wayCount considered) OR shared by >= 2 ways.
  const significant = new Set<number>();
  const markEndpoints = (points: NormPoint[]) => {
    if (points.length) {
      significant.add(points[0].osmId);
      significant.add(points[points.length - 1].osmId);
    }
  };
  for (const p of pistes) markEndpoints(p.points);
  for (const l of lifts) markEndpoints(l.points);
  for (const [id, cnt] of wayCount) if (cnt >= 2) significant.add(id);

  // Cluster significant nodes.
  const provisionals: Provisional[] = [...significant].map((osmId) => {
    const pt = coord.get(osmId)!;
    return {
      osmId,
      lon: pt.lon,
      lat: pt.lat,
      ele: pt.ele,
      isLiftStation: liftStation.has(osmId),
    };
  });

  const grid = new Grid(c.Hmerge);
  for (const p of provisionals) grid.add(p);
  const uf = new UnionFind();
  for (const p of provisionals) uf.find(String(p.osmId));
  for (const p of provisionals) {
    for (const q of grid.neighbors(p.lon, p.lat)) {
      if (q.osmId <= p.osmId) continue;
      const h = haversineM(toGeo(p as unknown as NormPoint), toGeo(q as unknown as NormPoint));
      const v =
        p.ele != null && q.ele != null ? Math.abs(p.ele - q.ele) : 0;
      if (h <= c.Hmerge && v <= c.Vmerge) uf.union(String(p.osmId), String(q.osmId));
    }
  }

  // Build canonical nodes from clusters.
  const clusters = new Map<string, Provisional[]>();
  for (const p of provisionals) {
    const root = uf.find(String(p.osmId));
    const arr = clusters.get(root);
    if (arr) arr.push(p);
    else clusters.set(root, [p]);
  }

  const canonicalOf = new Map<number, string>();
  const nodes = new Map<string, CanonNode>();
  let idx = 0;
  for (const members of clusters.values()) {
    const id = `n${idx++}`;
    const lon = members.reduce((s, m) => s + m.lon, 0) / members.length;
    const lat = members.reduce((s, m) => s + m.lat, 0) / members.length;
    const eles = members.map((m) => m.ele).filter((e): e is number => e != null);
    const ele = eles.length ? eles.reduce((s, e) => s + e, 0) / eles.length : null;
    const node: CanonNode = {
      id,
      lon,
      lat,
      ele,
      isLiftStation: members.some((m) => m.isLiftStation),
      members: members.map((m) => m.osmId),
    };
    nodes.set(id, node);
    for (const m of members) canonicalOf.set(m.osmId, id);
    // Flag suspicious merges: a cluster spanning more vertical range than Vmerge
    // (can happen via transitive unions) may have wrongly merged stacked points.
    if (eles.length >= 2) {
      const span = Math.max(...eles) - Math.min(...eles);
      if (span > c.Vmerge * 1.5) {
        warnings.push({
          code: 'suspicious_merge',
          message: `Node ${id} merges points spanning ${span.toFixed(1)} m vertically (> Vmerge). Review in overrides.`,
          refs: [id],
        });
      }
    }
  }
  return { canonicalOf, nodes };
}

/** A raw segment of a way between two consecutive significant nodes. */
interface Segment {
  from: string;
  to: string;
  geometry: GeoPoint[];
}

/** Split a way's points into segments between significant (canonical-mapped) nodes. */
function segmentWay(points: NormPoint[], canonicalOf: Map<number, string>): Segment[] {
  const segs: Segment[] = [];
  let startIdx = 0;
  for (let i = 1; i < points.length; i++) {
    const canon = canonicalOf.get(points[i].osmId);
    const isSignificant = canon !== undefined && i !== startIdx;
    if (isSignificant || i === points.length - 1) {
      const fromCanon = canonicalOf.get(points[startIdx].osmId);
      const toCanon = canonicalOf.get(points[i].osmId);
      if (fromCanon && toCanon && fromCanon !== toCanon) {
        segs.push({
          from: fromCanon,
          to: toCanon,
          geometry: points.slice(startIdx, i + 1).map(toGeo),
        });
      }
      startIdx = i;
    }
  }
  return segs;
}

function isDownloadable(lt: LiftType): boolean {
  return DOWNLOADABLE_LIFT_TYPES.has(lt);
}

/** Nodes that can reach a lift station following directed edges (reverse BFS from stations). */
function reachLiftStations(edges: GraphEdge[], liftStationIds: string[]): Set<string> {
  const rev = new Map<string, string[]>();
  for (const e of edges) {
    const arr = rev.get(e.to);
    if (arr) arr.push(e.from);
    else rev.set(e.to, [e.from]);
  }
  const seen = new Set<string>(liftStationIds);
  const queue = [...liftStationIds];
  while (queue.length) {
    const cur = queue.shift()!;
    for (const prev of rev.get(cur) ?? []) {
      if (!seen.has(prev)) {
        seen.add(prev);
        queue.push(prev);
      }
    }
  }
  return seen;
}

function liftRideSeconds(lt: LiftType, lengthM: number, durationSec?: number): number {
  if (durationSec && durationSec > 0) return durationSec;
  const speed = DEFAULT_SPEEDS.liftSpeedByType[lt] ?? DEFAULT_SPEEDS.fallbackLiftSpeed;
  return lengthM / speed;
}

/**
 * Build the full resort graph: piste edges (descending), flat traverses (bidirectional),
 * lift edges (up, plus down for downloadable types), and inferred skiable connectors.
 */
export function buildResortGraph(
  resortId: string,
  pistes: NormPiste[],
  lifts: NormLift[],
  c: GraphConstants,
): ResortGraph {
  const warnings: DataWarning[] = [];
  const { canonicalOf, nodes } = buildCanonicalNodes(pistes, lifts, c, warnings);

  const edges: GraphEdge[] = [];
  let edgeIdx = 0;
  const nextEdgeId = () => `e${edgeIdx++}`;
  const node = (id: string) => nodes.get(id)!;
  const nodeGeo = (id: string): GeoPoint => {
    const n = node(id);
    return { lon: n.lon, lat: n.lat, ele: n.ele };
  };

  // --- Piste + flat edges -------------------------------------------------
  const pisteEndpointNames: { nodeId: string; name: string; role: 'top' | 'bottom' }[] = [];
  for (const piste of pistes) {
    for (const seg of segmentWay(piste.points, canonicalOf)) {
      const a = node(seg.from);
      const b = node(seg.to);
      const lengthM = polylineLength3dM(seg.geometry);
      if (lengthM < 1) continue;
      const drop = a.ele != null && b.ele != null ? b.ele - a.ele : 0;

      if (Math.abs(drop) <= c.pisteFlatTolerance) {
        // Flat piste patch: bidirectional traverse (absorbs surrounding direction).
        for (const [from, to] of [
          [seg.from, seg.to],
          [seg.to, seg.from],
        ] as const) {
          edges.push({
            id: nextEdgeId(),
            from,
            to,
            kind: 'connector',
            connectorKind: 'flat_traverse',
            geometry: from === seg.from ? seg.geometry : [...seg.geometry].reverse(),
            lengthM,
            dropM: 0,
            color: piste.color,
            pisteName: piste.name,
            pisteRef: piste.ref,
            area: piste.area || undefined,
          });
        }
      } else {
        // Orient descending: high -> low.
        const descendFromA = drop < 0;
        const from = descendFromA ? seg.from : seg.to;
        const to = descendFromA ? seg.to : seg.from;
        const geometry = descendFromA ? seg.geometry : [...seg.geometry].reverse();
        edges.push({
          id: nextEdgeId(),
          from,
          to,
          kind: 'piste',
          geometry,
          lengthM,
          dropM: -Math.abs(drop),
          color: piste.color,
          pisteName: piste.name,
          pisteRef: piste.ref,
          area: piste.area || undefined,
        });
        const label = piste.ref && piste.name ? `${piste.ref} ${piste.name}` : piste.ref ? `Piste ${piste.ref}` : piste.name;
        if (label) {
          pisteEndpointNames.push({ nodeId: from, name: label, role: 'top' });
          pisteEndpointNames.push({ nodeId: to, name: label, role: 'bottom' });
        }
        // Near-flat cat-track: also traversable in reverse (skate/pole the gentle rise),
        // but only when the actual rise is small — you can't climb toward a summit.
        const grade = Math.abs(drop) / lengthM;
        if (grade <= c.flatGradeMax && Math.abs(drop) <= c.maxTraverseClimb) {
          edges.push({
            id: nextEdgeId(),
            from: to,
            to: from,
            kind: 'connector',
            connectorKind: 'flat_traverse',
            geometry: [...geometry].reverse(),
            lengthM,
            dropM: 0,
            color: piste.color,
            pisteName: piste.name,
            pisteRef: piste.ref,
            area: piste.area || undefined,
          });
        }
      }
    }
  }

  // --- Lift edges ---------------------------------------------------------
  const liftStationNames: { nodeId: string; name: string; role: 'top' | 'bottom' }[] = [];
  for (const lift of lifts) {
    const segs = segmentWay(lift.points, canonicalOf);
    // Treat the whole lift as bottom-station to top-station using its overall endpoints.
    for (const seg of segs) {
      const a = node(seg.from);
      const b = node(seg.to);
      const lengthM = polylineLength3dM(seg.geometry);
      if (lengthM < 1) continue;
      const aEle = a.ele ?? 0;
      const bEle = b.ele ?? 0;
      // Bottom = lower station.
      const bottomId = aEle <= bEle ? seg.from : seg.to;
      const topId = aEle <= bEle ? seg.to : seg.from;
      const upGeom = bottomId === seg.from ? seg.geometry : [...seg.geometry].reverse();
      const ride = liftRideSeconds(lift.liftType, lengthM, lift.durationSec);
      const drop = Math.abs((b.ele ?? 0) - (a.ele ?? 0));

      const upEdge: GraphEdge = {
        id: nextEdgeId(),
        from: bottomId,
        to: topId,
        kind: 'lift',
        geometry: upGeom,
        lengthM,
        dropM: drop,
        liftType: lift.liftType,
        liftName: lift.name,
        isDownload: false,
        openingHours: lift.openingHours,
      };
      // Attach ride time hint via geometry length is recomputed in router; keep openingHours.
      edges.push(upEdge);
      void ride; // ride time is derived in the router from speeds/duration.

      if (isDownloadable(lift.liftType)) {
        edges.push({
          id: nextEdgeId(),
          from: topId,
          to: bottomId,
          kind: 'lift',
          geometry: [...upGeom].reverse(),
          lengthM,
          dropM: -drop,
          liftType: lift.liftType,
          liftName: lift.name,
          isDownload: true,
          openingHours: lift.openingHours,
        });
      }

      if (lift.name) {
        liftStationNames.push({ nodeId: bottomId, name: lift.name, role: 'bottom' });
        liftStationNames.push({ nodeId: topId, name: lift.name, role: 'top' });
      }
      if (!lift.openingHours) {
        warnings.push({
          code: 'missing_opening_hours',
          message: `Lift "${lift.name ?? lift.wayId}" has no opening_hours in OSM.`,
        });
      }
    }
  }

  // --- Snap dead-end piste endpoints onto nearby piste lines (T-junctions) ------
  // OSM often draws a run that ends ON another run's line (not at a shared node), leaving
  // a routing gap. For each descent dead-end, if another piste's polyline passes within
  // snapToLineRadius, split that piste at the projection and add a short link. This closes
  // the "endpoint touches another run's middle" gap class.
  {
    const descOutSnap = new Set<string>();
    const descInSnap = new Set<string>();
    for (const e of edges) {
      // Arriving by piste OR lift deposits a skier who wants to ski on...
      if (e.kind === 'piste' || e.kind === 'lift' || (e.kind === 'connector' && e.connectorKind === 'skiable_down')) {
        descInSnap.add(e.to);
      }
      // ...but only a piste/skiable descent counts as being able to SKI onward (a lift back
      // down does not — a lift-only top must still be linked to the ski network).
      if (e.kind === 'piste' || (e.kind === 'connector' && e.connectorKind === 'skiable_down')) {
        descOutSnap.add(e.from);
      }
    }
    const deadEnds = [...nodes.values()].filter((n) => descInSnap.has(n.id) && !descOutSnap.has(n.id) && n.ele != null);
    let nextNodeNum = nodes.size;
    let snapped = 0;
    for (const E of deadEnds) {
      const ep: GeoPoint = { lon: E.lon, lat: E.lat, ele: E.ele };
      let best: { edge: GraphEdge; segIdx: number; point: GeoPoint; dist: number } | null = null;
      for (const X of edges) {
        if (X.kind !== 'piste' || X.from === E.id || X.to === E.id) continue;
        for (let i = 1; i < X.geometry.length; i++) {
          const pr = projectOnSegment(ep, X.geometry[i - 1], X.geometry[i]);
          if (pr.dist <= c.snapToLineRadius && pr.dist < (best?.dist ?? Infinity)) {
            best = { edge: X, segIdx: i, point: pr.point, dist: pr.dist };
          }
        }
      }
      if (!best) continue;
      const X = best.edge;
      const P = best.point;
      const N = `n${nextNodeNum++}`;
      nodes.set(N, { id: N, lon: P.lon, lat: P.lat, ele: P.ele, isLiftStation: false, members: [] });
      // Split X at P (preserving its downhill direction and attributes).
      const g1 = [...X.geometry.slice(0, best.segIdx), P];
      const g2 = [P, ...X.geometry.slice(best.segIdx)];
      const fromEle = nodes.get(X.from)?.ele ?? 0;
      const toEle = nodes.get(X.to)?.ele ?? 0;
      const idx = edges.indexOf(X);
      if (idx >= 0) edges.splice(idx, 1);
      edges.push({ ...X, id: nextEdgeId(), to: N, geometry: g1, lengthM: polylineLength3dM(g1), dropM: (P.ele ?? 0) - fromEle });
      edges.push({ ...X, id: nextEdgeId(), from: N, geometry: g2, lengthM: polylineLength3dM(g2), dropM: toEle - (P.ele ?? 0) });
      // Link the dead-end onto the run at N. A very close touch (<= Hmerge) is a real
      // junction (not flagged); a larger gap is an app guess (flagged synthetic).
      const dz = (P.ele ?? 0) - E.ele;
      const flagged = best.dist > c.Hmerge;
      if (dz < -c.maxTraverseClimb) {
        edges.push({ id: nextEdgeId(), from: E.id, to: N, kind: 'connector', connectorKind: 'skiable_down', geometry: [ep, P], lengthM: best.dist, dropM: -Math.abs(dz), synthetic: flagged });
      } else {
        edges.push({ id: nextEdgeId(), from: E.id, to: N, kind: 'connector', connectorKind: 'flat_traverse', geometry: [ep, P], lengthM: best.dist, dropM: 0, synthetic: flagged });
        edges.push({ id: nextEdgeId(), from: N, to: E.id, kind: 'connector', connectorKind: 'flat_traverse', geometry: [P, ep], lengthM: best.dist, dropM: 0, synthetic: flagged });
      }
      snapped++;
    }
    if (snapped > 0) {
      warnings.push({ code: 'inferred_connector', message: `Snapped ${snapped} dead-end run(s) onto a nearby piste line (T-junction).` });
    }
  }

  // --- Inferred skiable / flat connectors --------------------------------
  // Only bridge "stuck" nodes: a place a skier can reach but cannot continue from
  // (no outgoing piste/lift/connector). This avoids densely interlinking every nearby
  // pair while still closing genuine gaps (piste end near a lift base or another run).
  const nodeList = [...nodes.values()];
  const hasIncoming = new Set<string>();
  const canContinue = new Set<string>();
  for (const e of edges) {
    hasIncoming.add(e.to);
    // Only a piste/skiable descent counts as "can ski onward". A lift does NOT (a lift-only
    // top can't be skied off), and a flat traverse must not mask a missing descent.
    if (e.kind === 'piste' || (e.kind === 'connector' && e.connectorKind === 'skiable_down')) {
      canContinue.add(e.from);
    }
  }
  const cgrid = new Grid(c.bridgeRadius);
  for (const n of nodeList) {
    cgrid.add({ osmId: Number(n.id.slice(1)), lon: n.lon, lat: n.lat, ele: n.ele, isLiftStation: n.isLiftStation });
  }
  const existingPair = new Set<string>();
  for (const e of edges) existingPair.add(`${e.from}->${e.to}`);

  let inferred = 0;
  const MAX_LINKS_PER_STUCK = 2;
  for (const a of nodeList) {
    // A node is "stuck" if something leads into it but nothing leads onward.
    const stuck = hasIncoming.has(a.id) && !canContinue.has(a.id);
    if (!stuck || a.ele == null) continue;

    const candidates: { b: CanonNode; h: number; dz: number; flat: boolean }[] = [];
    for (const nb of cgrid.neighbors(a.lon, a.lat)) {
      const b = nodes.get(`n${nb.osmId}`);
      if (!b || b.id === a.id || b.ele == null) continue;
      const h = haversineM({ lon: a.lon, lat: a.lat, ele: a.ele }, { lon: b.lon, lat: b.lat, ele: b.ele });
      if (h <= c.Hmerge || h > c.bridgeRadius) continue;
      // B must offer a way onward.
      if (!canContinue.has(b.id) && !b.isLiftStation) continue;
      const dz = b.ele - a.ele;
      const grade = Math.abs(dz) / h;
      const flat = Math.abs(dz) <= c.Vflat && h <= c.flatBridgeMax;
      // Skiable if descending (B lower) within grade limits, or a short near-flat traverse.
      const descend = dz < -c.Vflat && grade <= c.maxGrade;
      if (!flat && !descend) continue;
      candidates.push({ b, h, dz, flat });
    }
    // Prefer descending continuations, then the nearest.
    candidates.sort((x, y) => Number(x.flat) - Number(y.flat) || x.h - y.h);

    for (const { b, h, dz, flat } of candidates.slice(0, MAX_LINKS_PER_STUCK)) {
      if (flat) {
        for (const [from, to] of [[a.id, b.id], [b.id, a.id]] as const) {
          if (existingPair.has(`${from}->${to}`)) continue;
          existingPair.add(`${from}->${to}`);
          edges.push({
            id: nextEdgeId(),
            from,
            to,
            kind: 'connector',
            connectorKind: 'flat_traverse',
            geometry: [nodeGeo(from), nodeGeo(to)],
            lengthM: h,
            dropM: 0,
            gradient: 0,
            synthetic: true,
          });
        }
      } else {
        // a is the stuck (higher) end -> descend to b.
        if (existingPair.has(`${a.id}->${b.id}`)) continue;
        existingPair.add(`${a.id}->${b.id}`);
        edges.push({
          id: nextEdgeId(),
          from: a.id,
          to: b.id,
          kind: 'connector',
          connectorKind: 'skiable_down',
          geometry: [nodeGeo(a.id), nodeGeo(b.id)],
          lengthM: h,
          dropM: -Math.abs(dz),
          gradient: -Math.abs(dz) / h,
          synthetic: true,
        });
        canContinue.add(a.id); // a now has a real descent
      }
      inferred++;
    }
  }
  if (inferred > 0) {
    warnings.push({
      code: 'inferred_connector',
      message: `Inferred ${inferred} skiable/flat connector(s) to bridge stuck nodes.`,
    });
  }

  // --- Flat-junction pass -------------------------------------------------
  // Fill "dummy gaps": flat areas (restaurant aprons, lift bases, cols) where a run visibly
  // ends and another begins across a level patch, but OSM leaves a gap. To avoid wrongly
  // linking two *parallel* runs, only bridge a DANGLING piste end — a node where a run
  // terminates (arrives, nothing onward) or starts (leaves, nothing leads in) — to a partner
  // that supplies the missing direction, at ~the same elevation (DEM-noise tolerant).
  const descIn = new Set<string>();
  const descOut = new Set<string>();
  for (const e of edges) {
    if (e.kind === 'piste' || e.kind === 'lift' || (e.kind === 'connector' && e.connectorKind === 'skiable_down')) {
      descIn.add(e.to);
    }
    // Lift does not count as skiing onward (a lift-only top is a dangling end).
    if (e.kind === 'piste' || (e.kind === 'connector' && e.connectorKind === 'skiable_down')) {
      descOut.add(e.from);
    }
  }
  const fjGrid = new Grid(c.flatJunctionRadius);
  for (const n of nodeList) {
    fjGrid.add({ osmId: Number(n.id.slice(1)), lon: n.lon, lat: n.lat, ele: n.ele, isLiftStation: n.isLiftStation });
  }
  let flatLinks = 0;
  for (const a of nodeList) {
    if (a.ele == null) continue;
    const deadEnd = descIn.has(a.id) && !descOut.has(a.id); // arrives, no way onward
    const deadStart = descOut.has(a.id) && !descIn.has(a.id); // leaves, nothing leads in
    if (!deadEnd && !deadStart) continue;

    const near: { b: CanonNode; h: number }[] = [];
    for (const nb of fjGrid.neighbors(a.lon, a.lat)) {
      const b = nodes.get(`n${nb.osmId}`);
      if (!b || b.id === a.id || b.ele == null) continue;
      if (Math.abs(b.ele - a.ele) > c.flatJunctionDV) continue; // not the same flat area
      const h = haversineM({ lon: a.lon, lat: a.lat, ele: a.ele }, { lon: b.lon, lat: b.lat, ele: b.ele });
      if (h <= c.Hmerge || h > c.flatJunctionRadius) continue;
      // Partner must supply the missing direction.
      if (deadEnd) {
        if (!descOut.has(b.id) && !b.isLiftStation) continue;
      } else {
        // deadStart: needs something that leads into it.
        if (!descIn.has(b.id)) continue;
      }
      near.push({ b, h });
    }
    near.sort((x, y) => x.h - y.h);
    for (const { b, h } of near.slice(0, c.flatJunctionK)) {
      for (const [from, to] of [[a.id, b.id], [b.id, a.id]] as const) {
        if (existingPair.has(`${from}->${to}`)) continue;
        existingPair.add(`${from}->${to}`);
        edges.push({
          id: nextEdgeId(),
          from,
          to,
          kind: 'connector',
          connectorKind: 'flat_traverse',
          geometry: [nodeGeo(from), nodeGeo(to)],
          lengthM: h,
          dropM: 0,
          gradient: 0,
          synthetic: true,
        });
      }
      // Mark so subsequent dangling ends see this node as connected.
      if (deadEnd) descOut.add(a.id);
      if (deadStart) descIn.add(a.id);
      flatLinks++;
    }
  }
  if (flatLinks > 0) {
    warnings.push({
      code: 'inferred_connector',
      message: `Added ${flatLinks} flat-junction traverse(s) bridging dangling run ends across level areas.`,
    });
  }

  // --- Rescue pass: guarantee no run is a dead route ----------------------
  // A node is "trapped" if a skier can reach it (incoming) but from it cannot reach ANY
  // lift station via any edges. Force a flat connector to the best nearby reachable node,
  // preferring lower/level escapers (short skate/traverse). Repeat for small chains.
  const liftStationIds = nodeList.filter((n) => n.isLiftStation).map((n) => n.id);
  const rgrid = new Grid(c.rescueRadius);
  for (const n of nodeList) {
    rgrid.add({ osmId: Number(n.id.slice(1)), lon: n.lon, lat: n.lat, ele: n.ele, isLiftStation: n.isLiftStation });
  }
  let rescued = 0;
  for (let pass = 0; pass < 3; pass++) {
    const canReach = reachLiftStations(edges, liftStationIds);
    let passRescued = 0;
    for (const a of nodeList) {
      if (a.isLiftStation || a.ele == null) continue;
      if (!hasIncoming.has(a.id) || canReach.has(a.id)) continue;
      // Pick the reachable escaper with the best score (near + not much of a climb).
      let best: CanonNode | undefined;
      let bestScore = Infinity;
      let bestH = 0;
      for (const nb of rgrid.neighbors(a.lon, a.lat)) {
        const b = nodes.get(`n${nb.osmId}`);
        if (!b || b.id === a.id || b.ele == null || !canReach.has(b.id)) continue;
        const h = haversineM({ lon: a.lon, lat: a.lat, ele: a.ele }, { lon: b.lon, lat: b.lat, ele: b.ele });
        if (h <= c.Hmerge || h > c.rescueRadius) continue;
        const climb = Math.max(0, b.ele - a.ele);
        if (climb > c.maxTraverseClimb) continue; // never rescue via an impossible uphill link
        const score = h + climb * 6; // strongly prefer descending/level exits
        if (score < bestScore) {
          bestScore = score;
          best = b;
          bestH = h;
        }
      }
      if (best) {
        const dz = best.ele! - a.ele; // a = trapped node
        // If a descends significantly to its escaper, make it a ONE-WAY skiable link so the
        // reverse direction can't be abused to climb. Only near-level links stay bidirectional.
        const oneWayDown = dz < -c.maxTraverseClimb;
        const dirs: [string, string][] = oneWayDown
          ? [[a.id, best.id]]
          : [[a.id, best.id], [best.id, a.id]];
        for (const [from, to] of dirs) {
          if (existingPair.has(`${from}->${to}`)) continue;
          existingPair.add(`${from}->${to}`);
          edges.push({
            id: nextEdgeId(),
            from,
            to,
            kind: 'connector',
            connectorKind: oneWayDown ? 'skiable_down' : 'flat_traverse',
            geometry: [nodeGeo(from), nodeGeo(to)],
            lengthM: bestH,
            dropM: oneWayDown ? -Math.abs(dz) : 0,
            gradient: oneWayDown ? -Math.abs(dz) / bestH : 0,
            synthetic: true,
          });
        }
        rescued++;
        passRescued++;
      }
    }
    if (passRescued === 0) break;
  }
  if (rescued > 0) {
    warnings.push({
      code: 'inferred_connector',
      message: `Rescued ${rescued} trapped node(s) with a forced traverse to the nearest reachable point.`,
    });
  }

  // --- Lift-top ski-out snap ---------------------------------------------
  // A lift top you can only ride back down (no ski-out at all) but a piste passes within
  // liftSkiOutRadius mid-edge. Unlike the general 45m endpoint snap (node-to-line) and the
  // node-to-node bridge/rescue passes, this targets lift tops specifically with a larger
  // radius and projects onto the nearest downhill point of a piste line (splitting it).
  {
    const liftTops = new Set<string>();
    for (const e of edges) if (e.kind === 'lift' && !e.isDownload) liftTops.add(e.to);
    const hasNonLiftOut = new Set<string>();
    for (const e of edges) if (e.kind !== 'lift') hasNonLiftOut.add(e.from);
    let nextNodeNum = nodes.size;
    let linked = 0;
    for (const topId of liftTops) {
      if (hasNonLiftOut.has(topId)) continue; // already has a ski-out
      const T = nodes.get(topId);
      if (!T || T.ele == null) continue;
      const tp: GeoPoint = { lon: T.lon, lat: T.lat, ele: T.ele };
      let best: { edge: GraphEdge; segIdx: number; point: GeoPoint; dist: number } | null = null;
      for (const X of edges) {
        if (X.kind !== 'piste' || X.from === topId || X.to === topId) continue;
        for (let i = 1; i < X.geometry.length; i++) {
          const pr = projectOnSegment(tp, X.geometry[i - 1], X.geometry[i]);
          // Only a downhill ski-on: the projected point must be at/below the lift top.
          if ((pr.point.ele ?? 0) > T.ele + 2) continue;
          if (pr.dist <= c.liftSkiOutRadius && pr.dist < (best?.dist ?? Infinity)) {
            best = { edge: X, segIdx: i, point: pr.point, dist: pr.dist };
          }
        }
      }
      if (!best) continue;
      const X = best.edge;
      const P = best.point;

      // Reuse an existing endpoint if the projection lands on it; otherwise split X.
      const fromN = nodes.get(X.from)!;
      const toN = nodes.get(X.to)!;
      const dFrom = haversineM(P, { lon: fromN.lon, lat: fromN.lat, ele: fromN.ele });
      const dTo = haversineM(P, { lon: toN.lon, lat: toN.lat, ele: toN.ele });
      let N: string;
      if (dFrom <= 3) {
        N = X.from;
      } else if (dTo <= 3) {
        N = X.to;
      } else {
        N = `n${nextNodeNum++}`;
        nodes.set(N, { id: N, lon: P.lon, lat: P.lat, ele: P.ele, isLiftStation: false, members: [] });
        const g1 = [...X.geometry.slice(0, best.segIdx), P];
        const g2 = [P, ...X.geometry.slice(best.segIdx)];
        const fromEle = fromN.ele ?? 0;
        const toEle = toN.ele ?? 0;
        const idx = edges.indexOf(X);
        if (idx >= 0) edges.splice(idx, 1);
        edges.push({ ...X, id: nextEdgeId(), to: N, geometry: g1, lengthM: polylineLength3dM(g1), dropM: (P.ele ?? 0) - fromEle });
        edges.push({ ...X, id: nextEdgeId(), from: N, geometry: g2, lengthM: polylineLength3dM(g2), dropM: toEle - (P.ele ?? 0) });
      }

      const dz = (P.ele ?? 0) - T.ele; // typically <= 0 (ski down onto the run)
      const oneWayDown = dz < -c.maxTraverseClimb;
      edges.push({
        id: nextEdgeId(),
        from: topId,
        to: N,
        kind: 'connector',
        connectorKind: oneWayDown ? 'skiable_down' : 'flat_traverse',
        geometry: [tp, { lon: nodes.get(N)!.lon, lat: nodes.get(N)!.lat, ele: nodes.get(N)!.ele }],
        lengthM: best.dist,
        dropM: oneWayDown ? -Math.abs(dz) : 0,
        gradient: best.dist > 0 ? dz / best.dist : 0,
        synthetic: true,
      });
      if (!oneWayDown) {
        edges.push({
          id: nextEdgeId(),
          from: N,
          to: topId,
          kind: 'connector',
          connectorKind: 'flat_traverse',
          geometry: [{ lon: nodes.get(N)!.lon, lat: nodes.get(N)!.lat, ele: nodes.get(N)!.ele }, tp],
          lengthM: best.dist,
          dropM: 0,
          synthetic: true,
        });
      }
      linked++;
    }
    if (linked > 0) {
      warnings.push({
        code: 'inferred_connector',
        message: `Linked ${linked} lift top(s) with no ski-out onto a nearby piste line.`,
      });
    }
  }

  // --- Finalize nodes -----------------------------------------------------
  const degree = new Map<string, number>();
  for (const e of edges) {
    degree.set(e.from, (degree.get(e.from) ?? 0) + 1);
    degree.set(e.to, (degree.get(e.to) ?? 0) + 1);
  }
  // Iterate the live node map (not the earlier `nodeList` snapshot) so nodes created by
  // late passes (e.g. lift-top ski-out splits) are included — otherwise their edges dangle.
  const graphNodes: GraphNode[] = [...nodes.values()].map((n) => ({
    id: n.id,
    point: { lon: n.lon, lat: n.lat, ele: n.ele },
    kind: n.isLiftStation
      ? 'lift_station'
      : (degree.get(n.id) ?? 0) >= 3
        ? 'junction'
        : 'piste_endpoint',
    name: undefined,
  }));

  // --- Meaningful points (A/B picker) ------------------------------------
  const points = buildMeaningfulPoints(nodes, liftStationNames, pisteEndpointNames);

  return {
    resortId,
    generatedAt: new Date().toISOString(),
    nodes: graphNodes,
    edges,
    points,
    warnings,
  };
}

function buildMeaningfulPoints(
  nodes: Map<string, CanonNode>,
  liftStations: { nodeId: string; name: string; role: 'top' | 'bottom' }[],
  pisteEndpoints: { nodeId: string; name: string; role: 'top' | 'bottom' }[],
): MeaningfulPoint[] {
  type Cat = 'lift' | 'piste';
  interface Pick { nodeId: string; name: string; role: 'top' | 'bottom'; cat: Cat }

  // A run/lift is usually split into many segments, producing many "top"/"bottom" points.
  // Collapse each (category, name, role) to a SINGLE extreme node: the highest-elevation
  // node for "top", the lowest for "bottom". This removes confusing duplicate entries.
  const pick = new Map<string, Pick>();
  const consider = (nodeId: string, name: string, role: 'top' | 'bottom', cat: Cat) => {
    const n = nodes.get(nodeId);
    if (!n || n.ele == null) return;
    const key = `${cat}|${name}|${role}`;
    const cur = pick.get(key);
    if (!cur) {
      pick.set(key, { nodeId, name, role, cat });
      return;
    }
    const curEle = nodes.get(cur.nodeId)?.ele ?? 0;
    const better = role === 'top' ? n.ele > curEle : n.ele < curEle;
    if (better) pick.set(key, { nodeId, name, role, cat });
  };
  for (const s of liftStations) consider(s.nodeId, s.name, s.role, 'lift');
  for (const p of pisteEndpoints) consider(p.nodeId, p.name, p.role, 'piste');

  const out: MeaningfulPoint[] = [];
  const usedNode = new Set<string>();
  // Prefer lift labels when a node is shared between a lift and a piste endpoint.
  const entries = [...pick.values()].sort((a, b) => (a.cat === 'lift' ? 0 : 1) - (b.cat === 'lift' ? 0 : 1));
  for (const e of entries) {
    if (usedNode.has(e.nodeId)) continue;
    const n = nodes.get(e.nodeId)!;
    usedNode.add(e.nodeId);
    const type: MeaningfulPoint['type'] =
      e.cat === 'lift'
        ? e.role === 'top' ? 'lift_top' : 'lift_bottom'
        : e.role === 'top' ? 'piste_top' : 'piste_bottom';
    const eleTag = n.ele != null ? ` \u00b7 ${Math.round(n.ele)} m` : '';
    out.push({
      id: `p${out.length}`,
      name: `${e.name} (${e.role})${eleTag}`,
      type,
      nodeId: e.nodeId,
      point: { lon: n.lon, lat: n.lat, ele: n.ele },
    });
  }
  out.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  return out;
}

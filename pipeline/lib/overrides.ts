// Apply an optional per-resort overrides.json to correct heuristic mistakes.
// Applied LAST so humans can fix wrong auto-decisions without changing code.
import fs from 'node:fs';
import path from 'node:path';
import type { GeoPoint, GraphEdge, LiftType, ResortGraph } from '../../src/types/domain';
import { haversineM, polylineLength3dM } from '../../src/utils/geo';
import { DEFAULT_GRAPH_CONSTANTS } from '../../src/config/graphConstants';

export interface Overrides {
  /** Groups of node ids to force-merge into a single node. */
  mergeNodes?: string[][];
  /**
   * Correct a mis-sampled node elevation (e.g. a DEM spike/dip at a junction). After the
   * correction, any piste edge touching the node is re-oriented to descend (high→low) and
   * its dropM/geometry endpoint elevations are recomputed, so arrows, cost and longest-run
   * stay consistent. Reusable across resorts.
   */
  setNodeElevation?: { node: string; ele: number }[];
  /** Edge ids to delete. */
  removeEdges?: string[];
  /**
   * Remove non-skiable pistes that OSM tagged as ski runs/connections (roads, walking paths,
   * mapping bugs). Match by exact `name`, and/or by a `bbox` [minLon,minLat,maxLon,maxLat]
   * (bbox only removes UNRATED pistes fully inside it, so it can't clip a real coloured run).
   */
  removePistes?: { name?: string; bbox?: [number, number, number, number] }[];
  /**
   * Remove lifts that are not usable by skiers (e.g. a foot-passenger sightseeing gondola), by
   * exact `liftName`. All lift edges with that name — up and any download — are dropped from the
   * routing graph so routes never board them.
   */
  removeLifts?: { liftName: string }[];
  /**
   * Reclassify a piste (that is really a lift OSM mis-tagged as piste:type=connection) into a
   * lift of the given type. `bidirectional` (e.g. a funicular) keeps both travel directions.
   */
  reclassifyLift?: { pisteName: string; liftType: LiftType; bidirectional?: boolean }[];
  /**
   * Split a piste at an interior point so a connector can attach to the MIDDLE of a run.
   * OSM only guarantees a node where two ways meet, but a real-world branch often leaves a run
   * part-way along it — and then `addConnectors` has nothing to join to. Matches the nearest
   * interior vertex of a piste with the given `pisteRef`/`pisteName` within `radius` metres
   * (default 30) and splits every piste edge passing through it, so a run and any reverse
   * traverse over the same ground stay consistent. The minted node id is derived from the
   * coordinate rather than an OSM id, so it survives a `data:refresh` renumbering.
   */
  splitPisteAt?: {
    /** [lon, lat] of the branch point. */
    at: [number, number];
    pisteRef?: string;
    pisteName?: string;
    radius?: number;
    /** Optional readable id for the minted node; defaults to a coordinate-derived one. */
    node?: string;
  }[];
  /** Extra connectors to add. */
  addConnectors?: {
    from: string;
    to: string;
    kind: 'skiable_down' | 'flat_traverse';
    bidirectional?: boolean;
  }[];
  /** Force a lift's download capability on/off by lift name. */
  setLiftDownload?: { liftName: string; canDownload: boolean }[];
  /**
   * Reversal candidates that `npm run check:elevation` should stop reporting because a human
   * checked them on the map and our orientation is right (the DEM is wrong, not us). Matched
   * on the two endpoints in either direction. This is purely an audit filter — it never
   * touches the graph — so the remaining audit output stays signal rather than known noise.
   */
  ignoreReversals?: { from: string; to: string; why?: string }[];
}

export function loadOverrides(resortId: string, dir: string): Overrides | null {
  const file = path.join(dir, `${resortId}.json`);
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf8')) as Overrides;
}

export function applyOverrides(graph: ResortGraph, ov: Overrides): ResortGraph {
  let nodes = graph.nodes;
  let edges = graph.edges;
  let points = graph.points;

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

  // 2-lift. Remove non-skiable lifts (e.g. foot-passenger sightseeing gondolas) by name.
  if (ov.removeLifts?.length) {
    const deadLifts = new Set(ov.removeLifts.map((r) => r.liftName));
    edges = edges.filter((e) => !(e.kind === 'lift' && e.liftName != null && deadLifts.has(e.liftName)));
  }

  // 2a. Remove non-skiable pistes (roads/paths/mapping bugs) by name and/or bbox.
  if (ov.removePistes?.length) {
    const names = new Set(ov.removePistes.map((r) => r.name).filter((n): n is string => !!n));
    const boxes = ov.removePistes.map((r) => r.bbox).filter((b): b is [number, number, number, number] => !!b);
    const inBox = (p: { lon: number; lat: number }, b: [number, number, number, number]) =>
      p.lon >= b[0] && p.lat >= b[1] && p.lon <= b[2] && p.lat <= b[3];
    edges = edges.filter((e) => {
      if (e.pisteName && names.has(e.pisteName)) return false;
      // bbox removes an UNRATED edge whose midpoint is inside a box (robust to boundary
      // crossings; can't clip a real coloured run since those are never unrated).
      if (boxes.length && (e.color === 'unknown' || e.color == null)) {
        const mid = e.geometry[Math.floor(e.geometry.length / 2)];
        if (mid && boxes.some((b) => inBox(mid, b))) return false;
      }
      return true;
    });
  }

  // 2c. Reclassify a piste that is really a lift (OSM tagged it piste:type=connection) into a
  // lift edge, keeping geometry. All matching-name edges become lift edges (so a bidirectional
  // funicular stays usable both ways); non-bidirectional keeps only the uphill direction.
  if (ov.reclassifyLift?.length) {
    const spec = new Map(ov.reclassifyLift.map((r) => [r.pisteName, r]));
    const eleOf = new Map(nodes.map((n) => [n.id, n.point.ele ?? 0]));
    let li = 0;
    const kept: GraphEdge[] = [];
    const seenPair = new Set<string>();
    for (const e of edges) {
      const r = e.pisteName ? spec.get(e.pisteName) : undefined;
      if (!r) {
        kept.push(e);
        continue;
      }
      const uphill = (eleOf.get(e.to) ?? 0) >= (eleOf.get(e.from) ?? 0);
      if (!r.bidirectional && !uphill) continue; // one-way lift: drop the downhill copy
      const key = [e.from, e.to].sort().join('~');
      if (!r.bidirectional && seenPair.has(key)) continue; // keep a single uphill edge per pair
      seenPair.add(key);
      kept.push({
        id: `eovl${li++}`,
        from: e.from,
        to: e.to,
        kind: 'lift',
        liftType: r.liftType,
        liftName: e.pisteName,
        isDownload: !uphill, // downhill copy renders once-skipped by emit, still routable
        geometry: e.geometry,
        lengthM: e.lengthM,
        dropM: (eleOf.get(e.to) ?? 0) - (eleOf.get(e.from) ?? 0),
      });
    }
    edges = kept;
  }

  // 2b. Correct mis-sampled node elevations, then re-derive direction/drop for touching
  // piste edges (a DEM spike/dip at a junction can orient a segment the wrong way).
  if (ov.setNodeElevation?.length) {
    const corr = new Map(ov.setNodeElevation.map((s) => [s.node, s.ele]));
    nodes = nodes.map((n) =>
      corr.has(n.id) ? { ...n, point: { ...n.point, ele: corr.get(n.id)! } } : n,
    );
    // Refresh the "· <ele> m" suffix baked into meaningful-point labels at build time, so the
    // A/B picker shows the corrected height instead of the stale DEM value.
    points = points.map((p) => {
      if (!corr.has(p.nodeId)) return p;
      const ele = Math.round(corr.get(p.nodeId)!);
      const name = /\u00b7\s*-?\d+\s*m/.test(p.name)
        ? p.name.replace(/\u00b7\s*-?\d+\s*m/, `\u00b7 ${ele} m`)
        : `${p.name} \u00b7 ${ele} m`;
      return { ...p, name };
    });
    const eleOf = new Map(nodes.map((n) => [n.id, n.point.ele ?? 0]));
    const flatTol = DEFAULT_GRAPH_CONSTANTS.pisteFlatTolerance;
    edges = edges
      .map((e): GraphEdge | null => {
        if (!corr.has(e.from) && !corr.has(e.to)) return e;
        const geom = e.geometry.map((p) => ({ ...p }));
        if (geom.length >= 2) {
          geom[0] = { ...geom[0], ele: eleOf.get(e.from) ?? geom[0].ele };
          geom[geom.length - 1] = { ...geom[geom.length - 1], ele: eleOf.get(e.to) ?? geom[geom.length - 1].ele };
        }
        if (e.connectorKind === 'flat_traverse') {
          const drop = (eleOf.get(e.to) ?? 0) - (eleOf.get(e.from) ?? 0);
          // If the correction reveals this "flat" is really a slope (drop now exceeds the flat
          // tolerance), promote the DOWNHILL direction to a one-way piste and drop the uphill
          // reverse partner — otherwise a mis-sampled near-flat run stays a dashed 2-way link.
          if (Math.abs(drop) > flatTol) {
            if (drop >= 0) return null; // uphill half of the pair → remove
            const { connectorKind: _flat, ...rest } = e;
            return { ...rest, kind: 'piste', geometry: geom, lengthM: polylineLength3dM(geom), dropM: drop };
          }
          // Genuinely flat: stay directionless (dropM 0), only refresh geometry.
          return { ...e, geometry: geom };
        }
        const drop = (eleOf.get(e.to) ?? 0) - (eleOf.get(e.from) ?? 0);
        // Lifts are directional by construction (up, or a marked download): keep their direction
        // and just refresh the signed drop, so correcting a station height can't invert/negate it.
        if (e.kind === 'lift') return { ...e, geometry: geom, dropM: drop };
        // A piste (or skiable_down connector) now pointing uphill is flipped to descend.
        if (drop > 0 && (e.kind === 'piste' || e.connectorKind === 'skiable_down')) {
          return { ...e, from: e.to, to: e.from, geometry: [...geom].reverse(), dropM: -Math.abs(drop) };
        }
        return { ...e, geometry: geom, dropM: -Math.abs(drop) };
      })
      .filter((e): e is GraphEdge => e !== null);
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

  // 4. Split pistes at explicit branch points, so connectors can attach mid-run.
  if (ov.splitPisteAt?.length) {
    const cut = (e: GraphEdge, id: string, from: string, to: string, geometry: GeoPoint[]): GraphEdge => {
      const dz = (geometry[geometry.length - 1].ele ?? 0) - (geometry[0].ele ?? 0);
      const next: GraphEdge = { ...e, id, from, to, geometry, lengthM: polylineLength3dM(geometry), dropM: dz };
      if (e.gradient != null) {
        next.gradient = dz / Math.max(1, haversineM(geometry[0], geometry[geometry.length - 1]));
      }
      return next;
    };
    for (const s of ov.splitPisteAt) {
      const target = { lon: s.at[0], lat: s.at[1] };
      const radius = s.radius ?? 30;
      let best: { d: number; p: GeoPoint } | null = null;
      for (const e of edges) {
        if (e.kind !== 'piste') continue;
        if (s.pisteRef && e.pisteRef !== s.pisteRef) continue;
        if (s.pisteName && e.pisteName !== s.pisteName) continue;
        for (let i = 1; i < e.geometry.length - 1; i++) {
          const d = haversineM(target, e.geometry[i]);
          if (d <= radius && (!best || d < best.d)) best = { d, p: e.geometry[i] };
        }
      }
      if (!best) continue;
      const at = best.p;
      const id = s.node ?? `xn${at.lon.toFixed(5)}_${at.lat.toFixed(5)}`.replace(/[.-]/g, '_');
      if (!nodes.some((n) => n.id === id)) nodes = [...nodes, { id, point: at, kind: 'junction' }];
      const out: GraphEdge[] = [];
      for (const e of edges) {
        const i = e.kind === 'piste' ? e.geometry.findIndex((p) => haversineM(p, at) < 0.5) : -1;
        if (i <= 0 || i >= e.geometry.length - 1) {
          out.push(e);
          continue;
        }
        out.push(
          cut(e, `${e.id}a`, e.from, id, e.geometry.slice(0, i + 1)),
          cut(e, `${e.id}b`, id, e.to, e.geometry.slice(i)),
        );
      }
      edges = out;
    }
  }

  // 5. Add connectors.
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

  return { ...graph, nodes, edges, points };
}

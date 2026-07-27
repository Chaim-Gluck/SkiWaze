import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  GraphEdge,
  GraphNode,
  GeoPoint,
  Preferences,
  ResortGraph,
  Route,
  RouteObjective,
} from './types/domain';
import type { GeoFeatureCollection, ResortIndexEntry } from './data/resortData';
import { loadResortGeo, loadResortGraph, loadResortIndex } from './data/resortData';
import { loadPreferences, savePreferences } from './state/preferences';
import { loadCustomEdges, saveCustomEdges } from './state/customEdges';
import { loadCustomNodes, saveCustomNodes, type CustomNode } from './state/customNodes';
import { buildEffectiveGraph } from './routing/customGraph';
import { loadClosures, saveClosures } from './state/closures';
import { geometryForClosure } from './routing/closures';
import { nearestNode, nearestResort } from './utils/nearest';
import { distance3dM, haversineM, projectOnPolyline } from './utils/geo';
import { planRoutes, findLongestRuns, routeForEdges, type PlanResult, type LongestRun } from './routing/plan';
import { buildRoutePath, snapToRoute, sliceAt, remainingStats, nextStep, type RoutePath } from './routing/navigation';
import { useLiveLocation, type LivePosition } from './hooks/useLiveLocation';
import { NavOverlay } from './components/NavOverlay';
import type { NavRender } from './components/MapView';
import { MeasuredSpeedsPanel } from './components/MeasuredSpeedsPanel';
import {
  loadMeasured, saveMeasured, emptyMeasured, addSample, measuredAverages, isSpeedColor,
  type MeasuredSpeeds, type SpeedColor,
} from './state/measuredSpeeds';
import { SKILL_SPEED_MULTIPLIER } from './config/defaults';
import { MapView, type LonLat, type RouteFeatureCollection } from './components/MapView';
import { PointPicker } from './components/PointPicker';
import { AccordionSection } from './components/AccordionSection';
import { PreferencesPanel } from './components/PreferencesPanel';
import { RouteOptions } from './components/RouteOptions';
import { CustomLinkPanel, type LinkColor, type LinkDirection } from './components/CustomLinkPanel';
import { ClosedPanel } from './components/ClosedPanel';
import { LongestRunPanel } from './components/LongestRunPanel';
import { Legend } from './components/Legend';
import { Logo } from './components/Logo';
import './App.css';

const DEFAULT_RESORT_ID = 'madonna-di-campiglio';

/** A custom-link endpoint: an existing graph node, or an arbitrary map point. */
type LinkEnd =
  | { kind: 'node'; nodeId: string; label: string }
  | { kind: 'point'; lon: number; lat: number; label: string };

const LINK_NODE_SNAP_M = 15;
const LINK_EDGE_SNAP_M = 40;

function nowLocalDatetime(offsetMinutes = 60): string {
  const d = new Date(Date.now() + offsetMinutes * 60000);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * Optional map deep-link from the URL, e.g. `?resort=cervinia-zermatt&at=45.897,7.658&z=18`.
 * `at` is "lat,lon". Used to jump the map straight to a spot (e.g. to verify a slope's arrow).
 */
function parseDeepLink(): { resortId?: string; lon?: number; lat?: number; zoom?: number } {
  try {
    const q = new URLSearchParams(window.location.search);
    const resortId = q.get('resort') ?? undefined;
    let lon: number | undefined;
    let lat: number | undefined;
    const at = q.get('at');
    if (at) {
      const [a, b] = at.split(',').map((s) => parseFloat(s.trim()));
      if (Number.isFinite(a) && Number.isFinite(b)) {
        lat = a;
        lon = b;
      }
    }
    const z = q.get('z');
    const zoom = z != null && Number.isFinite(parseFloat(z)) ? parseFloat(z) : undefined;
    return { resortId, lon, lat, zoom };
  } catch {
    return {};
  }
}

export default function App() {
  const [deepLink] = useState(parseDeepLink);
  const [index, setIndex] = useState<ResortIndexEntry[] | null>(null);
  const [resortId, setResortId] = useState<string>(deepLink.resortId ?? DEFAULT_RESORT_ID);
  const [deepLinkActive, setDeepLinkActive] = useState(deepLink.lat != null && deepLink.lon != null);
  const [graph, setGraph] = useState<ResortGraph | null>(null);
  const [geo, setGeo] = useState<GeoFeatureCollection | null>(null);
  const [prefs, setPrefs] = useState<Preferences>(() => loadPreferences());
  const [customEdges, setCustomEdges] = useState<GraphEdge[]>([]);
  const [customNodes, setCustomNodes] = useState<CustomNode[]>([]);
  const [linkFrom, setLinkFrom] = useState<LinkEnd | null>(null);
  const [linkTo, setLinkTo] = useState<LinkEnd | null>(null);
  const [linkPinMode, setLinkPinMode] = useState<'from' | 'to' | null>(null);
  const [closedKeys, setClosedKeys] = useState<string[]>([]);
  const closedRef = useRef<string[]>([]);

  const [fromNodeId, setFromNodeId] = useState<string | null>(null);
  const [toNodeId, setToNodeId] = useState<string | null>(null);
  const [fromCustom, setFromCustom] = useState<string | null>(null);
  const [toCustom, setToCustom] = useState<string | null>(null);
  const [pinMode, setPinMode] = useState<'from' | 'to' | null>(null);

  const [objective, setObjective] = useState<RouteObjective>('fastest');
  const [timingMode, setTimingMode] = useState<'now' | 'arrive_by'>('now');
  const [arriveTime, setArriveTime] = useState<string>(() => nowLocalDatetime());

  const [plan, setPlan] = useState<PlanResult | null>(null);
  const [selectedRoute, setSelectedRoute] = useState(0);
  const [selectedRange, setSelectedRange] = useState<[number, number] | null>(null);
  const [popup, setPopup] = useState<string | null>(null);
  const [status, setStatus] = useState<string>('Loading resorts…');
  const [focusGeometry, setFocusGeometry] = useState<[number, number][] | null>(null);
  const [longestRuns, setLongestRuns] = useState<(LongestRun & { startName: string; endName: string })[] | null>(null);
  const [longestIdx, setLongestIdx] = useState(0);
  const [panelOpen, setPanelOpen] = useState(false);
  const [openSection, setOpenSection] = useState<string>('plan');

  // Live location + turn-by-turn navigation (Phase 1 + 2).
  const live = useLiveLocation();
  const [simPos, setSimPos] = useState<LivePosition | null>(null);
  const userPos = simPos ?? live.position;
  const [following, setFollowing] = useState(true);
  const [navRoute, setNavRoute] = useState<Route | null>(null);
  const [measured, setMeasured] = useState<MeasuredSpeeds>(() => loadMeasured());
  const MIN_SAMPLES = 15;
  const toggleSection = (id: string) => setOpenSection((cur) => (cur === id ? '' : id));

  const geolocated = useRef(false);

  useEffect(() => savePreferences(prefs), [prefs]);

  // Load resort index + pick default (by geolocation, else Madonna).
  useEffect(() => {
    loadResortIndex()
      .then((entries) => {
        setIndex(entries);
        const hasDefault = entries.some((e) => e.id === DEFAULT_RESORT_ID);
        const linked = deepLink.resortId && entries.some((e) => e.id === deepLink.resortId);
        setResortId(
          linked ? deepLink.resortId! : hasDefault ? DEFAULT_RESORT_ID : entries[0]?.id ?? DEFAULT_RESORT_ID,
        );
        setStatus('');
        if (!linked && !geolocated.current && 'geolocation' in navigator) {
          geolocated.current = true;
          navigator.geolocation.getCurrentPosition(
            (pos) => {
              // Only switch if the user is actually near a resort (within ~50 km — covers a
              // large ski area's extent + a nearby town); otherwise keep the default (Madonna)
              // instead of jumping to the nearest Alp from afar.
              const near = nearestResort(entries, pos.coords.longitude, pos.coords.latitude, 50_000);
              if (near) setResortId(near.id);
            },
            () => {},
            { timeout: 5000 },
          );
        }
      })
      .catch((e) => setStatus(`Could not load resorts: ${String(e)}`));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Load graph + geo + custom edges when resort changes.
  useEffect(() => {
    if (!resortId) return;
    setGraph(null);
    setGeo(null);
    setPlan(null);
    setSelectedRange(null);
    setLongestRuns(null);
    setLongestIdx(0);
    setFocusGeometry(null);
    setFromNodeId(null);
    setToNodeId(null);
    setCustomEdges(loadCustomEdges(resortId));
    setCustomNodes(loadCustomNodes(resortId));
    setLinkFrom(null);
    setLinkTo(null);
    setLinkPinMode(null);
    const cl = loadClosures(resortId);
    setClosedKeys(cl);
    closedRef.current = cl;
    setStatus('Loading resort data…');
    Promise.all([loadResortGraph(resortId), loadResortGeo(resortId)])
      .then(([g, ge]) => {
        setGraph(g);
        setGeo(ge);
        setStatus('');
      })
      .catch((e) => setStatus(`Could not load resort: ${String(e)}`));
  }, [resortId]);

  // Graph + geo including any user-added custom nodes/links.
  const effectiveGraph = useMemo<ResortGraph | null>(() => {
    if (!graph) return null;
    return buildEffectiveGraph(graph, customNodes, customEdges);
  }, [graph, customNodes, customEdges]);

  const effectiveGeo = useMemo<GeoFeatureCollection | null>(() => {
    if (!geo) return null;
    if (customEdges.length === 0) return geo;
    const extra = customEdges.map((e) => ({
      type: 'Feature' as const,
      properties: {
        kind: e.kind,
        color: e.color ?? null,
        liftType: null,
        name: e.pisteName ?? 'Custom link',
        connectorKind: e.connectorKind ?? null,
        synthetic: true,
        custom: true,
      },
      geometry: { type: 'LineString' as const, coordinates: e.geometry.map((p) => [p.lon, p.lat] as [number, number]) },
    }));
    return { type: 'FeatureCollection', features: [...geo.features, ...extra] };
  }, [geo, customEdges]);

  const resortEntry = index?.find((e) => e.id === resortId);
  const center: LonLat =
    deepLinkActive && deepLink.lon != null && deepLink.lat != null
      ? { lon: deepLink.lon, lat: deepLink.lat }
      : resortEntry
        ? { lon: resortEntry.center.lon, lat: resortEntry.center.lat }
        : { lon: 10.826, lat: 46.23 };

  const nodeMap = useMemo(() => {
    const m = new Map<string, GraphNode>();
    effectiveGraph?.nodes.forEach((n) => m.set(n.id, n));
    return m;
  }, [effectiveGraph]);

  const edgeMap = useMemo(() => {
    const m = new Map<string, GraphEdge>();
    effectiveGraph?.edges.forEach((e) => m.set(e.id, e));
    return m;
  }, [effectiveGraph]);

  const pointFor = (nodeId: string | null): LonLat | null => {
    if (!nodeId) return null;
    const n = nodeMap.get(nodeId);
    return n ? { lon: n.point.lon, lat: n.point.lat } : null;
  };

  const linkEndPos = (end: LinkEnd | null): LonLat | null => {
    if (!end) return null;
    if (end.kind === 'point') return { lon: end.lon, lat: end.lat };
    return pointFor(end.nodeId);
  };

  const selected: Route | undefined = plan?.routes[selectedRoute];
  const routeFC: RouteFeatureCollection = useMemo(() => {
    if (!selected) return { type: 'FeatureCollection', features: [] };
    return {
      type: 'FeatureCollection',
      features: selected.legs
        .map((l, i) => {
          const edge = edgeMap.get(l.edgeId);
          if (!edge) return null;
          return {
            type: 'Feature' as const,
            properties: {
              color: l.color ?? null,
              kind: l.kind,
              stepIndex: i,
              synthetic: edge.synthetic ?? false,
              custom: edge.custom ?? false,
            },
            geometry: {
              type: 'LineString' as const,
              coordinates: edge.geometry.map((p) => [p.lon, p.lat] as [number, number]),
            },
          };
        })
        .filter((f): f is NonNullable<typeof f> => f !== null),
    };
  }, [selected, edgeMap]);

  const geomOf = useCallback(
    (edgeId: string): [number, number][] | undefined =>
      edgeMap.get(edgeId)?.geometry.map((p) => [p.lon, p.lat] as [number, number]),
    [edgeMap],
  );

  const navPath = useMemo<RoutePath | null>(
    () => (navRoute ? buildRoutePath(navRoute, geomOf) : null),
    [navRoute, geomOf],
  );

  const navData = useMemo(() => {
    if (!navRoute || !navPath || !userPos) return null;
    const snap = snapToRoute(navPath, userPos.lon, userPos.lat);
    if (!snap) return null;
    const { traveled, remaining } = sliceAt(navPath, snap.s);
    const render: NavRender = { lon: snap.lon, lat: snap.lat, bearing: snap.bearing, traveled, remaining };
    const curLeg = navRoute.legs[snap.leg];
    return {
      render,
      rem: remainingStats(navRoute, navPath, snap),
      step: nextStep(navRoute, navPath, snap),
      offRoute: snap.offM > Math.max(30, (userPos.accuracy || 0) + 20),
      legKind: curLeg?.kind,
      legColor: curLeg?.color,
    };
  }, [navRoute, navPath, userPos]);

  const onLocateToggle = () => {
    if (!live.tracking && !simPos) {
      live.start();
      setFollowing(true);
    } else if (!following) {
      setFollowing(true);
    } else {
      live.stop();
      setSimPos(null);
      setFollowing(true);
    }
  };

  const startNav = () => {
    if (!selected) {
      setPopup('Find and pick a route first, then start navigation.');
      return;
    }
    setNavRoute(selected);
    setFollowing(true);
    if (!live.tracking && !simPos) live.start();
  };
  const exitNav = () => {
    setNavRoute(null);
    setSimPos(null);
  };
  const rerouteFromHere = () => {
    if (!effectiveGraph || !userPos || !toNodeId) return;
    const near = nearestNode(effectiveGraph, userPos.lon, userPos.lat);
    if (!near) return;
    const result = planRoutes(effectiveGraph, {
      resortId,
      fromNodeId: near.id,
      toNodeId,
      objective,
      timing:
        timingMode === 'arrive_by'
          ? { mode: 'arrive_by', time: new Date(arriveTime).toISOString() }
          : { mode: 'now' },
      prefs,
      closedKeys: closedRef.current,
    });
    if (result.error || !result.routes.length) {
      setPopup(result.error || 'No route from your current position.');
      return;
    }
    setPlan(result);
    setSelectedRoute(0);
    setNavRoute(result.routes[0]);
  };

  // Keep the screen awake while navigating.
  useEffect(() => {
    if (!navRoute) return;
    let lock: { release?: () => Promise<void> } | null = null;
    const req = async () => {
      try {
        lock = await (navigator as unknown as { wakeLock?: { request: (t: string) => Promise<typeof lock> } }).wakeLock?.request('screen') ?? null;
      } catch { /* wake lock is best-effort */ }
    };
    void req();
    const onVis = () => {
      if (document.visibilityState === 'visible' && !lock) void req();
    };
    document.addEventListener('visibilitychange', onVis);
    return () => {
      document.removeEventListener('visibilitychange', onVis);
      void lock?.release?.();
      lock = null;
    };
  }, [navRoute]);

  // Record real skiing speed per piste colour while navigating (feeds "my measured speeds").
  const navDataRef = useRef(navData);
  navDataRef.current = navData;
  useEffect(() => {
    if (!navRoute || !userPos || userPos.speed == null) return;
    const sp = userPos.speed;
    if (sp < 0.8 || sp > 35) return; // filter GPS noise / stationary
    const nd = navDataRef.current;
    if (nd?.legKind !== 'piste' || !isSpeedColor(nd.legColor)) return;
    const color = nd.legColor;
    setMeasured((m) => {
      const nm = addSample(m, color, sp);
      saveMeasured(nm);
      return nm;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userPos]);

  const applyMeasured = () => {
    const avg = measuredAverages(measured, MIN_SAMPLES);
    const colors = Object.keys(avg) as SpeedColor[];
    if (!colors.length) {
      setPopup('Not enough measured data yet — ski a bit on each colour while navigating.');
      return;
    }
    setPrefs((p) => {
      const skiSpeedByColor = { ...p.speeds.skiSpeedByColor };
      for (const c of colors) if (avg[c] != null) skiSpeedByColor[c] = avg[c] as number;
      return { ...p, skillLevel: 'average', speeds: { ...p.speeds, skiSpeedByColor } };
    });
    setPopup('Applied your measured speeds. Skill level set to Average so they’re used as-is.');
  };
  const resetMeasured = () => {
    const m = emptyMeasured();
    saveMeasured(m);
    setMeasured(m);
  };
  // Effective (routing) ski speed per colour: base × the skill-level multiplier.
  const skillMult = SKILL_SPEED_MULTIPLIER[prefs.skillLevel] ?? 1;
  const estimatedByColor: Record<SpeedColor, number> = {
    green: prefs.speeds.skiSpeedByColor.green * skillMult,
    blue: prefs.speeds.skiSpeedByColor.blue * skillMult,
    red: prefs.speeds.skiSpeedByColor.red * skillMult,
    black: prefs.speeds.skiSpeedByColor.black * skillMult,
  };

  const handleMapClick = useCallback(
    (p: LonLat) => {
      if (linkPinMode) {
        const label = `📍 map point`;
        if (linkPinMode === 'from') setLinkFrom({ kind: 'point', lon: p.lon, lat: p.lat, label });
        else setLinkTo({ kind: 'point', lon: p.lon, lat: p.lat, label });
        setLinkPinMode(null);
        return;
      }
      if (!pinMode || !effectiveGraph) return;
      const n = nearestNode(effectiveGraph, p.lon, p.lat);
      if (!n) return;
      if (pinMode === 'from') {
        setFromNodeId(n.id);
        setFromCustom(n.name ?? 'Pinned location');
      } else {
        setToNodeId(n.id);
        setToCustom(n.name ?? 'Pinned location');
      }
      setPinMode(null);
    },
    [pinMode, linkPinMode, effectiveGraph],
  );

  const pickLocationFor = (which: 'from' | 'to') => {
    if (!effectiveGraph || !('geolocation' in navigator)) {
      setPopup('Geolocation is not available in this browser.');
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const n = nearestNode(effectiveGraph, pos.coords.longitude, pos.coords.latitude);
        if (!n) return;
        if (which === 'from') { setFromNodeId(n.id); setFromCustom('My location'); }
        else { setToNodeId(n.id); setToCustom('My location'); }
      },
      () => setPopup('Could not get your location. Pick a point or pin on the map instead.'),
      { timeout: 5000 },
    );
  };

  const doPlan = (fromId: string | null = fromNodeId, toId: string | null = toNodeId) => {
    if (!effectiveGraph || !fromId || !toId) {
      setPopup('Pick both a start and a destination first.');
      return;
    }
    const result = planRoutes(effectiveGraph, {
      resortId,
      fromNodeId: fromId,
      toNodeId: toId,
      objective,
      timing:
        timingMode === 'arrive_by'
          ? { mode: 'arrive_by', time: new Date(arriveTime).toISOString() }
          : { mode: 'now' },
      prefs,
      closedKeys: closedRef.current,
    });
    setPlan(result);
    setSelectedRoute(0);
    setSelectedRange(null);
    setFocusGeometry(null);
    setPanelOpen(false);
    setOpenSection('routes');
    if (result.error) {
      setPopup(result.error);
      return;
    }
    const codes = new Set(result.routes.flatMap((r) => r.warnings.map((w) => w.code)));
    const notes: string[] = [];
    if (codes.has('missing_opening_hours')) notes.push('Some lifts have no opening-hours data — closing-time warnings may be missing.');
    if (codes.has('using_default_wait')) notes.push('Default lift wait times were used (no measured data).');
    if (codes.has('using_default_speed')) notes.push('Default ski speeds were used for some runs (unknown difficulty).');
    if (notes.length) setPopup(notes.join('\n'));
  };

  // Resolve a link endpoint to a concrete node id, creating a custom node for an arbitrary
  // point: snap to a nearby existing node, else attach onto the nearest piste (split it), else
  // a free node. Returns the node id/point and any new custom node to persist.
  const resolveLinkEnd = (
    end: LinkEnd,
  ): { id: string; point: GeoPoint; newNode?: CustomNode } | null => {
    if (!graph) return null;
    if (end.kind === 'node') {
      const n = nodeMap.get(end.nodeId);
      return n ? { id: n.id, point: n.point } : null;
    }
    const pt: GeoPoint = { lon: end.lon, lat: end.lat, ele: null };
    // 1) snap to a very near existing node
    let nn: GraphNode | undefined;
    let nnDist = Infinity;
    for (const n of graph.nodes) {
      const d = haversineM(pt, n.point);
      if (d < nnDist) { nnDist = d; nn = n; }
    }
    if (nn && nnDist <= LINK_NODE_SNAP_M) return { id: nn.id, point: nn.point };

    // 2) project onto the nearest piste edge (attach + split there)
    let bestEdge: GraphEdge | undefined;
    let bestProj: ReturnType<typeof projectOnPolyline> | undefined;
    for (const e of graph.edges) {
      if (e.kind !== 'piste' || e.geometry.length < 2) continue;
      const pr = projectOnPolyline(pt, e.geometry);
      if (pr.dist < (bestProj?.dist ?? Infinity)) { bestProj = pr; bestEdge = e; }
    }
    const id = `cn-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    if (bestEdge && bestProj && bestProj.dist <= LINK_EDGE_SNAP_M) {
      const node: CustomNode = { id, point: bestProj.point, attachEdgeId: bestEdge.id };
      return { id, point: bestProj.point, newNode: node };
    }
    // 3) free node — elevation from the nearest existing node
    const ele = nn?.point.ele ?? null;
    const node: CustomNode = { id, point: { lon: pt.lon, lat: pt.lat, ele } };
    return { id, point: node.point, newNode: node };
  };

  const addCustomLink = (color: LinkColor, direction: LinkDirection) => {
    if (!linkFrom || !linkTo) {
      setPopup('Pick both a "Link from" and a "Link to" point for the link.');
      return;
    }
    const a = resolveLinkEnd(linkFrom);
    const b = resolveLinkEnd(linkTo);
    if (!a || !b || a.id === b.id) {
      setPopup('Pick two different points for the link.');
      return;
    }
    const len = distance3dM(a.point, b.point);
    const stamp = Date.now();
    const mk = (from: { id: string; point: GeoPoint }, to: { id: string; point: GeoPoint }, tag: string): GraphEdge => ({
      id: `cust-${stamp}-${tag}`,
      from: from.id,
      to: to.id,
      kind: color === 'none' ? 'connector' : 'piste',
      geometry: [from.point, to.point],
      lengthM: len,
      dropM: (to.point.ele ?? 0) - (from.point.ele ?? 0),
      color: color === 'none' ? undefined : color,
      pisteName: color === 'none' ? undefined : 'Custom link',
      connectorKind: color === 'none' ? 'flat_traverse' : undefined,
      synthetic: true,
      custom: true,
    });
    const added: GraphEdge[] = [];
    if (direction === 'ab' || direction === 'both') added.push(mk(a, b, 'ab'));
    if (direction === 'ba' || direction === 'both') added.push(mk(b, a, 'ba'));

    const newNodes = [a.newNode, b.newNode].filter((n): n is CustomNode => !!n);
    if (newNodes.length) {
      const nextNodes = [...customNodes, ...newNodes];
      setCustomNodes(nextNodes);
      saveCustomNodes(resortId, nextNodes);
    }
    const next = [...customEdges, ...added];
    setCustomEdges(next);
    saveCustomEdges(resortId, next);
    setLinkFrom(null);
    setLinkTo(null);
    setPopup(`Added a ${color === 'none' ? 'flat' : color} link (${direction === 'both' ? 'both ways' : direction.toUpperCase()}). Press "Find routes" to use it.`);
  };

  /** Drop custom nodes no longer referenced by any custom edge. */
  const gcCustomNodes = (edges: GraphEdge[]): void => {
    const used = new Set<string>();
    for (const e of edges) { used.add(e.from); used.add(e.to); }
    const kept = customNodes.filter((n) => used.has(n.id));
    if (kept.length !== customNodes.length) {
      setCustomNodes(kept);
      saveCustomNodes(resortId, kept);
    }
  };

  const clearCustomLinks = () => {
    setCustomEdges([]);
    saveCustomEdges(resortId, []);
    setCustomNodes([]);
    saveCustomNodes(resortId, []);
  };

  const deleteCustomLinks = (ids: string[]) => {
    const dead = new Set(ids);
    const next = customEdges.filter((e) => !dead.has(e.id));
    setCustomEdges(next);
    saveCustomEdges(resortId, next);
    gcCustomNodes(next);
  };

  const nodeLabelFor = (nodeId: string): string => {
    const p = graph?.points.find((x) => x.nodeId === nodeId);
    if (p) return p.name;
    if (nodeId.startsWith('cn-')) {
      const cn = customNodes.find((n) => n.id === nodeId);
      return cn?.point.ele != null ? `📍 map point · ${Math.round(cn.point.ele)} m` : '📍 map point';
    }
    const n = nodeMap.get(nodeId);
    if (n?.name) return n.name;
    // Fall back to the nearest named point ("near X") so unnamed graph nodes read meaningfully.
    if (n && graph) {
      let best: (typeof graph.points)[number] | undefined;
      let bestD = Infinity;
      for (const q of graph.points) {
        const d = haversineM(n.point, q.point);
        if (d < bestD) {
          bestD = d;
          best = q;
        }
      }
      if (best && bestD <= 250) {
        const ele = n.point.ele != null ? ` · ${Math.round(n.point.ele)} m` : '';
        // Same spot (different node id) reads better without the "near" qualifier.
        return bestD <= 20 ? `${best.name}${ele}` : `near ${best.name}${ele}`;
      }
    }
    if (n?.point.ele != null) return `Point at ${Math.round(n.point.ele)} m`;
    return nodeId;
  };

  const computeLongestRun = () => {
    if (!effectiveGraph) return;
    const res = findLongestRuns(effectiveGraph, prefs, 3);
    if (!res.length) {
      setLongestRuns(null);
      setPopup('No lift-free run found for your level. Try raising your max difficulty.');
      return;
    }
    const named = res.map((r) => ({
      ...r,
      startName: nodeLabelFor(r.startNodeId),
      endName: nodeLabelFor(r.endNodeId),
    }));
    setLongestRuns(named);
    setLongestIdx(0);
    // Showing the longest run is a highlight, not a route — clear any route options so only
    // one thing glows on the map at a time.
    setPlan(null);
    setSelectedRange(null);
    setFocusGeometry(named[0].coords);
    setPanelOpen(false);
    setOpenSection('longest');
  };

  const stepLongest = (delta: number) => {
    if (!longestRuns || longestRuns.length === 0) return;
    const next = (longestIdx + delta + longestRuns.length) % longestRuns.length;
    setLongestIdx(next);
    setPlan(null);
    setSelectedRange(null);
    setFocusGeometry(longestRuns[next].coords);
  };

  const currentLongest = longestRuns && longestRuns.length ? longestRuns[longestIdx] : null;

  const navigateToLongestStart = () => {
    if (!currentLongest) return;
    setToNodeId(currentLongest.startNodeId);
    setToCustom(currentLongest.startName);
    setFocusGeometry(null);
    setPopup(
      `Destination set to the start of the longest run (${currentLongest.startName}). Pick your start point A (or tap "My location"), then press Find routes.`,
    );
  };

  const navigateToLongestEnd = () => {
    if (!currentLongest || !effectiveGraph) return;
    // You're at the top and want to ski THIS run — show the exact longest run as the route
    // (not a fresh A→B search that would find different options).
    setFromNodeId(currentLongest.startNodeId);
    setFromCustom(currentLongest.startName);
    setToNodeId(currentLongest.endNodeId);
    setToCustom(currentLongest.endName);
    setFocusGeometry(null);
    const route = routeForEdges(effectiveGraph, prefs, currentLongest.edges, 'longest-run');
    setPlan({ routes: [route] });
    setSelectedRoute(0);
    setSelectedRange(null);
    setPanelOpen(false);
    setOpenSection('routes');
  };

  const handleStepClick = (routeIndex: number, fromLeg: number, toLeg: number) => {
    if (routeIndex !== selectedRoute) {
      setSelectedRoute(routeIndex);
      setSelectedRange([fromLeg, toLeg]);
    } else {
      setSelectedRange((cur) => (cur && cur[0] === fromLeg && cur[1] === toLeg ? null : [fromLeg, toLeg]));
    }
  };

  // --- Closures (assumed-open reality: user marks lifts/runs closed) ---
  const applyClosures = (next: string[]) => {
    closedRef.current = next;
    setClosedKeys(next);
    saveClosures(resortId, next);
    // Re-plan so routes immediately avoid (or re-include) the closure.
    if (fromNodeId && toNodeId) doPlan();
  };

  const markClosed = (key: string, label: string) => {
    if (closedRef.current.includes(key)) return;
    applyClosures([...closedRef.current, key]);
    setPopup(`Marked "${label}" closed — routes will avoid it. Reopen it in the "Closed today" panel.`);
  };

  const reopenClosure = (key: string) => applyClosures(closedRef.current.filter((k) => k !== key));
  const reopenAllClosures = () => applyClosures([]);

  const locateClosure = (key: string) => {
    if (!effectiveGraph) return;
    const coords = geometryForClosure(effectiveGraph, key);
    if (coords.length >= 2) setFocusGeometry(coords);
    else setPopup('Could not locate this closure on the map.');
  };

  const points = graph?.points ?? [];

  const fromLabel = fromCustom ?? (fromNodeId ? nodeLabelFor(fromNodeId) : null);
  const toLabel = toCustom ?? (toNodeId ? nodeLabelFor(toNodeId) : null);
  const planSummary = fromLabel || toLabel ? `${fromLabel ?? 'A'} → ${toLabel ?? 'B'}` : 'Pick A and B';
  const longestSummary = currentLongest
    ? `${currentLongest.startName} → ${currentLongest.endName}`
    : 'Find longest descents';
  const linksSummary = customEdges.length ? `${customEdges.length} link${customEdges.length === 1 ? '' : 's'}` : 'None yet';
  const closedSummary = closedKeys.length ? `${closedKeys.length} closed` : 'All open';

  return (
    <div className="app">
      <header className="topbar">
        <button
          type="button"
          className="panel-toggle"
          onClick={() => setPanelOpen((o) => !o)}
          aria-label={panelOpen ? 'Hide controls' : 'Show controls'}
        >
          ☰
        </button>
        <h1 className="logo">
          <Logo className="logo-mark" />
        </h1>
        <select
          value={resortId}
          onChange={(e) => {
            setResortId(e.target.value);
            setDeepLinkActive(false);
            setPopup(
              'Lift & slope statuses are assumed OPEN. In early/late season many may be closed — check the resort, and mark any closed run/lift (⊘ on a route step) so routes avoid it.',
            );
          }}
          className="resort-select"
        >
          {(index ?? []).map((r) => (
            <option key={r.id} value={r.id}>{r.name} ({r.country})</option>
          ))}
        </select>
        {status && <span className="status">{status}</span>}
      </header>

      <div className="body">
        {panelOpen && <div className="backdrop" onClick={() => setPanelOpen(false)} />}
        <aside className={panelOpen ? 'sidebar open' : 'sidebar'}>
          <AccordionSection
            title="Plan a route"
            summary={planSummary}
            open={openSection === 'plan'}
            onToggle={() => toggleSection('plan')}
          >
          <div className="panel">
            <h3>Plan a route</h3>
            <PointPicker
              label="From (A)"
              accent="#2e7d32"
              points={points}
              valueNodeId={fromNodeId}
              customLabel={fromCustom}
              onPick={(id) => { setFromNodeId(id); setFromCustom(null); }}
              onUseLocation={() => pickLocationFor('from')}
              onPinMode={() => setPinMode(pinMode === 'from' ? null : 'from')}
              pinActive={pinMode === 'from'}
            />
            <PointPicker
              label="To (B)"
              accent="#c62828"
              points={points}
              valueNodeId={toNodeId}
              customLabel={toCustom}
              onPick={(id) => { setToNodeId(id); setToCustom(null); }}
              onUseLocation={() => pickLocationFor('to')}
              onPinMode={() => setPinMode(pinMode === 'to' ? null : 'to')}
              pinActive={pinMode === 'to'}
            />

            <label className="field">
              <span>Objective</span>
              <select value={objective} onChange={(e) => setObjective(e.target.value as RouteObjective)}>
                <option value="fastest">Fastest route</option>
                <option value="longest_streak">Longest skiable streak</option>
              </select>
            </label>

            <div className="field">
              <span>When</span>
              <div className="timing">
                <label><input type="radio" checked={timingMode === 'now'} onChange={() => setTimingMode('now')} /> Now</label>
                <label><input type="radio" checked={timingMode === 'arrive_by'} onChange={() => setTimingMode('arrive_by')} /> Arrive by</label>
              </div>
              {timingMode === 'arrive_by' && (
                <input type="datetime-local" value={arriveTime} onChange={(e) => setArriveTime(e.target.value)} />
              )}
            </div>

            <button type="button" className="primary" onClick={() => doPlan()} disabled={!graph}>
              Find routes
            </button>
          </div>
          </AccordionSection>

          {plan && (plan.noLiftFreeRoute || plan.routes.length > 0) && (
            <AccordionSection
              title="Route options"
              summary={plan.routes.length ? `${plan.routes.length} option${plan.routes.length === 1 ? '' : 's'}` : 'No route'}
              open={openSection === 'routes'}
              onToggle={() => toggleSection('routes')}
            >
              {plan.noLiftFreeRoute && (
                <div className="ski-note">
                  <strong>No lift-free route to this point at your level.</strong>
                  {plan.nearestSkiDestination ? (
                    <>
                      {' '}Nearest ski-down destination:{' '}
                      <button
                        type="button"
                        className="link-btn inline"
                        onClick={() => {
                          setToNodeId(plan.nearestSkiDestination!.nodeId);
                          setToCustom(null);
                        }}
                      >
                        {plan.nearestSkiDestination.name}
                      </button>{' '}
                      (tap to set as destination, then Find routes).
                    </>
                  ) : (
                    ' Try a lower difficulty or a different destination.'
                  )}
                </div>
              )}

              {plan.routes.length > 0 && (
                <RouteOptions
                  routes={plan.routes}
                  selectedIndex={selectedRoute}
                  onSelect={(i) => { setSelectedRoute(i); setSelectedRange(null); }}
                  selectedRange={selectedRange}
                  onStepClick={handleStepClick}
                  onMarkClosed={markClosed}
                />
              )}
              {plan.routes.length > 0 && !navRoute && (
                <button type="button" className="primary nav-start" onClick={startNav}>
                  ▶ Start navigation
                </button>
              )}
            </AccordionSection>
          )}

          <AccordionSection
            title="🏆 Longest runs"
            summary={longestSummary}
            open={openSection === 'longest'}
            onToggle={() => toggleSection('longest')}
          >
          <LongestRunPanel
            runs={longestRuns}
            index={longestIdx}
            onFind={computeLongestRun}
            onPrev={() => stepLongest(-1)}
            onNext={() => stepLongest(1)}
            onShowOnMap={() => {
              if (!currentLongest) return;
              setPlan(null);
              setSelectedRange(null);
              setFocusGeometry(currentLongest.coords);
            }}
            onNavigateStart={navigateToLongestStart}
            onNavigateEnd={navigateToLongestEnd}
          />
          </AccordionSection>

          <AccordionSection
            title="🔗 Custom links"
            summary={linksSummary}
            open={openSection === 'links'}
            onToggle={() => toggleSection('links')}
          >
          <CustomLinkPanel
            points={points}
            fromLabel={linkFrom?.label ?? null}
            toLabel={linkTo?.label ?? null}
            onPickFrom={(nodeId) => setLinkFrom({ kind: 'node', nodeId, label: nodeLabelFor(nodeId) })}
            onPickTo={(nodeId) => setLinkTo({ kind: 'node', nodeId, label: nodeLabelFor(nodeId) })}
            onPinFrom={() => setLinkPinMode(linkPinMode === 'from' ? null : 'from')}
            onPinTo={() => setLinkPinMode(linkPinMode === 'to' ? null : 'to')}
            pinFromActive={linkPinMode === 'from'}
            pinToActive={linkPinMode === 'to'}
            onClearFrom={() => setLinkFrom(null)}
            onClearTo={() => setLinkTo(null)}
            links={customEdges}
            nodeLabel={nodeLabelFor}
            onAdd={addCustomLink}
            onDelete={deleteCustomLinks}
            onLocate={setFocusGeometry}
            onClear={clearCustomLinks}
          />
          </AccordionSection>

          <AccordionSection
            title="⛔ Closed today"
            summary={closedSummary}
            open={openSection === 'closed'}
            onToggle={() => toggleSection('closed')}
          >
          <ClosedPanel
            closedKeys={closedKeys}
            onReopen={reopenClosure}
            onReopenAll={reopenAllClosures}
            onLocate={locateClosure}
          />
          </AccordionSection>

          <AccordionSection
            title="Skiing preferences"
            summary="Level & lift filters"
            open={openSection === 'prefs'}
            onToggle={() => toggleSection('prefs')}
          >
          <PreferencesPanel prefs={prefs} onChange={setPrefs} />
          <MeasuredSpeedsPanel measured={measured ?? emptyMeasured()} estimatedByColor={estimatedByColor} minSamples={MIN_SAMPLES} onApply={applyMeasured} onReset={resetMeasured} />
          </AccordionSection>

          {graph && (
            <p className="datanote">
              {effectiveGraph?.nodes.length} nodes · {effectiveGraph?.edges.length} edges · {points.length} named points
            </p>
          )}
        </aside>

        <main className="map-wrap">
          <MapView
            center={center}
            zoom={deepLinkActive && deepLink.zoom != null ? deepLink.zoom : 12}
            geo={effectiveGeo}
            routeFC={routeFC}
            selectedRange={selectedRange}
            from={focusGeometry ? null : pointFor(fromNodeId)}
            to={focusGeometry ? null : pointFor(toNodeId)}
            linkFrom={linkEndPos(linkFrom)}
            linkTo={linkEndPos(linkTo)}
            focusGeometry={focusGeometry}
            onMapClick={handleMapClick}
            userPosition={userPos}
            following={following}
            locateActive={live.tracking || !!simPos}
            onLocateToggle={onLocateToggle}
            onFollowChange={setFollowing}
            nav={navData?.render ?? null}
            navHeadingUp
          />
          {pinMode && <div className="pin-hint">Click the map to set point {pinMode === 'from' ? 'A' : 'B'}</div>}
          {linkPinMode && <div className="pin-hint">Click the map to place the link's {linkPinMode === 'from' ? '"from"' : '"to"'} point (anywhere)</div>}
          <Legend />
          {navRoute && (
            <NavOverlay
              step={navData?.step}
              remaining={navData?.rem}
              speedMps={userPos?.speed ?? null}
              offRoute={navData?.offRoute ?? false}
              waiting={!userPos}
              onExit={exitNav}
              onReroute={rerouteFromHere}
              sim={import.meta.env.DEV ? { path: navPath, onSim: setSimPos } : undefined}
            />
          )}
        </main>
      </div>

      {popup && (
        <div className="popup-overlay" onClick={() => setPopup(null)}>
          <div className="popup" onClick={(e) => e.stopPropagation()}>
            <h4>Heads up</h4>
            {popup.split('\n').map((line, i) => <p key={i}>{line}</p>)}
            <button type="button" className="primary" onClick={() => setPopup(null)}>Got it</button>
          </div>
        </div>
      )}
    </div>
  );
}

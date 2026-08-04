import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import Button from '@mui/material/Button';
import TextField from '@mui/material/TextField';
import MenuItem from '@mui/material/MenuItem';
import ToggleButton from '@mui/material/ToggleButton';
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup';
import PlayArrowIcon from '@mui/icons-material/PlayArrow';
import AltRouteIcon from '@mui/icons-material/AltRoute';
import SearchIcon from '@mui/icons-material/Search';
import EmojiEventsIcon from '@mui/icons-material/EmojiEvents';
import LinkIcon from '@mui/icons-material/Link';
import DoNotDisturbOnIcon from '@mui/icons-material/DoNotDisturbOn';
import TuneIcon from '@mui/icons-material/Tune';
import AppBar from '@mui/material/AppBar';
import Toolbar from '@mui/material/Toolbar';
import IconButton from '@mui/material/IconButton';
import Select from '@mui/material/Select';
import Menu from '@mui/material/Menu';
import FormControl from '@mui/material/FormControl';
import IosShareIcon from '@mui/icons-material/IosShare';
import Tooltip from '@mui/material/Tooltip';
import Alert from '@mui/material/Alert';
import Snackbar from '@mui/material/Snackbar';
import MenuIcon from '@mui/icons-material/Menu';
import CloseIcon from '@mui/icons-material/Close';
import LightModeIcon from '@mui/icons-material/LightMode';
import DarkModeIcon from '@mui/icons-material/DarkMode';
import Box from '@mui/material/Box';
import Fab from '@mui/material/Fab';
import MyLocationIcon from '@mui/icons-material/MyLocation';
import LocationSearchingIcon from '@mui/icons-material/LocationSearching';
import { useThemeMode } from './theme-context';
import Typography from '@mui/material/Typography';
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
 *
 * A shared-location link additionally carries `to=lat,lon` (a destination to navigate to) and an
 * optional `name` label, e.g. `?resort=cervinia-zermatt&to=45.897,7.658&name=Meet%20here`.
 */
function parseDeepLink(): {
  resortId?: string;
  lon?: number;
  lat?: number;
  zoom?: number;
  toLat?: number;
  toLon?: number;
  toName?: string;
} {
  const parseLatLon = (v: string | null): [number, number] | undefined => {
    if (!v) return undefined;
    const [a, b] = v.split(',').map((s) => parseFloat(s.trim()));
    return Number.isFinite(a) && Number.isFinite(b) ? [a, b] : undefined;
  };
  try {
    const q = new URLSearchParams(window.location.search);
    const resortId = q.get('resort') ?? undefined;
    let lon: number | undefined;
    let lat: number | undefined;
    const at = parseLatLon(q.get('at'));
    if (at) [lat, lon] = at;
    let toLat: number | undefined;
    let toLon: number | undefined;
    const to = parseLatLon(q.get('to'));
    if (to) {
      [toLat, toLon] = to;
      // A shared destination also centres the map there when no explicit `at` was given.
      if (lat == null) [lat, lon] = to;
    }
    const toName = q.get('name') ?? undefined;
    const z = q.get('z');
    const zoom = z != null && Number.isFinite(parseFloat(z)) ? parseFloat(z) : undefined;
    return { resortId, lon, lat, zoom, toLat, toLon, toName };
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
  const [shareAnchor, setShareAnchor] = useState<null | HTMLElement>(null);
  const [sharePrompt, setSharePrompt] = useState(false);
  const sharedApplied = useRef(false);

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
      setPopup('Showing your location — following you. Tap the button again to stop.');
    } else if (!following) {
      setFollowing(true);
      setPopup('Recentered — following you again. Tap the button again to stop.');
    } else {
      live.stop();
      setSimPos(null);
      setFollowing(false);
      setPopup('Stopped following your location.');
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

  // ---- Share a location ------------------------------------------------------------------
  // Build a deep-link that opens SkiWaze at this resort with `coord` as the destination.
  const buildShareUrl = (coord: LonLat, name?: string): string => {
    const url = new URL(window.location.origin + window.location.pathname);
    url.searchParams.set('resort', resortId);
    url.searchParams.set('to', `${coord.lat.toFixed(5)},${coord.lon.toFixed(5)}`);
    if (name) url.searchParams.set('name', name);
    return url.toString();
  };

  const shareCoord = async (coord: LonLat, name: string | undefined, message: string) => {
    const url = buildShareUrl(coord, name);
    if (navigator.share) {
      try { await navigator.share({ title: 'SkiWaze', text: message, url }); }
      catch { /* user cancelled the share sheet */ }
    } else if (navigator.clipboard?.writeText) {
      try { await navigator.clipboard.writeText(`${message}\n${url}`); setPopup('Message + link copied to clipboard — paste it to a friend.'); }
      catch { setPopup(`${message}\n${url}`); }
    } else {
      setPopup(`${message}\n${url}`);
    }
  };

  const shareMyLocation = () => {
    setShareAnchor(null);
    const msg = "📍 Come meet me on the slopes! Open this SkiWaze link and it'll route you to my location:";
    if (userPos) { void shareCoord({ lon: userPos.lon, lat: userPos.lat }, 'My location', msg); return; }
    if (!('geolocation' in navigator)) { setPopup('Geolocation is not available in this browser.'); return; }
    navigator.geolocation.getCurrentPosition(
      (p) => void shareCoord({ lon: p.coords.longitude, lat: p.coords.latitude }, 'My location', msg),
      () => setPopup('Could not get your location to share.'),
      { timeout: 5000 },
    );
  };

  // Recipient side: once the graph for the shared resort is ready, snap the shared point to the
  // nearest routable node and prefill it as the destination, then prompt the recipient. Getting
  // their current location + running the route happens when they tap "Navigate" (a user gesture),
  // handled by navigateToShared().
  useEffect(() => {
    if (sharedApplied.current) return;
    if (deepLink.toLat == null || deepLink.toLon == null || !effectiveGraph) return;
    if (deepLink.resortId && resortId !== deepLink.resortId) return;
    sharedApplied.current = true;
    const dest = nearestNode(effectiveGraph, deepLink.toLon, deepLink.toLat);
    if (!dest) { setPopup('Could not place the shared location on this resort.'); return; }
    setToNodeId(dest.id);
    setToCustom(deepLink.toName ? `📍 ${deepLink.toName}` : '📍 Shared location');
    setOpenSection('plan');
    setSharePrompt(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [effectiveGraph, resortId]);

  // "Navigate" on the shared-location prompt: fetch the recipient's current location, set it as
  // the start, and run the route straight away (passing ids explicitly to avoid a stale-state race).
  const navigateToShared = (toId: string | null) => {
    setSharePrompt(false);
    if (!toId) return;
    if (!('geolocation' in navigator)) {
      setPopup('Geolocation is not available — pick a start point (From), then Find routes.');
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const n = effectiveGraph ? nearestNode(effectiveGraph, pos.coords.longitude, pos.coords.latitude) : null;
        if (!n) { setPopup('Could not place your location on this resort — pick a start point (From).'); return; }
        setFromNodeId(n.id);
        setFromCustom('My location');
        doPlan(n.id, toId);
      },
      () => setPopup('Could not get your location — pick a start point (From), then Find routes.'),
      { timeout: 5000 },
    );
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
  const planSummary = fromLabel || toLabel ? `${fromLabel ?? 'From'} → ${toLabel ?? 'To'}` : 'Pick start & end';
  const longestSummary = currentLongest
    ? `${currentLongest.startName} → ${currentLongest.endName}`
    : 'Find longest descents';
  const linkGroupCount = useMemo(
    () => new Set(customEdges.map((e) => e.id.split('-').slice(0, 2).join('-'))).size,
    [customEdges],
  );
  const linksSummary = linkGroupCount ? `${linkGroupCount} link${linkGroupCount === 1 ? '' : 's'}` : 'None yet';
  const closedSummary = closedKeys.length ? `${closedKeys.length} closed` : 'All open';
  const { mode, toggle: toggleTheme } = useThemeMode();
  const locateActive = live.tracking || !!simPos;
  const locateTip = !locateActive ? 'Show my location' : following ? 'Following you — tap to stop' : 'Recenter on me';

  // Mobile bottom sheet: drag the handle downwards to dismiss.
  const sheetRef = useRef<HTMLElement | null>(null);
  const sheetDrag = useRef<{ y: number; dy: number } | null>(null);
  const onSheetDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    sheetDrag.current = { y: e.clientY, dy: 0 };
    if (sheetRef.current) sheetRef.current.style.transition = 'none';
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onSheetMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!sheetDrag.current) return;
    const dy = Math.max(0, e.clientY - sheetDrag.current.y);
    sheetDrag.current.dy = dy;
    if (sheetRef.current) sheetRef.current.style.transform = `translateY(${dy}px)`;
  };
  const onSheetUp = () => {
    const d = sheetDrag.current;
    sheetDrag.current = null;
    if (sheetRef.current) {
      sheetRef.current.style.transition = '';
      sheetRef.current.style.transform = '';
    }
    if (d && d.dy > 80) setPanelOpen(false);
  };

  // Peek pull-tab (closed state): tap or drag up to open the sheet.
  const peekDrag = useRef<{ y: number; dy: number } | null>(null);
  const onPeekDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    peekDrag.current = { y: e.clientY, dy: 0 };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onPeekMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (peekDrag.current) peekDrag.current.dy = e.clientY - peekDrag.current.y;
  };
  const onPeekUp = () => {
    const d = peekDrag.current;
    peekDrag.current = null;
    if (!d) return;
    if (Math.abs(d.dy) < 8 || d.dy < -30) setPanelOpen(true);
  };

  return (
    <div className="app">
      <AppBar position="static" color="default" elevation={0} sx={{ borderBottom: 1, borderColor: 'divider', bgcolor: 'background.paper' }}>
        <Toolbar sx={{ gap: 1, minHeight: 60, px: { xs: 1, sm: 2 } }}>
          <IconButton
            edge="start"
            onClick={() => setPanelOpen((o) => !o)}
            aria-label={panelOpen ? 'Hide controls' : 'Show controls'}
            sx={{ display: 'inline-flex', '@media (min-width:821px)': { display: 'none' } }}
          >
            <MenuIcon />
          </IconButton>
          <Box sx={{ display: 'flex', alignItems: 'center' }}>
            <Logo className="logo-mark" />
          </Box>
          {status && (
            <Typography variant="body2" color="text.secondary" noWrap sx={{ display: { xs: 'none', sm: 'block' }, ml: 1 }}>
              {status}
            </Typography>
          )}
          <Box sx={{ flex: 1 }} />
          <FormControl size="small" sx={{ minWidth: 150, maxWidth: 260 }}>
            <Select
              value={resortId}
              onChange={(e) => {
                setResortId(e.target.value);
                setDeepLinkActive(false);
                setPopup(
                  'Lift & slope statuses are assumed OPEN. In early/late season many may be closed — check the resort, and mark any closed run/lift (⊘ on a route step) so routes avoid it.',
                );
              }}
            >
              {(index ?? []).map((r) => (
                <MenuItem key={r.id} value={r.id}>{r.name} ({r.country})</MenuItem>
              ))}
            </Select>
          </FormControl>
          <Tooltip title={mode === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}>
            <IconButton onClick={toggleTheme} aria-label="Toggle light/dark theme">
              {mode === 'dark' ? <LightModeIcon /> : <DarkModeIcon />}
            </IconButton>
          </Tooltip>
        </Toolbar>
      </AppBar>

      <div className="body">
        {panelOpen && <div className="backdrop" onClick={() => setPanelOpen(false)} />}
        <aside ref={sheetRef} className={panelOpen ? 'sidebar open' : 'sidebar'}>
          <div
            className="sheet-handle"
            onPointerDown={onSheetDown}
            onPointerMove={onSheetMove}
            onPointerUp={onSheetUp}
            onPointerCancel={onSheetUp}
            aria-label="Drag down to close"
          />
          <AccordionSection
            title="Plan a route"
            icon={<SearchIcon fontSize="small" />}
            summary={planSummary}
            open={openSection === 'plan'}
            onToggle={() => toggleSection('plan')}
          >
          <div className="panel">
            <h3>Plan a route</h3>
            <PointPicker
              label="From"
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
              label="To"
              accent="#c62828"
              points={points}
              valueNodeId={toNodeId}
              customLabel={toCustom}
              onPick={(id) => { setToNodeId(id); setToCustom(null); }}
              onUseLocation={() => pickLocationFor('to')}
              onPinMode={() => setPinMode(pinMode === 'to' ? null : 'to')}
              pinActive={pinMode === 'to'}
            />

            <TextField
              select
              size="small"
              fullWidth
              label="Objective"
              value={objective}
              onChange={(e) => setObjective(e.target.value as RouteObjective)}
              sx={{ mb: 1.5 }}
            >
              <MenuItem value="fastest">Fastest route</MenuItem>
              <MenuItem value="longest_streak">Longest skiable streak</MenuItem>
            </TextField>

            <Box sx={{ mb: 1.5 }}>
              <Typography variant="body2" color="text.secondary" sx={{ mb: 0.5 }}>
                When
              </Typography>
              <ToggleButtonGroup
                exclusive
                size="small"
                value={timingMode}
                onChange={(_, v) => v && setTimingMode(v)}
              >
                <ToggleButton value="now">Now</ToggleButton>
                <ToggleButton value="arrive_by">Arrive by</ToggleButton>
              </ToggleButtonGroup>
              {timingMode === 'arrive_by' && (
                <TextField
                  type="datetime-local"
                  size="small"
                  fullWidth
                  value={arriveTime}
                  onChange={(e) => setArriveTime(e.target.value)}
                  sx={{ mt: 1 }}
                  slotProps={{ inputLabel: { shrink: true } }}
                />
              )}
            </Box>

            <Button
              variant="contained"
              size="large"
              fullWidth
              onClick={() => doPlan()}
              disabled={!graph}
            >
              Find routes
            </Button>

            <Button
              variant="outlined"
              size="large"
              fullWidth
              startIcon={<IosShareIcon />}
              onClick={(e) => setShareAnchor(e.currentTarget)}
              sx={{ mt: 1 }}
            >
              Share a location
            </Button>
            <Menu anchorEl={shareAnchor} open={!!shareAnchor} onClose={() => setShareAnchor(null)}>
              <MenuItem onClick={shareMyLocation}>Share my current location</MenuItem>
              <MenuItem
                disabled={!toNodeId}
                onClick={() => {
                  setShareAnchor(null);
                  const coord = pointFor(toNodeId);
                  if (!coord) { setPopup('Pick a destination (To) first, then share it.'); return; }
                  const place = toLabel ?? 'this spot';
                  void shareCoord(coord, place, `📍 Meet me at ${place} — open this SkiWaze link to navigate there:`);
                }}
              >
                {toLabel ? `Share the “To” destination: ${toLabel}` : 'Share the “To” destination'}
              </MenuItem>
            </Menu>
          </div>
          </AccordionSection>

          {plan && (plan.noLiftFreeRoute || plan.routes.length > 0) && (
            <AccordionSection
              title="Route options"
              icon={<AltRouteIcon fontSize="small" />}
              summary={plan.routes.length ? `${plan.routes.length} option${plan.routes.length === 1 ? '' : 's'}` : 'No route'}
              open={openSection === 'routes'}
              onToggle={() => toggleSection('routes')}
            >
              {plan.noLiftFreeRoute && (
                <Alert severity="warning" sx={{ mb: 1 }}>
                  <strong>No lift-free route to this point at your level.</strong>
                  {plan.nearestSkiDestination ? (
                    <>
                      {' '}Nearest ski-down destination:{' '}
                      <Box
                        component="button"
                        type="button"
                        onClick={() => {
                          setToNodeId(plan.nearestSkiDestination!.nodeId);
                          setToCustom(null);
                        }}
                        sx={{ background: 'none', border: 0, p: 0, color: 'primary.main', cursor: 'pointer', font: 'inherit', textDecoration: 'underline' }}
                      >
                        {plan.nearestSkiDestination.name}
                      </Box>{' '}
                      (tap to set as destination, then Find routes).
                    </>
                  ) : (
                    ' Try a lower difficulty or a different destination.'
                  )}
                </Alert>
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
                <Button variant="contained" color="success" fullWidth startIcon={<PlayArrowIcon />} onClick={startNav} sx={{ mt: 1 }}>
                  Start navigation
                </Button>
              )}
            </AccordionSection>
          )}

          <AccordionSection
            title="Longest runs"
            icon={<EmojiEventsIcon fontSize="small" />}
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
            title="Custom links"
            icon={<LinkIcon fontSize="small" />}
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
            title="Closed today"
            icon={<DoNotDisturbOnIcon fontSize="small" />}
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
            icon={<TuneIcon fontSize="small" />}
            summary="Level & lift filters"
            open={openSection === 'prefs'}
            onToggle={() => toggleSection('prefs')}
          >
          <PreferencesPanel prefs={prefs} onChange={setPrefs} />
          <MeasuredSpeedsPanel measured={measured ?? emptyMeasured()} estimatedByColor={estimatedByColor} minSamples={MIN_SAMPLES} onApply={applyMeasured} onReset={resetMeasured} />
          </AccordionSection>

          {graph && (
            <Typography variant="caption" color="text.secondary" sx={{ display: 'block', textAlign: 'center', py: 1 }}>
              {effectiveGraph?.nodes.length} nodes · {effectiveGraph?.edges.length} edges · {points.length} named points
            </Typography>
          )}
        </aside>

        {!panelOpen && (
          <div
            className="sheet-peek"
            onPointerDown={onPeekDown}
            onPointerMove={onPeekMove}
            onPointerUp={onPeekUp}
            onPointerCancel={onPeekUp}
            role="button"
            aria-label="Open controls"
          >
            <span className="grip" />
            Controls
          </div>
        )}

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
            nav={navData?.render ?? null}
            navHeadingUp
          />
          {pinMode && <div className="pin-hint">Click the map to set the {pinMode === 'from' ? 'From' : 'To'} point</div>}
          {linkPinMode && <div className="pin-hint">Click the map to place the link's {linkPinMode === 'from' ? '"from"' : '"to"'} point (anywhere)</div>}
          <Box sx={{ position: 'absolute', top: 12, right: 12, zIndex: 5, display: 'flex', flexDirection: 'column', gap: 1 }}>
            <Tooltip title={locateTip} placement="left">
              <Fab
                size="small"
                color={locateActive && following ? 'primary' : 'default'}
                onClick={onLocateToggle}
                aria-label={locateTip}
                sx={locateActive && following ? undefined : { bgcolor: 'background.paper', color: 'text.primary' }}
              >
                {locateActive && !following ? <LocationSearchingIcon /> : <MyLocationIcon />}
              </Fab>
            </Tooltip>
            <Tooltip title="Plan a route" placement="left">
              <Fab
                size="small"
                aria-label="Plan a route"
                onClick={() => { setOpenSection('plan'); setPanelOpen(true); }}
                sx={{ bgcolor: 'background.paper', color: 'text.primary' }}
              >
                <SearchIcon />
              </Fab>
            </Tooltip>
            {plan && plan.routes.length > 0 && (
              <Tooltip title="Route options" placement="left">
                <Fab
                  size="small"
                  aria-label="Route options"
                  onClick={() => { setOpenSection('routes'); setPanelOpen(true); }}
                  sx={{ bgcolor: 'background.paper', color: 'text.primary' }}
                >
                  <AltRouteIcon />
                </Fab>
              </Tooltip>
            )}
          </Box>
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
        <Snackbar
          open={!!popup}
          autoHideDuration={7000}
          onClose={(_, reason) => { if (reason !== 'clickaway') setPopup(null); }}
          anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
        >
          <Alert
            onClose={() => setPopup(null)}
            severity={
              /could not|couldn't|no route|not available|no lift-free|not enough|pick both|pick two|pick a|first\b/i.test(popup)
                ? 'warning'
                : /applied|added|marked|✓/i.test(popup)
                  ? 'success'
                  : 'info'
            }
            variant="filled"
            sx={{ whiteSpace: 'pre-line', maxWidth: 'min(480px, calc(100vw - 24px))', boxShadow: 6 }}
          >
            {popup}
          </Alert>
        </Snackbar>
      )}

      {sharePrompt && (
        <Snackbar
          open={sharePrompt}
          anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
          sx={{ mb: { xs: 9, sm: 2 } }}
        >
          <Alert
            severity="info"
            variant="filled"
            onClose={() => setSharePrompt(false)}
            action={
              <>
                <Button color="inherit" size="small" onClick={() => navigateToShared(toNodeId)}>
                  Navigate
                </Button>
                <IconButton size="small" color="inherit" aria-label="Dismiss" onClick={() => setSharePrompt(false)}>
                  <CloseIcon fontSize="small" />
                </IconButton>
              </>
            }
            sx={{ boxShadow: 6, maxWidth: 'min(480px, calc(100vw - 24px))' }}
          >
            A location was shared with you — set as your destination. Navigate there?
          </Alert>
        </Snackbar>
      )}
    </div>
  );
}

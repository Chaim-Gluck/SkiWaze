import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useLanguage } from './i18n/language-context';
import { tr } from './utils/text';
import { bidiName } from './utils/format';
import Button from '@mui/material/Button';
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
import InputLabel from '@mui/material/InputLabel';
import ListSubheader from '@mui/material/ListSubheader';
import FormControl from '@mui/material/FormControl';
import Menu from '@mui/material/Menu';
import IosShareIcon from '@mui/icons-material/IosShare';
import Tooltip from '@mui/material/Tooltip';
import Alert from '@mui/material/Alert';
import Snackbar from '@mui/material/Snackbar';
import Link from '@mui/material/Link';
import AlertTitle from '@mui/material/AlertTitle';
import InfoOutlinedIcon from '@mui/icons-material/InfoOutlined';
import LightbulbOutlinedIcon from '@mui/icons-material/LightbulbOutlined';
import BottomNavigation from '@mui/material/BottomNavigation';
import BottomNavigationAction from '@mui/material/BottomNavigationAction';
import Badge from '@mui/material/Badge';
import useMediaQuery from '@mui/material/useMediaQuery';
import MenuIcon from '@mui/icons-material/Menu';
import CloseIcon from '@mui/icons-material/Close';
import { PanelShell } from './components/PanelShell';
import LightModeIcon from '@mui/icons-material/LightMode';
import DarkModeIcon from '@mui/icons-material/DarkMode';
import Box from '@mui/material/Box';
import Paper from '@mui/material/Paper';
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
} from './types/domain';
import type { GeoFeatureCollection, ResortIndexEntry } from './data/resortData';
import { loadResortGeo, loadResortGraph, loadResortIndex } from './data/resortData';
import { getResort } from './config/resorts';
import { countryCode, flagDataUrl } from './utils/flags';
import { loadPreferences, savePreferences } from './state/preferences';
import { shouldShowStatusNotice } from './state/statusNotice';
import { loadCustomEdges, saveCustomEdges } from './state/customEdges';
import { loadCustomNodes, saveCustomNodes, type CustomNode } from './state/customNodes';
import { buildEffectiveGraph } from './routing/customGraph';
import { loadClosures, saveClosures } from './state/closures';
import { closedGeometries, geometryForClosure } from './routing/closures';
import { nearestNode, nearestResort } from './utils/nearest';
import { PreviewPrompt, type PreviewReason } from './components/PreviewPrompt';
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
import { progressSpeedMps, measuredTrueToProgressMps, SNAKE_FACTOR } from './config/speedModel';
import { MapView, type LonLat, type RouteFeatureCollection } from './components/MapView';
import { PointPicker } from './components/PointPicker';
import { ArriveTimePicker } from './components/ArriveTimePicker';
import { AccordionSection } from './components/AccordionSection';
import { PreferencesPanel } from './components/PreferencesPanel';
import { RouteOptions } from './components/RouteOptions';
import { CustomLinkPanel, type LinkColor, type LinkDirection } from './components/CustomLinkPanel';
import { ClosedPanel } from './components/ClosedPanel';
import { LongestRunPanel } from './components/LongestRunPanel';
import { RoutePreview } from './components/RoutePreview';
import { LongestPreview } from './components/LongestPreview';
import { Logo } from './components/Logo';
import { LanguagePicker } from './components/LanguagePicker';
import { AppBarOverflow } from './components/AppBarOverflow';
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

/** One selectable picker row: a resort under a single country (multi-country resorts yield one per country). */
interface ResortOption {
  id: string;
  name: string;
  country: string;
}

/**
 * A transient bottom notice: primary text, optional title, a trailing link, and a tip line.
 * `severity` is carried explicitly — it used to be sniffed by regex-matching English words in
 * `text`, which silently degrades to "info" the moment the copy is translated.
 */
interface PopupNotice {
  text: string;
  severity?: 'warning' | 'success' | 'info';
  title?: string;
  href?: string;
  hrefLabel?: string;
  tip?: string;
}

/** Loading/error banner state. See the `status` state for why this isn't a plain string. */
type StatusState =
  | null
  | { kind: 'loadingResorts' | 'loadingResort' }
  | { kind: 'errorResorts' | 'errorResort'; detail: string };

export default function App() {
  const { t } = useTranslation();
  // The map shell is pinned LTR (see the <main> comment), so prose drawn over it has to be handed
  // the document direction back explicitly.
  const { rtl } = useLanguage();
  const dir = rtl ? 'rtl' : 'ltr';
  const [deepLink] = useState(parseDeepLink);
  const [index, setIndex] = useState<ResortIndexEntry[] | null>(null);
  const [resortId, setResortId] = useState<string>(deepLink.resortId ?? DEFAULT_RESORT_ID);
  const [deepLinkActive, setDeepLinkActive] = useState(deepLink.lat != null && deepLink.lon != null);
  /** Map is showing the whole-of-Europe flags view; only picking a resort leaves it. */
  const [globalView, setGlobalView] = useState(false);
  /** Bumped on every resort selection so the map re-frames even when the id is unchanged. */
  const [resortFrameSeq, setResortFrameSeq] = useState(0);
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
  const [previewDismissed, setPreviewDismissed] = useState(false);
  const [longestDismissed, setLongestDismissed] = useState(false);
  const isMobile = useMediaQuery('(max-width:820px)');
  // Narrower than the tablet breakpoint: this is the width at which the AppBar itself runs out of
  // room, which is a different question from whether the controls become a bottom sheet.
  // 480px is where the measured content (brand 213 + picker 96 + two 40px buttons + 48 of padding
  // and gaps = 445) stops fitting, so below it language and theme collapse into one menu.
  const isNarrow = useMediaQuery('(max-width:479px)');

  const [timingMode, setTimingMode] = useState<'now' | 'arrive_by'>('now');
  const [arriveTime, setArriveTime] = useState<string>(() => nowLocalDatetime());

  const [plan, setPlan] = useState<PlanResult | null>(null);
  const [selectedRoute, setSelectedRoute] = useState(0);
  const [selectedRange, setSelectedRange] = useState<[number, number] | null>(null);
  const [popup, setPopup] = useState<string | PopupNotice | null>(null);
  /** Show a transient notice. Severity is passed explicitly so it survives translation. */
  const notify = useCallback(
    (text: string, severity: 'warning' | 'success' | 'info' = 'info') => setPopup({ text, severity }),
    [],
  );
  /**
   * Held as a key + optional detail rather than a finished sentence, so a language switch
   * re-renders it in the new language instead of freezing whatever was current when it was set.
   */
  const [status, setStatus] = useState<StatusState>({ kind: 'loadingResorts' });
  const [focusGeometry, setFocusGeometry] = useState<[number, number][] | null>(null);
  const [fitRequest, setFitRequest] = useState<{ coords: [number, number][]; seq: number } | null>(null);
  const fitSeq = useRef(0);
  const [longestRuns, setLongestRuns] = useState<(LongestRun & { startName: string; endName: string })[] | null>(null);
  const [longestIdx, setLongestIdx] = useState(0);
  const [panelOpen, setPanelOpen] = useState(false);
  const [openSection, setOpenSection] = useState<string>('plan');

  // Live location + turn-by-turn navigation (Phase 1 + 2).
  const live = useLiveLocation();
  const [simPos, setSimPos] = useState<LivePosition | null>(null);
  const userPos = simPos ?? live.position;
  /**
   * Preview mode: navigation played from a simulated position, offered only when the real thing
   * cannot work (no fix, or a fix far from the resort). See `PreviewPrompt` for why it is a prompt
   * rather than a setting, and `App.css` for why the signalling is a frame rather than a colour.
   */
  const [previewMode, setPreviewMode] = useState(false);
  const [previewPrompt, setPreviewPrompt] = useState<PreviewReason | null>(null);
  // One offer per navigation session — re-asking after a decline would be nagging.
  const previewAsked = useRef(false);
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
        setStatus(null);
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
      .catch((e) => setStatus({ kind: 'errorResorts', detail: String(e) }));
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
    setStatus({ kind: 'loadingResort' });
    Promise.all([loadResortGraph(resortId), loadResortGeo(resortId)])
      .then(([g, ge]) => {
        setGraph(g);
        setGeo(ge);
        setStatus(null);
      })
      .catch((e) => setStatus({ kind: 'errorResort', detail: String(e) }));
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
  // Build picker rows grouped by country; a resort whose country lists several (e.g. "Italy /
  // Switzerland") appears once under EACH country, sorted country-then-name for grouped headers.
  const resortOptions = useMemo<ResortOption[]>(() => {
    const opts = (index ?? []).flatMap((r) =>
      r.country.split('/').map((c) => ({ id: r.id, name: r.name, country: c.trim() })),
    );
    return opts.sort((a, b) => a.country.localeCompare(b.country) || a.name.localeCompare(b.name));
  }, [index]);
  // Flatten into <ListSubheader> country headers + <MenuItem> rows for the grouped Select.
  const resortMenuItems = useMemo(() => {
    const items: ReactNode[] = [];
    let lastCountry: string | null = null;
    for (const o of resortOptions) {
      if (o.country !== lastCountry) {
        items.push(
          <ListSubheader
            key={`country-${o.country}`}
            sx={{
              display: 'flex',
              alignItems: 'center',
              gap: 0.75,
              bgcolor: 'background.default',
              color: 'primary.main',
              fontSize: 11,
              fontWeight: 700,
              letterSpacing: '0.08em',
              textTransform: 'uppercase',
              lineHeight: '32px',
              borderBottom: 1,
              borderColor: 'divider',
              pointerEvents: 'none',
            }}
          >
            <Box
              component="img"
              src={flagDataUrl(countryCode(o.country))}
              alt=""
              sx={{ width: 18, height: 12, borderRadius: '2px', flexShrink: 0 }}
            />
            <bdi>{o.country}</bdi>
          </ListSubheader>,
        );
        lastCountry = o.country;
      }
      // Indent via inline style, not `sx`: the RTL emotion plugin rewrites padding-left to
      // padding-right, which would indent from the wrong side inside this LTR-pinned menu.
      items.push(
        <MenuItem key={`${o.country}-${o.id}`} value={o.id} style={{ paddingLeft: 24 }}>
          <bdi>{o.name}</bdi>
        </MenuItem>,
      );
    }
    return items;
  }, [resortOptions]);
  // Shared resort selection (used by both the picker and the map's overview dots). The "assumed
  // open" status notice itself is driven by the resortId effect below (gated once per resort/day).
  // Selecting is also the ONLY way out of the map's global (flags) view — hence the seq bump, so
  // re-picking the resort you are already on still re-frames it instead of doing nothing.
  const selectResort = useCallback((id: string) => {
    setResortId(id);
    setDeepLinkActive(false);
    setGlobalView(false);
    setResortFrameSeq((n) => n + 1);
  }, []);
  const handleEnterGlobalView = useCallback(() => setGlobalView(true), []);
  // Show the "statuses assumed open" notice at most once per resort per day, on any resortId change
  // (initial landing, picker, map dot, or geolocation) — not on every selection.
  useEffect(() => {
    if (!resortId || !shouldShowStatusNotice(resortId)) return;
    setPopup({
      title: t('app.statusNotice.title'),
      text: t('app.statusNotice.text'),
      href: getResort(resortId)?.infoUrl,
      hrefLabel: t('app.statusNotice.hrefLabel'),
      tip: t('app.statusNotice.tip'),
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resortId]);
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

  /**
   * "Is this position at the resort?" measured against the nearest graph node, NOT the resort
   * centre. A centre-distance test lies on sprawling multi-valley resorts — at Sella Ronda you can
   * be on a piste and still be 10 km from the centroid — whereas the nearest node is by definition
   * the closest bit of mapped terrain. Generous threshold on purpose: a false "far" merely offers
   * Preview to someone who is really there (a shrug), while a false "near" would withhold it.
   */
  const PREVIEW_FAR_M = 10_000;
  const isFarFromResort = useCallback(
    (p: LivePosition | null): boolean => {
      if (!p || !effectiveGraph) return false;
      const n = nearestNode(effectiveGraph, p.lon, p.lat);
      return !!n && haversineM({ lon: p.lon, lat: p.lat, ele: 0 }, n.point) > PREVIEW_FAR_M;
    },
    [effectiveGraph],
  );

  /**
   * Is there a position the follow camera may legitimately fly to?
   *
   * The camera used to follow whatever `userPos` held, which is wrong the moment the real fix is
   * nowhere near the mountain: leaving Preview clears `simPos` while `following` is still true, so
   * the map eased straight from Madonna to the user's real position in another country. A
   * simulated position is at the resort by construction; a real one has to earn it.
   */
  const posAtResort = !!simPos || (!!live.position && !isFarFromResort(live.position));

  // Offer Preview when navigation cannot work for real. Three ways in: the location was refused or
  // errored; a good fix arrived but it is nowhere near the mountain; or nothing arrived at all
  // within a grace period (permission dialog left unanswered, indoors with no fix).
  useEffect(() => {
    if (!navRoute || previewMode || simPos || previewAsked.current) return;
    if (live.error) {
      previewAsked.current = true;
      setPreviewPrompt('noFix');
      return;
    }
    if (live.position && isFarFromResort(live.position)) {
      previewAsked.current = true;
      setPreviewPrompt('far');
      return;
    }
    if (live.position) return;
    const id = window.setTimeout(() => {
      if (previewAsked.current) return;
      previewAsked.current = true;
      setPreviewPrompt('noFix');
    }, 12_000);
    return () => window.clearTimeout(id);
  }, [navRoute, previewMode, simPos, live.error, live.position, isFarFromResort]);

  // Self-cancelling: the instant a real fix places the user at the resort, Preview must stand down.
  // A simulated position while someone is actually skiing is the one genuinely dangerous state.
  useEffect(() => {
    if (!previewMode || !live.position || isFarFromResort(live.position)) return;
    setPreviewMode(false);
    setSimPos(null);
    notify(t('preview.endedRealFix'), 'info');
  }, [previewMode, live.position, isFarFromResort, notify, t]);

  const onLocateToggle = () => {
    // In Preview there is no real location to fall back to, so the FAB only
    // toggles camera-follow. Clearing simPos here would drop the overlay back
    // to "waiting for location" — the exact dead end Preview exists to escape.
    if (previewMode) {
      setFollowing((f) => !f);
      notify(t(following ? 'app.notice.followingOff' : 'app.notice.followingOn'), 'info');
      return;
    }
    if (!live.tracking && !simPos) {
      live.start();
      setFollowing(true);
      notify(t('app.notice.followingOn'), 'info');
    } else if (!following) {
      setFollowing(true);
      // Be honest rather than appear broken: follow is on, but the camera will stay on the mountain
      // until there is a fix here, so say so instead of leaving a lit FAB and a motionless map.
      notify(
        posAtResort ? t('app.notice.followingRecentered') : t('app.notice.followingFar'),
        posAtResort ? 'info' : 'warning',
      );
    } else {
      live.stop();
      setSimPos(null);
      setFollowing(false);
      notify(t('app.notice.followingOff'), 'info');
    }
  };

  const startNav = () => {
    if (!selected) {
      notify(t('app.notice.navNoRoute'), 'warning');
      return;
    }
    setNavRoute(selected);
    setFollowing(true);
    setPanelOpen(false);
    previewAsked.current = false;
    if (!live.tracking && !simPos) live.start();
  };
  const exitNav = () => {
    setNavRoute(null);
    setSimPos(null);
    setPreviewMode(false);
    setPreviewPrompt(null);
    // Once the simulation stops there may be nothing worth following: leaving follow mode on would
    // light the locate FAB while the camera deliberately ignores a fix that isn't at the resort.
    if (!live.position || isFarFromResort(live.position)) {
      setFollowing(false);
      live.stop();
    }
    // Return to a clean map: drop the computed routes (options list, drawn line, preview card),
    // but keep the From/To selections so re-planning is one tap.
    setPlan(null);
    setSelectedRoute(0);
    setSelectedRange(null);
    setFocusGeometry(null);
    setPreviewDismissed(false);
  };
  /**
   * Start over: drop both the inputs and everything computed from them in one action.
   *
   * `exitNav` above does the *outputs* half and deliberately keeps From/To so re-planning is one
   * tap; this is the other intent — clear the form too. It stops at plan-owned state: the map
   * highlight (`focusGeometry`) belongs to the Longest-runs section, and planning already nulls it,
   * so there is never a stale route highlight left behind for this to clean up.
   */
  const clearPlan = () => {
    setFromNodeId(null);
    setToNodeId(null);
    setFromCustom(null);
    setToCustom(null);
    setPinMode(null);
    setPlan(null);
    setSelectedRoute(0);
    setSelectedRange(null);
    setPreviewDismissed(false);
  };
  // On mobile the bottom sheet must never overlap the navigation overlay.
  useEffect(() => { if (navRoute) setPanelOpen(false); }, [navRoute]);
  // Closing or reopening a run changes the question the Longest card answers, so a previously
  // computed answer is stale — same reasoning as the "allow poling" checkbox, which clears it too.
  useEffect(() => {
    setLongestRuns(null);
    setFocusGeometry(null);
  }, [closedKeys]);
  const rerouteFromHere = () => {
    if (!effectiveGraph || !userPos || !toNodeId) return;
    const near = nearestNode(effectiveGraph, userPos.lon, userPos.lat);
    if (!near) return;
    const result = planRoutes(effectiveGraph, {
      resortId,
      fromNodeId: near.id,
      toNodeId,
      timing:
        timingMode === 'arrive_by'
          ? { mode: 'arrive_by', time: new Date(arriveTime).toISOString() }
          : { mode: 'now' },
      prefs,
      closedKeys: closedRef.current,
    });
    if (result.error || !result.routes.length) {
      setPopup(result.error ? { text: tr(t, result.error), severity: 'warning' } : { text: t('app.notice.navNoRouteHere'), severity: 'warning' });
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
      notify(t('app.notice.speedsNotEnough'), 'warning');
      return;
    }
    setPrefs((p) => {
      // Measured GPS speeds are TRUE move speeds — divide out the per-colour snake factor to get
      // the PROGRESS speed the router needs, and flag that overrides are in use.
      const skiSpeedByColor = { ...p.speeds.skiSpeedByColor };
      for (const c of colors) if (avg[c] != null) skiSpeedByColor[c] = measuredTrueToProgressMps(avg[c] as number, c);
      return { ...p, useMeasuredSpeeds: true, speeds: { ...p.speeds, skiSpeedByColor } };
    });
    notify(t('app.notice.speedsOn'), 'success');
  };
  const resetMeasured = () => {
    const m = emptyMeasured();
    saveMeasured(m);
    setMeasured(m);
    setPrefs((p) => ({ ...p, useMeasuredSpeeds: false, speeds: { ...p.speeds, skiSpeedByColor: {} } }));
  };
  // TRUE move speed per colour for display (progress × snake factor): the override when the user
  // opted into measured speeds, otherwise the model's derived progress speed.
  const estimatedByColor: Record<SpeedColor, number> = {
    green: (prefs.speeds.skiSpeedByColor.green ?? progressSpeedMps('green', prefs.skillLevel)) * SNAKE_FACTOR.green,
    blue: (prefs.speeds.skiSpeedByColor.blue ?? progressSpeedMps('blue', prefs.skillLevel)) * SNAKE_FACTOR.blue,
    red: (prefs.speeds.skiSpeedByColor.red ?? progressSpeedMps('red', prefs.skillLevel)) * SNAKE_FACTOR.red,
    black: (prefs.speeds.skiSpeedByColor.black ?? progressSpeedMps('black', prefs.skillLevel)) * SNAKE_FACTOR.black,
  };

  const handleMapClick = useCallback(
    (p: LonLat) => {
      if (linkPinMode) {
        const label = `📍 map point`;
        if (linkPinMode === 'from') setLinkFrom({ kind: 'point', lon: p.lon, lat: p.lat, label });
        else setLinkTo({ kind: 'point', lon: p.lon, lat: p.lat, label });
        setLinkPinMode(null);
        if (isMobile) setPanelOpen(true); // restore the sheet we minimised to reveal the map
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
      if (isMobile) setPanelOpen(true);
    },
    [pinMode, linkPinMode, effectiveGraph, isMobile],
  );

  // Enter map-pin mode; on mobile also minimise the sheet so the map is tappable.
  const enterPinMode = (which: 'from' | 'to') => {
    setPinMode((cur) => {
      const next = cur === which ? null : which;
      if (next && isMobile) setPanelOpen(false);
      return next;
    });
  };
  const enterLinkPinMode = (which: 'from' | 'to') => {
    setLinkPinMode((cur) => {
      const next = cur === which ? null : which;
      if (next && isMobile) setPanelOpen(false);
      return next;
    });
  };

  const pickLocationFor = (which: 'from' | 'to') => {
    if (!effectiveGraph || !('geolocation' in navigator)) {
      notify(t('app.notice.geoUnavailable'), 'warning');
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const n = nearestNode(effectiveGraph, pos.coords.longitude, pos.coords.latitude);
        if (!n) return;
        if (which === 'from') { setFromNodeId(n.id); setFromCustom(t('app.point.myLocation')); }
        else { setToNodeId(n.id); setToCustom(t('app.point.myLocation')); }
      },
      () => notify(t('app.notice.geoFailedPick'), 'warning'),
      { timeout: 5000 },
    );
  };

  const doPlan = (fromId: string | null = fromNodeId, toId: string | null = toNodeId) => {
    if (!effectiveGraph || !fromId || !toId) {
      notify(t('app.notice.pickBoth'), 'warning');
      return;
    }
    const result = planRoutes(effectiveGraph, {
      resortId,
      fromNodeId: fromId,
      toNodeId: toId,
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
    // Bring the results into view: on mobile this selects the Plan tab (which carries the results);
    // on desktop the form and results are pinned open, so this only closes any secondary section.
    setOpenSection('routes');
    setPreviewDismissed(false);
    if (result.error) {
      notify(tr(t, result.error), 'warning');
      return;
    }
    // Frame the route we're about to show, the way the longest-run finder does. Without this the
    // camera stays wherever the user last left it, which after picking A and B is often nowhere
    // near the route.
    const first = result.routes[0];
    if (first) {
      const coords = first.legs.flatMap((l) => {
        const edge = edgeMap.get(l.edgeId);
        return edge ? edge.geometry.map((p) => [p.lon, p.lat] as [number, number]) : [];
      });
      if (coords.length >= 2) {
        fitSeq.current += 1;
        setFitRequest({ coords, seq: fitSeq.current });
      }
    }
    const codes = new Set(result.routes.flatMap((r) => r.warnings.map((w) => w.code)));
    const notes: string[] = [];
    if (codes.has('missing_opening_hours')) notes.push(t('app.notes.missingHours'));
    if (codes.has('using_default_wait')) notes.push(t('app.notes.defaultWait'));
    if (codes.has('using_default_speed')) notes.push(t('app.notes.defaultSpeed'));
    if (notes.length) notify(notes.join('\n'));
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
      try { await navigator.clipboard.writeText(`${message}\n${url}`); notify(t('app.notice.shareCopied'), 'success'); }
      catch { setPopup(`${message}\n${url}`); }
    } else {
      setPopup(`${message}\n${url}`);
    }
  };

  const shareMyLocation = () => {
    setShareAnchor(null);
    const msg = t('app.share.msgMe');
    const me = t('app.point.myLocation');
    if (userPos) { void shareCoord({ lon: userPos.lon, lat: userPos.lat }, me, msg); return; }
    if (!('geolocation' in navigator)) { notify(t('app.notice.geoUnavailable'), 'warning'); return; }
    navigator.geolocation.getCurrentPosition(
      (p) => void shareCoord({ lon: p.coords.longitude, lat: p.coords.latitude }, me, msg),
      () => notify(t('app.notice.geoFailedShare'), 'warning'),
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
    if (!dest) { notify(t('app.notice.sharePlaceFailed'), 'warning'); return; }
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
      notify(t('app.notice.geoUnavailableFrom'), 'warning');
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const n = effectiveGraph ? nearestNode(effectiveGraph, pos.coords.longitude, pos.coords.latitude) : null;
        if (!n) { notify(t('app.notice.geoPlaceFailedFrom'), 'warning'); return; }
        setFromNodeId(n.id);
        setFromCustom(t('app.point.myLocation'));
        doPlan(n.id, toId);
      },
      () => notify(t('app.notice.geoFailedFrom'), 'warning'),
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
      notify(t('app.notice.linkPickBoth'), 'warning');
      return;
    }
    const a = resolveLinkEnd(linkFrom);
    const b = resolveLinkEnd(linkTo);
    if (!a || !b || a.id === b.id) {
      notify(t('app.notice.linkPickDistinct'), 'warning');
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
    notify(
      t('app.notice.linkAdded', {
        color: color === 'none' ? t('app.notice.linkColorFlat') : t(`color.${color}`),
        direction: direction === 'both' ? t('app.notice.linkDirBoth') : direction.toUpperCase(),
      }),
      'success',
    );
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
    if (p) return bidiName(p.name);
    if (nodeId.startsWith('cn-')) {
      const cn = customNodes.find((n) => n.id === nodeId);
      return cn?.point.ele != null
        ? t('app.point.mapPointEle', { ele: Math.round(cn.point.ele) })
        : t('app.point.mapPoint');
    }
    const n = nodeMap.get(nodeId);
    if (n?.name) return bidiName(n.name);
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
        const named = bidiName(`${best.name}${ele}`);
        // Same spot (different node id) reads better without the "near" qualifier.
        return bestD <= 20 ? named : t('app.point.near', { name: named });
      }
    }
    if (n?.point.ele != null) return t('app.point.at', { ele: Math.round(n.point.ele) });
    return nodeId;
  };

  const computeLongestRun = () => {
    if (!effectiveGraph) return;
    const res = findLongestRuns(effectiveGraph, prefs, 3, closedKeys);
    if (!res.length) {
      setLongestRuns(null);
      notify(t('app.notice.longestNone'), 'warning');
      return;
    }
    const named = res.map((r) => ({
      ...r,
      startName: nodeLabelFor(r.startNodeId),
      endName: nodeLabelFor(r.endNodeId),
      usesInferred: r.edges.some((e) => e.synthetic && !e.custom),
    }));
    setLongestRuns(named);
    setLongestIdx(0);
    // Showing the longest run is a highlight, not a route — clear any route options so only
    // one thing glows on the map at a time.
    setPlan(null);
    setSelectedRange(null);
    setFocusGeometry(named[0].coords);
    // Deliberately does NOT close the mobile sheet. The user asked for the three longest runs, so
    // dropping them straight onto the map hid the very list they came for; revealing the map is
    // "Show on map"'s job (see onShowOnMap). These two behaviours used to be exactly inverted.
    setLongestDismissed(false);
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
    notify(t('app.notice.longestDestSet', { name: currentLongest.startName }));
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
    notify(t('app.notice.closedMarked', { label }), 'success');
  };

  const reopenClosure = (key: string) => applyClosures(closedRef.current.filter((k) => k !== key));
  const reopenAllClosures = () => applyClosures([]);

  // Every closed run/lift as geometry, so the map can draw what the router is refusing. One
  // polyline per affected EDGE — a single closure key routinely covers several disconnected edges.
  const closedGeometry = useMemo(
    () => (effectiveGraph ? closedGeometries(effectiveGraph, closedKeys) : []),
    [effectiveGraph, closedKeys],
  );

  const locateClosure = (key: string) => {    if (!effectiveGraph) return;
    const coords = geometryForClosure(effectiveGraph, key);
    if (coords.length >= 2) setFocusGeometry(coords);
    else notify(t('app.notice.closureLocateFailed'), 'warning');
  };

  const points = graph?.points ?? [];

  const fromLabel = fromCustom ?? (fromNodeId ? nodeLabelFor(fromNodeId) : null);
  const toLabel = toCustom ?? (toNodeId ? nodeLabelFor(toNodeId) : null);
  const planSummary =
    fromLabel || toLabel
      ? `${fromLabel ?? t('app.plan.from')} → ${toLabel ?? t('app.plan.to')}`
      : t('app.summary.pickStartEnd');
  const longestSummary = currentLongest
    ? `${currentLongest.startName} → ${currentLongest.endName}`
    : t('app.summary.findLongest');
  const linkGroupCount = useMemo(
    () => new Set(customEdges.map((e) => e.id.split('-').slice(0, 2).join('-'))).size,
    [customEdges],
  );
  const linksSummary = linkGroupCount ? t('app.summary.links', { count: linkGroupCount }) : t('app.summary.noneYet');
  const closedSummary = closedKeys.length ? t('app.summary.closed', { count: closedKeys.length }) : t('app.summary.allOpen');
  const { mode, toggle: toggleTheme } = useThemeMode();
  const locateActive = live.tracking || !!simPos;
  const locateTip = !locateActive ? t('app.locate.show') : following ? t('app.locate.following') : t('app.locate.recenter');

  // Mobile bottom navigation. "Route options" is folded into the Plan tab, giving 5 fixed tabs.
  const mobileTab = openSection === 'routes' ? 'plan' : openSection;
  const showSec = (key: string) =>
    !isMobile || (key === 'routes' ? mobileTab === 'plan' : mobileTab === key);
  const selectMobileTab = (v: string) => {
    if (panelOpen && v === mobileTab) { setPanelOpen(false); return; }
    setOpenSection(v);
    setPanelOpen(true);
  };
  // The sheet carries a single title instead of the per-section accordion headers the desktop
  // column uses. Falls back to Plan so the header is never blank mid-transition.
  const sectionHeader = ({
    plan: { title: t('app.plan.title'), icon: <SearchIcon fontSize="small" /> },
    longest: { title: t('app.longest.title'), icon: <EmojiEventsIcon fontSize="small" /> },
    links: { title: t('app.links.title'), icon: <LinkIcon fontSize="small" /> },
    closed: { title: t('app.closed.title'), icon: <DoNotDisturbOnIcon fontSize="small" /> },
    prefs: { title: t('app.prefs.title'), icon: <TuneIcon fontSize="small" /> },
  } as Record<string, { title: string; icon: ReactNode }>)[mobileTab]
    ?? { title: t('app.plan.title'), icon: <SearchIcon fontSize="small" /> };

  // The sheet's open/close, backdrop and swipe-to-dismiss now belong to PanelShell's MUI drawer.

  return (
    <div className="app">
      <AppBar position="static" color="default" elevation={0} sx={{ borderBottom: 1, borderColor: 'divider', bgcolor: 'background.paper' }}>
        {/* Pinned LTR: the header is chrome, not prose. The brand lockup stays on the left and the
            resort / language / theme controls on the right in every language, which is also what
            keeps it consistent with the map controls below. */}
        <Toolbar dir="ltr" sx={{ gap: 1, minHeight: 60, px: { xs: 1, sm: 2 } }}>
          <IconButton
            edge="start"
            onClick={() => setPanelOpen((o) => !o)}
            aria-label={panelOpen ? t('app.hideControls') : t('app.showControls')}
            sx={{ display: 'none' }}
          >
            <MenuIcon />
          </IconButton>
          <Box sx={{ display: 'flex', alignItems: 'center' }}>
            <Logo className="logo-mark" />
          </Box>
          {status && (
            <Typography variant="body2" color="text.secondary" noWrap dir={dir} sx={{ display: { xs: 'none', sm: 'block' } }}>
              {'detail' in status
                ? t(`app.status.${status.kind}`, { detail: status.detail })
                : t(`app.status.${status.kind}`)}
            </Typography>
          )}
          <Box sx={{ flex: 1 }} />
          <FormControl
            size="small"
            // Fluid, not stepped: the picker takes whatever the brand and the buttons leave over,
            // so a 430px phone gets a wider picker than a 360px one without another breakpoint.
            // It shares the slack with the spacer above and freezes at maxWidth, after which the
            // spacer absorbs the rest.
            sx={{ flex: '1 1 auto', minWidth: { xs: 88, sm: 170 }, maxWidth: 280 }}
          >
            <InputLabel id="resort-picker-label">{t('app.resort')}</InputLabel>
            <Select
              labelId="resort-picker-label"
              label={t('app.resort')}
              value={index ? resortId : ''}
              // Resort and country names are never translated, so the menu stays left-aligned even
              // in Hebrew — a column of Latin names ragged-right is harder to scan than ragged-left.
              MenuProps={{ slotProps: { paper: { dir: 'ltr' } } }}
              renderValue={() => <bdi>{resortEntry?.shortName ?? resortEntry?.name ?? ''}</bdi>}
              onChange={(e) => {
                selectResort(e.target.value);
              }}
            >
              {resortMenuItems}
            </Select>
          </FormControl>
          {/* Below sm the bar cannot hold both icon buttons beside the brand and the resort
              picker, so they collapse into one overflow menu. See AppBarOverflow. */}
          {isNarrow ? (
            <AppBarOverflow />
          ) : (
            <>
              <LanguagePicker />
              <Tooltip title={mode === 'dark' ? t('app.themeLight') : t('app.themeDark')}>
                <IconButton onClick={toggleTheme} aria-label={t('app.themeToggle')}>
                  {mode === 'dark' ? <LightModeIcon /> : <DarkModeIcon />}
                </IconButton>
              </Tooltip>
            </>
          )}
        </Toolbar>
      </AppBar>

      <div className="body">
        <PanelShell
          isMobile={isMobile}
          open={panelOpen}
          onClose={() => setPanelOpen(false)}
          onOpen={() => setPanelOpen(true)}
          title={sectionHeader.title}
          icon={sectionHeader.icon}
        >
          {showSec('plan') && (
          <AccordionSection
            title={t('app.plan.title')}
            icon={<SearchIcon fontSize="small" />}
            summary={planSummary}
            bare={isMobile}
            pinned
            open={openSection === 'plan'}
            onToggle={() => toggleSection('plan')}
          >
          <div className="panel">
            <h3>{t('app.plan.title')}</h3>
            <PointPicker
              label={t('app.plan.from')}
              accent="#2e7d32"
              points={points}
              valueNodeId={fromNodeId}
              customLabel={fromCustom}
              onPick={(id) => { setFromNodeId(id); setFromCustom(null); }}
              onUseLocation={() => pickLocationFor('from')}
              onPinMode={() => enterPinMode('from')}
              pinActive={pinMode === 'from'}
            />
            <PointPicker
              label={t('app.plan.to')}
              accent="#c62828"
              points={points}
              valueNodeId={toNodeId}
              customLabel={toCustom}
              onPick={(id) => { setToNodeId(id); setToCustom(null); }}
              onUseLocation={() => pickLocationFor('to')}
              onPinMode={() => enterPinMode('to')}
              pinActive={pinMode === 'to'}
            />

            <Box sx={{ mb: 1.5 }}>
              <Typography variant="body2" color="text.secondary" sx={{ mb: 0.5 }}>
                {t('app.plan.when')}
              </Typography>
              <ToggleButtonGroup
                exclusive
                size="small"
                value={timingMode}
                onChange={(_, v) => v && setTimingMode(v)}
              >
                <ToggleButton value="now">{t('app.plan.now')}</ToggleButton>
                <ToggleButton value="arrive_by">{t('app.plan.arriveBy')}</ToggleButton>
              </ToggleButtonGroup>
              {timingMode === 'arrive_by' && (
                <ArriveTimePicker value={arriveTime} onChange={setArriveTime} />
              )}
            </Box>

            <Box sx={{ display: 'flex', gap: 1 }}>
              <Button
                variant="contained"
                size="large"
                fullWidth
                onClick={() => doPlan()}
                disabled={!graph}
                sx={{ flex: 1 }}
              >
                {t('app.plan.find')}
              </Button>
              {/* Only shown when there is actually something to clear: a permanently disabled
                  button is clutter on the first screen a user ever sees. */}
              {(fromNodeId || toNodeId || pinMode || plan) && (
                <Button
                  variant="outlined"
                  size="large"
                  color="inherit"
                  onClick={clearPlan}
                  sx={{ flex: '0 0 auto', borderColor: 'divider', color: 'text.secondary' }}
                >
                  {t('app.plan.clear')}
                </Button>
              )}
            </Box>
            <Button
              variant="outlined"
              size="large"
              fullWidth
              startIcon={<IosShareIcon />}
              onClick={(e) => setShareAnchor(e.currentTarget)}
              sx={{ mt: 1 }}
            >
              {t('app.share.button')}
            </Button>
            <Menu anchorEl={shareAnchor} open={!!shareAnchor} onClose={() => setShareAnchor(null)}>
              <MenuItem onClick={shareMyLocation}>{t('app.share.myLocationItem')}</MenuItem>
              <MenuItem
                disabled={!toNodeId}
                onClick={() => {
                  setShareAnchor(null);
                  const coord = pointFor(toNodeId);
                  if (!coord) { notify(t('app.notice.shareNoDest'), 'warning'); return; }
                  const place = toLabel ?? t('app.share.thisSpot');
                  void shareCoord(coord, place, t('app.share.msgHere', { place }));
                }}
              >
                {toLabel ? t('app.share.toDestNamed', { name: toLabel }) : t('app.share.toDest')}
              </MenuItem>
            </Menu>
          </div>
          </AccordionSection>
          )}

          {showSec('routes') && plan && (plan.noLiftFreeRoute || plan.routes.length > 0) && (
            <AccordionSection
              title={t('app.routes.title')}
              icon={<AltRouteIcon fontSize="small" />}
              summary={plan.routes.length ? t('app.summary.options', { count: plan.routes.length }) : t('app.summary.noRoute')}
              bare={isMobile}
              pinned
              open={openSection === 'routes'}
              onToggle={() => toggleSection('routes')}
            >
              {plan.noLiftFreeRoute && (
                <Alert severity="warning" sx={{ mb: 1 }}>
                  <strong>{t('app.routes.noLiftFree')}</strong>
                  {plan.nearestSkiDestination ? (
                    <>
                      {' '}{t('app.routes.nearestDest')}{' '}
                      <Box
                        component="button"
                        type="button"
                        onClick={() => {
                          setToNodeId(plan.nearestSkiDestination!.nodeId);
                          setToCustom(null);
                        }}
                        sx={{ background: 'none', border: 0, p: 0, color: 'primary.main', cursor: 'pointer', font: 'inherit', textDecoration: 'underline' }}
                      >
                        <bdi>{plan.nearestSkiDestination.name}</bdi>
                      </Box>{' '}
                      {t('app.routes.tapToSet')}
                    </>
                  ) : (
                    ` ${t('app.routes.tryLower')}`
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
                <Button variant="contained" color="success" fullWidth startIcon={<PlayArrowIcon style={{ transform: rtl ? 'scaleX(-1)' : undefined }} />} onClick={startNav} sx={{ mt: 1 }}>
                  {t('app.routes.startNav')}
                </Button>
              )}
            </AccordionSection>
          )}

          {showSec('longest') && (
          <AccordionSection
            title={t('app.longest.title')}
            icon={<EmojiEventsIcon fontSize="small" />}
            summary={longestSummary}
            bare={isMobile}
            open={openSection === 'longest'}
            onToggle={() => toggleSection('longest')}
          >
          <LongestRunPanel
            runs={longestRuns}
            index={longestIdx}
            allowPoling={prefs.allowPoling}
            onAllowPolingChange={(value) => {
              setPrefs((p) => ({ ...p, allowPoling: value }));
              // The shown runs were scored under the old setting, so they no longer answer the
              // question the checkbox now asks. Clear them rather than leave a stale answer on screen.
              setLongestRuns(null);
            }}
            onFind={computeLongestRun}
            onPrev={() => stepLongest(-1)}
            onNext={() => stepLongest(1)}
            onShowOnMap={() => {
              if (!currentLongest) return;
              setPlan(null);
              setSelectedRange(null);
              setFocusGeometry(currentLongest.coords);
              setLongestDismissed(false);
              // The button is named "Show on map", so on mobile it has to actually reveal the map.
              if (isMobile) setPanelOpen(false);
            }}
            onNavigateStart={navigateToLongestStart}
            onNavigateEnd={navigateToLongestEnd}
          />
          </AccordionSection>
          )}

          {showSec('links') && (
          <AccordionSection
            title={t('app.links.title')}
            icon={<LinkIcon fontSize="small" />}
            summary={linksSummary}
            bare={isMobile}
            open={openSection === 'links'}
            onToggle={() => toggleSection('links')}
          >
          <CustomLinkPanel
            points={points}
            fromLabel={linkFrom?.label ?? null}
            toLabel={linkTo?.label ?? null}
            onPickFrom={(nodeId) => setLinkFrom({ kind: 'node', nodeId, label: nodeLabelFor(nodeId) })}
            onPickTo={(nodeId) => setLinkTo({ kind: 'node', nodeId, label: nodeLabelFor(nodeId) })}
            onPinFrom={() => enterLinkPinMode('from')}
            onPinTo={() => enterLinkPinMode('to')}
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
          )}

          {showSec('closed') && (
          <AccordionSection
            title={t('app.closed.title')}
            icon={<DoNotDisturbOnIcon fontSize="small" />}
            summary={closedSummary}
            bare={isMobile}
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
          )}

          {showSec('prefs') && (
          <AccordionSection
            title={t('app.prefs.title')}
            icon={<TuneIcon fontSize="small" />}
            summary={t('app.prefs.summary')}
            bare={isMobile}
            open={openSection === 'prefs'}
            onToggle={() => toggleSection('prefs')}
          >
          <PreferencesPanel prefs={prefs} onChange={setPrefs} />
          <MeasuredSpeedsPanel measured={measured ?? emptyMeasured()} estimatedByColor={estimatedByColor} minSamples={MIN_SAMPLES} onApply={applyMeasured} onReset={resetMeasured} />
          </AccordionSection>
          )}

          {!isMobile && graph && (
            <Typography variant="caption" color="text.secondary" sx={{ display: 'block', textAlign: 'center', py: 1 }}>
              {t('app.graphStats', {
                nodes: effectiveGraph?.nodes.length ?? 0,
                edges: effectiveGraph?.edges.length ?? 0,
                points: points.length,
              })}
            </Typography>
          )}
        </PanelShell>

        {/* The map is geography, not prose: north is up and west is left in every language. Pinning
            it LTR also keeps our MUI overlays (Fabs, layer/legend buttons) on the same side as
            MapLibre's own controls, whose stylesheet the emotion RTL plugin never sees. */}
        <main className="map-wrap" dir="ltr">
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
            closedGeometry={closedGeometry}
            fitRequest={fitRequest}
            onMapClick={handleMapClick}
            userPosition={userPos}
            positionSimulated={previewMode && !!simPos}
            following={following && posAtResort}
            nav={navData?.render ?? null}
            navHeadingUp
            resorts={index ?? []}
            selectedResortId={resortId}
            onSelectResort={selectResort}
            globalView={globalView}
            onEnterGlobalView={handleEnterGlobalView}
            resortFrameSeq={resortFrameSeq}
            allowOffPiste={prefs.allowOffPiste}
          />
          {/* Peripheral, unmissable marker that the position on screen is not real. */}
          {previewMode && <div className="preview-frame" aria-hidden="true" />}
          {globalView && (
            <div className="pin-hint" dir={dir} data-testid="global-view-hint">
              {t('app.globalHint')}
            </div>
          )}
          {pinMode && <div className="pin-hint" dir={dir}>{t('app.pinHintPoint', { which: pinMode === 'from' ? t('app.plan.from') : t('app.plan.to') })}</div>}
          {linkPinMode && <div className="pin-hint" dir={dir}>{t('app.pinHintLink', { which: linkPinMode === 'from' ? t('app.link.fromWord') : t('app.link.toWord') })}</div>}
          {/* Positioned with an inline style, not `sx`: the RTL emotion plugin rewrites left/right in
              generated CSS whatever the container's dir is, and these buttons must stay put in
              Hebrew — MapLibre's own controls (its stylesheet, which the plugin never sees) do. */}
          <Box
            style={{ position: 'absolute', top: 12, right: 12 }}
            sx={{ zIndex: 5, display: 'flex', flexDirection: 'column', gap: 1 }}
          >
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
            {!isMobile && (
              <Tooltip title={t('app.plan.title')} placement="left">
                <Fab
                  size="small"
                  aria-label={t('app.plan.title')}
                  onClick={() => { setOpenSection('plan'); setPanelOpen(true); }}
                  sx={{ bgcolor: 'background.paper', color: 'text.primary' }}
                >
                  <SearchIcon />
                </Fab>
              </Tooltip>
            )}
            {!isMobile && plan && plan.routes.length > 0 && (
              <Tooltip title={t('app.routes.title')} placement="left">
                <Fab
                  size="small"
                  aria-label={t('app.routes.title')}
                  onClick={() => { setOpenSection('routes'); setPanelOpen(true); }}
                  sx={{ bgcolor: 'background.paper', color: 'text.primary' }}
                >
                  <AltRouteIcon />
                </Fab>
              </Tooltip>
            )}
          </Box>
          {navRoute && (
            <div dir={dir}>
              <NavOverlay
                step={navData?.step}
                remaining={navData?.rem}
                speedMps={userPos?.speed ?? null}
                offRoute={navData?.offRoute ?? false}
                waiting={!userPos}
                onExit={exitNav}
                onReroute={rerouteFromHere}
                sim={previewMode || import.meta.env.DEV
                  ? { path: navPath, onSim: setSimPos, preview: previewMode }
                  : undefined}
              />
            </div>
          )}
          {plan && plan.routes.length > 0 && !navRoute && !previewDismissed && (!isMobile || !panelOpen) && (
            <div dir={dir}>
              <RoutePreview
                routes={plan.routes}
                selectedIndex={selectedRoute}
                onSelect={(i) => { setSelectedRoute(i); setSelectedRange(null); }}
                onStart={startNav}
                onDetails={() => { setOpenSection('routes'); setPanelOpen(true); }}
                onDismiss={() => setPreviewDismissed(true)}
                bottom={isMobile ? 'calc(64px + env(safe-area-inset-bottom, 0px))' : 16}
              />
            </div>
          )}
          {longestRuns && longestRuns.length > 0 && currentLongest && focusGeometry && !navRoute && !plan
            && !longestDismissed && (!isMobile || !panelOpen) && (
            <div dir={dir}>
              <LongestPreview
                runs={longestRuns}
                index={longestIdx}
                onPrev={() => stepLongest(-1)}
                onNext={() => stepLongest(1)}
                onDetails={() => { setOpenSection('longest'); setPanelOpen(true); }}
                onDismiss={() => setLongestDismissed(true)}
                onNavigateStart={() => {
                  navigateToLongestStart();
                  // Unlike "To end", this only fills in the destination — it does not plan. From the
                  // floating card the sheet is closed, so without this the user gets a toast and no
                  // way to continue; hand them the planner with the destination already set.
                  // (`mobileTab` is derived from `openSection`, so this selects the Plan tab too.)
                  setOpenSection('plan');
                  if (isMobile) setPanelOpen(true);
                }}
                onSki={navigateToLongestEnd}
                bottom={isMobile ? 'calc(64px + env(safe-area-inset-bottom, 0px))' : 16}
              />
            </div>
          )}
        </main>
      </div>

      {isMobile && !navRoute && (
        <Paper
          elevation={8}
          // Above the sheet's drawer (MUI's default 1200): the bar is how you switch sections, so
          // it has to stay reachable while the sheet is up.
          sx={{ position: 'fixed', left: 0, right: 0, bottom: 0, zIndex: (theme) => theme.zIndex.drawer + 2, borderTop: 1, borderColor: 'divider', pb: 'env(safe-area-inset-bottom, 0px)' }}
        >
          <BottomNavigation
            showLabels
            value={panelOpen ? (mobileTab || false) : false}
            onChange={(_, v) => selectMobileTab(v)}
          >
            <BottomNavigationAction
              value="plan"
              label={t('app.tabs.plan')}
              icon={
                <Badge color="primary" badgeContent={plan?.routes.length ?? 0} invisible={!(plan && plan.routes.length)}>
                  <SearchIcon />
                </Badge>
              }
            />
            <BottomNavigationAction value="longest" label={t('app.tabs.longest')} icon={<EmojiEventsIcon />} />
            <BottomNavigationAction value="links" label={t('app.tabs.links')} icon={<LinkIcon />} />
            <BottomNavigationAction value="closed" label={t('app.tabs.closed')} icon={<DoNotDisturbOnIcon />} />
            <BottomNavigationAction value="prefs" label={t('app.tabs.prefs')} icon={<TuneIcon />} />
          </BottomNavigation>
        </Paper>
      )}

      {popup && (() => {
        const isNotice = typeof popup !== 'string';
        const noticeText = typeof popup === 'string' ? popup : popup.text;
        const noticeTitle = typeof popup === 'string' ? undefined : popup.title;
        const noticeHref = typeof popup === 'string' ? undefined : popup.href;
        const noticeHrefLabel = typeof popup === 'string' ? undefined : popup.hrefLabel;
        const noticeTip = typeof popup === 'string' ? undefined : popup.tip;
        const structured = isNotice && (!!noticeTitle || !!noticeTip);
        return (
        <Snackbar
          open={!!popup}
          autoHideDuration={structured ? 15000 : noticeHref ? 13000 : 7000}
          onClose={(_, reason) => { if (reason !== 'clickaway') setPopup(null); }}
          anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
        >
          <Alert
            onClose={() => setPopup(null)}
            icon={structured ? false : undefined}
            severity={typeof popup === 'string' ? 'info' : (popup.severity ?? 'info')}
            variant="filled"
            sx={{ whiteSpace: 'pre-line', maxWidth: 'min(480px, calc(100vw - 24px))', boxShadow: 6 }}
          >
            {noticeTitle && <AlertTitle sx={{ fontWeight: 700, mb: 0.5 }}>{noticeTitle}</AlertTitle>}
            <Box sx={{ display: 'flex', gap: 1, alignItems: 'flex-start' }}>
              {structured && <InfoOutlinedIcon fontSize="small" sx={{ mt: '2px', flexShrink: 0, opacity: 0.9 }} />}
              <Box>
                {noticeText}
                {noticeHref && (
                  <Box sx={{ mt: 0.25 }}>
                    <Link
                      href={noticeHref}
                      target="_blank"
                      rel="noopener noreferrer"
                      onClick={() => {
                        // Let the anchor's target="_blank" open the link (each OS does its best:
                        // Android → separate Custom Tab, iOS PWA → in-app Safari view with "Done").
                        // Dismiss the notice on the next tick so closing it can't cancel navigation.
                        setTimeout(() => setPopup(null), 0);
                      }}
                      sx={{ color: 'inherit', fontWeight: 700, textDecorationColor: 'currentColor' }}
                    >
                      {noticeHrefLabel ?? t('app.openLink')}
                    </Link>
                  </Box>
                )}
              </Box>
            </Box>
            {noticeTip && (
              <Box sx={{ display: 'flex', gap: 1, alignItems: 'flex-start', mt: 1 }}>
                <LightbulbOutlinedIcon fontSize="small" sx={{ mt: '2px', flexShrink: 0, opacity: 0.9 }} />
                <Box>{noticeTip}</Box>
              </Box>
            )}
          </Alert>
        </Snackbar>
        );
      })()}

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
                  {t('app.sharePrompt.navigate')}
                </Button>
                <IconButton size="small" color="inherit" aria-label={t('common.dismiss')} onClick={() => setSharePrompt(false)}>
                  <CloseIcon fontSize="small" />
                </IconButton>
              </>
            }
            sx={{ boxShadow: 6, maxWidth: 'min(480px, calc(100vw - 24px))' }}
          >
            {t('app.sharePrompt.text')}
          </Alert>
        </Snackbar>
      )}
      <PreviewPrompt
        reason={previewPrompt}
        resortName={resortEntry?.shortName ?? resortEntry?.name ?? ''}
        onAccept={() => { setPreviewPrompt(null); setPreviewMode(true); }}
        onDecline={() => setPreviewPrompt(null)}
      />
    </div>
  );
}

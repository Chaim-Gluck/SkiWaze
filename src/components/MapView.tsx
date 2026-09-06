import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useLanguage } from '../i18n/language-context';
import maplibregl, { type StyleSpecification, type FilterSpecification } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import rtlTextPluginUrl from '@mapbox/mapbox-gl-rtl-text/mapbox-gl-rtl-text.min.js?url';
import Paper from '@mui/material/Paper';
import Box from '@mui/material/Box';
import ToggleButton from '@mui/material/ToggleButton';
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup';
import Checkbox from '@mui/material/Checkbox';
import FormControlLabel from '@mui/material/FormControlLabel';
import IconButton from '@mui/material/IconButton';
import Typography from '@mui/material/Typography';
import LayersIcon from '@mui/icons-material/Layers';
import CloseIcon from '@mui/icons-material/Close';
import { Legend } from './Legend';
import type { GeoFeatureCollection, ResortIndexEntry } from '../data/resortData';
import type { LivePosition } from '../hooks/useLiveLocation';
import { resortFlagCode, flagImageData } from '../utils/flags';

const BASE_STYLE: StyleSpecification = {
  version: 8,
  // fonts.openmaptiles.org stopped serving glyphs: it now answers every {fontstack}/{range}.pbf
  // with an HTML landing page under a 200, so MapLibre parsed HTML as protobuf and logged
  // "Unable to load glyph range … Error: Unimplemented type: 4" once per codepoint, then drew each
  // label with its local fallback instead of the real font. OpenFreeMap serves the same Noto stacks
  // as real application/x-protobuf, including the Hebrew range (1280-1535) the RTL locale needs.
  glyphs: 'https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf',
  sources: {
    osm: {
      type: 'raster',
      tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
      tileSize: 256,
      maxzoom: 19,
      attribution: '© OpenStreetMap contributors',
    },
    topo: {
      type: 'raster',
      tiles: [
        'https://a.tile.opentopomap.org/{z}/{x}/{y}.png',
        'https://b.tile.opentopomap.org/{z}/{x}/{y}.png',
        'https://c.tile.opentopomap.org/{z}/{x}/{y}.png',
      ],
      tileSize: 256,
      maxzoom: 17,
      attribution: '© OpenTopoMap (CC-BY-SA), © OpenStreetMap contributors',
    },
    satellite: {
      type: 'raster',
      tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'],
      tileSize: 256,
      maxzoom: 19,
      attribution: 'Imagery © Esri, Maxar, Earthstar Geographics',
    },
    dem: {
      type: 'raster-dem',
      tiles: ['https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png'],
      encoding: 'terrarium',
      tileSize: 256,
      maxzoom: 15,
      attribution: 'Elevation: Terrain Tiles (AWS Open Data)',
    },
  },
  layers: [
    { id: 'base-osm', type: 'raster', source: 'osm' },
    { id: 'base-topo', type: 'raster', source: 'topo', layout: { visibility: 'none' } },
    { id: 'base-satellite', type: 'raster', source: 'satellite', layout: { visibility: 'none' } },
    { id: 'hillshade', type: 'hillshade', source: 'dem', layout: { visibility: 'none' }, paint: { 'hillshade-exaggeration': 0.35 } },
  ],
};

export type BaseMap = 'standard' | 'topo' | 'satellite';

const EMPTY_FC: GeoFeatureCollection = { type: 'FeatureCollection', features: [] };

/**
 * Register MapLibre's RTL text plugin once per page. Without it, right-to-left scripts
 * (Hebrew, Arabic — e.g. Mount Hermon's labels) render reversed/disconnected. Deferred, so the
 * plugin is only fetched when RTL text actually appears. Bundled locally to stay offline-friendly.
 */
let rtlTextPluginRequested = false;
function ensureRtlTextPlugin(): void {
  if (rtlTextPluginRequested) return;
  rtlTextPluginRequested = true;
  try {
    const status = maplibregl.getRTLTextPluginStatus?.();
    if (status && status !== 'unavailable') return; // already set by another map instance
    void Promise.resolve(maplibregl.setRTLTextPlugin(rtlTextPluginUrl, true /* lazy */)).catch(() => {
      // Plugin load/register failure is non-fatal — labels just fall back to default shaping.
    });
  } catch {
    // setRTLTextPlugin throws if already registered — safe to ignore.
  }
}

const SLOPE_COLOR_EXPR: maplibregl.ExpressionSpecification = [
  'match',
  ['get', 'color'],
  'green', '#2e7d32',
  'blue', '#1565c0',
  'red', '#d32f2f',
  'black', '#111111',
  '#ff9800',
];

/** Highlight-filter for the currently selected step's leg-index range. */
function rangeFilter(range: [number, number] | null): maplibregl.FilterSpecification {
  if (!range) return ['==', ['get', 'stepIndex'], -1];
  return ['all', ['>=', ['get', 'stepIndex'], range[0]], ['<=', ['get', 'stepIndex'], range[1]]];
}

/** A distinct dot marker (not the teardrop nav pin) for custom-link endpoints. */
function linkDotEl(color: string): HTMLElement {
  const el = document.createElement('div');
  el.style.cssText = `width:16px;height:16px;border-radius:50%;background:${color};border:2px solid #fff;box-shadow:0 0 5px rgba(0,0,0,.55);cursor:pointer;`;
  return el;
}

/** Live-location "puck": a heading arrow (when a compass heading is known) or a plain dot. */
function userLocEl(): HTMLElement {
  const el = document.createElement('div');
  el.className = 'user-loc';
  el.innerHTML =
    '<svg class="ul-arrow" viewBox="0 0 24 24" width="38" height="38">' +
    '<path d="M12 2 L19 20 L12 16 L5 20 Z" fill="#1a73e8" stroke="#ffffff" stroke-width="1.6" stroke-linejoin="round"/></svg>' +
    '<span class="ul-dot"></span>';
  return el;
}

/** Bigger directional arrow used while actively navigating a route. */
function navArrowEl(): HTMLElement {
  const el = document.createElement('div');
  el.className = 'nav-arrow';
  el.innerHTML =
    '<svg viewBox="0 0 24 24" width="46" height="46">' +
    '<path d="M12 1 L20 21 L12 16.5 L4 21 Z" fill="#ff6d00" stroke="#ffffff" stroke-width="1.7" stroke-linejoin="round"/></svg>';
  return el;
}

/**
 * A small map-aligned direction arrow (white with a dark halo), pointing +x (east) at
 * rotation 0 — this is MapLibre's line-symbol convention (the icon's horizontal axis is
 * aligned to the line tangent), so a +x arrow follows the line direction. `double` draws
 * a two-headed arrow (shaft with a head at each end) for lifts that run both ways.
 * Returned as ImageData for map.addImage (rendered at pixelRatio 2).
 */
function arrowImage(double: boolean): ImageData {
  const S = 30;
  const c = document.createElement('canvas');
  c.width = S;
  c.height = S;
  const ctx = c.getContext('2d')!;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  const cy = S / 2;
  const paths = () => {
    if (double) {
      ctx.beginPath();
      ctx.moveTo(6, cy);
      ctx.lineTo(24, cy);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(11, cy - 5);
      ctx.lineTo(6, cy);
      ctx.lineTo(11, cy + 5);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(19, cy - 5);
      ctx.lineTo(24, cy);
      ctx.lineTo(19, cy + 5);
      ctx.stroke();
    } else {
      ctx.beginPath();
      ctx.moveTo(7, cy);
      ctx.lineTo(22, cy);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(16, cy - 6);
      ctx.lineTo(23, cy);
      ctx.lineTo(16, cy + 6);
      ctx.stroke();
    }
  };
  ctx.strokeStyle = 'rgba(15,20,28,0.92)';
  ctx.lineWidth = 7;
  paths();
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 3;
  paths();
  return ctx.getImageData(0, 0, S, S);
}

/**
 * Red ⊘ badge marking a closed run or lift.
 *
 * Drawn as a white disc with a red ring and a red slash-cross so it reads over snow, forest and
 * satellite alike — the arrow glyphs' dark-halo trick goes muddy in red. Repeated along the line
 * rather than placed once: a single badge mid-run disappears the moment you zoom past it, which is
 * the same defect that made `line-center` wrong for lift labels.
 */
function closedImage(): ImageData {
  const S = 28;
  const c = document.createElement('canvas');
  c.width = S;
  c.height = S;
  const ctx = c.getContext('2d')!;
  const cx = S / 2;
  const r = S / 2 - 3;
  ctx.beginPath();
  ctx.arc(cx, cx, r, 0, Math.PI * 2);
  ctx.fillStyle = '#ffffff';
  ctx.fill();
  ctx.lineWidth = 2.5;
  ctx.strokeStyle = '#d32f2f';
  ctx.stroke();
  ctx.lineCap = 'round';
  ctx.lineWidth = 3;
  const d = r * 0.5;
  ctx.beginPath();
  ctx.moveTo(cx - d, cx - d);
  ctx.lineTo(cx + d, cx + d);
  ctx.moveTo(cx + d, cx - d);
  ctx.lineTo(cx - d, cx + d);
  ctx.stroke();
  return ctx.getImageData(0, 0, S, S);
}

/** Lift types that realistically carry riders down as well as up (double-headed arrow). */
const TWO_WAY_LIFTS = ['gondola', 'cable_car', 'funicular', 'mixed_lift'];

/** Wrap a coordinate list as a single-LineString FeatureCollection. */
function lineFC(coords: [number, number][]): GeoFeatureCollection {
  if (coords.length < 2) return EMPTY_FC;
  return {
    type: 'FeatureCollection',
    features: [{ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: coords } }],
  } as unknown as GeoFeatureCollection;
}

/** Wrap several coordinate lists as a multi-feature LineString FeatureCollection. */
function linesFC(lines: readonly [number, number][][] | undefined): GeoFeatureCollection {
  const usable = (lines ?? []).filter((l) => l.length >= 2);
  if (!usable.length) return EMPTY_FC;
  return {
    type: 'FeatureCollection',
    features: usable.map((coords) => ({
      type: 'Feature',
      properties: {},
      geometry: { type: 'LineString', coordinates: coords },
    })),
  } as unknown as GeoFeatureCollection;
}

/** Geodesic circle polygon (ring of lon/lat) of `radiusM` metres for the accuracy halo. */
function circlePolygon(lon: number, lat: number, radiusM: number, n = 48): [number, number][] {
  const latR = radiusM / 110540;
  const lonR = radiusM / (111320 * Math.cos((lat * Math.PI) / 180) || 1e-6);
  const ring: [number, number][] = [];
  for (let i = 0; i <= n; i++) {
    const t = (i / n) * 2 * Math.PI;
    ring.push([lon + lonR * Math.cos(t), lat + latR * Math.sin(t)]);
  }
  return ring;
}

export interface LonLat {
  lon: number;
  lat: number;
}

export interface RouteFeatureCollection {
  type: 'FeatureCollection';
  features: {
    type: 'Feature';
    properties: { color: string | null; kind: string; stepIndex: number; synthetic: boolean; custom: boolean };
    geometry: { type: 'LineString'; coordinates: [number, number][] };
  }[];
}

/** Render payload for active navigation (snapped position + travelled/remaining geometry). */
export interface NavRender {
  lon: number;
  lat: number;
  bearing: number;
  traveled: [number, number][];
  remaining: [number, number][];
}

/** Below this zoom the map shows one dot+label per resort; at/above it, the selected resort's
 * full slopes/lifts. Keeps the "whole-of-Europe" overview cheap (only centres, always loaded). */
const RESORT_MARKER_MAXZOOM = 8.5;

/**
 * Global-vs-resort is an explicit MODE, not a proximity guess.
 *
 * Zooming out past `RESORT_MARKER_MAXZOOM` enters global view, and you stay there — flags visible
 * at every zoom, no resort drawn — until you pick a resort from the list or click its flag. The
 * earlier zoom-only behaviour looked broken from either side: zooming in past the threshold made a
 * non-selected resort's flag vanish with nothing in its place, and the A/B pins kept rendering at
 * a fixed pixel size over a resort that had shrunk to a few dozen pixels, so the pins were bigger
 * than the mountain.
 */
const GLOBAL_VIEW_LAYERS_HIDDEN = [
  'route-casing',
  'route-line',
  'route-synthetic',
  'route-custom',
  'route-step',
  'focus-line',
  'nav-traveled',
  'nav-remaining-casing',
  'nav-remaining',
];

/**
 * Below this zoom the A/B pins and custom-link dots are hidden. They are drawn at a fixed pixel
 * size, so once a 10 km resort is under ~150 px across a pin covers a meaningful part of it. This
 * has to sit ABOVE `RESORT_MARKER_MAXZOOM`: at 8.5 a resort is already only ~30 px wide, so gating
 * on the mode threshold alone would still leave a band where the pin dwarfs the mountain.
 * Deliberately NOT applied to the route line, which is thin and stays readable when zoomed out —
 * and hiding it could blank a long route that "fit to route" had just framed at a low zoom.
 */
const PIN_MINZOOM = 10.5;

/** Detailed slope/lift layers hidden below the marker zoom so dots cleanly replace them. */
const RESORT_DETAIL_LAYERS = [
  'areas-fill',
  'areas-outline',
  'connectors',
  'synthetic-links',
  'custom-links',
  'pistes-line',
  'pistes-offpiste-line',
  'lifts-line',
  'closed-line',
  'closed-badges',
];

/** Build the resort-marker GeoJSON; multi-country resorts are grouped by their first country. */
function resortsFC(resorts: ResortIndexEntry[], selectedId: string | undefined) {
  return {
    type: 'FeatureCollection' as const,
    features: resorts.map((r) => ({
      type: 'Feature' as const,
      geometry: { type: 'Point' as const, coordinates: [r.center.lon, r.center.lat] },
      properties: {
        id: r.id,
        // The flag label is 10-13 px map text that wraps at 10 ems, so a name spelling out the
        // sub-areas would stack into a multi-line block under a tiny flag and collide with its
        // neighbours. Use the compact label here; the dropdown still shows the full name.
        name: r.shortName ?? r.name,
        country: r.country.split('/')[0].trim(),
        code: resortFlagCode(r.country),
        selected: r.id === selectedId,
      },
    })),
  };
}

/** Register a flag icon for every distinct resort flag code (single or split), plus a fallback.
 * Idempotent, so it can run on load and whenever the resort list changes. */
function ensureResortFlagImages(map: maplibregl.Map, resorts: ResortIndexEntry[]): void {
  const codes = new Set<string>(['']);
  for (const r of resorts) codes.add(resortFlagCode(r.country));
  for (const code of codes) {
    const name = `flag-${code}`;
    if (!map.hasImage(name)) map.addImage(name, flagImageData(code), { pixelRatio: 2 });
  }
}

interface MapViewProps {
  center: LonLat;
  zoom: number;
  geo: GeoFeatureCollection | null;
  routeFC: RouteFeatureCollection | null;
  selectedRange: [number, number] | null;
  from: LonLat | null;
  to: LonLat | null;
  linkFrom: LonLat | null;
  linkTo: LonLat | null;
  focusGeometry: [number, number][] | null;
  /**
   * Geometry of every currently-closed run/lift, one polyline each. Drawn as a red dashed overlay
   * with repeating ⊘ badges so the map agrees with the closures the user has marked — without it,
   * closing a run changed the routing silently and the map still showed it as skiable.
   */
  closedGeometry?: [number, number][][];
  /**
   * True while the shown position comes from Preview mode rather than the GPS. Marks both markers
   * with a dashed ring — deliberately a SHAPE difference, not a recolour, so it survives greyscale
   * and colour-blindness and cannot be confused with the orange nav arrow.
   */
  positionSimulated?: boolean;
  /**
   * One-shot "frame this geometry" request. Unlike `focusGeometry` this only moves the camera —
   * it draws nothing and hides no markers — so a planned route can be framed while its own line
   * and the A/B pins stay as they are. `seq` makes each request distinct, so asking to frame the
   * same route twice (e.g. hitting Find route again) still re-fits after the user has panned away.
   */
  fitRequest: { coords: [number, number][]; seq: number } | null;
  onMapClick?: (p: LonLat) => void;
  userPosition: LivePosition | null;
  following: boolean;
  nav: NavRender | null;
  navHeadingUp: boolean;
  resorts?: ResortIndexEntry[];
  selectedResortId?: string;
  onSelectResort?: (id: string) => void;
  /** True while the map is in global (flags-only) view. Owned by App so the picker can leave it. */
  globalView?: boolean;
  /** Fired when the user zooms out past the threshold and the map enters global view. */
  onEnterGlobalView?: () => void;
  /** Bumped by App on every resort selection, so re-picking the current resort still re-frames. */
  resortFrameSeq?: number;
  /**
   * The router's off-piste opt-in. Only used to *follow* it: flipping the preference pushes the
   * off-piste layer to match, so opting in can never leave the router crossing terrain the map
   * isn't drawing. The user is still free to toggle the layer afterwards.
   */
  allowOffPiste?: boolean;
}

export function MapView({
  center, zoom, geo, routeFC, selectedRange, from, to, linkFrom, linkTo, focusGeometry, closedGeometry, fitRequest, onMapClick,
  userPosition, following, nav, navHeadingUp, resorts, selectedResortId, onSelectResort, positionSimulated = false,
  globalView = false, onEnterGlobalView, resortFrameSeq = 0, allowOffPiste = false,
}: MapViewProps) {
  const { t } = useTranslation();
  // The map shell is pinned LTR, so the panels that hold prose have to ask for the reading
  // direction back explicitly.
  const { rtl } = useLanguage();
  const dir = rtl ? 'rtl' : 'ltr';
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const [loaded, setLoaded] = useState(false);
  const fromMarker = useRef<maplibregl.Marker | null>(null);
  const toMarker = useRef<maplibregl.Marker | null>(null);
  const linkFromMarker = useRef<maplibregl.Marker | null>(null);
  const linkToMarker = useRef<maplibregl.Marker | null>(null);

  const [base, setBase] = useState<BaseMap>('standard');
  const [is3D, setIs3D] = useState(false);
  const [showPistes, setShowPistes] = useState(true);
  const [showLifts, setShowLifts] = useState(true);
  const [showAreas, setShowAreas] = useState(false);
  // Off-piste defaults OFF so the map agrees with the router, which refuses these edges unless
  // `allowOffPiste` is set. Drawing unpatrolled freeride terrain by default would advertise it.
  const [showOffPiste, setShowOffPiste] = useState(allowOffPiste);
  const [showLabels, setShowLabels] = useState(true);
  const [controlsOpen, setControlsOpen] = useState(false);

  // One-way sync: the preference drives the layer, never the reverse. Opting into off-piste routing
  // reveals the terrain (otherwise the route line crosses snow with no run drawn under it); opting
  // back out hides it again. Keyed on the preference alone, so toggling the layer by hand sticks.
  useEffect(() => {
    setShowOffPiste(allowOffPiste);
  }, [allowOffPiste]);

  // Live location + navigation are driven by props (shared hook lives in App).
  const userMarker = useRef<maplibregl.Marker | null>(null);
  const navMarker = useRef<maplibregl.Marker | null>(null);

  // Keep latest data/handlers in refs so the map's async 'load' handler never
  // captures stale values (this is what previously left overlays blank on first load).
  const geoRef = useRef(geo);
  geoRef.current = geo;
  const closedGeoRef = useRef(closedGeometry);
  closedGeoRef.current = closedGeometry;
  const routeRef = useRef(routeFC);
  routeRef.current = routeFC;
  const stepRef = useRef(selectedRange);
  stepRef.current = selectedRange;
  const clickCb = useRef(onMapClick);
  clickCb.current = onMapClick;
  // Latest follow inputs in refs, so the one-time map 'load' handlers can implement
  // "suspend auto-centering while the user interacts, then recentre after they stop".
  const followingRef = useRef(following);
  followingRef.current = following;
  const userPosRef = useRef(userPosition);
  userPosRef.current = userPosition;
  const navRef = useRef(nav);
  navRef.current = nav;
  const navHeadingUpRef = useRef(navHeadingUp);
  navHeadingUpRef.current = navHeadingUp;
  const resortsRef = useRef(resorts);
  resortsRef.current = resorts;
  const selectedResortIdRef = useRef(selectedResortId);
  selectedResortIdRef.current = selectedResortId;
  const onSelectResortRef = useRef(onSelectResort);
  onSelectResortRef.current = onSelectResort;
  const globalViewRef = useRef(globalView);
  globalViewRef.current = globalView;
  const onEnterGlobalViewRef = useRef(onEnterGlobalView);
  onEnterGlobalViewRef.current = onEnterGlobalView;
  /** Pins are hidden below PIN_MINZOOM; tracked as state so the marker effects can react. */
  const [pinsVisible, setPinsVisible] = useState(true);
  /**
   * True while OUR OWN camera animation is in flight. Without it, leaving global view deadlocks:
   * the re-framing easeTo starts at the zoomed-out level, the zoom handler sees a low zoom with
   * `globalView` already false, and flips straight back into global view.
   */
  const cameraGuard = useRef(false);
  const followSuspended = useRef(false);
  const idleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const wasFollowing = useRef(following);
  const wasNav = useRef<boolean>(!!nav);
  // Default camera zoom for follow-me mode, and how long after the last user gesture we
  // wait before recentring back onto the user.
  const FOLLOW_ZOOM = 15;
  const FOLLOW_RESUME_MS = 4000;

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;
    ensureRtlTextPlugin();
    const map = new maplibregl.Map({
      container: containerRef.current,
      style: BASE_STYLE,
      center: [center.lon, center.lat],
      zoom,
    });
    map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'bottom-right');
    mapRef.current = map;

    map.on('load', () => {
      map.addSource('pistes', { type: 'geojson', data: EMPTY_FC });
      map.addSource('areas', { type: 'geojson', data: EMPTY_FC });
      map.addSource('lifts', { type: 'geojson', data: EMPTY_FC });
      map.addSource('route', { type: 'geojson', data: EMPTY_FC });
      map.addSource('focus', { type: 'geojson', data: EMPTY_FC });

      // Area polygons (wide open bowls/aprons): translucent fill + outline, OFF by default.
      map.addLayer({
        id: 'areas-fill',
        type: 'fill',
        source: 'areas',
        layout: { visibility: 'none' },
        paint: { 'fill-color': SLOPE_COLOR_EXPR, 'fill-opacity': 0.25 },
      });
      map.addLayer({
        id: 'areas-outline',
        type: 'line',
        source: 'areas',
        layout: { visibility: 'none' },
        paint: { 'line-color': SLOPE_COLOR_EXPR, 'line-width': 1.5, 'line-opacity': 0.9 },
      });

      map.addLayer({
        id: 'connectors',
        type: 'line',
        source: 'pistes',
        filter: ['all', ['==', ['get', 'kind'], 'connector'], ['!=', ['get', 'synthetic'], true]],
        paint: { 'line-color': '#00bfa5', 'line-width': 2, 'line-dasharray': [2, 1.5], 'line-opacity': 0.85 },
      });
      // Synthetic (app-added bridges) links: clearly artificial dotted magenta.
      map.addLayer({
        id: 'synthetic-links',
        type: 'line',
        source: 'pistes',
        filter: ['all', ['==', ['get', 'synthetic'], true], ['!=', ['get', 'custom'], true]],
        paint: { 'line-color': '#e040fb', 'line-width': 3, 'line-dasharray': [1, 1], 'line-opacity': 1 },
      });
      // User custom links: dotted cyan (clearly yours).
      map.addLayer({
        id: 'custom-links',
        type: 'line',
        source: 'pistes',
        filter: ['==', ['get', 'custom'], true],
        paint: { 'line-color': '#00e5ff', 'line-width': 3, 'line-dasharray': [1.2, 1], 'line-opacity': 1 },
      });
      map.addLayer({
        id: 'pistes-line',
        type: 'line',
        source: 'pistes',
        filter: ['all', ['==', ['get', 'kind'], 'piste'], ['!=', ['get', 'offPiste'], true]],
        paint: { 'line-width': 2.5, 'line-color': SLOPE_COLOR_EXPR },
      });
      // Off-piste (piste:difficulty=freeride|extreme) gets its OWN layer purely so it can be
      // dashed: `line-dasharray` is not a data-driven property in MapLibre, so a single layer
      // cannot dash a subset. Drawn dashed and thinner in its slope colour, matching the
      // convention that anything a skier must not treat as ordinary marked terrain is visually
      // distinct. Solid black here was a safety bug - 310 km fleet-wide read as patrolled runs.
      map.addLayer({
        id: 'pistes-offpiste-line',
        type: 'line',
        source: 'pistes',
        filter: ['all', ['==', ['get', 'kind'], 'piste'], ['==', ['get', 'offPiste'], true]],
        layout: { visibility: 'none' },
        paint: {
          'line-width': 2,
          'line-color': SLOPE_COLOR_EXPR,
          'line-dasharray': [1.5, 2],
          'line-opacity': 0.85,
        },
      });
      map.addLayer({
        id: 'lifts-line',
        type: 'line',
        source: 'lifts',
        paint: { 'line-color': '#7b1fa2', 'line-width': 2, 'line-dasharray': [2, 1.5] },
      });

      // Route: translucent orange "selection" casing underneath, then the route in its
      // real slope colors on top, then a bright highlight for a clicked step.
      map.addLayer({
        id: 'route-casing',
        type: 'line',
        source: 'route',
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': '#ff6d00', 'line-width': 13, 'line-opacity': 0.72 },
      });
      map.addLayer({
        id: 'route-line',
        type: 'line',
        source: 'route',
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-width': 3,
          'line-color': [
            'case',
            ['==', ['get', 'kind'], 'lift'], '#7b1fa2',
            ['==', ['get', 'kind'], 'connector'], '#455a64',
            SLOPE_COLOR_EXPR,
          ],
        },
      });
      map.addLayer({
        id: 'route-synthetic',
        type: 'line',
        source: 'route',
        filter: ['all', ['==', ['get', 'synthetic'], true], ['!=', ['get', 'custom'], true]],
        layout: { 'line-cap': 'butt', 'line-join': 'round' },
        paint: { 'line-color': '#e040fb', 'line-width': 5, 'line-dasharray': [0.6, 1.2] },
      });
      map.addLayer({
        id: 'route-custom',
        type: 'line',
        source: 'route',
        filter: ['==', ['get', 'custom'], true],
        layout: { 'line-cap': 'butt', 'line-join': 'round' },
        paint: { 'line-color': '#00e5ff', 'line-width': 5, 'line-dasharray': [1, 1] },
      });
      map.addLayer({
        id: 'route-step',
        type: 'line',
        source: 'route',
        filter: ['==', ['get', 'stepIndex'], -1],
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': '#ffffff', 'line-width': 7, 'line-opacity': 0.95 },
      });
      // Focus highlight for a located custom link (bright yellow halo on top).
      map.addLayer({
        id: 'focus-line',
        type: 'line',
        source: 'focus',
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': '#ffeb3b', 'line-width': 8, 'line-opacity': 0.9 },
      });

      // Live-location accuracy halo (updated while tracking).
      map.addSource('user-accuracy', { type: 'geojson', data: EMPTY_FC });
      map.addLayer({
        id: 'user-accuracy-fill',
        type: 'fill',
        source: 'user-accuracy',
        paint: { 'fill-color': '#1a73e8', 'fill-opacity': 0.12 },
      });
      map.addLayer({
        id: 'user-accuracy-line',
        type: 'line',
        source: 'user-accuracy',
        paint: { 'line-color': '#1a73e8', 'line-opacity': 0.35, 'line-width': 1 },
      });

      // Navigation progress: travelled (dimmed) + remaining (bright) route split.
      map.addSource('nav-traveled', { type: 'geojson', data: EMPTY_FC });
      map.addSource('nav-remaining', { type: 'geojson', data: EMPTY_FC });
      map.addLayer({
        id: 'nav-traveled',
        type: 'line',
        source: 'nav-traveled',
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': '#7a8a99', 'line-width': 7, 'line-opacity': 0.8 },
      });
      map.addLayer({
        id: 'nav-remaining-casing',
        type: 'line',
        source: 'nav-remaining',
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': '#0b3d66', 'line-width': 11, 'line-opacity': 0.9 },
      });
      map.addLayer({
        id: 'nav-remaining',
        type: 'line',
        source: 'nav-remaining',
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': '#37b6ff', 'line-width': 6 },
      });

      // Piste/lift labels + direction arrows: only when zoomed in. Arrows and text are
      // SEPARATE symbol layers on purpose — an icon-only layer follows the line
      // (icon-rotation-alignment: map), while a text-only layer stays readable. Combining
      // them stops the icon from rotating to the line. Geometry is emitted downhill for
      // pistes and base→top for lifts, so a +x arrow (icon-keep-upright:false) points the
      // right way; two-way lifts get a double-headed arrow.
      if (!map.hasImage('ski-arrow')) map.addImage('ski-arrow', arrowImage(false), { pixelRatio: 2 });
      if (!map.hasImage('ski-arrow2')) map.addImage('ski-arrow2', arrowImage(true), { pixelRatio: 2 });

      map.addLayer({
        id: 'piste-arrows',
        type: 'symbol',
        source: 'pistes',
        filter: ['==', ['get', 'kind'], 'piste'],
        minzoom: 12,
        layout: {
          'symbol-placement': 'line',
          'symbol-spacing': 130,
          'icon-image': 'ski-arrow',
          'icon-rotation-alignment': 'map',
          'icon-pitch-alignment': 'map',
          'icon-keep-upright': false,
          'icon-size': ['interpolate', ['linear'], ['zoom'], 12, 0.5, 17, 0.85],
          'icon-allow-overlap': false,
        },
      });
      map.addLayer({
        id: 'lift-arrows',
        type: 'symbol',
        source: 'lifts',
        minzoom: 12,
        layout: {
          'symbol-placement': 'line',
          'symbol-spacing': 130,
          'icon-image': ['case', ['in', ['get', 'liftType'], ['literal', TWO_WAY_LIFTS]], 'ski-arrow2', 'ski-arrow'],
          'icon-rotation-alignment': 'map',
          'icon-pitch-alignment': 'map',
          'icon-keep-upright': false,
          'icon-size': ['interpolate', ['linear'], ['zoom'], 12, 0.55, 17, 0.95],
          'icon-allow-overlap': false,
        },
      });

      map.addLayer({
        id: 'piste-labels',
        type: 'symbol',
        source: 'pistes',
        filter: ['==', ['get', 'kind'], 'piste'],
        minzoom: 12,
        layout: {
          'symbol-placement': 'line',
          // Zoom-scaled, not a flat 450: at 450 px a phone (~390 px wide) gets fewer than one label
          // per screen width, so a run crossing the view often carried no name at all and the user
          // had to zoom OUT to identify it — the opposite of what zooming in is for. Collision still
          // culls the surplus, so a tighter spacing only buys more chances for one to survive.
          'symbol-spacing': ['interpolate', ['linear'], ['zoom'], 12, 400, 14, 300, 17, 200],
          'text-field': ['coalesce', ['get', 'ref'], ['get', 'name'], ''],
          'text-font': ['Noto Sans Bold'],
          'text-size': ['interpolate', ['linear'], ['zoom'], 12, 11, 17, 13],
          'text-max-angle': 40,
        },
        paint: {
          'text-color': '#0b1622',
          'text-halo-color': '#ffffff',
          'text-halo-width': 1.8,
        },
      });
      map.addLayer({
        id: 'lift-labels',
        type: 'symbol',
        source: 'lifts',
        minzoom: 12,
        layout: {
          // NOT 'line-center'. That places exactly ONE label per lift, at its midpoint, so zooming
          // in until the midpoint left the viewport made the lift's name vanish entirely — you had
          // to zoom out to read it. Repeating along the line keeps a name on screen at any zoom.
          'symbol-placement': 'line',
          'symbol-spacing': ['interpolate', ['linear'], ['zoom'], 12, 400, 14, 300, 17, 200],
          'text-field': ['coalesce', ['get', 'name'], ''],
          'text-font': ['Noto Sans Bold'],
          'text-size': ['interpolate', ['linear'], ['zoom'], 12, 11, 17, 13],
          'text-max-angle': 40,
        },
        paint: {
          'text-color': '#4a148c',
          'text-halo-color': '#ffffff',
          'text-halo-width': 1.8,
        },
      });

      // --- Closed runs and lifts. Marking something closed changed routing but drew nothing, so
      // the map contradicted the user's own input. Two layers: a red dashed overlay that shows the
      // whole extent of what is shut, and repeating ⊘ badges that survive any zoom level. Added
      // after the piste/lift layers so they sit on top of them, but before the route and navigation
      // layers, which must stay the most prominent thing on the map.
      if (!map.hasImage('closed-x')) map.addImage('closed-x', closedImage(), { pixelRatio: 2 });
      map.addSource('closed', { type: 'geojson', data: EMPTY_FC });
      map.addLayer({
        id: 'closed-line',
        type: 'line',
        source: 'closed',
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-color': '#d32f2f',
          'line-width': ['interpolate', ['linear'], ['zoom'], 12, 2.5, 17, 5],
          'line-opacity': 0.9,
          'line-dasharray': [1.5, 1.2],
        },
      });
      map.addLayer({
        id: 'closed-badges',
        type: 'symbol',
        source: 'closed',
        layout: {
          'symbol-placement': 'line',
          'symbol-spacing': ['interpolate', ['linear'], ['zoom'], 12, 160, 17, 110],
          'icon-image': 'closed-x',
          'icon-size': ['interpolate', ['linear'], ['zoom'], 12, 0.55, 17, 0.9],
          // A closure is a safety statement, so it must never be culled by label collision.
          'icon-allow-overlap': true,
          'icon-ignore-placement': true,
        },
      });

      // --- Resort overview markers: one dot + label per resort, shown only when zoomed out.
      // Uses just the resort centres (always loaded from the index), so the whole-Europe view is
      // cheap. Clicking a dot selects that resort (App reflects it in the picker and frames it).
      map.addSource('resorts', { type: 'geojson', data: EMPTY_FC });
      ensureResortFlagImages(map, resortsRef.current ?? []);
      // Highlight ring + faint tint behind the currently-selected resort's badge (added before the
      // flags so it sits underneath) — emphasises the active resort without resizing its marker.
      map.addLayer({
        id: 'resort-selected-glow',
        type: 'circle',
        source: 'resorts',
        maxzoom: RESORT_MARKER_MAXZOOM,
        filter: ['boolean', ['get', 'selected'], false],
        paint: {
          'circle-color': '#1565c0',
          'circle-opacity': 0.2,
          'circle-radius': ['interpolate', ['linear'], ['zoom'], 3, 10, 8, 16],
          'circle-stroke-color': '#1565c0',
          'circle-stroke-width': 3,
          'circle-stroke-opacity': 0.95,
        },
      });
      map.addLayer({
        id: 'resort-flags',
        type: 'symbol',
        source: 'resorts',
        maxzoom: RESORT_MARKER_MAXZOOM,
        layout: {
          'icon-image': ['concat', 'flag-', ['get', 'code']],
          'icon-size': ['interpolate', ['linear'], ['zoom'], 3, 0.55, 8, 0.9],
          'icon-allow-overlap': true,
          'text-field': ['get', 'name'],
          'text-font': ['Noto Sans Bold'],
          'text-size': ['interpolate', ['linear'], ['zoom'], 4, 10, 8, 13],
          'text-offset': [0, 1.0],
          'text-anchor': 'top',
          'text-optional': true,
        },
        paint: {
          'text-color': '#0b1622',
          'text-halo-color': '#ffffff',
          'text-halo-width': 1.8,
        },
      });
      // Hide the selected resort's detailed slopes/lifts below the marker zoom so the flags
      // cleanly replace them (labels/arrows are already minzoom 12).
      for (const id of RESORT_DETAIL_LAYERS) {
        if (map.getLayer(id)) map.setLayerZoomRange(id, RESORT_MARKER_MAXZOOM, 24);
      }
      map.on('click', 'resort-flags', (e) => {
        const id = e.features?.[0]?.properties?.id;
        if (id) onSelectResortRef.current?.(String(id));
      });
      map.on('mouseenter', 'resort-flags', () => { map.getCanvas().style.cursor = 'pointer'; });
      map.on('mouseleave', 'resort-flags', () => { map.getCanvas().style.cursor = ''; });

      // Apply whatever data is current now (fixes blank-on-first-load).
      (map.getSource('pistes') as maplibregl.GeoJSONSource).setData(splitPistes(geoRef.current) as never);
      (map.getSource('areas') as maplibregl.GeoJSONSource).setData(splitAreas(geoRef.current) as never);
      (map.getSource('lifts') as maplibregl.GeoJSONSource).setData(splitLifts(geoRef.current) as never);
      (map.getSource('resorts') as maplibregl.GeoJSONSource).setData(
        resortsFC(resortsRef.current ?? [], selectedResortIdRef.current) as never,
      );
      (map.getSource('route') as maplibregl.GeoJSONSource).setData((routeRef.current ?? EMPTY_FC) as never);
      (map.getSource('closed') as maplibregl.GeoJSONSource).setData(linesFC(closedGeoRef.current) as never);
      map.setFilter('route-step', rangeFilter(stepRef.current));
      setLoaded(true);
    });

    // In global view a click means "pick a resort", never "drop a pin" — the flag layer's own
    // handler deals with the former, so swallow everything else rather than placing an A/B point
    // at some arbitrary spot in Europe.
    map.on('click', (e) => {
      if (globalViewRef.current) return;
      clickCb.current?.({ lon: e.lngLat.lng, lat: e.lngLat.lat });
    });
    // Zoom drives BOTH mode transitions. Entering global view is one-way here: only an explicit
    // resort selection leaves it again, which is the whole point of making it a mode.
    const syncZoomMode = () => {
      const z = map.getZoom();
      setPinsVisible(z >= PIN_MINZOOM);
      if (z < RESORT_MARKER_MAXZOOM && !globalViewRef.current && !cameraGuard.current) {
        onEnterGlobalViewRef.current?.();
      }
    };
    map.on('zoom', syncZoomMode);
    map.on('moveend', () => { cameraGuard.current = false; });
    syncZoomMode();
    // While following, a user gesture (pan/pinch) should NOT drop follow mode. Instead we
    // suspend auto-centering, then recentre on the user once they stop interacting for a beat.
    // `originalEvent` is present only for real user gestures (absent for our own easeTo).
    const onUserGesture = (e: { originalEvent?: unknown }) => {
      if (!e.originalEvent || !followingRef.current) return;
      followSuspended.current = true;
      if (idleTimer.current) clearTimeout(idleTimer.current);
      idleTimer.current = setTimeout(() => {
        followSuspended.current = false;
        if (!followingRef.current) return;
        const nv = navRef.current;
        const p = userPosRef.current;
        const c: [number, number] | null = nv ? [nv.lon, nv.lat] : p ? [p.lon, p.lat] : null;
        if (!c) return;
        const opts: maplibregl.EaseToOptions = { center: c, duration: 600 };
        if (nv && navHeadingUpRef.current) {
          opts.bearing = nv.bearing;
          opts.pitch = 55;
          opts.zoom = 16;
        } else {
          opts.zoom = FOLLOW_ZOOM;
        }
        map.easeTo(opts);
      }, FOLLOW_RESUME_MS);
    };
    map.on('movestart', onUserGesture);
    map.on('zoomstart', onUserGesture);
    map.on('rotatestart', onUserGesture);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Data effects re-run once the map is loaded (loaded is a dependency).
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !loaded) return;
    (map.getSource('pistes') as maplibregl.GeoJSONSource | undefined)?.setData(splitPistes(geo) as never);
    (map.getSource('areas') as maplibregl.GeoJSONSource | undefined)?.setData(splitAreas(geo) as never);
    (map.getSource('lifts') as maplibregl.GeoJSONSource | undefined)?.setData(splitLifts(geo) as never);
  }, [geo, loaded]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !loaded) return;
    (map.getSource('closed') as maplibregl.GeoJSONSource | undefined)?.setData(linesFC(closedGeometry) as never);
  }, [closedGeometry, loaded]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !loaded) return;
    ensureResortFlagImages(map, resorts ?? []);
    (map.getSource('resorts') as maplibregl.GeoJSONSource | undefined)?.setData(
      resortsFC(resorts ?? [], selectedResortId) as never,
    );
  }, [resorts, selectedResortId, loaded]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !loaded) return;
    (map.getSource('route') as maplibregl.GeoJSONSource | undefined)?.setData((routeFC ?? EMPTY_FC) as never);
  }, [routeFC, loaded]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !loaded) return;
    map.setFilter('route-step', rangeFilter(selectedRange));
  }, [selectedRange, loaded]);

  // Locate/recenter a custom link when requested.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !loaded) return;
    const src = map.getSource('focus') as maplibregl.GeoJSONSource | undefined;
    if (!focusGeometry || focusGeometry.length < 2) {
      src?.setData(EMPTY_FC as never);
      return;
    }
    src?.setData({
      type: 'FeatureCollection',
      features: [{ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: focusGeometry } }],
    } as never);
    const b = new maplibregl.LngLatBounds(focusGeometry[0], focusGeometry[0]);
    for (const c of focusGeometry) b.extend(c);
    map.fitBounds(b, { padding: 140, maxZoom: 16.5, duration: 700 });
  }, [focusGeometry, loaded]);

  // Frame a route without drawing anything (see `fitRequest`). On desktop the sidebar is a flex
  // sibling so the map is never underneath it and even padding is right; on mobile the bottom nav
  // and the route preview card overlay the map, so leave extra room at the bottom.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !loaded || !fitRequest || fitRequest.coords.length < 2) return;
    const b = new maplibregl.LngLatBounds(fitRequest.coords[0], fitRequest.coords[0]);
    for (const c of fitRequest.coords) b.extend(c);
    const mobile = typeof window !== 'undefined' && window.innerWidth <= 820;
    const padding = mobile ? { top: 72, bottom: 200, left: 32, right: 32 } : 90;
    cameraGuard.current = true;
    map.fitBounds(b, { padding, maxZoom: 16.5, duration: 700 });
  }, [fitRequest, loaded]);

  useEffect(() => {
    // In global view the camera is the user's to drive; only a resort selection re-frames.
    if (globalView) return;
    cameraGuard.current = true;
    mapRef.current?.easeTo({ center: [center.lon, center.lat], zoom });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [center.lon, center.lat, zoom, globalView, resortFrameSeq]);

  // Global vs resort view: flags at every zoom and nothing else, or the resort as usual.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !loaded) return;
    for (const id of ['resort-flags', 'resort-selected-glow']) {
      if (map.getLayer(id)) map.setLayerZoomRange(id, 0, globalView ? 24 : RESORT_MARKER_MAXZOOM);
    }
    const hide = (id: string, hidden: boolean) => {
      if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', hidden ? 'none' : 'visible');
    };
    for (const id of GLOBAL_VIEW_LAYERS_HIDDEN) hide(id, globalView);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [globalView, loaded]);

  const markersVisible = pinsVisible && !globalView;

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (from && markersVisible) {
      if (!fromMarker.current) fromMarker.current = new maplibregl.Marker({ color: '#2e7d32' });
      fromMarker.current.setLngLat([from.lon, from.lat]).addTo(map);
    } else {
      fromMarker.current?.remove();
      fromMarker.current = null;
    }
    if (to && markersVisible) {
      if (!toMarker.current) toMarker.current = new maplibregl.Marker({ color: '#c62828' });
      toMarker.current.setLngLat([to.lon, to.lat]).addTo(map);
    } else {
      toMarker.current?.remove();
      toMarker.current = null;
    }
  }, [from, to, markersVisible]);

  // Custom-link endpoint markers (dots, distinct from the nav pins).
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (linkFrom && markersVisible) {
      if (!linkFromMarker.current) linkFromMarker.current = new maplibregl.Marker({ element: linkDotEl('#2e7d32') });
      linkFromMarker.current.setLngLat([linkFrom.lon, linkFrom.lat]).addTo(map);
    } else {
      linkFromMarker.current?.remove();
      linkFromMarker.current = null;
    }
    if (linkTo && markersVisible) {
      if (!linkToMarker.current) linkToMarker.current = new maplibregl.Marker({ element: linkDotEl('#c62828') });
      linkToMarker.current.setLngLat([linkTo.lon, linkTo.lat]).addTo(map);
    } else {
      linkToMarker.current?.remove();
      linkToMarker.current = null;
    }
  }, [linkFrom, linkTo, markersVisible]);

  // Base-map switch: toggle visibility of the three base raster layers.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !loaded) return;
    map.setLayoutProperty('base-osm', 'visibility', base === 'standard' ? 'visible' : 'none');
    map.setLayoutProperty('base-topo', 'visibility', base === 'topo' ? 'visible' : 'none');
    map.setLayoutProperty('base-satellite', 'visibility', base === 'satellite' ? 'visible' : 'none');
  }, [base, loaded]);

  // 3D terrain toggle: DEM-based terrain + hillshade + pitched camera + sky.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !loaded) return;
    if (is3D) {
      map.setTerrain({ source: 'dem', exaggeration: 1.4 });
      map.setLayoutProperty('hillshade', 'visibility', 'visible');
      try {
        (map as { setSky?: (s: unknown) => void }).setSky?.({
          'sky-color': '#a4c8ff',
          'sky-horizon-blend': 0.5,
          'horizon-color': '#eaf2fb',
          'horizon-fog-blend': 0.5,
          'fog-color': '#f3f7fc',
          'fog-ground-blend': 0.7,
        });
      } catch { /* sky is cosmetic */ }
      map.easeTo({ pitch: 62, duration: 600 });
    } else {
      map.setTerrain(null);
      map.setLayoutProperty('hillshade', 'visibility', 'none');
      map.easeTo({ pitch: 0, duration: 600 });
    }
  }, [is3D, loaded]);

  // Overlay toggles: pistes/connectors and lifts. This effect is the single owner of visibility for
  // the resort layers, so global view is folded in here rather than fighting it from elsewhere.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !loaded) return;
    const vis = (on: boolean) => (on && !globalView ? 'visible' : 'none');
    const pisteLayers = ['pistes-line', 'connectors', 'synthetic-links', 'custom-links'];
    for (const l of pisteLayers) map.setLayoutProperty(l, 'visibility', vis(showPistes));
    map.setLayoutProperty('pistes-offpiste-line', 'visibility', vis(showPistes && showOffPiste));
    map.setLayoutProperty('lifts-line', 'visibility', vis(showLifts));
    for (const l of ['areas-fill', 'areas-outline']) map.setLayoutProperty(l, 'visibility', vis(showAreas));
    // Labels and arrows come off the same source, so hiding only the LINE would leave an off-piste
    // run's name and direction arrows floating over empty snow. Their filter has to follow the
    // toggle too.
    const pisteSymbolFilter: FilterSpecification = showOffPiste
      ? ['==', ['get', 'kind'], 'piste']
      : ['all', ['==', ['get', 'kind'], 'piste'], ['!=', ['get', 'offPiste'], true]];
    map.setFilter('piste-labels', pisteSymbolFilter);
    map.setFilter('piste-arrows', pisteSymbolFilter);
    const pisteLabelsOn = vis(showLabels && showPistes);
    const liftLabelsOn = vis(showLabels && showLifts);
    map.setLayoutProperty('piste-labels', 'visibility', pisteLabelsOn);
    map.setLayoutProperty('piste-arrows', 'visibility', pisteLabelsOn);
    map.setLayoutProperty('lift-labels', 'visibility', liftLabelsOn);
    map.setLayoutProperty('lift-arrows', 'visibility', liftLabelsOn);
  }, [showPistes, showLifts, showAreas, showLabels, showOffPiste, globalView, loaded]);

  // Live-location puck from the shared position stream.
  //
  // Suppressed while navigating: the nav arrow already represents the user, snapped to the route,
  // so drawing the raw puck too gives two arrows a few metres apart (and two accuracy halos) for
  // one skier. Every turn-by-turn app shows exactly one.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !loaded) return;
    const acc = map.getSource('user-accuracy') as maplibregl.GeoJSONSource | undefined;
    if (!userPosition || nav) {
      userMarker.current?.remove();
      userMarker.current = null;
      acc?.setData(EMPTY_FC as never);
      return;
    }
    if (!userMarker.current) {
      userMarker.current = new maplibregl.Marker({ element: userLocEl(), rotationAlignment: 'map' });
    }
    const el = userMarker.current.getElement();
    const hasHeading = userPosition.heading != null;
    el.classList.toggle('has-heading', hasHeading);
    el.classList.toggle('simulated', positionSimulated);
    if (hasHeading) userMarker.current.setRotation(userPosition.heading as number);
    userMarker.current.setLngLat([userPosition.lon, userPosition.lat]).addTo(map);
    if (acc && userPosition.accuracy) {
      acc.setData({
        type: 'Feature',
        properties: {},
        geometry: { type: 'Polygon', coordinates: [circlePolygon(userPosition.lon, userPosition.lat, userPosition.accuracy)] },
      } as never);
    }
  }, [userPosition, loaded, positionSimulated, nav]);

  // Navigation render: travelled/remaining split + a nav arrow at the snapped point.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !loaded) return;
    const trav = map.getSource('nav-traveled') as maplibregl.GeoJSONSource | undefined;
    const rem = map.getSource('nav-remaining') as maplibregl.GeoJSONSource | undefined;
    const routeLayers = ['route-casing', 'route-line', 'route-synthetic', 'route-custom', 'route-step'];
    if (!nav) {
      trav?.setData(EMPTY_FC as never);
      rem?.setData(EMPTY_FC as never);
      navMarker.current?.remove();
      navMarker.current = null;
      for (const l of routeLayers) if (map.getLayer(l)) map.setLayoutProperty(l, 'visibility', 'visible');
      if (map.getPitch() > 0 && !is3D) map.easeTo({ pitch: 0, bearing: 0, duration: 400 });
      return;
    }
    for (const l of routeLayers) if (map.getLayer(l)) map.setLayoutProperty(l, 'visibility', 'none');
    trav?.setData(lineFC(nav.traveled) as never);
    rem?.setData(lineFC(nav.remaining) as never);
    if (!navMarker.current) navMarker.current = new maplibregl.Marker({ element: navArrowEl(), rotationAlignment: 'map' });
    navMarker.current.getElement().classList.toggle('simulated', positionSimulated);
    navMarker.current.setRotation(nav.bearing);
    navMarker.current.setLngLat([nav.lon, nav.lat]).addTo(map);
  }, [nav, loaded, is3D, positionSimulated]);

  // Follow-me camera (heading-up + tilted while navigating).
  useEffect(() => {
    const map = mapRef.current;
    const starting = following && !wasFollowing.current;
    wasFollowing.current = following;
    const endingNav = !nav && wasNav.current;
    wasNav.current = !!nav;
    if (!map || !loaded || !following) return;
    if (followSuspended.current) return; // user is interacting; recentre happens after they stop
    const center: [number, number] | null = nav
      ? [nav.lon, nav.lat]
      : userPosition
        ? [userPosition.lon, userPosition.lat]
        : null;
    if (!center) return;
    const opts: maplibregl.EaseToOptions = { center, duration: 600 };
    if (nav && navHeadingUp) {
      opts.bearing = nav.bearing;
      opts.pitch = 55;
      if (map.getZoom() < 15) opts.zoom = 16;
    } else if (endingNav && !is3D) {
      // Leaving navigation: flatten the heading-up tilt (our recentre easeTo would otherwise
      // cancel the nav-cleanup pitch reset and keep the map tilted).
      opts.pitch = 0;
      opts.bearing = 0;
    } else if (starting && map.getZoom() < FOLLOW_ZOOM) {
      // On starting to follow, zoom in to the default follow level (never zoom out).
      opts.zoom = FOLLOW_ZOOM;
    }
    map.easeTo(opts);
  }, [userPosition, nav, following, navHeadingUp, loaded, is3D]);

  return (
    <div className="map-shell">
      <div ref={containerRef} className="map-canvas" />
      {/* Positioned with an inline style, not `sx`: the RTL emotion plugin rewrites left/right in
          generated CSS whatever the container's dir is, and these controls must stay put in Hebrew
          — MapLibre's own controls (its stylesheet, which the plugin never sees) do.

          While navigating on a PHONE they drop below the manoeuvre card, which is centred and nearly
          full width there and would otherwise sit on top of them. The offset comes from
          `--nav-banner-h`, published by NavOverlay from a ResizeObserver rather than guessed: the
          card is one to three lines depending on how long the run's name is, so any fixed number is
          wrong two-thirds of the time. The variable is the card's BOTTOM EDGE in this same
          coordinate frame, so the 6px is only the gap - matching the simulation chip's own top
          margin puts these level with it rather than below the whole overlay. On desktop they do not
          move at all: there the card is capped narrower and inset past this column, so it never
          reaches them and displacing them would be pure loss.

          `top` is safe in `sx` (the RTL plugin rewrites the inline axis only); `left` is not. */}
      <Box
        style={{ position: 'absolute', left: 10 }}
        sx={{
        top: nav ? 'calc(var(--nav-banner-h, 0px) + 6px)' : '10px',
        '@media (min-width: 821px)': { top: '10px' },
        zIndex: 5, display: 'flex', flexDirection: 'column', gap: 1, alignItems: 'flex-start',
        // Stop short of the map's right-hand Fab column instead of running under it. The locate Fab
        // is size="small" (40px) at right:12, so it owns the last 52px; 10px left inset + 10px gap
        // gives 72. Without this the expanded Layers panel grows until it collides with the Fab on a
        // phone -- it wraps to three rows once there are five layer checkboxes. The Legend below is
        // capped at 240px of its own, so it is unaffected at any phone width.
        maxWidth: 'calc(100% - 72px)',
      }}>
      <Paper
        elevation={3}
        dir={dir}
        sx={{
          p: 0.75, borderRadius: 2,
          display: 'flex', flexDirection: 'column', gap: 0.75, bgcolor: 'var(--glass)',
          backdropFilter: 'blur(3px)',
        }}
      >
        {!controlsOpen ? (
          <IconButton size="small" onClick={() => setControlsOpen(true)} aria-label={t('layers.show')} title={t('layers.title')}>
            <LayersIcon fontSize="small" />
          </IconButton>
        ) : (
          <>
            {/* The header is pinned LTR so the close X lands on the panel's top-left corner — the
                exact spot the collapsed icon occupied — in every language. Opening and closing is
                then one thumb position rather than two. */}
            <Box dir="ltr" sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 0.5 }}>
              <IconButton size="small" onClick={() => setControlsOpen(false)} aria-label={t('layers.collapse')} sx={{ p: 0.25 }}>
                <CloseIcon fontSize="small" />
              </IconButton>
              <Typography dir={dir} variant="caption" sx={{ fontWeight: 700, display: 'flex', alignItems: 'center', gap: 0.5 }}>
                <LayersIcon fontSize="small" /> {t('layers.title')}
              </Typography>
            </Box>
            {/* Two separate exclusive groups sharing one row: the base map is a tile source, 2D/3D is
                terrain relief. Merging them into one ToggleButtonGroup would make 3D deselect the
                base map. Pushed to opposite ends, which also reads as "different question" — the
                panel is dir-aware, so in RTL they swap sides on their own. The row wraps if a
                translation ever outgrows the panel's width cap, and space-between then collapses to
                a normal gap. */}
            <Box sx={{ width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 0.75 }}>
              <ToggleButtonGroup exclusive size="small" value={base} onChange={(_, v) => v && setBase(v)}>
                <ToggleButton value="standard" sx={{ px: 1.25, py: 0.25 }}>{t('layers.base.standard')}</ToggleButton>
                <ToggleButton value="topo" sx={{ px: 1.25, py: 0.25 }}>{t('layers.base.topo')}</ToggleButton>
                <ToggleButton value="satellite" sx={{ px: 1.25, py: 0.25 }}>{t('layers.base.satellite')}</ToggleButton>
              </ToggleButtonGroup>
              {/* Naming both states beats a lone "3D" toggle, whose meaning depends on whether the
                  user can tell it is selected. "2D"/"3D" read the same in every language. */}
              <ToggleButtonGroup
                exclusive
                size="small"
                value={is3D ? '3d' : '2d'}
                onChange={(_, v) => v && setIs3D(v === '3d')}
                title={t('layers.toggle3d')}
              >
                <ToggleButton value="2d" sx={{ px: 1.25, py: 0.25 }}>2D</ToggleButton>
                <ToggleButton value="3d" sx={{ px: 1.25, py: 0.25 }}>3D</ToggleButton>
              </ToggleButtonGroup>
            </Box>
            <Box sx={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 0.25 }}>
              {([['pistes', showPistes, setShowPistes], ['lifts', showLifts, setShowLifts], ['areas', showAreas, setShowAreas], ['offPiste', showOffPiste, setShowOffPiste], ['labels', showLabels, setShowLabels]] as const).map(
                ([key, checked, setter]) => (
                  <FormControlLabel
                    key={key}
                    sx={{ m: 0, mr: 0.5 }}
                    control={<Checkbox size="small" sx={{ p: 0.25 }} checked={checked} onChange={(e) => setter(e.target.checked)} />}
                    label={t(`layers.${key}`)}
                    slotProps={{ typography: { variant: 'caption' } }}
                  />
                ),
              )}
            </Box>
          </>
        )}
      </Paper>
      <Legend />
      </Box>
    </div>
  );
}

function splitPistes(geo: GeoFeatureCollection | null): GeoFeatureCollection {
  if (!geo) return EMPTY_FC;
  const pistesEtc = geo.features.filter((f) => f.properties.kind !== 'lift' && f.properties.kind !== 'area');
  return { type: 'FeatureCollection', features: dedupePistes(pistesEtc) };
}
function splitAreas(geo: GeoFeatureCollection | null): GeoFeatureCollection {
  if (!geo) return EMPTY_FC;
  return { type: 'FeatureCollection', features: geo.features.filter((f) => f.properties.kind === 'area') };
}

type PisteFeature = GeoFeatureCollection['features'][number];

/**
 * OSM over-maps many runs as several near-parallel ways a few metres apart, and our
 * pipeline further splits each run into `piste` (steep) + `connector` (flat) edges —
 * so a single slope shows as 2–3 stacked lines. This collapses that visual noise for
 * RENDERING ONLY (the routing graph is untouched), in two passes:
 *   1. Geometric: pistes + connectors are de-duped together, grouped by colour; a line
 *      whose path is ≥70% covered by an already-kept same-colour line within ~15m is
 *      dropped. Pistes go first (longest first) so the colour-coded slope line survives.
 *   2. Named-shadow: OSM traces many runs as extra UNNAMED ways 20–40m off a named run.
 *      A remaining unnamed line whose path is ≥60% within ~30m of a same-colour NAMED
 *      survivor is dropped (the named line is the "real" one).
 * Named runs and standalone unnamed runs (no twin) are always kept; custom links are
 * never touched.
 */
function isNamedRun(f: PisteFeature): boolean {
  const n = f.properties.name;
  return !!n && n !== 'Custom link' && n.trim() !== '';
}

function dedupePistes(features: PisteFeature[]): PisteFeature[] {
  const CELL = 8; // metres — grid cell; a 3×3 neighbour check merges lines within ~15m
  const occupied = new Set<string>();
  const order = features
    .map((f, i) => {
      const kind = f.properties.kind;
      const candidate = (kind === 'piste' || kind === 'connector') && f.properties.custom !== true;
      return { i, pri: kind === 'piste' ? 1 : 0, len: candidate ? approxLengthM(f) : -1 };
    })
    .filter((x) => x.len >= 0)
    .sort((a, b) => b.pri - a.pri || b.len - a.len);
  const dropped = new Set<number>();
  for (const { i } of order) {
    const f = features[i];
    const color = String(f.properties.color ?? '?');
    const cells = sampleCells(f, CELL);
    if (cells.length === 0) continue;
    let hit = 0;
    for (const [gx, gy] of cells) if (neighbourOccupied(occupied, color, gx, gy)) hit++;
    if (hit / cells.length >= 0.7) { dropped.add(i); continue; }
    for (const [gx, gy] of cells) occupied.add(`${color}:${gx}:${gy}`);
  }

  // Pass 2: drop surviving UNNAMED lines that closely shadow a same-colour NAMED survivor.
  const NAMED_CELL = 15; // ~30m tolerance with the 3×3 neighbour check
  const namedCells = new Set<string>();
  for (let i = 0; i < features.length; i++) {
    if (dropped.has(i)) continue;
    const f = features[i];
    const kind = f.properties.kind;
    if ((kind !== 'piste' && kind !== 'connector') || !isNamedRun(f)) continue;
    const color = String(f.properties.color ?? '?');
    for (const [gx, gy] of sampleCells(f, NAMED_CELL)) namedCells.add(`${color}:${gx}:${gy}`);
  }
  for (let i = 0; i < features.length; i++) {
    if (dropped.has(i)) continue;
    const f = features[i];
    const kind = f.properties.kind;
    if ((kind !== 'piste' && kind !== 'connector') || f.properties.custom === true || isNamedRun(f)) continue;
    const color = String(f.properties.color ?? '?');
    const cells = sampleCells(f, NAMED_CELL);
    if (cells.length === 0) continue;
    let hit = 0;
    for (const [gx, gy] of cells) if (neighbourOccupied(namedCells, color, gx, gy)) hit++;
    if (hit / cells.length >= 0.6) dropped.add(i);
  }

  return dropped.size ? features.filter((_, i) => !dropped.has(i)) : features;
}

function approxLengthM(f: PisteFeature): number {
  const c = f.geometry.coordinates as [number, number][];
  let m = 0;
  for (let s = 0; s < c.length - 1; s++) {
    const dx = (c[s + 1][0] - c[s][0]) * Math.cos((c[s][1] * Math.PI) / 180) * 111320;
    const dy = (c[s + 1][1] - c[s][1]) * 110540;
    m += Math.hypot(dx, dy);
  }
  return m;
}

function sampleCells(f: PisteFeature, cell: number): [number, number][] {
  const c = f.geometry.coordinates as [number, number][];
  const cells: [number, number][] = [];
  const seen = new Set<string>();
  const push = (lon: number, lat: number) => {
    const gx = Math.round((lon * Math.cos((lat * Math.PI) / 180) * 111320) / cell);
    const gy = Math.round((lat * 110540) / cell);
    const k = `${gx},${gy}`;
    if (!seen.has(k)) { seen.add(k); cells.push([gx, gy]); }
  };
  for (let s = 0; s < c.length - 1; s++) {
    const [lon1, lat1] = c[s];
    const [lon2, lat2] = c[s + 1];
    const dx = (lon2 - lon1) * Math.cos((lat1 * Math.PI) / 180) * 111320;
    const dy = (lat2 - lat1) * 110540;
    const steps = Math.max(1, Math.ceil(Math.hypot(dx, dy) / cell));
    for (let t = 0; t <= steps; t++) {
      const u = t / steps;
      push(lon1 + (lon2 - lon1) * u, lat1 + (lat2 - lat1) * u);
    }
  }
  return cells;
}

function neighbourOccupied(occ: Set<string>, color: string, gx: number, gy: number): boolean {
  for (let dx = -1; dx <= 1; dx++)
    for (let dy = -1; dy <= 1; dy++)
      if (occ.has(`${color}:${gx + dx}:${gy + dy}`)) return true;
  return false;
}
function splitLifts(geo: GeoFeatureCollection | null): GeoFeatureCollection {
  if (!geo) return EMPTY_FC;
  return { type: 'FeatureCollection', features: geo.features.filter((f) => f.properties.kind === 'lift') };
}

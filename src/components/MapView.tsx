import { useEffect, useRef, useState } from 'react';
import maplibregl, { type StyleSpecification } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import type { GeoFeatureCollection } from '../data/resortData';

const BASE_STYLE: StyleSpecification = {
  version: 8,
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
  onMapClick?: (p: LonLat) => void;
}

export function MapView({ center, zoom, geo, routeFC, selectedRange, from, to, linkFrom, linkTo, focusGeometry, onMapClick }: MapViewProps) {
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

  // Keep latest data/handlers in refs so the map's async 'load' handler never
  // captures stale values (this is what previously left overlays blank on first load).
  const geoRef = useRef(geo);
  geoRef.current = geo;
  const routeRef = useRef(routeFC);
  routeRef.current = routeFC;
  const stepRef = useRef(selectedRange);
  stepRef.current = selectedRange;
  const clickCb = useRef(onMapClick);
  clickCb.current = onMapClick;

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;
    const map = new maplibregl.Map({
      container: containerRef.current,
      style: BASE_STYLE,
      center: [center.lon, center.lat],
      zoom,
    });
    map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'top-right');
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
        filter: ['==', ['get', 'kind'], 'piste'],
        paint: { 'line-width': 2.5, 'line-color': SLOPE_COLOR_EXPR },
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

      // Apply whatever data is current now (fixes blank-on-first-load).
      (map.getSource('pistes') as maplibregl.GeoJSONSource).setData(splitPistes(geoRef.current) as never);
      (map.getSource('areas') as maplibregl.GeoJSONSource).setData(splitAreas(geoRef.current) as never);
      (map.getSource('lifts') as maplibregl.GeoJSONSource).setData(splitLifts(geoRef.current) as never);
      (map.getSource('route') as maplibregl.GeoJSONSource).setData((routeRef.current ?? EMPTY_FC) as never);
      map.setFilter('route-step', rangeFilter(stepRef.current));
      setLoaded(true);
    });

    map.on('click', (e) => clickCb.current?.({ lon: e.lngLat.lng, lat: e.lngLat.lat }));
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

  useEffect(() => {
    mapRef.current?.easeTo({ center: [center.lon, center.lat], zoom });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [center.lon, center.lat, zoom]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (from) {
      if (!fromMarker.current) fromMarker.current = new maplibregl.Marker({ color: '#2e7d32' });
      fromMarker.current.setLngLat([from.lon, from.lat]).addTo(map);
    } else {
      fromMarker.current?.remove();
      fromMarker.current = null;
    }
    if (to) {
      if (!toMarker.current) toMarker.current = new maplibregl.Marker({ color: '#c62828' });
      toMarker.current.setLngLat([to.lon, to.lat]).addTo(map);
    } else {
      toMarker.current?.remove();
      toMarker.current = null;
    }
  }, [from, to]);

  // Custom-link endpoint markers (dots, distinct from the nav pins).
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (linkFrom) {
      if (!linkFromMarker.current) linkFromMarker.current = new maplibregl.Marker({ element: linkDotEl('#2e7d32') });
      linkFromMarker.current.setLngLat([linkFrom.lon, linkFrom.lat]).addTo(map);
    } else {
      linkFromMarker.current?.remove();
      linkFromMarker.current = null;
    }
    if (linkTo) {
      if (!linkToMarker.current) linkToMarker.current = new maplibregl.Marker({ element: linkDotEl('#c62828') });
      linkToMarker.current.setLngLat([linkTo.lon, linkTo.lat]).addTo(map);
    } else {
      linkToMarker.current?.remove();
      linkToMarker.current = null;
    }
  }, [linkFrom, linkTo]);

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

  // Overlay toggles: pistes/connectors and lifts.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !loaded) return;
    const pisteLayers = ['pistes-line', 'connectors', 'synthetic-links', 'custom-links'];
    for (const l of pisteLayers) map.setLayoutProperty(l, 'visibility', showPistes ? 'visible' : 'none');
    map.setLayoutProperty('lifts-line', 'visibility', showLifts ? 'visible' : 'none');
    for (const l of ['areas-fill', 'areas-outline']) map.setLayoutProperty(l, 'visibility', showAreas ? 'visible' : 'none');
  }, [showPistes, showLifts, showAreas, loaded]);

  return (
    <div className="map-shell">
      <div ref={containerRef} className="map-canvas" />
      <div className="map-controls">
        <div className="mc-group">
          <button type="button" className={base === 'standard' ? 'mc-btn active' : 'mc-btn'} onClick={() => setBase('standard')}>Map</button>
          <button type="button" className={base === 'topo' ? 'mc-btn active' : 'mc-btn'} onClick={() => setBase('topo')}>Topo</button>
          <button type="button" className={base === 'satellite' ? 'mc-btn active' : 'mc-btn'} onClick={() => setBase('satellite')}>Sat</button>
        </div>
        <div className="mc-group">
          <button type="button" className={is3D ? 'mc-btn active' : 'mc-btn'} onClick={() => setIs3D((v) => !v)} title="Toggle 3D terrain">
            {is3D ? '3D ✓' : '3D'}
          </button>
          <label className="mc-check"><input type="checkbox" checked={showPistes} onChange={(e) => setShowPistes(e.target.checked)} /> Pistes</label>
          <label className="mc-check"><input type="checkbox" checked={showLifts} onChange={(e) => setShowLifts(e.target.checked)} /> Lifts</label>
          <label className="mc-check"><input type="checkbox" checked={showAreas} onChange={(e) => setShowAreas(e.target.checked)} /> Areas</label>
        </div>
      </div>
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

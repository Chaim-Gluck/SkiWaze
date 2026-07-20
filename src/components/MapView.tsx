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
      attribution: '© OpenStreetMap contributors',
    },
  },
  layers: [{ id: 'osm', type: 'raster', source: 'osm' }],
};

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
  selectedStep: number | null;
  from: LonLat | null;
  to: LonLat | null;
  focusGeometry: [number, number][] | null;
  onMapClick?: (p: LonLat) => void;
}

export function MapView({ center, zoom, geo, routeFC, selectedStep, from, to, focusGeometry, onMapClick }: MapViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const [loaded, setLoaded] = useState(false);
  const fromMarker = useRef<maplibregl.Marker | null>(null);
  const toMarker = useRef<maplibregl.Marker | null>(null);

  // Keep latest data/handlers in refs so the map's async 'load' handler never
  // captures stale values (this is what previously left overlays blank on first load).
  const geoRef = useRef(geo);
  geoRef.current = geo;
  const routeRef = useRef(routeFC);
  routeRef.current = routeFC;
  const stepRef = useRef(selectedStep);
  stepRef.current = selectedStep;
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
      map.addSource('lifts', { type: 'geojson', data: EMPTY_FC });
      map.addSource('route', { type: 'geojson', data: EMPTY_FC });
      map.addSource('focus', { type: 'geojson', data: EMPTY_FC });

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
        paint: { 'line-color': '#ff9800', 'line-width': 10, 'line-opacity': 0.4 },
      });
      map.addLayer({
        id: 'route-line',
        type: 'line',
        source: 'route',
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-width': 4,
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
      (map.getSource('lifts') as maplibregl.GeoJSONSource).setData(splitLifts(geoRef.current) as never);
      (map.getSource('route') as maplibregl.GeoJSONSource).setData((routeRef.current ?? EMPTY_FC) as never);
      map.setFilter('route-step', ['==', ['get', 'stepIndex'], stepRef.current ?? -1]);
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
    map.setFilter('route-step', ['==', ['get', 'stepIndex'], selectedStep ?? -1]);
  }, [selectedStep, loaded]);

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

  return <div ref={containerRef} style={{ width: '100%', height: '100%' }} />;
}

function splitPistes(geo: GeoFeatureCollection | null): GeoFeatureCollection {
  if (!geo) return EMPTY_FC;
  return { type: 'FeatureCollection', features: geo.features.filter((f) => f.properties.kind !== 'lift') };
}
function splitLifts(geo: GeoFeatureCollection | null): GeoFeatureCollection {
  if (!geo) return EMPTY_FC;
  return { type: 'FeatureCollection', features: geo.features.filter((f) => f.properties.kind === 'lift') };
}

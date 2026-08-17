import type { Resort } from '../types/domain';

/**
 * The five initial resorts. Bounding boxes are approximate and used both for the
 * Overpass extraction (pipeline) and the map default view. Madonna di Campiglio is
 * the default fallback when no geolocation is available.
 */
export const RESORTS: Resort[] = [
  {
    id: 'madonna-di-campiglio',
    name: 'Madonna di Campiglio',
    country: 'Italy',
    center: { lon: 10.826, lat: 46.23 },
    bbox: { minLon: 10.72, minLat: 46.16, maxLon: 10.94, maxLat: 46.32 },
    defaultZoom: 12.5,
    timezone: 'Europe/Rome',
  },
  {
    id: 'cervinia-zermatt',
    name: 'Cervinia\u2013Zermatt',
    country: 'Italy / Switzerland',
    center: { lon: 7.69, lat: 45.97 },
    bbox: { minLon: 7.55, minLat: 45.87, maxLon: 7.82, maxLat: 46.05 },
    defaultZoom: 12,
    timezone: 'Europe/Zurich',
  },
  {
    id: 'sella-ronda',
    name: 'Sella Ronda (Canazei)',
    country: 'Italy',
    center: { lon: 11.79, lat: 46.5 },
    bbox: { minLon: 11.68, minLat: 46.42, maxLon: 11.94, maxLat: 46.58 },
    defaultZoom: 12,
    timezone: 'Europe/Rome',
  },
  {
    id: 'val-thorens-3vallees',
    name: 'Val Thorens \u2013 Les 3 Vall\u00e9es',
    country: 'France',
    center: { lon: 6.58, lat: 45.36 },
    bbox: { minLon: 6.5, minLat: 45.19, maxLon: 6.68, maxLat: 45.44 },
    defaultZoom: 12,
    timezone: 'Europe/Paris',
  },
  {
    id: 'tignes-val-disere',
    name: "Tignes \u2013 Val d'Is\u00e8re (Espace Killy)",
    country: 'France',
    center: { lon: 6.93, lat: 45.46 },
    bbox: { minLon: 6.83, minLat: 45.4, maxLon: 7.02, maxLat: 45.52 },
    defaultZoom: 12,
    timezone: 'Europe/Paris',
  },
  {
    id: 'st-anton-arlberg',
    name: 'St. Anton am Arlberg',
    country: 'Austria',
    center: { lon: 10.24, lat: 47.13 },
    bbox: { minLon: 10.13, minLat: 47.09, maxLon: 10.33, maxLat: 47.21 },
    defaultZoom: 12,
    timezone: 'Europe/Vienna',
  },
  {
    id: 'mount-hermon',
    name: 'Mount Hermon',
    country: 'Israel',
    center: { lon: 35.785, lat: 33.302 },
    bbox: { minLon: 35.75, minLat: 33.28, maxLon: 35.81, maxLat: 33.32 },
    defaultZoom: 13.5,
    timezone: 'Asia/Jerusalem',
  },
];

/** Fallback resort when geolocation is unavailable. */
export const DEFAULT_RESORT_ID = 'madonna-di-campiglio';

export function getResort(id: string): Resort | undefined {
  return RESORTS.find((r) => r.id === id);
}

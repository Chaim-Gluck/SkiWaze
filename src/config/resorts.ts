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
    infoUrl: 'https://www.campigliodolomiti.it/en/',
  },
  {
    id: 'cervinia-zermatt',
    name: 'Cervinia\u2013Zermatt',
    country: 'Italy / Switzerland',
    center: { lon: 7.71, lat: 45.958 },
    bbox: { minLon: 7.55, minLat: 45.87, maxLon: 7.82, maxLat: 46.05 },
    defaultZoom: 12,
    timezone: 'Europe/Zurich',
    infoUrl: 'https://www.cervinia.it/en/impianti-e-piste',
  },
  {
    id: 'sella-ronda',
    name: 'Sella Ronda (Canazei)',
    country: 'Italy',
    center: { lon: 11.808, lat: 46.518 },
    bbox: { minLon: 11.68, minLat: 46.42, maxLon: 11.94, maxLat: 46.58 },
    defaultZoom: 12,
    timezone: 'Europe/Rome',
    infoUrl: 'https://www.dolomitisuperski.com/en/',
  },
  {
    id: 'val-thorens-3vallees',
    name: 'Val Thorens \u2013 Les 3 Vall\u00e9es',
    country: 'France',
    center: { lon: 6.58, lat: 45.36 },
    bbox: { minLon: 6.5, minLat: 45.19, maxLon: 6.68, maxLat: 45.44 },
    defaultZoom: 12,
    timezone: 'Europe/Paris',
    infoUrl: 'https://www.valthorens.com/en/',
  },
  {
    id: 'tignes-val-disere',
    name: "Tignes \u2013 Val d'Is\u00e8re (Espace Killy)",
    country: 'France',
    center: { lon: 6.93, lat: 45.46 },
    bbox: { minLon: 6.83, minLat: 45.4, maxLon: 7.02, maxLat: 45.52 },
    defaultZoom: 12,
    timezone: 'Europe/Paris',
    infoUrl: 'https://www.tignes.net/en/',
  },
  {
    id: 'st-anton-arlberg',
    name: 'St. Anton am Arlberg',
    country: 'Austria',
    center: { lon: 10.24, lat: 47.13 },
    bbox: { minLon: 10.13, minLat: 47.09, maxLon: 10.33, maxLat: 47.21 },
    defaultZoom: 12,
    timezone: 'Europe/Vienna',
    infoUrl: 'https://www.stantonamarlberg.com/en/',
  },
  {
    id: 'mount-hermon',
    name: 'Mount Hermon',
    country: 'Israel',
    center: { lon: 35.785, lat: 33.302 },
    bbox: { minLon: 35.75, minLat: 33.28, maxLon: 35.81, maxLat: 33.32 },
    defaultZoom: 13.5,
    timezone: 'Asia/Jerusalem',
    infoUrl: 'https://www.skihermon.co.il/',
  },
  {
    id: 'gudauri',
    name: 'Gudauri',
    country: 'Georgia',
    center: { lon: 44.49, lat: 42.485 },
    bbox: { minLon: 44.42, minLat: 42.43, maxLon: 44.51, maxLat: 42.53 },
    defaultZoom: 12.5,
    timezone: 'Asia/Tbilisi',
    infoUrl: 'https://gudauri.com/',
  },
  {
    id: 'mayrhofen',
    name: 'Mayrhofen',
    country: 'Austria',
    center: { lon: 11.81, lat: 47.16 },
    bbox: { minLon: 11.72, minLat: 47.12, maxLon: 11.9, maxLat: 47.205 },
    defaultZoom: 11.5,
    timezone: 'Europe/Vienna',
    infoUrl: 'https://www.mayrhofner-bergbahnen.com/en/',
  },
  {
    id: 'soelden',
    name: 'S\u00f6lden',
    country: 'Austria',
    center: { lon: 10.96, lat: 46.95 },
    bbox: { minLon: 10.912, minLat: 46.9, maxLon: 11.02, maxLat: 46.99 },
    defaultZoom: 12,
    timezone: 'Europe/Vienna',
    infoUrl: 'https://www.soelden.com/en/',
  },
  {
    id: 'ischgl-samnaun',
    name: 'Ischgl \u2013 Samnaun (Silvretta Arena)',
    country: 'Austria / Switzerland',
    center: { lon: 10.34, lat: 46.97 },
    bbox: { minLon: 10.27, minLat: 46.91, maxLon: 10.42, maxLat: 47.03 },
    defaultZoom: 12,
    timezone: 'Europe/Vienna',
    infoUrl: 'https://www.ischgl.com/en/',
  },
  {
    id: 'alpe-dhuez',
    name: "Alpe d'Huez",
    country: 'France',
    center: { lon: 6.08, lat: 45.1 },
    bbox: { minLon: 6.03, minLat: 45.04, maxLon: 6.14, maxLat: 45.17 },
    defaultZoom: 11.5,
    timezone: 'Europe/Paris',
    infoUrl: 'https://www.alpedhuez.com/en/',
  },
  {
    id: 'les-deux-alpes',
    name: 'Les 2 Alpes',
    country: 'France',
    center: { lon: 6.16, lat: 45.0 },
    bbox: { minLon: 6.09, minLat: 44.96, maxLon: 6.23, maxLat: 45.04 },
    defaultZoom: 12,
    timezone: 'Europe/Paris',
    infoUrl: 'https://www.les2alpes.com/en/',
  },
];

/** Fallback resort when geolocation is unavailable. */
export const DEFAULT_RESORT_ID = 'madonna-di-campiglio';

export function getResort(id: string): Resort | undefined {
  return RESORTS.find((r) => r.id === id);
}

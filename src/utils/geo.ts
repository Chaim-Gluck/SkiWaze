import type { GeoPoint } from '../types/domain';

const EARTH_RADIUS_M = 6371000;

function toRad(deg: number): number {
  return (deg * Math.PI) / 180;
}

/** Great-circle horizontal distance in meters between two lon/lat points. */
export function haversineM(a: GeoPoint, b: GeoPoint): number {
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** 3D distance in meters including elevation delta (falls back to 2D if ele missing). */
export function distance3dM(a: GeoPoint, b: GeoPoint): number {
  const flat = haversineM(a, b);
  if (a.ele == null || b.ele == null) return flat;
  const dz = b.ele - a.ele;
  return Math.sqrt(flat * flat + dz * dz);
}

/** Project a point onto a single segment [a,b]; returns closest point, distance, param t∈[0,1]. */
export function projectOnSegment(p: GeoPoint, a: GeoPoint, b: GeoPoint): { point: GeoPoint; dist: number; t: number } {
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

/** Project a point onto a polyline; returns the closest point + its segment index (1-based: segment geometry[i-1]->geometry[i]) and distance. */
export function projectOnPolyline(p: GeoPoint, geometry: GeoPoint[]): { point: GeoPoint; dist: number; segIdx: number; t: number } {
  let best = { point: geometry[0], dist: Infinity, segIdx: 1, t: 0 };
  for (let i = 1; i < geometry.length; i++) {
    const pr = projectOnSegment(p, geometry[i - 1], geometry[i]);
    if (pr.dist < best.dist) best = { point: pr.point, dist: pr.dist, segIdx: i, t: pr.t };
  }
  return best;
}

/** Sum of 3D segment lengths along a polyline. */
export function polylineLength3dM(points: GeoPoint[]): number {
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    total += distance3dM(points[i - 1], points[i]);
  }
  return total;
}

/** Elevation delta (last - first) along a polyline; null if any endpoint elevation missing. */
export function polylineDropM(points: GeoPoint[]): number | null {
  const first = points[0];
  const last = points[points.length - 1];
  if (!first || !last || first.ele == null || last.ele == null) return null;
  return last.ele - first.ele;
}

/** Gradient (rise/run) between two points; 0 when horizontally coincident. */
export function gradient(a: GeoPoint, b: GeoPoint): number {
  if (a.ele == null || b.ele == null) return 0;
  const run = haversineM(a, b);
  if (run < 1e-6) return 0;
  return (b.ele - a.ele) / run;
}

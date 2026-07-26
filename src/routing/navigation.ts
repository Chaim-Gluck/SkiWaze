import type { DisplayStep, Route } from '../types/domain';

/** Metres between two [lon,lat] points (local equirectangular; fine at resort scale). */
function distM(a: [number, number], b: [number, number]): number {
  const dLat = (a[1] - b[1]) * 110540;
  const dLon = (a[0] - b[0]) * 111320 * Math.cos((((a[1] + b[1]) / 2) * Math.PI) / 180);
  return Math.hypot(dLat, dLon);
}

export interface PathPoint {
  lon: number;
  lat: number;
  /** Distance along the route from the start, in metres. */
  s: number;
  /** Index of the route leg this point belongs to. */
  leg: number;
}

export interface RoutePath {
  pts: PathPoint[];
  totalM: number;
  /** Cumulative distance (m) at the start/end of each leg. */
  legStartS: number[];
  legEndS: number[];
}

/** Concatenate a route's per-leg geometry into one measured polyline. */
export function buildRoutePath(route: Route, geomOf: (edgeId: string) => [number, number][] | undefined): RoutePath {
  const pts: PathPoint[] = [];
  const legStartS: number[] = [];
  const legEndS: number[] = [];
  let s = 0;
  route.legs.forEach((leg, i) => {
    const coords = geomOf(leg.edgeId);
    legStartS[i] = s;
    if (!coords || coords.length < 2) {
      legEndS[i] = s;
      return;
    }
    const startK = pts.length === 0 ? 0 : 1; // skip the point shared with the previous leg
    for (let k = startK; k < coords.length; k++) {
      const c = coords[k];
      if (pts.length) s += distM([pts[pts.length - 1].lon, pts[pts.length - 1].lat], c);
      pts.push({ lon: c[0], lat: c[1], s, leg: i });
    }
    legEndS[i] = s;
  });
  return { pts, totalM: s, legStartS, legEndS };
}

export interface Snap {
  /** Distance along the route (m) of the snapped position. */
  s: number;
  lon: number;
  lat: number;
  /** Bearing of the route at the snapped point (deg, 0 = north). */
  bearing: number;
  /** Route leg index at the snapped point. */
  leg: number;
  /** Perpendicular distance (m) from the raw point to the route. */
  offM: number;
}

/** Project a live [lon,lat] onto the nearest point of the route polyline. */
export function snapToRoute(path: RoutePath, lon: number, lat: number): Snap | null {
  if (path.pts.length < 2) return null;
  let best: Snap | null = null;
  let bestD = Infinity;
  for (let i = 1; i < path.pts.length; i++) {
    const A = path.pts[i - 1];
    const B = path.pts[i];
    const latRef = (((A.lat + B.lat) / 2) * Math.PI) / 180;
    const bx = (B.lon - A.lon) * 111320 * Math.cos(latRef);
    const by = (B.lat - A.lat) * 110540;
    const px = (lon - A.lon) * 111320 * Math.cos(latRef);
    const py = (lat - A.lat) * 110540;
    const seg2 = bx * bx + by * by;
    let t = seg2 > 0 ? (px * bx + py * by) / seg2 : 0;
    t = Math.max(0, Math.min(1, t));
    const d = Math.hypot(px - bx * t, py - by * t);
    if (d < bestD) {
      bestD = d;
      const brg = (Math.atan2(bx, by) * 180) / Math.PI;
      best = {
        s: A.s + (B.s - A.s) * t,
        lon: A.lon + (B.lon - A.lon) * t,
        lat: A.lat + (B.lat - A.lat) * t,
        bearing: (brg + 360) % 360,
        leg: B.leg,
        offM: d,
      };
    }
  }
  return best;
}

/** Split the route polyline at distance `s` into travelled + remaining coordinate lists. */
export function sliceAt(path: RoutePath, s: number): { traveled: [number, number][]; remaining: [number, number][] } {
  const traveled: [number, number][] = [];
  const remaining: [number, number][] = [];
  for (const p of path.pts) {
    if (p.s <= s) traveled.push([p.lon, p.lat]);
    else remaining.push([p.lon, p.lat]);
  }
  for (let i = 1; i < path.pts.length; i++) {
    if (path.pts[i - 1].s <= s && path.pts[i].s >= s) {
      const A = path.pts[i - 1];
      const B = path.pts[i];
      const t = B.s - A.s > 0 ? (s - A.s) / (B.s - A.s) : 0;
      const sp: [number, number] = [A.lon + (B.lon - A.lon) * t, A.lat + (B.lat - A.lat) * t];
      traveled.push(sp);
      remaining.unshift(sp);
      break;
    }
  }
  return { traveled, remaining };
}

/** Remaining distance (m) and estimated time (s) from the snapped position to the end. */
export function remainingStats(route: Route, path: RoutePath, snap: Snap): { distM: number; timeS: number } {
  const dist = Math.max(0, path.totalM - snap.s);
  let timeS = 0;
  const leg = snap.leg;
  const legLen = path.legEndS[leg] - path.legStartS[leg];
  const frac = legLen > 0 ? Math.max(0, Math.min(1, (path.legEndS[leg] - snap.s) / legLen)) : 0;
  timeS += (route.legs[leg]?.durationS ?? 0) * frac;
  for (let i = leg + 1; i < route.legs.length; i++) timeS += route.legs[i].durationS;
  return { distM: dist, timeS };
}

/** Current display step, the next one, and the distance (m) to that transition. */
export function nextStep(
  route: Route,
  path: RoutePath,
  snap: Snap,
): { current?: DisplayStep; next?: DisplayStep; distToNextM: number } {
  const steps = route.steps;
  let cs = steps.findIndex((st) => snap.leg >= st.fromLeg && snap.leg <= st.toLeg);
  if (cs < 0) cs = 0;
  const current = steps[cs];
  const next = steps[cs + 1];
  const distToNextM = current ? Math.max(0, path.legEndS[current.toLeg] - snap.s) : 0;
  return { current, next, distToNextM };
}

/** Interpolated position + travel bearing at distance `s` along the route (for the dev simulator). */
export function posAtS(path: RoutePath, s: number): { lon: number; lat: number; heading: number } | null {
  if (path.pts.length < 2) return null;
  const clamped = Math.max(0, Math.min(path.totalM, s));
  for (let i = 1; i < path.pts.length; i++) {
    if (path.pts[i].s >= clamped) {
      const A = path.pts[i - 1];
      const B = path.pts[i];
      const t = B.s - A.s > 0 ? (clamped - A.s) / (B.s - A.s) : 0;
      const latRef = (((A.lat + B.lat) / 2) * Math.PI) / 180;
      const brg =
        (Math.atan2((B.lon - A.lon) * 111320 * Math.cos(latRef), (B.lat - A.lat) * 110540) * 180) / Math.PI;
      return { lon: A.lon + (B.lon - A.lon) * t, lat: A.lat + (B.lat - A.lat) * t, heading: (brg + 360) % 360 };
    }
  }
  const last = path.pts[path.pts.length - 1];
  return { lon: last.lon, lat: last.lat, heading: 0 };
}

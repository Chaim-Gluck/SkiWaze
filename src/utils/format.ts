export function fmtDuration(seconds: number): string {
  const s = Math.round(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.round((s % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m} min`;
}

export function fmtDistance(meters: number): string {
  if (meters >= 1000) return `${(meters / 1000).toFixed(1)} km`;
  return `${Math.round(meters)} m`;
}

/** Local clock time HH:MM (24h) from an ISO string. */
export function fmtClock(iso: string | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
}

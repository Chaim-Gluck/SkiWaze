/**
 * Lightweight opening_hours handling. OSM opening_hours can be complex; for v1 we
 * extract the daily HH:MM-HH:MM time range(s) and ignore day/month scoping (ski lifts
 * are typically "seasonal, daily during the season"). Missing data is surfaced upstream.
 */

export interface DailyWindow {
  /** Minutes from midnight. */
  openMin: number;
  closeMin: number;
}

const TIME_RANGE_RE = /(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})/g;

/** Parse all HH:MM-HH:MM ranges found in the string (day/month prefixes ignored). */
export function parseDailyWindows(spec: string | undefined): DailyWindow[] {
  if (!spec) return [];
  if (/24\/7/.test(spec)) return [{ openMin: 0, closeMin: 24 * 60 }];
  const out: DailyWindow[] = [];
  let m: RegExpExecArray | null;
  TIME_RANGE_RE.lastIndex = 0;
  while ((m = TIME_RANGE_RE.exec(spec)) !== null) {
    const openMin = Number(m[1]) * 60 + Number(m[2]);
    let closeMin = Number(m[3]) * 60 + Number(m[4]);
    if (closeMin <= openMin) closeMin += 24 * 60; // handle wrap, rare for lifts
    out.push({ openMin, closeMin });
  }
  return out;
}

function minutesOfDay(d: Date): number {
  return d.getHours() * 60 + d.getMinutes();
}

/** True when `date` falls inside any parsed window. */
export function isOpenAt(windows: DailyWindow[], date: Date): boolean {
  if (windows.length === 0) return true; // unknown -> treat as open (warned elsewhere)
  const t = minutesOfDay(date);
  return windows.some((w) => t >= w.openMin && t <= w.closeMin);
}

/** Minutes until the lift closes at `date`; null if unknown/closed/no applicable window. */
export function minutesUntilClose(windows: DailyWindow[], date: Date): number | null {
  if (windows.length === 0) return null;
  const t = minutesOfDay(date);
  const active = windows.find((w) => t >= w.openMin && t <= w.closeMin);
  if (!active) return null;
  return active.closeMin - t;
}

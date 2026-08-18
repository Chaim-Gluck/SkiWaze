// Tracks which resorts have already shown the "assumed open" status notice today, so it appears
// at most once per resort per calendar day (not on every selection). Per-browser via localStorage.
const KEY = 'skiwaze.statusNoticeShown';

function today(): string {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD (local enough for a daily gate)
}

/**
 * Returns true the first time a resort's status notice should be shown on a given day, and records
 * it so subsequent calls that day return false. Fails open (returns true) if storage is unavailable.
 */
export function shouldShowStatusNotice(resortId: string): boolean {
  try {
    const raw = localStorage.getItem(KEY);
    const map: Record<string, string> = raw ? JSON.parse(raw) : {};
    if (map[resortId] === today()) return false;
    map[resortId] = today();
    localStorage.setItem(KEY, JSON.stringify(map));
    return true;
  } catch {
    return true;
  }
}

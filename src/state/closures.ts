const KEY = (resortId: string) => `skiwaze.closures.${resortId}`;

/** Closure keys the user has manually marked closed for a resort. */
export function loadClosures(resortId: string): string[] {
  try {
    const raw = localStorage.getItem(KEY(resortId));
    if (!raw) return [];
    const parsed = JSON.parse(raw) as string[];
    return Array.isArray(parsed) ? parsed.filter((k) => typeof k === 'string') : [];
  } catch {
    return [];
  }
}

export function saveClosures(resortId: string, keys: string[]): void {
  try {
    localStorage.setItem(KEY(resortId), JSON.stringify(keys));
  } catch {
    // ignore quota / private-mode errors
  }
}

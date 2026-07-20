import type { Preferences } from '../types/domain';
import { DEFAULT_PREFERENCES } from '../config/defaults';

const KEY = 'skiwaze.preferences.v1';

export function loadPreferences(): Preferences {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return DEFAULT_PREFERENCES;
    const parsed = JSON.parse(raw) as Partial<Preferences>;
    // Merge with defaults so new fields are always populated.
    return {
      ...DEFAULT_PREFERENCES,
      ...parsed,
      speeds: { ...DEFAULT_PREFERENCES.speeds, ...(parsed.speeds ?? {}) },
    };
  } catch {
    return DEFAULT_PREFERENCES;
  }
}

export function savePreferences(prefs: Preferences): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(prefs));
  } catch {
    // ignore quota / private-mode errors
  }
}

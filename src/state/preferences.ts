import type { Preferences } from '../types/domain';
import { DEFAULT_PREFERENCES } from '../config/defaults';

const KEY = 'skiwaze.preferences.v1';

export function loadPreferences(): Preferences {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return DEFAULT_PREFERENCES;
    const parsed = JSON.parse(raw) as Partial<Preferences>;
    // Merge with defaults so new fields are always populated.
    const merged: Preferences = {
      ...DEFAULT_PREFERENCES,
      ...parsed,
      speeds: { ...DEFAULT_PREFERENCES.speeds, ...(parsed.speeds ?? {}) },
    };
    // Self-heal: base per-colour speeds are derived from the model, never persisted. Only keep a
    // stored skiSpeedByColor override when the user has opted into measured speeds — otherwise
    // drop it so old/stale cached speeds can't override the current model.
    if (!merged.useMeasuredSpeeds) merged.speeds = { ...merged.speeds, skiSpeedByColor: {} };
    // Self-heal: lift ride speeds and queue waits are app constants, not user settings — nothing in
    // the UI edits them. The spread above is shallow, so a stored copy would replace the whole map
    // and pin a returning user to whatever the defaults were on their first visit (that is how
    // chairs would have stayed at the old, far-too-slow 2.5 m/s). Always re-derive them.
    merged.speeds = {
      ...merged.speeds,
      liftSpeedByType: DEFAULT_PREFERENCES.speeds.liftSpeedByType,
      liftWaitByType: DEFAULT_PREFERENCES.speeds.liftWaitByType,
    };
    return merged;
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

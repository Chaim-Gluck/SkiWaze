/**
 * Number + unit formatting.
 *
 * Two i18n concerns are handled here rather than at the ~40 call sites:
 *
 * 1. **The unit words are injected, not imported.** These helpers also run under Node in the
 *    pipeline probes, where there is no React and no `t()`, so the UI pushes translated labels in
 *    via `setUnitLabels` instead of this module reaching for i18next.
 * 2. **A measurement is wrapped in a bidi isolate**, so dropping "1.2 km" into a Hebrew sentence
 *    can't let the algorithm reorder it against neighbouring punctuation ("5 m – 3 km" came out
 *    with the dash in the wrong place). The isolate is *first-strong* (U+2068), not forced-LTR:
 *    once the unit word is itself Hebrew, "22 דק'" has to lay out right-to-left or the unit reads
 *    before the number. Guarded on `document` so the probes keep comparing clean strings.
 */

interface UnitLabels {
  hour: string;
  minuteShort: string;
  minute: string;
  km: string;
  metre: string;
}

const units: UnitLabels = { hour: 'h', minuteShort: 'm', minute: 'min', km: 'km', metre: 'm' };

/** Called by the language provider whenever the active language changes. */
export function setUnitLabels(next: Partial<UnitLabels>): void {
  Object.assign(units, next);
}

function isolate(s: string): string {
  if (typeof document === 'undefined' || document.documentElement.dir !== 'rtl') return s;
  return `\u2068${s}\u2069`;
}

/**
 * Isolate a proper name (piste, lift, resort, named point) from the surrounding text direction.
 *
 * Names are never translated — they have to match the signage on the mountain — so a Hebrew page is
 * full of Latin runs like `Pozza vecia (bottom)`. Left bare in an RTL paragraph the bidi algorithm
 * treats the brackets as belonging to the Hebrew, and mirrors them: `Pozza vecia )bottom(`. A
 * *first-strong* isolate (U+2068…U+2069) fixes that without hard-coding a direction, so a genuinely
 * Hebrew name (Mount Hermon) still reads right-to-left. No-op outside the browser and outside RTL,
 * so the pipeline probes keep comparing clean strings.
 */
export function bidiName(s: string): string;
export function bidiName(s: string | undefined): string | undefined;
export function bidiName(s: string | undefined): string | undefined {
  if (!s) return s;
  if (typeof document === 'undefined' || document.documentElement.dir !== 'rtl') return s;
  return `\u2068${s}\u2069`;
}

export function fmtDuration(seconds: number): string {
  const s = Math.round(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.round((s % 3600) / 60);
  if (h > 0) return isolate(`${h}${units.hour} ${m}${units.minuteShort}`);
  return isolate(`${m} ${units.minute}`);
}

export function fmtDistance(meters: number): string {
  if (meters >= 1000) return isolate(`${(meters / 1000).toFixed(1)} ${units.km}`);
  return isolate(`${Math.round(meters)} ${units.metre}`);
}

/** Local clock time HH:MM (24h) from an ISO string. */
export function fmtClock(iso: string | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  return isolate(d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false }));
}

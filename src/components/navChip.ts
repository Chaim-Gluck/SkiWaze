import type { DisplayStep } from '../types/domain';

/**
 * Slope colours, as hex, for anything drawn over the map rather than through the theme.
 *
 * Fixed values, not theme tokens: these read over map tiles, which do not change with the theme
 * (same rule as the other MapLibre-coupled visuals in the style guide).
 */
export const COLOR_HEX: Record<string, string> = {
  green: '#2e7d32', blue: '#1565c0', red: '#d32f2f', black: '#111111', unknown: '#ff9800',
};

/**
 * The run or lift you are ON, as a single minimal pill - Waze's current-street badge.
 *
 * It is returned as data, not as an element, because it is rendered as a **MapLibre marker
 * anchored under the nav arrow**, not as part of the nav overlay. That placement is the point:
 * "what am I on" is a fact about a place, so it belongs at the place, and a pill parked at the foot
 * of the screen made the eye travel away from the puck to read it. Anchoring it to the position
 * also keeps it honest when the user pans off themselves - it goes with them, instead of continuing
 * to label a spot that is no longer on screen.
 *
 * Three rules, and each is the reason it replaced the captioned strip that used to sit inside the
 * manoeuvre card:
 * - **No verb.** "Ski", "Take", "Traverse" are instructions, and this is not an instruction - it is
 *   the answer to "what am I on". Dropping the verb also retires the `nav.now` caption, which only
 *   existed because Hebrew has no genderless present participle (`גולש`/`גולשת`): a bare name has
 *   no gender to get wrong.
 * - **The name only, never a sentence.** `DisplayStep.name` is the raw mapped name, so it is never
 *   translated - it matches the sign at the top of the run, per the i18n rule.
 * - **Nothing at all when there is no name.** An unnamed traverse or an unnamed run has nothing
 *   worth saying, and a pill reading "traverse" would be ink spent on the absence of information.
 *
 * Colour is the app's existing vocabulary, not a new one: the slope's own colour for a piste, and
 * for a lift the same slate `.pbadge.lift` already uses in the step list. A skier learns the
 * mapping once and it holds across the step list, the map and here.
 */
export function navRunChip(step?: DisplayStep): { text: string; color: string } | null {
  if (!step?.name) return null;
  return {
    text: step.name,
    color: step.kind === 'lift' ? '#37475a' : (COLOR_HEX[step.color ?? 'unknown'] ?? COLOR_HEX.unknown),
  };
}

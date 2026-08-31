import type { RouteLabel } from '../types/domain';

/**
 * The one place a route badge key becomes words.
 *
 * Routing stores badges as keys (`RouteLabel`) because `reconcileLabels` in plan.ts *compares*
 * them — a display string there would make translation a routing bug rather than a wording change.
 * Keeping the single mapping here means adding a language later touches this file and nothing in
 * `src/routing/`.
 */
export const ROUTE_LABEL_TEXT: Record<RouteLabel, string> = {
  fastest: 'Fastest',
  fewest_lifts: 'Fewest lifts',
  preferred: 'Preferred runs',
  longest_ab: 'Longest',
  alternative: 'Alternative',
};

export function routeLabelText(label: RouteLabel): string {
  return ROUTE_LABEL_TEXT[label];
}

import type { RouteLabel } from '../types/domain';

/**
 * The one place a route badge key becomes words.
 *
 * Routing stores badges as keys (`RouteLabel`) because `reconcileLabels` in plan.ts *compares*
 * them — a display string there would make translation a routing bug rather than a wording change.
 * Keeping the single mapping here means adding a language touches this file and nothing in
 * `src/routing/`.
 */
export function routeLabelKey(label: RouteLabel): string {
  return `route.badge.${label}`;
}

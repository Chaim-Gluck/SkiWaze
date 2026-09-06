import type { TFunction } from 'i18next';
import type { TextRef } from '../types/domain';

/**
 * Render a `TextRef` emitted by a pure routing module.
 *
 * Params may themselves be TextRefs (a piste label nested inside a leg description), so this
 * resolves one param level before interpolating. Keeping the nesting in the params — rather
 * than pre-joining English fragments in routing — is what lets a translation reorder the
 * sentence around the run's name.
 */
export function tr(t: TFunction, ref: TextRef): string {
  if (!ref.params) return t(ref.key);
  const params: Record<string, string | number> = {};
  for (const [k, v] of Object.entries(ref.params)) {
    params[k] = typeof v === 'object' ? tr(t, v) : v;
  }
  return t(ref.key, params);
}

/**
 * Marker for "the piste shield goes here" inside a resolved label.
 *
 * Routing is pure and cannot emit a React node, and the UI must not cut a translated sentence at a
 * fixed offset — Hebrew puts the run's name in a different place from English. So routing
 * interpolates this character as an ordinary param and the **catalogue** decides where it lands;
 * the UI just splits on it. A private-use codepoint, so it can never collide with an OSM name.
 */
export const SHIELD_SLOT = '\uE000';

import createCache from '@emotion/cache';
import { prefixer } from 'stylis';
import rtlPlugin from 'stylis-plugin-rtl';

/**
 * Emotion caches for the two writing directions.
 *
 * `stylis-plugin-rtl` rewrites CSS logical properties in emotion-generated styles, which covers
 * everything MUI renders. It does NOT cover the map: per the style guide the MapLibre-coupled
 * visuals (location puck, on-map arrows, route lines, piste badges, pin hints) are deliberately
 * plain tokenised CSS that emotion never sees, and the map itself must not flip — north stays up
 * and west stays left regardless of the UI language.
 */
export const rtlCache = createCache({
  key: 'mui-rtl',
  stylisPlugins: [prefixer, rtlPlugin],
});

/** Default LTR emotion cache. */
export const ltrCache = createCache({ key: 'mui' });

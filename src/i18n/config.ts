/**
 * i18next initialisation.
 *
 * The active language is owned by the app's preferences (persisted in localStorage) and pushed
 * here via `i18n.changeLanguage`, so there is one source of truth rather than two that can drift.
 *
 * Only the app's own chrome is translated. Piste, lift and resort names come from OSM and stay in
 * the local language on purpose: a skier has to match what the card says against the sign at the
 * top of the run, and a translated run name would disagree with the mountain.
 */
import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import en from '../locales/en.json';
import he from '../locales/he.json';
import { setUnitLabels } from '../utils/format';

/** Supported languages (code -> native label shown in the picker). */
export const LANGUAGES = { en: 'English', he: 'עברית' } as const;
export type Language = keyof typeof LANGUAGES;

/** Right-to-left languages. */
export const RTL_LANGUAGES: Language[] = ['he'];
export const isRtlLanguage = (lng: Language): boolean => RTL_LANGUAGES.includes(lng);

export function isLanguage(v: unknown): v is Language {
  return typeof v === 'string' && Object.prototype.hasOwnProperty.call(LANGUAGES, v);
}

/**
 * Language for a first-time visitor.
 *
 * Deliberately NOT taken from the browser. English is the language of the mountain here: piste,
 * lift and resort names are never translated because they have to match the signage, so an
 * all-Hebrew shell around Latin names reads worse than a consistently English one. A Hebrew
 * speaker switches once and the choice is stored, so detection would only ever save one tap while
 * surprising everyone whose device locale does not match how they want to read a map.
 */
export const DEFAULT_LANGUAGE: Language = 'en';

export const LANGUAGE_STORAGE_KEY = 'skiwaze-language';

/**
 * A stored choice always wins; everyone else starts in English (see DEFAULT_LANGUAGE).
 *
 * This is read HERE, at init, and not only by the React provider: `changeLanguage` is async, so a
 * provider effect leaves a window in which `t()` still answers in English. Anything that resolves a
 * string eagerly during that window — the once-a-day "statuses assumed open" notice freezes its
 * text into state on mount — kept the English copy for the rest of the visit, and only looked right
 * after a later resort change re-ran it. Same failure mode as the unit labels below.
 */
export function storedLanguage(): Language {
  try {
    const saved = localStorage.getItem(LANGUAGE_STORAGE_KEY);
    if (isLanguage(saved)) return saved;
  } catch { /* ignore */ }
  return DEFAULT_LANGUAGE;
}

i18n.use(initReactI18next).init({
  resources: {
    en: { translation: en },
    he: { translation: he },
  },
  lng: storedLanguage(),
  fallbackLng: 'en',
  interpolation: { escapeValue: false }, // React already escapes
  returnNull: false,
});

/**
 * Keep the plain formatting module's unit words in step with the active language.
 *
 * This is driven off i18next's own event rather than from the React provider, because
 * `changeLanguage` is asynchronous: reading `t('units.short.km')` on the line after calling it
 * still answers for the OUTGOING language. A returning Hebrew visitor therefore got English units
 * baked in on the first render and kept them until they switched language a second time.
 */
function syncUnitLabels(): void {
  setUnitLabels({
    hour: i18n.t('units.short.hour'),
    minuteShort: i18n.t('units.short.minuteShort'),
    minute: i18n.t('units.short.minute'),
    km: i18n.t('units.short.km'),
    metre: i18n.t('units.short.metre'),
  });
}
i18n.on('languageChanged', syncUnitLabels);
syncUnitLabels();

export default i18n;

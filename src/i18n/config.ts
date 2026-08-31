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
 * Best language for a first-time visitor, taken from the browser. A Hebrew speaker who cannot read
 * the UI would otherwise have to find the language picker before being able to read anything, so
 * detection makes the picker a correction rather than a discovery. Only consulted when nothing has
 * been stored — an explicit choice always wins.
 */
export function detectLanguage(): Language {
  const tags = typeof navigator !== 'undefined' ? (navigator.languages ?? [navigator.language]) : [];
  for (const tag of tags) {
    const base = String(tag).toLowerCase().split('-')[0];
    // 'iw' is the legacy ISO code for Hebrew and is still emitted by some platforms.
    const code = base === 'iw' ? 'he' : base;
    if (isLanguage(code)) return code;
  }
  return 'en';
}

i18n.use(initReactI18next).init({
  resources: {
    en: { translation: en },
  },
  lng: 'en',
  fallbackLng: 'en',
  interpolation: { escapeValue: false }, // React already escapes
  returnNull: false,
});

export default i18n;

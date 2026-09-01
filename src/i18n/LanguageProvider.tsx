import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { CacheProvider } from '@emotion/react';
import i18n, { DEFAULT_LANGUAGE, isLanguage, isRtlLanguage, type Language } from './config';
import { LanguageContext, type LanguageCtxValue } from './language-context';
import { rtlCache, ltrCache } from '../rtlCache';

const STORAGE_KEY = 'skiwaze-language';

/**
 * A stored choice always wins; everyone else starts in English. The browser locale is deliberately
 * not consulted — see DEFAULT_LANGUAGE.
 */
function initialLanguage(): Language {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (isLanguage(saved)) return saved;
  } catch { /* ignore */ }
  return DEFAULT_LANGUAGE;
}

/**
 * Owns the active language and the writing direction that follows from it.
 *
 * Must sit OUTSIDE ThemeModeProvider: the emotion cache has to wrap the MUI ThemeProvider for the
 * RTL style plugin to see MUI's styles, and the theme itself needs `direction` to lay components
 * out mirrored.
 */
export function LanguageProvider({ children }: { children: ReactNode }) {
  const [language, setLanguage] = useState<Language>(initialLanguage);
  const rtl = isRtlLanguage(language);

  useEffect(() => {
    // The formatters' unit words follow this via i18next's own `languageChanged` event (see
    // config.ts) — doing it here would read the outgoing language, since changeLanguage is async.
    void i18n.changeLanguage(language);
    document.documentElement.dir = rtl ? 'rtl' : 'ltr';
    document.documentElement.lang = language;
    try { localStorage.setItem(STORAGE_KEY, language); } catch { /* ignore */ }
  }, [language, rtl]);

  const value = useMemo<LanguageCtxValue>(() => ({ language, setLanguage, rtl }), [language, rtl]);

  return (
    <LanguageContext.Provider value={value}>
      <CacheProvider value={rtl ? rtlCache : ltrCache}>{children}</CacheProvider>
    </LanguageContext.Provider>
  );
}

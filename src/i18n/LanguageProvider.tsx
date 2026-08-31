import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { CacheProvider } from '@emotion/react';
import i18n, { detectLanguage, isLanguage, isRtlLanguage, type Language } from './config';
import { LanguageContext, type LanguageCtxValue } from './language-context';
import { rtlCache, ltrCache } from '../rtlCache';

const STORAGE_KEY = 'skiwaze-language';

/**
 * A stored choice always wins; the browser is consulted only for a first-time visitor. Getting
 * that order wrong would keep silently overriding someone who had deliberately switched back.
 */
function initialLanguage(): Language {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (isLanguage(saved)) return saved;
  } catch { /* ignore */ }
  return detectLanguage();
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

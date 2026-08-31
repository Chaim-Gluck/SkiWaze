import { createContext, useContext } from 'react';
import type { Language } from './config';

export interface LanguageCtxValue {
  language: Language;
  setLanguage: (lng: Language) => void;
  /** True when the active language is right-to-left. */
  rtl: boolean;
}

export const LanguageContext = createContext<LanguageCtxValue>({
  language: 'en',
  setLanguage: () => {},
  rtl: false,
});

export function useLanguage(): LanguageCtxValue {
  return useContext(LanguageContext);
}

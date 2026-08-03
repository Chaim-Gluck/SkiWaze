import { createContext, useContext } from 'react';

export type ThemeMode = 'light' | 'dark';

export interface ThemeModeCtxValue {
  mode: ThemeMode;
  toggle: () => void;
}

export const ThemeModeContext = createContext<ThemeModeCtxValue>({ mode: 'dark', toggle: () => {} });

export const useThemeMode = () => useContext(ThemeModeContext);

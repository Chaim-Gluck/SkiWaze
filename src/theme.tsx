import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { createTheme, ThemeProvider } from '@mui/material/styles';
import CssBaseline from '@mui/material/CssBaseline';
import { ThemeModeContext, type ThemeMode, type ThemeModeCtxValue } from './theme-context';
import { useLanguage } from './i18n/language-context';

/**
 * Single source of truth for the app's colours. The MUI theme is built from these, AND they
 * are mirrored onto CSS custom properties (`--bg`, `--panel`, …) so the MapLibre-coupled
 * overlays styled in App.css (nav banner, badges, puck) follow the same light/dark palette.
 */
const TOKENS: Record<ThemeMode, Record<string, string>> = {
  dark: {
    bg: '#0f1720',
    panel: '#1b2733',
    panel2: '#223140',
    text: '#e7edf3',
    muted: '#9fb0c0',
    line: '#2c3d4d',
    accent: '#ff9800', // route highlight / warm accent
    primary: '#4aa8ff', // primary actions (brand blue, lightened for dark)
    glass: 'rgba(20,29,38,0.85)', // translucent panel for map overlays
  },
  light: {
    bg: '#f4f7fb',
    panel: '#ffffff',
    panel2: '#eef2f7',
    text: '#17222d',
    muted: '#5b6b7a',
    line: '#dce4ec',
    accent: '#f57c00',
    primary: '#1565c0',
    glass: 'rgba(255,255,255,0.9)',
  },
};

const LATIN_FONTS = "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif";
/**
 * `system-ui` resolves to Segoe UI on Windows, whose Hebrew is markedly heavier and blockier than
 * its Latin at the same weight. Arial's Hebrew is the most neutral face that ships everywhere, so
 * Hebrew gets its own stack rather than a webfont download.
 */
const HEBREW_FONTS = "Arial, 'Segoe UI', system-ui, sans-serif";

function makeTheme(mode: ThemeMode, direction: 'ltr' | 'rtl') {
  const t = TOKENS[mode];
  return createTheme({
    direction,
    palette: {
      mode,
      primary: { main: t.primary },
      background: { default: t.bg, paper: t.panel },
      text: { primary: t.text, secondary: t.muted },
      divider: t.line,
    },
    shape: { borderRadius: 10 },
    typography: { fontFamily: direction === 'rtl' ? HEBREW_FONTS : LATIN_FONTS },
    components: {
      MuiPaper: { defaultProps: { elevation: 0 }, styleOverrides: { root: { backgroundImage: 'none' } } },
      MuiButton: {
        defaultProps: { disableElevation: true },
        styleOverrides: { root: { textTransform: 'none', fontWeight: 600 } },
      },
      MuiAccordion: { defaultProps: { disableGutters: true, elevation: 0 } },
    },
  });
}

function applyCssVars(mode: ThemeMode): void {
  const root = document.documentElement;
  for (const [k, v] of Object.entries(TOKENS[mode])) root.style.setProperty(`--${k}`, v);
  root.style.colorScheme = mode;
}

const STORAGE_KEY = 'skiwaze-theme';

function initialMode(): ThemeMode {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === 'light' || saved === 'dark') return saved;
  } catch { /* ignore */ }
  // Default to dark until the light theme + map-overlay contrast are polished (later step).
  return 'dark';
}

/** Wraps the app in the MUI theme + CssBaseline and keeps the CSS vars / storage in sync. */
export function ThemeModeProvider({ children }: { children: ReactNode }) {
  const [mode, setMode] = useState<ThemeMode>(initialMode);
  const { rtl } = useLanguage();
  useEffect(() => {
    applyCssVars(mode);
    try { localStorage.setItem(STORAGE_KEY, mode); } catch { /* ignore */ }
  }, [mode]);
  const theme = useMemo(() => makeTheme(mode, rtl ? 'rtl' : 'ltr'), [mode, rtl]);
  const value = useMemo<ThemeModeCtxValue>(() => ({ mode, toggle: () => setMode((m) => (m === 'dark' ? 'light' : 'dark')) }), [mode]);
  return (
    <ThemeModeContext.Provider value={value}>
      <ThemeProvider theme={theme}>
        <CssBaseline />
        {children}
      </ThemeProvider>
    </ThemeModeContext.Provider>
  );
}

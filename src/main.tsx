import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { ErrorBoundary } from './components/ErrorBoundary'
import { ThemeModeProvider } from './theme'
// LanguageProvider owns the emotion cache, so it must wrap the theme: the RTL style plugin can
// only rewrite MUI's styles if its cache sits above MUI's ThemeProvider.
import { LanguageProvider } from './i18n/LanguageProvider'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <LanguageProvider>
      <ThemeModeProvider>
        <ErrorBoundary>
          <App />
        </ErrorBoundary>
      </ThemeModeProvider>
    </LanguageProvider>
  </StrictMode>,
)

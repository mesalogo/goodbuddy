import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '@fontsource-variable/noto-sans-sc/wght.css'
import App from './App'
import { installBundledUiFonts } from './fonts'
import { changeUiLocale } from './i18n'
import {
  UiLocaleProvider
} from './i18n/UiLocaleProvider'
import {
  loadUiLocalePreference,
  resolveUiLocale,
  systemUiLanguages
} from './i18n/locale'
import {
  applyAppearanceTheme,
  loadAppearanceTheme,
  resolveAppearanceTheme
} from './theme'
import { installDocumentOcrBridge } from './document-ocr-bridge'
import './styles.css'

const root = document.getElementById('root')

if (!root) {
  throw new Error('Root element not found')
}

installBundledUiFonts()

const initialUiLocalePreference = loadUiLocalePreference()
void changeUiLocale(
  resolveUiLocale(
    initialUiLocalePreference,
    systemUiLanguages()
  )
)

applyAppearanceTheme(
  resolveAppearanceTheme(
    loadAppearanceTheme(),
    typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-color-scheme: dark)').matches
  )
)

installDocumentOcrBridge()

createRoot(root).render(
  <StrictMode>
    <UiLocaleProvider
      initialPreference={initialUiLocalePreference}
    >
      <App />
    </UiLocaleProvider>
  </StrictMode>
)

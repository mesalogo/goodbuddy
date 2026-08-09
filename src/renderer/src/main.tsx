import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '@fontsource-variable/noto-sans-sc/wght.css'
import App from './App'
import { installBundledUiFonts } from './fonts'
import {
  applyAppearanceTheme,
  loadAppearanceTheme,
  resolveAppearanceTheme
} from './theme'
import './styles.css'

const root = document.getElementById('root')

if (!root) {
  throw new Error('Root element not found')
}

installBundledUiFonts()

applyAppearanceTheme(
  resolveAppearanceTheme(
    loadAppearanceTheme(),
    typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-color-scheme: dark)').matches
  )
)

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>
)

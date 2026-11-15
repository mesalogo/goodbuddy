import { createRoot } from 'react-dom/client'
import App from '../../src/renderer/src/App'
import { UiLocaleProvider } from '../../src/renderer/src/i18n/UiLocaleProvider'
import { changeUiLocale } from '../../src/renderer/src/i18n'
import '../../src/renderer/src/styles.css'

// No renderer bridge replacement: window.goodbuddy comes from production preload.
// The drivers walk the classic sidebar (sidebar toggle, search); workbench is the app default.
localStorage.setItem('goodbuddy.interface-layout', 'classic')
await changeUiLocale('en-US')
createRoot(document.getElementById('root')!).render(<UiLocaleProvider initialPreference="en-US"><App /></UiLocaleProvider>)

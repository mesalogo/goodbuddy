import { createRoot } from 'react-dom/client'
import App from '../../src/renderer/src/App'
import { UiLocaleProvider } from '../../src/renderer/src/i18n/UiLocaleProvider'
import { changeUiLocale } from '../../src/renderer/src/i18n'
import '../../src/renderer/src/styles.css'

// No renderer bridge replacement: window.goodbuddy comes from production preload.
await changeUiLocale('en-US')
createRoot(document.getElementById('root')!).render(<UiLocaleProvider initialPreference="en-US"><App /></UiLocaleProvider>)

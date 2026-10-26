import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { UpdateSettingsSection } from '../../src/renderer/src/UpdateSettingsSection'
import { UiLocaleProvider } from '../../src/renderer/src/i18n/UiLocaleProvider'
import '../../src/renderer/src/styles.css'

function Harness() {
  const [visible, setVisible] = useState(true)
  return <UiLocaleProvider initialPreference="en-US">
    <button id="toggle-settings" onClick={() => setVisible(value => !value)}>Toggle settings</button>
    <main className="settings-panel">{visible && <UpdateSettingsSection />}</main>
  </UiLocaleProvider>
}
createRoot(document.getElementById('root')!).render(<Harness />)

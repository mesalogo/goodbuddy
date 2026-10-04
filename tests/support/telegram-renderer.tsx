import { createRoot } from 'react-dom/client'
import { ChannelSettingsSection } from '../../src/renderer/src/ChannelSettingsSection'
import { UiLocaleProvider } from '../../src/renderer/src/i18n/UiLocaleProvider'
import { changeUiLocale } from '../../src/renderer/src/i18n'
import '../../src/renderer/src/styles.css'

// All reads and actions use the unmodified production preload bridge.
await changeUiLocale('en-US')
const projects = await window.goodbuddy.projects.list()
createRoot(document.getElementById('root')!).render(
  <UiLocaleProvider initialPreference="en-US">
    <ChannelSettingsSection initialChannel="telegram" projectList={projects}
      onUpdateProject={(id, input) => window.goodbuddy.projects.update(id, input)} />
  </UiLocaleProvider>
)

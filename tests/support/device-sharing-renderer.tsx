import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { ApplicationCenter } from '../../src/renderer/src/ApplicationCenter'
import { DeviceSharingPage } from '../../src/renderer/src/DeviceSharingPage'
import { applicationSettingsSchema, defaultLocalToolEnvironmentSettings } from '../../src/shared/application-settings-contracts'
import { UiLocaleProvider } from '../../src/renderer/src/i18n/UiLocaleProvider'
import '../../src/renderer/src/styles.css'

const settings = applicationSettingsSchema.parse({ checkUpdatesOnStartup: false, updateSource: 'github', modelDownloadSource: 'modelscope',
  localToolEnvironment: defaultLocalToolEnvironmentSettings, conversationHtmlRenderingEnabled: true, remoteProjectsEnabled: false })
function Harness(): React.JSX.Element {
  const [open, setOpen] = useState(true)
  const [page, setPage] = useState(false)
  return <UiLocaleProvider initialPreference="en-US">
    {open && <ApplicationCenter settings={settings} pending={false} onClose={() => setOpen(false)}
      onOpen={id => { if (id === 'device-sharing') { setPage(true); setOpen(false) } }}
      onUpdate={async () => false} onRetry={() => undefined} />}
    {page && <DeviceSharingPage notify={input => { document.documentElement.dataset.notification = input.message }} />}
  </UiLocaleProvider>
}
createRoot(document.getElementById('root')!).render(<Harness />)

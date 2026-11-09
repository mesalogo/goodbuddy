import React from 'react'
import { createRoot } from 'react-dom/client'
import '../../src/renderer/src/i18n'
import '../../src/renderer/src/styles.css'
import { SpeechConnectionSettings } from '../../src/renderer/src/SpeechConnectionSettings'

function Fixture() {
  const [notification, setNotification] = React.useState('')
  return <main className="settings-panel">
    <SpeechConnectionSettings onDirtyChange={() => undefined} onNotify={notice => setNotification(notice.message)}>
      <p>Local model controls</p>
    </SpeechConnectionSettings>
    <p id="notification">{notification}</p>
  </main>
}
createRoot(document.getElementById('root')!).render(<Fixture />)

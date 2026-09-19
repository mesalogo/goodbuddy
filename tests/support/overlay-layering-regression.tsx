import { useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { AppNotificationViewport } from '../../src/renderer/src/App'
import { SettingsPanel } from '../../src/renderer/src/SettingsPanel'
import { ApplicationCenter } from '../../src/renderer/src/ApplicationCenter'
import LocalInferencePage from '../../src/renderer/src/LocalInferencePage'
import { defaultRuntimeSettings } from '../../src/shared/contracts'
import { UiLocaleProvider } from '../../src/renderer/src/i18n/UiLocaleProvider'
import { applyAppearanceTheme } from '../../src/renderer/src/theme'
import '../../src/renderer/src/styles.css'

const snapshot = {
  settings: { chatWorkflow: 'auto', knowledgeWorkflow: 'complete-index', localOcrModelId: 'pp-ocrv6-tiny', maximumPages: 100, pageTimeoutSeconds: 60 },
  status: { nativeParsingAvailable: true, conversionAvailable: false,
    localOcr: { id: 'pp-ocrv6-tiny', displayName: 'PP-OCRv6 Tiny', available: false, verified: false, runtime: 'onnxruntime-web-wasm', detail: 'Fixture: not installed' } },
  ocrModels: { rootDirectory: '', selectedDownloadSource: 'modelscope', catalog: [], installed: [], operations: [] }
}
Object.defineProperty(window, 'goodbuddy', { value: {
  settings: { getRuntime: async () => ({ ...defaultRuntimeSettings, modelProfiles: [], embeddingConnections: [],
    opencodeModelSource: { kind: 'platform' }, continueModelSource: { kind: 'platform' }, deepseekHarnessModelSource: { kind: 'platform' } }),
    detectAgentRuntimes: async () => ({}) },
  documentParsing: { getSnapshot: async () => snapshot, releaseResult: async () => undefined,
    test: async () => ({ fileName: 'fixture.txt', sourceFormat: 'TXT', method: 'native', pageCount: 1,
      ocrPageCount: 0, characterCount: 15, durationMs: 1, preview: 'Fixture result', warnings: [] }) },
  localInference: { getSnapshot: async () => ({ services: [], tasks: [] }) }
} })

function Fixture(): React.JSX.Element {
  const [modal, setModal] = useState('')
  const [notifications, setNotifications] = useState<Array<{ id: string; message: string; tone: 'error' | 'success'; revision: number }>>([])
  const native = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const notify = (event: Event): void => {
      const tone = (event as CustomEvent).detail === 'success' ? 'success' : 'error'
      setNotifications(items => [...items, { id: crypto.randomUUID(), message: 'Overlay regression notification', tone, revision: 1 }])
    }
    const theme = (event: Event): void => applyAppearanceTheme((event as CustomEvent).detail)
    window.addEventListener('fixture-notify', notify)
    window.addEventListener('fixture-theme', theme)
    return () => { window.removeEventListener('fixture-notify', notify); window.removeEventListener('fixture-theme', theme) }
  }, [])
  return <div className="app-shell">
    <div><button id="settings" onClick={() => setModal('settings')}>Settings</button>
      <button id="applications" onClick={() => setModal('applications')}>Applications</button>
      <button id="inference" onClick={() => setModal('inference')}>Inference</button>
      <button id="native" onClick={() => native.current!.showModal()}>Native dialog</button></div>
    <AppNotificationViewport notifications={notifications} dispatch={action => {
      if ('dismiss' in action) setNotifications(items => items.filter(item => item.id !== action.dismiss))
    }} />
    {modal === 'settings' && <SettingsPanel open initialCategory="document-parsing" onClose={() => setModal('')}
      onSaved={() => {}} onUpdateProject={async () => { throw new Error('Unused fixture API') }} projects={[]} onClearLocalData={async () => {}} />}
    {modal === 'applications' && <ApplicationCenter pending={false} onClose={() => setModal('')}
      onOpen={() => {}} onUpdate={async () => true} onRetry={() => {}} />}
    {modal === 'inference' && <LocalInferencePage onClose={() => setModal('')} />}
    <dialog ref={native}><button onClick={() => native.current!.close()}>Close native</button></dialog>
  </div>
}

createRoot(document.getElementById('root')!).render(<UiLocaleProvider initialPreference="zh-CN"><Fixture /></UiLocaleProvider>)

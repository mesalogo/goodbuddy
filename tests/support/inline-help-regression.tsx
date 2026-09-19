import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { createRoot } from 'react-dom/client'
import { InlineHelp } from '../../src/renderer/src/InlineHelp'
import { PageHeader } from '../../src/renderer/src/WorkspacePrimitives'
import { SettingsSectionHeader } from '../../src/renderer/src/SettingsPrimitives'
import { activateModalFocus, trapTabFocus } from '../../src/renderer/src/dialog-focus'
import { ApplicationCenter } from '../../src/renderer/src/ApplicationCenter'
import { SettingsPanel } from '../../src/renderer/src/SettingsPanel'
import { KnowledgeRetrievalWorkbench } from '../../src/renderer/src/KnowledgeRetrievalWorkbench'
import { ActivityPanel } from '../../src/renderer/src/ActivityPanel'
import { UiLocaleProvider } from '../../src/renderer/src/i18n/UiLocaleProvider'
import { defaultRuntimeSettings } from '../../src/shared/contracts'
import { applicationSettingsSchema, defaultLocalToolEnvironmentSettings } from '../../src/shared/application-settings-contracts'
import { defaultKnowledgeRetrievalSettings } from '../../src/shared/knowledge-contracts'
import '../../src/renderer/src/styles.css'

const actions: string[] = []
const record = (action: string): void => {
  actions.push(action)
  document.documentElement.dataset.fixtureActions = JSON.stringify(actions)
}
const applicationSettings = applicationSettingsSchema.parse({
  checkUpdatesOnStartup: false, updateSource: 'github', modelDownloadSource: 'modelscope',
  localToolEnvironment: defaultLocalToolEnvironmentSettings, conversationHtmlRenderingEnabled: true,
  remoteProjectsEnabled: false, magicNoteCanvasPageCount: 3,
})
const profileId = '00000000-0000-4000-8000-000000000001'
Object.defineProperty(window, 'goodbuddy', { value: {
  settings: {
    getRuntime: async () => ({ ...defaultRuntimeSettings, modelProfiles: [{
      id: profileId, name: 'Help regression model', modelName: 'fixture-model', baseUrl: 'https://example.invalid',
      protocol: 'anthropic-messages', authentication: 'none', imageGenerationQuality: 'auto',
      apiKeyConfigured: false, credentialSource: 'none', contextWindowTokens: 128000, maximumOutputTokens: 16000,
      requestHeaders: { 'x-fixture': 'preserve-me' }, requestBody: { temperature: 0.4 },
    }], defaultModelProfileId: profileId, embeddingConnections: [],
      opencodeModelSource: { kind: 'platform' }, continueModelSource: { kind: 'platform' }, deepseekHarnessModelSource: { kind: 'platform' } }),
    detectAgentRuntimes: async () => ({}),
    updateRuntime: async () => { record('runtime-save'); throw new Error('Unexpected save') },
    testModelConnection: async () => { record('model-call'); throw new Error('Model calls forbidden in help regression') },
  },
} })

function Modal({ close }: { close: () => void }): React.JSX.Element {
  const first = useRef<HTMLButtonElement>(null)
  useEffect(() => activateModalFocus(() => first.current), [])
  useEffect(() => {
    const escape = (event: KeyboardEvent): void => { if (event.key === 'Escape') close() }
    document.addEventListener('keydown', escape, true)
    return () => document.removeEventListener('keydown', escape, true)
  }, [close])
  return createPortal(<div className="settings-backdrop">
    <section role="dialog" aria-modal="true" aria-label="Help fixture" style={{ width: 'calc(100% - 32px)', maxWidth: 700,
      maxHeight: 'calc(100% - 32px)', overflow: 'auto', padding: 16, background: 'var(--surface-raised)' }}
      onKeyDown={event => trapTabFocus(event, event.currentTarget)}>
      <button id="outside" ref={first}>Outside</button>
      <PageHeader headingId="page" title="Page" help="Page help" />
      <SettingsSectionHeader headingId="section" title="Section" description="Description" help="Section help" />
      <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
        <InlineHelp label="Long help" id="long-help">{'Long unbroken text: ' + 'abcdefghij'.repeat(150)}</InlineHelp>
      </div>
    </section>
  </div>, document.body)
}
function Fixture(): React.JSX.Element {
  const [view, setView] = useState('')
  const [settings, setSettings] = useState(applicationSettings)
  return <div className="app-shell"><div>
    <button id="open" onClick={() => setView('isolated')}>Open modal</button>
    <button id="applications" onClick={() => setView('applications')}>Applications</button>
    <button id="settings" onClick={() => setView('settings')}>Settings</button>
    <button id="retrieval" onClick={() => setView('retrieval')}>Retrieval</button>
    <button id="activity" onClick={() => setView('activity')}>Activity</button>
    <button id="home" onClick={() => setView('')}>Home</button>
  </div>
    {view === 'isolated' && <Modal close={() => setView('')} />}
    {view === 'applications' && <ApplicationCenter settings={settings} pending={false} onClose={() => setView('')}
      onOpen={() => record('application-open')} onRetry={() => record('application-retry')}
      onUpdate={async patch => { record('application-update'); setSettings(current => ({ ...current, ...patch })); return true }} />}
    {view === 'settings' && <SettingsPanel open initialCategory="model" projects={[]} onClose={() => setView('')}
      onSaved={() => record('settings-saved')} onClearLocalData={async () => record('clear-data')}
      onUpdateProject={async () => { throw new Error('Unexpected project update') }} />}
    {view === 'retrieval' && <KnowledgeRetrievalWorkbench libraryName="Help regression library" initialQuery="Preserve this query"
      settings={defaultKnowledgeRetrievalSettings} graphAvailable onClose={() => setView('')}
      onTest={() => record('retrieval-test')} onSaveDefaults={() => record('retrieval-save')}
      onOpenSource={() => record('source-open')} onViewContext={() => record('context-open')} />}
    {view === 'activity' && <main style={{ width: '100%', minWidth: 0, padding: 16 }}><ActivityPanel records={[]}
      tokenUsage={{ records: [], totals: { callCount: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 } }}
      onClear={() => record('activity-clear')} onOpenConversation={() => record('conversation-open')} /></main>}
  </div>
}
createRoot(document.getElementById('root')!).render(<UiLocaleProvider initialPreference="zh-CN"><Fixture /></UiLocaleProvider>)

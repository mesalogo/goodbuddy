import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { SettingsPanel } from '../../src/renderer/src/SettingsPanel'
import { DEFAULT_WORKBAR_INSTANCES, WorkbarShell } from '../../src/renderer/src/WorkbarShell'
import { UiLocaleProvider } from '../../src/renderer/src/i18n/UiLocaleProvider'
import { changeUiLocale } from '../../src/renderer/src/i18n'
import { applyAppearanceTheme } from '../../src/renderer/src/theme'
import { installBundledUiFonts } from '../../src/renderer/src/fonts'
import { defaultRuntimeSettings, type DesktopApi } from '../../src/shared/contracts'
import type { WorkbarTabInstance } from '../../src/shared/workbar-contracts'
import type { ApplicationSettingsUpdate, ModelDownloadSource } from '../../src/shared/application-settings-contracts'
import '../../src/renderer/src/styles.css'

const query = new URLSearchParams(location.search)
const locale = query.get('locale') === 'en-US' ? 'en-US' : 'zh-CN'
const longName = locale === 'en-US'
  ? 'Organization shared model connection for document processing and analysis'
  : '\u7ec4\u7ec7\u5185\u90e8\u6587\u6863\u5904\u7406\u4e0e\u5206\u6790\u4e13\u7528\u5171\u4eab\u6a21\u578b\u8fde\u63a5'
const profileId = '10000000-0000-4000-8000-000000000001'
const sourceFixture = { source: 'modelscope' as ModelDownloadSource, writes: [] as ApplicationSettingsUpdate[] }
Object.defineProperty(window, 'sourceFixture', { value: sourceFixture })
Object.defineProperty(window, 'goodbuddy', { value: {
  updates: {
    getSettings: async () => ({ modelDownloadSource: sourceFixture.source }),
    onSettingsChanged: () => () => {},
    updateSettings: async (input: ApplicationSettingsUpdate) => {
      sourceFixture.writes.push(input)
      if (input.modelDownloadSource) sourceFixture.source = input.modelDownloadSource
      return { modelDownloadSource: sourceFixture.source }
    }
  },
  settings: {
    getRuntime: async () => ({ ...defaultRuntimeSettings, modelProfiles: [{
      id: profileId, name: longName, baseUrl: 'http://fixture.invalid/v1', modelName: 'fixture-model',
      protocol: 'openai-chat-completions', authentication: 'none', imageGenerationQuality: 'auto',
      apiKeyConfigured: false, credentialSource: 'none'
    }], defaultModelProfileId: profileId, embeddingConnections: [],
    opencodeModelSource: { kind: 'platform' }, continueModelSource: { kind: 'platform' },
    deepseekHarnessModelSource: { kind: 'platform' } }),
    detectAgentRuntimes: async () => ({})
  },
  runtimeCustomization: {
    getSettings: async () => ({ opencode: {}, continue: { presets: [] } }),
    getNativeSnapshot: async () => ({ provider: 'opencode', available: false, inventoryStatus: 'unavailable',
      agents: [], tools: [], commands: [], lsp: [], formatters: [], mcpServers: [], skills: [], rules: [], prompts: [], resources: [],
      context: { strategy: 'goodbuddy-summary', manualCompact: false, detail: 'Fixture' } })
  }
} as unknown as DesktopApi })

function WorkbarFixture(): React.JSX.Element {
  const [instances, setInstances] = useState<readonly WorkbarTabInstance[]>(DEFAULT_WORKBAR_INSTANCES.map((item, index) => ({
    ...item, title: locale === 'en-US' ? ['Task center', 'Workspace', 'Browser', 'Results'][index]! : item.title
  })))
  const [active, setActive] = useState<string | null>(instances[0]!.id)
  return <>
    <button id="many-tabs" onClick={() => setInstances(current => [...current, ...Array.from({ length: 12 }, (_, index) => ({
      id: `extra-${index}`, appId: 'browser' as const, title: `${longName} ${index + 1}`
    }))])}>More tabs</button>
    <aside className="assistant-sidebar assistant-sidebar--open" style={{ width: 300, flexBasis: 300, height: 480 }}>
      <WorkbarShell instances={instances} activeInstanceId={active} onActiveInstanceChange={setActive}
        onCreateInstance={({ appId }) => {
          const id = `created-${instances.length}`
          setInstances(current => [...current, { id, appId, title: `${appId} ${instances.length}` }])
          setActive(id)
        }}
        onCloseInstance={instance => setInstances(current => current.filter(item => item.id !== instance.id))}
        onResolveTerminalTarget={() => ({ type: 'local' })} renderPanel={instance => <p>{instance.title}</p>} />
    </aside>
  </>
}

function Fixture(): React.JSX.Element {
  return <UiLocaleProvider initialPreference={locale}>
    {query.get('surface') === 'settings'
      ? <SettingsPanel open initialCategory="model" projects={[]} onClose={() => {}} onSaved={() => {}}
          onUpdateProject={async () => { throw new Error('Unused fixture API') }} onClearLocalData={async () => {}} />
      : <WorkbarFixture />}
  </UiLocaleProvider>
}

installBundledUiFonts()
applyAppearanceTheme(query.get('theme') === 'dark' ? 'dark' : 'light')
void changeUiLocale(locale).then(() => createRoot(document.getElementById('root')!).render(<Fixture />))

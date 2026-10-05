import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { ChatHistoryPane } from '../../src/renderer/src/ChatHistoryPane'
import type { Conversation } from '../../src/renderer/src/chat-conversation'
import { PageShell } from '../../src/renderer/src/WorkspacePrimitives'
import { UiLocaleProvider } from '../../src/renderer/src/i18n/UiLocaleProvider'
import { changeUiLocale } from '../../src/renderer/src/i18n'
import { SupervisorWorkspace } from '../../src/renderer/src/SupervisorWorkspace'
import '../../src/renderer/src/supervisor-workspace.css'
import '../../src/renderer/src/styles.css'

const count = Number(new URLSearchParams(location.search).get('count') ?? 2000)
const conversation: Conversation = { id: 'synthetic', title: 'Synthetic history', updatedAt: 1,
  messages: Array.from({ length: count }, (_, index) => ({
    id: `m${index}`, role: 'assistant', state: 'complete', createdAt: index + 1,
    content: `Synthetic message ${index}. ${'A paragraph of rendered history. '.repeat(8)}`,
    reasoning: `Reasoning ${index}. ${'A reasoning paragraph. '.repeat(8)}`,
    tools: [{ callId: `tool${index}`, name: 'read', summary: `Read synthetic file ${index}`, state: 'completed',
      input: '{"path":"synthetic.txt"}', output: 'Synthetic output\n'.repeat(8) }]
  })) }
const noop = (): void => {}
const complete = async (): Promise<void> => {}
const artifacts = new Map()

// Fixture-only retention probe. Restore Map.set as soon as the expansion map
// first writes; no production diagnostic API or persistent instrumentation.
const expansionMaps = new Set<Map<unknown, unknown>>()
const originalSet = Map.prototype.set
Map.prototype.set = function (key, value) {
  if (value && typeof value.open === 'boolean' && typeof value.automaticOpen === 'boolean') {
    expansionMaps.add(this)
    Map.prototype.set = originalSet
  }
  return originalSet.call(this, key, value)
}
Object.assign(window, { expansionEntryCount: () => [...expansionMaps].reduce((total, map) => total + map.size, 0) })

function Fixture() {
  const [current, setCurrent] = useState(conversation)
  const [navigation, setNavigation] = useState({ conversationId: conversation.id, messageId: 'm0', requestId: 1 })
  Object.assign(window, {
    expansionNavigate: (index: number) => setNavigation(current => ({ ...current, messageId: `m${index}`, requestId: current.requestId + 1 })),
    expansionDeleteMessages: () => setCurrent({ ...conversation, messages: [] })
  })
  return <div className="app-shell"><div className="app-frame"><header className="topbar">Synthetic expansion validation</header>
    <div className="app-content"><main className="workspace"><PageShell variant="reading"><div className="chat-scroll-region">
      <ChatHistoryPane conversation={current} active artifactById={artifacts} locale="en-US"
        conversationHtmlRenderingEnabled={false} noteMessageNavigation={navigation}
        onOpenImageModelSettings={noop} onReselectImageSources={noop} onEditImage={noop}
        onCopyMessage={async () => true} onDownloadImage={noop} onOpenCitationContext={complete}
        onOpenCitationSource={complete} onOpenImage={noop} onRespondQuestion={complete} onRetry={noop}
        onScrollSnapshotChange={noop} onSetInput={noop} quickActions={[]} visibleMessageCount={count}
        onVisibleMessageCountChange={noop} />
    </div><footer className="composer-wrap"><textarea aria-label="Composer" defaultValue="Preserved draft" /></footer></PageShell></main></div>
  </div></div>
}
const supervisor = new URLSearchParams(location.search).has('supervisor')
if (supervisor) {
  const at = '2026-10-01T00:00:00.000Z'
  let graphReads = 0
  Object.assign(window, { goodbuddy: { supervision: {
    overview: async () => [{ id: 'result', storyLineId: 'story', sourceId: null, summary: 'Synthetic review', changeDigest: '',
      createdAt: at, scope: { kind: 'global' }, timeRange: { from: at, to: at }, openItems: [] }],
    graph: async () => {
      const read = ++graphReads
      // Keep the replacement read pending long enough to expose partial-state waits.
      if (read > 1) await new Promise(resolve => setTimeout(resolve, 100))
      return { storyLine: null, events: [{ id: 'event', title: 'Event', description: '', occurred_at: at }],
      entities: [], relations: [], eventEntities: [], sources: [{ id: 'source', title: `Synthetic source ${read}`, occurred_at: at }],
      eventSources: [{ event_id: 'event', source_id: 'source' }] }
    },
    source: () => new Promise(resolve => Object.assign(window, { finishSource: () => resolve({ title: 'Synthetic source', content: 'Stale content', occurredAt: at }) }))
  } } })
}
createRoot(document.getElementById('root')!).render(<UiLocaleProvider initialPreference="zh-CN">{supervisor
  ? <><button id="change-language" onClick={() => void changeUiLocale('en-US')}>Change language</button><SupervisorWorkspace tab="graph" /></>
  : <Fixture />}</UiLocaleProvider>)

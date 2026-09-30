import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { ChatHistoryPane } from '../../src/renderer/src/ChatHistoryPane'
import type { Conversation } from '../../src/renderer/src/chat-conversation'
import { RuntimeChecklistStrip } from '../../src/renderer/src/RuntimeChecklistStrip'
import { PageShell } from '../../src/renderer/src/WorkspacePrimitives'
import { UiLocaleProvider } from '../../src/renderer/src/i18n/UiLocaleProvider'
import '../../src/renderer/src/styles.css'

const conversations: Conversation[] = ['a', 'b'].map(id => ({
  id, title: id, updatedAt: 1,
  messages: Array.from({ length: 100 }, (_, index) => ({
    id: `${id}-${index}`, role: 'user', createdAt: index + 1, state: 'complete',
    content: `Message ${id}-${index}: Scroll this actual chat content behind the title bar.\n\nSecond paragraph for a visible message surface.`,
  })),
}))
conversations.push({ id: 'short', title: 'Short', updatedAt: 1, messages: [conversations[0].messages[0]] })
const noop = (): void => {}
const complete = async (): Promise<void> => {}
const artifacts = new Map()

function Fixture(): React.JSX.Element {
  const [active, setActive] = useState('a')
  const [route, setRoute] = useState('chat')
  const [context, setContext] = useState(true)
  const [counts, setCounts] = useState<Record<string, number>>({ a: 80, b: 100, short: 100 })
  const [clicks, setClicks] = useState(0)
  return <><div className="app-shell"><div className="app-frame">
    <header className="topbar"><button data-clicks={clicks} onClick={() => setClicks(clicks + 1)}>Button</button>
      <input aria-label="Input" /><select aria-label="Select"><option>Option</option></select>
      <button id="switch-conversation" onClick={() => setActive(active === 'a' ? 'b' : 'a')}>Conversation</button>
      <button id="switch-route" onClick={() => setRoute(route === 'chat' ? 'activity' : 'chat')}>Route</button>
      <button id="switch-context" onClick={() => setContext(!context)}>Context</button>
      <button id="short-chat" onClick={() => setActive('short')}>Short</button>
      <div className="topbar__actions">Actions</div>
      <div className="window-controls"><button className="window-control">X</button></div>
    </header>
    <div className="app-content"><main className="workspace">
      <div className="workspace-route-cache" data-route="chat" hidden={route !== 'chat'}>
        <PageShell variant="reading"><div className="chat-scroll-region">
          {conversations.map(conversation => <ChatHistoryPane key={conversation.id}
            conversation={conversation} active={route === 'chat' && active === conversation.id}
            artifactById={artifacts} conversationHtmlRenderingEnabled={false} locale="en-US"
            onOpenImageModelSettings={noop} onReselectImageSources={noop} onEditImage={noop}
            onCopyMessage={async () => true} onDownloadImage={noop} onOpenCitationContext={complete}
            onOpenCitationSource={complete} onOpenImage={noop} onRespondApproval={complete}
            onRespondQuestion={complete} onRetry={noop} onScrollSnapshotChange={noop}
            onSetInput={noop} quickActions={[]} visibleMessageCount={counts[conversation.id]}
            onVisibleMessageCountChange={(id, count) => setCounts(current => ({ ...current, [id]: count }))}
            taskStrip={context ? <div className="conversation-context-strips"><RuntimeChecklistStrip messages={[{
              id: 'glass', role: 'assistant', content: '', createdAt: 1, state: 'streaming',
              runtimeChecklist: { source: 'opencode', items: [
                { content: 'Inspect', status: 'completed' },
                { content: 'Implement', status: 'in_progress' },
                { content: 'Verify', status: 'pending' },
              ] },
            }]} /></div> : undefined}
          />)}
        </div><footer className="composer-wrap"><textarea aria-label="Composer" defaultValue="Draft" /></footer></PageShell>
      </div>
      <div className="workspace-route-cache" data-route="activity" hidden={route === 'chat'}><PageShell variant="dashboard">Activity</PageShell></div>
    </main><aside data-workbar style={{ width: 300, flexShrink: 0 }}>Workbar</aside></div>
  </div></div><div className="anchored-menu" data-ordinary-menu="true">Ordinary menu</div></>
}

createRoot(document.getElementById('root')!).render(<UiLocaleProvider><Fixture /></UiLocaleProvider>)

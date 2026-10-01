import { useLayoutEffect, useMemo, useState } from 'react'
import { flushSync } from 'react-dom'
import { createRoot } from 'react-dom/client'
import { ChatTimeline, type Message } from '../../src/renderer/src/ChatTimeline'
import { UiLocaleProvider } from '../../src/renderer/src/i18n/UiLocaleProvider'
import '../../src/renderer/src/fonts'
import '../../src/renderer/src/styles.css'

const epoch = () => performance.timeOrigin + performance.now()
const inputs: { at: number; frame: number; value: string; trusted: boolean }[] = []
const tasks: number[] = []
let collecting = false
let committed = ''
let committedDraft = ''
let updates = 0
let received = 0
let firstCommit = 0
let lastCommit = 0
let setContent: (update: string | ((previous: string) => string)) => void
let setDraft: (value: string) => void
const observer = new PerformanceObserver(list => {
  if (collecting) tasks.push(...list.getEntries().map(entry => entry.duration))
})
observer.observe({ type: 'longtask' })
const callbacks = {
  onArticleRef: () => {}, onCopyMessage: async () => true,
  onDownloadImage: () => {}, onOpenCitationContext: async () => {},
  onOpenCitationSource: async () => {}, onOpenImage: () => {},
  onRespondApproval: async () => {}, onRespondQuestion: async () => {},
  onRetry: () => {}, onRevealEarlier: () => {}
}
const artifacts = new Map()
const initial: Message = { id: 'answer', role: 'assistant', content: '', createdAt: 1, state: 'streaming' }
function Bench() {
  const [content, updateContent] = useState('')
  const [draft, updateDraft] = useState('')
  // Preserve ChatTimeline's production memo boundary when only the composer changes.
  const messages = useMemo(() => [{ ...initial, content }], [content])
  setContent = updateContent
  setDraft = updateDraft
  useLayoutEffect(() => {
    committed = content
    if (collecting && content) {
      updates++
      lastCommit = epoch()
      if (!firstCommit) firstCommit = lastCommit
    }
  }, [content])
  useLayoutEffect(() => { committedDraft = draft }, [draft])
  return <UiLocaleProvider initialPreference="en-US">
    <main style={{ height: '100vh', display: 'flex', flexDirection: 'column', padding: 16 }}>
      <section id="answer" style={{ flex: 1, overflow: 'auto' }}>
        <ChatTimeline {...callbacks} artifactById={artifacts} conversationId="benchmark"
          hiddenMessageCount={0} isUnusedConversation={false} locale="en-US"
          messageStartIndex={0} messages={messages} totalMessageCount={1} />
      </section>
      <textarea aria-label="Draft" id="draft" value={draft} rows={3}
        onInput={event => {
          if (!collecting) return
          const sample = { at: epoch(), frame: 0, value: event.currentTarget.value,
            trusted: event.nativeEvent.isTrusted }
          inputs.push(sample)
          // Callback execution time includes work queued before this frame; the rAF timestamp does not.
          requestAnimationFrame(() => { sample.frame = epoch() })
        }} onChange={event => updateDraft(event.target.value)} />
    </main>
  </UiLocaleProvider>
}
flushSync(() => createRoot(document.getElementById('root')!).render(<Bench />))
const bridge = (window as unknown as {
  streamingInputBridge: { onChunk: (callback: (delta: string) => void) => void }
}).streamingInputBridge
bridge.onChunk(delta => { received++; setContent(previous => previous + delta) })
const nextFrame = () => new Promise<void>(resolve => requestAnimationFrame(() => resolve()))
Object.assign(window, { streamingInput: {
  async reset(content = '') {
    collecting = false
    flushSync(() => { setContent(content); setDraft('') })
    await document.fonts.ready
    await nextFrame()
    await nextFrame()
    inputs.length = 0
    tasks.length = 0
    observer.takeRecords()
    updates = received = firstCommit = lastCommit = 0
    document.getElementById('draft')!.focus()
    collecting = true
    return document.getElementById('answer')!.textContent
  },
  clock: epoch,
  status: () => ({ length: committed.length, inputs: inputs.length, frames: inputs.filter(input => input.frame).length }),
  async result() {
    await nextFrame()
    await nextFrame()
    tasks.push(...observer.takeRecords().map(entry => entry.duration))
    collecting = false
    return { committed, committedDraft, domText: document.getElementById('answer')!.textContent,
      draft: (document.getElementById('draft') as HTMLTextAreaElement).value,
      focused: document.activeElement?.id === 'draft', inputs, tasks, updates, received, firstCommit, lastCommit }
  }
} })

import { afterEach, expect, it, vi } from 'vitest'
import { createConversationStore } from './conversation-store'
import { createLiveMessageStore } from './live-message-store'
import { createConversationPersistence } from './conversation-persistence'
import { createMessageEditStore } from './message-edit-store'
import type { Conversation } from './chat-conversation'

afterEach(() => vi.unstubAllGlobals())
function fixture() {
  const source: Conversation = { id: 'source', title: 'original', updatedAt: 1, messages: [
    { id: 'first', role: 'user', content: 'first', state: 'complete', createdAt: 1 },
    { id: 'reply', role: 'assistant', content: 'old reply', state: 'complete', createdAt: 2 },
    { id: 'edit', role: 'user', content: 'old question', state: 'complete', createdAt: 3, attachments: [{ id: 'asset', name: 'file.txt', size: 1, preview: 'x', kind: 'text' }] },
  ] }
  const conversations = createConversationStore([source], createLiveMessageStore())
  const persistence = createConversationPersistence({ store: conversations, intervalMs: 500, api: { saveLocal: vi.fn(async () => undefined), get: vi.fn() } })
  persistence.acknowledged().set(source.id, source)
  persistence.connect({ retainedConversationIds: () => new Set(['source', 'branch']), hasBusyTask: () => false, pinState: () => ({ revision: 0, pending: false }), historyUnavailableError: () => new Error('missing'), onSaveFailed: () => undefined })
  const branch = { ...source, id: 'branch', messages: source.messages.slice(0, 2) }
  const branchLocal = vi.fn(async () => branch)
  const enqueueUser = vi.fn(async () => ({}))
  const saveDraft = vi.fn(async () => [])
  const selectFiles = vi.fn(async () => [{ id: 'added', name: 'added.txt', size: 1, preview: 'new', kind: 'text' as const }])
  const remove = vi.fn(async () => undefined)
  vi.stubGlobal('goodbuddy', undefined)
  Object.defineProperty(window, 'goodbuddy', { configurable: true, value: { conversations: { branchLocal }, conversationQueue: { enqueueUser }, context: { remove, saveDraft, selectFiles } } })
  const openConversation = vi.fn(), setDraft = vi.fn(), unavailable = vi.fn<() => string | undefined>(() => undefined)
  const store = createMessageEditStore(() => ({ conversations, persistence, flush: () => persistence.persist(), unavailable,
    queueDefaults: () => ({ knowledgeLibraryIds: [] }), openConversation, setDraft, branchTitle: () => 'branch', fallbackError: () => 'failed', attachmentLimitError: () => 'too many attachments' }))
  return { source, conversations, branchLocal, enqueueUser, saveDraft, selectFiles, remove, openConversation, setDraft, unavailable, store }
}

it('opens only user messages and cancels without writes or touching the composer', async () => {
  const f = fixture()
  f.store.open('source', 'reply')
  expect(f.store.getState()).toBeUndefined()
  f.store.open('source', 'edit')
  f.store.setContent('changed')
  await f.store.cancel()
  expect(f.store.getState()).toBeUndefined()
  expect(f.branchLocal).not.toHaveBeenCalled()
  expect(f.setDraft).not.toHaveBeenCalled()
})

it('registers the destination before early queue dispatch and submits once with edited text and attachments', async () => {
  const f = fixture()
  f.enqueueUser.mockImplementation(async () => {
    expect(f.conversations.getConversation('branch')?.messages.map(m => m.content)).toEqual(['first', 'old reply'])
    return {}
  })
  f.store.open('source', 'edit')
  f.store.setContent('new question')
  await Promise.all([f.store.submit(), f.store.submit()])
  expect(f.branchLocal).toHaveBeenCalledExactlyOnceWith({ sourceConversationId: 'source', beforeMessageId: 'edit', title: 'branch' })
  expect(f.enqueueUser).toHaveBeenCalledTimes(1)
  expect(f.enqueueUser).toHaveBeenCalledWith(expect.objectContaining({ conversationId: 'branch', prompt: 'new question', attachments: f.source.messages[2]!.attachments }))
  expect(f.openConversation).toHaveBeenCalledWith('branch')
  expect(f.conversations.getConversation('source')).toBe(f.source)
  expect(f.store.getState()).toBeUndefined()
})

it('retains the editor after copy failure and reuses an existing branch after enqueue failure', async () => {
  const f = fixture()
  f.branchLocal.mockRejectedValueOnce(new Error('disk full'))
  f.store.open('source', 'edit')
  f.store.setContent('edited')
  await f.store.submit()
  expect(f.store.getState()).toMatchObject({ content: 'edited', error: 'disk full', submitting: false })
  f.enqueueUser.mockRejectedValueOnce(new Error('missing attachment'))
  await f.store.submit()
  expect(f.store.getState()).toMatchObject({ branch: { id: 'branch' }, error: 'missing attachment' })
  f.store.removeAttachment('asset')
  await f.store.submit()
  expect(f.branchLocal).toHaveBeenCalledTimes(2)
  expect(f.enqueueUser).toHaveBeenLastCalledWith(expect.objectContaining({ attachments: [] }))
})

it('keeps a failed-send branch draft when cancelling and blocks busy or empty submissions', async () => {
  const f = fixture()
  f.store.open('source', 'edit')
  f.unavailable.mockReturnValue('busy')
  await f.store.submit()
  expect(f.branchLocal).not.toHaveBeenCalled()
  f.unavailable.mockReturnValue(undefined)
  f.store.setContent('   ')
  await f.store.submit()
  expect(f.branchLocal).not.toHaveBeenCalled()
  f.store.setContent('edited')
  f.enqueueUser.mockRejectedValueOnce(new Error('offline'))
  await f.store.submit()
  await f.store.cancel()
  expect(f.saveDraft).toHaveBeenCalledWith('branch', ['asset'])
  expect(f.setDraft).toHaveBeenCalledWith('branch', 'edited')
})

it('adds files independently of the source draft and only releases newly imported resources on cancel', async () => {
  const f = fixture()
  f.store.open('source', 'edit')
  await f.store.addFiles()
  expect(f.selectFiles).toHaveBeenCalledWith()
  expect(f.store.getState()?.attachments.map(item => item.id)).toEqual(['asset', 'added'])
  f.store.removeAttachment('asset')
  expect(f.source.messages[2]!.attachments?.map(item => item.id)).toEqual(['asset'])
  await f.store.cancel()
  expect(f.remove).toHaveBeenCalledExactlyOnceWith('added')
  expect(f.saveDraft).not.toHaveBeenCalled()
})

it('releases a rejected over-limit import immediately while retaining the original selection', async () => {
  const f = fixture()
  f.selectFiles.mockResolvedValueOnce(Array.from({ length: 8 }, (_, index) => ({ id: `extra-${index}`, name: 'extra.txt', size: 1, preview: 'x', kind: 'text' })))
  f.store.open('source', 'edit')
  await f.store.addFiles()
  expect(f.store.getState()).toMatchObject({ addingFiles: false, error: 'too many attachments' })
  expect(f.store.getState()?.attachments.map(item => item.id)).toEqual(['asset'])
  expect(f.remove).toHaveBeenCalledTimes(8)
  await f.store.cancel()
  expect(f.remove).toHaveBeenCalledTimes(8)
})

it('hands imported attachments to the accepted queue without removing an in-flight context', async () => {
  const f = fixture()
  f.store.open('source', 'edit')
  await f.store.addFiles()
  await f.store.submit()
  expect(f.enqueueUser).toHaveBeenCalledWith(expect.objectContaining({ attachments: expect.arrayContaining([expect.objectContaining({ id: 'added' })]) }))
  expect(f.remove).not.toHaveBeenCalled()
})

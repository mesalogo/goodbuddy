import { expect, it, vi } from 'vitest'
import { handleAgentEvent, type AgentEventDependencies } from './agent-event-handler'
import { createConversationStore } from './conversation-store'
import { createLiveMessageStore } from './live-message-store'
import { createTaskStore } from './task-store'
import { createActivityStore } from './activity-store'
import { toConversationMessage, createLocalConversationSaveBatch } from './conversation-persistence'
import { conversationMessageSchema } from '../../shared/assistant-contracts'
import { conversationMessageResourceIds } from '../../shared/conversation-output'

it.each(['completed', 'failed', 'cancelled'] as const)('retains output references in renderer %s events, blocks and local save metadata', state => {
  const conversationId = crypto.randomUUID(), messageId = crypto.randomUUID(), requestId = crypto.randomUUID()
  const liveMessages = createLiveMessageStore()
  const store = createConversationStore([{ id: conversationId, title: 'Output', updatedAt: 0, messages: [
    { id: messageId, role: 'assistant', content: '', state: 'streaming', createdAt: 0, blocks: [] }
  ] }], liveMessages)
  const deps: AgentEventDependencies = {
    activeRuns: { current: new Map([[requestId, { conversationId, messageId, runtimeSelectionKey: 'model' }]]) },
    activeConversationIdRef: { current: conversationId }, activeProjectIdRef: { current: '' },
    hydratingArtifactIds: { current: new Set() }, requestPersistenceFlush: vi.fn(),
    tRef: { current: ((key: string) => key) as AgentEventDependencies['tRef']['current'] },
    conversationStore: store, liveMessages, setConversations: store.set,
    taskStore: createTaskStore(), activityStore: createActivityStore(), setUnreadConversationIds: vi.fn(),
    notify: vi.fn(), updateMessage: (id, mid, update) => store.set(current => current.map(conversation =>
      conversation.id === id ? { ...conversation, messages: conversation.messages.map(message => message.id === mid ? update(message) : message) } : conversation)),
    recordActivity: vi.fn(), loadWorkspaceChanges: vi.fn(), markConversationCompleted: vi.fn(),
    setConversationActivity: vi.fn(), releaseConversationQueueAfterRun: vi.fn()
  }
  const reference = { handle: `process:${crypto.randomUUID()}`, nextCursor: 5, totalBytes: 100000 }
  const childReference = { ...reference, handle: `subagent:${crypto.randomUUID()}` }
  const output = 'x'.repeat(200000)
  handleAgentEvent({ requestId, type: 'tool', callId: 'process', name: 'Process',
    state: state === 'cancelled' ? 'completed' : state, summary: 'Output', output, outputReferences: [reference] }, deps)
  handleAgentEvent({ requestId, type: 'subagent', childTaskId: crypto.randomUUID(),
    actor: { kind: 'direct-model', label: '编程 Subagent' }, routingMode: 'native', state,
    output: 'child preview', outputReference: childReference }, deps)
  const conversation = store.getState()[0]!
  const message = conversationMessageSchema.parse(toConversationMessage(conversation.messages[0]!))
  expect(message.tools?.[0]?.outputReferences).toEqual([reference])
  expect(message.blocks?.[0]).toMatchObject({ type: 'tool', tool: { outputReferences: [reference], output } })
  expect(message.subagents?.[0]?.outputReference).toEqual(childReference)
  const batch = createLocalConversationSaveBatch([conversation], new Map(), new Set()).batch
  expect(JSON.parse(JSON.stringify(batch))[0].messages[0]).toMatchObject({
    tools: [{ outputReferences: [reference], output }], subagents: [{ outputReference: childReference }]
  })
  expect(conversationMessageResourceIds(message)).toEqual([reference.handle.split(':')[1], childReference.handle.split(':')[1]])
})

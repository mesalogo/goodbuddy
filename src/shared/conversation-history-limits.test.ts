import { randomUUID } from 'node:crypto'
import { expect, it } from 'vitest'
import { agentRequestSchema, runtimeConversationCompactInputSchema } from './contracts'
import { conversationMessageSchema } from './assistant-contracts'

it('accepts full history for execution and compaction while validating message IDs', () => {
  const history = Array.from({ length: 502 }, (_, index) => ({
    role: index % 2 ? 'assistant' as const : 'user' as const,
    content: index === 0 ? 'x'.repeat(100_001) : 'x'.repeat(4_200)
  }))
  const request = {
    requestId: randomUUID(),
    conversationId: randomUUID(),
    runtimeSelection: { provider: 'continue' },
    history,
    historyMessageIds: history.map(() => randomUUID())
  }
  expect(agentRequestSchema.parse({ ...request, prompt: 'continue' }).history).toEqual(history)
  expect(runtimeConversationCompactInputSchema.parse(request).history).toEqual(history)
  expect(() => runtimeConversationCompactInputSchema.parse({
    ...request, historyMessageIds: request.historyMessageIds.slice(1)
  })).toThrow()
  expect(conversationMessageSchema.parse({
    id: randomUUID(), role: 'assistant', state: 'complete', createdAt: 0,
    content: 'x'.repeat(1_000_001)
  }).content).toHaveLength(1_000_001)
})

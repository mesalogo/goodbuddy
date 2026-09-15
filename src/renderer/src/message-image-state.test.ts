import { describe, expect, it } from 'vitest'
import type { Message } from './ChatTimeline'
import { mergeMessageImageState } from './message-image-state'

describe('mergeMessageImageState', () => {
  const message: Message = {
    id: 'message', role: 'assistant', content: 'Retained history',
    state: 'complete', createdAt: 1
  }

  it('does not mark unchanged ordinary history as dirty after a snapshot refresh', () => {
    const incoming = Array.from({ length: 1600 }, () => ({ ...message }))
    const merged = incoming.map(item => mergeMessageImageState(item, item, { ...item }))
    expect(merged.filter((item, index) => item !== incoming[index])).toHaveLength(0)
  })

  it('preserves unchanged artifact references and streaming message identity', () => {
    const persisted = { ...message, artifactIds: ['image'] }
    expect(mergeMessageImageState(persisted, persisted, { ...persisted, artifactIds: ['image'] })).toBe(persisted)
    const streaming = { ...message, state: 'streaming' as const, content: 'New text' }
    expect(mergeMessageImageState(streaming, message, streaming)).toBe(streaming)
  })

  it('merges newer local image operations without losing the selected message body', () => {
    const operation = {
      id: 'image-operation', conversationId: 'conversation', messageId: 'message',
      modelProfileId: 'profile', modelName: 'image', requestId: 'request', callId: 'call',
      input: { prompt: 'circle', intent: 'create' as const, sourceArtifactIds: [] },
      state: 'completed' as const, artifactIds: ['new-image'],
      createdAt: 1, updatedAt: 2
    }
    const local: Message = { ...message, imageOperations: [operation] }
    const result = mergeMessageImageState(message, message, local)
    expect(result.content).toBe(message.content)
    expect(result.imageOperations).toEqual([operation])
    expect(result.artifactIds).toEqual(['new-image'])
  })
})

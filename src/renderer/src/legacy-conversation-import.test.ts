import { describe, expect, it } from 'vitest'
import { stripLegacyConversationModes } from './legacy-conversation-import'

describe('legacy conversation import', () => {
  it.each(['ask', 'execute', 'plan', undefined])('strips owned %s metadata without rewriting user data', (workMode) => {
    const tool = { name: 'custom', input: { workMode: 'ask', defaultWorkMode: 'execute' }, output: 'Ask / Execute' }
    const subagent = { childTaskId: 'child', workMode, output: 'Use Execute', progress: [tool] }
    const message = { content: '/ask Keep workMode and Execute in this text', toolCalls: [tool], subagents: [subagent] }
    const original = { id: 'conversation', title: 'Ask / Execute', workMode, messages: [message] }
    const result = stripLegacyConversationModes(original) as typeof original

    expect(result).not.toHaveProperty('workMode')
    expect(result.messages[0]!.subagents[0]).not.toHaveProperty('workMode')
    expect(result.title).toBe(original.title)
    expect(result.messages[0]!.content).toBe(message.content)
    expect(result.messages[0]!.toolCalls).toEqual([tool])
    expect(result.messages[0]!.subagents[0]!.output).toBe(subagent.output)
    expect(result.messages[0]!.subagents[0]!.progress).toEqual([tool])
    expect(original).toHaveProperty('workMode', workMode)
    expect(subagent).toHaveProperty('workMode', workMode)
  })
})

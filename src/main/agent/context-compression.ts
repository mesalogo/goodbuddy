import type { ContextCompressionSettings } from '../../shared/contracts'
import {
  estimateContextInputTokens,
  estimateMessagesTokens,
  getEffectiveContextTriggerTokens
} from '../../shared/context-window'

export {
  estimateMessagesTokens,
  estimateTextTokens
} from '../../shared/context-window'

export type CompressibleConversationMessage = {
  role: 'user' | 'assistant'
  content: string
}

export type ContextCompressionPlan = {
  earlierMessages: CompressibleConversationMessage[]
  recentMessages: CompressibleConversationMessage[]
  estimatedInputTokens: number
  effectiveTriggerTokens: number
}

function groupConversationTurns(
  messages: readonly CompressibleConversationMessage[]
): CompressibleConversationMessage[][] {
  const turns: CompressibleConversationMessage[][] = []
  for (const message of messages) {
    const current = turns.at(-1)
    if (
      message.role === 'assistant' &&
      current?.at(-1)?.role === 'user'
    ) {
      current.push(message)
    } else {
      turns.push([message])
    }
  }
  return turns
}

export function planContextCompression(input: {
  history: readonly CompressibleConversationMessage[]
  prompt: string
  summaryTokens?: number
  settings: ContextCompressionSettings
  contextWindowTokens?: number
}): ContextCompressionPlan | undefined {
  const estimatedInputTokens = estimateContextInputTokens({
    history: input.history,
    prompt: input.prompt,
    summaryTokens: input.summaryTokens
  })
  const effectiveTriggerTokens = getEffectiveContextTriggerTokens({
    triggerTokens: input.settings.triggerTokens,
    contextWindowTokens: input.contextWindowTokens
  })
  if (estimatedInputTokens < effectiveTriggerTokens) {
    return undefined
  }

  const turns = groupConversationTurns(input.history)
  const recentTurns: CompressibleConversationMessage[][] = []
  const recentRawTokenBudget = Math.min(
    input.settings.recentRawTokens,
    Math.max(4_000, effectiveTriggerTokens - 8_000)
  )
  let recentTokens = 0
  while (turns.length > 0) {
    const turn = turns.at(-1)!
    const turnTokens = estimateMessagesTokens(turn)
    if (
      recentTurns.length > 0 &&
      recentTokens + turnTokens > recentRawTokenBudget
    ) {
      break
    }
    recentTurns.unshift(turns.pop()!)
    recentTokens += turnTokens
  }
  const earlierMessages = turns.flat()
  if (earlierMessages.length === 0) {
    return undefined
  }
  return {
    earlierMessages,
    recentMessages: recentTurns.flat(),
    estimatedInputTokens,
    effectiveTriggerTokens
  }
}

export function formatConversationForSummary(
  messages: readonly CompressibleConversationMessage[]
): string {
  return messages
    .map(
      (message) =>
        `${message.role === 'user' ? 'USER' : 'ASSISTANT'}:\n${message.content}`
    )
    .join('\n\n')
}

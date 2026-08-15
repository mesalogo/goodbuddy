import type { ContextCompressionSettings } from '../../shared/contracts'

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

const reservedOutputAndSafetyTokens = 12_000
const estimatedRequestOverheadTokens = 4_000

export function estimateTextTokens(value: string): number {
  let asciiCharacters = 0
  let nonAsciiCharacters = 0
  for (const character of value) {
    if (character.codePointAt(0)! <= 0x7f) {
      asciiCharacters += 1
    } else {
      nonAsciiCharacters += 1
    }
  }
  return Math.max(
    1,
    Math.ceil(asciiCharacters / 4 + nonAsciiCharacters)
  )
}

export function estimateMessagesTokens(
  messages: readonly CompressibleConversationMessage[]
): number {
  return messages.reduce(
    (total, message) => total + estimateTextTokens(message.content) + 4,
    0
  )
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
  settings: ContextCompressionSettings
  contextWindowTokens?: number
}): ContextCompressionPlan | undefined {
  const estimatedInputTokens =
    estimateMessagesTokens(input.history) +
    estimateTextTokens(input.prompt) +
    estimatedRequestOverheadTokens
  const contextLimitedTrigger =
    input.contextWindowTokens === undefined
      ? input.settings.triggerTokens
      : Math.max(
          8_000,
          input.contextWindowTokens - reservedOutputAndSafetyTokens
        )
  const effectiveTriggerTokens = Math.min(
    input.settings.triggerTokens,
    contextLimitedTrigger
  )
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

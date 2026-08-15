export const minimumModelContextWindowTokens = 32_000
export const maximumModelContextWindowTokens = 10_000_000
export const contextOutputAndSafetyTokens = 12_000
export const estimatedContextRequestOverheadTokens = 4_000

export type ContextWindowMessage = {
  role: 'user' | 'assistant'
  content: string
}

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
  messages: readonly ContextWindowMessage[]
): number {
  return messages.reduce(
    (total, message) => total + estimateTextTokens(message.content) + 4,
    0
  )
}

export function estimateContextInputTokens(input: {
  history: readonly ContextWindowMessage[]
  prompt: string
  summaryTokens?: number
}): number {
  return (
    estimateMessagesTokens(input.history) +
    estimateTextTokens(input.prompt) +
    (input.summaryTokens ?? 0) +
    estimatedContextRequestOverheadTokens
  )
}

export function getEffectiveContextTriggerTokens(input: {
  triggerTokens: number
  contextWindowTokens?: number
}): number {
  if (input.contextWindowTokens === undefined) {
    return input.triggerTokens
  }
  return Math.min(
    input.triggerTokens,
    Math.max(
      input.contextWindowTokens,
      minimumModelContextWindowTokens
    ) - contextOutputAndSafetyTokens
  )
}

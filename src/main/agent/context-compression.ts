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

export type PrefixCompressionPlan<T> = {
  earlierUnits: T[]
  recentUnits: T[]
  estimatedInputTokens: number
  effectiveTriggerTokens: number
}

export const contextSummaryTokenBudget = 8_192

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

export function planPrefixCompression<T>(input: {
  units: readonly T[]
  estimatedInputTokens: number
  effectiveTriggerTokens: number
  recentRawTokens: number
  estimateUnitTokens: (unit: T) => number
  allowCompressLatestUnit?: boolean
  maximumRecentRawTokens?: number
}): PrefixCompressionPlan<T> | undefined {
  if (
    input.estimatedInputTokens < input.effectiveTriggerTokens ||
    input.units.length === 0 ||
    (input.units.length < 2 && !input.allowCompressLatestUnit)
  ) {
    return undefined
  }
  const recentRawTokenBudget = Math.min(
    input.recentRawTokens,
    Math.max(0, input.maximumRecentRawTokens ?? Number.MAX_SAFE_INTEGER)
  )
  if (input.units.length === 1 && input.allowCompressLatestUnit) {
    if (
      input.estimateUnitTokens(input.units[0]!) <=
      recentRawTokenBudget
    ) {
      return undefined
    }
    return {
      earlierUnits: [...input.units],
      recentUnits: [],
      estimatedInputTokens: input.estimatedInputTokens,
      effectiveTriggerTokens: input.effectiveTriggerTokens
    }
  }

  const earlierUnits = [...input.units]
  const recentUnits: T[] = []
  let recentTokens = 0
  while (earlierUnits.length > 0) {
    const unit = earlierUnits.at(-1)!
    const unitTokens = input.estimateUnitTokens(unit)
    if (
      (recentUnits.length > 0 || input.allowCompressLatestUnit) &&
      recentTokens + unitTokens > recentRawTokenBudget
    ) {
      break
    }
    recentUnits.unshift(earlierUnits.pop()!)
    recentTokens += unitTokens
  }
  if (earlierUnits.length === 0) {
    return undefined
  }
  return {
    earlierUnits,
    recentUnits,
    estimatedInputTokens: input.estimatedInputTokens,
    effectiveTriggerTokens: input.effectiveTriggerTokens
  }
}

export function planContextCompression(input: {
  history: readonly CompressibleConversationMessage[]
  prompt: string
  summaryTokens?: number
  settings: ContextCompressionSettings
  contextWindowTokens?: number
  allowCompressLatestTurn?: boolean
  effectiveTriggerTokens?: number
  triggerContextTokens?: number
}): ContextCompressionPlan | undefined {
  const estimatedInputTokens = estimateContextInputTokens({
    history: input.history,
    prompt: input.prompt,
    summaryTokens: input.summaryTokens
  })
  const effectiveTriggerTokens =
    input.effectiveTriggerTokens ??
    getEffectiveContextTriggerTokens({
      triggerTokens: input.settings.triggerTokens,
      contextWindowTokens: input.contextWindowTokens
    })
  const planningInputTokens = Math.max(
    estimatedInputTokens,
    input.triggerContextTokens ?? 0
  )
  if (planningInputTokens < effectiveTriggerTokens) {
    return undefined
  }

  const fixedContextTokens = estimateContextInputTokens({
    history: [],
    prompt: input.prompt,
    summaryTokens: contextSummaryTokenBudget
  })
  const turns = groupConversationTurns(input.history)
  const plan = planPrefixCompression({
    units: turns,
    estimatedInputTokens: planningInputTokens,
    effectiveTriggerTokens,
    recentRawTokens: input.settings.recentRawTokens,
    estimateUnitTokens: estimateMessagesTokens,
    allowCompressLatestUnit: input.allowCompressLatestTurn,
    maximumRecentRawTokens: Math.max(
      0,
      effectiveTriggerTokens - fixedContextTokens
    )
  })
  if (!plan) {
    return undefined
  }
  return {
    earlierMessages: plan.earlierUnits.flat(),
    recentMessages: plan.recentUnits.flat(),
    estimatedInputTokens,
    effectiveTriggerTokens: plan.effectiveTriggerTokens
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

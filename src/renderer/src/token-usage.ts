import type { TokenUsageSummary } from '../../shared/assistant-contracts'

export type TokenUsageGroup = 'project' | 'conversation' | 'model'

export type TokenUsageTotals = {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  cacheInputTokens: number
  cacheHitRate?: number
  totalTokens: number
}

export type TokenUsageGroupRow = TokenUsageTotals & {
  key: string
  label: string
  model: string
  runtime: string
}

type TokenUsageRecord = TokenUsageSummary['records'][number]

function usesSeparatedAnthropicInput(provider: unknown): boolean {
  return (
    typeof provider === 'string' &&
    provider.toLocaleLowerCase().includes('anthropic')
  )
}

function usageNumbers(
  source: unknown,
  provider?: unknown
): TokenUsageTotals {
  const values = source as Record<string, unknown>
  const read = (preferred: string, legacy: string): number => {
    const value = values[preferred] ?? values[legacy]
    return typeof value === 'number' && Number.isFinite(value)
      ? value
      : 0
  }
  const inputTokens = read('inputTokens', 'input')
  const outputTokens = read('outputTokens', 'output')
  const cacheReadTokens = read('cacheReadTokens', 'cacheRead')
  const cacheWriteTokens = read('cacheWriteTokens', 'cacheWrite')
  const reportedCacheInput = values.cacheInputTokens ?? values.cacheInput
  const cacheInputTokens =
    typeof reportedCacheInput === 'number' &&
    Number.isFinite(reportedCacheInput)
      ? reportedCacheInput
      : inputTokens +
        (usesSeparatedAnthropicInput(provider)
          ? cacheReadTokens + cacheWriteTokens
          : 0)

  return {
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    cacheInputTokens,
    cacheHitRate:
      cacheInputTokens > 0
        ? Math.min(cacheReadTokens / cacheInputTokens, 1)
        : undefined,
    totalTokens: inputTokens + outputTokens
  }
}

function groupIdentity(
  record: TokenUsageRecord,
  group: TokenUsageGroup
): Pick<TokenUsageGroupRow, 'key' | 'label' | 'model' | 'runtime'> {
  const model = record.model.trim()
  const runtime = record.runtime.trim()
  const runtimeModelKey = `runtime:${runtime}:model:${model}`

  if (group === 'project') {
    const projectKey = record.projectId
      ? `project:${record.projectId}`
      : 'project:unassigned'
    return {
      key: `${projectKey}:${runtimeModelKey}`,
      label: record.projectName?.trim() || '',
      model,
      runtime
    }
  }

  if (group === 'conversation') {
    const conversationKey = record.conversationId
      ? `conversation:${record.conversationId}`
      : 'conversation:deleted'
    return {
      key: `${conversationKey}:${runtimeModelKey}`,
      label: record.conversationTitle?.trim() || '',
      model,
      runtime
    }
  }

  return {
    key: runtimeModelKey,
    label: model,
    model,
    runtime
  }
}

export function getTokenUsageTotals(
  tokenUsage: TokenUsageSummary
): TokenUsageTotals {
  return usageNumbers(tokenUsage.totals)
}

export function groupTokenUsage(
  tokenUsage: TokenUsageSummary,
  group: TokenUsageGroup
): TokenUsageGroupRow[] {
  const rows = new Map<string, TokenUsageGroupRow>()

  for (const record of tokenUsage.records) {
    const identity = groupIdentity(record, group)
    const usage = usageNumbers(record, record.provider)
    const existing = rows.get(identity.key)

    if (existing) {
      existing.inputTokens += usage.inputTokens
      existing.outputTokens += usage.outputTokens
      existing.cacheReadTokens += usage.cacheReadTokens
      existing.cacheWriteTokens += usage.cacheWriteTokens
      existing.cacheInputTokens += usage.cacheInputTokens
      existing.cacheHitRate =
        existing.cacheInputTokens > 0
          ? Math.min(
              existing.cacheReadTokens / existing.cacheInputTokens,
              1
            )
          : undefined
      existing.totalTokens = existing.inputTokens + existing.outputTokens

      if (!existing.label && identity.label) {
        existing.label = identity.label
      }
      continue
    }

    rows.set(identity.key, {
      ...identity,
      ...usage
    })
  }

  return [...rows.values()]
}

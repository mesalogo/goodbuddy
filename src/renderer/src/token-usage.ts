import type { TokenUsageSummary } from '../../shared/assistant-contracts'

export type TokenUsageGroup = 'project' | 'conversation' | 'model'

export type TokenUsageTotals = {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  totalTokens: number
}

export type TokenUsageGroupRow = TokenUsageTotals & {
  key: string
  label: string
  detail?: string
}

type TokenUsageRecord = TokenUsageSummary['records'][number]

function usageNumbers(source: unknown): TokenUsageTotals {
  const values = source as Record<string, unknown>
  const read = (preferred: string, legacy: string): number => {
    const value = values[preferred] ?? values[legacy]
    return typeof value === 'number' && Number.isFinite(value)
      ? value
      : 0
  }
  const inputTokens = read('inputTokens', 'input')
  const outputTokens = read('outputTokens', 'output')

  return {
    inputTokens,
    outputTokens,
    cacheReadTokens: read('cacheReadTokens', 'cacheRead'),
    cacheWriteTokens: read('cacheWriteTokens', 'cacheWrite'),
    totalTokens: inputTokens + outputTokens
  }
}

function groupIdentity(
  record: TokenUsageRecord,
  group: TokenUsageGroup
): Pick<TokenUsageGroupRow, 'key' | 'label' | 'detail'> {
  const model = record.model.trim()
  const provider = record.provider.trim()
  const modelKey = `${provider}:${model}`
  const modelLabel = model || '未知模型'
  const modelDetail = provider
    ? `${modelLabel} · ${provider}`
    : modelLabel

  if (group === 'project') {
    const projectKey = record.projectId
      ? `project:${record.projectId}`
      : 'project:unassigned'
    return {
      key: `${projectKey}:model:${modelKey}`,
      label: record.projectName?.trim() || '未归属项目',
      detail: modelDetail
    }
  }

  if (group === 'conversation') {
    const conversationKey = record.conversationId
      ? `conversation:${record.conversationId}`
      : 'conversation:deleted'
    return {
      key: `${conversationKey}:model:${modelKey}`,
      label: record.conversationTitle?.trim() || '已删除会话',
      detail: modelDetail
    }
  }

  return {
    key: `model:${modelKey}`,
    label: modelLabel,
    detail: provider || undefined
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
    const usage = usageNumbers(record)
    const existing = rows.get(identity.key)

    if (existing) {
      existing.inputTokens += usage.inputTokens
      existing.outputTokens += usage.outputTokens
      existing.cacheReadTokens += usage.cacheReadTokens
      existing.cacheWriteTokens += usage.cacheWriteTokens
      existing.totalTokens = existing.inputTokens + existing.outputTokens

      if (
        (existing.label === '未归属项目' ||
          existing.label === '已删除会话') &&
        identity.label !== existing.label
      ) {
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

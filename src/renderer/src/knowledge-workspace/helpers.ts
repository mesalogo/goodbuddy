import type { KnowledgeGraphStrategy, KnowledgeTaskItem } from './types'
import type { TFunction } from 'i18next'

export const strategyLabelKeys = {
  rules: 'strategies.rules',
  model: 'strategies.model',
  hybrid: 'strategies.hybrid',
  ask: 'strategies.ask'
} as const satisfies Record<KnowledgeGraphStrategy, string>

export function parseAliases(value: string, limit?: number): string[] {
  const aliases = value
    .split(/[、,，]/)
    .map((item) => item.trim())
    .filter(Boolean)
  return limit === undefined ? aliases : aliases.slice(0, limit)
}

export const taskStageLabelKeys = {
  queued: 'taskStages.queued',
  syncing: 'taskStages.syncing',
  reading: 'taskStages.reading',
  parsing: 'taskStages.parsing',
  chunking: 'taskStages.chunking',
  indexing: 'taskStages.indexing',
  embedding: 'taskStages.embedding',
  graph: 'taskStages.graph',
  finalizing: 'taskStages.finalizing'
} as const satisfies Record<KnowledgeTaskItem['stage'], string>

export function clampProgress(progress: number | undefined): number {
  if (!Number.isFinite(progress)) {
    return 0
  }
  return Math.min(100, Math.max(0, progress ?? 0))
}

export function toErrorMessage(
  reason: unknown,
  t: TFunction<'knowledge'>
): string {
  return reason instanceof Error && reason.message
    ? reason.message
    : t('errors.operationFailed')
}

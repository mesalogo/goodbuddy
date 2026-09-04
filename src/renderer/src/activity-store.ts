import i18n from './i18n'

import {
  activityRecordSchema,
  type ActivityRecord as SharedActivityRecord,
  type AssistantTask
} from '../../shared/assistant-contracts'

export const ACTIVITY_STORAGE_KEY = 'goodbuddy.activity-records.v1'

const LEGACY_MAX_ACTIVITY_RECORDS = 500
const LEGACY_MAX_ACTIVITY_DETAIL_LENGTH = 4_000
const LEGACY_MAX_STORED_JSON_LENGTH = 2_000_000
const LEGACY_NEAR_STORAGE_LIMIT_LENGTH =
  LEGACY_MAX_STORED_JSON_LENGTH - 10_000

export type ActivityRecord = SharedActivityRecord

export type LegacyActivityHistory = {
  records: ActivityRecord[]
  historyMayBeIncomplete: boolean
}

function getLocalStorage(): Storage | undefined {
  try {
    return typeof window === 'undefined' ? undefined : window.localStorage
  } catch {
    return undefined
  }
}

function parseActivityRecord(value: unknown): ActivityRecord | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined
  }
  const candidate = value as Record<string, unknown>
  const parsed = activityRecordSchema.safeParse({
    ...candidate,
    scope: candidate.scope ?? { kind: 'unavailable' }
  })
  return parsed.success ? parsed.data : undefined
}

export function upsertActivityRecord(
  records: readonly ActivityRecord[],
  incoming: ActivityRecord
): ActivityRecord[] {
  if (
    (incoming.kind !== 'tool' && incoming.kind !== 'subagent') ||
    !incoming.callId
  ) {
    return [incoming, ...records]
  }

  const existingIndex = records.findIndex(
    (record) =>
      record.kind === incoming.kind &&
      record.requestId === incoming.requestId &&
      record.callId === incoming.callId
  )
  if (existingIndex < 0) {
    return [incoming, ...records]
  }

  const existing = records[existingIndex]!
  return [
    {
      ...incoming,
      id: existing.id,
      createdAt: existing.createdAt,
      scope: existing.scope
    },
    ...records.filter((_, index) => index !== existingIndex)
  ]
}

export function mergeActivityRecords(
  primary: readonly ActivityRecord[],
  secondary: readonly ActivityRecord[]
): ActivityRecord[] {
  const seen = new Set<string>()
  return [...primary, ...secondary].filter((record) => {
    if (seen.has(record.id)) {
      return false
    }
    seen.add(record.id)
    return true
  })
}

function taskTerminalStatus(
  task: AssistantTask
): ActivityRecord['status'] | undefined {
  if (task.status === 'completed') {
    return 'completed'
  }
  if (task.status === 'failed') {
    return 'failed'
  }
  if (task.status === 'cancelled') {
    return 'cancelled'
  }
  if (task.status === 'interrupted') {
    return 'interrupted'
  }
  return undefined
}

export function reconcileActivityRecords(
  records: readonly ActivityRecord[],
  tasks: readonly AssistantTask[],
  activeRequestIds: ReadonlySet<string> = new Set()
): ActivityRecord[] {
  const tasksById = new Map(tasks.map((task) => [task.id, task]))
  return records.map((record) => {
    if (
      activeRequestIds.has(record.requestId) ||
      (record.status !== 'pending' && record.status !== 'running')
    ) {
      return record
    }
    const task = tasksById.get(record.requestId)
    const terminalStatus = task
      ? taskTerminalStatus(task)
      : 'interrupted'
    if (!terminalStatus) {
      return record
    }
    return {
      ...record,
      status:
        terminalStatus === 'completed' &&
        (record.kind === 'tool' ||
          record.kind === 'approval' ||
          record.kind === 'subagent')
          ? 'interrupted'
          : terminalStatus,
      detail:
        terminalStatus === 'interrupted'
          ? `${record.detail}\n${i18n.t(
              'records.interruptedOnRestart',
              { ns: 'activity' }
            )}`
          : record.detail
    }
  })
}

/**
 * Reads the previous Renderer-owned history once for migration to SQLite.
 * The legacy writer silently stopped at fixed record and payload limits, so
 * reaching one of those boundaries is retained as durable uncertainty.
 */
export function loadLegacyActivityHistory(
  storage: Storage | undefined = getLocalStorage()
): LegacyActivityHistory {
  if (!storage) {
    return { records: [], historyMayBeIncomplete: false }
  }

  try {
    const serialized = storage.getItem(ACTIVITY_STORAGE_KEY)
    if (serialized === null) {
      return { records: [], historyMayBeIncomplete: false }
    }

    const parsed: unknown = JSON.parse(serialized)
    if (!Array.isArray(parsed)) {
      return { records: [], historyMayBeIncomplete: false }
    }

    const records: ActivityRecord[] = []
    for (const candidate of parsed) {
      const record = parseActivityRecord(candidate)
      if (record) {
        records.push(record)
      }
    }
    return {
      records,
      historyMayBeIncomplete:
        records.length >= LEGACY_MAX_ACTIVITY_RECORDS ||
        serialized.length >= LEGACY_NEAR_STORAGE_LIMIT_LENGTH ||
        records.some(
          (record) =>
            record.detail.length === LEGACY_MAX_ACTIVITY_DETAIL_LENGTH
        )
    }
  } catch {
    return { records: [], historyMayBeIncomplete: false }
  }
}

export function clearLegacyActivityHistory(
  storage: Storage | undefined = getLocalStorage()
): void {
  if (!storage) {
    return
  }
  try {
    storage.removeItem(ACTIVITY_STORAGE_KEY)
  } catch {
    // A failed cleanup leaves the migration source intact for the next start.
  }
}

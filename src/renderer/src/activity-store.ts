import i18n from './i18n'

import type { AssistantTask } from '../../shared/assistant-contracts'

export const ACTIVITY_STORAGE_KEY = 'goodbuddy.activity-records.v1'
export const MAX_ACTIVITY_RECORDS = 500
export const MAX_ACTIVITY_DETAIL_LENGTH = 4_000

const MAX_STORED_JSON_LENGTH = 2_000_000
const MAX_ID_LENGTH = 256
const MAX_TITLE_LENGTH = 240
const MAX_PROJECT_NAME_LENGTH = 120

const activityKinds = [
  'request',
  'tool',
  'approval',
  'subagent',
  'result'
] as const
const activityStatuses = [
  'pending',
  'running',
  'completed',
  'failed',
  'denied',
  'cancelled',
  'interrupted'
] as const

export type ActivityRecord = {
  id: string
  conversationId: string
  requestId: string
  callId?: string
  scope:
    | { kind: 'global' }
    | { kind: 'project'; projectId: string; projectName: string }
    | { kind: 'unavailable' }
  kind: (typeof activityKinds)[number]
  title: string
  detail: string
  status: (typeof activityStatuses)[number]
  createdAt: number
}

function getLocalStorage(): Storage | undefined {
  try {
    return typeof window === 'undefined' ? undefined : window.localStorage
  } catch {
    return undefined
  }
}

function isBoundedString(
  value: unknown,
  maximumLength: number,
  allowEmpty = false
): value is string {
  return (
    typeof value === 'string' &&
    value.length <= maximumLength &&
    (allowEmpty || value.length > 0)
  )
}

function parseActivityScope(
  value: unknown
): ActivityRecord['scope'] | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined
  }
  const candidate = value as Record<string, unknown>
  if (candidate.kind === 'global') {
    return { kind: 'global' }
  }
  if (candidate.kind === 'unavailable') {
    return { kind: 'unavailable' }
  }
  if (
    candidate.kind === 'project' &&
    isBoundedString(candidate.projectId, MAX_ID_LENGTH) &&
    isBoundedString(candidate.projectName, MAX_PROJECT_NAME_LENGTH)
  ) {
    return {
      kind: 'project',
      projectId: candidate.projectId,
      projectName: candidate.projectName
    }
  }
  return undefined
}

function parseActivityRecord(value: unknown): ActivityRecord | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined
  }

  const candidate = value as Record<string, unknown>
  if (
    !isBoundedString(candidate.id, MAX_ID_LENGTH) ||
    !isBoundedString(candidate.conversationId, MAX_ID_LENGTH) ||
    !isBoundedString(candidate.requestId, MAX_ID_LENGTH) ||
    (candidate.callId !== undefined &&
      !isBoundedString(candidate.callId, MAX_ID_LENGTH)) ||
    !activityKinds.some((kind) => kind === candidate.kind) ||
    !isBoundedString(candidate.title, MAX_TITLE_LENGTH) ||
    !isBoundedString(
      candidate.detail,
      MAX_ACTIVITY_DETAIL_LENGTH,
      true
    ) ||
    !activityStatuses.some((status) => status === candidate.status) ||
    typeof candidate.createdAt !== 'number' ||
    !Number.isFinite(candidate.createdAt) ||
    candidate.createdAt < 0
  ) {
    return undefined
  }

  const scope =
    candidate.scope === undefined
      ? { kind: 'unavailable' as const }
      : parseActivityScope(candidate.scope)
  if (!scope) {
    return undefined
  }

  return {
    id: candidate.id,
    conversationId: candidate.conversationId,
    requestId: candidate.requestId,
    ...(candidate.callId === undefined
      ? {}
      : { callId: candidate.callId }),
    scope,
    kind: candidate.kind as ActivityRecord['kind'],
    title: candidate.title,
    detail: candidate.detail,
    status: candidate.status as ActivityRecord['status'],
    createdAt: candidate.createdAt
  }
}

export function upsertActivityRecord(
  records: readonly ActivityRecord[],
  incoming: ActivityRecord
): ActivityRecord[] {
  if (
    (incoming.kind !== 'tool' && incoming.kind !== 'subagent') ||
    !incoming.callId
  ) {
    return [incoming, ...records].slice(0, MAX_ACTIVITY_RECORDS)
  }

  const existingIndex = records.findIndex(
    (record) =>
      record.kind === incoming.kind &&
      record.requestId === incoming.requestId &&
      record.callId === incoming.callId
  )
  if (existingIndex < 0) {
    return [incoming, ...records].slice(0, MAX_ACTIVITY_RECORDS)
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
  ].slice(0, MAX_ACTIVITY_RECORDS)
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
            )}`.slice(
              0,
              MAX_ACTIVITY_DETAIL_LENGTH
            )
          : record.detail
    }
  })
}

/**
 * Loads only records matching the persisted activity schema. Corrupt storage,
 * inaccessible storage and oversized payloads are treated as an empty history.
 */
export function loadActivityRecords(
  storage: Storage | undefined = getLocalStorage()
): ActivityRecord[] {
  if (!storage) {
    return []
  }

  try {
    const serialized = storage.getItem(ACTIVITY_STORAGE_KEY)
    if (
      serialized === null ||
      serialized.length > MAX_STORED_JSON_LENGTH
    ) {
      return []
    }

    const parsed: unknown = JSON.parse(serialized)
    if (!Array.isArray(parsed)) {
      return []
    }

    const records: ActivityRecord[] = []
    for (const candidate of parsed) {
      const record = parseActivityRecord(candidate)
      if (record) {
        records.push(record)
      }
      if (records.length === MAX_ACTIVITY_RECORDS) {
        break
      }
    }
    return records
  } catch {
    return []
  }
}

/**
 * Persists at most 500 schema-valid records. Returns false if storage is
 * unavailable or rejects the write.
 */
export function saveActivityRecords(
  records: readonly ActivityRecord[],
  storage: Storage | undefined = getLocalStorage()
): boolean {
  if (!storage) {
    return false
  }

  const safeRecords: ActivityRecord[] = []
  for (const record of records) {
    const safeRecord = parseActivityRecord(record)
    if (safeRecord) {
      safeRecords.push(safeRecord)
    }
    if (safeRecords.length === MAX_ACTIVITY_RECORDS) {
      break
    }
  }

  try {
    storage.setItem(ACTIVITY_STORAGE_KEY, JSON.stringify(safeRecords))
    return true
  } catch {
    return false
  }
}

export const ACTIVITY_STORAGE_KEY = 'goodbuddy.activity-records.v1'
export const MAX_ACTIVITY_RECORDS = 500
export const MAX_ACTIVITY_DETAIL_LENGTH = 4_000

const MAX_STORED_JSON_LENGTH = 2_000_000
const MAX_ID_LENGTH = 256
const MAX_TITLE_LENGTH = 240

const activityKinds = [
  'request',
  'tool',
  'approval',
  'result'
] as const
const activityStatuses = [
  'pending',
  'running',
  'completed',
  'failed',
  'denied'
] as const

export type ActivityRecord = {
  id: string
  conversationId: string
  requestId: string
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

function isActivityRecord(value: unknown): value is ActivityRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false
  }

  const candidate = value as Record<string, unknown>
  return (
    isBoundedString(candidate.id, MAX_ID_LENGTH) &&
    isBoundedString(candidate.conversationId, MAX_ID_LENGTH) &&
    isBoundedString(candidate.requestId, MAX_ID_LENGTH) &&
    activityKinds.some((kind) => kind === candidate.kind) &&
    isBoundedString(candidate.title, MAX_TITLE_LENGTH) &&
    isBoundedString(
      candidate.detail,
      MAX_ACTIVITY_DETAIL_LENGTH,
      true
    ) &&
    activityStatuses.some((status) => status === candidate.status) &&
    typeof candidate.createdAt === 'number' &&
    Number.isFinite(candidate.createdAt) &&
    candidate.createdAt >= 0
  )
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
      if (isActivityRecord(candidate)) {
        records.push(candidate)
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
    if (isActivityRecord(record)) {
      safeRecords.push(record)
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

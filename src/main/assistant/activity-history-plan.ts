import {
  activityHistorySnapshotSchema,
  activityRecordSchema,
  type ActivityRecord
} from '../../shared/assistant-contracts'

// PERF-15: planning of a full activity history `replace` (legacy migration).
// These pure helpers validate and diff against the last committed rows
// without re-validating or re-serializing unchanged records. Incremental
// changes are applied by ActivityHistoryRepository directly in SQL.

/** A stored row; `record` is a validated, privately owned copy when known. */
export type ActivityHistoryEntry = { json: string; seq: number; record?: ActivityRecord }

export type ActivityHistoryState = {
  /** Every row in activity_history_records, keyed by record_key. */
  entries: ReadonlyMap<string, ActivityHistoryEntry>
  incomplete?: boolean
}

export type ActivityHistoryPlan = {
  next: { entries: Map<string, ActivityHistoryEntry>; incomplete: boolean }
  upserts: Array<[key: string, json: string, seq: number]>
  removes: string[]
  /** The legacy flag changed: the singleton row must be updated. */
  headerChanged: boolean
}

type ParsedItem = { record: ActivityRecord; json?: string; key?: string }

/** IDs were never unique in the snapshot schema; every occurrence is kept. */
export const activityRecordKey = (id: string, occurrence: number): string => JSON.stringify([id, occurrence])

export const isActivityHistoryPlanEmpty = (plan: ActivityHistoryPlan): boolean =>
  plan.upserts.length === 0 && plan.removes.length === 0 && !plan.headerChanged

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value) as unknown
  return prototype === Object.prototype || prototype === null
}

/** Exact structural equality against a validated record (same own keys, same values). */
function sameValue(raw: unknown, validated: unknown): boolean {
  if (raw === validated) return true
  if (!isPlainObject(validated) || !isPlainObject(raw)) return false
  const keys = Object.keys(validated)
  if (Object.keys(raw).length !== keys.length) return false
  for (const key of keys) {
    if (!Object.hasOwn(raw, key) || !sameValue(raw[key], validated[key])) return false
  }
  return true
}

/**
 * Validates a replace snapshot with the same accept/reject behavior and errors
 * as `activityHistorySnapshotSchema.parse`, reusing previously validated
 * records (and their serialized form) that are structurally identical.
 */
export function parseActivityHistorySnapshot(
  input: unknown,
  previous?: ActivityHistoryState
): { items: ParsedItem[]; incomplete: boolean } {
  let raw: { records: readonly unknown[]; legacyHistoryMayBeIncomplete: boolean }
  if (
    isPlainObject(input) && Object.keys(input).length === 2 &&
    Array.isArray(input.records) && typeof input.legacyHistoryMayBeIncomplete === 'boolean'
  ) {
    raw = input as typeof raw
  } else {
    raw = activityHistorySnapshotSchema.parse(input)
  }
  const occurrences = new Map<string, number>()
  const items: ParsedItem[] = new Array(raw.records.length)
  for (let index = 0; index < raw.records.length; index++) {
    const candidate = raw.records[index]
    const id = isPlainObject(candidate) ? candidate.id : undefined
    if (typeof id === 'string') {
      const occurrence = occurrences.get(id) ?? 0
      const key = activityRecordKey(id, occurrence)
      const entry = previous?.entries.get(key)
      if (entry?.record && sameValue(candidate, entry.record)) {
        occurrences.set(id, occurrence + 1)
        items[index] = { record: entry.record, json: entry.json, key }
        continue
      }
    }
    const parsed = activityRecordSchema.safeParse(candidate)
    // Throw exactly the error (paths included) the whole-snapshot schema throws.
    if (!parsed.success) activityHistorySnapshotSchema.parse(input)
    const record = parsed.success ? parsed.data : activityRecordSchema.parse(candidate)
    occurrences.set(record.id, (occurrences.get(record.id) ?? 0) + 1)
    items[index] = { record }
  }
  return { items, incomplete: raw.legacyHistoryMayBeIncomplete }
}

/**
 * Diffs a full newest-first list against the committed rows. Order is kept
 * as `order_seq` (newer = larger): walking from the oldest record, a row
 * keeps its sequence when it is still above the previous one, otherwise it
 * gets the next one. Prepending or moving one record to the front therefore
 * writes only that record.
 */
export function planActivityHistoryReplace(
  items: readonly ParsedItem[],
  incomplete: boolean,
  previous: ActivityHistoryState,
  onProgress?: (processed: number) => void
): ActivityHistoryPlan {
  const occurrences = new Map<string, number>()
  const keys: string[] = new Array(items.length)
  for (let index = 0; index < items.length; index++) {
    const { record } = items[index]!
    const occurrence = occurrences.get(record.id) ?? 0
    occurrences.set(record.id, occurrence + 1)
    keys[index] = items[index]!.key ?? activityRecordKey(record.id, occurrence)
  }
  const entries = new Map<string, ActivityHistoryEntry>()
  const upserts: Array<[string, string, number]> = []
  let floor = 0
  for (let index = items.length - 1, processed = 0; index >= 0; index--, processed++) {
    if (processed % 128 === 0) onProgress?.(processed)
    const { record } = items[index]!
    const key = keys[index]!
    const json = items[index]!.json ?? JSON.stringify(record)
    const before = previous.entries.get(key)
    const seq = before && before.seq > floor ? before.seq : floor + 1
    floor = seq
    if (before?.json !== json || before.seq !== seq) upserts.push([key, json, seq])
    entries.set(key, { json, seq, record })
  }
  const removes: string[] = []
  for (const key of previous.entries.keys()) if (!entries.has(key)) removes.push(key)
  return {
    next: { entries, incomplete },
    upserts,
    removes,
    headerChanged: previous.incomplete !== incomplete
  }
}

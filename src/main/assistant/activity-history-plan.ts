import {
  activityHistorySnapshotSchema,
  activityHistoryUpdateSchema,
  activityRecordSchema,
  type ActivityRecord
} from '../../shared/assistant-contracts'

// PERF-15: activity history persistence planning. The renderer sends the whole
// newest-first list every change; most records are unchanged. These pure
// helpers validate and diff against the last committed state without
// re-validating or re-serializing unchanged records, and turn incremental
// changes into the same stored rows that `replace` would produce.

/** A stored row; `record` is a validated, privately owned copy when known. */
export type ActivityHistoryEntry = { json: string; record?: ActivityRecord }

export type ActivityHistoryState = {
  /** Every row in activity_history_records, keyed by record_key. */
  entries: ReadonlyMap<string, ActivityHistoryEntry>
  /** Stored order; undefined when unknown (always rewritten). */
  order?: readonly string[]
  orderJson?: string
  incomplete?: boolean
}

export type ActivityHistoryPlan = {
  next: ActivityHistoryState & { order: readonly string[]; orderJson: string; incomplete: boolean }
  upserts: Array<[key: string, json: string]>
  removes: string[]
  /** Order or legacy flag changed: the singleton row must be updated. */
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

function sameOrder(left: readonly string[], right: readonly string[] | undefined): boolean {
  if (!right || left.length !== right.length) return false
  for (let index = 0; index < left.length; index++) if (left[index] !== right[index]) return false
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

/** Diffs a full newest-first list against the committed state. */
export function planActivityHistoryReplace(
  items: readonly ParsedItem[],
  incomplete: boolean,
  previous: ActivityHistoryState,
  onProgress?: (processed: number) => void
): ActivityHistoryPlan {
  const entries = new Map<string, ActivityHistoryEntry>()
  const occurrences = new Map<string, number>()
  const order: string[] = new Array(items.length)
  const upserts: Array<[string, string]> = []
  for (let index = 0; index < items.length; index++) {
    if (index % 128 === 0) onProgress?.(index)
    const { record } = items[index]!
    const occurrence = occurrences.get(record.id) ?? 0
    occurrences.set(record.id, occurrence + 1)
    const key = items[index]!.key ?? activityRecordKey(record.id, occurrence)
    const json = items[index]!.json ?? JSON.stringify(record)
    order[index] = key
    if (previous.entries.get(key)?.json !== json) upserts.push([key, json])
    entries.set(key, { json, record })
  }
  const removes: string[] = []
  for (const key of previous.entries.keys()) if (!entries.has(key)) removes.push(key)
  return finish(entries, order, incomplete, previous, upserts, removes)
}

function finish(
  entries: Map<string, ActivityHistoryEntry>,
  order: string[],
  incomplete: boolean,
  previous: ActivityHistoryState,
  upserts: Array<[string, string]>,
  removes: string[]
): ActivityHistoryPlan {
  const orderUnchanged = sameOrder(order, previous.order) && previous.orderJson !== undefined
  const orderJson = orderUnchanged ? previous.orderJson! : JSON.stringify(order)
  return {
    next: { entries, order, orderJson, incomplete },
    upserts,
    removes,
    headerChanged: !orderUnchanged || previous.incomplete !== incomplete
  }
}

/**
 * Applies incremental changes (see `activityHistoryChangeSchema`). Only the
 * changed records are validated and serialized; the result is identical to
 * `planActivityHistoryReplace` with the resulting list.
 */
export function planActivityHistoryUpdate(input: unknown, previous: ActivityHistoryState): ActivityHistoryPlan {
  const update = activityHistoryUpdateSchema.parse(input)
  if (!previous.order) throw new Error('Activity history order is unreadable; save the full history instead')
  const entries = new Map(previous.entries)
  let order = [...previous.order]
  const touched = new Set<string>()
  for (const change of update.changes) {
    if (change.type === 'remove-duplicates') {
      const isDuplicate = (key: string): boolean => (JSON.parse(key) as [string, number])[1] !== 0
      order = order.filter(key => !isDuplicate(key))
      for (const key of [...entries.keys()]) {
        if (isDuplicate(key)) { entries.delete(key); touched.add(key) }
      }
      continue
    }
    if (change.type === 'remove') {
      // Keys of one ID share the JSON prefix `["id",`.
      const prefix = `${JSON.stringify([change.id]).slice(0, -1)},`
      const removed = order.filter(key => key.startsWith(prefix))
      if (removed.length > 0) order = order.filter(key => !key.startsWith(prefix))
      for (const key of removed) { entries.delete(key); touched.add(key) }
      for (let occurrence = 0; ; occurrence++) {
        const key = activityRecordKey(change.id, occurrence)
        if (!entries.delete(key)) break
        touched.add(key)
      }
      continue
    }
    const { record } = change
    // The first occurrence stays first when moved to the front, so its key is stable.
    const key = activityRecordKey(record.id, 0)
    const index = order.indexOf(key)
    if (index < 0) order.unshift(key)
    else if (change.position === 'front' && index > 0) {
      order.splice(index, 1)
      order.unshift(key)
    }
    entries.set(key, { json: JSON.stringify(record), record })
    touched.add(key)
  }
  const upserts: Array<[string, string]> = []
  const removes: string[] = []
  for (const key of touched) {
    const entry = entries.get(key)
    if (!entry) {
      if (previous.entries.has(key)) removes.push(key)
    } else if (previous.entries.get(key)?.json !== entry.json) {
      upserts.push([key, entry.json])
    }
  }
  return finish(entries, order, update.legacyHistoryMayBeIncomplete ?? previous.incomplete ?? false,
    previous, upserts, removes)
}

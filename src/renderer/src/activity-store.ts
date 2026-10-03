import i18n from './i18n'

import {
  activityRecordSchema,
  type ActivityHistoryChange,
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
  records: ActivityRecord[],
  incoming: ActivityRecord
): ActivityRecord[]
export function upsertActivityRecord(
  records: readonly ActivityRecord[],
  incoming: ActivityRecord
): readonly ActivityRecord[]
export function upsertActivityRecord(
  records: readonly ActivityRecord[],
  incoming: ActivityRecord
): readonly ActivityRecord[] {
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
  // Matching fields and the original identity/scope cannot change on an update.
  const unchanged =
    existing.conversationId === incoming.conversationId &&
    existing.title === incoming.title &&
    existing.detail === incoming.detail &&
    existing.status === incoming.status
  if (unchanged && existingIndex === 0) {
    return records
  }
  return [
    unchanged
      ? existing
      : {
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

/**
 * What still has to reach Main, in order: incremental changes, or a marker
 * that the whole history must be cleared or written in full first.
 */
export type ActivityOutboxEntry =
  | ActivityHistoryChange
  | { type: 'clear' }
  | { type: 'replace' }

type Listener = () => void

export type ActivityStore = ReturnType<typeof createActivityStore>

/**
 * Activity history, kept outside App state (P2/P4). Every domain action
 * updates the newest-first list and appends the matching contract changes to
 * the outbox, which activity-sync.ts sends to Main; the list is never written
 * back as a whole except for the legacy migration fallback.
 *
 * The Activity page shows a snapshot (`getPanelRecords`) instead of the live
 * list so streaming runs do not re-render it; `refreshPanel` updates it.
 */
export function createActivityStore(
  initial: readonly ActivityRecord[] = [],
  initialLegacyIncomplete = false
) {
  let records: readonly ActivityRecord[] = mergeActivityRecords(initial, [])
  let panelRecords = records
  let ready = false
  let legacyIncomplete = initialLegacyIncomplete
  let outbox: ActivityOutboxEntry[] = []
  const listeners = new Set<Listener>()
  const panelListeners = new Set<Listener>()
  const outboxListeners = new Set<Listener>()
  const notify = (set: Set<Listener>): void => {
    for (const listener of [...set]) listener()
  }
  const subscribe = (set: Set<Listener>) => (listener: Listener): (() => void) => {
    set.add(listener)
    return () => {
      set.delete(listener)
    }
  }

  const enqueue = (entry: ActivityOutboxEntry): void => {
    const last = outbox.at(-1)
    // Consecutive upserts of one record collapse: front then in-place is a
    // front upsert with the newer content, and so on.
    if (
      entry.type === 'upsert' &&
      last?.type === 'upsert' &&
      last.record.id === entry.record.id
    ) {
      outbox[outbox.length - 1] = {
        type: 'upsert',
        record: entry.record,
        position:
          last.position === 'front' || entry.position === 'front'
            ? 'front'
            : 'in-place'
      }
      return
    }
    outbox.push(entry)
  }

  const commit = (
    next: readonly ActivityRecord[],
    changes: readonly ActivityOutboxEntry[]
  ): void => {
    if (next === records && changes.length === 0) return
    const wasEmpty = outbox.length === 0
    records = next
    for (const change of changes) enqueue(change)
    notify(listeners)
    if (wasEmpty && outbox.length > 0) notify(outboxListeners)
  }

  /** Maps records in place; each changed one becomes an in-place upsert. */
  const mapInPlace = (
    update: (record: ActivityRecord) => ActivityRecord
  ): void => {
    const changes: ActivityOutboxEntry[] = []
    const next = records.map((record) => {
      const updated = update(record)
      if (updated !== record) {
        changes.push({ type: 'upsert', record: updated, position: 'in-place' })
      }
      return updated
    })
    if (changes.length > 0) commit(next, changes)
  }

  const removeWhere = (match: (record: ActivityRecord) => boolean): void => {
    const removed = records.filter(match)
    if (removed.length === 0) return
    commit(
      records.filter((record) => !match(record)),
      [...new Set(removed.map((record) => record.id))].map((id) => ({
        type: 'remove' as const,
        id
      }))
    )
  }

  const store = {
    getRecords(): readonly ActivityRecord[] {
      return records
    },
    subscribe: subscribe(listeners),
    getPanelRecords(): readonly ActivityRecord[] {
      return panelRecords
    },
    subscribePanel: subscribe(panelListeners),
    /** Shows the current list on the Activity page. */
    refreshPanel(): void {
      if (panelRecords === records) return
      panelRecords = records
      notify(panelListeners)
    },
    /** Whether the stored history was loaded; changes are sent only after. */
    isReady(): boolean {
      return ready
    },
    /** Whether the migrated legacy history may have lost records. */
    isLegacyIncomplete(): boolean {
      return legacyIncomplete
    },

    /** Adds a record, or moves a tool/subagent record of the same call to the front. */
    record(incoming: ActivityRecord): void {
      const next = upsertActivityRecord(records, incoming)
      if (next === records) return
      commit(next, [{ type: 'upsert', record: next[0]!, position: 'front' }])
    },
    /** Updates the request record(s) of a run where they are. */
    updateRequest(
      requestId: string,
      status: ActivityRecord['status'],
      detail?: string
    ): void {
      mapInPlace((record) =>
        record.requestId === requestId && record.kind === 'request'
          ? { ...record, status, detail: detail ?? record.detail }
          : record
      )
    },
    /** Resolves the newest pending approval of a conversation. */
    updateApproval(
      conversationId: string,
      status: ActivityRecord['status'],
      detailLine: string
    ): void {
      let updated = false
      mapInPlace((record) => {
        if (
          updated ||
          record.conversationId !== conversationId ||
          record.kind !== 'approval' ||
          record.status !== 'pending'
        ) {
          return record
        }
        updated = true
        return { ...record, status, detail: `${record.detail}\n${detailLine}` }
      })
    },
    /** Drops every record of a request that never started. */
    removeByRequest(requestId: string): void {
      removeWhere((record) => record.requestId === requestId)
    },
    /** Drops the provisional tool record a subagent replaces. */
    removeToolByCallId(requestId: string, callId: string): void {
      removeWhere(
        (record) =>
          record.requestId === requestId &&
          record.kind === 'tool' &&
          record.callId === callId
      )
    },
    /** Ends the unfinished non-request records of a finished run. */
    settleRequest(
      requestId: string,
      status: ActivityRecord['status'],
      detailLine: string
    ): void {
      mapInPlace((record) =>
        record.requestId === requestId &&
        record.kind !== 'request' &&
        (record.status === 'pending' || record.status === 'running')
          ? { ...record, status, detail: `${record.detail}\n${detailLine}` }
          : record
      )
    },
    /** Ends records left running by a run that is no longer active. */
    reconcile(
      tasks: readonly AssistantTask[],
      activeRequestIds: ReadonlySet<string>
    ): void {
      const next = reconcileActivityRecords(records, tasks, activeRequestIds)
      const changes: ActivityOutboxEntry[] = []
      next.forEach((record, index) => {
        if (record !== records[index]) {
          changes.push({ type: 'upsert', record, position: 'in-place' })
        }
      })
      if (changes.length > 0) commit(next, changes)
    },
    /**
     * Adds the stored history behind the records of this session. Stored
     * duplicates of an ID are dropped, as the list always showed only the
     * first one.
     */
    mergeLoaded(
      loaded: readonly ActivityRecord[],
      loadedLegacyIncomplete: boolean
    ): void {
      const next = mergeActivityRecords(records, loaded)
      const hasDuplicates =
        new Set(loaded.map((record) => record.id)).size < loaded.length
      ready = true
      legacyIncomplete = legacyIncomplete || loadedLegacyIncomplete
      commit(next, hasDuplicates ? [{ type: 'remove-duplicates' }] : [])
      if (outbox.length > 0) notify(outboxListeners)
    },
    /**
     * Clears the history here and, through the sync, in Main. Queued changes
     * are dropped: the clear supersedes them. Before the stored history
     * loaded only this session's records go, as before.
     */
    clear(): void {
      records = []
      panelRecords = []
      legacyIncomplete = false
      outbox = ready ? [{ type: 'clear' }] : []
      notify(listeners)
      notify(panelListeners)
      notify(outboxListeners)
    },
    /** Main already deleted everything (clear local data): nothing to send. */
    reset(): void {
      records = []
      panelRecords = []
      legacyIncomplete = false
      outbox = []
      notify(listeners)
      notify(panelListeners)
    },
    /** The next save writes the whole list (Main's copy is not a known base). */
    requireReplace(): void {
      outbox = [{ type: 'replace' }]
      notify(outboxListeners)
    },

    getOutbox(): readonly ActivityOutboxEntry[] {
      return outbox
    },
    subscribeOutbox: subscribe(outboxListeners),
    /** Removes and returns the first `count` outbox entries. */
    takeOutbox(count: number): ActivityOutboxEntry[] {
      return outbox.splice(0, count)
    },
    /** Puts entries that failed to save back in front, in order. */
    requeue(entries: readonly ActivityOutboxEntry[]): void {
      if (outbox[0]?.type === 'clear' || outbox[0]?.type === 'replace') return
      outbox = [...entries, ...outbox]
    }
  }
  return store
}

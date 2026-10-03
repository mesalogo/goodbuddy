import i18n from './i18n'

import {
  activityRecordSchema,
  type ActivityHistoryChange,
  type ActivityHistoryFilter,
  type ActivityHistoryPage,
  type ActivityHistoryReconcileRequest,
  type ActivityHistorySummary,
  type ActivityRecord as SharedActivityRecord,
  type AssistantTask
} from '../../shared/assistant-contracts'
import { applyActivityChanges } from '../../shared/activity-history-reference'

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
 * What still has to reach Main, in order: incremental changes, a reconcile
 * against the stored tasks, the legacy-incomplete flag, or clearing it all.
 */
export type ActivityOutboxEntry =
  | ActivityHistoryChange
  | {
      type: 'reconcile'
      request: ActivityHistoryReconcileRequest
      /** Kept to apply the same reconcile to pages read before Main ran it. */
      tasks: readonly AssistantTask[]
    }
  | { type: 'legacy-flag'; value: boolean }
  | { type: 'clear' }

type Listener = () => void

export type ActivityStore = ReturnType<typeof createActivityStore>

/** The loaded records of one filter. */
export type ActivityPageState = {
  filter: ActivityHistoryFilter
  /** Newest first: a prefix of Main's list for `filter`, plus this session's unsaved records. */
  records: readonly ActivityRecord[]
  /** `before` of the next page; undefined when everything is loaded or not known (trimmed). */
  nextBefore?: number
  /** Whether more records may exist than are loaded. */
  hasMore: boolean
}

export const ACTIVITY_FIRST_PAGE_SIZE = 200
export const ACTIVITY_PAGE_SIZE = 500

export function matchesActivityFilter(record: ActivityRecord, filter: ActivityHistoryFilter): boolean {
  if (filter === 'active') return record.status === 'pending' || record.status === 'running'
  if (filter === 'failed') {
    return record.status === 'failed' || record.status === 'denied' ||
      record.status === 'cancelled' || record.status === 'interrupted'
  }
  return true
}

export const isActivityChange = (entry: ActivityOutboxEntry): entry is ActivityHistoryChange =>
  entry.type !== 'reconcile' && entry.type !== 'clear' && entry.type !== 'legacy-flag'

/**
 * Activity history, kept outside App state (P2/P4). Main owns the history;
 * the renderer keeps only the pages it loaded. Every domain action applies
 * its contract change to the loaded records (`applyActivityChanges`, the
 * same semantics Main applies) and appends it to the outbox, which
 * activity-sync.ts sends to Main. Main matches changes by content, so
 * records that are not loaded are updated too.
 *
 * The Activity page shows a snapshot (`getPanel`) instead of the live list so
 * streaming runs do not re-render it; `refreshPanel` updates it.
 */
export function createActivityStore(initial: readonly ActivityRecord[] = []) {
  let page: ActivityPageState = { filter: 'all', records: mergeActivityRecords(initial, []), hasMore: true }
  let panel = page
  let summary: ActivityHistorySummary | undefined
  let ready = false
  /** Bumped whenever the loaded pages are replaced; stale page responses are dropped. */
  let generation = 0
  let outbox: ActivityOutboxEntry[] = []
  /** Taken by the sync and not acknowledged yet. */
  let sending: ActivityOutboxEntry[] = []
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
  const setPage = (next: ActivityPageState): void => {
    page = next
    notify(listeners)
  }

  const enqueue = (entry: ActivityOutboxEntry): void => {
    const wasEmpty = outbox.length === 0
    // Only the latest reconcile matters: it reads the stored tasks when it runs.
    if (entry.type === 'reconcile' && outbox.at(-1)?.type === 'reconcile') outbox[outbox.length - 1] = entry
    else outbox.push(entry)
    if (wasEmpty) notify(outboxListeners)
  }

  const apply = (change: ActivityHistoryChange): void => {
    const records = applyActivityChanges(page.records, [change])
    enqueue(change)
    if (!sameRecords(records, page.records)) setPage({ ...page, records })
  }

  /** What Main does not have yet: the changes after the last queued clear (and whether there is one). */
  const queuedChanges = (): { cleared: boolean; entries: ActivityOutboxEntry[] } => {
    const queued = [...sending, ...outbox]
    const cleared = queued.findLastIndex((entry) => entry.type === 'clear')
    return { cleared: cleared >= 0, entries: queued.slice(cleared + 1) }
  }
  const replay = (
    records: readonly ActivityRecord[],
    entries: readonly ActivityOutboxEntry[],
    inserts: boolean
  ): ActivityRecord[] => {
    let result = [...records]
    for (const entry of entries) {
      if (entry.type === 'reconcile') {
        result = reconcileActivityRecords(result, entry.tasks, new Set(entry.request.activeRequestIds))
      } else if (isActivityChange(entry) && (inserts || (entry.type !== 'upsert' && entry.type !== 'upsert-call'))) {
        result = applyActivityChanges(result, [entry])
      }
    }
    return result
  }
  /** A first page from Main with the queued changes applied, as Main will store it. */
  const firstPageRecords = (loaded: readonly ActivityRecord[], filter: ActivityHistoryFilter): ActivityRecord[] => {
    const { cleared, entries } = queuedChanges()
    return replay(cleared ? [] : loaded, entries, true).filter((record) => matchesActivityFilter(record, filter))
  }
  /** An older page: queued upserts already put their records in front of the loaded ones. */
  const olderPageRecords = (loaded: readonly ActivityRecord[]): ActivityRecord[] => {
    const { cleared, entries } = queuedChanges()
    if (cleared) return []
    const moved = new Set<string>()
    for (const entry of entries) {
      if (entry.type === 'upsert') moved.add(entry.record.id)
      if (entry.type !== 'upsert-call') continue
      // Inserted here because the call's record was not loaded: Main moves
      // the first record of the call to the front instead.
      const key = callKey(entry.record)
      const local = page.records.find((record) => record.callId !== undefined && callKey(record) === key)
      if (local?.id !== entry.record.id) continue
      const match = loaded.find((record) => !moved.has(record.id) && record.callId !== undefined && callKey(record) === key)
      if (match) moved.add(match.id)
    }
    return replay(loaded.filter((record) => !moved.has(record.id)), entries, false)
      .filter((record) => matchesActivityFilter(record, page.filter))
  }
  const clearQueued = (): boolean => queuedChanges().cleared
  const pageEnd = (loaded: ActivityHistoryPage): Pick<ActivityPageState, 'hasMore' | 'nextBefore'> =>
    loaded.nextBefore === undefined || clearQueued()
      ? { hasMore: false }
      : { hasMore: true, nextBefore: loaded.nextBefore }

  const emptySummary = (): ActivityHistorySummary => ({
    counts: { all: 0, active: 0, failed: 0 }, conversations: {}, legacyHistoryMayBeIncomplete: false
  })

  return {
    /** The loaded records, newest first. */
    getRecords(): readonly ActivityRecord[] {
      return page.records
    },
    getPage(): ActivityPageState {
      return page
    },
    getGeneration(): number {
      return generation
    },
    subscribe: subscribe(listeners),
    /** What the Activity page shows (a snapshot). */
    getPanel(): ActivityPageState {
      return panel
    },
    /** Counts and conversation titles/status over the whole history (Main). */
    getSummary(): ActivityHistorySummary | undefined {
      return summary
    },
    subscribePanel: subscribe(panelListeners),
    /** Shows the current records on the Activity page. */
    refreshPanel(): void {
      if (panel === page) return
      panel = page
      notify(panelListeners)
    },
    setSummary(next: ActivityHistorySummary): void {
      summary = next
      notify(panelListeners)
    },
    /** Whether the stored history was loaded; changes are sent only after. */
    isReady(): boolean {
      return ready
    },
    markReady(): void {
      ready = true
      if (outbox.length > 0) notify(outboxListeners)
    },

    /** Adds a record, or moves a tool/subagent record of the same call to the front. */
    record(incoming: ActivityRecord): void {
      apply((incoming.kind === 'tool' || incoming.kind === 'subagent') && incoming.callId
        ? { type: 'upsert-call', record: incoming }
        : { type: 'upsert', record: incoming, position: 'front' })
    },
    /** Updates the request record(s) of a run where they are. */
    updateRequest(requestId: string, status: ActivityRecord['status'], detail?: string): void {
      apply({ type: 'update-request', requestId, status, ...(detail === undefined ? {} : { detail }) })
    },
    /** Resolves the newest pending approval of a conversation. */
    updateApproval(conversationId: string, status: ActivityRecord['status'], detailLine: string): void {
      apply({ type: 'resolve-approval', conversationId, status, detailLine })
    },
    /** Drops every record of a request that never started. */
    removeByRequest(requestId: string): void {
      apply({ type: 'remove-request', requestId })
    },
    /** Drops the provisional tool record a subagent replaces. */
    removeToolByCallId(requestId: string, callId: string): void {
      apply({ type: 'remove-call', requestId, callId })
    },
    /** Ends the unfinished non-request records of a finished run. */
    settleRequest(requestId: string, status: ActivityRecord['status'], detailLine: string): void {
      apply({ type: 'settle-request', requestId, status, detailLine })
    },
    /**
     * Ends records left running by requests that are no longer active: the
     * loaded ones here, all of them in Main (joined with the stored tasks).
     */
    reconcile(tasks: readonly AssistantTask[], activeRequestIds: ReadonlySet<string>): void {
      const interruptedDetail = i18n.t('records.interruptedOnRestart', { ns: 'activity' })
      const records = reconcileActivityRecords(page.records, tasks, activeRequestIds)
      enqueue({ type: 'reconcile', request: { activeRequestIds: [...activeRequestIds], interruptedDetail }, tasks })
      if (!sameRecords(records, page.records)) setPage({ ...page, records })
    },

    /**
     * Replaces the loaded records with a first page from Main; this
     * session's unsaved records stay in front. `generation` is the value
     * when the request started: a response superseded meanwhile is dropped.
     */
    setFirstPage(filter: ActivityHistoryFilter, loaded: ActivityHistoryPage, requestGeneration: number): boolean {
      if (requestGeneration !== generation) return false
      generation++
      setPage({
        filter,
        records: firstPageRecords(loaded.records, filter),
        ...pageEnd(loaded)
      })
      return true
    },
    /** Appends the page that starts at the current `nextBefore`. */
    appendPage(loaded: ActivityHistoryPage, requestGeneration: number, before: number): boolean {
      if (requestGeneration !== generation || page.nextBefore !== before) return false
      generation++
      setPage({
        filter: page.filter,
        records: mergeActivityRecords(page.records, olderPageRecords(loaded.records)),
        ...pageEnd(loaded)
      })
      return true
    },
    /**
     * Shows the loaded records of another filter at once; the sync then
     * loads its first page. They are a prefix of that filter's list.
     */
    showFilter(filter: ActivityHistoryFilter): void {
      if (filter === page.filter) return
      generation++
      setPage({ filter, records: page.records.filter((record) => matchesActivityFilter(record, filter)), hasMore: true })
      panel = page
      notify(panelListeners)
    },
    /** Keeps at most the first page (leaving the Activity page); the next entry reloads. */
    trim(size = ACTIVITY_PAGE_SIZE): void {
      if (page.records.length <= size) return
      generation++
      setPage({ filter: page.filter, records: page.records.slice(0, size), hasMore: true })
      // The hidden page lets go of the rest too; entering shows the same first rows.
      panel = page
      notify(panelListeners)
    },
    /**
     * Clears the history here and, through the sync, in Main. Queued changes
     * are dropped: the clear supersedes them. Before the stored history
     * loaded only this session's records go, as before.
     */
    clear(): void {
      generation++
      page = { filter: page.filter, records: [], hasMore: false }
      panel = page
      summary = summary && emptySummary()
      outbox = ready ? [{ type: 'clear' }] : []
      sending = []
      notify(listeners)
      notify(panelListeners)
      notify(outboxListeners)
    },
    /** Main already deleted everything (clear local data): nothing to send. */
    reset(): void {
      generation++
      page = { filter: 'all', records: [], hasMore: false }
      panel = page
      summary = summary && emptySummary()
      outbox = []
      notify(listeners)
      notify(panelListeners)
    },
    /**
     * Queues the migration of the legacy localStorage history in front of
     * this session's changes: the stored list becomes
     * mergeActivityRecords(legacy, stored), as the former full replace did.
     */
    queueLegacyMigration(legacy: readonly ActivityRecord[], mayBeIncomplete: boolean): void {
      const changes: ActivityOutboxEntry[] = [...legacy].reverse().map((record) =>
        ({ type: 'upsert', record, position: 'front' }))
      changes.push({ type: 'remove-duplicates' })
      // The stored flag stays set when it was; the legacy history can only add to it.
      if (mayBeIncomplete) changes.push({ type: 'legacy-flag', value: true })
      const wasEmpty = outbox.length === 0
      outbox = [...changes, ...outbox]
      if (wasEmpty) notify(outboxListeners)
    },

    getOutbox(): readonly ActivityOutboxEntry[] {
      return outbox
    },
    subscribeOutbox: subscribe(outboxListeners),
    /** Removes and returns the first `count` outbox entries. */
    takeOutbox(count: number): ActivityOutboxEntry[] {
      sending = outbox.splice(0, count)
      return sending
    },
    /**
     * The taken entries are saved. calls are Main's stored records of the
     * sent upsert-call changes: a call whose earlier record was not loaded
     * keeps that record's id and createdAt, so the loaded copy takes them.
     */
    acknowledge(calls: readonly ActivityRecord[] = []): void {
      const sent = sending.flatMap((entry) => (entry.type === 'upsert-call' ? [entry.record.id] : []))
      sending = []
      // The renderer's id of each sent call record -> the id Main keeps.
      const renamed = new Map<string, ActivityRecord>()
      sent.forEach((id, index) => {
        const stored = calls[index]
        if (stored && stored.id !== id) renamed.set(id, stored)
      })
      if (renamed.size === 0) return
      const records = page.records.map((record) => {
        const stored = renamed.get(record.id)
        return stored ? { ...record, id: stored.id, createdAt: stored.createdAt, scope: stored.scope } : record
      })
      // Later queued changes refer to the renderer's id only through content, never by id.
      setPage({ ...page, records: mergeActivityRecords(records, []) })
    },    /** Puts entries that failed to save back in front, in order. */
    requeue(entries: readonly ActivityOutboxEntry[]): void {
      sending = []
      if (outbox[0]?.type === 'clear') return
      outbox = [...entries, ...outbox]
    }
  }
}

const callKey = (record: ActivityRecord): string =>
  JSON.stringify([record.kind, record.requestId, record.callId])

const recordKeys: readonly (keyof ActivityRecord)[] = [
  'id', 'conversationId', 'requestId', 'callId', 'kind', 'title', 'detail', 'status', 'createdAt'
]
function sameRecords(left: readonly ActivityRecord[], right: readonly ActivityRecord[]): boolean {
  return left.length === right.length && left.every((record, index) => {
    const other = right[index]!
    return record === other || (recordKeys.every((key) => record[key] === other[key]) &&
      JSON.stringify(record.scope) === JSON.stringify(other.scope))
  })
}
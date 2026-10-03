import { useCallback, useEffect, useRef } from 'react'
import type {
  ActivityHistoryChange,
  ActivityHistoryFilter,
  ActivityHistoryPage,
  ActivityHistoryPageRequest,
  ActivityHistoryReconcileRequest,
  ActivityHistorySummary,
  ActivityHistorySummaryRequest,
  ActivityHistoryUpdate,
  ActivityHistoryUpdateResult
} from '../../shared/assistant-contracts'
import i18n from './i18n'
import {
  ACTIVITY_FIRST_PAGE_SIZE,
  ACTIVITY_PAGE_SIZE,
  clearLegacyActivityHistory,
  isActivityChange,
  type ActivityOutboxEntry,
  type ActivityStore,
  type LegacyActivityHistory
} from './activity-store'

/**
 * Activity history IPC with Main (P4): startup (legacy migration, reconcile,
 * first page and summary), pages on demand, and the incremental save queue.
 * Changes collect in the store's outbox and leave 250 ms after the first
 * one, at most 20,000 per `update` call. A failed save keeps its changes
 * queued, in order, and is retried with backoff; quitting and unmounting
 * flush what is left.
 */
export type ActivityHistoryApi = {
  update: (update: ActivityHistoryUpdate) => Promise<ActivityHistoryUpdateResult | void>
  clear: () => Promise<void>
  page: (request: ActivityHistoryPageRequest) => Promise<ActivityHistoryPage>
  summary: (request: ActivityHistorySummaryRequest) => Promise<ActivityHistorySummary>
  reconcile: (request: ActivityHistoryReconcileRequest) => Promise<number>
}

export const ACTIVITY_SAVE_DELAY_MS = 250
export const ACTIVITY_MAX_CHANGES_PER_UPDATE = 20_000
/** The Activity page shows this many records before "load more", as before paging. */
export const ACTIVITY_VISIBLE_BATCH = 500
const MAX_SUMMARY_CONVERSATIONS = 5_000
const RETRY_DELAYS_MS = [1_000, 2_000, 5_000, 10_000, 30_000]

export type ActivitySync = {
  /** Sends every queued change; resolves when done or after a failure. */
  flush: () => Promise<void>
  stop: () => void
}

type Timers = {
  setTimeout: (callback: () => void, delay: number) => unknown
  clearTimeout: (handle: unknown) => void
}

const defaultTimers: Timers = {
  setTimeout: (callback, delay) => globalThis.setTimeout(callback, delay),
  clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>)
}

const saving = new WeakMap<ActivityStore, Promise<void>>()

export function startActivitySync(
  store: ActivityStore,
  api: Pick<ActivityHistoryApi, 'update' | 'clear' | 'reconcile'>,
  options: { onSaveFailed: () => void; onDrained?: () => void; timers?: Timers; delayMs?: number }
): ActivitySync {
  const timers = options.timers ?? defaultTimers
  const delayMs = options.delayMs ?? ACTIVITY_SAVE_DELAY_MS
  let timer: unknown
  let failures = 0
  let stopped = false

  const schedule = (delay: number): void => {
    if (stopped || timer !== undefined) return
    timer = timers.setTimeout(() => {
      timer = undefined
      void flush()
    }, delay)
  }

  /** Sends the next batch; false when it failed. */
  const sendNext = async (): Promise<boolean> => {
    const first = store.getOutbox()[0]
    if (!first) return true
    let batch: ActivityOutboxEntry[] = []
    try {
      if (first.type === 'clear') {
        batch = store.takeOutbox(1)
        await api.clear()
      } else if (first.type === 'reconcile') {
        batch = store.takeOutbox(1)
        await api.reconcile(first.request)
      } else if (first.type === 'legacy-flag') {
        batch = store.takeOutbox(1)
        await api.update({ changes: [], legacyHistoryMayBeIncomplete: first.value })
      } else {
        const outbox = store.getOutbox()
        let count = 0
        while (count < outbox.length && count < ACTIVITY_MAX_CHANGES_PER_UPDATE && isActivityChange(outbox[count]!)) {
          count++
        }
        batch = store.takeOutbox(count)
        const result = await api.update({ changes: batch as ActivityHistoryChange[] })
        store.acknowledge(result ? result.calls : [])
        return true
      }
    } catch {
      store.requeue(batch)
      return false
    }
    store.acknowledge()
    return true
  }

  const run = async (): Promise<void> => {
    while (store.getOutbox().length > 0) {
      if (!(await sendNext())) {
        failures++
        if (failures === 1) options.onSaveFailed()
        schedule(RETRY_DELAYS_MS[Math.min(failures, RETRY_DELAYS_MS.length) - 1]!)
        return
      }
      failures = 0
    }
    options.onDrained?.()
  }

  const flush = async (): Promise<void> => {
    if (!store.isReady()) return
    if (timer !== undefined) {
      timers.clearTimeout(timer)
      timer = undefined
    }
    // One save at a time per store, also across a remounted sync.
    const previous = saving.get(store) ?? Promise.resolve()
    const current = previous.then(run)
    saving.set(store, current)
    await current
  }

  const unsubscribe = store.subscribeOutbox(() => {
    if (store.isReady() && store.getOutbox().length > 0 && failures === 0) schedule(delayMs)
  })
  if (store.isReady() && store.getOutbox().length > 0) schedule(delayMs)

  return {
    flush,
    stop: () => {
      unsubscribe()
      stopped = true
      if (timer !== undefined) timers.clearTimeout(timer)
      timer = undefined
    }
  }
}

/** Loads the first page of the store's filter (replacing the loaded pages). */
export async function loadFirstActivityPage(
  store: ActivityStore,
  api: Pick<ActivityHistoryApi, 'page'>,
  limit: number = ACTIVITY_FIRST_PAGE_SIZE,
  filter: ActivityHistoryFilter = store.getPage().filter
): Promise<void> {
  const generation = store.getGeneration()
  const page = await api.page({ limit, ...(filter === 'all' ? {} : { filter }) })
  store.setFirstPage(filter, page, generation)
}

/** Loads the page after the loaded ones, when there is one. */
export async function loadNextActivityPage(
  store: ActivityStore,
  api: Pick<ActivityHistoryApi, 'page'>
): Promise<void> {
  const { filter, nextBefore, hasMore } = store.getPage()
  if (!hasMore) return
  if (nextBefore === undefined) {
    // Trimmed: reload the head, then continue from its end as if never trimmed.
    await loadFirstActivityPage(store, api, ACTIVITY_PAGE_SIZE)
    if (store.getPage().nextBefore !== undefined) await loadNextActivityPage(store, api)
    return
  }
  const generation = store.getGeneration()
  const page = await api.page({ before: nextBefore, limit: ACTIVITY_PAGE_SIZE, ...(filter === 'all' ? {} : { filter }) })
  store.appendPage(page, generation, nextBefore)
}

/** Reloads the summary for the conversations the page shows. */
export async function refreshActivitySummary(
  store: ActivityStore,
  api: Pick<ActivityHistoryApi, 'summary'>
): Promise<void> {
  const conversationIds = [...new Set(store.getPanel().records.map((record) => record.conversationId))]
    .slice(0, MAX_SUMMARY_CONVERSATIONS)
  store.setSummary(await api.summary({ conversationIds }))
}

/**
 * Startup: queue the legacy migration, let saves start and send what is
 * queued, let Main end records left running by the previous session, then
 * load the first page.
 */
export async function loadActivityHistory(
  store: ActivityStore,
  api: Pick<ActivityHistoryApi, 'page' | 'reconcile'>,
  legacy: LegacyActivityHistory,
  handlers: {
    flush: () => Promise<void>
    activeRequestIds: () => ReadonlySet<string>
    onReadFailed: () => void
    isActive: () => boolean
  }
): Promise<void> {
  if (legacy.records.length > 0 || legacy.historyMayBeIncomplete) {
    store.queueLegacyMigration(legacy.records, legacy.historyMayBeIncomplete)
  }
  store.markReady()
  await handlers.flush()
  if (!handlers.isActive()) return
  try {
    await api.reconcile({
      activeRequestIds: [...handlers.activeRequestIds()],
      interruptedDetail: i18n.t('records.interruptedOnRestart', { ns: 'activity' })
    })
  } catch {
    // The next task refresh reconciles again.
  }
  if (!handlers.isActive()) return
  try {
    await loadFirstActivityPage(store, api)
  } catch {
    if (handlers.isActive()) handlers.onReadFailed()
  }
}

/**
 * Loads the stored history on mount, then saves changes incrementally. The
 * returned actions are stable: `flush` (quit handshake), `show` (the
 * Activity page opens or its timer/refresh runs: flush, load at least one
 * visible batch, refresh the snapshot and summary), `hide`, `loadMore` and
 * `setFilter`.
 */
export function useActivityHistorySync(
  store: ActivityStore,
  legacy: LegacyActivityHistory,
  options: {
    activeRequestIds: () => ReadonlySet<string>
    onReadFailed: () => void
    onSaveFailed: () => void
    onLoaded?: () => void
  }
): {
  flush: () => Promise<void>
  show: () => Promise<void>
  hide: () => void
  loadMore: () => Promise<void>
  setFilter: (filter: ActivityHistoryFilter) => Promise<void>
} {
  const optionsRef = useRef(options)
  useEffect(() => {
    optionsRef.current = options
  })
  const syncRef = useRef<ActivitySync | undefined>(undefined)
  useEffect(() => {
    let active = true
    let migrating = legacy.records.length > 0 || legacy.historyMayBeIncomplete
    const api = window.goodbuddy.activityHistory
    const sync = startActivitySync(store, api, {
      onSaveFailed: () => optionsRef.current.onSaveFailed(),
      onDrained: () => {
        // The legacy records are in Main once the queue in front of them drained.
        if (migrating) clearLegacyActivityHistory()
        migrating = false
      }
    })
    syncRef.current = sync
    void loadActivityHistory(store, api, legacy, {
      flush: sync.flush,
      activeRequestIds: () => optionsRef.current.activeRequestIds(),
      onReadFailed: () => optionsRef.current.onReadFailed(),
      isActive: () => active
    }).then(() => {
      if (active) optionsRef.current.onLoaded?.()
    })
    return () => {
      active = false
      sync.stop()
      if (syncRef.current === sync) syncRef.current = undefined
      void sync.flush()
    }
  }, [legacy, store])
  const flush = useCallback(async () => {
    await syncRef.current?.flush()
  }, [])
  const api = (): ActivityHistoryApi => window.goodbuddy.activityHistory
  const show = useCallback(async () => {
    store.refreshPanel()
    await flush()
    try {
      if (store.getRecords().length < ACTIVITY_VISIBLE_BATCH && store.getPage().hasMore) {
        await loadFirstActivityPage(store, api(), ACTIVITY_VISIBLE_BATCH)
        store.refreshPanel()
      }
      await refreshActivitySummary(store, api())
    } catch {
      optionsRef.current.onReadFailed()
    }
  }, [flush, store])
  const hide = useCallback(() => store.trim(), [store])
  const loadMore = useCallback(async () => {
    try {
      await flush()
      await loadNextActivityPage(store, api())
      store.refreshPanel()
      await refreshActivitySummary(store, api())
    } catch {
      optionsRef.current.onReadFailed()
    }
  }, [flush, store])
  const setFilter = useCallback(async (filter: ActivityHistoryFilter) => {
    store.showFilter(filter)
    try {
      await flush()
      await loadFirstActivityPage(store, api(), ACTIVITY_VISIBLE_BATCH, filter)
      store.refreshPanel()
      await refreshActivitySummary(store, api())
    } catch {
      optionsRef.current.onReadFailed()
    }
  }, [flush, store])
  return { flush, show, hide, loadMore, setFilter }
}

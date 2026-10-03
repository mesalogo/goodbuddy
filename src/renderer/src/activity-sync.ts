import { useCallback, useEffect, useRef } from 'react'
import type {
  ActivityHistoryChange,
  ActivityHistorySnapshot,
  ActivityHistoryUpdate,
  ActivityRecord
} from '../../shared/assistant-contracts'
import {
  clearLegacyActivityHistory,
  mergeActivityRecords,
  type ActivityOutboxEntry,
  type ActivityStore,
  type LegacyActivityHistory
} from './activity-store'

/**
 * Activity history IPC with Main (P4): the first load with the legacy
 * localStorage migration, and the incremental save queue. Changes collect in
 * the store's outbox and leave 250 ms after the first one, at most 20,000 per
 * `update` call. A failed save keeps its changes queued, in order, and is
 * retried with backoff; quitting and unmounting flush what is left.
 */
export type ActivityHistoryApi = {
  get: () => Promise<ActivityHistorySnapshot>
  replace: (records: ActivityRecord[], legacyHistoryMayBeIncomplete: boolean) => Promise<void>
  update: (update: ActivityHistoryUpdate) => Promise<void>
  clear: () => Promise<void>
}

export const ACTIVITY_SAVE_DELAY_MS = 250
export const ACTIVITY_MAX_CHANGES_PER_UPDATE = 20_000
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
  api: ActivityHistoryApi,
  options: { onSaveFailed: () => void; timers?: Timers; delayMs?: number }
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
    let batch: ActivityOutboxEntry[]
    try {
      if (first.type === 'clear') {
        batch = store.takeOutbox(1)
        await api.clear()
      } else if (first.type === 'replace') {
        // The full list already contains everything queued after the marker.
        batch = store.takeOutbox(store.getOutbox().length)
        await api.replace([...store.getRecords()], store.isLegacyIncomplete())
      } else {
        const outbox = store.getOutbox()
        let count = 0
        while (
          count < outbox.length &&
          count < ACTIVITY_MAX_CHANGES_PER_UPDATE &&
          outbox[count]!.type !== 'clear' &&
          outbox[count]!.type !== 'replace'
        ) {
          count++
        }
        batch = store.takeOutbox(count)
        await api.update({ changes: batch as ActivityHistoryChange[] })
      }
    } catch {
      store.requeue(batch!)
      return false
    }
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
    if (store.isReady() && store.getOutbox().length > 0 && failures === 0) {
      schedule(delayMs)
    }
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

/**
 * Loads the stored history on mount, then saves changes incrementally. The
 * returned `flush` (stable) sends what is queued, for the quit handshake; the
 * queue is also flushed on unmount.
 */
export function useActivityHistorySync(
  store: ActivityStore,
  legacy: LegacyActivityHistory,
  notices: { onReadFailed: () => void; onSaveFailed: () => void; onLoaded?: () => void }
): () => Promise<void> {
  const noticesRef = useRef(notices)
  useEffect(() => {
    noticesRef.current = notices
  })
  const syncRef = useRef<ActivitySync | undefined>(undefined)
  useEffect(() => {
    let active = true
    const api = window.goodbuddy.activityHistory
    const onSaveFailed = (): void => noticesRef.current.onSaveFailed()
    const sync = startActivitySync(store, api, { onSaveFailed })
    syncRef.current = sync
    void loadActivityHistory(store, api, legacy, {
      onReadFailed: () => noticesRef.current.onReadFailed(),
      onSaveFailed,
      isActive: () => active
    }).then(() => {
      if (active && store.isReady()) noticesRef.current.onLoaded?.()
    })
    return () => {
      active = false
      sync.stop()
      if (syncRef.current === sync) syncRef.current = undefined
      void sync.flush()
    }
  }, [legacy, store])
  return useCallback(async () => {
    await syncRef.current?.flush()
  }, [])
}

/**
 * Loads the stored history once. A legacy localStorage history is written
 * together with it as a full `replace` and then removed; the store is ready
 * (saves start) only after the load succeeded.
 */
export async function loadActivityHistory(
  store: ActivityStore,
  api: ActivityHistoryApi,
  legacy: LegacyActivityHistory,
  handlers: { onReadFailed: () => void; onSaveFailed: () => void; isActive: () => boolean }
): Promise<void> {
  let snapshot: ActivityHistorySnapshot
  try {
    snapshot = await api.get()
  } catch {
    if (handlers.isActive()) handlers.onReadFailed()
    return
  }
  if (!handlers.isActive()) return
  let replaceFailed = false
  if (legacy.records.length > 0 || legacy.historyMayBeIncomplete) {
    // Everything queued so far is part of the list sent here.
    store.takeOutbox(store.getOutbox().length)
    try {
      await api.replace(
        mergeActivityRecords(store.getRecords(), snapshot.records),
        legacy.historyMayBeIncomplete || snapshot.legacyHistoryMayBeIncomplete
      )
      clearLegacyActivityHistory()
    } catch {
      replaceFailed = true
      handlers.onSaveFailed()
    }
    if (!handlers.isActive()) return
  }
  store.mergeLoaded(snapshot.records, snapshot.legacyHistoryMayBeIncomplete)
  if (replaceFailed) store.requireReplace()
}

// @vitest-environment node
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type {
  ActivityHistorySnapshot,
  ActivityHistoryUpdate,
  ActivityRecord,
  AssistantTask
} from '../../shared/assistant-contracts'
import { createActivityStore, type ActivityStore } from './activity-store'
import {
  loadActivityHistory,
  startActivitySync,
  type ActivityHistoryApi
} from './activity-sync'

/** The part of Main's AssistantDatabase these tests use (a real database on a temp file). */
type AssistantDatabase = {
  initialize: (directory: string) => void
  close: () => void
  getActivityHistory: () => ActivityHistorySnapshot
  replaceActivityHistory: (input: unknown) => void
  updateActivityHistory: (input: unknown) => void
  clearActivityHistory: () => void
}
let AssistantDatabase: new (path: string) => AssistantDatabase
beforeAll(async () => {
  // Main code is outside the renderer TypeScript project; load it untyped.
  const mainModule = '../../main/assistant/assistant-database'
  ;({ AssistantDatabase } = (await import(mainModule)) as {
    AssistantDatabase: typeof AssistantDatabase
  })
})

const directories: string[] = []
const opened: AssistantDatabase[] = []
afterEach(() => {
  for (const database of opened.splice(0)) database.close()
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

function openDatabase(): AssistantDatabase {
  const directory = mkdtempSync(join(tmpdir(), 'goodbuddy-activity-sync-'))
  directories.push(directory)
  const database = new AssistantDatabase(join(directory, 'assistant.sqlite'))
  database.initialize(directory)
  opened.push(database)
  return database
}

/** IPC double over a real database; `fail()` decides whether a call throws first. */
function databaseApi(
  database: AssistantDatabase,
  fail: () => boolean = () => false
): ActivityHistoryApi & { updates: ActivityHistoryUpdate[] } {
  const updates: ActivityHistoryUpdate[] = []
  const guard = (): void => {
    if (fail()) throw new Error('injected save failure')
  }
  return {
    updates,
    get: async () => database.getActivityHistory(),
    replace: async (records, legacyHistoryMayBeIncomplete) => {
      guard()
      database.replaceActivityHistory(
        structuredClone({ records, legacyHistoryMayBeIncomplete })
      )
    },
    update: async (update) => {
      guard()
      updates.push(update)
      database.updateActivityHistory(structuredClone(update))
    },
    clear: async () => {
      guard()
      database.clearActivityHistory()
    }
  }
}

const manualTimers = {
  setTimeout: () => 1,
  clearTimeout: () => undefined
}

function makeRandom(seed: number): () => number {
  let state = seed
  return () => (state = (state * 1664525 + 1013904223) >>> 0) / 4294967296
}

let counter = 0
function record(overrides: Partial<ActivityRecord> = {}): ActivityRecord {
  counter += 1
  return {
    id: `record-${counter}`,
    conversationId: `conversation-${counter % 3}`,
    requestId: `request-${counter % 5}`,
    scope: { kind: 'global' },
    kind: 'tool',
    title: `Tool ${counter}`,
    detail: `detail ${counter}`,
    status: 'running',
    createdAt: counter,
    ...overrides
  }
}

function task(id: string, status: AssistantTask['status']): AssistantTask {
  return {
    id,
    title: id,
    instructions: id,
    workMode: 'ask',
    status,
    createdAt: new Date(0).toISOString()
  } as AssistantTask
}

async function loadedStore(api: ActivityHistoryApi): Promise<ActivityStore> {
  const store = createActivityStore()
  await loadActivityHistory(
    store,
    api,
    { records: [], historyMayBeIncomplete: false },
    { onReadFailed: () => undefined, onSaveFailed: () => undefined, isActive: () => true }
  )
  return store
}

describe('activity history sync', () => {
  it('stores what a full replace of the final list stores, for random actions, flushes and failures', async () => {
    for (const seed of [3, 17, 2026]) {
      const random = makeRandom(seed)
      const pick = <T,>(items: readonly T[]): T =>
        items[Math.floor(random() * items.length)]!
      const incremental = openDatabase()
      // Legacy history with duplicate IDs, stored by the former full replace.
      const first = record({ id: 'dup' })
      const legacy = [
        first,
        record({ status: 'completed' }),
        { ...first, detail: 'older duplicate' },
        record({ kind: 'request', status: 'running', requestId: 'request-1' }),
        record({ kind: 'approval', status: 'pending', conversationId: 'conversation-1' })
      ]
      incremental.replaceActivityHistory({
        records: legacy,
        legacyHistoryMayBeIncomplete: seed % 2 === 0
      })
      let failing = false
      let expectedFlag = seed % 2 === 0
      const api = databaseApi(incremental, () => failing && random() < 0.5)
      const store = await loadedStore(api)
      const sync = startActivitySync(store, api, {
        onSaveFailed: () => undefined,
        timers: manualTimers
      })
      const callIds = ['a', 'b', 'c', 'd']
      for (let step = 0; step < 400; step++) {
        const roll = random()
        const requestId = `request-${Math.floor(random() * 5)}`
        if (roll < 0.3) {
          const kind = pick(['tool', 'subagent', 'request', 'result', 'approval'] as const)
          store.record(record({
            kind,
            requestId,
            ...(kind === 'tool' || kind === 'subagent' ? { callId: pick(callIds) } : {}),
            status: pick(['pending', 'running', 'completed', 'failed'] as const)
          }))
        } else if (roll < 0.4) {
          store.updateRequest(requestId, pick(['completed', 'failed'] as const), random() < 0.5 ? 'done' : undefined)
        } else if (roll < 0.47) {
          store.updateApproval(`conversation-${Math.floor(random() * 3)}`, 'denied', 'decision')
        } else if (roll < 0.52) {
          store.removeByRequest(requestId)
        } else if (roll < 0.58) {
          store.removeToolByCallId(requestId, pick(callIds))
        } else if (roll < 0.65) {
          store.settleRequest(requestId, 'interrupted', 'incomplete')
        } else if (roll < 0.72) {
          store.reconcile(
            [task('request-0', 'completed'), task('request-2', 'failed'), task('request-3', 'running')],
            new Set(random() < 0.5 ? ['request-1'] : [])
          )
        } else if (roll < 0.74) {
          store.clear()
          expectedFlag = false
        } else if (roll < 0.8) {
          failing = random() < 0.4
        } else {
          await sync.flush()
        }
      }
      failing = false
      await sync.flush()
      expect(store.getOutbox()).toEqual([])

      const replaced = openDatabase()
      replaced.replaceActivityHistory({
        records: [...store.getRecords()],
        legacyHistoryMayBeIncomplete: expectedFlag
      })
      expect(incremental.getActivityHistory()).toEqual(replaced.getActivityHistory())
      expect(incremental.getActivityHistory().records).toEqual(store.getRecords())
      sync.stop()
    }
  })

  it('sends only the changed records', async () => {
    const database = openDatabase()
    const records = Array.from({ length: 5_000 }, () => record({ status: 'completed' }))
    database.replaceActivityHistory({ records, legacyHistoryMayBeIncomplete: false })
    const api = databaseApi(database)
    const store = await loadedStore(api)
    const sync = startActivitySync(store, api, { onSaveFailed: () => undefined, timers: manualTimers })

    const tool = record({ callId: 'call-1', requestId: 'request-x' })
    store.record(tool)
    store.record({ ...tool, id: 'ignored', detail: 'progress', status: 'completed' })
    store.updateRequest(records[4_000]!.requestId, 'failed')
    await sync.flush()
    // Two consecutive upserts of the tool collapse into one.
    expect(api.updates).toHaveLength(1)
    const changes = api.updates[0]!.changes
    const requestRecords = records.filter(
      (item) => item.requestId === records[4_000]!.requestId && item.kind === 'request'
    )
    expect(changes).toHaveLength(1 + requestRecords.length)
    expect(JSON.stringify(api.updates[0]).length).toBeLessThan(1_000)
    expect(database.getActivityHistory().records[0]).toMatchObject({
      id: tool.id,
      detail: 'progress'
    })
    sync.stop()
  })

  it('keeps failed changes queued and retries them in order with backoff', async () => {
    const database = openDatabase()
    let fail = true
    const api = databaseApi(database, () => fail)
    const store = await loadedStore(api)
    const delays: number[] = []
    const callbacks: Array<() => void> = []
    const onSaveFailed = vi.fn()
    const sync = startActivitySync(store, api, {
      onSaveFailed,
      timers: {
        setTimeout: (callback, delay) => {
          delays.push(delay)
          callbacks.push(callback)
          return callbacks.length
        },
        clearTimeout: () => undefined
      }
    })
    const a = record()
    const b = record()
    store.record(a)
    expect(delays).toEqual([250])
    callbacks.shift()!()
    await vi.waitFor(() => expect(delays).toEqual([250, 1_000]))
    store.record(b)
    callbacks.shift()!()
    await vi.waitFor(() => expect(delays).toEqual([250, 1_000, 2_000]))
    expect(onSaveFailed).toHaveBeenCalledTimes(1)
    fail = false
    callbacks.shift()!()
    await vi.waitFor(() =>
      expect(database.getActivityHistory().records.map((item) => item.id)).toEqual([b.id, a.id])
    )
    expect(store.getOutbox()).toEqual([])
    sync.stop()
  })

  it('clears the database in one call and drops queued changes', async () => {
    const database = openDatabase()
    database.replaceActivityHistory({ records: [record(), record()], legacyHistoryMayBeIncomplete: true })
    const api = databaseApi(database)
    const update = vi.spyOn(api, 'update')
    const store = await loadedStore(api)
    const sync = startActivitySync(store, api, { onSaveFailed: () => undefined, timers: manualTimers })
    store.record(record())
    store.clear()
    await sync.flush()
    expect(update).not.toHaveBeenCalled()
    expect(database.getActivityHistory()).toEqual({ records: [], legacyHistoryMayBeIncomplete: false })
    expect(store.getRecords()).toEqual([])
    sync.stop()
  })

  it('migrates legacy records with one replace and retries it in full after a failure', async () => {
    const database = openDatabase()
    const stored = record({ status: 'completed' })
    database.replaceActivityHistory({ records: [stored], legacyHistoryMayBeIncomplete: false })
    let fail = true
    const api = databaseApi(database, () => fail)
    const legacyRecord = record({ status: 'completed' })
    const store = createActivityStore([legacyRecord], true)
    await loadActivityHistory(
      store,
      api,
      { records: [legacyRecord], historyMayBeIncomplete: true },
      { onReadFailed: () => undefined, onSaveFailed: () => undefined, isActive: () => true }
    )
    expect(store.getRecords()).toEqual([legacyRecord, stored])
    expect(store.getOutbox()).toEqual([{ type: 'replace' }])
    fail = false
    const sync = startActivitySync(store, api, { onSaveFailed: () => undefined, timers: manualTimers })
    await sync.flush()
    expect(database.getActivityHistory()).toEqual({
      records: [legacyRecord, stored],
      legacyHistoryMayBeIncomplete: true
    })
    sync.stop()
  })
})

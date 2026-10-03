// @vitest-environment node
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type {
  ActivityHistoryPage,
  ActivityHistorySnapshot,
  ActivityHistorySummary,
  ActivityHistoryUpdate,
  ActivityRecord,
  AssistantTask
} from '../../shared/assistant-contracts'
import { firstOccurrences } from '../../shared/activity-history-reference'
import i18n from './i18n'
import {
  ACTIVITY_FIRST_PAGE_SIZE,
  createActivityStore,
  mergeActivityRecords,
  reconcileActivityRecords,
  upsertActivityRecord,
  type ActivityStore
} from './activity-store'
import {
  loadActivityHistory,
  loadFirstActivityPage,
  loadNextActivityPage,
  refreshActivitySummary,
  startActivitySync,
  type ActivityHistoryApi
} from './activity-sync'

/** The part of Main's AssistantDatabase these tests use (a real database on a temp file). */
type AssistantDatabase = {
  initialize: (directory: string) => void
  close: () => void
  getActivityHistory: () => ActivityHistorySnapshot
  replaceActivityHistory: (input: unknown) => void
  updateActivityHistory: (input: unknown) => { calls: ActivityRecord[] }
  clearActivityHistory: () => void
  getActivityHistoryPage: (input: unknown) => ActivityHistoryPage
  getActivityHistorySummary: (input: unknown) => ActivityHistorySummary
  reconcileActivityHistory: (input: unknown) => number
  createTask: (input: { id: string; title: string; instructions: string; workMode: 'ask' }) => AssistantTask
  updateTaskStatus: (taskId: string, status: AssistantTask['status']) => void
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

type TestApi = ActivityHistoryApi & { updates: ActivityHistoryUpdate[]; calls: string[] }

/** IPC double over a real database (structured clones, like IPC); `fail()` makes a save throw. */
function databaseApi(database: AssistantDatabase, fail: () => boolean = () => false): TestApi {
  const updates: ActivityHistoryUpdate[] = []
  const calls: string[] = []
  const guard = (name: string): void => {
    calls.push(name)
    if (fail()) throw new Error('injected save failure')
  }
  return {
    updates,
    calls,
    update: async (update) => {
      guard('update')
      updates.push(update)
      return structuredClone(database.updateActivityHistory(structuredClone(update)))
    },
    clear: async () => {
      guard('clear')
      database.clearActivityHistory()
    },
    reconcile: async (request) => {
      guard('reconcile')
      return database.reconcileActivityHistory(structuredClone(request))
    },
    page: async (request) => {
      calls.push('page')
      return database.getActivityHistoryPage(structuredClone(request))
    },
    summary: async (request) => {
      calls.push('summary')
      return database.getActivityHistorySummary(structuredClone(request))
    }
  }
}

const manualTimers = { setTimeout: () => 1, clearTimeout: () => undefined }

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

async function startup(
  store: ActivityStore,
  api: TestApi,
  sync: { flush: () => Promise<void> },
  activeRequestIds: ReadonlySet<string> = new Set(),
  legacy: ActivityRecord[] = [],
  legacyIncomplete = false
): Promise<void> {
  await loadActivityHistory(store, api, { records: legacy, historyMayBeIncomplete: legacyIncomplete }, {
    flush: sync.flush,
    activeRequestIds: () => activeRequestIds,
    onReadFailed: () => undefined,
    isActive: () => true
  })
}

/**
 * The former App behavior over the whole list (activity state = every
 * record), used as the oracle the paged store plus Main must match.
 */
function oracle(initial: readonly ActivityRecord[]) {
  let list = firstOccurrences(initial)
  return {
    get: () => list,
    record: (incoming: ActivityRecord) => { list = upsertActivityRecord(list, incoming) },
    updateRequest: (requestId: string, status: ActivityRecord['status'], detail?: string) => {
      list = list.map((item) => item.requestId === requestId && item.kind === 'request'
        ? { ...item, status, detail: detail ?? item.detail } : item)
    },
    updateApproval: (conversationId: string, status: ActivityRecord['status'], line: string) => {
      let updated = false
      list = list.map((item) => {
        if (updated || item.conversationId !== conversationId || item.kind !== 'approval' || item.status !== 'pending') return item
        updated = true
        return { ...item, status, detail: `${item.detail}\n${line}` }
      })
    },
    removeByRequest: (requestId: string) => { list = list.filter((item) => item.requestId !== requestId) },
    removeToolByCallId: (requestId: string, callId: string) => {
      list = list.filter((item) => !(item.requestId === requestId && item.kind === 'tool' && item.callId === callId))
    },
    settleRequest: (requestId: string, status: ActivityRecord['status'], line: string) => {
      list = list.map((item) => item.requestId === requestId && item.kind !== 'request' &&
        (item.status === 'pending' || item.status === 'running')
        ? { ...item, status, detail: `${item.detail}\n${line}` } : item)
    },
    reconcile: (tasks: readonly AssistantTask[], active: ReadonlySet<string>) => {
      list = reconcileActivityRecords(list, tasks, active)
    },
    clear: () => { list = [] },
    prepend: (records: readonly ActivityRecord[]) => { list = mergeActivityRecords(records, list) }
  }
}

describe('activity history sync (paged)', () => {
  it('ends in the state the former full-list code saved, for random actions, pages, trims, flushes and failures', async () => {
    for (const seed of [3, 17, 2026, 41, 7777, 90210]) {
      const random = makeRandom(seed)
      const pick = <T,>(items: readonly T[]): T => items[Math.floor(random() * items.length)]!
      const database = openDatabase()
      // Stored history with legacy duplicate IDs; the first occurrence is the shown one.
      const stored = Array.from({ length: 260 }, (_, index) => record({
        kind: pick(['tool', 'subagent', 'request', 'result', 'approval'] as const),
        status: pick(['pending', 'running', 'completed', 'failed'] as const),
        requestId: `request-${index % 7}`,
        conversationId: `conversation-${index % 4}`,
        ...(index % 3 === 0 ? { callId: pick(['a', 'b', 'c']) } : {})
      }))
      stored.splice(40, 0, { ...stored[3]!, detail: 'hidden duplicate' })
      stored.splice(250, 0, { ...stored[200]!, detail: 'hidden duplicate' })
      database.replaceActivityHistory({ records: stored, legacyHistoryMayBeIncomplete: false })
      const tasks: AssistantTask[] = []
      for (const [index, status] of (['completed', 'failed', 'running', 'cancelled'] as const).entries()) {
        const created = database.createTask({ id: `request-${index}`, title: 't', instructions: 'i', workMode: 'ask' })
        database.updateTaskStatus(created.id, status)
        tasks.push({ ...created, status })
      }
      const expected = oracle(stored)
      let failing = false
      const api = databaseApi(database, () => failing && random() < 0.5)
      const store = createActivityStore()
      const sync = startActivitySync(store, api, { onSaveFailed: () => undefined, timers: manualTimers })
      const active = new Set(['request-5'])
      await startup(store, api, sync, active)
      expected.reconcile(tasks, active)
      expect(store.getRecords().length).toBeLessThanOrEqual(ACTIVITY_FIRST_PAGE_SIZE)

      const callIds = ['a', 'b', 'c', 'd']
      for (let step = 0; step < 500; step++) {
        const roll = random()
        const requestId = `request-${Math.floor(random() * 8)}`
        const conversationId = `conversation-${Math.floor(random() * 4)}`
        if (roll < 0.25) {
          const kind = pick(['tool', 'subagent', 'request', 'result', 'approval'] as const)
          const incoming = record({
            kind, requestId, conversationId,
            ...(kind === 'tool' || kind === 'subagent' ? { callId: pick(callIds) } : {}),
            status: pick(['pending', 'running', 'completed', 'failed'] as const)
          })
          store.record(incoming)
          expected.record(incoming)
        } else if (roll < 0.35) {
          const status = pick(['completed', 'failed'] as const)
          const detail = random() < 0.5 ? 'done' : undefined
          store.updateRequest(requestId, status, detail)
          expected.updateRequest(requestId, status, detail)
        } else if (roll < 0.42) {
          store.updateApproval(conversationId, 'denied', 'decision')
          expected.updateApproval(conversationId, 'denied', 'decision')
        } else if (roll < 0.46) {
          store.removeByRequest(requestId)
          expected.removeByRequest(requestId)
        } else if (roll < 0.51) {
          const callId = pick(callIds)
          store.removeToolByCallId(requestId, callId)
          expected.removeToolByCallId(requestId, callId)
        } else if (roll < 0.57) {
          store.settleRequest(requestId, 'interrupted', 'incomplete')
          expected.settleRequest(requestId, 'interrupted', 'incomplete')
        } else if (roll < 0.62) {
          const running = new Set(random() < 0.5 ? ['request-1'] : [])
          store.reconcile(tasks, running)
          expected.reconcile(tasks, running)
        } else if (roll < 0.635) {
          store.clear()
          expected.clear()
        } else if (roll < 0.68) {
          failing = random() < 0.4
        } else if (roll < 0.73) {
          await loadNextActivityPage(store, api)
        } else if (roll < 0.76) {
          store.trim(Math.floor(random() * 60))
        } else if (roll < 0.79) {
          await loadFirstActivityPage(store, api, 1 + Math.floor(random() * 80))
        } else {
          await sync.flush()
        }
        // Loaded records are always the newest records of the full list.
        if (store.getOutbox().length === 0) {
          const loaded = store.getRecords()
          expect(loaded).toEqual(expected.get().slice(0, loaded.length))
        }
      }
      failing = false
      await sync.flush()
      expect(store.getOutbox()).toEqual([])
      const shown = firstOccurrences(database.getActivityHistory().records)
      expect(shown).toEqual(expected.get())
      const replaced = openDatabase()
      replaced.replaceActivityHistory({ records: expected.get(), legacyHistoryMayBeIncomplete: false })
      expect(shown).toEqual(replaced.getActivityHistory().records)
      sync.stop()
    }
  }, 60_000)

  it('keeps at most one page after startup and sends only changed records, including unloaded ones', async () => {
    const database = openDatabase()
    const records = Array.from({ length: 5_000 }, (_, index) => record({ status: 'completed', kind: index % 5 === 0 ? 'request' : 'tool', requestId: `request-${index}` }))
    database.replaceActivityHistory({ records, legacyHistoryMayBeIncomplete: false })
    const api = databaseApi(database)
    const store = createActivityStore()
    const sync = startActivitySync(store, api, { onSaveFailed: () => undefined, timers: manualTimers })
    await startup(store, api, sync)
    expect(store.getRecords()).toHaveLength(ACTIVITY_FIRST_PAGE_SIZE)
    expect(api.calls).toEqual(['reconcile', 'page'])

    const tool = record({ callId: 'call-1', requestId: 'request-x' })
    store.record(tool)
    store.record({ ...tool, id: 'ignored', detail: 'progress', status: 'completed' })
    // records[4_000] is far outside the loaded page.
    store.updateRequest(records[4_000]!.requestId, 'failed', 'late failure')
    await sync.flush()
    expect(api.updates).toHaveLength(1)
    expect(api.updates[0]!.changes).toHaveLength(3)
    expect(JSON.stringify(api.updates[0]).length).toBeLessThan(1_500)
    const after = database.getActivityHistory().records
    expect(after[0]).toMatchObject({ id: tool.id, detail: 'progress', status: 'completed' })
    expect(after.find((item) => item.id === records[4_000]!.id)).toMatchObject({ status: 'failed', detail: 'late failure' })
    expect(store.getRecords().length).toBeLessThanOrEqual(ACTIVITY_FIRST_PAGE_SIZE + 1)
    sync.stop()
  })

  it('shows a tool call once when its earlier record arrives on a later page while the update is queued', async () => {
    const database = openDatabase()
    const old = record({ kind: 'tool', callId: 'call-z', requestId: 'request-z', status: 'running' })
    const newer = Array.from({ length: 4 }, () => record({ status: 'completed' }))
    database.replaceActivityHistory({ records: [...newer, old], legacyHistoryMayBeIncomplete: false })
    const api = databaseApi(database)
    const store = createActivityStore()
    const sync = startActivitySync(store, api, { onSaveFailed: () => undefined, timers: manualTimers })
    await startup(store, api, sync)
    await loadFirstActivityPage(store, api, 2)
    const incoming = record({ kind: 'tool', callId: 'call-z', requestId: 'request-z', status: 'completed', detail: 'done' })
    store.record(incoming)
    await loadNextActivityPage(store, api)
    const expected = upsertActivityRecord([...newer, old], incoming)
    // Until saved, the call carries this session's id; content and order already match.
    const withoutIds = (list: readonly ActivityRecord[]): unknown[] =>
      list.map((item) => ({ ...item, id: undefined, createdAt: undefined }))
    expect(store.getRecords()).toHaveLength(5)

    expect(withoutIds(store.getRecords())).toEqual(withoutIds(expected))
    await sync.flush()
    expect(store.getRecords()).toEqual(expected.slice(0, store.getRecords().length))
    expect(database.getActivityHistory().records).toEqual(expected)
    sync.stop()
  })

  it('marks records left running by the previous session interrupted, with the same localized line', async () => {
    const database = openDatabase()
    const leftover = record({ status: 'running', requestId: 'gone', detail: 'reading' })
    const done = record({ status: 'running', requestId: 'finished', kind: 'request', detail: 'started' })
    const live = record({ status: 'running', requestId: 'live' })
    database.replaceActivityHistory({ records: [leftover, done, live], legacyHistoryMayBeIncomplete: false })
    const task = database.createTask({ id: 'finished', title: 't', instructions: 'i', workMode: 'ask' })
    database.updateTaskStatus(task.id, 'completed')
    const api = databaseApi(database)
    const store = createActivityStore()
    const sync = startActivitySync(store, api, { onSaveFailed: () => undefined, timers: manualTimers })
    await startup(store, api, sync, new Set(['live']))
    const line = i18n.t('records.interruptedOnRestart', { ns: 'activity' })
    expect(line.length).toBeGreaterThan(0)
    const expected = reconcileActivityRecords([leftover, done, live], [{ ...task, status: 'completed' }], new Set(['live']))
    expect(expected[0]!.detail).toBe(`reading\n${line}`)
    expect(database.getActivityHistory().records).toEqual(expected)
    expect(store.getRecords()).toEqual(expected)
    sync.stop()
  })

  it('keeps failed changes queued and retries them in order with backoff', async () => {
    const database = openDatabase()
    let fail = false
    const api = databaseApi(database, () => fail)
    const store = createActivityStore()
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
    await startup(store, api, sync)
    fail = true
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

  it('summarizes every loaded conversation, beyond one request', async () => {
    const records = Array.from({ length: 5_003 }, (_, index) =>
      record({ conversationId: `many-${index}`, kind: 'request', title: `Title ${index}`, status: 'completed' }))
    const store = createActivityStore()
    store.markReady()
    store.setFirstPage('all', { records }, store.getGeneration())
    store.refreshPanel()
    const requested: number[] = []
    await refreshActivitySummary(store, {
      summary: async ({ conversationIds }) => {
        requested.push(conversationIds.length)
        return {
          counts: { all: records.length, active: 0, failed: 0 },
          conversations: Object.fromEntries(conversationIds.map((id) => [id, { title: id, status: 'completed' as const }])),
          legacyHistoryMayBeIncomplete: false
        }
      }
    })
    expect(requested).toEqual([5_000, 3])
    const conversations = store.getSummary()!.conversations
    expect(Object.keys(conversations)).toHaveLength(5_003)
    expect(conversations['many-5002']?.title).toBe('many-5002')
  })

  it('clear empties the database, the loaded pages and the summary', async () => {
    const database = openDatabase()
    database.replaceActivityHistory({ records: [record(), record()], legacyHistoryMayBeIncomplete: true })
    const api = databaseApi(database)
    const store = createActivityStore()
    const sync = startActivitySync(store, api, { onSaveFailed: () => undefined, timers: manualTimers })
    await startup(store, api, sync)
    store.refreshPanel()
    await refreshActivitySummary(store, api)
    expect(store.getSummary()?.counts.all).toBe(2)
    store.record(record())
    store.clear()
    await sync.flush()
    expect(api.updates).toEqual([])
    expect(database.getActivityHistory()).toEqual({ records: [], legacyHistoryMayBeIncomplete: false })
    expect(store.getRecords()).toEqual([])
    expect(store.getPanel().records).toEqual([])
    expect(store.getSummary()?.counts).toEqual({ all: 0, active: 0, failed: 0 })
    sync.stop()
  })

  it('migrates legacy localStorage records in front of the stored ones, retrying after a failure', async () => {
    const database = openDatabase()
    const stored = record({ status: 'completed' })
    const both = record({ status: 'completed' })
    database.replaceActivityHistory({ records: [stored, both], legacyHistoryMayBeIncomplete: false })
    let fail = true
    const api = databaseApi(database, () => fail)
    const legacyRecord = record({ status: 'completed' })
    const store = createActivityStore([legacyRecord, both])
    const sync = startActivitySync(store, api, { onSaveFailed: () => undefined, timers: manualTimers })
    await startup(store, api, sync, new Set(), [legacyRecord, both], true)
    fail = false
    await sync.flush()
    await loadFirstActivityPage(store, api)
    const expected = mergeActivityRecords([legacyRecord, both], [stored, both])
    expect(database.getActivityHistory()).toEqual({ records: expected, legacyHistoryMayBeIncomplete: true })
    expect(store.getRecords()).toEqual(expected)
    sync.stop()
  })
})

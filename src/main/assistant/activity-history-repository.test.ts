// @vitest-environment node
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { build } from 'esbuild'
import { afterEach, describe, expect, it } from 'vitest'
import type { ActivityHistoryChange, ActivityRecord, AssistantTask } from '../../shared/assistant-contracts'
import {
  applyActivityChanges,
  firstOccurrences,
  referenceActivityPage,
  referenceActivityReconcile,
  referenceActivitySummary
} from '../../shared/activity-history-reference'
import { AssistantDatabase } from './assistant-database'

const directories: string[] = []
const opened: AssistantDatabase[] = []
afterEach(() => {
  for (const database of opened.splice(0)) database.close()
  // A readonly worker ends asynchronously after close and may still hold the file briefly.
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})

function open(): { database: AssistantDatabase; raw: DatabaseSync; path: string; directory: string } {
  const directory = mkdtempSync(join(tmpdir(), 'goodbuddy-activity-repository-'))
  directories.push(directory)
  const path = join(directory, 'assistant.sqlite')
  const database = new AssistantDatabase(path)
  database.initialize(directory)
  opened.push(database)
  return { database, raw: (database as unknown as { database: DatabaseSync }).database, path, directory }
}

function makeRandom(seed: number): () => number {
  let state = seed
  return () => (state = (state * 1664525 + 1013904223) >>> 0) / 4294967296
}

const statuses = ['pending', 'running', 'completed', 'failed', 'denied', 'cancelled', 'interrupted'] as const
const kinds = ['request', 'tool', 'approval', 'subagent', 'result'] as const

/** A random newest-first list with duplicate IDs and createdAt ties. */
function randomList(random: () => number, length: number): ActivityRecord[] {
  const pick = <T,>(items: readonly T[]): T => items[Math.floor(random() * items.length)]!
  const list: ActivityRecord[] = []
  for (let index = 0; index < length; index++) {
    const duplicate = list.length > 0 && random() < 0.08
    const id = duplicate ? pick(list).id : `record-${index}`
    const project = random() < 0.5
    list.push({
      id,
      conversationId: `conversation-${Math.floor(random() * 6)}`,
      requestId: `request-${Math.floor(random() * 10)}`,
      scope: project ? { kind: 'project', projectId: `project-${Math.floor(random() * 2)}`, projectName: 'P' } : { kind: 'global' },
      kind: pick(kinds),
      title: `Title ${index}`,
      detail: `detail ${index}`,
      status: pick(statuses),
      createdAt: Math.floor(random() * 40)
    })
  }
  return list
}

describe('ActivityHistoryRepository', () => {
  it('pages, counts and summarizes exactly like the full-list computation', () => {
    for (const seed of [1, 7, 99]) {
      const random = makeRandom(seed)
      const { database } = open()
      const list = randomList(random, 300)
      database.replaceActivityHistory({ records: list, legacyHistoryMayBeIncomplete: seed === 7 })
      const conversationIds = Array.from({ length: 7 }, (_, index) => `conversation-${index}`)
      expect(database.getActivityHistorySummary({ conversationIds }))
        .toEqual(referenceActivitySummary(list, conversationIds, seed === 7))
      for (const filter of ['all', 'active', 'failed'] as const) {
        for (const scope of [{}, { projectId: 'project-1' }, { conversationId: 'conversation-2' }]) {
          const pages: ActivityRecord[] = []
          let before: number | undefined
          do {
            const page = database.getActivityHistoryPage({ limit: 37, filter, ...scope, ...(before === undefined ? {} : { before }) })
            pages.push(...page.records)
            before = page.nextBefore
          } while (before !== undefined)
          const expected = referenceActivityPage(list, { limit: 500, filter, ...scope })
          expect(pages).toEqual(expected.records)
        }
      }
      expect(database.getActivityHistoryPage({ limit: 500 }).records).toEqual(firstOccurrences(list))
    }
  })

  it('applies content-matched changes in SQL exactly like the reference, including legacy duplicates', () => {
    for (const seed of [4, 8, 15]) {
      const random = makeRandom(seed)
      const pick = <T,>(items: readonly T[]): T => items[Math.floor(random() * items.length)]!
      const { database } = open()
      let list = randomList(random, 150).map((item, index) =>
        item.kind === 'tool' || item.kind === 'subagent' ? { ...item, callId: `call-${index % 4}` } : item)
      database.replaceActivityHistory({ records: list, legacyHistoryMayBeIncomplete: false })
      list = firstOccurrences(list)
      for (let round = 0; round < 80; round++) {
        const requestId = `request-${Math.floor(random() * 10)}`
        const status = pick(statuses)
        const changes: ActivityHistoryChange[] = [pick([
          (): ActivityHistoryChange => ({ type: 'upsert-call', record: { ...randomList(random, 1)[0]!, id: `new-${round}`,
            kind: pick(['tool', 'subagent'] as const), requestId, callId: `call-${Math.floor(random() * 4)}` } }),
          (): ActivityHistoryChange => ({ type: 'update-request', requestId, status, ...(random() < 0.5 ? { detail: 'd' } : {}) }),
          (): ActivityHistoryChange => ({ type: 'resolve-approval', conversationId: `conversation-${Math.floor(random() * 6)}`, status, detailLine: 'x' }),
          (): ActivityHistoryChange => ({ type: 'settle-request', requestId, status, detailLine: 'y' }),
          (): ActivityHistoryChange => ({ type: 'remove-request', requestId }),
          (): ActivityHistoryChange => ({ type: 'remove-call', requestId, callId: `call-${Math.floor(random() * 4)}` })
        ])()]
        database.updateActivityHistory({ changes })
        list = applyActivityChanges(list, changes)
        expect(firstOccurrences(database.getActivityHistory().records)).toEqual(list)
      }
    }
  })

  it('reconciles with the stored tasks like the former renderer code', () => {
    const { database } = open()
    const random = makeRandom(5)
    const list = randomList(random, 200)
    database.replaceActivityHistory({ records: list, legacyHistoryMayBeIncomplete: false })
    const statusesByRequest: Array<AssistantTask['status'] | undefined> =
      ['completed', 'failed', 'cancelled', 'interrupted', 'running', 'waiting_approval', 'queued', undefined, 'completed', undefined]
    const tasks: Array<Pick<AssistantTask, 'id' | 'status'>> = []
    statusesByRequest.forEach((status, index) => {
      if (!status) return
      const task = database.createTask({ id: `request-${index}`, title: 't', instructions: 'i', workMode: 'ask' })
      database.updateTaskStatus(task.id, status)
      tasks.push({ id: task.id, status })
    })
    const active = new Set(['request-8', 'request-9'])
    const changed = database.reconcileActivityHistory({ activeRequestIds: [...active], interruptedDetail: '已在重启时中断' })
    const expected = referenceActivityReconcile(list, tasks, active, '已在重启时中断')
    expect(database.getActivityHistory().records).toEqual(expected)
    expect(changed).toBe(expected.filter((record, index) => record !== list[index]).length)
    expect(database.reconcileActivityHistory({ activeRequestIds: [...active], interruptedDetail: 'x' })).toBe(0)
  })

  it('moves a record to the front without rewriting other rows', () => {
    const { database, raw } = open()
    const list = randomList(makeRandom(3), 1_000)
    database.replaceActivityHistory({ records: list, legacyHistoryMayBeIncomplete: false })
    const total = (): number => (raw.prepare('SELECT total_changes() AS n').get() as { n: number }).n
    const start = total()
    const target = firstOccurrences(list)[600]!
    database.updateActivityHistory({ changes: [{ type: 'upsert', position: 'front', record: { ...target, status: 'completed' } }] })
    expect(total() - start).toBe(1)
    expect(database.getActivityHistoryPage({ limit: 1 }).records[0]).toEqual({ ...target, status: 'completed' })
    // A replace that prepends one record writes one row.
    const current = database.getActivityHistory().records
    const before = total()
    database.replaceActivityHistory({ records: [{ ...list[0]!, id: 'fresh' }, ...current], legacyHistoryMayBeIncomplete: false })
    expect(total() - before).toBe(1)
  })

  it('reads pages by index, without scanning arrays', () => {
    const { raw } = open()
    for (const sql of [
      'SELECT record_json FROM activity_history_records WHERE occurrence = 0 AND order_seq < 5 ORDER BY order_seq DESC LIMIT 10',
      "SELECT record_json FROM activity_history_records WHERE occurrence = 0 AND status_group = 'failed' ORDER BY order_seq DESC LIMIT 10",
      "SELECT record_json FROM activity_history_records WHERE occurrence = 0 AND conversation_id = 'c' ORDER BY order_seq DESC LIMIT 10"
    ]) {
      const plan = (raw.prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as Array<{ detail: string }>).map((row) => row.detail).join('; ')
      expect(plan).toMatch(/USING INDEX/)
      expect(plan).not.toMatch(/TEMP B-TREE|json_each/)
    }
  })

  it('migrates the stored order exactly, keeping the first occurrence of duplicates shown', () => {
    const { database, raw, path, directory } = open()
    const list = randomList(makeRandom(11), 120)
    database.replaceActivityHistory({ records: list, legacyHistoryMayBeIncomplete: true })
    database.close()
    // Rebuild the schema-56 layout: order list in record_order_json, no order columns.
    const legacy = new DatabaseSync(path)
    const rows = legacy.prepare(
      'SELECT record_key, record_json FROM activity_history_records ORDER BY order_seq DESC, record_key'
    ).all() as Array<{ record_key: string; record_json: string }>
    legacy.exec(`
      DROP TABLE activity_history_records;
      CREATE TABLE activity_history_records (record_key TEXT PRIMARY KEY NOT NULL, record_json TEXT NOT NULL);
    `)
    const insert = legacy.prepare('INSERT INTO activity_history_records VALUES (?, ?)')
    for (const row of rows) insert.run(row.record_key, row.record_json)
    insert.run(JSON.stringify(['orphan', 0]), JSON.stringify({ ...list[0], id: 'orphan' }))
    legacy.prepare("UPDATE activity_history SET record_order_json = ? WHERE singleton = 1")
      .run(JSON.stringify(rows.map((row) => row.record_key)))
    legacy.exec('PRAGMA user_version = 56')
    legacy.close()

    const reopened = new AssistantDatabase(path)
    reopened.initialize(directory)
    opened.push(reopened)
    expect(reopened.getActivityHistory()).toEqual({ records: list, legacyHistoryMayBeIncomplete: true })
    expect(reopened.getActivityHistoryPage({ limit: 500 }).records).toEqual(firstOccurrences(list))
    const check = (reopened as unknown as { database: DatabaseSync }).database
    expect(check.prepare("SELECT record_order_json FROM activity_history").get()).toEqual({ record_order_json: '[]' })
    void raw
  })

  it('serves pages and the summary from the readonly worker with the same results', async () => {
    const { database, directory } = open()
    const workerPath = join(directory, 'readonly-query-worker.cjs')
    await build({ entryPoints: [resolve('src/main/readonly-query-worker.ts')], outfile: workerPath,
      bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent' })
    const list = randomList(makeRandom(21), 150)
    database.replaceActivityHistory({ records: list, legacyHistoryMayBeIncomplete: false })
    const pageRequest = { limit: 40, filter: 'failed' as const }
    const summaryRequest = { conversationIds: ['conversation-1', 'conversation-4'] }
    const expectedPage = database.getActivityHistoryPage(pageRequest)
    const expectedSummary = database.getActivityHistorySummary(summaryRequest)
    database.enableReadonlyWorker(workerPath)
    expect(await database.getActivityHistoryPageAsync(pageRequest)).toEqual(expectedPage)
    expect(await database.getActivityHistorySummaryAsync(summaryRequest)).toEqual(expectedSummary)
    // A committed write is visible to the next worker read.
    database.updateActivityHistory({ changes: [{ type: 'upsert', position: 'front', record: { ...list[0]!, id: 'fresh', status: 'failed' } }] })
    expect((await database.getActivityHistoryPageAsync(pageRequest)).records[0]!.id).toBe('fresh')
    await expect(database.getActivityHistoryPageAsync({ limit: 501 })).rejects.toThrow()
  }, 60_000)

  it('clears everything in one call', () => {
    const { database } = open()
    database.replaceActivityHistory({ records: randomList(makeRandom(2), 50), legacyHistoryMayBeIncomplete: true })
    database.clearActivityHistory()
    expect(database.getActivityHistory()).toEqual({ records: [], legacyHistoryMayBeIncomplete: false })
    expect(database.getActivityHistorySummary({ conversationIds: [] }).counts).toEqual({ all: 0, active: 0, failed: 0 })
  })
})

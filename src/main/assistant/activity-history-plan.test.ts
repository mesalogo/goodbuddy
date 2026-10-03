// @vitest-environment node
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { activityHistorySnapshotSchema, type ActivityHistoryChange, type ActivityRecord } from '../../shared/assistant-contracts'
import { applyActivityChanges } from '../../shared/activity-history-reference'
import { AssistantDatabase } from './assistant-database'
import { parseActivityHistorySnapshot, planActivityHistoryReplace, planActivityHistoryUpdate } from './activity-history-plan'

const directories: string[] = []
const opened: AssistantDatabase[] = []
afterEach(() => {
  for (const database of opened.splice(0)) database.close()
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function open(): { database: AssistantDatabase; raw: DatabaseSync; directory: string } {
  const directory = mkdtempSync(join(tmpdir(), 'goodbuddy-activity-plan-'))
  directories.push(directory)
  const database = new AssistantDatabase(join(directory, 'assistant.sqlite'))
  database.initialize(directory)
  opened.push(database)
  return { database, raw: (database as unknown as { database: DatabaseSync }).database, directory }
}

/** The complete persisted state, independent of the read API. */
function storedState(raw: DatabaseSync): unknown {
  return {
    header: raw.prepare('SELECT record_order_json, legacy_history_may_be_incomplete FROM activity_history').all(),
    rows: raw.prepare('SELECT record_key, record_json FROM activity_history_records ORDER BY record_key').all()
  }
}

let counter = 0
function record(id: string, overrides: Partial<ActivityRecord> = {}): ActivityRecord {
  counter += 1
  return {
    id, conversationId: 'conversation', requestId: `request-${id}`,
    ...(counter % 2 === 0 ? { callId: `call-${id}` } : {}),
    scope: counter % 3 === 0 ? { kind: 'project', projectId: 'p', projectName: 'Project' } : { kind: 'global' },
    kind: 'tool', title: `Tool ${id}`, detail: `detail ${counter}`, status: 'running', createdAt: counter,
    ...overrides
  }
}

/** Reference semantics of a change, applied to a plain newest-first list. */
const applyReference = (list: ActivityRecord[], change: ActivityHistoryChange): ActivityRecord[] =>
  applyActivityChanges(list, [change])

describe('activity history incremental updates', () => {
  it('stores exactly the state a full replace stores, for random change sequences', () => {
    let seed = 11
    const random = (): number => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296)
    const incremental = open()
    const replaced = open()
    // Legacy history may contain duplicate IDs.
    let list = [record('a'), record('b'), record('a'), record('c'), record('d')]
    let flag = true
    incremental.database.replaceActivityHistory({ records: list, legacyHistoryMayBeIncomplete: true })
    for (let round = 0; round < 60; round++) {
      const changes: ActivityHistoryChange[] = Array.from({ length: 1 + Math.floor(random() * 4) }, () => {
        const id = 'abcdefgh'[Math.floor(random() * 8)]!
        const roll = random()
        if (roll < 0.15) return { type: 'remove', id }
        return { type: 'upsert', position: roll < 0.6 ? 'front' : 'in-place',
          record: record(id, { status: random() < 0.5 ? 'completed' : 'running' }) }
      })
      const legacyHistoryMayBeIncomplete = round % 7 === 0 ? round % 2 === 0 : undefined
      for (const change of changes) list = applyReference(list, change)
      flag = legacyHistoryMayBeIncomplete ?? flag
      incremental.database.updateActivityHistory({ changes, ...(legacyHistoryMayBeIncomplete === undefined ? {} : { legacyHistoryMayBeIncomplete }) })
      const expected = { records: list, legacyHistoryMayBeIncomplete: flag }
      replaced.database.replaceActivityHistory(expected)
      expect(incremental.database.getActivityHistory()).toEqual(expected)
      expect(storedState(incremental.raw)).toEqual(storedState(replaced.raw))
    }
    // A fresh connection (no cache) reads the same state.
    incremental.database.close()
    incremental.database.initialize(incremental.directory)
    expect(incremental.database.getActivityHistory().records).toEqual(list)
  })

  it('validates incremental changes and rolls back a failed batch', () => {
    const { database, raw } = open()
    database.replaceActivityHistory({ records: [record('a')], legacyHistoryMayBeIncomplete: false })
    const before = storedState(raw)
    expect(() => database.updateActivityHistory({ changes: [{ type: 'upsert', position: 'front', record: { ...record('b'), title: '' } }] }))
      .toThrow(z.ZodError)
    raw.exec(`CREATE TRIGGER reject_activity BEFORE INSERT ON activity_history_records
      WHEN json_extract(NEW.record_json, '$.id') = 'z' BEGIN SELECT RAISE(ABORT, 'test failure'); END`)
    expect(() => database.updateActivityHistory({ changes: [
      { type: 'upsert', position: 'front', record: record('y') },
      { type: 'upsert', position: 'front', record: record('z') }
    ] })).toThrow('test failure')
    expect(storedState(raw)).toEqual(before)
    raw.exec('DROP TRIGGER reject_activity')
    const y = record('y')
    database.updateActivityHistory({ changes: [{ type: 'upsert', position: 'front', record: y }] })
    expect(database.getActivityHistory().records.map(item => item.id)).toEqual(['y', 'a'])
  })

  it('writes only the touched rows', () => {
    const { database, raw } = open()
    const records = Array.from({ length: 2_000 }, (_, index) => record(String(index)))
    database.replaceActivityHistory({ records, legacyHistoryMayBeIncomplete: false })
    const changes = (): number => (raw.prepare('SELECT total_changes() AS n').get() as { n: number }).n
    const start = changes()
    const stringify = vi.spyOn(JSON, 'stringify')
    database.updateActivityHistory({ changes: [{ type: 'upsert', position: 'front', record: { ...records[1_500]!, status: 'completed' } }] })
    const calls = stringify.mock.calls.filter(([value]) => !Array.isArray(value)).length
    stringify.mockRestore()
    // One record row plus the order row.
    expect(changes() - start).toBe(2)
    expect(calls).toBeLessThan(10)
  })
})

describe('activity history replace', () => {
  it('does no writes, transactions or per-record serialization for 5,000 unchanged records', () => {
    const { database, raw } = open()
    const records = Array.from({ length: 5_000 }, (_, index) => record(String(index % 4_000)))
    database.replaceActivityHistory({ records, legacyHistoryMayBeIncomplete: true })
    // The renderer sends a fresh structured clone every time.
    const clone = (): unknown => structuredClone({ records, legacyHistoryMayBeIncomplete: true })
    const total = (): number => (raw.prepare('SELECT total_changes() AS n').get() as { n: number }).n
    const start = total()
    const exec = vi.spyOn(raw, 'exec')
    const stringify = vi.spyOn(JSON, 'stringify')
    const parse = vi.spyOn(activityHistorySnapshotSchema, 'parse')
    database.replaceActivityHistory(clone())
    // Record serialization only; [id, occurrence] keys are tiny.
    const stringifyCalls = stringify.mock.calls.filter(([value]) => !Array.isArray(value)).length
    stringify.mockRestore()
    expect(exec).not.toHaveBeenCalled()
    expect(parse).not.toHaveBeenCalled()
    expect(stringifyCalls).toBeLessThan(10)
    exec.mockRestore()
    parse.mockRestore()
    expect(total()).toBe(start)

    // One changed record: one row write plus nothing else.
    const changed = structuredClone(records)
    changed[42]!.detail += ' changed'
    database.replaceActivityHistory({ records: changed, legacyHistoryMayBeIncomplete: true })
    expect(total() - start).toBe(1)
    expect(database.getActivityHistory().records).toEqual(changed)
  })

  it('keeps the schema behavior: same errors, strictness and normalized output', () => {
    const { database } = open()
    const valid = [record('a'), record('b')]
    database.replaceActivityHistory({ records: valid, legacyHistoryMayBeIncomplete: false })
    const cases: unknown[] = [
      { records: [valid[0], { ...valid[1], extra: 1 }], legacyHistoryMayBeIncomplete: false },
      { records: [valid[0], { ...valid[1], createdAt: -1 }], legacyHistoryMayBeIncomplete: false },
      { records: [valid[0], { ...valid[1], scope: { kind: 'global', extra: true } }], legacyHistoryMayBeIncomplete: false },
      { records: valid, legacyHistoryMayBeIncomplete: false, extra: 1 },
      { records: valid },
      { records: 'x', legacyHistoryMayBeIncomplete: false },
      [valid],
      null
    ]
    for (const input of cases) {
      const expected = activityHistorySnapshotSchema.safeParse(input)
      expect(expected.success).toBe(false)
      let actual: unknown
      try { database.replaceActivityHistory(input) } catch (error) { actual = error }
      expect(actual).toBeInstanceOf(z.ZodError)
      expect((actual as z.ZodError).issues).toEqual(expected.error!.issues)
    }
    expect(database.getActivityHistory().records).toEqual(valid)
    // Key order and an explicit undefined optional key follow the schema.
    const reordered = Object.fromEntries(Object.entries(valid[0]!).reverse())
    database.replaceActivityHistory({ records: [reordered, { ...valid[1], callId: undefined }], legacyHistoryMayBeIncomplete: false })
    expect(database.getActivityHistory()).toEqual(activityHistorySnapshotSchema.parse({ records: [reordered, { ...valid[1], callId: undefined }], legacyHistoryMayBeIncomplete: false }))
  })

  it('plans identical results with and without cached records', () => {
    const records = [record('a'), record('b'), record('a')]
    const empty = { entries: new Map() }
    const first = planActivityHistoryReplace(parseActivityHistorySnapshot({ records, legacyHistoryMayBeIncomplete: false }).items, false, empty)
    const reparsed = parseActivityHistorySnapshot(structuredClone({ records, legacyHistoryMayBeIncomplete: false }), first.next)
    expect(reparsed.items.every((item, index) => item.record === first.next.entries.get([...first.next.order][index]!)!.record)).toBe(true)
    const second = planActivityHistoryReplace(reparsed.items, false, first.next)
    expect(second.upserts).toEqual([])
    expect(second.removes).toEqual([])
    expect(second.headerChanged).toBe(false)
    expect(() => planActivityHistoryUpdate({ changes: [] }, { entries: new Map() })).toThrow('unreadable')
  })
})

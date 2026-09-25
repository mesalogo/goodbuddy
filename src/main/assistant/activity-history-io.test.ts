// @vitest-environment node
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { expect, it, vi } from 'vitest'
import { AssistantDatabase } from './assistant-database'
import { upgradeAssistantStorage } from './assistant-storage-upgrade'

it('migrates activity history and writes only changed records during streaming', () => {
  const directory = mkdtempSync(join(tmpdir(), 'goodbuddy-save-io-'))
  const path = join(directory, 'assistant.sqlite')
  const database = new AssistantDatabase(path)
  try {
    database.initialize(directory)
    const raw = (database as unknown as { database: DatabaseSync }).database
    const records = Array.from({ length: 10_000 }, (_, index) => ({
      id: String(index), conversationId: randomUUID(), requestId: randomUUID(),
      scope: { kind: 'global' as const }, kind: 'tool' as const,
      title: 'Tool', detail: 'h'.repeat(280),
      status: 'running' as const, createdAt: Date.now()
    }))
    // Build a released schema-43 snapshot, including an allowed duplicate ID.
    records[1]!.id = records[0]!.id
    raw.exec(`DROP TABLE activity_history_records;
      ALTER TABLE activity_history RENAME COLUMN record_order_json TO records_json;
      DROP TRIGGER messages_review_insert; DROP TRIGGER messages_review_update;
      DROP TRIGGER messages_review_delete; DROP TRIGGER tasks_review_delete;
      DROP VIEW IF EXISTS supervision_review_current;
      DROP TABLE IF EXISTS supervision_review_navigation; DROP TABLE IF EXISTS supervision_review_batches;
      DROP TABLE IF EXISTS supervision_review_sources; DROP TABLE IF EXISTS supervision_review_runs;
      DROP TABLE review_checkpoints; ALTER TABLE messages DROP COLUMN review_revision;
      PRAGMA user_version=43`)
    const legacySave = raw.prepare('UPDATE activity_history SET records_json = ?, legacy_history_may_be_incomplete = 1')
    legacySave.run(JSON.stringify(records))
    raw.exec('PRAGMA wal_checkpoint(TRUNCATE); PRAGMA wal_autocheckpoint=0')
    for (let index = 0; index < 10; index++) {
      records[0]!.detail += 'x'
      legacySave.run(JSON.stringify(records))
    }
    const beforeBytes = statSync(`${path}-wal`).size
    database.close()
    upgradeAssistantStorage(path, () => undefined)
    database.initialize(directory)
    expect(database.getActivityHistory()).toEqual({ records, legacyHistoryMayBeIncomplete: true })
    const migrated = (database as unknown as { database: DatabaseSync }).database
    migrated.exec('PRAGMA wal_checkpoint(TRUNCATE); PRAGMA wal_autocheckpoint=0')
    const prepare = vi.spyOn(migrated, 'prepare')
    for (let index = 0; index < 10; index++) {
      records[0]!.detail += 'x'
      database.replaceActivityHistory({ records, legacyHistoryMayBeIncomplete: true })
    }
    const afterBytes = statSync(`${path}-wal`).size
    const historyScans = prepare.mock.calls.filter(([sql]) =>
      /SELECT record_key, record_json FROM activity_history_records/.test(sql)
    ).length
    prepare.mockRestore()
    console.log({ beforeBytes, afterBytes, historyScans })
    expect(historyScans).toBeLessThanOrEqual(1)
    expect(afterBytes).toBeLessThan(beforeBytes / 100)
    database.replaceActivityHistory({ records, legacyHistoryMayBeIncomplete: true })
    expect(statSync(`${path}-wal`).size).toBe(afterBytes)
    records.unshift(records.pop()!)
    records.splice(2, 1)
    database.replaceActivityHistory({ records, legacyHistoryMayBeIncomplete: false })
    database.close()
    database.initialize(directory)
    expect(database.getActivityHistory()).toEqual({ records, legacyHistoryMayBeIncomplete: false })
  } finally {
    database.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

it('keeps activity comparisons correct after rollback, external writes and clearing', () => {
  const directory = mkdtempSync(join(tmpdir(), 'goodbuddy-save-io-'))
  const path = join(directory, 'assistant.sqlite')
  const database = new AssistantDatabase(path)
  try {
    database.initialize(directory)
    const raw = (database as unknown as { database: DatabaseSync }).database
    const snapshot = {
      records: ['first', 'second'].map((id) => ({
        id, conversationId: randomUUID(), requestId: randomUUID(),
        scope: { kind: 'global' as const }, kind: 'tool' as const,
        title: 'Tool', detail: 'initial', status: 'running' as const, createdAt: Date.now()
      })),
      legacyHistoryMayBeIncomplete: false
    }
    database.replaceActivityHistory(snapshot)
    raw.exec(`CREATE TRIGGER reject_activity BEFORE UPDATE ON activity_history_records
      WHEN json_extract(NEW.record_json, '$.id') = 'second'
      BEGIN SELECT RAISE(ABORT, 'test failure'); END`)
    for (const record of snapshot.records) record.detail = 'changed'
    expect(() => database.replaceActivityHistory(snapshot)).toThrow('test failure')
    expect(database.getActivityHistory().records.map((record) => record.detail)).toEqual(['initial', 'initial'])
    raw.exec('DROP TRIGGER reject_activity')
    database.replaceActivityHistory(snapshot)
    expect(database.getActivityHistory()).toEqual(snapshot)

    const external = new DatabaseSync(path)
    try {
      external.exec('DELETE FROM activity_history_records')
    } finally {
      external.close()
    }
    database.replaceActivityHistory(snapshot)
    expect(database.getActivityHistory()).toEqual(snapshot)
    database.clearAssistantData()
    database.replaceActivityHistory(snapshot)
    expect(database.getActivityHistory()).toEqual(snapshot)
  } finally {
    database.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

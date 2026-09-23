// @vitest-environment node
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { expect, it } from 'vitest'
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
    for (let index = 0; index < 10; index++) {
      records[0]!.detail += 'x'
      database.replaceActivityHistory({ records, legacyHistoryMayBeIncomplete: true })
    }
    const afterBytes = statSync(`${path}-wal`).size
    console.log({ beforeBytes, afterBytes })
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

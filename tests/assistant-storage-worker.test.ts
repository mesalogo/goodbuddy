// @vitest-environment node
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { Worker } from 'node:worker_threads'
import { build } from 'esbuild'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { AssistantDatabase, ASSISTANT_DATABASE_SCHEMA_VERSION } from '../src/main/assistant/assistant-database'
import { getPendingAssistantStorageUpgrade } from '../src/main/assistant/assistant-storage-upgrade'
import { assistantStorageProgressSchema } from '../src/shared/assistant-storage-contracts'

let directory: string
let workerPath: string
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'goodbuddy-storage-worker-'))
  workerPath = join(directory, 'worker.cjs')
  await build({
    entryPoints: [resolve('src/main/assistant-storage-worker.ts')],
    outfile: workerPath, bundle: true, platform: 'node', format: 'cjs', target: 'node24'
  })
})
afterAll(async () => {
  if (directory) await rm(directory, { recursive: true, force: true })
})

it.each([false, true])('runs the real startup worker with legacy notes=%s without touching unrelated data', async (legacyNotes) => {
  const root = await mkdtemp(join(directory, 'case-'))
  const databasePath = join(root, 'assistant.sqlite')
  const database = new AssistantDatabase(databasePath)
  database.initialize(root)
  const note = database.createMagicNote({
    title: 'Worker note', content: { version: 1, ops: [{ insert: 'Keep note\n' }] }
  })
  const header = { id: randomUUID(), title: 'Worker chat', updatedAt: 1000 }
  const message = { id: randomUUID(), role: 'assistant' as const, state: 'complete' as const,
    content: 'Normal chat'.repeat(100_000), createdAt: 1000 }
  database.saveLocalConversations([{ header, messages: [message] }])
  database.saveLocalConversations([{ header, messages: [{ ...message, content: 'Keep response' }] }])
  const expected = database.getConversation(header.id)
  database.close()
  const sql = new DatabaseSync(databasePath)
  try {
    sql.exec(`DROP VIEW supervision_review_current;
      DROP TABLE supervision_review_navigation; DROP TABLE supervision_review_batches;
      DROP TABLE supervision_review_sources; DROP TABLE supervision_review_runs;
      PRAGMA user_version = 46;`)
    if (legacyNotes) sql.prepare('UPDATE magic_note_entries SET content_json = ? WHERE id = ?')
      .run(JSON.stringify(note.entries[0]!.content), note.entries[0]!.id)
    sql.exec('PRAGMA wal_checkpoint(TRUNCATE)')
    expect(sql.prepare('PRAGMA freelist_count').get()!.freelist_count).toBeGreaterThan(0)
    const bytesBefore = (await stat(databasePath)).size
    const upgrade = getPendingAssistantStorageUpgrade(databasePath)!
    expect(upgrade).toEqual({ migrateNotes: legacyNotes, reclaimSpace: legacyNotes })
    const run = async (cancelled: boolean) => {
      const cancellation = new SharedArrayBuffer(4)
      if (cancelled) Atomics.store(new Int32Array(cancellation), 0, 1)
      const worker = new Worker(workerPath, { workerData: { databasePath, cancellation, upgrade } })
      const messages: Array<{ progress?: unknown; done?: boolean; cancelled?: boolean; error?: string }> = []
      worker.on('message', message => messages.push(message))
      try {
        const code = await new Promise<number>((resolve, reject) => {
          worker.once('error', reject)
          worker.once('exit', resolve)
        })
        expect(code).toBe(0)
        return messages
      } finally { await worker.terminate() }
    }
    expect((await run(true)).at(-1)).toMatchObject({ cancelled: true })
    expect(sql.prepare('PRAGMA user_version').get()!.user_version).toBe(46)
    const messages = await run(false)
    expect(messages.at(-1)).toEqual({ done: true })
    expect(messages.some(message => message.error)).toBe(false)
    const stages = messages.flatMap(message => message.progress
      ? [assistantStorageProgressSchema.parse(message.progress).stage] : [])
    expect(stages).toContain('upgrading')
    if (legacyNotes) {
      expect(stages).toContain('converting')
      expect(stages).toContain('compacting')
    } else {
      expect(stages).toEqual(['upgrading'])
      expect((await stat(databasePath)).size).toBeGreaterThanOrEqual(bytesBefore)
    }
    expect(sql.prepare('PRAGMA user_version').get()!.user_version).toBe(ASSISTANT_DATABASE_SCHEMA_VERSION)
    expect(getPendingAssistantStorageUpgrade(databasePath)).toBeUndefined()
    database.initialize(root)
    expect(database.getConversation(header.id)).toEqual(expected)
    expect(database.getMagicNote(note.id)).toEqual(note)
    expect(sql.prepare('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' })
  } finally {
    database.close()
    sql.close()
  }
}, 30_000)

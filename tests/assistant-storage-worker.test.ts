// @vitest-environment node
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { Worker } from 'node:worker_threads'
import { build } from 'esbuild'
import { afterAll, beforeAll, expect, it, vi } from 'vitest'
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

async function runWorker(databasePath: string, upgrade: NonNullable<ReturnType<typeof getPendingAssistantStorageUpgrade>>, cancelled = false) {
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

it.each([false, true])('runs the real startup worker with legacy notes=%s without touching unrelated data', async (legacyNotes) => {
  const root = await mkdtemp(join(directory, 'case-'))
  const databasePath = join(root, 'assistant.sqlite')
  const database = new AssistantDatabase(databasePath)
  database.initialize(root)
  const note = database.getMagicNote(database.createMagicNote({
    title: 'Worker note', content: { version: 1, ops: [{ insert: 'Keep note\n' }] }
  }).id)
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
      ALTER TABLE magic_note_entries DROP COLUMN source_json;
      ALTER TABLE projects ADD COLUMN default_work_mode TEXT NOT NULL DEFAULT 'ask';
      ALTER TABLE conversations ADD COLUMN work_mode TEXT NOT NULL DEFAULT 'ask';
      ALTER TABLE tasks ADD COLUMN work_mode TEXT NOT NULL DEFAULT 'execute';
      PRAGMA user_version = 46;`)
    if (legacyNotes) sql.prepare('UPDATE magic_note_entries SET content_json = ? WHERE id = ?')
      .run(JSON.stringify(note.entries[0]!.content), note.entries[0]!.id)
    sql.exec('PRAGMA wal_checkpoint(TRUNCATE)')
    expect(sql.prepare('PRAGMA freelist_count').get()!.freelist_count).toBeGreaterThan(0)
    const bytesBefore = (await stat(databasePath)).size
    const upgrade = getPendingAssistantStorageUpgrade(databasePath)!
    expect(upgrade).toEqual({ migrateNotes: legacyNotes, reclaimSpace: legacyNotes })
    expect((await runWorker(databasePath, upgrade, true)).at(-1)).toMatchObject({ cancelled: true })
    expect(sql.prepare('PRAGMA user_version').get()!.user_version).toBe(46)
    const messages = await runWorker(databasePath, upgrade)
    expect(messages.at(-1)).toEqual({ done: true })
    expect(messages.some(message => message.error)).toBe(false)
    const stages = messages.flatMap(message => message.progress
      ? [assistantStorageProgressSchema.parse(message.progress).stage] : [])
    expect(stages).toContain('upgrading')
    if (legacyNotes) {
      expect(stages).toContain('converting')
      expect(stages).toContain('compacting')
    } else {
      expect(stages).toContain('converting')
      expect(stages).not.toContain('compacting')
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

it('upgrades a fresh historical schema 59 through the real worker without reconstructing dropped columns', async () => {
  const root = await mkdtemp(join(directory, 'schema59-'))
  const databasePath = join(root, 'assistant.sqlite')
  const database = new AssistantDatabase(databasePath)
  const exec = DatabaseSync.prototype.exec
  // Build the actual historical schema from an empty file. Reject only the final
  // schema 60 DDL so its transaction rolls back; never reset user_version.
  const stop = vi.spyOn(DatabaseSync.prototype, 'exec').mockImplementation(function (this: DatabaseSync, sql: string) {
    if (sql.includes('ALTER TABLE projects DROP COLUMN default_work_mode')) throw new Error('Stop at historical schema 59')
    return exec.call(this, sql)
  })
  try {
    expect(() => database.initialize(root)).toThrow('Stop at historical schema 59')
  } finally {
    stop.mockRestore()
    database.close()
  }
  const sql = new DatabaseSync(databasePath)
  const projectId = randomUUID()
  const conversationId = randomUUID()
  const taskId = randomUUID()
  const messageId = randomUUID()
  const createdAt = '2026-01-01T00:00:00.000Z'
  const content = '/ask keep user text and workMode: execute'
  const userInput = { workMode: 'user-owned', toolApproval: 'user-owned' }
  try {
    expect(sql.prepare('PRAGMA user_version').get()!.user_version).toBe(59)
    for (const [table, column] of [['projects', 'default_work_mode'], ['conversations', 'work_mode'], ['tasks', 'work_mode']] as const) {
      const definition = sql.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)!.sql as string
      expect(definition).toContain(`CHECK(${column} IN ('ask', 'execute'))`)
    }
    sql.prepare(`INSERT INTO projects (id, name, description, root_path, default_work_mode, status, created_at, updated_at)
      VALUES (?, 'Historical project', '', ?, 'execute', 'active', ?, ?)`)
      .run(projectId, root, createdAt, createdAt)
    sql.prepare("INSERT INTO project_execution_spaces (project_id, kind, root_path) VALUES (?, 'local', ?)")
      .run(projectId, root)
    sql.prepare(`INSERT INTO conversations (id, project_id, work_mode, context_state_json, title, created_at, updated_at)
      VALUES (?, ?, 'ask', ?, 'Historical chat', ?, ?)`)
      .run(conversationId, projectId, JSON.stringify({ workMode: 'ask', knowledgeLibraryIds: [], storyGraphEnabled: true }), createdAt, createdAt)
    sql.prepare(`INSERT INTO tasks (id, project_id, conversation_id, title, instructions, origin, status, work_mode, created_at)
      VALUES (?, ?, ?, 'Historical task', ?, 'user', 'completed', 'execute', ?)`)
      .run(taskId, projectId, conversationId, content, createdAt)
    const activity = { childTaskId: randomUUID(), actor: { kind: 'direct-model', label: 'Child' }, routingMode: 'native', state: 'completed' }
    sql.prepare(`INSERT INTO messages (id, conversation_id, role, content, state, sequence, metadata_json, created_at)
      VALUES (?, ?, 'assistant', ?, 'complete', 0, ?, ?)`)
      .run(messageId, conversationId, content, JSON.stringify({ subagents: [{ ...activity, workMode: 'execute' }] }), createdAt)
    sql.prepare(`INSERT INTO task_events (task_id, kind, payload_json, created_at,
      remote_binding_id, remote_operation_id, remote_semantic_sequence, remote_event_index)
      VALUES (?, 'status', ?, ?, 'binding', 'operation', '7', 0)`)
      .run(taskId, JSON.stringify({ workMode: 'ask', status: 'completed', input: userInput }), createdAt)
    const eventBefore = sql.prepare('SELECT * FROM task_events WHERE task_id = ?').get(taskId)!
    sql.exec('PRAGMA wal_checkpoint(TRUNCATE)')
    const upgrade = getPendingAssistantStorageUpgrade(databasePath)!
    expect(upgrade).toEqual({ migrateNotes: false, reclaimSpace: false })
    expect((await runWorker(databasePath, upgrade)).at(-1)).toEqual({ done: true })
    expect(sql.prepare('PRAGMA user_version').get()!.user_version).toBe(60)
    for (const [table, column] of [['projects', 'default_work_mode'], ['conversations', 'work_mode'], ['tasks', 'work_mode']] as const) {
      expect(sql.prepare(`PRAGMA table_info(${table})`).all().map(row => row.name)).not.toContain(column)
    }
    expect(JSON.parse(sql.prepare('SELECT context_state_json FROM conversations WHERE id = ?').get(conversationId)!.context_state_json as string))
      .toEqual({ knowledgeLibraryIds: [], storyGraphEnabled: true })
    expect(JSON.parse(sql.prepare('SELECT metadata_json FROM messages WHERE id = ?').get(messageId)!.metadata_json as string))
      .toEqual({ subagents: [activity] })
    expect(sql.prepare('SELECT * FROM task_events WHERE task_id = ?').get(taskId)).toEqual({
      ...eventBefore, payload_json: JSON.stringify({ status: 'completed', input: userInput })
    })
    expect(sql.prepare('PRAGMA integrity_check').get()!.integrity_check).toBe('ok')
    expect(sql.prepare('PRAGMA foreign_key_check').all()).toEqual([])
    expect(getPendingAssistantStorageUpgrade(databasePath)).toBeUndefined()
    database.initialize(root)
    expect(database.getConversation(conversationId).messages[0]).toMatchObject({ id: messageId, content, subagents: [activity] })
    expect(database.getTask(taskId).instructions).toBe(content)
  } finally {
    database.close()
    sql.close()
  }
}, 30_000)

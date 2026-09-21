// @vitest-environment node
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { build } from 'esbuild'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { AssistantDatabase } from './assistant-database'
import { ExecutionStatsReader } from './execution-stats-reader'

let directory: string
let workerPath: string
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'goodbuddy-statistics-reader-'))
  workerPath = process.env.GOODBUDDY_STATS_WORKER_PATH ?? join(directory, 'worker.cjs')
  if (!process.env.GOODBUDDY_STATS_WORKER_PATH) {
    await build({ entryPoints: [resolve('src/main/execution-stats-worker.ts')], outfile: workerPath,
      bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent' })
  }
})
afterAll(async () => { await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) })

it('reads committed WAL evidence off-thread without recovering live tasks and refreshes external writes', async () => {
  const path = join(directory, 'assistant.sqlite')
  const database = new AssistantDatabase(path)
  database.initialize(directory)
  const projectId = database.listProjects()[0]!.id
  const conversationId = randomUUID()
  const id = randomUUID()
  database.createTask({ id, projectId, conversationId, title: 'Live', instructions: 'Reply', workMode: 'ask', visible: false })
  database.appendTaskEvent(id, 'text', { requestId: id, type: 'text', delta: 'Reply' })
  const sql = new DatabaseSync(path)
  try {
    const status = database.getTask(id).status
    const [conversation, project] = await Promise.all([
      database.getExecutionStatsAsync({ conversationId }, new Set([id]), workerPath),
      database.getExecutionStatsAsync({ projectId }, new Set([id]), workerPath)
    ])
    expect(conversation).toMatchObject({ requestCount: 1, activeRequestCount: 1, incompleteRequestCount: 0 })
    expect(project.requestCount).toBe(1)
    expect(database.getTask(id).status).toBe(status)
    database.updateTaskStatus(id, 'completed')
    expect(await database.getExecutionStatsAsync({ conversationId }, new Set(), workerPath)).toMatchObject({ requestCount: 1, activeRequestCount: 0 })
    sql.exec('BEGIN IMMEDIATE')
    sql.prepare('DELETE FROM tasks WHERE id = ?').run(id)
    expect((await database.getExecutionStatsAsync({ conversationId }, new Set(), workerPath)).requestCount).toBe(1)
    sql.exec('ROLLBACK')
    expect((await database.getExecutionStatsAsync({ conversationId }, new Set(), workerPath)).requestCount).toBe(1)
    sql.prepare('DELETE FROM tasks WHERE id = ?').run(id)
    expect((await database.getExecutionStatsAsync({ conversationId }, new Set(), workerPath)).requestCount).toBe(0)
    // A returned result must not leave a read transaction pinning the WAL.
    expect(sql.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get()?.busy).toBe(0)
    const pending = database.getExecutionStatsAsync({ projectId }, new Set(), workerPath)
    const rejection = expect(pending).rejects.toThrow('closed')
    database.close()
    await rejection
  } finally { sql.close(); database.close() }
})

it('rejects worker startup errors and permits the next read to retry', async () => {
  const reader = new ExecutionStatsReader(join(directory, 'missing.sqlite'), workerPath)
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      await expect(reader.read({ projectId: randomUUID() }, new Set())).rejects.toThrow()
    }
  } finally { reader.close() }
})

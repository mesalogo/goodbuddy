// @vitest-environment node
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { build } from 'esbuild'
import { afterAll, afterEach, beforeAll, expect, it } from 'vitest'
import { AssistantDatabase } from './assistant-database'
import { ReadonlyQueryReader } from '../readonly-query-reader'
import { supervisionReviewSettingsSchema } from '../../shared/supervision-review-contracts'
import type { ReviewManifestReader, ReviewManifestRow, ReviewState } from './supervision-review-store'

let directory: string, workerPath: string
const cleanup: Array<() => Promise<void>> = []
beforeAll(async () => {
  const parent = resolve('temp/goodbuddy-storage-foundation')
  await mkdir(parent, { recursive: true })
  directory = await mkdtemp(join(parent, 'review-'))
  workerPath = join(directory, 'reader.cjs')
  await build({ entryPoints: [resolve('src/main/readonly-query-worker.ts')], outfile: workerPath,
    bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent' })
})
afterEach(async () => { for (const close of cleanup.splice(0)) await close() })
afterAll(async () => { await rm(directory, { recursive: true, force: true, maxRetries: 10 }) })

async function fixture() {
  const root = await mkdtemp(join(directory, 'db-'))
  const path = join(root, 'assistant.sqlite')
  const database = new AssistantDatabase(path)
  database.initialize(root)
  const sql = (database as unknown as { database: DatabaseSync }).database
  const project = database.listProjects()[0]!
  const conversationId = randomUUID()
  database.replaceConversations([{ id: conversationId, projectId: project.id, title: 'Sources', updatedAt: Date.now(),
    messages: Array.from({ length: 450 }, (_, i) => ({ id: randomUUID(), role: 'user', state: 'complete',
      content: `Evidence ${i}`, createdAt: Date.parse('2026-10-01T12:00:00Z') })) }])
  const state: ReviewState = {
    request: { trigger: 'manual', scope: { kind: 'global' }, timeRange: { from: '2026-01-01T00:00:00Z', to: '2027-01-01T00:00:00Z' } },
    config: { ...supervisionReviewSettingsSchema.parse({}), version: 1, timeoutSeconds: 30, concurrency: 1 }
  }
  const runId = database.startSupervisionRun(state.request)
  const store = database.supervisionReviewStore()
  const worker = new ReadonlyQueryReader('assistant', path, workerPath)
  const reader: ReviewManifestReader = worker.reviewManifest(runId)
  cleanup.push(async () => { await worker.close(); database.close(); await rm(root, { recursive: true, force: true, maxRetries: 10 }) })
  return { database, sql, store, reader, worker, state, runId, conversationId }
}

it('scans read-only, transfers at most 200 rows, yields without a transaction, and preserves snapshot revisions', async () => {
  const f = await fixture()
  const pageSizes: number[] = []
  let wrote = false
  const page = f.reader.page
  f.reader.page = async (offset, signal) => {
    const rows = await page(offset, signal)
    pageSizes.push(rows.length)
    if (offset === 200) {
      expect(f.sql.isTransaction).toBe(false)
      expect(f.store.progress(f.runId).sources).toBe(200)
      expect(f.store.load(f.runId).initializing).toBe(true)
      // A different producer can commit while initialization is in flight.
      f.database.createProject({ name: 'Peer write', rootPath: directory, description: '' })
      f.sql.prepare('UPDATE messages SET content = ? WHERE id = (SELECT id FROM messages ORDER BY id LIMIT 1)').run('Changed after scan')
      wrote = true
    }
    return rows
  }
  await f.store.initializeWithReader(f.runId, f.state, f.reader)
  expect(pageSizes).toEqual([200, 200, 50, 0])
  expect(wrote).toBe(true)
  expect(f.store.progress(f.runId).sources).toBe(450)
  expect(f.store.load(f.runId).initializing).toBeUndefined()
  // Frozen scan revisions must not silently advance to the concurrent write.
  await expect(f.store.resumeWithReader(f.runId, f.reader)).rejects.toThrow('source changed')
  expect(f.store.load(f.runId).restartRequired).toBe(true)
  await expect(f.worker.call('reviewManifestPage', [f.runId, 0])).rejects.toThrow('lost its snapshot')
})

it('cancels between committed batches, retains the marker, and rebuilds on resume', async () => {
  const f = await fixture()
  const abort = new AbortController()
  const page = f.reader.page
  f.reader.page = async (offset, signal) => {
    if (offset === 200) abort.abort(new Error('stop between commits'))
    return page(offset, signal)
  }
  await expect(f.store.initializeWithReader(f.runId, f.state, f.reader, abort.signal)).rejects.toThrow('stop between commits')
  expect(f.store.progress(f.runId).sources).toBe(200)
  expect(f.store.load(f.runId).initializing).toBe(true)
  expect(() => f.store.assertComplete(f.runId)).toThrow('incomplete source manifest')
  expect(f.sql.isTransaction).toBe(false)
  expect(f.worker.pendingCount).toBe(0)
  f.reader.page = page
  await f.store.resumeWithReader(f.runId, f.reader)
  expect(f.store.progress(f.runId).sources).toBe(450)
  expect(f.store.load(f.runId).initializing).toBeUndefined()
})

it('rolls back a failing batch atomically and preserves earlier committed rows for recovery', async () => {
  const f = await fixture()
  f.sql.exec(`CREATE TRIGGER fail_manifest BEFORE INSERT ON supervision_review_sources
    WHEN (SELECT COUNT(*) FROM supervision_review_sources) >= 250 BEGIN SELECT RAISE(ABORT, 'batch failed'); END`)
  await expect(f.store.initializeWithReader(f.runId, f.state, f.reader)).rejects.toThrow('batch failed')
  expect(f.store.progress(f.runId).sources).toBe(200)
  expect(f.store.load(f.runId).initializing).toBe(true)
  f.sql.exec('DROP TRIGGER fail_manifest')
  await f.store.resumeWithReader(f.runId, f.reader)
  expect(f.store.progress(f.runId).sources).toBe(450)
  expect(f.sql.prepare('PRAGMA foreign_key_check').all()).toEqual([])
})

it('validates resume in bounded reader pages and observes cancellation and deleted conversations', async () => {
  const f = await fixture()
  await f.store.initializeWithReader(f.runId, f.state, f.reader)
  const validate = f.reader.changedSource
  const abort = new AbortController()
  const sizes: number[] = []
  f.reader.changedSource = async (rows, signal) => {
    sizes.push(rows.length)
    expect(f.sql.isTransaction).toBe(false)
    if (sizes.length === 2) abort.abort(new Error('stop validation'))
    return validate(rows, signal)
  }
  await expect(f.store.resumeWithReader(f.runId, f.reader, abort.signal)).rejects.toThrow('stop validation')
  expect(sizes).toEqual([200, 200])
  expect(f.store.progress(f.runId).sources).toBe(450)
  f.reader.changedSource = validate
  f.sql.prepare('DELETE FROM conversations WHERE id = ?').run(f.conversationId)
  await f.store.resumeWithReader(f.runId, f.reader)
  expect(f.store.progress(f.runId)).toMatchObject({ sources: 0, omittedSources: 450 })
})

it('does not clear the marker after a cancel write arrives during initialization', async () => {
  const f = await fixture()
  const page = f.reader.page
  f.reader.page = async (offset, signal): Promise<ReviewManifestRow[]> => {
    const rows = await page(offset, signal)
    if (offset === 200) f.store.cancel(f.runId)
    return rows
  }
  await expect(f.store.initializeWithReader(f.runId, f.state, f.reader)).rejects.toThrow('stopped')
  expect(f.store.load(f.runId).initializing).toBe(true)
  await expect(f.store.resumeWithReader(f.runId, f.reader)).rejects.toThrow('SUPERVISION_REVIEW_CANCELLED')
})

it('keeps partial initialization recoverable when the read worker exits and never scans on the owner as fallback', async () => {
  const f = await fixture()
  const page = f.reader.page
  f.reader.page = async (offset, signal) => {
    if (offset === 200) await f.worker.terminateWorkerForTest()
    return page(offset, signal)
  }
  await expect(f.store.initializeWithReader(f.runId, f.state, f.reader)).rejects.toThrow('backing off')
  expect(f.store.progress(f.runId).sources).toBe(200)
  expect(f.store.load(f.runId).initializing).toBe(true)
  expect(f.sql.prepare("SELECT name FROM sqlite_temp_master WHERE name = 'review_manifest'").all()).toEqual([])
  f.worker.resetBackoffForTest()
  f.reader.page = page
  await f.store.resumeWithReader(f.runId, f.reader)
  expect(f.store.progress(f.runId).sources).toBe(450)
})

it('clears the initial marker and applies deleted-source cleanup in one final transaction', async () => {
  const f = await fixture()
  const page = f.reader.page
  f.reader.page = async (offset, signal) => {
    const rows = await page(offset, signal)
    if (offset === 400) {
      f.sql.prepare('DELETE FROM conversations WHERE id = ?').run(f.conversationId)
      f.sql.exec(`CREATE TRIGGER fail_omission BEFORE DELETE ON supervision_review_sources
        BEGIN SELECT RAISE(ABORT, 'omission failed'); END`)
    }
    return rows
  }
  await expect(f.store.initializeWithReader(f.runId, f.state, f.reader)).rejects.toThrow('omission failed')
  expect(f.store.load(f.runId).initializing).toBe(true)
  expect(f.store.progress(f.runId).sources).toBe(450)
  expect(f.sql.isTransaction).toBe(false)
  f.sql.exec('DROP TRIGGER fail_omission')
  f.reader.page = page
  await f.store.resumeWithReader(f.runId, f.reader)
  expect(f.store.progress(f.runId).sources).toBe(0)
  expect(f.store.load(f.runId).initializing).toBeUndefined()
})

import assert from 'node:assert/strict'
import { join } from 'node:path'
import { writeFile } from 'node:fs/promises'
import { randomUUID, createHash } from 'node:crypto'
import { monitorEventLoopDelay, performance } from 'node:perf_hooks'
import { app } from 'electron'
import { DesktopStorageClient } from '../../src/main/desktop-storage-client'
import { supervisionGraphViewSchema } from '../../src/shared/supervision-contracts'

const root = process.env.GB_PORTABLE_UPGRADE_ROOT!
const work = join(root, 'work')
app.setPath('userData', join(root, 'electron'))
const report: Record<string, unknown> = { stage: 'startup', electron: process.versions.electron }
const options = { assistantPath: join(work, 'assistant.sqlite'), knowledgePath: join(work, 'knowledge.sqlite'),
  defaultRootPath: work, userDataPath: work, entryPath: join(root, 'desktop-storage-entry.mjs'),
  readerWorkerPath: join(root, 'readonly-query-worker.cjs'), upgradeWorkerPath: join(root, 'assistant-storage-worker.cjs') }
let storage: DesktopStorageClient | undefined
const digest = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex')
async function stage(value: string): Promise<void> {
  report.stage = value
  await writeFile(join(root, 'fixture-summary.json'), JSON.stringify(report))
}
async function open(): Promise<DesktopStorageClient> {
  const client = new DesktopStorageClient(options)
  storage = client
  await client.ready
  return client
}
async function run(): Promise<void> {
  await stage('startup')
  await app.whenReady()
  const started = performance.now()
  let client = await open()
  report.initializeMs = performance.now() - started
  const projects = await client.call('assistant', 'listProjects', [])
  assert.ok(projects.length > 0)
  const original = await client.call('assistant', 'listSupervisionResults', [20])
  assert.ok(original.length > 0, 'real supervision data required')
  const graph = await client.call('assistant', 'getSupervisionGraph', [{ resultId: original[0]!.id }])
  report.realRead = { projects: projects.length, results: original.length, graphSha256: digest(graph) }
  await stage('reopen')
  await client.close()
  const reopenedAt = performance.now()
  client = await open()
  report.reopenMs = performance.now() - reopenedAt
  assert.equal(digest(await client.call('assistant', 'getSupervisionGraph', [{ resultId: original[0]!.id }])), digest(graph))
  if (process.env.GB_PORTABLE_UPGRADE_PHASE === 'exercise') {
    await stage('task-event-dedupe')
    const taskId = randomUUID()
    await client.call('assistant', 'createTask', [{ id: taskId, title: 'Storage validation', instructions: 'Local deterministic validation', status: 'completed' }])
    const event = { taskId, bindingId: randomUUID(), operationId: randomUUID(), semanticSequence: '1', eventIndex: 0,
      kind: 'output', payload: { text: 'deterministic validation output' } }
    assert.equal(await client.call('assistant', 'appendRemoteTaskEventOnce', [event]), true)
    assert.equal(await client.call('assistant', 'appendRemoteTaskEventOnce', [event]), false)
    await assert.rejects(client.call('assistant', 'appendRemoteTaskEventOnce', [{ ...event, payload: { text: 'conflict' } }]))
    assert.equal(await client.call('assistant', 'getHighestCommittedRemoteTaskEventSequence', [event.bindingId, event.operationId]), '1')
    await client.close()
    client = await open()
    assert.equal(await client.call('assistant', 'appendRemoteTaskEventOnce', [event]), false)
    assert.equal(await client.call('assistant', 'getHighestCommittedRemoteTaskEventSequence', [event.bindingId, event.operationId]), '1')
    report.dedupe = { insert: true, replay: true, conflict: true, reopenReplay: true }

    await stage('overlapping-review-reads-publication')
    // Fixed, bounded local workload; not the full C03/UI acceptance fixture.
    const delay = monitorEventLoopDelay({ resolution: 1 })
    const publicationMs: number[] = [], readMs: number[] = []
    const at = '2026-10-05T00:00:00.000Z'
    let highWater = 0
    delay.enable()
    const began = performance.now()
    await Promise.all([
      (async () => {
        for (let batch = 0; batch < 100; batch++) {
          const time = performance.now()
          await client.call('assistant', 'saveSupervisionResult', [{
            request: { trigger: 'manual', scope: { kind: 'global' }, timeRange: { from: at, to: at } },
            evidence: Array.from({ length: 20 }, (_, index) => ({ id: `source-${index}`, sourceType: 'task' as const,
              sourceId: taskId, title: 'Deterministic source', content: 'x'.repeat(2048), occurredAt: at })),
            output: { summary: 'Deterministic review', changeDigest: '', openItems: [], entities: [], entityChanges: [], relations: [],
              events: Array.from({ length: 20 }, (_, index) => ({ title: 'Deterministic event', description: '', occurredAt: at,
                eventType: 'decision' as const, sourceReferenceIds: [`source-${index}`], entityIds: [] })) }
          }])
          publicationMs.push(performance.now() - time)
          highWater = Math.max(highWater, client.pendingCount)
        }
      })(),
      (async () => {
        for (let index = 0; index < 100; index++) {
          const time = performance.now()
          await client.call('assistant', 'getSupervisionGraph', [{ resultId: original[index % original.length]!.id }])
          await client.call('assistant', 'listSupervisionResults', [20])
          readMs.push(performance.now() - time)
          highWater = Math.max(highWater, client.pendingCount)
        }
      })()
    ])
    const durationMs = performance.now() - began
    delay.disable()
    const stats = (values: number[]) => { const sorted = [...values].sort((a, b) => a - b); return {
      samples: values.length, p50: sorted[Math.ceil(sorted.length * .5) - 1], p95: sorted[Math.ceil(sorted.length * .95) - 1], max: sorted.at(-1) } }
    report.performance = { classification: 'single-run source-harness baseline, not C03 acceptance or before/after improvement',
      durationMs, publications: stats(publicationMs), reviewReadPairs: stats(readMs), mainDelayP99Ms: delay.percentile(99) / 1e6,
      mainDelayMaxMs: delay.max / 1e6, delaySamples: delay.count, pendingHighWaterObserved: highWater, pendingAfter: client.pendingCount,
      batches: 100, sourcesPerBatch: 20, sourceBytes: 2048, mainRssBytes: process.memoryUsage().rss }
    const published = await client.call('assistant', 'listSupervisionResults', [1])
    const publishedGraph = supervisionGraphViewSchema.parse(await client.call('assistant', 'getSupervisionGraph', [{ resultId: published[0]!.id }]))
    assert.equal(publishedGraph.events.length, 20)
    assert.equal(publishedGraph.sources.length, 20)
    const eventIds = new Set(publishedGraph.events.map(event => event.id))
    const sourceIds = new Set(publishedGraph.sources.map(source => source.id))
    assert.equal(publishedGraph.eventSources.length, 20)
    assert.ok(publishedGraph.eventSources.every(link => eventIds.has(link.event_id) && sourceIds.has(link.source_id)))
    await client.close()
    client = await open()
    assert.equal(digest(supervisionGraphViewSchema.parse(await client.call('assistant', 'getSupervisionGraph', [{ resultId: published[0]!.id }]))), digest(publishedGraph))
    report.publicationReopen = true
  }
  await client.close()
  storage = undefined
  report.stage = 'passed'
}
void run().then(async () => {
  await writeFile(join(root, 'fixture-summary.json'), JSON.stringify(report))
  app.exit(0)
}, async () => {
  // Never serialize an exception: SQLite/IPC errors may contain private content.
  try { await storage?.close() } catch { /* Preserve the failing stage. */ }
  await writeFile(join(root, 'fixture-summary.json'), JSON.stringify(report))
  app.exit(1)
})

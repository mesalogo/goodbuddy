// Owner-local database/read-worker microbenchmark (PERF-15). Not a Main IPC latency probe.
// Bundles the production
// AssistantDatabase and readonly worker with esbuild, seeds a temporary
// assistant database (default 1,000 conversations / 20,000 messages and 24,000
// activity records) and measures, for the IPC paths the renderer hits often:
//   - per-call time
//   - harness event-loop delay while the calls run back to back
// for owner-local SQL ("sync") and explicit read-worker dispatch ("after").
//   conversations:list-summaries  sync listConversationSummaries vs worker
//   conversations:get             sync getConversation vs worker
//   activity-history:replace      legacy replace (zod parse + BEGIN IMMEDIATE +
//                                 JSON.stringify of every record) vs current
//   activity-history:update       one changed record via the incremental API
//   activity startup load         whole list (pre-paging get) vs first page (200)
//                                 + summary on the readonly worker
//   activity page / summary       sync paths, for reference
// Env: GB_MPERF_CONVERSATIONS, GB_MPERF_MESSAGES, GB_MPERF_ACTIVITY,
// GB_MPERF_CALLS, GB_MPERF_OUTPUT (JSON), GB_MPERF_NODE=1 (skip Electron).
const { buildSync } = require('esbuild')
const { mkdtempSync, rmSync, writeFileSync, mkdirSync } = require('node:fs')
const { join, resolve } = require('node:path')
const { randomUUID } = require('node:crypto')
const { monitorEventLoopDelay, performance } = require('node:perf_hooks')

const root = resolve(__dirname, '..')

if (process.env.GB_MPERF_NODE !== '1') {
  let electron
  let version
  try { electron = require('electron'); version = require('electron/package.json').version } catch { electron = undefined }
  if (typeof electron === 'string' && process.versions.electron !== version) {
    const { status } = require('node:child_process').spawnSync(electron, [__filename], {
      stdio: 'inherit', env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
    })
    process.exit(status ?? 1)
  }
}

const conversationCount = Number(process.env.GB_MPERF_CONVERSATIONS || 1000)
const messageCount = Number(process.env.GB_MPERF_MESSAGES || 20000)
const activityCount = Number(process.env.GB_MPERF_ACTIVITY || 24000)
const calls = Number(process.env.GB_MPERF_CALLS || 15)

const temporaryRoot = join(root, 'temp', 'goodbuddy-storage-foundation')
mkdirSync(temporaryRoot, { recursive: true })
const directory = mkdtempSync(join(temporaryRoot, 'main-perf-'))
const bundle = join(directory, 'assistant-database.cjs')
const workerBundle = join(directory, 'readonly-query-worker.cjs')
const schemaBundle = join(directory, 'assistant-contracts.cjs')
const readerBundle = join(directory, 'readonly-query-reader.cjs')
for (const [entry, outfile] of [
  ['src/main/assistant/assistant-database.ts', bundle],
  ['src/main/readonly-query-worker.ts', workerBundle],
  ['src/main/readonly-query-reader.ts', readerBundle],
  ['src/shared/assistant-contracts.ts', schemaBundle]
]) {
  buildSync({
    entryPoints: [join(root, entry)], bundle: true, platform: 'node', format: 'cjs',
    target: 'node22', outfile, logLevel: 'error', external: ['electron']
  })
}
const { AssistantDatabase } = require(bundle)
const { ReadonlyQueryReader } = require(readerBundle)
let ownedDatabase, reader
const { activityHistorySnapshotSchema } = require(schemaBundle)

let seed = 42
const random = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296)
const words = 'lighthouse harbor policy engine renderer stream vector index budget latency schedule archive network storage contract invoice release window memory review 发布 审批 流程'.split(' ')
const sentence = n => Array.from({ length: n }, () => words[Math.floor(random() * words.length)]).join(' ')
const round = value => Math.round(value * 10) / 10
const percentile = (values, p) => {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))]
}

/**
 * Runs `body` `calls` times (after one warm-up) and reports the per-call wall
 * time and the harness event-loop delay histogram (p99/max) over the run.
 */
async function measure(body) {
  await body(-1)
  await new Promise(resolve => setTimeout(resolve, 50))
  // monitorEventLoopDelay is bound to the ~15 ms Windows timer granularity, so
  // the longest block is measured as the largest gap between setImmediate
  // ticks (each tick is one event-loop turn).
  const histogram = monitorEventLoopDelay({ resolution: 1 })
  histogram.enable()
  let probing = true
  let last = performance.now()
  let maxGap = 0
  const tick = () => {
    const now = performance.now()
    maxGap = Math.max(maxGap, now - last)
    last = now
    if (probing) setImmediate(tick)
  }
  setImmediate(tick)
  const samples = []
  for (let index = 0; index < calls; index += 1) {
    const started = performance.now()
    await body(index)
    samples.push(performance.now() - started)
    // Yield like the IPC loop does between messages.
    await new Promise(resolve => setImmediate(resolve))
  }
  await new Promise(resolve => setTimeout(resolve, 20))
  probing = false
  histogram.disable()
  return {
    callP50: round(percentile(samples, 50)), callP95: round(percentile(samples, 95)),
    loopP99: round(histogram.percentile(99) / 1e6), loopMax: round(maxGap)
  }
}

/** The pre-PERF-15 replace implementation, kept as the "before" reference. */
function legacyReplace(raw, cache, input) {
  const snapshot = activityHistorySnapshotSchema.parse(input)
  raw.exec('BEGIN IMMEDIATE')
  try {
    const { data_version: dataVersion } = raw.prepare('PRAGMA data_version').get()
    let previous = cache.value?.dataVersion === dataVersion ? cache.value.records : undefined
    if (!previous) {
      previous = new Map(raw.prepare('SELECT record_key, record_json FROM activity_history_records').all()
        .map(row => [row.record_key, row.record_json]))
    }
    const records = new Map()
    const occurrences = new Map()
    const order = []
    // order_seq only satisfies the current schema; the old code kept order in the JSON list below.
    const upsert = raw.prepare(`INSERT INTO activity_history_records (record_key, record_json, order_seq) VALUES (?, ?, ?)
      ON CONFLICT(record_key) DO UPDATE SET record_json = excluded.record_json`)
    for (const record of snapshot.records) {
      const occurrence = occurrences.get(record.id) ?? 0
      occurrences.set(record.id, occurrence + 1)
      const key = JSON.stringify([record.id, occurrence])
      const json = JSON.stringify(record)
      order.push(key)
      if (previous.get(key) !== json) upsert.run(key, json, snapshot.records.length - order.length + 1)
      records.set(key, json)
    }
    const remove = raw.prepare('DELETE FROM activity_history_records WHERE record_key = ?')
    for (const key of previous.keys()) if (!records.has(key)) remove.run(key)
    const orderJson = JSON.stringify(order)
    const incomplete = Number(snapshot.legacyHistoryMayBeIncomplete)
    raw.prepare(`UPDATE activity_history SET record_order_json = ?, legacy_history_may_be_incomplete = ?
      WHERE singleton = 1 AND (record_order_json != ? OR legacy_history_may_be_incomplete != ?)`)
      .run(orderJson, incomplete, orderJson, incomplete)
    raw.exec('COMMIT')
    cache.value = { records, dataVersion }
  } catch (error) {
    raw.exec('ROLLBACK')
    throw error
  }
}

async function main() {
  console.log(`[mperf] runtime: node ${process.version}${process.versions.electron ? ` (electron ${process.versions.electron})` : ''}`)
  const workspace = join(directory, 'workspace')
  mkdirSync(workspace)
  const path = join(directory, 'assistant.sqlite')
  const seeding = new AssistantDatabase(path)
  ownedDatabase = seeding
  seeding.initialize(workspace)
  const seedStarted = performance.now()
  const projectId = seeding.listProjects()[0].id
  // Message counts follow a skewed distribution; the first conversation is the largest.
  const weights = Array.from({ length: conversationCount }, (_, index) => 1 / (1 + index * 0.01))
  const weightSum = weights.reduce((sum, value) => sum + value, 0)
  const counts = weights.map(weight => Math.max(1, Math.round(messageCount * weight / weightSum)))
  const ids = counts.map(() => randomUUID())
  for (let start = 0; start < conversationCount; start += 50) {
    seeding.saveLocalConversations(ids.slice(start, start + 50).map((id, offset) => {
      const index = start + offset
      return {
        header: { id, projectId, title: `Conversation ${index} ${sentence(3)}`, updatedAt: 1_700_000_000_000 + index },
        messages: Array.from({ length: counts[index] }, (_, at) => ({
          id: randomUUID(), role: at % 2 === 0 ? 'user' : 'assistant', state: 'complete',
          content: sentence(at % 2 === 0 ? 30 : 120), createdAt: 1_700_000_000_000 + index * 1000 + at
        }))
      }
    }))
  }
  const records = Array.from({ length: activityCount }, (_, index) => ({
    id: randomUUID(), conversationId: ids[index % conversationCount], requestId: randomUUID(),
    ...(index % 2 === 0 ? { callId: `call-${index}` } : {}),
    scope: index % 3 === 0 ? { kind: 'project', projectId, projectName: 'Perf' } : { kind: 'global' },
    kind: index % 5 === 0 ? 'request' : 'tool', title: `Tool ${index}`, detail: sentence(40),
    status: 'completed', createdAt: 1_700_000_000_000 + index
  }))
  seeding.replaceActivityHistory({ records, legacyHistoryMayBeIncomplete: false })
  const seedSeconds = round((performance.now() - seedStarted) / 1000)
  seeding.close()

  const database = new AssistantDatabase(path)
  ownedDatabase = database
  database.initialize(workspace)
  const raw = database.database
  const totalMessages = counts.reduce((sum, value) => sum + value, 0)
  const largest = ids[0]
  const typical = ids[Math.floor(conversationCount / 2)]
  // The renderer retains the current conversation's history.
  const detailIds = [ids[1]]
  const results = { conversations: conversationCount, messages: totalMessages, activityRecords: activityCount,
    largestConversationMessages: counts[0], seedSeconds }

  results.listSummariesSync = await measure(async () => database.listConversationSummaries(detailIds))
  results.getLargestSync = await measure(async () => database.getConversation(largest))
  results.getTypicalSync = await measure(async () => database.getConversation(typical))
  reader = new ReadonlyQueryReader('assistant', path, workerBundle)
  results.listSummariesWorker = await measure(() => reader.call('listConversationSummaries', [detailIds]))
  results.getLargestWorker = await measure(() => reader.call('getConversation', [largest]))
  results.getTypicalWorker = await measure(() => reader.call('getConversation', [typical]))

  // The renderer sends a fresh structured clone of the whole list every save.
  const unchanged = () => structuredClone({ records, legacyHistoryMayBeIncomplete: false })
  const oneChanged = index => {
    const snapshot = unchanged()
    const record = snapshot.records[(index + 2) % 50]
    record.detail = `${record.detail} ${index}`
    return snapshot
  }
  // Inputs are cloned up front: cloning happens in the renderer / IPC layer.
  const run = async (makeInput, call) => {
    const inputs = Array.from({ length: calls + 1 }, (_, index) => makeInput(index - 1))
    return measure(async index => call(inputs[index + 1]))
  }
  const legacyCache = {}
  results.replaceUnchangedLegacy = await run(unchanged, input => legacyReplace(raw, legacyCache, input))
  results.replaceOneChangedLegacy = await run(oneChanged, input => legacyReplace(raw, legacyCache, input))
  // Restore a consistent state for the current implementation's cache.
  database.replaceActivityHistory({ records, legacyHistoryMayBeIncomplete: false })
  results.replaceUnchangedAfter = await run(unchanged, input => database.replaceActivityHistory(input))
  results.replaceOneChangedAfter = await run(oneChanged, input => database.replaceActivityHistory(input))
  results.updateOneRecord = await run(index => {
    const record = { ...records[(index + 2) % 50], detail: `incremental ${index}`, status: 'running' }
    return { changes: [{ type: 'upsert', position: 'front', record }] }
  }, input => database.updateActivityHistory(input))

  // Startup: the renderer used to load the whole list; now the first page and the summary.
  const firstPageRequest = { limit: 200 }
  const summaryRequest = () => ({ conversationIds: [...new Set(database.getActivityHistoryPage(firstPageRequest).records.map(record => record.conversationId))] })
  results.activityFullLoad = await measure(async () => database.getActivityHistory())
  results.activityFirstPageSync = await measure(async () => database.getActivityHistoryPage(firstPageRequest))
  results.activitySummarySync = await measure(async () => database.getActivityHistorySummary(summaryRequest()))
  results.activityStartupWorker = await measure(async () => {
    const page = await reader.call('activityHistoryPage', [firstPageRequest])
    await reader.call('activityHistorySummary', [{ conversationIds: [...new Set(page.records.map(record => record.conversationId))] }])
  })
  results.activityFullLoadBytes = JSON.stringify(database.getActivityHistory()).length
  results.activityFirstPageBytes = JSON.stringify(database.getActivityHistoryPage(firstPageRequest)).length
  await reader.close()
  database.close()

  console.log(`[mperf] seeded ${results.conversations} conversations / ${results.messages} messages (largest ${results.largestConversationMessages}), ${results.activityRecords} activity records in ${seedSeconds} s`)
  const rows = [
    ['conversations:list-summaries', results.listSummariesSync, results.listSummariesWorker],
    [`conversations:get (${counts[0]} msgs)`, results.getLargestSync, results.getLargestWorker],
    [`conversations:get (${counts[Math.floor(conversationCount / 2)]} msgs)`, results.getTypicalSync, results.getTypicalWorker],
    ['activity replace, unchanged', results.replaceUnchangedLegacy, results.replaceUnchangedAfter],
    ['activity replace, 1 changed', results.replaceOneChangedLegacy, results.replaceOneChangedAfter],
    ['activity update, 1 record', results.replaceOneChangedLegacy, results.updateOneRecord],
    ['activity startup: full list vs page+summary (worker)', results.activityFullLoad, results.activityStartupWorker],
    ['activity first page (200), sync', results.activityFullLoad, results.activityFirstPageSync],
    ['activity summary, sync', results.activityFullLoad, results.activitySummarySync]
  ]
  console.table(rows.map(([name, before, after]) => ({
    path: name,
    'before call p50/p95 ms': `${before.callP50} / ${before.callP95}`,
    'before loop max ms': before.loopMax,
    'after call p50/p95 ms': `${after.callP50} / ${after.callP95}`,
    'after loop max ms': after.loopMax
  })))
  console.log(`[mperf] activity payload: full list ${results.activityFullLoadBytes} bytes, first page ${results.activityFirstPageBytes} bytes`)
  const output = process.env.GB_MPERF_OUTPUT
  if (output) writeFileSync(output, JSON.stringify({ kind: 'goodbuddy-main-database-benchmark', executionBoundary: 'owner-local', node: process.version, results }, null, 2))
}

main().catch(error => { process.exitCode = 1; console.error(error) }).finally(async () => {
  await reader?.close()
  ownedDatabase?.close()
  rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
})

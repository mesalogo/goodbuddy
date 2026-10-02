// Main-process database benchmark (PERF-15). Bundles the production
// AssistantDatabase and readonly worker with esbuild, seeds a temporary
// assistant database (default 1,000 conversations / 20,000 messages and 5,000
// activity records) and measures, for the IPC paths the renderer hits often:
//   - per-call time
//   - Main event-loop delay while the calls run back to back
// for the previous synchronous path ("sync") and the current path ("after").
//   conversations:list-summaries  sync listConversationSummaries vs worker
//   conversations:get             sync getConversation vs worker
//   activity-history:replace      legacy replace (zod parse + BEGIN IMMEDIATE +
//                                 JSON.stringify of every record) vs current
//   activity-history:update       one changed record via the incremental API
// Env: GB_MPERF_CONVERSATIONS, GB_MPERF_MESSAGES, GB_MPERF_ACTIVITY,
// GB_MPERF_CALLS, GB_MPERF_OUTPUT (JSON), GB_MPERF_NODE=1 (skip Electron).
const { buildSync } = require('esbuild')
const { mkdtempSync, rmSync, writeFileSync, mkdirSync } = require('node:fs')
const { tmpdir } = require('node:os')
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
const activityCount = Number(process.env.GB_MPERF_ACTIVITY || 5000)
const calls = Number(process.env.GB_MPERF_CALLS || 15)

const directory = mkdtempSync(join(tmpdir(), 'goodbuddy-main-perf-'))
const bundle = join(directory, 'assistant-database.cjs')
const workerBundle = join(directory, 'readonly-query-worker.cjs')
const schemaBundle = join(directory, 'assistant-contracts.cjs')
for (const [entry, outfile] of [
  ['src/main/assistant/assistant-database.ts', bundle],
  ['src/main/readonly-query-worker.ts', workerBundle],
  ['src/shared/assistant-contracts.ts', schemaBundle]
]) {
  buildSync({
    entryPoints: [join(root, entry)], bundle: true, platform: 'node', format: 'cjs',
    target: 'node22', outfile, logLevel: 'error', external: ['electron']
  })
}
const { AssistantDatabase } = require(bundle)
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
 * time and the Main event-loop delay histogram (p99/max) over the run.
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
    const upsert = raw.prepare(`INSERT INTO activity_history_records (record_key, record_json) VALUES (?, ?)
      ON CONFLICT(record_key) DO UPDATE SET record_json = excluded.record_json`)
    for (const record of snapshot.records) {
      const occurrence = occurrences.get(record.id) ?? 0
      occurrences.set(record.id, occurrence + 1)
      const key = JSON.stringify([record.id, occurrence])
      const json = JSON.stringify(record)
      order.push(key)
      if (previous.get(key) !== json) upsert.run(key, json)
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
  database.enableReadonlyWorker(workerBundle)
  results.listSummariesWorker = await measure(() => database.listConversationSummariesAsync(detailIds))
  results.getLargestWorker = await measure(() => database.getConversationAsync(largest))
  results.getTypicalWorker = await measure(() => database.getConversationAsync(typical))

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
  database.close()

  console.log(`[mperf] seeded ${results.conversations} conversations / ${results.messages} messages (largest ${results.largestConversationMessages}), ${results.activityRecords} activity records in ${seedSeconds} s`)
  const rows = [
    ['conversations:list-summaries', results.listSummariesSync, results.listSummariesWorker],
    [`conversations:get (${counts[0]} msgs)`, results.getLargestSync, results.getLargestWorker],
    [`conversations:get (${counts[Math.floor(conversationCount / 2)]} msgs)`, results.getTypicalSync, results.getTypicalWorker],
    ['activity replace, unchanged', results.replaceUnchangedLegacy, results.replaceUnchangedAfter],
    ['activity replace, 1 changed', results.replaceOneChangedLegacy, results.replaceOneChangedAfter],
    ['activity update, 1 record', results.replaceOneChangedLegacy, results.updateOneRecord]
  ]
  console.table(rows.map(([name, before, after]) => ({
    path: name,
    'before call p50/p95 ms': `${before.callP50} / ${before.callP95}`,
    'before loop max ms': before.loopMax,
    'after call p50/p95 ms': `${after.callP50} / ${after.callP95}`,
    'after loop max ms': after.loopMax
  })))
  const output = process.env.GB_MPERF_OUTPUT
  if (output) writeFileSync(output, JSON.stringify({ kind: 'goodbuddy-main-database-benchmark', node: process.version, results }, null, 2))
}

main().catch(error => { process.exitCode = 1; console.error(error) }).finally(() => {
  rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
})

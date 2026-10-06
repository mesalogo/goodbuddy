// Owner-local database WRITE microbenchmark on a closed data copy (PERF-15).
// Copies assistant.sqlite (+ -wal/-shm) from GB_WPERF_DATA (for example the
// portable build's data folder) into a temporary directory - the source is
// never opened - then measures, with the production AssistantDatabase, the
// synchronous repository writes. This is not a production Main IPC latency probe:
//   task-events:subagent   replay of the largest real subagent progress stream
//                          (restored events, re-compacted on write, as live)
//   task-events:tool       replay of real tool events
//   task-events:text       250 ms text batches (persisted buffer)
//   conversations:save     the renderer's 500 ms local save (header + the
//                          streaming assistant message) for a real conversation
//   activity:update        one incremental activity change
// For each: per-call time and the longest owner-local harness event-loop block.
// Event replays are paced at GB_WPERF_RATE events/s (default 270, the busiest
// second in real data; 0 = back to back).
// Env: GB_WPERF_DATA (required), GB_WPERF_EVENTS (default 2000),
// GB_WPERF_OUTPUT (JSON), GB_WPERF_KEEP=1 (keep the copy).
const { buildSync } = require('esbuild')
const { mkdtempSync, rmSync, writeFileSync, mkdirSync, copyFileSync, cpSync, existsSync } = require('node:fs')
const { Worker } = require('node:worker_threads')
const { join, resolve } = require('node:path')
const { randomUUID } = require('node:crypto')
const { performance } = require('node:perf_hooks')

const root = resolve(__dirname, '..')

if (process.env.GB_WPERF_NODE !== '1') {
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

const source = process.env.GB_WPERF_DATA
if (!source || !existsSync(join(source, 'assistant.sqlite'))) {
  console.error('[wperf] set GB_WPERF_DATA to a GoodBuddy data directory containing assistant.sqlite')
  process.exit(2)
}
const eventLimit = Number(process.env.GB_WPERF_EVENTS || 2000)

const temporaryRoot = join(root, 'temp', 'goodbuddy-storage-foundation')
mkdirSync(temporaryRoot, { recursive: true })
const directory = mkdtempSync(join(temporaryRoot, 'write-perf-'))
let ownedDatabase, checkpoint, checkpointExit
const bundle = join(directory, 'assistant-database.cjs')
const progressBundle = join(directory, 'subagent-progress.cjs')
for (const [entry, outfile] of [
  ['src/main/assistant/assistant-database.ts', bundle],
  ['src/main/assistant/subagent-progress-storage.ts', progressBundle],
  ['src/main/readonly-query-worker.ts', join(directory, 'readonly-query-worker.cjs')]
]) {
  buildSync({
    entryPoints: [join(root, entry)], bundle: true, platform: 'node', format: 'cjs',
    target: 'node22', outfile, logLevel: 'error', external: ['electron']
  })
}
const { AssistantDatabase } = require(bundle)
const { restoreSubagentPayload } = require(progressBundle)

const round = value => Math.round(value * 10) / 10
const percentile = (values, p) => {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))]
}

/** Per-call times plus the longest gap between event-loop turns. */
async function measure(count, body, { yieldEvery = 1, rate = 0 } = {}) {
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
  const slow = []
  const started = performance.now()
  for (let index = 0; index < count; index += 1) {
    const at = performance.now()
    body(index)
    const elapsed = performance.now() - at
    samples.push(elapsed)
    if (elapsed > 50) slow.push([index, round(elapsed)])
    if (rate > 0) {
      // Real streams arrive at a rate; wait until this call's scheduled time.
      const due = started + ((index + 1) * 1000) / rate
      const wait = due - performance.now()
      await new Promise(resolve => (wait > 1 ? setTimeout(resolve, wait) : setImmediate(resolve)))
    } else if ((index + 1) % yieldEvery === 0) await new Promise(resolve => setImmediate(resolve))
  }
  const total = performance.now() - started
  await new Promise(resolve => setTimeout(resolve, 20))
  probing = false
  return {
    calls: count, totalMs: round(total), callP50: round(percentile(samples, 50)),
    callP95: round(percentile(samples, 95)), callP99: round(percentile(samples, 99)),
    callMax: round(Math.max(...samples)), loopMax: round(maxGap), slowCalls: slow.slice(0, 10)
  }
}

async function main() {
  console.log(`[wperf] runtime: node ${process.version}${process.versions.electron ? ` (electron ${process.versions.electron})` : ''}`)
  const copyStarted = performance.now()
  for (const name of ['assistant.sqlite', 'assistant.sqlite-wal', 'assistant.sqlite-shm']) {
    if (existsSync(join(source, name))) copyFileSync(join(source, name), join(directory, name))
  }
  // Initialization checks note files against the database.
  if (existsSync(join(source, 'notes'))) cpSync(join(source, 'notes'), join(directory, 'notes'), { recursive: true })
  console.log(`[wperf] copied data in ${round((performance.now() - copyStarted) / 1000)} s`)
  const workspace = join(directory, 'workspace')
  mkdirSync(workspace)
  const database = new AssistantDatabase(join(directory, 'assistant.sqlite'))
  ownedDatabase = database
  const openStarted = performance.now()
  database.initialize(workspace)
  const raw = database.database
  const results = { openMs: round(performance.now() - openStarted) }
  // Experiment switch: override the durability level after initialization.
  if (process.env.GB_WPERF_SYNCHRONOUS) raw.exec(`PRAGMA synchronous = ${process.env.GB_WPERF_SYNCHRONOUS}`)
  results.synchronous = raw.prepare('PRAGMA synchronous').get().synchronous
  if (process.env.GB_WPERF_AUTOCHECKPOINT) raw.exec(`PRAGMA wal_autocheckpoint = ${process.env.GB_WPERF_AUTOCHECKPOINT}`)
  // As in production: checkpoints run on a worker thread (GB_WPERF_CHECKPOINT_WORKER=0 disables).
  if (process.env.GB_WPERF_CHECKPOINT_WORKER !== '0') {
    checkpoint = new Worker(join(directory, 'readonly-query-worker.cjs'), {
      workerData: { kind: 'checkpoint', databasePath: join(directory, 'assistant.sqlite'), intervalMs: 250 }
    })
    checkpointExit = new Promise(resolve => checkpoint.once('exit', resolve))
    await new Promise((resolve, reject) => { checkpoint.once('message', resolve); checkpoint.once('error', reject) })
  }
  results.walAutocheckpoint = raw.prepare('PRAGMA wal_autocheckpoint').get().wal_autocheckpoint
  const count = (sql, ...args) => Number(raw.prepare(sql).get(...args).n)
  results.taskEvents = count('SELECT COUNT(*) AS n FROM task_events')
  results.messages = count('SELECT COUNT(*) AS n FROM messages')
  results.activityRecords = count('SELECT COUNT(*) AS n FROM activity_history_records')

  // The real task with the most subagent events, restored in order.
  const sourceTask = raw.prepare(
    `SELECT task_id FROM task_events WHERE kind = 'subagent' GROUP BY task_id ORDER BY COUNT(*) DESC LIMIT 1`
  ).get()?.task_id
  const blocks = new Map()
  const subagentEvents = sourceTask ? raw.prepare(
    `SELECT payload_json FROM task_events WHERE task_id = ? AND kind = 'subagent' ORDER BY id LIMIT ?`
  ).all(sourceTask, eventLimit).map(row => restoreSubagentPayload(JSON.parse(row.payload_json), blocks)) : []
  const toolEvents = raw.prepare(
    `SELECT payload_json FROM task_events WHERE kind = 'tool' ORDER BY id DESC LIMIT ?`
  ).all(eventLimit).map(row => JSON.parse(row.payload_json))

  const conversation = raw.prepare(
    `SELECT conversation_id AS id FROM messages GROUP BY conversation_id ORDER BY COUNT(*) DESC LIMIT 1`
  ).get()?.id
  const taskId = randomUUID()
  database.createTask({ id: taskId, title: 'write perf', instructions: 'replay', conversationId: conversation })

  const replay = (events, kind) => index => {
    const event = { ...events[index % events.length], requestId: taskId }
    database.appendTaskEvent(taskId, kind, event)
  }
  if (process.env.GB_WPERF_INSPECT) {
    const at = Number(process.env.GB_WPERF_INSPECT)
    const { compactSubagentPayload } = require(progressBundle)
    const event = subagentEvents[at]
    const t0 = performance.now()
    const json = JSON.stringify(event)
    const t1 = performance.now()
    const restoredBlocks = new Map()
    for (let i = 0; i < at; i += 1) restoreSubagentPayload(JSON.parse(JSON.stringify(compactSubagentPayload(subagentEvents[i], restoredBlocks))), restoredBlocks)
    const t2 = performance.now()
    const compact = JSON.stringify(compactSubagentPayload(event, restoredBlocks))
    const t3 = performance.now()
    console.log(`[wperf] event ${at}: full ${json.length} B (stringify ${round(t1 - t0)} ms), compact ${compact.length} B (compact ${round(t3 - t2)} ms)`)
    console.log(`[wperf] event ${at} progress blocks: ${(event.progress ?? []).length}, updates: ${(event.progressUpdates ?? []).length}`)
  }
  // Paced at the busiest second seen in real data (269 subagent events/s); 0 = back to back.
  const rate = Number(process.env.GB_WPERF_RATE ?? 270)
  if (subagentEvents.length) {
    results.subagentEvents = await measure(subagentEvents.length, replay(subagentEvents, 'subagent'), { rate })
  }
  if (toolEvents.length) results.toolEvents = await measure(toolEvents.length, replay(toolEvents, 'tool'), { rate })
  const delta = 'streamed text '.repeat(40)
  results.textBatches = await measure(400, index => database.appendTaskEvent(taskId, 'text',
    { type: 'text', requestId: taskId, delta: `${delta}${index}` }))

  // Renderer local save: the conversation header and the streaming assistant message growing.
  if (conversation) {
    const snapshot = database.getConversation(conversation)
    const header = {
      id: snapshot.id, projectId: snapshot.projectId, title: snapshot.title,
      runtimeSelection: snapshot.runtimeSelection, updatedAt: Date.now()
    }
    const messageId = randomUUID()
    let content = ''
    results.conversationSave = await measure(200, index => {
      content += 'Lorem ipsum dolor sit amet, streaming reply chunk. '.repeat(8)
      database.saveLocalConversations([{
        header: { ...header, updatedAt: Date.now() + index },
        messages: [{ id: messageId, role: 'assistant', state: 'streaming', content, createdAt: Date.now() }]
      }])
    })
    results.conversationGet = await measure(20, () => database.getConversation(conversation))
  }

  const sample = database.getActivityHistoryPage({ limit: 50 }).records
  if (sample.length) {
    results.activityUpdate = await measure(200, index => database.updateActivityHistory({
      changes: [{ type: 'upsert', position: 'in-place', record: { ...sample[index % sample.length], detail: `perf ${index}` } }]
    }))
  }
  results.walBytes = existsSync(join(directory, 'assistant.sqlite-wal'))
    ? require('node:fs').statSync(join(directory, 'assistant.sqlite-wal')).size : 0
  if (checkpoint) { checkpoint.postMessage({ type: 'close' }); await checkpointExit; checkpoint = undefined }
  database.close()

  console.log(`[wperf] ${results.taskEvents} task events, ${results.messages} messages, ${results.activityRecords} activity records; open ${results.openMs} ms`)
  const rows = [
    ['task event: subagent (real stream)', results.subagentEvents],
    ['task event: tool (real)', results.toolEvents],
    ['task event: text batch', results.textBatches],
    ['conversation save (500 ms tick)', results.conversationSave],
    ['conversation get (largest)', results.conversationGet],
    ['activity update, 1 record', results.activityUpdate]
  ].filter(([, value]) => value)
  console.table(rows.map(([name, r]) => ({
    path: name, calls: r.calls, 'p50 ms': r.callP50, 'p95 ms': r.callP95, 'p99 ms': r.callP99,
    'max ms': r.callMax, 'loop max ms': r.loopMax, 'calls/s': Math.round(r.calls / (r.totalMs / 1000))
  })))
  for (const [name, r] of rows) if (r.slowCalls.length) console.log(`[wperf] slow calls (index, ms) ${name}: ${JSON.stringify(r.slowCalls)}`)
  console.log(`[wperf] synchronous=${results.synchronous} wal_autocheckpoint=${results.walAutocheckpoint} wal=${results.walBytes} B`)
  const output = process.env.GB_WPERF_OUTPUT
  if (output) writeFileSync(output, JSON.stringify({ kind: 'goodbuddy-main-write-benchmark', executionBoundary: 'owner-local', node: process.version, results }, null, 2))
}

main().catch(error => { process.exitCode = 1; console.error(error) }).finally(async () => {
  if (checkpoint) { checkpoint.postMessage({ type: 'close' }); await checkpointExit }
  ownedDatabase?.close()
  if (process.env.GB_WPERF_KEEP === '1') console.log(`[wperf] kept ${directory}`)
  else rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
})

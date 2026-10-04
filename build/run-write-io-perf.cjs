// Windows logical-I/O probe against an isolated copy of a quiescent data folder.
// GB_WPERF_DATA must contain assistant.sqlite. No source database is opened.
const { buildSync } = require('esbuild')
const { mkdtempSync, copyFileSync, cpSync, existsSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join, resolve } = require('node:path')
const { randomUUID } = require('node:crypto')
const { performance } = require('node:perf_hooks')
const { execFileSync, spawnSync } = require('node:child_process')
const { deepStrictEqual } = require('node:assert')

if (process.platform !== 'win32') throw new Error('This probe uses Windows process I/O counters')
if (!process.versions.electron) {
  const result = spawnSync(require('electron'), [__filename], {
    stdio: 'inherit', env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
  })
  process.exit(result.status ?? 1)
}
const io = () => JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-Command',
  `Get-CimInstance Win32_Process -Filter 'ProcessId=${process.pid}' | Select-Object ReadTransferCount,WriteTransferCount | ConvertTo-Json -Compress`
], { encoding: 'utf8' }))
const source = process.env.GB_WPERF_DATA
if (!source || !existsSync(join(source, 'assistant.sqlite'))) throw new Error('Set GB_WPERF_DATA')
const directory = mkdtempSync(join(tmpdir(), 'goodbuddy-write-io-'))
let database
try {
  const path = join(directory, 'assistant.sqlite')
  for (const suffix of ['', '-wal', '-shm']) {
    if (existsSync(join(source, `assistant.sqlite${suffix}`))) {
      copyFileSync(join(source, `assistant.sqlite${suffix}`), `${path}${suffix}`)
    }
  }
  if (existsSync(join(source, 'notes'))) cpSync(join(source, 'notes'), join(directory, 'notes'), { recursive: true })
  const bundle = join(directory, 'database.cjs')
  buildSync({ entryPoints: [resolve(__dirname, '../src/main/assistant/assistant-database.ts')],
    outfile: bundle, bundle: true, platform: 'node', format: 'cjs', external: ['electron'], logLevel: 'error' })
  const { AssistantDatabase } = require(bundle)
  database = new AssistantDatabase(path)
  database.initialize(directory)
  const raw = database.database
  const largest = raw.prepare(`SELECT id, conversation_id, length(metadata_json) AS bytes
    FROM messages ORDER BY length(metadata_json) DESC LIMIT 1`).get()
  if (!largest) throw new Error('No messages')
  const snapshot = database.getConversation(largest.conversation_id)
  const message = snapshot.messages.find(item => item.id === largest.id)
  // Summary reads must remain small even while a large history is streaming.
  database.saveLocalConversations([{ header: { ...snapshot, messages: undefined },
    messages: [{ ...message, state: 'streaming' }] }])
  const taskId = randomUUID()
  database.createTask({ id: taskId, projectId: snapshot.projectId,
    conversationId: snapshot.id, title: 'I/O probe', instructions: '', visible: false })
  database.startExecutionTiming(taskId)
  raw.exec('PRAGMA wal_checkpoint(TRUNCATE)')
  console.log(JSON.stringify({ schema: raw.prepare('PRAGMA user_version').get(), metadataBytes: largest.bytes }))
  const results = []
  for (const [variant, query, count] of [
    ['read-conversation', () => database.getConversation(snapshot.id), 1],
    ['read-summary', () => database.listConversationSummaries([]), 1],
    ['conversation-timing', () => database.getExecutionStats({ conversationId: snapshot.id }), 20],
    ...(snapshot.projectId ? [['project-timing', () => database.getExecutionStats({ projectId: snapshot.projectId }), 20]] : [])
  ]) {
    const before = io()
    const start = performance.now()
    for (let index = 0; index < count; index++) query()
    const elapsedMs = Math.round(performance.now() - start)
    const after = io()
    results.push({ variant, calls: count, elapsedMs,
      readMiB: Number(((after.ReadTransferCount - before.ReadTransferCount) / 1024 / 1024).toFixed(3)),
      writeMiB: Number(((after.WriteTransferCount - before.WriteTransferCount) / 1024 / 1024).toFixed(3)) })
  }
  database.endExecutionTiming(taskId)
  deepStrictEqual(database.getConversation(snapshot.id).messages,
    snapshot.messages.map(item => item.id === message.id ? { ...item, state: 'streaming' } : item))
  console.table(results)
} finally {
  database?.close()
  rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
}

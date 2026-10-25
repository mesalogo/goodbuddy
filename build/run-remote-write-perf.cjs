// node build/run-remote-write-perf.cjs [baseline-worktree]
// Deterministic owner-local SQLite write probe; no model or user data.
// WAL growth with autocheckpoint disabled measures emitted WAL bytes/frames,
// not physical device writes or fsync calls. FULL remains enabled throughout.
const { buildSync } = require('esbuild')
const { mkdtempSync, mkdirSync, rmSync, statSync, existsSync } = require('node:fs')
const { join, resolve } = require('node:path')
const { performance } = require('node:perf_hooks')
const assert = require('node:assert/strict')
const os = require('node:os')
const { DatabaseSync } = require('node:sqlite')
const root = resolve(__dirname, '..')
const parent = join(root, 'temp', 'remote-write-perf')
mkdirSync(parent, { recursive: true })
const directory = mkdtempSync(join(parent, 'run-'))
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const owner = { conversationId: id(1), taskId: id(2), assistantMessageId: id(4) }
const entry = (sequence, index, event) => ({ bindingId: 'benchmark-binding',
  operationId: owner.taskId, semanticSequence: String(sequence), eventIndex: index,
  event: { requestId: owner.taskId, ...event } })
function measure(Database, label, round, scenario) {
  const folder = join(directory, `${label}-${round}-${scenario}`)
  mkdirSync(folder)
  const file = join(folder, 'assistant.sqlite')
  const database = new Database(file)
  try {
    database.initialize(folder)
    const project = database.createSshProject({
      project: { name: 'benchmark', description: '', rootPath: '/benchmark', runtimeSelection: { provider: 'opencode' } },
      executionSpace: { kind: 'ssh', hostId: id(5), remoteRootPath: '/benchmark' }, assertCurrent() {}
    })
    database.saveLocalConversations([{ header: { id: owner.conversationId, projectId: project.id,
      title: 'benchmark', updatedAt: 0 }, messages: [] }])
    database.createTask({ id: owner.taskId, projectId: project.id, conversationId: owner.conversationId,
      title: 'benchmark', instructions: 'benchmark', remoteRecovery: { recoverable: true,
        currentUserMessageId: id(3), currentAssistantMessageId: owner.assistantMessageId } })
    const append = events => database.appendRemoteConversationTaskEventsBatch({ ...owner, events })
    const seed = 'deterministic transcript\n'.repeat(4096)
    append([entry(1, 0, { type: 'text', delta: seed }), entry(1, 1, { type: 'status', message: 'working' }),
      entry(1, 2, { type: 'remote-semantic-checkpoint' })])
    const raw = database.database
    assert.equal(raw.prepare('PRAGMA synchronous').get().synchronous, 2)
    raw.exec('PRAGMA wal_autocheckpoint = 0; PRAGMA wal_checkpoint(TRUNCATE)')
    const pageSize = raw.prepare('PRAGMA page_size').get().page_size
    const before = raw.prepare('SELECT total_changes() AS n').get().n
    let commits = 0
    let messageUpdates = 0
    const exec = raw.exec.bind(raw)
    const prepare = raw.prepare.bind(raw)
    raw.exec = sql => {
      if (/^COMMIT/.test(sql)) {
        assert.equal(prepare('PRAGMA synchronous').get().synchronous, 2)
        commits++
      }
      return exec(sql)
    }
    raw.prepare = sql => {
      if (/^UPDATE messages\s/.test(sql.trim())) messageUpdates++
      return prepare(sql)
    }
    const samples = []
    for (let i = 0; i < 120; i++) {
      const event = scenario === 'text' ? { type: 'text', delta: 'next chunk\n' }
        : scenario === 'status' ? { type: 'status', message: 'working' }
          : { type: 'context-metrics', contextTokens: 1000 + i, effectiveTriggerTokens: 10000,
            compressionEnabled: false, source: 'provider' }
      const start = performance.now()
      assert.deepEqual(append([entry(i + 2, 0, event), entry(i + 2, 1, { type: 'remote-semantic-checkpoint' })]), [true, true])
      samples.push(performance.now() - start)
    }
    const walBytes = existsSync(`${file}-wal`) ? statSync(`${file}-wal`).size : 0
    const changes = prepare('SELECT total_changes() AS n').get().n - before
    assert.equal(database.getHighestCommittedRemoteTaskEventSequenceForTask(owner.taskId), '121')
    assert.equal(prepare('SELECT count(*) AS n FROM task_events WHERE remote_semantic_sequence IS NOT NULL').get().n, 243)
    assert.equal(database.getConversation(owner.conversationId).messages.find(m => m.id === owner.assistantMessageId).content,
      seed + (scenario === 'text' ? 'next chunk\n'.repeat(120) : ''))
    database.close()
    const reopened = new DatabaseSync(file, { readOnly: true })
    try {
      assert.equal(reopened.prepare('SELECT count(*) AS n FROM task_events WHERE remote_semantic_sequence IS NOT NULL').get().n, 243)
      assert.equal(reopened.prepare('SELECT content FROM messages WHERE id = ?').get(owner.assistantMessageId).content,
        seed + (scenario === 'text' ? 'next chunk\n'.repeat(120) : ''))
      assert.equal(reopened.prepare("SELECT count(*) AS n FROM task_events WHERE kind = 'remote-semantic-checkpoint' AND remote_semantic_sequence = '121'").get().n, 1)
      assert.equal(reopened.prepare('PRAGMA integrity_check').get().integrity_check, 'ok')
    } finally { reopened.close() }
    samples.sort((a, b) => a - b)
    return { label, round, scenario, calls: 120, events: 240, commits, messageUpdates, changes,
      walBytes, walFrames: (walBytes - 32) / (pageSize + 24), synchronous: 2,
      p95Ms: +samples[113].toFixed(2), maxMs: +samples[119].toFixed(2) }
  } finally { database.close() }
}
try {
  const sources = process.argv[2] ? [['baseline', resolve(process.argv[2])], ['candidate', root]] : [['current', root]]
  const versions = sources.map(([label, source]) => {
    const outfile = join(directory, `${label}.cjs`)
    buildSync({ entryPoints: [join(source, 'src/main/assistant/assistant-database.ts')], outfile,
      bundle: true, platform: 'node', format: 'cjs', target: 'node22', external: ['electron'],
      nodePaths: [join(root, 'node_modules')], logLevel: 'error' })
    return [label, require(outfile).AssistantDatabase]
  })
  console.log(JSON.stringify({ node: process.version, platform: process.platform, arch: process.arch,
    cpu: os.cpus()[0].model, measurement: 'owner-local WAL emission; unpaced calls; no IPC/queue/device IO measurement' }))
  for (let round = 1; round <= 3; round++) {
    for (const [label, Database] of versions) {
      for (const scenario of ['text', 'status', 'metrics']) console.log(JSON.stringify(measure(Database, label, round, scenario)))
    }
  }
} finally {
  rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  // The shared parent may contain another benchmark run.
}

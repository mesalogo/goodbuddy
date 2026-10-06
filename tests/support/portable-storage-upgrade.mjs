// Run with Node 24+: node tests/support/portable-storage-upgrade.mjs --launch
// --resume reuses an interrupted run's backup; --report prints aggregate evidence.
import assert from 'node:assert/strict'
import process from 'node:process'
import console from 'node:console'
import { Buffer } from 'node:buffer'
import { performance } from 'node:perf_hooks'
import { setTimeout, clearTimeout, setInterval, clearInterval } from 'node:timers'
import { createHash } from 'node:crypto'
import { createReadStream, openSync, closeSync } from 'node:fs'
import { cp, mkdir, readFile, readdir, rm, stat, unlink, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { DatabaseSync, backup } from 'node:sqlite'
import { spawn, execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { cpus, totalmem, platform, release } from 'node:os'
import { build } from 'esbuild'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const source = join(root, 'dist/GoodBuddy-windows-x64/data')
const temporary = join(root, 'temp/goodbuddy-storage-upgrade')
const run = join(temporary, process.argv.includes('--fresh') ? 'fresh-run' : 'run')
const resume = process.argv.includes('--resume')
if (process.argv.includes('--report')) {
  const result = JSON.parse(await readFile(join(temporary, 'summary.json'), 'utf8'))
  const canonicalContentUnchanged = result.comparison && Object.values(result.comparison).every(value => value.changed.length === 0)
  const databases = Object.fromEntries(Object.entries(result.metadata ?? {}).map(([name, metadata]) => [name, {
    sourceBytes: result.sourceBefore[name]?.bytes, sourceWalBytes: result.sourceBefore[name + '-wal']?.bytes,
    backupBytes: result.backup?.[name]?.file.bytes, workBytes: result.workFiles?.[name]?.bytes,
    versionBefore: metadata.version, versionAfter: result.after?.[name]?.version,
    freePagesBefore: metadata.freePages, freePagesAfter: result.after?.[name]?.freePages,
    tables: Object.fromEntries(Object.entries(metadata.tables).map(([table, entry]) => [table, entry.count])),
    snapshotBeforeMs: result.backup?.[name]?.snapshot.durationMs, snapshotAfterMs: result.after?.[name]?.durationMs,
    comparison: result.comparison?.[name], integrity: result.finalIntegrity?.[name]
  }]))
  console.log(JSON.stringify({ startedAt: result.startedAt, environment: result.environment,
    status: result.status, canonicalContentUnchanged, failure: result.failure, sourceUnchanged: result.sourceUnchanged, copiesRemoved: result.copiesRemoved,
    durationMs: result.durationMs, databases, initialization: result.initialization, exercise: result.exercise,
    attachments: result.attachments, notes: result.notesBefore, notesUnchanged: result.notesUnchanged }, null, 2))
  process.exit(0)
}
if (process.argv.includes('--launch')) {
  await mkdir(temporary, { recursive: true })
  const log = openSync(join(temporary, 'execution.log'), 'w')
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--supervise', ...process.argv.slice(2).filter(arg => arg !== '--launch')], { detached: true, stdio: ['ignore', log, log] })
  closeSync(log)
  child.unref()
  console.log(`Launched verification supervisor ${child.pid}`)
  process.exit(0)
}
if (process.argv.includes('--supervise')) {
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), ...process.argv.slice(2).filter(arg => arg !== '--supervise')], { stdio: 'inherit' })
  const timer = setTimeout(() => {
    console.log('Overall verification deadline exceeded')
    if (process.platform === 'win32') execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { timeout: 10_000, stdio: 'ignore' })
    else child.kill('SIGKILL')
  }, 900_000)
  child.once('error', () => { clearTimeout(timer); process.exit(1) })
  child.once('exit', code => { clearTimeout(timer); process.exit(code ?? 1) })
  await new Promise(() => {})
}
if (process.argv.includes('--cleanup-interrupted')) {
  console.log('Removing interrupted validation copies')
  for (const name of ['assistant.sqlite', 'assistant.sqlite-wal', 'assistant.sqlite-shm']) {
    try { await unlink(join(run, 'work', name)); console.log(`Removed ${name}`) }
    catch (error) { console.log(`Cleanup ${name}: ${error.code}`) }
  }
  await rm(run, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  console.log('Interrupted validation copies removed')
  process.exit(0)
}
const names = ['assistant.sqlite', 'knowledge.sqlite', 'conversation-attachments.sqlite', 'remote-runtime-bindings.sqlite']
const quote = value => `"${value.replaceAll('"', '""')}"`
const hash = value => createHash('sha256').update(value).digest('hex')
const canonical = value => JSON.stringify(value, (_key, item) => typeof item === 'bigint' ? String(item) : item instanceof Uint8Array ? Buffer.from(item).toString('base64') : item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item)
async function fingerprint(path) {
  const info = await stat(path).catch(error => { if (error.code !== 'ENOENT') throw error })
  if (!info) return null
  const digest = createHash('sha256')
  for await (const chunk of createReadStream(path)) digest.update(chunk)
  return { bytes: info.size, mtimeMs: info.mtimeMs, sha256: digest.digest('hex') }
}
async function sourceFingerprint() {
  return Object.fromEntries(await Promise.all(names.flatMap(name => ['', '-wal', '-shm'].map(async suffix => [name + suffix, await fingerprint(join(source, name + suffix))]))))
}
async function contentFingerprint(directory) {
  const entries = []
  async function visit(path, relative) {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      assert.ok(!entry.isSymbolicLink(), 'file-backed content must be isolated')
      const name = join(relative, entry.name)
      if (entry.isDirectory()) await visit(join(path, entry.name), name)
      else {
        const file = await fingerprint(join(path, entry.name))
        entries.push({ name, bytes: file.bytes, sha256: file.sha256 })
      }
    }
  }
  await visit(directory, '')
  return { files: entries.length, bytes: entries.reduce((sum, file) => sum + file.bytes, 0), sha256: hash(canonical(entries.sort((a, b) => a.name.localeCompare(b.name)))) }
}
function inspect(path) {
  const db = new DatabaseSync(path, { readOnly: true })
  try {
    db.exec('BEGIN')
    const tables = {}
    for (const { name } of db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all()) {
      const columns = db.prepare(`PRAGMA table_info(${quote(name)})`).all().map(column => column.name)
      tables[name] = { count: db.prepare(`SELECT COUNT(*) AS n FROM ${quote(name)}`).get().n, columns }
    }
    return { version: db.prepare('PRAGMA user_version').get().user_version,
      pageCount: db.prepare('PRAGMA page_count').get().page_count, pageSize: db.prepare('PRAGMA page_size').get().page_size,
      freePages: db.prepare('PRAGMA freelist_count').get().freelist_count, tables }
  } finally { db.close() }
}

// Hash every existing table/column, including IDs, order columns, provenance and references.
// Sorting row digests makes physical SQLite row order irrelevant without retaining bodies.
function snapshot(path, restoreSubagentPayload) {
  const started = performance.now()
  const blockDigests = new WeakMap()
  const progressDigests = new WeakMap()
  const db = new DatabaseSync(path, { readOnly: true })
  try {
    db.exec('BEGIN')
    assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok', 'integrity check failed')
    const metadata = inspect(path)
    const tables = {}
    for (const [name, table] of Object.entries(metadata.tables)) {
      console.log(`Hashing ${name}: ${table.count} rows`)
      const rows = []
      let previousTask, blocks = new Map()
      const order = name === 'task_events' ? ' ORDER BY task_id, id' : ''
      for (const row of db.prepare(`SELECT * FROM ${quote(name)}${order}`).iterate()) {
        if (name === 'task_events' && row.kind === 'subagent') {
          if (previousTask !== row.task_id) { blocks = new Map(); previousTask = row.task_id }
          const restored = restoreSubagentPayload(JSON.parse(row.payload_json), blocks)
          if (Array.isArray(restored?.progress)) {
            // Production restoration shares unchanged immutable blocks. Hash their
            // canonical content once, preserving the full ordered progress digest.
            let progressDigest = progressDigests.get(restored.progress)
            if (!progressDigest) {
              progressDigest = hash(restored.progress.map(block => {
                let digest = blockDigests.get(block)
                if (!digest) { digest = hash(canonical(block)); blockDigests.set(block, digest) }
                return digest
              }).join('\n'))
              progressDigests.set(restored.progress, progressDigest)
            }
            row.payload_json = canonical({ ...restored, progress: { count: restored.progress.length, sha256: progressDigest } })
          } else row.payload_json = canonical(restored)
        }
        rows.push(hash(canonical(row)))
        if (rows.length % 100_000 === 0) {
          console.log(`Hashed ${name}: ${rows.length}/${table.count}`)
          assert.ok(performance.now() - started < 600_000, 'snapshot deadline exceeded')
        }
      }
      tables[name] = { count: table.count, sha256: hash(rows.sort().join('\n')) }
    }
    const violations = db.prepare('PRAGMA foreign_key_check').all()
    return { ...metadata, tables, durationMs: performance.now() - started, integrity: 'ok', foreignKeyViolations: violations.length,
      foreignKeyDigest: hash(canonical(violations)) }
  } finally { db.close() }
}

if (process.argv.includes('--verify-source')) {
  const result = JSON.parse(await readFile(join(temporary, 'summary.json'), 'utf8'))
  assert.equal(canonical(await sourceFingerprint()), canonical(result.sourceBefore), 'original database files changed')
  if (result.notesBefore) assert.deepEqual(await contentFingerprint(join(source, 'notes')), result.notesBefore, 'original notes changed')
  assert.ok(Object.values(result.comparison).every(value => value.changed.length === 0))
  console.log('Original DB/WAL/SHM fingerprints and notes still match; saved canonical comparisons have no changed tables')
  process.exit(0)
}

const summary = { startedAt: new Date().toISOString(), externalModelCalls: 0,
  environment: { platform: platform(), release: release(), cpu: cpus()[0]?.model, memoryBytes: totalmem(), node: process.version,
    commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', timeout: 10_000 }).trim(), dirtyWorktree: true },
  caveat: 'Per-database read-only SQLite online backup includes committed WAL. Sequential databases/files are not a cross-database transaction. Live application writes may change fingerprints; no source checkpoint or initialization is performed.' }
let before
let ownsRun = false
try {
  console.log('Fingerprinting original database files')
  await mkdir(temporary, { recursive: true })
  before = await sourceFingerprint()
  summary.sourceBefore = before
  await writeFile(join(temporary, 'source-before.json'), JSON.stringify(before, null, 2))
  console.log('Inspecting database metadata')
  if (resume) summary.metadata = Object.fromEntries(names.map(name => [name, inspect(join(run, 'backup', name))]))
  if (process.argv.includes('--inspect')) {
    console.log(JSON.stringify(summary, null, 2))
  } else {
    // Never remove a previous run implicitly: it may belong to another validator.
    if (!resume) await mkdir(run)
    ownsRun = true
    if (!resume) await mkdir(join(run, 'backup'))
    if (resume) await rm(join(run, 'work'), { recursive: true, force: true })
    await mkdir(join(run, 'work'))
    for (const name of names) {
      console.log(`${resume ? 'Reusing backup' : 'Backing up'} ${name}`)
      if (!resume) {
        // Capture main + WAL without letting SQLite touch the original SHM. Require
        // stable source fingerprints across capture before using the online backup.
        await mkdir(join(run, 'capture'), { recursive: true })
        await cp(join(source, name), join(run, 'capture', name))
        if (before[name + '-wal']) await cp(join(source, name + '-wal'), join(run, 'capture', name + '-wal'))
        assert.deepEqual(await fingerprint(join(source, name)), before[name], 'source changed during capture')
        assert.deepEqual(await fingerprint(join(source, name + '-wal')), before[name + '-wal'], 'WAL changed during capture')
        const db = new DatabaseSync(join(run, 'capture', name), { readOnly: true })
        try { await backup(db, join(run, 'backup', name)) } finally { db.close() }
      }
      await cp(join(run, 'backup', name), join(run, 'work', name))
    }
    summary.metadata = Object.fromEntries(names.map(name => [name, inspect(join(run, 'backup', name))]))
    assert.ok(summary.metadata['assistant.sqlite'].tables.messages.count > 0, 'real messages required')
    // Notes use relative file-backed content. No settings/credential files are copied.
    if (await stat(join(source, 'notes')).catch(() => undefined)) {
      summary.notesBefore = await contentFingerprint(join(source, 'notes'))
      await cp(join(source, 'notes'), join(run, 'work/notes'), { recursive: true })
      assert.deepEqual(await contentFingerprint(join(run, 'work/notes')), summary.notesBefore, 'note copy differs')
    }
    const assets = new DatabaseSync(join(run, 'backup/conversation-attachments.sqlite'), { readOnly: true })
    summary.attachments = { referenced: 0, copied: 0, missing: 0, outsideRoot: 0, verifiedBytes: 0 }
    const attachmentFiles = []
    try {
      for (const row of assets.prepare('SELECT path FROM attachments').iterate()) {
        summary.attachments.referenced++
        const relative = row.path.replaceAll('\\', '/')
        const from = resolve(source, relative)
        if (!from.startsWith(source + '/'.replace('/', process.platform === 'win32' ? '\\' : '/'))) { summary.attachments.outsideRoot++; continue }
        const info = await stat(from).catch(() => undefined)
        if (!info) { summary.attachments.missing++; continue }
        await cp(from, join(run, 'work', relative), { recursive: true })
        const directory = info.isDirectory()
        const file = await (directory ? contentFingerprint(from) : fingerprint(from))
        assert.equal((await (directory ? contentFingerprint(join(run, 'work', relative)) : fingerprint(join(run, 'work', relative)))).sha256, file.sha256, 'attachment copy differs')
        attachmentFiles.push({ relative, file, directory })
        summary.attachments.verifiedBytes += file.bytes
        summary.attachments.copied++
      }
    } finally { assets.close() }
    for (const [entry, output, format] of [
      ['src/main/desktop-storage-entry.ts', 'desktop-storage-entry.mjs', 'esm'],
      ['src/main/readonly-query-worker.ts', 'readonly-query-worker.cjs', 'cjs'],
      ['src/main/assistant-storage-worker.ts', 'assistant-storage-worker.cjs', 'cjs'],
      ['src/main/assistant/subagent-progress-storage.ts', 'canonical.mjs', 'esm'],
      ['tests/support/portable-storage-upgrade-fixture.ts', 'main.mjs', 'esm']
    ]) await build({ entryPoints: [join(root, entry)], outfile: join(run, output), bundle: true, platform: 'node', format,
      external: ['electron', '@napi-rs/canvas'], logLevel: 'silent' })
    const { restoreSubagentPayload } = await import(pathToFileURL(join(run, 'canonical.mjs')).href)
    summary.backup = Object.fromEntries(await Promise.all(names.map(async name => [name, { file: await fingerprint(join(run, 'backup', name)), snapshot: snapshot(join(run, 'backup', name), restoreSubagentPayload) }])))
    await writeFile(join(temporary, 'summary.json'), JSON.stringify(summary, null, 2))
    const env = { ...process.env, GB_PORTABLE_UPGRADE_ROOT: run, TEMP: run, TMP: run, TMPDIR: run }
    delete env.ELECTRON_RUN_AS_NODE
    async function fixture(phase) {
      console.log(`Production fixture: ${phase}`)
      await rm(join(run, 'fixture-summary.json'), { force: true })
      const child = spawn(createRequire(import.meta.url)('electron'), [join(run, 'main.mjs')], { env: { ...env, GB_PORTABLE_UPGRADE_PHASE: phase }, stdio: 'ignore' })
      let timedOut = false
      const timer = setTimeout(() => {
        timedOut = true
        if (process.platform === 'win32') execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { timeout: 10_000, stdio: 'ignore' })
        else child.kill('SIGKILL')
      }, 180_000)
      const progress = setInterval(() => {
        void readFile(join(run, 'fixture-summary.json'), 'utf8').then(text => console.log(`Fixture stage: ${JSON.parse(text).stage}`)).catch(() => {})
      }, 10_000)
      const code = await new Promise((resolveExit, reject) => { child.once('exit', resolveExit); child.once('error', reject) }).finally(() => { clearTimeout(timer); clearInterval(progress) })
      const result = JSON.parse(await readFile(join(run, 'fixture-summary.json'), 'utf8'))
      summary.fixture = result
      assert.equal(timedOut, false, 'production fixture deadline exceeded')
      assert.equal(code, 0, 'production fixture failed; see sanitized stage')
      return result
    }
    summary.initialization = await fixture('initialize')
    summary.after = Object.fromEntries(names.map(name => [name, snapshot(join(run, 'work', name), restoreSubagentPayload)]))
    summary.comparison = {}
    for (const name of names) {
      const original = summary.backup[name].snapshot
      const current = summary.after[name]
      summary.comparison[name] = { unchanged: [], changed: [], added: Object.keys(current.tables).filter(table => !original.tables[table]) }
      for (const [table, value] of Object.entries(original.tables)) {
        summary.comparison[name][canonical(value) === canonical(current.tables[table]) ? 'unchanged' : 'changed'].push(table)
      }
      assert.equal((await fingerprint(join(run, 'backup', name))).sha256, summary.backup[name].file.sha256, 'backup changed')
      assert.equal(current.foreignKeyDigest, original.foreignKeyDigest, 'foreign key violations changed')
      assert.equal(summary.comparison[name].changed.length, 0, 'existing content changed; review startup recovery before accepting')
    }
    summary.exercise = await fixture('exercise')
    summary.finalIntegrity = {}
    for (const name of names) {
      const db = new DatabaseSync(join(run, 'work', name), { readOnly: true })
      try {
        const integrity = db.prepare('PRAGMA integrity_check').get().integrity_check
        const violations = db.prepare('PRAGMA foreign_key_check').all()
        assert.equal(integrity, 'ok')
        assert.equal(hash(canonical(violations)), summary.backup[name].snapshot.foreignKeyDigest)
        summary.finalIntegrity[name] = { integrity, foreignKeyViolations: violations.length }
      } finally { db.close() }
    }
    for (const { relative, file, directory } of attachmentFiles) {
      const read = directory ? contentFingerprint : fingerprint
      assert.deepEqual(await read(join(source, relative)), file, 'original attachment changed')
      assert.equal((await read(join(run, 'work', relative)))?.sha256, file.sha256, 'work attachment changed')
    }
    summary.attachments.unchangedAfter = true
    if (summary.notesBefore) {
      assert.deepEqual(await contentFingerprint(join(source, 'notes')), summary.notesBefore, 'original notes changed')
      assert.deepEqual(await contentFingerprint(join(run, 'work/notes')), summary.notesBefore, 'work notes changed')
      summary.notesUnchanged = true
    }
    summary.workFiles = Object.fromEntries(await Promise.all(names.map(async name => [name, await fingerprint(join(run, 'work', name))])))
    summary.status = 'passed'
  }
} catch (error) {
  summary.status = 'failed'
  // Error messages, stacks and assertions can contain private row data or paths.
  summary.failure = { name: error?.name, code: error?.code, stage: summary.fixture?.stage ?? (summary.backup ? 'validation' : 'backup/setup') }
  process.exitCode = 1
} finally {
  if (before) {
    summary.sourceAfter = await sourceFingerprint()
    summary.sourceUnchanged = canonical(before) === canonical(summary.sourceAfter)
    if (!summary.sourceUnchanged) { summary.status = 'failed: source fingerprints changed'; process.exitCode = 1 }
  }
  if (!process.argv.includes('--inspect')) {
    if (ownsRun) await rm(run, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
    summary.copiesRemoved = ownsRun
    summary.durationMs = Date.now() - Date.parse(summary.startedAt)
    summary.reusedBackup = resume
    await writeFile(join(temporary, 'summary.json'), JSON.stringify(summary, null, 2))
    console.log(JSON.stringify({ status: summary.status, failure: summary.failure, sourceUnchanged: summary.sourceUnchanged, copiesRemoved: summary.copiesRemoved }))
  }
}

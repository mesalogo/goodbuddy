// Owner-local knowledge/read-worker microbenchmark (PERF-05), not a Main IPC probe.
// Bundles the production
// KnowledgeDatabase with esbuild, seeds synthetic libraries of increasing size
// in a temporary SQLite file and times the synchronous search calls that the
// storage owner runs during retrieval. Synchronous duration measures this harness's
// event loop, not the Electron Main process of the application.
const { buildSync } = require('esbuild')
const { createHash } = require('node:crypto')
const { mkdtempSync, rmSync, writeFileSync, mkdirSync } = require('node:fs')
const { join, resolve } = require('node:path')
const { monitorEventLoopDelay, performance } = require('node:perf_hooks')

const root = resolve(__dirname, '..')

// Measure on the project's Electron (the production runtime). Older runtimes
// (Node 24.18 / Electron 43) stall worker threads for hundreds of ms on many
// small ArrayBuffer allocations (SQLite BLOB rows); GB_KPERF_NODE=1 opts out.
if (process.env.GB_KPERF_NODE !== '1') {
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
const sizes = (process.env.GB_KPERF_SIZES || '5000,20000,50000').split(',').map(Number)
const dimensions = Number(process.env.GB_KPERF_DIMENSIONS || 384)
const chunksPerDocument = 100
const queries = Number(process.env.GB_KPERF_QUERIES || 15)

const temporaryRoot = join(root, 'temp', 'goodbuddy-storage-foundation')
mkdirSync(temporaryRoot, { recursive: true })
const directory = mkdtempSync(join(temporaryRoot, 'knowledge-perf-'))
const bundle = join(directory, 'knowledge-database.cjs')
const workerBundle = join(directory, 'readonly-query-worker.cjs')
const readerBundle = join(directory, 'readonly-query-reader.cjs')
for (const [entry, outfile] of [
  ['src/main/knowledge/knowledge-database.ts', bundle],
  ['src/main/readonly-query-worker.ts', workerBundle],
  ['src/main/readonly-query-reader.ts', readerBundle]
]) {
  buildSync({
    entryPoints: [join(root, entry)],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    outfile,
    logLevel: 'error',
    // The worker reuses AssistantDatabase, which imports Electron-only modules lazily.
    external: ['electron']
  })
}
const { KnowledgeDatabase } = require(bundle)
const { ReadonlyQueryReader } = require(readerBundle)
const ownedDatabases = new Set(), readers = new Set()

// Deterministic pseudo-random generator so runs are comparable.
let seed = 42
const random = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296)
const words = 'lighthouse harbor policy engine renderer stream vector index budget latency schedule archive network storage contract invoice release window memory review'.split(' ')
const sentence = n => Array.from({ length: n }, () => words[Math.floor(random() * words.length)]).join(' ')
const vector = () => Array.from({ length: dimensions }, () => random() * 2 - 1)
const checksum = value => createHash('sha256').update(value).digest('hex')

function percentile(values, p) {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))]
}
function time(body) {
  const samples = []
  body() // warm statement cache and page cache
  for (let index = 0; index < queries; index += 1) {
    const started = performance.now()
    body()
    samples.push(performance.now() - started)
  }
  return { p50: round(percentile(samples, 50)), p95: round(percentile(samples, 95)), max: round(Math.max(...samples)) }
}
const round = value => Math.round(value * 10) / 10

// Harness event-loop delay while `queries` searches run back to back. A sync
// search blocks the loop for its whole duration; a worker search should not.
async function loopDelay(body) {
  const histogram = monitorEventLoopDelay({ resolution: 5 })
  await body() // warm worker / caches outside the measurement
  // Let the warm-up's blocked interval drain before sampling.
  await new Promise(resolve => setTimeout(resolve, 50))
  histogram.enable()
  const started = performance.now()
  for (let index = 0; index < queries; index += 1) {
    await body()
    // Yield like a real IPC handler, so the histogram samples between queries.
    await new Promise(resolve => setImmediate(resolve))
  }
  const wallMs = performance.now() - started
  await new Promise(resolve => setTimeout(resolve, 20))
  histogram.disable()
  const ms = value => round(value / 1e6)
  return { p50: ms(histogram.percentile(50)), p99: ms(histogram.percentile(99)), max: ms(histogram.max), perQueryMs: round(wallMs / queries) }
}

const results = []
async function main() {
  console.log(`[kperf] runtime: node ${process.version}${process.versions.electron ? ` (electron ${process.versions.electron})` : ''}`)
  for (const size of sizes) {
    const path = join(directory, `knowledge-${size}.sqlite`)
    const database = new KnowledgeDatabase(path)
    ownedDatabases.add(database)
    database.initialize()
    const library = database.createKnowledgeBase({ name: `Perf ${size}`, storageMode: 'reference' })
    const sqlite = database.database
    const seedStarted = performance.now()
    for (let documentIndex = 0; documentIndex < size / chunksPerDocument; documentIndex += 1) {
      const source = database.upsertSource({ knowledgeBaseId: library.id, type: 'file', location: `C:\\perf\\doc-${documentIndex}.md`, displayName: `doc-${documentIndex}.md`, status: 'ready' })
      const chunks = Array.from({ length: chunksPerDocument }, (_, ordinal) => ({ id: `d${documentIndex}-c${ordinal}`, ordinal, content: sentence(80), location: `line ${ordinal + 1}` }))
      const document = database.upsertDocument({ knowledgeBaseId: library.id, sourceId: source.id, externalId: `doc-${documentIndex}`, title: `doc-${documentIndex}`, sourceLocation: source.location }, chunks)
      const stored = sqlite.prepare("SELECT id, index_content FROM chunks WHERE document_id = ? AND enabled = 1 AND role <> 'parent'").all(document.id)
      database.replaceDocumentEmbeddings(document.id, 'perf', 'perf-model', stored.map(row => ({ chunkId: row.id, contentChecksum: checksum(row.index_content), vector: vector() })))
    }
    const seedMs = performance.now() - seedStarted
    database.close()

    // Reopen so timings start from a fresh connection, like an app restart.
    const reopened = new KnowledgeDatabase(path)
    ownedDatabases.add(reopened)
    reopened.initialize()
    const query = vector()
    const entry = {
      chunks: size,
      dimensions,
      seedSeconds: round(seedMs / 1000),
      ftsMs: time(() => reopened.search({ knowledgeBaseId: library.id, query: 'lighthouse budget', limit: 40 })),
      vectorMs: time(() => reopened.vectorSearch({ knowledgeBaseId: library.id, provider: 'perf', model: 'perf-model', vector: query, limit: 40 })),
      hybridMs: time(() => reopened.hybridSearchWithDiagnostics(hybridOptions(library.id, query)))
    }
    // Harness loop delay: owner-local synchronous search vs its explicit read worker.
    entry.mainLoopDelaySyncMs = await loopDelay(async () => reopened.hybridSearchWithDiagnostics(hybridOptions(library.id, query)))
    const reader = new ReadonlyQueryReader('knowledge', path, workerBundle)
    readers.add(reader)
    entry.mainLoopDelayWorkerMs = await loopDelay(() => reader.call('hybridSearchWithDiagnostics', [hybridOptions(library.id, query)]))
    await reader.close()
    reopened.close()
    results.push(entry)
    console.log(`[kperf] ${size} chunks: fts p95 ${entry.ftsMs.p95} ms, vector p95 ${entry.vectorMs.p95} ms, hybrid p95 ${entry.hybridMs.p95} ms (seed ${entry.seedSeconds} s)`)
    console.log(`[kperf] ${size} chunks: Main loop delay max sync ${entry.mainLoopDelaySyncMs.max} ms vs worker ${entry.mainLoopDelayWorkerMs.max} ms (p99 ${entry.mainLoopDelaySyncMs.p99} / ${entry.mainLoopDelayWorkerMs.p99} ms; per query ${entry.mainLoopDelaySyncMs.perQueryMs} / ${entry.mainLoopDelayWorkerMs.perQueryMs} ms)`)
  }
  const output = process.env.GB_KPERF_OUTPUT
  if (output) writeFileSync(output, JSON.stringify({ kind: 'goodbuddy-knowledge-retrieval-benchmark', executionBoundary: 'owner-local', node: process.version, results }, null, 2))
  console.table(results.map(r => ({ chunks: r.chunks, 'fts p50/p95': `${r.ftsMs.p50} / ${r.ftsMs.p95}`, 'vector p50/p95': `${r.vectorMs.p50} / ${r.vectorMs.p95}`, 'hybrid p50/p95': `${r.hybridMs.p50} / ${r.hybridMs.p95}`, 'loop max sync/worker': `${r.mainLoopDelaySyncMs.max} / ${r.mainLoopDelayWorkerMs.max}` })))
}
const hybridOptions = (knowledgeBaseId, vector) => ({ knowledgeBaseId, query: 'lighthouse budget', limit: 40, provider: 'perf', model: 'perf-model', vector, graphEnabled: false, candidateMultiplier: 1 })
main().catch(error => { process.exitCode = 1; console.error(error) }).finally(async () => {
  await Promise.all([...readers].map(reader => reader.close()))
  for (const database of ownedDatabases) database.close()
  rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
})

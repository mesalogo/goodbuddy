// Knowledge retrieval benchmark (PERF-05). Bundles the production
// KnowledgeDatabase with esbuild, seeds synthetic libraries of increasing size
// in a temporary SQLite file and times the synchronous search calls that the
// Electron Main process runs inline during retrieval. Because these calls are
// synchronous, their duration is the time Main is blocked per query.
const { buildSync } = require('esbuild')
const { createHash } = require('node:crypto')
const { mkdtempSync, rmSync, writeFileSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join, resolve } = require('node:path')
const { performance } = require('node:perf_hooks')

const root = resolve(__dirname, '..')
const sizes = (process.env.GB_KPERF_SIZES || '5000,20000,50000').split(',').map(Number)
const dimensions = Number(process.env.GB_KPERF_DIMENSIONS || 384)
const chunksPerDocument = 100
const queries = Number(process.env.GB_KPERF_QUERIES || 15)

const directory = mkdtempSync(join(tmpdir(), 'goodbuddy-knowledge-perf-'))
const bundle = join(directory, 'knowledge-database.cjs')
buildSync({
  entryPoints: [join(root, 'src/main/knowledge/knowledge-database.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  outfile: bundle,
  logLevel: 'error'
})
const { KnowledgeDatabase } = require(bundle)

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

const results = []
try {
  for (const size of sizes) {
    const path = join(directory, `knowledge-${size}.sqlite`)
    const database = new KnowledgeDatabase(path)
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
    reopened.initialize()
    const query = vector()
    const entry = {
      chunks: size,
      dimensions,
      seedSeconds: round(seedMs / 1000),
      ftsMs: time(() => reopened.search({ knowledgeBaseId: library.id, query: 'lighthouse budget', limit: 40 })),
      vectorMs: time(() => reopened.vectorSearch({ knowledgeBaseId: library.id, provider: 'perf', model: 'perf-model', vector: query, limit: 40 })),
      hybridMs: time(() => reopened.hybridSearchWithDiagnostics({ knowledgeBaseId: library.id, query: 'lighthouse budget', limit: 40, provider: 'perf', model: 'perf-model', vector: query, graphEnabled: false, candidateMultiplier: 1 }))
    }
    reopened.close()
    results.push(entry)
    console.log(`[kperf] ${size} chunks: fts p95 ${entry.ftsMs.p95} ms, vector p95 ${entry.vectorMs.p95} ms, hybrid p95 ${entry.hybridMs.p95} ms (seed ${entry.seedSeconds} s)`)
  }
  const output = process.env.GB_KPERF_OUTPUT
  if (output) writeFileSync(output, JSON.stringify({ kind: 'goodbuddy-knowledge-retrieval-benchmark', node: process.version, results }, null, 2))
  console.table(results.map(r => ({ chunks: r.chunks, 'fts p50/p95': `${r.ftsMs.p50} / ${r.ftsMs.p95}`, 'vector p50/p95': `${r.vectorMs.p50} / ${r.vectorMs.p95}`, 'hybrid p50/p95': `${r.hybridMs.p50} / ${r.hybridMs.p95}` })))
} finally {
  rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
}

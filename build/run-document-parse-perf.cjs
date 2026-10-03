// Document parse benchmark (PERF-15/16, P7). Bundles the production parser
// client and worker with esbuild, then imports synthetic large documents
// (hash -> parse -> chunk, as Knowledge import does) twice per round: inline on
// the main thread, then through the parse worker. Records the main event-loop
// max block with perf_hooks.monitorEventLoopDelay.
//
//   node build/run-document-parse-perf.cjs
//   GB_DOCPERF_ROUNDS=3 GB_DOCPERF_NODE=1 (skip Electron) GB_DOCPERF_OUTPUT=file.json
const { buildSync } = require('esbuild')
const { mkdirSync, rmSync, writeFileSync } = require('node:fs')
const { join, resolve } = require('node:path')
const { monitorEventLoopDelay, performance } = require('node:perf_hooks')

const root = resolve(__dirname, '..')

// Measure on the project's Electron (the production runtime), like perf:knowledge.
if (process.env.GB_DOCPERF_NODE !== '1') {
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

const rounds = Number(process.env.GB_DOCPERF_ROUNDS || 3)
// Under node_modules so the external pdfjs-dist resolves from the repository.
const directory = join(root, 'node_modules', '.cache', `goodbuddy-document-parse-perf-${process.pid}`)
mkdirSync(directory, { recursive: true })
const harness = join(directory, 'harness.cjs')
const workerBundle = join(directory, 'document-parse-worker.cjs')
const harnessSource = join(directory, 'harness.ts')
writeFileSync(harnessSource, [
  `export * from ${JSON.stringify(join(root, 'src/main/document-parse-client.ts'))}`,
  `export * from ${JSON.stringify(join(root, 'tests/support/document-parse-worker-fixture.ts'))}`
].join('\n'))
for (const [entry, outfile] of [[harnessSource, harness], [join(root, 'src/main/document-parse-worker.ts'), workerBundle]]) {
  buildSync({
    entryPoints: [entry], bundle: true, platform: 'node', format: 'cjs', target: 'node22',
    outfile, logLevel: 'error', external: ['pdfjs-dist', 'electron', 'esbuild']
  })
}
const {
  DocumentParseWorkerClient, chunkDocumentOffMain, parseDocumentOffMain, sha256OffMain,
  createDocx, createLargePdf, sentenceGenerator
} = require(harness)

const settings = {
  version: 1, mode: 'structure', targetCharacters: 1600, overlapCharacters: 100,
  parentCharacters: 1600, childCharacters: 400, contextualIndexingEnabled: false
}
const round = value => Math.round(value * 10) / 10

async function importOnce(name, buffer, client) {
  await sha256OffMain(buffer, client)
  const parsed = await parseDocumentOffMain(name, buffer, undefined, client)
  return (await chunkDocumentOffMain(parsed, settings, client)).length
}

async function measure(name, buffer, client) {
  await importOnce(name, buffer, client) // warm modules / worker
  await new Promise(resolve => setTimeout(resolve, 50))
  const histogram = monitorEventLoopDelay({ resolution: 5 })
  histogram.enable()
  // The histogram only measures from its first timer tick on; a block that
  // starts before that tick (the inline path is all microtasks) is not seen.
  await new Promise(resolve => setTimeout(resolve, 30))
  const started = performance.now()
  const chunks = await importOnce(name, buffer, client)
  const wallMs = performance.now() - started
  await new Promise(resolve => setTimeout(resolve, 20))
  histogram.disable()
  return { maxMs: round(histogram.max / 1e6), p99Ms: round(histogram.percentile(99) / 1e6), wallMs: round(wallMs), chunks }
}

async function main() {
  console.log(`[docperf] runtime: node ${process.version}${process.versions.electron ? ` (electron ${process.versions.electron})` : ''}`)
  const sentence = sentenceGenerator(11)
  const inputs = [
    { name: 'large.pdf', buffer: createLargePdf(500, 60) },
    { name: 'large.docx', buffer: createDocx(Array.from({ length: 4000 }, () => sentence(25))) },
    { name: 'large.md', buffer: Buffer.from(Array.from({ length: 4000 }, (_, index) => `${index % 50 === 0 ? '## Section\n' : ''}${sentence(60)}.`).join('\n')) }
  ]
  const client = new DocumentParseWorkerClient(workerBundle)
  const results = []
  try {
    for (const input of inputs) {
      for (let index = 0; index < rounds; index += 1) {
        // Alternate inline / worker within each round (P7).
        const inline = await measure(input.name, input.buffer, undefined)
        const worker = await measure(input.name, input.buffer, client)
        if (worker.chunks !== inline.chunks) throw new Error(`chunk count mismatch for ${input.name}`)
        results.push({ input: input.name, bytes: input.buffer.byteLength, round: index + 1, inline, worker })
        console.log(`[docperf] ${input.name} round ${index + 1}: Main loop max ${inline.maxMs} -> ${worker.maxMs} ms; wall ${inline.wallMs} / ${worker.wallMs} ms; ${inline.chunks} chunks`)
      }
    }
  } finally {
    client.close()
  }
  const output = process.env.GB_DOCPERF_OUTPUT
  if (output) writeFileSync(output, JSON.stringify({ kind: 'goodbuddy-document-parse-benchmark', node: process.version, results }, null, 2))
  console.table(results.map(r => ({ input: r.input, round: r.round, 'loop max inline/worker ms': `${r.inline.maxMs} / ${r.worker.maxMs}`, 'wall inline/worker ms': `${r.inline.wallMs} / ${r.worker.wallMs}` })))
}
main().catch(error => { process.exitCode = 1; console.error(error) }).finally(() => {
  rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
})

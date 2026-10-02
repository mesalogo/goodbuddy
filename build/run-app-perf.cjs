// Full-App interaction benchmark supervisor (PERF-11).
// Starts a loopback fake OpenAI-compatible model on 127.0.0.1:11434 (the
// fresh-profile default model endpoint), launches the current production
// build in an isolated profile through tests/support/app-perf-driver.mjs,
// enforces a total deadline and prints a summary of the driver report.
const { spawn } = require('node:child_process')
const { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = require('node:fs')
const { createServer } = require('node:http')
const { tmpdir } = require('node:os')
const { join, resolve } = require('node:path')

const root = resolve(__dirname, '..')
const modelPort = 11434
const totalTimeoutMs = Number(process.env.GB_PERF_TIMEOUT_MS || 600_000)
const keepProfile = process.env.GB_PERF_KEEP_PROFILE === '1'
const streamBytes = Number(process.env.GB_PERF_STREAM_BYTES || 40_000)
const chunkChars = Number(process.env.GB_PERF_CHUNK_CHARS || 12)
const streamCharsPerSecond = Number(process.env.GB_PERF_STREAM_CPS || 2_000)
const tickIntervalMs = 10

function buildAnswer(targetBytes) {
  const blocks = [
    '## Section {n}\n\nThis paragraph explains the {n}th step of the benchmark answer with **bold**, `inline code`, and a [link](https://example.com/{n}).\n\n',
    '- First item for block {n}\n- Second item with *emphasis*\n  - Nested item {n}\n- Third item\n\n',
    '```ts\nexport function step{n}(input: number): number {\n  const value = input * {n}\n  return value + 1\n}\n```\n\n',
    '| Column | Value {n} | Notes |\n| --- | --- | --- |\n| alpha | {n} | first |\n| beta | {n}1 | second |\n\n',
    // Single-line display math is common in model output. GB_PERF_CORPUS=multiline-math
    // puts the delimiters on their own lines instead.
    process.env.GB_PERF_CORPUS === 'multiline-math'
      ? 'Inline math $a_{n} = b^2 + c$ and display math:\n\n$$\n\\sum_{i=1}^{{n}} i = \\frac{{n}({n}+1)}{2}\n$$\n\n'
      : 'Inline math $a_{n} = b^2 + c$ and display math:\n\n$$\\sum_{i=1}^{{n}} i = \\frac{{n}({n}+1)}{2}$$\n\n',
    '> Quoted note {n}: keep the streaming renderer honest with mixed blocks.\n\n'
  ]
  let text = ''
  let n = 1
  while (Buffer.byteLength(text) < targetBytes) {
    text += blocks[n % blocks.length].replaceAll('{n}', String(n))
    n += 1
  }
  return text
}

function startModelServer(ledger) {
  const answer = buildAnswer(streamBytes)
  const server = createServer((request, response) => {
    const started = Date.now()
    const entry = { method: request.method, path: request.url, startedAt: started }
    ledger.push(entry)
    if (request.method === 'GET' && request.url?.endsWith('/models')) {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ object: 'list', data: [{ id: 'qwen3', object: 'model' }] }))
      return
    }
    if (request.method !== 'POST' || !request.url?.endsWith('/chat/completions')) {
      response.writeHead(404).end()
      return
    }
    let body = ''
    request.on('data', chunk => { body += chunk })
    request.on('end', () => {
      let parsed = {}
      try { parsed = JSON.parse(body) } catch { /* counted below */ }
      const messages = Array.isArray(parsed.messages) ? parsed.messages : []
      const last = messages.at(-1)
      const lastText = typeof last?.content === 'string' ? last.content : JSON.stringify(last?.content ?? '')
      const benchmark = lastText.includes('perf-stream')
      entry.kind = benchmark ? 'benchmark-stream' : 'auxiliary'
      entry.stream = parsed.stream === true
      const content = benchmark ? answer : 'Benchmark title'
      if (!entry.stream) {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({
          id: 'perf', object: 'chat.completion', model: 'qwen3',
          choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content } }],
          usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 }
        }))
        entry.finishedAt = Date.now()
        return
      }
      response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
      const send = payload => response.write(`data: ${JSON.stringify(payload)}\n\n`)
      const delta = text => send({ id: 'perf', object: 'chat.completion.chunk', model: 'qwen3', choices: [{ index: 0, delta: { content: text }, finish_reason: null }] })
      send({ id: 'perf', object: 'chat.completion.chunk', model: 'qwen3', choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] })
      let offset = 0
      let chunks = 0
      const finish = () => {
        send({ id: 'perf', object: 'chat.completion.chunk', model: 'qwen3', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })
        send({ id: 'perf', object: 'chat.completion.chunk', model: 'qwen3', choices: [], usage: { prompt_tokens: 10, completion_tokens: Math.ceil(content.length / 4), total_tokens: 10 + Math.ceil(content.length / 4) } })
        response.write('data: [DONE]\n\n')
        response.end()
        entry.finishedAt = Date.now()
        entry.chunks = chunks
        entry.bytes = Buffer.byteLength(content)
      }
      if (!benchmark) { delta(content); finish(); return }
      // Emit at a fixed character rate, split into small SSE events like a
      // fast token stream. Pacing is time-based so coarse timers do not
      // change throughput.
      const streamStart = Date.now()
      const tick = () => {
        if (response.destroyed) { entry.aborted = true; return }
        const due = Math.min(content.length, Math.ceil(((Date.now() - streamStart) / 1000) * streamCharsPerSecond))
        while (offset < due) {
          delta(content.slice(offset, offset + chunkChars))
          offset += chunkChars
          chunks += 1
        }
        if (offset >= content.length) { finish(); return }
        setTimeout(tick, tickIntervalMs)
      }
      tick()
    })
  })
  return new Promise((resolvePromise, reject) => {
    server.once('error', reject)
    server.listen(modelPort, '127.0.0.1', () => resolvePromise(server))
  })
}

function format(value, digits = 1) {
  return value === null || value === undefined || Number.isNaN(value) ? '-' : Number(value).toFixed(digits)
}

function printSummary(report) {
  console.log(`\nGoodBuddy full-App benchmark (${report.status})`)
  console.log(`source ${report.source?.commit ?? '?'}${report.source?.dirty ? ' (dirty)' : ''}, Electron ${report.environment?.electron}, DPR ${report.environment?.devicePixelRatio}, ${report.environment?.cpu}`)
  if (report.startup) {
    console.log(`startup: window ${format(report.startup.windowCreatedMs, 0)} ms, ready-to-show ${format(report.startup.readyToShowMs, 0)} ms, composer ready ${format(report.startup.composerReadyMs, 0)} ms`)
  }
  const rows = (report.scenarios ?? []).map(s => ({
    scenario: s.id,
    ms: format(s.durationMs, 0),
    longTasks: `${s.renderer?.longTasks?.count ?? '-'} / ${format(s.renderer?.longTasks?.totalMs, 0)} / ${format(s.renderer?.longTasks?.maxMs, 0)}`,
    'frame p50/p95/max': `${format(s.renderer?.frames?.p50)} / ${format(s.renderer?.frames?.p95)} / ${format(s.renderer?.frames?.max, 0)}`,
    'jank%': format(s.renderer?.frames?.jankRatio * 100),
    'latency p50/p95/max': s.latency ? `${format(s.latency.p50)} / ${format(s.latency.p95)} / ${format(s.latency.max)}` : '-',
    'mainLag p99/max': `${format(s.main?.eventLoopDelay?.p99)} / ${format(s.main?.eventLoopDelay?.max)}`,
    'cpu% main/renderer/gpu': `${format(s.processes?.cpu?.Browser, 0)} / ${format(s.processes?.cpu?.Tab, 0)} / ${format(s.processes?.cpu?.GPU, 0)}`,
    domNodes: s.renderer?.domNodes ?? '-',
    heapMB: format(s.renderer?.heapUsedMB)
  }))
  if (rows.length) console.table(rows)
  if (report.error) console.log(`error: ${report.error}`)
}

async function main() {
  const required = ['out/main/index.js', 'out/preload/index.cjs', 'out/renderer/index.html']
  const missing = required.filter(file => !existsSync(join(root, file)))
  if (missing.length) throw new Error(`Missing production build (${missing.join(', ')}); run npm run build:bundle first`)
  const runDirectory = mkdtempSync(join(tmpdir(), 'goodbuddy-app-perf-'))
  const outputDirectory = resolve(process.env.GB_PERF_OUTPUT || join(runDirectory, 'artifacts'))
  mkdirSync(outputDirectory, { recursive: true })
  const ledger = []
  let server
  try {
    server = await startModelServer(ledger)
  } catch (error) {
    throw new Error(`Cannot listen on 127.0.0.1:${modelPort} for the fake model (${error.code ?? error.message}); stop the local service using that port and retry`, { cause: error })
  }
  const environment = { ...process.env, GB_PERF_DIRECTORY: runDirectory, GB_PERF_ARTIFACTS: outputDirectory, GB_PERF_ROOT: root }
  delete environment.ELECTRON_RUN_AS_NODE
  delete environment.ELECTRON_RENDERER_URL
  for (const key of ['GOODBUDDY_MODEL_API_KEY', 'GOODBUDDY_MODEL_BASE_URL', 'GOODBUDDY_MODEL_NAME', 'GOODBUDDY_BIGTOKEN_API_KEY', 'GOODBUDDY_BIGTOKEN_BASE_URL', 'GOODBUDDY_BIGTOKEN_MODEL']) delete environment[key]
  environment.GOODBUDDY_WORKSPACE = join(runDirectory, 'workspace')
  mkdirSync(environment.GOODBUDDY_WORKSPACE, { recursive: true })
  const started = Date.now()
  const child = spawn(require('electron'), [join(root, 'tests', 'support', 'app-perf-driver.mjs')], { cwd: root, env: environment, stdio: 'inherit', windowsHide: false })
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    if (process.platform === 'win32') spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
    else child.kill('SIGKILL')
  }, totalTimeoutMs)
  const exit = await new Promise(resolvePromise => child.once('exit', (code, signal) => resolvePromise({ code, signal })))
  clearTimeout(timer)
  await new Promise(resolvePromise => server.close(() => resolvePromise()))
  const resultPath = join(outputDirectory, 'result.json')
  let report
  if (existsSync(resultPath)) report = JSON.parse(readFileSync(resultPath, 'utf8'))
  else report = { status: 'failed', error: timedOut ? 'Supervisor timeout before report' : 'Driver exited without a report' }
  report.supervisor = { elapsedMs: Date.now() - started, timeoutMs: totalTimeoutMs, timedOut, exitCode: exit.code, signal: exit.signal }
  report.corpus = { kind: process.env.GB_PERF_CORPUS || 'single-line-math', bytes: streamBytes, charsPerSecond: streamCharsPerSecond, charsPerEvent: chunkChars }
  report.modelRequests = {
    boundary: 'loopback fake model only; no external requests',
    total: ledger.length,
    benchmarkStreams: ledger.filter(entry => entry.kind === 'benchmark-stream').length,
    auxiliary: ledger.filter(entry => entry.kind === 'auxiliary').length,
    ledger: ledger.map(({ method, path, kind, stream, chunks, bytes, aborted, startedAt, finishedAt }) => ({ method, path, kind, stream, chunks, bytes, aborted, durationMs: finishedAt ? finishedAt - startedAt : null }))
  }
  if (timedOut || exit.code !== 0) report.status = 'failed'
  writeFileSync(resultPath, JSON.stringify(report, null, 2))
  printSummary(report)
  console.log(`\nreport: ${resultPath}`)
  if (!keepProfile) rmSync(join(runDirectory, 'profile'), { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  process.exitCode = String(report.status).startsWith('passed') ? 0 : 1
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})

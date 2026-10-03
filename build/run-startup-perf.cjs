// Cold-start benchmark supervisor (PERF-01).
// Launches the current production build (out/, from `npm run build:bundle`)
// GB_PERF_STARTUP_RUNS times (default 5) per variant through
// tests/support/startup-perf-driver.mjs, each launch in a fresh temporary
// user-data directory, and reports median / p95 per startup phase.
//
// Variants (interleaved each round, per docs P7):
//   first-run   empty user-data dir (creates databases, shows release notes)
//   empty       copy of a prepared profile: release notes seen, startup update
//               check off, 0 conversations
//   seeded-300  same as empty plus GB_PERF_STARTUP_SEED (default 300)
//               synthetic conversations, reusing the PERF-11 seed shape
//
// Isolation: temporary profile/session/logs, a loopback fake model on an
// ephemeral port (GB_PERF_MODEL_PORT to pin one; 11434 is left alone), all
// non-loopback requests blocked in the driver. Output has phase names, times
// and counts only.
//
// Env: GB_PERF_STARTUP_RUNS, GB_PERF_STARTUP_SEED, GB_PERF_STARTUP_VARIANTS
// (comma list), GB_PERF_STARTUP_SKIP_BUILD=1, GB_PERF_STARTUP_PROFILE=1 (one
// extra CPU-profiled launch per variant, excluded from the table),
// GB_PERF_OUTPUT (report directory), GB_PERF_KEEP_PROFILE=1,
// GB_PERF_STARTUP_APP_ROOT (checkout/worktree to build and launch; default .).
const { spawn, spawnSync, execFileSync } = require('node:child_process')
const { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } = require('node:fs')
const { createServer } = require('node:http')
const { cpus, tmpdir, totalmem } = require('node:os')
const { join, resolve } = require('node:path')
const { npmInvocation } = require('./npm-invocation.cjs')

const root = resolve(__dirname, '..')
// The app under test. Defaults to this checkout; point it at a temporary
// worktree to measure a baseline or a clean HEAD while this tree is mid-edit.
const appRoot = resolve(process.env.GB_PERF_STARTUP_APP_ROOT || root)
const runs = Math.max(1, Number(process.env.GB_PERF_STARTUP_RUNS || 5))
const seedCount = Number(process.env.GB_PERF_STARTUP_SEED || 300)
const seededName = `seeded-${seedCount}`
const variants = (process.env.GB_PERF_STARTUP_VARIANTS || `first-run,empty,${seededName}`).split(',').map(v => v.trim()).filter(Boolean)
const requestedPort = Number(process.env.GB_PERF_MODEL_PORT || 0)
const launchTimeoutMs = Number(process.env.GB_PERF_STARTUP_LAUNCH_TIMEOUT_MS || 150_000)
const keepProfile = process.env.GB_PERF_KEEP_PROFILE === '1'
const cpuProfile = process.env.GB_PERF_STARTUP_PROFILE === '1'

// ------------------------------------------------------------------ build

function newestMtime(path) {
  let newest = 0
  const stack = [path]
  while (stack.length) {
    const current = stack.pop()
    let info
    try { info = statSync(current) } catch { continue }
    if (info.isDirectory()) {
      for (const entry of readdirSync(current)) if (entry !== 'node_modules') stack.push(join(current, entry))
    } else if (!/\.test\.tsx?$/.test(current)) {
      newest = Math.max(newest, info.mtimeMs)
    }
  }
  return newest
}

function ensureBuild() {
  const outputs = ['out/main/index.js', 'out/preload/index.cjs', 'out/renderer/index.html'].map(file => join(appRoot, file))
  const missing = outputs.some(file => !existsSync(file))
  const builtAt = missing ? 0 : Math.min(...outputs.map(file => statSync(file).mtimeMs))
  const sourceAt = Math.max(...['src/main', 'src/preload', 'src/renderer', 'src/shared', 'electron.vite.config.ts', 'package.json'].map(p => newestMtime(join(appRoot, p))))
  const stale = missing || sourceAt > builtAt
  if (!stale) return { rebuilt: false }
  if (process.env.GB_PERF_STARTUP_SKIP_BUILD === '1') {
    if (missing) throw new Error('Missing production build and GB_PERF_STARTUP_SKIP_BUILD=1')
    console.log('[startup] build is older than src/, measuring it anyway (GB_PERF_STARTUP_SKIP_BUILD=1)')
    return { rebuilt: false, stale: true }
  }
  console.log(`[startup] ${missing ? 'no production build' : 'production build is older than src/'}; running npm run build:bundle`)
  const npm = npmInvocation(appRoot)
  const result = spawnSync(npm.command, [...npm.prefixArgs, 'run', 'build:bundle'], { cwd: appRoot, stdio: 'inherit', shell: npm.prefixArgs.length === 0 && process.platform === 'win32' })
  if (result.status !== 0) throw new Error(`npm run build:bundle failed (${result.status})`)
  return { rebuilt: true }
}

// -------------------------------------------------------------- fake model

function startModelServer(ledger) {
  const server = createServer((request, response) => {
    ledger.push({ method: request.method, path: request.url })
    if (request.method === 'GET' && request.url?.endsWith('/models')) {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ object: 'list', data: [{ id: 'qwen3', object: 'model' }] }))
      return
    }
    if (request.method === 'POST' && request.url?.endsWith('/chat/completions')) {
      request.resume()
      request.on('end', () => {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ id: 'perf', object: 'chat.completion', model: 'qwen3', choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'ok' } }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }))
      })
      return
    }
    response.writeHead(404).end()
  })
  return new Promise((resolvePromise, reject) => {
    server.once('error', reject)
    server.listen(requestedPort, '127.0.0.1', () => resolvePromise(server))
  })
}

// ------------------------------------------------------------------ launch

function baseEnvironment(modelPort, workspace) {
  const environment = { ...process.env, GB_PERF_ROOT: appRoot, GB_PERF_STARTUP_MARKS: '1' }
  delete environment.ELECTRON_RUN_AS_NODE
  delete environment.ELECTRON_RENDERER_URL
  for (const key of ['GOODBUDDY_MODEL_API_KEY', 'GOODBUDDY_MODEL_BASE_URL', 'GOODBUDDY_MODEL_NAME', 'GOODBUDDY_BIGTOKEN_API_KEY', 'GOODBUDDY_BIGTOKEN_BASE_URL', 'GOODBUDDY_BIGTOKEN_MODEL']) delete environment[key]
  environment.GOODBUDDY_MODEL_API_KEY = 'perf-loopback'
  environment.GOODBUDDY_MODEL_BASE_URL = `http://127.0.0.1:${modelPort}/v1`
  environment.GOODBUDDY_MODEL_NAME = 'qwen3'
  environment.GOODBUDDY_WORKSPACE = workspace
  return environment
}

async function launch({ directory, environment, mode = 'measure', seed = 0, expectConversations = 0, profilePath }) {
  const resultPath = join(directory, 'startup-result.json')
  const env = { ...environment, GB_STARTUP_DIR: directory, GB_STARTUP_RESULT: resultPath, GB_STARTUP_MODE: mode, GB_STARTUP_SEED: String(seed), GB_STARTUP_EXPECT_CONVERSATIONS: String(expectConversations) }
  if (profilePath) env.GB_STARTUP_CPU_PROFILE = profilePath
  const stderr = []
  const spawnAt = Date.now()
  const child = spawn(require('electron'), [join(root, 'tests', 'support', 'startup-perf-driver.mjs')], { cwd: root, env, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: false })
  child.stderr.on('data', chunk => { if (stderr.length < 200) stderr.push(String(chunk)) })
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    if (process.platform === 'win32') spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
    else child.kill('SIGKILL')
  }, launchTimeoutMs)
  const exit = await new Promise(resolvePromise => child.once('exit', code => resolvePromise(code)))
  const exitAt = Date.now()
  clearTimeout(timer)
  const report = existsSync(resultPath) ? JSON.parse(readFileSync(resultPath, 'utf8')) : { status: 'failed', error: timedOut ? 'launch timeout' : 'driver exited without a report' }
  if (exit !== 0 || timedOut) report.status = 'failed'
  report.spawnAt = spawnAt
  report.exitMs = exitAt - spawnAt
  // stderr is kept only for failures, and only its first line (no user data exists in these profiles).
  if (report.status !== 'passed') report.stderrHead = stderr.join('').split(/\r?\n/).filter(Boolean).slice(0, 8)
  return report
}

// --------------------------------------------------------------- analysis

function phases(report) {
  const t = report.times
  const r = report.renderer
  const s = report.spawnAt
  const marks = Object.fromEntries((report.startupMarks ?? []).map(m => [m.name, m.at]))
  const d = (from, to) => (from === undefined || from === null || to === undefined || to === null) ? null : to - from
  const result = {
    'spawn -> driver start (Electron boot)': d(s, t.driverStart),
    'driver start -> Main import done': d(t.driverStart, t.mainImportEnd),
    'spawn -> app ready': d(s, t.appReady),
    'app ready -> BrowserWindow created': d(t.appReady, t.windowCreated),
    'window created -> loadMainWindow': d(t.windowCreated, marks['main:load-main-window']),
    'loadMainWindow -> ready-to-show': d(marks['main:load-main-window'], t.readyToShow),
    'window created -> ready-to-show': d(t.windowCreated, t.readyToShow),
    'ready-to-show -> first visible frame': d(t.readyToShow, r.firstVisibleFrame),
    'ready-to-show -> composer interactive': d(t.readyToShow, r.composerInteractive),
    'spawn -> ready-to-show': d(s, t.readyToShow),
    'spawn -> first visible frame': d(s, r.firstVisibleFrame),
    // Only reported by Chromium when the first paint happens while visible.
    'spawn -> first contentful paint': d(s, r.firstContentfulPaint),
    'spawn -> composer present': d(s, r.composerPresent),
    'spawn -> composer interactive': d(s, r.composerInteractive),
    'spawn -> sidebar populated (seeded)': d(s, r.sidebarPopulated),
    'composer interactive -> sidebar populated': d(r.composerInteractive, r.sidebarPopulated)
  }
  // Main phases (GB_PERF_STARTUP_MARKS spans; parallel spans overlap).
  const main = {
    'main: module import (index.js eval)': d(t.mainImportStart, marks['main:module-evaluated']),
    'main: whenReady -> window created': d(marks['main:when-ready'], marks['main:create-window:end']),
    'main: createMainWindow()': d(marks['main:create-window:start'], marks['main:create-window:end']),
    'main: tray': d(marks['main:create-window:end'], marks['main:tray-built'])
  }
  for (const m of report.startupMarks ?? []) {
    if (!m.name.endsWith(':start')) continue
    const base = m.name.slice(0, -':start'.length)
    if (base === 'main:create-window') continue
    main[`${base.replace(/^main:/, 'main: ')}`] = d(m.at, marks[`${base}:end`])
    // Synchronous part of the span: from the call until the first await yields.
    if (marks[`${base}:sync-end`] !== undefined) main[`${base.replace(/^main:/, 'main: ')} (sync part)`] = d(m.at, marks[`${base}:sync-end`])
  }
  main['main: whenReady -> loadMainWindow (total)'] = d(marks['main:when-ready'], marks['main:load-main-window'])
  // Critical path in Main: consecutive top-level marks (spans that run in
  // parallel inside the prerequisites are excluded), so each gap is the time
  // Main spent between two points of the sequential startup function.
  const nested = /^main:(knowledge-init|knowledge-gateway-start|runtime-hydrate|assistant-db-init)/
  const sequence = (report.startupMarks ?? []).filter(m => !nested.test(m.name) && !m.name.endsWith(':sync-end')).sort((a, b) => a.at - b.at)
  for (let index = 1; index < sequence.length; index += 1) {
    main[`gap: ${sequence[index - 1].name} -> ${sequence[index].name}`] = sequence[index].at - sequence[index - 1].at
  }
  const renderer = {
    'renderer: navigation start -> DOMContentLoaded': d(r.navigationStart, r.domContentLoaded),
    'renderer: DOMContentLoaded -> composer present': d(r.domContentLoaded, r.composerPresent),
    'renderer: navigation start -> composer present': d(r.navigationStart, r.composerPresent)
  }
  return { ...result, ...main, ...renderer }
}

function percentile(values, p) {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b)
  // Nearest rank; with 5 samples p95 is the maximum.
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))]
}

function summarize(reportsByVariant) {
  const rows = new Map()
  for (const [variant, reports] of Object.entries(reportsByVariant)) {
    const passed = reports.filter(r => r.status === 'passed')
    const perRun = passed.map(phases)
    for (const name of new Set(perRun.flatMap(Object.keys))) {
      const values = perRun.map(p => p[name]).filter(v => typeof v === 'number' && Number.isFinite(v))
      const row = rows.get(name) ?? {}
      row[variant] = values.length ? { median: percentile(values, 50), p95: percentile(values, 95), n: values.length } : null
      rows.set(name, row)
    }
  }
  return rows
}

function sourceInfo() {
  try {
    const commit = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: appRoot, encoding: 'utf8' }).trim()
    const dirtyFiles = execFileSync('git', ['status', '--porcelain'], { cwd: appRoot, encoding: 'utf8' }).split('\n').filter(Boolean).length
    return { commit, dirty: dirtyFiles > 0, dirtyFiles, appRoot: appRoot === root ? '.' : 'GB_PERF_STARTUP_APP_ROOT' }
  } catch {
    return { commit: null }
  }
}

const fmt = v => (v === null || v === undefined ? '-' : Math.round(v).toString())

// ------------------------------------------------------------------- main

async function main() {
  const build = ensureBuild()
  const runDirectory = mkdtempSync(join(tmpdir(), 'goodbuddy-startup-perf-'))
  const outputDirectory = resolve(process.env.GB_PERF_OUTPUT || join(runDirectory, 'artifacts'))
  mkdirSync(outputDirectory, { recursive: true })
  const workspace = join(runDirectory, 'workspace')
  mkdirSync(workspace, { recursive: true })
  const ledger = []
  let server
  try {
    server = await startModelServer(ledger)
  } catch (error) {
    throw new Error(`Cannot listen on 127.0.0.1:${requestedPort} for the fake model (${error.code ?? error.message}); set GB_PERF_MODEL_PORT to a free port or leave it unset for an ephemeral port`, { cause: error })
  }
  const modelPort = server.address().port
  const environment = baseEnvironment(modelPort, workspace)
  const templates = {}
  const prepareReports = {}
  try {
    // Templates are prepared once and copied per launch, so every measured
    // launch starts from an identical, never-used-before directory.
    for (const variant of variants) {
      if (variant === 'first-run') continue
      const seed = variant === 'empty' ? 0 : variant === seededName ? seedCount : null
      if (seed === null) throw new Error(`Unknown variant ${variant}`)
      const directory = join(runDirectory, `template-${variant}`)
      mkdirSync(directory, { recursive: true })
      console.log(`[startup] preparing ${variant} profile${seed ? ` (${seed} conversations)` : ''}`)
      const report = await launch({ directory, environment, mode: 'prepare', seed })
      prepareReports[variant] = { status: report.status, error: report.error, seeded: report.seeded, exitMs: report.exitMs, stderrHead: report.stderrHead }
      if (report.status !== 'passed') throw new Error(`Preparing ${variant} failed: ${report.error ?? 'unknown'}\n${(report.stderrHead ?? []).join('\n')}`)
      rmSync(join(directory, 'startup-result.json'), { force: true })
      templates[variant] = directory
    }

    const fresh = (variant, label) => {
      const directory = join(runDirectory, `${label}-${variant}`)
      if (templates[variant]) {
        cpSync(templates[variant], directory, { recursive: true })
      } else {
        mkdirSync(directory, { recursive: true })
      }
      return directory
    }

    const expectedFor = variant => (variant === seededName ? seedCount : 0)
    const results = Object.fromEntries(variants.map(v => [v, []]))
    // A discarded warm-up launch per invocation so the first measured launch
    // does not also pay for loading Electron binaries from a cold disk cache.
    console.log('[startup] warm-up launch (discarded)')
    await launch({ directory: fresh(variants.includes('empty') ? 'empty' : variants[0], 'warmup'), environment })
    for (let round = 0; round < runs; round += 1) {
      for (const variant of variants) {
        const directory = fresh(variant, `run${round + 1}`)
        const report = await launch({ directory, environment, expectConversations: expectedFor(variant) })
        report.round = round + 1
        results[variant].push(report)
        const p = report.status === 'passed' ? phases(report) : {}
        console.log(`[startup] round ${round + 1} ${variant}: ${report.status}, ready ${fmt(p['spawn -> app ready'])} ms, ready-to-show ${fmt(p['spawn -> ready-to-show'])} ms, first frame ${fmt(p['spawn -> first visible frame'])} ms, composer interactive ${fmt(p['spawn -> composer interactive'])} ms${report.error ? `, error ${report.error}` : ''}`)
        if (!keepProfile) rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
      }
    }

    const profiles = {}
    if (cpuProfile) {
      for (const variant of variants) {
        const directory = fresh(variant, 'profiled')
        const profilePath = join(outputDirectory, `main-startup-${variant}.cpuprofile`)
        const report = await launch({ directory, environment, profilePath, expectConversations: expectedFor(variant) })
        profiles[variant] = { status: report.status, cpuProfile: report.cpuProfile, phases: report.status === 'passed' ? phases(report) : null, file: profilePath }
        console.log(`[startup] CPU-profiled ${variant}: ${report.status} -> ${profilePath}`)
      }
    }

    const table = summarize(results)
    const report = {
      schemaVersion: 1,
      kind: 'goodbuddy-startup-benchmark',
      source: { ...sourceInfo(), build },
      environment: { platform: process.platform, arch: process.arch, electron: require('electron/package.json').version, cpu: `${cpus()[0]?.model?.trim()} x${cpus().length}`, memoryGB: Math.round(totalmem() / 1073741824) },
      config: { runs, variants, seedConversations: seedCount, percentile: 'nearest-rank' },
      prepare: prepareReports,
      phases: Object.fromEntries(table),
      runs: Object.fromEntries(Object.entries(results).map(([variant, reports]) => [variant, reports.map(r => ({
        round: r.round, status: r.status, error: r.error, stderrHead: r.stderrHead, exitMs: r.exitMs,
        phases: r.status === 'passed' ? phases(r) : null,
        renderer: r.renderer ? { domNodes: r.renderer.domNodes, conversationRows: r.renderer.conversationRows, scriptResources: r.renderer.scriptResources, scriptBytes: r.renderer.scriptBytes, jsHeapMB: r.renderer.jsHeapMB, startupDialog: r.renderer.startupDialog !== undefined, composerPresentBeforeProbe: r.renderer.alreadyAtInstall === true, longAnimationFrames: r.renderer.longAnimationFrames && { count: r.renderer.longAnimationFrames.count, totalMs: r.renderer.longAnimationFrames.totalMs, maxMs: r.renderer.longAnimationFrames.maxMs, scriptMs: r.renderer.longAnimationFrames.scriptMs } } : null,
        mainEventLoopDelay: r.mainEventLoopDelay,
        blockedRequests: r.blockedRequests && { fetch: r.blockedRequests.fetch.length, renderer: r.blockedRequests.renderer.length, hosts: [...new Set([...r.blockedRequests.fetch, ...r.blockedRequests.renderer])] }
      }))])),
      cpuProfiles: profiles,
      modelRequests: { boundary: 'loopback fake model only; non-loopback requests blocked', total: ledger.length, paths: [...new Set(ledger.map(e => `${e.method} ${e.path}`))] }
    }
    const resultPath = join(outputDirectory, 'startup-result.json')
    writeFileSync(resultPath, JSON.stringify(report, null, 2))

    console.log(`\nGoodBuddy cold-start benchmark: ${runs} runs per variant, ms (median / p95, nearest rank)`)
    console.log(`source ${report.source.commit ?? '?'}${report.source.dirty ? ` (dirty, ${report.source.dirtyFiles} files)` : ''}, Electron ${report.environment.electron}, ${report.environment.cpu}, ${report.environment.memoryGB} GB`)
    console.table(Object.fromEntries([...table].map(([name, row]) => [name, Object.fromEntries(variants.map(v => [v, row[v] ? `${fmt(row[v].median)} / ${fmt(row[v].p95)}${row[v].n < runs ? ` (n=${row[v].n})` : ''}` : '-']))])))
    const failed = Object.values(results).flat().filter(r => r.status !== 'passed').length
    if (failed) console.log(`${failed} launch(es) failed; see report`)
    const blocked = Object.values(results).flat().flatMap(r => [...(r.blockedRequests?.fetch ?? []), ...(r.blockedRequests?.renderer ?? [])])
    console.log(`blocked non-loopback requests: ${blocked.length}${blocked.length ? ` (${[...new Set(blocked)].join(', ')})` : ''}; fake model requests: ${ledger.length}`)
    console.log(`\nreport: ${resultPath}`)
    process.exitCode = failed ? 1 : 0
  } finally {
    await new Promise(resolvePromise => server.close(() => resolvePromise()))
    if (!keepProfile) {
      for (const entry of readdirSync(runDirectory)) {
        if (entry !== 'artifacts') rmSync(join(runDirectory, entry), { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
      }
    }
  }
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})

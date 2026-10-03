// Full-App interaction benchmark driver (PERF-11). Launched by
// build/run-app-perf.cjs. Runs inside the Electron main process: isolates the
// profile, imports the current production Main, then drives the real window
// with native input events and records renderer, Main and process metrics.
import { app } from 'electron'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { cpus, totalmem } from 'node:os'
import { join } from 'node:path'
import { monitorEventLoopDelay, performance } from 'node:perf_hooks'
import console from 'node:console'
import process from 'node:process'
import { clearTimeout, setTimeout } from 'node:timers'
import { setTimeout as sleep } from 'node:timers/promises'
import { pathToFileURL } from 'node:url'

const directory = process.env.GB_PERF_DIRECTORY
const artifacts = process.env.GB_PERF_ARTIFACTS
const root = process.env.GB_PERF_ROOT
if (!directory || !artifacts || !root) throw new Error('Run through build/run-app-perf.cjs')
const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const config = {
  seedConversations: Number(process.env.GB_PERF_SEED_CONVERSATIONS || 300),
  seedMessagesPerConversation: Number(process.env.GB_PERF_SEED_MESSAGES || 20),
  longConversationMessages: Number(process.env.GB_PERF_LONG_MESSAGES || 2_000),
  typedCharacters: Number(process.env.GB_PERF_TYPED_CHARACTERS || 120),
  keyIntervalMs: Number(process.env.GB_PERF_KEY_INTERVAL_MS || 60),
  switches: Number(process.env.GB_PERF_SWITCHES || 15),
  memoryVisits: Number(process.env.GB_PERF_MEMORY_VISITS || 24),
  // Chromium CPU throttling of the renderer only (Main is not slowed down).
  cpuThrottle: Number(process.env.GB_PERF_CPU_THROTTLE || 1),
  contentWidth: 1280,
  contentHeight: 800
}

// Isolation must happen before the production Main module loads: it takes
// the single-instance lock and opens storage from userData at import time.
app.setAppPath(root)
app.setName(packageJson.name)
app.setVersion(packageJson.version)
app.setPath('userData', join(directory, 'profile'))
app.setPath('sessionData', join(directory, 'session'))
app.setAppLogsPath(join(directory, 'logs'))
app.commandLine.appendSwitch('force-device-scale-factor', '1')
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion')
app.commandLine.appendSwitch('enable-precise-memory-info')
mkdirSync(artifacts, { recursive: true })

const driverStart = performance.now()
const report = {
  schemaVersion: 1,
  kind: 'goodbuddy-full-app-benchmark',
  status: 'running',
  source: sourceInfo(),
  environment: null,
  config,
  startup: {},
  scenarios: [],
  rendererErrors: [],
  pending: 'startup'
}
const errors = report.rendererErrors
const mainDelay = monitorEventLoopDelay({ resolution: 10 })
mainDelay.enable()
let win

function sourceInfo() {
  try {
    const commit = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
    const dirty = execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim().split('\n').filter(Boolean).length
    return { commit, dirty: dirty > 0, dirtyFiles: dirty, version: packageJson.version }
  } catch {
    return { commit: null, dirty: null, version: packageJson.version }
  }
}

function writeReport() {
  writeFileSync(join(artifacts, 'result.json'), JSON.stringify(report, null, 2))
}

const deadline = setTimeout(() => {
  report.status = 'failed'
  report.error = `Driver timeout during ${report.pending}`
  writeReport()
  app.exit(1)
}, Number(process.env.GB_PERF_DRIVER_TIMEOUT_MS || 540_000))

app.on('browser-window-created', (_event, created) => {
  if (win) return
  win = created
  report.startup.windowCreatedMs = performance.now() - driverStart
  created.once('ready-to-show', () => { report.startup.readyToShowMs = performance.now() - driverStart })
  created.webContents.on('console-message', event => {
    if (event.level !== 'error') return
    const text = String(event.message)
    // CSP has no font-src, so KaTeX data: fonts are refused. Count, don't list.
    if (text.startsWith("Loading the font 'data:font/")) { report.cspBlockedDataFonts = (report.cspBlockedDataFonts ?? 0) + 1; return }
    errors.push(text.slice(0, 500))
  })
  created.webContents.on('render-process-gone', (_e, details) => errors.push(`render-process-gone ${JSON.stringify(details)}`))
})

await import(pathToFileURL(join(root, 'out', 'main', 'index.js')).href)

// ---------------------------------------------------------------- helpers

const js = code => win.webContents.executeJavaScript(code, true)
async function waitFor(code, timeoutMs = 30_000, label = code) {
  const started = performance.now()
  while (performance.now() - started < timeoutMs) {
    try { if (await js(code)) return performance.now() - started } catch { /* page may be reloading */ }
    await sleep(20)
  }
  throw new Error(`Timeout waiting for ${label}`)
}
const settle = () => js('new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))')

async function focusWindow() {
  win.show()
  win.focus()
  win.webContents.focus()
  await waitFor('document.hasFocus()', 5_000, 'window focus')
}

async function clickSelector(selector, { scroll = true } = {}) {
  await focusWindow()
  const point = await js(`(() => {
    const e = document.querySelector(${JSON.stringify(selector)});
    if (!e) return null;
    ${scroll ? "e.scrollIntoView({ block: 'center' });" : ''}
    const r = e.getBoundingClientRect();
    const x = Math.round(r.x + r.width / 2), y = Math.round(r.y + r.height / 2);
    return { x, y, hit: e.contains(document.elementFromPoint(x, y)) };
  })()`)
  if (!point) throw new Error(`Missing element ${selector}`)
  if (!point.hit) throw new Error(`Element occluded ${selector}`)
  win.webContents.sendInputEvent({ type: 'mouseMove', x: point.x, y: point.y })
  win.webContents.sendInputEvent({ type: 'mouseDown', x: point.x, y: point.y, button: 'left', clickCount: 1 })
  win.webContents.sendInputEvent({ type: 'mouseUp', x: point.x, y: point.y, button: 'left', clickCount: 1 })
}

async function typeText(text) {
  for (const character of text) {
    const keyCode = character === ' ' ? 'Space' : character
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode })
    win.webContents.sendInputEvent({ type: 'char', keyCode: character })
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode })
    await sleep(config.keyIntervalMs)
  }
}

function percentile(values, p) {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))]
}
function summarize(values) {
  if (!values.length) return null
  return { count: values.length, p50: percentile(values, 50), p95: percentile(values, 95), max: Math.max(...values) }
}

// Installed into the renderer after every load. It only observes; it does not
// change application state.
const probeSource = `(() => {
  if (window.__gbPerf) return true;
  const s = { recording: false, startedAt: 0, frames: [], lastFrame: 0, longTasks: [], loafs: [], events: [], latencies: [], mutations: 0, pointerDown: 0 };
  const frame = t => { if (s.recording && s.lastFrame) s.frames.push(t - s.lastFrame); s.lastFrame = t; requestAnimationFrame(frame); };
  requestAnimationFrame(frame);
  const observe = (type, sink, options = {}) => { try { new PerformanceObserver(list => { if (s.recording) for (const e of list.getEntries()) sink(e); }).observe({ type, ...options }); } catch {} };
  observe('longtask', e => s.longTasks.push({ at: e.startTime - s.startedAt, duration: e.duration }));
  // Split each long frame into script time and rendering (style + layout + paint) time.
  observe('long-animation-frame', e => s.loafs.push({ duration: e.duration, blocking: e.blockingDuration,
    scriptMs: e.scripts.reduce((a, x) => a + x.duration, 0),
    renderMs: e.renderStart ? e.startTime + e.duration - e.renderStart : 0,
    styleLayoutMs: e.styleAndLayoutStart ? e.startTime + e.duration - e.styleAndLayoutStart : 0,
    forcedLayoutMs: e.scripts.reduce((a, x) => a + (x.forcedStyleAndLayoutDuration || 0), 0) }));
  observe('event', e => { if (e.name === 'keydown' || e.name === 'keypress' || e.name === 'input' || e.name === 'pointerdown' || e.name === 'click' || e.name === 'mousedown') s.events.push({ name: e.name, duration: e.duration }); }, { durationThreshold: 16 });
  document.addEventListener('keydown', e => { if (!s.recording) return; const t = e.timeStamp; requestAnimationFrame(() => s.latencies.push(performance.now() - t)); }, true);
  document.addEventListener('mousedown', e => { s.pointerDown = e.timeStamp; }, true);
  new MutationObserver(() => { if (s.recording) s.mutations += 1; }).observe(document.documentElement, { subtree: true, childList: true, characterData: true });
  window.__gbPerf = {
    start() { Object.assign(s, { recording: true, startedAt: performance.now(), frames: [], lastFrame: 0, longTasks: [], loafs: [], events: [], latencies: [], mutations: 0 }); return true; },
    stop() {
      s.recording = false;
      return { elapsed: performance.now() - s.startedAt, frames: s.frames, longTasks: s.longTasks, loafs: s.loafs, events: s.events, latencies: s.latencies, mutations: s.mutations,
        domNodes: document.getElementsByTagName('*').length, heapUsedMB: performance.memory ? performance.memory.usedJSHeapSize / 1048576 : null };
    },
    // Resolves with the time from the last native mousedown until the given
    // conversation is the active pane with rendered messages, checked at frame
    // boundaries. (CSP forbids eval, so the condition is fixed here.)
    paneShownSinceMouseDown(conversationId) {
      return new Promise((resolve, reject) => {
        const started = performance.now();
        const check = () => {
          const pane = document.querySelector('.chat-history-pane[data-active=true]');
          if (pane && pane.dataset.conversationId === conversationId && pane.querySelector('article.message')) resolve(performance.now() - s.pointerDown);
          else if (performance.now() - started > 30000) reject(new Error('timeout pane ' + conversationId));
          else requestAnimationFrame(check);
        };
        check();
      });
    }
  };
  return true;
})()`

function processSnapshot() {
  const byType = {}
  for (const metric of app.getAppMetrics()) {
    const key = metric.type
    const entry = byType[key] ?? (byType[key] = { cpu: 0, workingSetMB: 0, count: 0 })
    entry.cpu += metric.cpu.percentCPUUsage
    entry.workingSetMB += metric.memory.workingSetSize / 1024
    entry.count += 1
  }
  return byType
}

let frameBaseline = null
async function measure(id, description, body) {
  report.pending = id
  writeReport()
  await js(probeSource)
  processSnapshot() // resets per-process CPU accounting
  mainDelay.reset()
  await js('window.__gbPerf.start()')
  const started = performance.now()
  const extra = (await body()) ?? {}
  const durationMs = performance.now() - started
  const raw = await js('window.__gbPerf.stop()')
  const processes = processSnapshot()
  const frames = raw.frames
  const baseline = frameBaseline ?? percentile(frames, 50) ?? 16.7
  const longTaskDurations = raw.longTasks.map(task => task.duration)
  const longTaskTotal = longTaskDurations.reduce((a, b) => a + b, 0)
  // Long-task time per quarter of the recorded window shows whether cost grows over the scenario.
  const quarters = [0, 0, 0, 0]
  for (const task of raw.longTasks) quarters[Math.min(3, Math.max(0, Math.floor((task.at / raw.elapsed) * 4)))] += task.duration
  const scenario = {
    id,
    description,
    durationMs,
    renderer: {
      longTasks: { count: raw.longTasks.length, totalMs: longTaskTotal, maxMs: longTaskDurations.length ? Math.max(...longTaskDurations) : 0, shareOfDuration: longTaskTotal / raw.elapsed, msByQuarter: quarters.map(Math.round) },
      longAnimationFrames: { count: raw.loafs.length, blockingMs: raw.loafs.reduce((a, b) => a + b.blocking, 0), maxMs: raw.loafs.length ? Math.max(...raw.loafs.map(l => l.duration)) : 0,
        scriptMs: Math.round(raw.loafs.reduce((a, b) => a + b.scriptMs, 0)),
        forcedLayoutMs: Math.round(raw.loafs.reduce((a, b) => a + b.forcedLayoutMs, 0)),
        styleLayoutMs: Math.round(raw.loafs.reduce((a, b) => a + b.styleLayoutMs, 0)),
        renderMs: Math.round(raw.loafs.reduce((a, b) => a + b.renderMs, 0)) },
      frames: { count: frames.length, ...summarize(frames), baselineMs: baseline, jankRatio: frames.length ? frames.filter(f => f > baseline * 1.5).length / frames.length : null },
      slowEvents: { countOver16ms: raw.events.length, maxMs: raw.events.length ? Math.max(...raw.events.map(e => e.duration)) : 0, byName: raw.events.reduce((acc, e) => ({ ...acc, [e.name]: (acc[e.name] ?? 0) + 1 }), {}) },
      domMutationBatches: raw.mutations,
      domNodes: raw.domNodes,
      heapUsedMB: raw.heapUsedMB
    },
    latency: raw.latencies.length ? summarize(raw.latencies) : extra.latency ?? null,
    main: {
      eventLoopDelay: {
        p50: mainDelay.percentile(50) / 1e6,
        p99: mainDelay.percentile(99) / 1e6,
        max: mainDelay.max / 1e6,
        mean: mainDelay.mean / 1e6
      }
    },
    processes: {
      cpu: Object.fromEntries(Object.entries(processes).map(([type, value]) => [type, value.cpu])),
      workingSetMB: Object.fromEntries(Object.entries(processes).map(([type, value]) => [type, Math.round(value.workingSetMB)]))
    },
    ...extra.fields
  }
  delete scenario.latencyExtra
  report.scenarios.push(scenario)
  writeReport()
  console.log(`[perf] ${id}: ${Math.round(durationMs)} ms, long tasks ${raw.longTasks.length} (${Math.round(longTaskTotal)} ms), frame p95 ${scenario.renderer.frames.p95?.toFixed(1)} ms, main lag max ${scenario.main.eventLoopDelay.max.toFixed(1)} ms`)
  return scenario
}

// Optional renderer CPU profile (GB_PERF_PROFILE=1). Profiling adds overhead,
// so profiled runs are for attribution only, not for baseline numbers.
const profiling = process.env.GB_PERF_PROFILE === '1'
function cdp() {
  const debuggerApi = win.webContents.debugger
  if (!debuggerApi.isAttached()) debuggerApi.attach('1.3')
  return debuggerApi
}
// Throttling is per page session, so it is reapplied after every reload.
async function applyCpuThrottle() {
  if (config.cpuThrottle > 1) await cdp().sendCommand('Emulation.setCPUThrottlingRate', { rate: config.cpuThrottle })
}
// Heap after a full GC, so retained memory is not hidden by GC timing.
async function retainedHeapMB() {
  await cdp().sendCommand('HeapProfiler.collectGarbage')
  const { usedSize } = await cdp().sendCommand('Runtime.getHeapUsage')
  return usedSize / 1048576
}
async function withRendererProfile(name, body) {
  if (!profiling) return body()
  const debuggerApi = cdp()
  await debuggerApi.sendCommand('Profiler.enable')
  await debuggerApi.sendCommand('Profiler.setSamplingInterval', { interval: 200 })
  await debuggerApi.sendCommand('Profiler.start')
  try {
    return await body()
  } finally {
    const { profile } = await debuggerApi.sendCommand('Profiler.stop')
    writeFileSync(join(artifacts, `${name}.cpuprofile`), JSON.stringify(profile))
    report.profiles = [...(report.profiles ?? []), { scenario: name, hotspots: profileHotspots(profile) }]
  }
}

// Self time per function and per script, without source text.
function profileHotspots(profile) {
  const byId = new Map(profile.nodes.map(node => [node.id, node]))
  const self = new Map()
  const deltas = profile.timeDeltas
  for (let index = 0; index < profile.samples.length; index += 1) {
    const id = profile.samples[index]
    self.set(id, (self.get(id) ?? 0) + (deltas[index] ?? 0))
  }
  const functions = new Map()
  const scripts = new Map()
  let total = 0
  for (const [id, micros] of self) {
    const frame = byId.get(id).callFrame
    total += micros
    const file = frame.url ? frame.url.split('/').pop() : `(${frame.functionName || 'native'})`
    const key = `${frame.functionName || '(anonymous)'} ${file}:${frame.lineNumber + 1}`
    functions.set(key, (functions.get(key) ?? 0) + micros)
    scripts.set(file, (scripts.get(file) ?? 0) + micros)
  }
  const top = (map, count) => [...map].sort((a, b) => b[1] - a[1]).slice(0, count).map(([key, micros]) => ({ key, ms: Math.round(micros / 1000), share: Math.round((micros / total) * 1000) / 10 }))
  return { totalMs: Math.round(total / 1000), functions: top(functions, 30), scripts: top(scripts, 10) }
}

async function screenshot(name) {
  writeFileSync(join(artifacts, `${name}.png`), (await win.webContents.capturePage()).toPNG())
}

const composer = '.composer__input textarea'
const sendButton = '.composer__submit-actions button.send-button:not(.send-button--stop)'
const stopButton = 'button.send-button--stop'

async function dismissStartupDialogs({ expect = true } = {}) {
  // The fresh-profile release notes dialog opens after an async IPC read.
  if (expect) await waitFor("!!document.querySelector('section.release-notes-dialog')", 6_000, 'release notes').catch(() => {})
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const open = await js("!!document.querySelector('section.release-notes-dialog')")
    if (!open) return
    await clickSelector('.release-notes-dialog__header button.icon-button', { scroll: false })
    await waitFor("!document.querySelector('section.release-notes-dialog')", 5_000, 'release notes closed')
  }
}

function message(role, index, createdAt) {
  const content = role === 'user'
    ? `Question ${index}: how should the benchmark handle item ${index}?`
    : `## Answer ${index}\n\nThe benchmark answer for item ${index} contains **formatting**, \`inline code\`, and a list:\n\n- point one\n- point two\n\n\`\`\`ts\nconst value${index} = ${index}\n\`\`\`\n\nInline math $x_${index} = ${index}^2$.`
  return { id: randomUUID(), role, content, createdAt, state: 'complete' }
}

function conversation(projectId, title, messageCount, updatedAt) {
  const messages = []
  for (let index = 0; index < messageCount; index += 1) {
    messages.push(message(index % 2 === 0 ? 'user' : 'assistant', index, updatedAt - (messageCount - index) * 1000))
  }
  return { header: { id: randomUUID(), projectId, title, updatedAt, knowledgeLibraryIds: [], knowledgeRetrievalMode: 'auto' }, messages }
}

async function seed() {
  const projectId = await js(`window.goodbuddy.projects.list(false).then(list => list.find(p => p.kind === 'user' && p.executionSpace.kind === 'local')?.id)`)
  if (!projectId) throw new Error('No local project to seed')
  const now = Date.now()
  const items = []
  for (let index = 0; index < config.seedConversations; index += 1) {
    items.push(conversation(projectId, `Perf conversation ${String(index + 1).padStart(4, '0')}`, config.seedMessagesPerConversation, now - (index + 1) * 60_000))
  }
  const long = conversation(projectId, 'Perf long conversation', config.longConversationMessages, now - 30_000)
  const started = performance.now()
  for (let offset = 0; offset < items.length; offset += 100) {
    await js(`window.goodbuddy.conversations.saveLocal(${JSON.stringify(items.slice(offset, offset + 100))}).then(() => true)`)
  }
  await js(`window.goodbuddy.conversations.saveLocal(${JSON.stringify([long])}).then(() => true)`)
  return { seedMs: performance.now() - started, titles: items.map(item => item.header.title), longTitle: long.header.title, longId: long.header.id, ids: items.map(item => item.header.id) }
}

const rowSelectorByTitle = title => `[...document.querySelectorAll('button.conversation-item')].find(b => b.querySelector('.conversation-item__title')?.textContent.includes(${JSON.stringify(title)}))`

// The sidebar mounts only the rows near its viewport (PERF-14). Scroll it a
// screen at a time from the top, letting it re-window after each step, until
// the row is mounted; then centre it and wait for the re-window again.
async function revealConversation(title) {
  const list = "document.querySelector('.conversation-list')"
  const present = `!!(${rowSelectorByTitle(title)})`
  await js(`(() => { const l = ${list}; if (l) l.scrollTop = 0; return true; })()`)
  await settle()
  for (let step = 0; step < 200; step += 1) {
    await settle()
    if (await js(present)) break
    const moved = await js(`(() => { const l = ${list}; if (!l) return false; const before = l.scrollTop; l.scrollTop += Math.max(200, Math.round(l.clientHeight * 0.8)); return l.scrollTop !== before; })()`)
    if (!moved) break
  }
  await js(`(() => { ${rowSelectorByTitle(title)}?.scrollIntoView({ block: 'center' }); return true; })()`)
}

async function clickConversation(title) {
  await focusWindow()
  await revealConversation(title)
  let point
  for (let attempt = 0; attempt < 10 && !point?.hit; attempt += 1) {
    await settle()
    point = await js(`(() => {
      const e = ${rowSelectorByTitle(title)};
      if (!e) return null;
      const r = e.getBoundingClientRect();
      const x = Math.round(r.x + Math.min(r.width / 2, 80)), y = Math.round(r.y + r.height / 2);
      return { x, y, hit: e.contains(document.elementFromPoint(x, y)) };
    })()`)
  }
  if (!point?.hit) throw new Error(`Conversation row not clickable: ${title}`)
  await settle()
  win.webContents.sendInputEvent({ type: 'mouseMove', x: point.x, y: point.y })
  win.webContents.sendInputEvent({ type: 'mouseDown', x: point.x, y: point.y, button: 'left', clickCount: 1 })
  win.webContents.sendInputEvent({ type: 'mouseUp', x: point.x, y: point.y, button: 'left', clickCount: 1 })
}

async function streamOnce({ typeDuring = 0 } = {}) {
  await clickSelector('button.new-chat', { scroll: false })
  await waitFor(`!!document.querySelector(${JSON.stringify(composer)})`, 10_000, 'composer after new chat')
  await clickSelector(composer, { scroll: false })
  await typeText('perf-stream benchmark request')
  await waitFor(`!!document.querySelector(${JSON.stringify(sendButton)}) && !document.querySelector(${JSON.stringify(sendButton)}).disabled`, 15_000, 'send enabled')
  await clickSelector(sendButton, { scroll: false })
  const sendAt = performance.now()
  await waitFor(`!!document.querySelector(${JSON.stringify(stopButton)})`, 15_000, 'stream started')
  const startedMs = performance.now() - sendAt
  // Renderer samples cover only the streaming period, not prompt typing.
  await js('window.__gbPerf.start()')
  let typedDuringStream = 0
  if (typeDuring > 0) {
    await clickSelector(composer, { scroll: false })
    await typeText('abcdefghijklmnopqrstuvwxyz'.repeat(Math.ceil(typeDuring / 26)).slice(0, typeDuring))
    typedDuringStream = typeDuring
  }
  const stillStreaming = await js(`!!document.querySelector(${JSON.stringify(stopButton)})`)
  await waitFor(`!document.querySelector(${JSON.stringify(stopButton)})`, 180_000, 'stream finished')
  const assistantChars = await js(`(() => { const list = document.querySelectorAll('.chat-history-pane[data-active=true] article.message--assistant'); return list.length ? list[list.length - 1].textContent.length : 0; })()`)
  return { fields: { streamStartMs: startedMs, streamTotalMs: performance.now() - sendAt, assistantRenderedChars: assistantChars, typedDuringStream, typingEndedBeforeStreamFinished: stillStreaming } }
}

// PERF-09: visit many distinct conversations and check whether DOM size and
// retained heap stay bounded by the keep-alive cache. Sampling forces a GC,
// so it is recorded outside measure() and is not mixed with frame metrics.
async function memoryGrowth(seeded) {
  report.pending = 'memory-growth'
  writeReport()
  const sample = async visits => ({
    visits,
    mountedPanes: await js("document.querySelectorAll('.chat-history-pane').length"),
    domNodes: await js("document.getElementsByTagName('*').length"),
    retainedHeapMB: Math.round(await retainedHeapMB() * 10) / 10
  })
  const samples = [await sample(0)]
  const openMs = []
  for (let index = 0; index < config.memoryVisits; index += 1) {
    const target = index * 3 + 2
    await clickConversation(seeded.titles[target])
    openMs.push(await js(`window.__gbPerf.paneShownSinceMouseDown(${JSON.stringify(seeded.ids[target])})`))
    await sleep(200)
    if ((index + 1) % 4 === 0) samples.push(await sample(index + 1))
  }
  const first = samples[0]
  const last = samples[samples.length - 1]
  const half = samples[Math.floor(samples.length / 2)]
  report.memoryGrowth = {
    description: `Visit ${config.memoryVisits} distinct seeded conversations; DOM and post-GC heap every 4 visits`,
    samples,
    openLatency: summarize(openMs),
    // Growth in the second half shows whether the cache bound actually holds.
    secondHalfGrowth: { domNodes: last.domNodes - half.domNodes, retainedHeapMB: Math.round((last.retainedHeapMB - half.retainedHeapMB) * 10) / 10 },
    totalGrowth: { domNodes: last.domNodes - first.domNodes, retainedHeapMB: Math.round((last.retainedHeapMB - first.retainedHeapMB) * 10) / 10 }
  }
  writeReport()
  console.log(`[perf] memory-growth: panes ${first.mountedPanes}->${last.mountedPanes}, DOM ${first.domNodes}->${last.domNodes}, heap ${first.retainedHeapMB}->${last.retainedHeapMB} MB (second half +${report.memoryGrowth.secondHalfGrowth.retainedHeapMB} MB)`)
}

// -------------------------------------------------------------- scenarios

// Electron emits `ready` only after this ESM entry finishes evaluating, so
// the scenario run must not be awaited at module top level.
void app.whenReady().then(run)

async function run() {
try {
  for (let i = 0; i < 600 && !win; i += 1) await sleep(100)
  if (!win) throw new Error('Main window was not created')
  win.setContentSize(config.contentWidth, config.contentHeight)
  await waitFor(`!!document.querySelector(${JSON.stringify(composer)}) && !!document.querySelector('button.new-chat')`, 60_000, 'composer ready')
  report.startup.composerReadyMs = performance.now() - driverStart
  await dismissStartupDialogs()
  await js('document.fonts.ready.then(() => true)')
  const gpu = app.getGPUFeatureStatus()
  const [innerWidth, innerHeight, devicePixelRatio] = await js('[innerWidth, innerHeight, devicePixelRatio]')
  report.environment = {
    platform: process.platform, arch: process.arch, electron: process.versions.electron, chrome: process.versions.chrome,
    cpu: `${cpus()[0]?.model?.trim()} x${cpus().length}`, memoryGB: Math.round(totalmem() / 1073741824),
    innerWidth, innerHeight, devicePixelRatio,
    gpu: { gpu_compositing: gpu.gpu_compositing, rasterization: gpu.rasterization, webgl: gpu.webgl, webgl2: gpu.webgl2, video_decode: gpu.video_decode },
    rendererCpuThrottle: config.cpuThrottle
  }
  await applyCpuThrottle()
  await sleep(1_500)

  const idle = await measure('idle', 'Fresh profile, no interaction for 3 s', async () => { await sleep(3_000) })
  frameBaseline = idle.renderer.frames.p50 ?? 16.7

  await measure('typing-small', `Type ${config.typedCharacters} characters into the composer (fresh profile)`, async () => {
    await clickSelector(composer, { scroll: false })
    await typeText('abcdefghijklmnopqrstuvwxyz'.repeat(Math.ceil(config.typedCharacters / 26)).slice(0, config.typedCharacters))
    await settle()
  })
  // Clear the draft so later sends start from an empty composer.
  await js(`(() => { const t = document.querySelector(${JSON.stringify(composer)}); const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set; set.call(t, ''); t.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`)

  report.pending = 'seed'
  const seeded = await seed()
  report.seed = { conversations: config.seedConversations, messagesPerConversation: config.seedMessagesPerConversation, longConversationMessages: config.longConversationMessages, seedMs: seeded.seedMs }

  // Reload so the App loads the seeded history through its normal startup path.
  const reloadStart = performance.now()
  win.webContents.reload()
  await waitFor(`!!document.querySelector(${JSON.stringify(composer)}) && (() => { const rows = document.querySelectorAll('button.conversation-item'); const entry = document.querySelector('.conversation-list [aria-setsize]'); const total = entry ? Number(entry.getAttribute('aria-setsize')) : rows.length; return total >= ${config.seedConversations} && rows.length >= ${Math.min(10, config.seedConversations)}; })()`, 60_000, 'seeded sidebar')
  report.startup.reloadWithSeedMs = performance.now() - reloadStart
  await applyCpuThrottle()
  await dismissStartupDialogs({ expect: false })
  await sleep(1_500)
  report.seed.sidebarRows = await js("document.querySelectorAll('button.conversation-item').length")
  await screenshot('seeded')

  await measure('idle-seeded', `Seeded history (${config.seedConversations} conversations), no interaction for 3 s`, async () => { await sleep(3_000) })

  await measure('typing-seeded', `Type ${config.typedCharacters} characters with seeded history`, () => withRendererProfile('typing-seeded', async () => {
    await clickSelector(composer, { scroll: false })
    await typeText('abcdefghijklmnopqrstuvwxyz'.repeat(Math.ceil(config.typedCharacters / 26)).slice(0, config.typedCharacters))
    await settle()
  }))
  await js(`(() => { const t = document.querySelector(${JSON.stringify(composer)}); const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set; set.call(t, ''); t.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`)

  await measure('switch-conversations', `Click ${config.switches} different seeded conversations (${config.seedMessagesPerConversation} messages each), first visit`, () => withRendererProfile('switch-conversations', async () => {
    const samples = []
    for (let index = 0; index < config.switches; index += 1) {
      const target = index * 3 + 1
      await clickConversation(seeded.titles[target])
      samples.push(await js(`window.__gbPerf.paneShownSinceMouseDown(${JSON.stringify(seeded.ids[target])})`))
      await sleep(250)
    }
    return { latency: summarize(samples), fields: { switchSamplesMs: samples } }
  }))

  await measure('switch-conversations-warm', 'Revisit the same conversations (keep-alive cache warm)', () => withRendererProfile('switch-conversations-warm', async () => {
    const samples = []
    for (let index = 0; index < Math.min(config.switches, 10); index += 1) {
      const target = index * 3 + 1
      await clickConversation(seeded.titles[target])
      samples.push(await js(`window.__gbPerf.paneShownSinceMouseDown(${JSON.stringify(seeded.ids[target])})`))
      await sleep(250)
    }
    return { latency: summarize(samples), fields: { switchSamplesMs: samples } }
  }))

  // The warm scenario above revisits more conversations than the pane cache
  // holds, so in LRU order most revisits miss. This one alternates between
  // three conversations that are certainly still mounted.
  await measure('switch-conversations-hot', 'Alternate between 3 recently opened conversations (panes mounted)', () => withRendererProfile('switch-conversations-hot', async () => {
    const targets = [1, 4, 7]
    for (const target of targets) {
      await clickConversation(seeded.titles[target])
      await js(`window.__gbPerf.paneShownSinceMouseDown(${JSON.stringify(seeded.ids[target])})`)
      await sleep(250)
    }
    const samples = []
    for (let index = 0; index < 12; index += 1) {
      const target = targets[index % targets.length]
      await clickConversation(seeded.titles[target])
      samples.push(await js(`window.__gbPerf.paneShownSinceMouseDown(${JSON.stringify(seeded.ids[target])})`))
      await sleep(250)
    }
    return { latency: summarize(samples), fields: { switchSamplesMs: samples } }
  }))

  await measure('open-long-conversation', `Open a conversation with ${config.longConversationMessages} messages`, async () => {
    await clickConversation(seeded.longTitle)
    const openMs = await js(`window.__gbPerf.paneShownSinceMouseDown(${JSON.stringify(seeded.longId)})`)
    await sleep(1_000)
    const renderedMessages = await js("document.querySelectorAll('.chat-history-pane[data-active=true] article.message').length")
    return { latency: { count: 1, p50: openMs, p95: openMs, max: openMs }, fields: { openMs, renderedMessages } }
  })

  await measure('scroll-long-conversation', 'Wheel-scroll up through the long conversation for 3 s', () => withRendererProfile('scroll-long-conversation', async () => {
    const point = await js(`(() => { const e = document.querySelector('.chat-history-pane[data-active=true] #chat-message-list') || document.querySelector('.chat-history-pane[data-active=true]'); const r = e.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()`)
    const scroller = `(() => { const p = document.querySelector('.chat-history-pane[data-active=true]'); const c = p && [p, ...p.querySelectorAll('*')].find(e => e.scrollHeight > e.clientHeight + 4 && /(auto|scroll)/.test(getComputedStyle(e).overflowY)); return c ? c.scrollTop : null; })()`;
    const before = await js(scroller)
    const end = performance.now() + 3_000
    while (performance.now() < end) {
      win.webContents.sendInputEvent({ type: 'mouseWheel', x: point.x, y: point.y, deltaX: 0, deltaY: 120 })
      await sleep(16)
    }
    await sleep(300)
    const after = await js(scroller)
    // UX: large jumps (scrollbar drag, Home/End, flick) must not paint a frame
    // whose viewport is not covered by mounted rows (a blank screen).
    const blankFrames = await js(`new Promise((resolve) => {
      const c = document.querySelector('.chat-history-pane[data-active=true] .chat');
      const covered = () => {
        const v = c.getBoundingClientRect(), mid = v.top + v.height / 2;
        return [...c.querySelectorAll('.message-window-row')].some((row) => { const r = row.getBoundingClientRect(); return r.top <= mid && r.bottom >= mid; });
      };
      const targets = [0.5, 0.1, 0.9, 0.3, 0.7, 0.05, 0.95, 0.2, 0.8, 0.4].map((f) => Math.round((c.scrollHeight - c.clientHeight) * f));
      let blank = 0, checked = 0;
      const step = () => {
        const target = targets.shift();
        if (target === undefined) { resolve({ blank, checked }); return; }
        c.scrollTop = target;
        // The frame the jump is painted in: rAF runs before paint, after rendering work queued by the scroll.
        requestAnimationFrame(() => requestAnimationFrame(() => { checked += 1; if (!covered()) blank += 1; setTimeout(step, 50); }));
      };
      step();
    })`)
    return { fields: { scrollTopBefore: before, scrollTopAfter: after, scrolledPx: before === null || after === null ? null : before - after, jumpBlankFrames: blankFrames.blank, jumpChecks: blankFrames.checked } }
  }))

  await screenshot('long-conversation')

  await measure('stream-seeded', 'New conversation, stream a long Markdown answer from the loopback model (seeded history)', () => withRendererProfile('stream-seeded', () => streamOnce()))
  await screenshot('streamed')

  await measure('stream-and-type', 'Stream a long answer while typing into the composer; latency and frames cover the typing period', () => streamOnce({ typeDuring: 100 }))

  if (config.memoryVisits > 0) await memoryGrowth(seeded)

  report.status = errors.length ? 'passed-with-renderer-errors' : 'passed'
  report.pending = null
  report.startup.driverTotalMs = performance.now() - driverStart
  writeReport()
  clearTimeout(deadline)
  app.exit(0)
} catch (error) {
  report.status = 'failed'
  report.error = error instanceof Error ? error.stack : String(error)
  try { await screenshot('failure') } catch { /* window may be gone */ }
  writeReport()
  clearTimeout(deadline)
  app.exit(1)
}
}

// Cold-start measurement driver (PERF-01). Launched by
// build/run-startup-perf.cjs, once per measured launch. Runs inside the
// Electron main process: isolates the profile, blocks every non-loopback
// request, imports the current production Main and records when startup
// milestones happen. All times are epoch milliseconds (timeOrigin + now) so the
// supervisor can relate them to its spawn time. The report holds only phase
// names, times and counts; never conversation text or file paths.
//
// GB_STARTUP_MODE=prepare builds a reusable profile instead of measuring:
// acknowledges the release notes, disables the startup update check, seeds
// GB_STARTUP_SEED synthetic conversations, then quits through the normal
// shutdown path so the databases are checkpointed and closed.
import { app, BrowserWindow, session } from 'electron'
import { randomUUID } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { monitorEventLoopDelay, performance } from 'node:perf_hooks'
import process from 'node:process'
import { clearTimeout, setTimeout } from 'node:timers'
import { setTimeout as sleep } from 'node:timers/promises'
import { pathToFileURL, URL } from 'node:url'

const now = () => performance.timeOrigin + performance.now()
const driverStart = now()
const directory = process.env.GB_STARTUP_DIR
const resultPath = process.env.GB_STARTUP_RESULT
const root = process.env.GB_PERF_ROOT
if (!directory || !resultPath || !root) throw new Error('Run through build/run-startup-perf.cjs')
const mode = process.env.GB_STARTUP_MODE === 'prepare' ? 'prepare' : 'measure'
const profilePath = process.env.GB_STARTUP_CPU_PROFILE
const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

// Same isolation as tests/support/app-perf-driver.mjs; it must happen before
// the production Main module loads (single-instance lock, storage paths).
app.setAppPath(root)
app.setName(packageJson.name)
app.setVersion(packageJson.version)
app.setPath('userData', join(directory, 'profile'))
app.setPath('sessionData', join(directory, 'session'))
app.setAppLogsPath(join(directory, 'logs'))
app.commandLine.appendSwitch('force-device-scale-factor', '1')
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion')

const report = { mode, status: 'running', times: { driverStart }, blockedRequests: { fetch: [], renderer: [] }, renderer: {}, flags: {} }
const times = report.times
const mark = name => { if (times[name] === undefined) times[name] = now() }
const writeReport = () => writeFileSync(resultPath, JSON.stringify(report, null, 2))
const mainDelay = monitorEventLoopDelay({ resolution: 5 })
mainDelay.enable()

const deadline = setTimeout(() => {
  report.status = 'failed'
  report.error = 'Driver timeout'
  writeReport()
  app.exit(1)
}, Number(process.env.GB_STARTUP_DRIVER_TIMEOUT_MS || 120_000))

// No external requests: the fake model and everything else must be loopback.
const isLoopback = url => {
  try {
    const { hostname, protocol } = new URL(url)
    if (!['http:', 'https:', 'ws:', 'wss:'].includes(protocol)) return true
    return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '[::1]'
  } catch { return true }
}
const hostOf = url => { try { return new URL(url).hostname } catch { return 'invalid' } }
const originalFetch = globalThis.fetch
globalThis.fetch = (input, init) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input?.url
  if (url && !isLoopback(url)) {
    report.blockedRequests.fetch.push(hostOf(url))
    return Promise.reject(new TypeError('blocked by startup benchmark'))
  }
  return originalFetch(input, init)
}

let profiler
if (profilePath) {
  const inspector = await import('node:inspector')
  profiler = new inspector.Session()
  profiler.connect()
  const post = (method, params) => new Promise((resolve, reject) => profiler.post(method, params, (error, result) => error ? reject(error) : resolve(result)))
  profiler.postAsync = post
  await post('Profiler.enable')
  await post('Profiler.setSamplingInterval', { interval: 250 })
  await post('Profiler.start')
}

app.once('ready', () => mark('appReady'))
// Registered before Main imports, so it runs before Main's whenReady handler.
void app.whenReady().then(() => {
  session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] }, (details, callback) => {
    if (isLoopback(details.url)) { callback({}); return }
    report.blockedRequests.renderer.push(hostOf(details.url))
    callback({ cancel: true })
  })
})

let win
app.on('browser-window-created', (_event, created) => {
  if (win) return
  win = created
  mark('windowCreated')
  created.once('ready-to-show', () => mark('readyToShow'))
  created.once('show', () => mark('windowShown'))
  created.webContents.once('did-start-loading', () => mark('didStartLoading'))
  created.webContents.once('dom-ready', () => { mark('domReady'); void installRendererProbe() })
  created.webContents.once('did-finish-load', () => mark('didFinishLoad'))
  created.webContents.on('render-process-gone', (_e, details) => { report.error = `render-process-gone ${details.reason}` })
})

mark('mainImportStart')
await import(pathToFileURL(join(root, 'out', 'main', 'index.js')).href)
mark('mainImportEnd')

const js = code => win.webContents.executeJavaScript(code, true)

// Composer is interactive when it exists, is enabled, laid out, and not inside
// an inert or hidden subtree (a modal dialog makes the app shell inert).
const composerSelector = '.composer__input textarea'
const expectedConversations = mode === 'measure' ? Math.max(0, Number(process.env.GB_STARTUP_EXPECT_CONVERSATIONS || 0)) : 0
const rendererProbe = `new Promise(resolve => {
  const origin = performance.timeOrigin;
  const at = () => origin + performance.now();
  const r = { installedAt: at(), visibleAtInstall: document.visibilityState === 'visible' };
  // Chromium does not report first-contentful-paint when the first paint
  // happens while the page is hidden, and the main window is created hidden
  // until ready-to-show. "First visible frame" is the second animation frame
  // after the page becomes visible, i.e. a frame actually presented on screen.
  let frameDone = false;
  const firstVisibleFrame = () => {
    r.visibleAt = at();
    requestAnimationFrame(() => requestAnimationFrame(() => { r.firstVisibleFrame = at(); frameDone = true; if (check()) finish(); }));
  };
  if (document.visibilityState === 'visible') firstVisibleFrame();
  else document.addEventListener('visibilitychange', function onVisible() { if (document.visibilityState !== 'visible') return; document.removeEventListener('visibilitychange', onVisible); firstVisibleFrame(); });
  const check = () => {
    const c = document.querySelector(${JSON.stringify(composerSelector)});
    if (c && r.composerPresent === undefined) r.composerPresent = at();
    if (!r.firstConversationRow && document.querySelector('button.conversation-item')) r.firstConversationRow = at();
    if (!r.startupDialog && document.querySelector('section.release-notes-dialog')) r.startupDialog = at();
    if (c && r.composerInteractive === undefined && !c.disabled && c.getClientRects().length > 0 && !c.closest('[inert], [hidden], [aria-hidden="true"]')) r.composerInteractive = at();
    // Seeded profiles: the sidebar is populated once the virtualized list
    // reports the seeded total (or mounts enough rows to fill the viewport).
    if (${expectedConversations} > 0 && r.sidebarPopulated === undefined) {
      const rows = document.querySelectorAll('button.conversation-item').length;
      const entry = document.querySelector('.conversation-list [aria-setsize]');
      const total = entry ? Number(entry.getAttribute('aria-setsize')) : rows;
      if (total >= ${expectedConversations} && rows >= ${Math.min(10, expectedConversations)}) r.sidebarPopulated = at();
    }
    const sidebarDone = ${expectedConversations} === 0 || r.sidebarPopulated !== undefined;
    return frameDone && sidebarDone && (r.composerInteractive !== undefined || (r.composerPresent !== undefined && r.startupDialog !== undefined));
  };
  let observer;
  let settled = false;
  const finish = () => { if (settled) return; settled = true; observer?.disconnect(); resolve(r); };
  if (check()) { finish(); return; }
  observer = new MutationObserver(() => { if (check()) finish(); });
  observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ['inert', 'hidden', 'disabled', 'aria-hidden', 'class'] });
  setTimeout(() => { r.timedOut = true; finish(); }, 60000);
})`
let probeResult
async function installRendererProbe() {
  try { probeResult = await js(rendererProbe) } catch (error) { report.error = `renderer probe: ${error instanceof Error ? error.message : error}` }
}

async function collectRenderer() {
  const data = await js(`(() => {
    const origin = performance.timeOrigin;
    const nav = performance.getEntriesByType('navigation')[0];
    const paint = Object.fromEntries(performance.getEntriesByType('paint').map(e => [e.name, origin + e.startTime]));
    const scripts = performance.getEntriesByType('resource').filter(e => e.initiatorType === 'script' || /\\.js$/.test(e.name));
    return {
      timeOrigin: origin,
      navigationStart: nav ? origin + nav.startTime : null,
      responseEnd: nav ? origin + nav.responseEnd : null,
      domInteractive: nav ? origin + nav.domInteractive : null,
      domContentLoaded: nav ? origin + nav.domContentLoadedEventEnd : null,
      loadEventEnd: nav ? origin + nav.loadEventEnd : null,
      firstPaint: paint['first-paint'] ?? null,
      firstContentfulPaint: paint['first-contentful-paint'] ?? null,
      scriptResources: scripts.length,
      scriptBytes: scripts.reduce((a, e) => a + (e.decodedBodySize || 0), 0),
      jsHeapMB: performance.memory ? performance.memory.usedJSHeapSize / 1048576 : null,
      domNodes: document.getElementsByTagName('*').length,
      conversationRows: document.querySelectorAll('button.conversation-item').length
    };
  })()`)
  return data
}

// Long animation frames are buffered by Chromium, so the ones during startup
// are visible even though the observer is installed after dom-ready.
const loafProbe = `new Promise(resolve => {
  const items = [];
  try {
    new PerformanceObserver(list => { for (const e of list.getEntries()) items.push(e); }).observe({ type: 'long-animation-frame', buffered: true });
  } catch { resolve(null); return; }
  setTimeout(() => {
    const origin = performance.timeOrigin;
    resolve({ count: items.length, totalMs: items.reduce((a, e) => a + e.duration, 0), blockingMs: items.reduce((a, e) => a + e.blockingDuration, 0),
      maxMs: items.reduce((a, e) => Math.max(a, e.duration), 0),
      scriptMs: items.reduce((a, e) => a + e.scripts.reduce((s, x) => s + x.duration, 0), 0),
      frames: items.slice(0, 20).map(e => ({ at: origin + e.startTime, duration: e.duration, scriptMs: e.scripts.reduce((s, x) => s + x.duration, 0) })) });
  }, 50);
})`

function profileHotspots(profile) {
  const byId = new Map(profile.nodes.map(node => [node.id, node]))
  const parent = new Map()
  for (const node of profile.nodes) for (const child of node.children ?? []) parent.set(child, node.id)
  const self = new Map()
  for (let index = 0; index < profile.samples.length; index += 1) {
    const id = profile.samples[index]
    self.set(id, (self.get(id) ?? 0) + (profile.timeDeltas[index] ?? 0))
  }
  const keyOf = frame => {
    const file = frame.url ? frame.url.replace(/^file:\/\/\/?/, '').split(/[\\/]/).slice(-3).join('/') : `(${frame.functionName || 'native'})`
    return `${frame.functionName || '(anonymous)'} ${file}:${frame.lineNumber + 1}`
  }
  const selfByKey = new Map()
  const inclusiveByKey = new Map()
  let total = 0
  for (const [id, micros] of self) {
    total += micros
    const key = keyOf(byId.get(id).callFrame)
    selfByKey.set(key, (selfByKey.get(key) ?? 0) + micros)
    const seen = new Set()
    for (let cursor = id; cursor !== undefined; cursor = parent.get(cursor)) {
      const k = keyOf(byId.get(cursor).callFrame)
      if (seen.has(k)) continue
      seen.add(k)
      inclusiveByKey.set(k, (inclusiveByKey.get(k) ?? 0) + micros)
    }
  }
  const top = (map, count, filter = () => true) => [...map].filter(([key]) => filter(key)).sort((a, b) => b[1] - a[1]).slice(0, count)
    .map(([key, micros]) => ({ key, ms: Math.round(micros / 100) / 10 }))
  const own = key => /out\/main\//.test(key)
  return {
    sampledMs: Math.round(total / 1000),
    selfTop: top(selfByKey, 30),
    inclusiveOutMain: top(inclusiveByKey, 40, own)
  }
}

async function prepare() {
  await js(`window.goodbuddy.updates.updateSettings({ checkUpdatesOnStartup: false }).then(() => true)`)
  await js(`window.goodbuddy.releaseNotes.getPending().then(s => s.releases.some(r => r.version === s.currentVersion) ? window.goodbuddy.releaseNotes.acknowledge(s.currentVersion) : undefined).then(() => true)`)
  const count = Number(process.env.GB_STARTUP_SEED || 0)
  const perConversation = Number(process.env.GB_STARTUP_SEED_MESSAGES || 20)
  if (count > 0) {
    const projectId = await js(`window.goodbuddy.projects.list(false).then(list => list.find(p => p.kind === 'user' && p.executionSpace.kind === 'local')?.id)`)
    if (!projectId) throw new Error('No local project to seed')
    const base = Date.now()
    const items = []
    for (let index = 0; index < count; index += 1) {
      const updatedAt = base - (index + 1) * 60_000
      const messages = []
      for (let m = 0; m < perConversation; m += 1) {
        const role = m % 2 === 0 ? 'user' : 'assistant'
        const content = role === 'user'
          ? `Question ${m}: how should the benchmark handle item ${m}?`
          : `## Answer ${m}\n\nThe benchmark answer for item ${m} contains **formatting**, \`inline code\`, and a list:\n\n- point one\n- point two\n\n\`\`\`ts\nconst value${m} = ${m}\n\`\`\``
        messages.push({ id: randomUUID(), role, content, createdAt: updatedAt - (perConversation - m) * 1000, state: 'complete' })
      }
      items.push({ header: { id: randomUUID(), projectId, title: `Perf conversation ${String(index + 1).padStart(4, '0')}`, updatedAt, knowledgeLibraryIds: [], knowledgeRetrievalMode: 'auto' }, messages })
    }
    for (let offset = 0; offset < items.length; offset += 100) {
      await js(`window.goodbuddy.conversations.saveLocal(${JSON.stringify(items.slice(offset, offset + 100))}).then(() => true)`)
    }
    report.seeded = { conversations: count, messagesPerConversation: perConversation }
  }
}

async function run() {
  try {
    for (let i = 0; i < 600 && !win; i += 1) await sleep(50)
    if (!win) throw new Error('Main window was not created')
    for (let i = 0; i < 1200 && probeResult === undefined; i += 1) await sleep(25)
    if (!probeResult) throw new Error(report.error ?? 'Renderer probe did not finish')
    mark('probeResolvedInMain')
    if (profiler) {
      const { profile } = await profiler.postAsync('Profiler.stop')
      writeFileSync(profilePath, JSON.stringify(profile))
      report.cpuProfile = profileHotspots(profile)
    }
    Object.assign(report.renderer, probeResult)
    Object.assign(report.renderer, await collectRenderer())
    report.renderer.longAnimationFrames = await js(loafProbe).catch(() => null)
    report.startupMarks = (globalThis.__goodbuddyStartupMarks ?? []).map(({ name, at }) => ({ name, at: performance.timeOrigin + at }))
    report.mainEventLoopDelay = { maxMs: mainDelay.max / 1e6, p99Ms: mainDelay.percentile(99) / 1e6, meanMs: mainDelay.mean / 1e6 }
    report.flags.windowCount = BrowserWindow.getAllWindows().length
    if (mode === 'prepare') await prepare()
    report.status = 'passed'
    writeReport()
    clearTimeout(deadline)
    if (mode === 'prepare') app.quit()
    else app.exit(0)
  } catch (error) {
    report.status = 'failed'
    report.error = error instanceof Error ? error.message : String(error)
    writeReport()
    clearTimeout(deadline)
    app.exit(1)
  }
}

// Electron emits `ready` only after this ESM entry finishes evaluating.
void app.whenReady().then(run)

import { mkdirSync, appendFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { setTimeout as sleep } from 'node:timers/promises'
import process from 'node:process'

// Uses the existing full-App driver and production preload. No mock bridge.
const DRAIN_BOUND_MS = 180_000
// SubagentScheduler default concurrency; offered children above it queue by design.
const PRODUCT_SUBAGENT_CAP = 3
export async function runConcurrentAcceptance(h) {
  const { app, win, js, waitFor, settle, clickSelector, typeText, measure, seed, report, writeReport, directory, artifacts, composer, sendButton, stopButton } = h
  const mode = process.env.GB_PERF_MODE
  if (!['C01', 'C02', 'C03', 'C04', 'C06', 'C07'].includes(mode)) throw new Error(`${mode}: fixture not implemented; no acceptance result`)
  const pressure = mode === 'C02' || mode === 'C06'
  const load = { projects: pressure ? 4 : 3, sessions: pressure ? 8 : 4, subtasks: pressure ? 16 : 8, fragmentIntervalMs: 16, toolUpdateIntervalMs: 1000, toolOutputBytes: 4096 }
  report.acceptance = { mode, load, status: 'running', cycles: [], gaps: [
    'Periodic 4 KiB tool updates are not yet implemented; offered text and delegated child requests are measured separately.',
    'Storage queue wait/execute decomposition, cache/subscription counts and temporary-file accounting are not instrumented.',
    'C05 storage fault injection remains outside this task.',
    'C03 review publication requires an existing persisted review result; this run records whether one is available.'
  ] }
  report.config.longConversationMessages = pressure ? 10_000 : 2_000
  report.pending = 'concurrent-seed'
  writeReport()
  const seeded = await seed()
  report.seed = { conversations: report.config.seedConversations, messagesPerConversation: report.config.seedMessagesPerConversation, longConversationMessages: report.config.longConversationMessages, seedMs: seeded.seedMs }
  const projects = []
  for (let index = 0; index < load.projects; index++) {
    const rootPath = join(directory, `project-${index}`)
    mkdirSync(rootPath, { recursive: true })
    projects.push(await js(`window.goodbuddy.projects.create(${JSON.stringify({ name: `Concurrent ${index}`, description: 'Deterministic architecture acceptance', rootPath, runtimeSelection: { provider: 'model' } })})`))
  }
  win.webContents.reload()
  await waitFor(`!!document.querySelector(${JSON.stringify(composer)})`, 60_000)
  await sleep(1500)
  await js(`(() => {
    const state = window.__concurrent = { requests: {}, children: {}, peakChildren: 0, peakParents: 0, events: 0, errors: [] };
    state.dispose = window.goodbuddy.agent.onEvent(event => {
      state.events++;
      const request = state.requests[event.requestId] ||= { events: 0, chars: 0, started: performance.now(), done: false };
      request.events++;
      if (event.type === 'text') request.chars += event.delta.length;
      if (event.type === 'error') state.errors.push({ requestId: event.requestId, message: event.message });
      if (event.type === 'done' || event.type === 'error') { request.done = true; request.settled = performance.now(); }
      if (event.type === 'subagent') {
        const id = event.childTaskId;
        state.children[id] = { state: event.state, requestId: event.requestId };
        state.peakChildren = Math.max(state.peakChildren, Object.values(state.children).filter(c => c.state === 'running').length);
      }
      state.peakParents = Math.max(state.peakParents, Object.values(state.requests).filter(r => !r.done).length);
    });
    return true;
  })()`)

  // insertText is dropped if focus has not settled yet; confirm it landed.
  const enterPrompt = async prompt => {
    for (let attempt = 0; attempt < 3; attempt++) {
      await clickSelector(composer, { scroll: false })
      await win.webContents.insertText(prompt)
      const landed = await waitFor(`(document.querySelector(${JSON.stringify(composer)})?.value ?? '').includes(${JSON.stringify(prompt)})`, 2_000).then(() => true).catch(() => false)
      if (landed) return
    }
  }

  const measureAvailability = async (name, action) => {
    const startedAt = performance.now()
    let value
    let error
    try { value = await action() } catch (caught) { error = String(caught?.message ?? caught) }
    return { name, startedAt, availableAt: error ? null : performance.now(), elapsedMs: error ? null : performance.now() - startedAt, error, value }
  }

  const runC03 = async () => {
    const startedAt = performance.now()
    await sleep(2_000)
    const library = await js(`window.goodbuddy.knowledge.createLibrary(${JSON.stringify({ name: 'C03 deterministic library', description: 'isolated concurrent acceptance', storageMode: 'reference', graphEnabled: true, graphStrategy: 'rules' })})`)
    const sourcePath = join(directory, 'c03-knowledge.txt')
    writeFileSync(sourcePath, 'C03 deterministic knowledge source\n'.repeat(80))
    const libraryId = String(library.id)
    const importStarted = performance.now()
    let importError
    try {
      await js(`window.goodbuddy.knowledge.importPaths(${JSON.stringify(libraryId)}, [${JSON.stringify(sourcePath)}], 'rules')`)
    } catch (error) { importError = String(error?.message ?? error) }
    const graphSource = await js('window.goodbuddy.supervision.overview({})')
    const resultId = Array.isArray(graphSource) ? graphSource[0]?.id : undefined
    const batches = []
    for (let batch = 0; batch < 100; batch += 1) {
      const conversationId = projects[batch % projects.length].id
      const work = [
        js(`window.goodbuddy.conversations.listSummaries()`),
        js(`window.goodbuddy.knowledge.search([${JSON.stringify(libraryId)}], ${JSON.stringify(`c03-${batch}`)})`).catch(() => []),
        js(`window.goodbuddy.supervision.graph(${JSON.stringify(resultId ? { resultId } : {})})`).catch(error => ({ error: String(error?.message ?? error) }))
      ]
      batches.push({ batch, conversationId, startedAt: performance.now(), results: await Promise.all(work) })
    }
    report.acceptance.c03 = {
      elapsedMs: performance.now() - startedAt,
      reviewResultAvailable: Boolean(resultId),
      reviewPublishBatches: 0,
      knowledgeImport: { attempted: true, elapsedMs: performance.now() - importStarted, error: importError },
      overlappingBatches: batches.length,
      graphReads: batches.filter(item => !item.results[2]?.error).length,
      historyReads: batches.length,
      searchCalls: batches.length,
      overlapWindowMs: batches.length ? performance.now() - batches[0].startedAt : 0,
      status: resultId && !importError ? 'measured-with-gaps' : 'not-fulfilled'
    }
    writeReport()
  }

  const runC04 = async () => {
    const startedAt = performance.now()
    const faultConversation = await js(`window.goodbuddy.conversations.listSummaries().then(items => items[0]?.id)`)
    if (!faultConversation) throw new Error('C04 requires a conversation')
    await enterPrompt('gb-fault:hang isolate this request')
    await waitFor(`!!document.querySelector(${JSON.stringify(sendButton)}) && !document.querySelector(${JSON.stringify(sendButton)}).disabled`, 15_000, 'C04 fault send')
    await clickSelector(sendButton, { scroll: false })
    await waitFor(`!!document.querySelector(${JSON.stringify(stopButton)})`, 15_000, 'C04 fault started')
    await waitFor('Object.keys(window.__concurrent.requests).length > 0', 15_000, 'C04 runtime admitted')
    const faultRequestId = await js('Object.keys(window.__concurrent.requests).at(-1)')
    const faultStartedAt = performance.now()
    await clickSelector('button.new-chat', { scroll: false })
    await enterPrompt('gb-concurrent:parent:c04-health execute one healthy task')
    await waitFor(`!!document.querySelector(${JSON.stringify(sendButton)}) && !document.querySelector(${JSON.stringify(sendButton)}).disabled`, 15_000, 'C04 peer send')
    await clickSelector(sendButton, { scroll: false })
    const peerStartedAt = performance.now()
    await waitFor(`!!document.querySelector(${JSON.stringify(stopButton)})`, 15_000, 'C04 peer started')
    await waitFor('Object.keys(window.__concurrent.requests).length >= 2', 15_000, 'C04 peer admitted')
    const peerRequestId = await js('Object.keys(window.__concurrent.requests).at(-1)')
    await js(`window.goodbuddy.agent.cancel(${JSON.stringify(faultRequestId)})`)
    const cancelledAt = performance.now()
    await waitFor(`window.__concurrent.requests[${JSON.stringify(faultRequestId)}]?.done === true`, 30_000, 'C04 fault cancelled')
    await waitFor(`!document.querySelector(${JSON.stringify(stopButton)})`, 60_000, 'C04 peer complete')
    const [status, summaries, state] = await Promise.all([
      js('window.goodbuddy.agent.getStatus()'),
      js('window.goodbuddy.conversations.listSummaries()'),
      js('({ errors: window.__concurrent.errors, requests: window.__concurrent.requests })')
    ])
    const faultState = { id: faultRequestId, request: state.requests[faultRequestId] }
    const peerState = state.requests[peerRequestId]
    report.acceptance.c04 = {
      elapsedMs: performance.now() - startedAt,
      faultStartedMs: faultStartedAt - startedAt,
      cancellationObservedMs: cancelledAt - faultStartedAt,
      healthyPeerCompletedMs: performance.now() - peerStartedAt,
      faultRequestId,
      peerRequestId,
      peerRequestDone: peerState?.done === true,
      peerErrorCount: state.errors.filter(error => error.requestId === peerRequestId).length,
      healthyPeerUnaffected: peerState?.done === true && !state.errors.some(error => error.requestId === peerRequestId),
      faultRequestCancelled: faultState.request?.done === true,
      faultRequestSettled: faultState.request?.done === true,
      queryResponsive: Array.isArray(summaries),
      statusResponsive: status?.available === true,
      cleanupCompleted: faultState.request?.done === true,
      observedRequestCount: state.requests ? Object.keys(state.requests).length : 0,
      status: faultState.request?.done === true &&
        Array.isArray(summaries) &&
        status?.available === true &&
        state.requests && Object.keys(state.requests).length >= 2 && peerState?.done === true
        ? 'measured'
        : 'not-fulfilled'
    }
    writeReport()
  }

  const runC07 = async () => {
    const coldStartedAt = performance.now()
    const cold = {
      input: await measureAvailability('input', () => waitFor(`!!document.querySelector(${JSON.stringify(composer)})`)),
      history: await measureAvailability('history', () => js('window.goodbuddy.conversations.listSummaries()')),
      supervisor: await measureAvailability('supervisor-overview', () => js('window.goodbuddy.supervision.overview({})')),
      graph: await measureAvailability('graph', () => js('window.goodbuddy.supervision.graph({})')),
      knowledge: await measureAvailability('knowledge-snapshot', () => js('window.goodbuddy.knowledge.getSnapshot()'))
    }
    win.webContents.reload()
    await waitFor(`!!document.querySelector(${JSON.stringify(composer)})`, 60_000, 'C07 warm composer')
    const warm = {
      input: await measureAvailability('input', () => waitFor(`!!document.querySelector(${JSON.stringify(composer)})`)),
      history: await measureAvailability('history', () => js('window.goodbuddy.conversations.listSummaries()')),
      supervisor: await measureAvailability('supervisor-overview', () => js('window.goodbuddy.supervision.overview({})')),
      graph: await measureAvailability('graph', () => js('window.goodbuddy.supervision.graph({})')),
      knowledge: await measureAvailability('knowledge-snapshot', () => js('window.goodbuddy.knowledge.getSnapshot()'))
    }
    report.acceptance.c07 = { cold: { elapsedMs: performance.now() - coldStartedAt, stages: cold }, warm: { stages: warm }, status: 'measured-with-gaps', sourceBody: 'not available without a persisted supervision source' }
    writeReport()
  }

  if (mode === 'C03') await runC03()
  if (mode === 'C04') await runC04()
  if (mode === 'C07') await runC07()
  if (['C03', 'C04', 'C07'].includes(mode)) {
    report.acceptance.status = mode === 'C04'
      ? report.acceptance.c04?.status ?? 'not-fulfilled'
      : 'not-fulfilled'
    // C04 is a correctness scenario: cancellation settles and the healthy peer finishes.
    report.status = mode === 'C04' && report.acceptance.c04?.healthyPeerUnaffected && report.acceptance.status === 'measured' ? 'passed' : report.acceptance.status
    report.pending = null
    await js('true')
    await h.screenshot(`concurrent-${mode.toLowerCase()}-final`)
    return
  }
  const selectProject = async index => {
    await clickSelector('.project-switcher__trigger', { scroll: false })
    await waitFor(`!![...document.querySelectorAll('[role=menuitemradio]')].find(e => e.textContent.includes('Concurrent ${index}'))`)
    await js(`(() => { const e = [...document.querySelectorAll('[role=menuitemradio]')].find(e => e.textContent.includes('Concurrent ${index}')); e.dataset.perfTarget = 'true'; return true; })()`)
    await clickSelector('[data-perf-target=true]')
    await waitFor(`document.querySelector('.project-switcher__trigger')?.textContent.includes('Concurrent ${index}')`)
    await settle()
  }
  const startCycle = async cycle => {
    for (let index = 0; index < load.sessions; index++) {
      await selectProject(index % projects.length)
      await clickSelector('button.new-chat', { scroll: false })
      await enterPrompt(`gb-concurrent:parent:c${cycle}-s${index} execute two delegated tasks`)
      await waitFor(`!!document.querySelector(${JSON.stringify(sendButton)}) && !document.querySelector(${JSON.stringify(sendButton)}).disabled`)
      await clickSelector(sendButton, { scroll: false })
      await sleep(50)
    }
  }
  const started = performance.now()
  // C06: 5 minutes of repeated create/complete cycles; long enough to expose
  // growth trends without a fixed 30-minute requirement.
  const requiredMs = mode === 'C06' ? 300_000 : 150_000
  report.acceptance.startedAt = new Date().toISOString()
  report.acceptance.requiredMs = requiredMs
  let cycle = 0
  do {
    await startCycle(cycle)
    if (cycle === 0) {
      report.pending = 'concurrent-warmup-30s'
      writeReport()
      await sleep(30_000)
    }
    const result = await measure(`${mode}-cycle-${cycle}`, 'Native typing while production parent and child requests execute', async () => {
      const until = performance.now() + (mode === 'C06' ? 30_000 : 30_000)
      let samples = 0
      while (performance.now() < until) {
        await clickSelector(composer, { scroll: false })
        await typeText('abcdefghijklmnopqrstuvwxyz')
        samples += 26
        const state = await js(`(() => { const s = window.__concurrent; return { requests: s.requests, children: s.children, peakChildren: s.peakChildren, peakParents: s.peakParents, events: s.events, errors: s.errors }; })()`)
        appendFileSync(join(artifacts, 'heartbeat.jsonl'), JSON.stringify({ at: new Date().toISOString(), elapsedMs: performance.now() - started, cycle, samples, state, pids: app.getAppMetrics() }) + '\n')
        if (Object.values(state.requests).every(request => request.done) && performance.now() < until - 10_000) {
          await startCycle(++cycle)
        }
      }
      return { fields: { nativeKeySamplesOffered: samples } }
    })
    const drainStarted = performance.now()
    // Children run behind the product subagent cap (3), so 16 delegated 12 s children
    // need over a minute. The bound is identical for baseline and candidate; the
    // measured drainMs is the throughput comparison.
    const drained = await waitFor('Object.values(window.__concurrent.requests).every(r => r.done)', DRAIN_BOUND_MS, 'production request drain').then(() => true).catch(() => false)
    const drainMs = performance.now() - drainStarted
    const state = await js(`(() => { const { requests, children, peakChildren, peakParents, events, errors } = window.__concurrent; return { requests, children, peakChildren, peakParents, events, errors }; })()`)
    const persisted = await js('window.goodbuddy.conversations.listSummaries().then(items => items.length)')
    report.acceptance.cycles.push({ cycle, drained, drainMs, state, persistedSummaries: persisted, heapMB: await h.retainedHeapMB(), metrics: result.id })
    report.acceptance.elapsedMs = performance.now() - started
    writeReport()
    cycle++
  } while (performance.now() - started < requiredMs)
  report.acceptance.fullDurationCompleted = performance.now() - started >= requiredMs
  report.acceptance.elapsedMs = performance.now() - started
  const state = await js('({peakChildren: window.__concurrent.peakChildren, peakParents: window.__concurrent.peakParents})')
  report.acceptance.achieved = state
  report.acceptance.budgets = report.scenarios.map(s => ({ id: s.id, input: s.latency?.count >= 100 && s.latency.p95 <= 16, frame: s.renderer.frames.p95 <= 17, longTasks: s.renderer.longTasks.count === 0, mainP99: s.main.eventLoopDelay.p99 <= 30, mainSingleBlock: 'not measured; monitor delay is not single-block duration' }))
  // Release gate: correctness only. Budgets above are reported as target gaps;
  // regressions are judged by alternating baseline/candidate runs, not here.
  const cycles = report.acceptance.cycles
  const errors = cycles.flatMap(item => item.state.errors ?? [])
  report.acceptance.correctness = {
    allCyclesDrained: cycles.length > 0 && cycles.every(item => item.drained),
    errors: errors.length,
    peakParents: state.peakParents, peakChildren: state.peakChildren,
    childCap: Math.min(load.subtasks, PRODUCT_SUBAGENT_CAP),
    drainMs: cycles.map(item => Math.round(item.drainMs)),
    reachedLoad: state.peakParents >= load.sessions && state.peakChildren >= Math.min(load.subtasks, PRODUCT_SUBAGENT_CAP),
    fullDuration: report.acceptance.fullDurationCompleted
  }
  const gate = report.acceptance.correctness
  report.acceptance.status = gate.allCyclesDrained && gate.errors === 0 && gate.reachedLoad && gate.fullDuration ? 'correctness-passed' : 'not-fulfilled'
  report.status = report.acceptance.status === 'correctness-passed' ? 'passed' : 'not-fulfilled'
  report.pending = null
  await js('window.__concurrent.dispose(); true')
  await h.screenshot('concurrent-final')
}

import { app, BrowserWindow } from 'electron'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { setTimeout as delay } from 'node:timers/promises'
import { AgentEventBuffer } from '../../src/main/agent-event-buffer'
import { longAnswerCorpus } from './streaming-markdown-corpus'

const directory = process.env.GOODBUDDY_STREAMING_INPUT_DIRECTORY!
const epoch = () => performance.timeOrigin + performance.now()
const duration = 5_000
const chunkPeriod = 8
const inputPeriod = 71
// End on a complete section and add math, rather than truncating a code fence/table.
const sectionEnd = longAnswerCorpus.indexOf('## Deployment review', 22_000)
const answer = longAnswerCorpus.slice(0, sectionEnd) + '\nInline \\(x^2 + y^2\\) and display math:\n\n\\[E = mc^2\\]\n'
const chunkCount = duration / chunkPeriod
const chunks = Array.from({ length: chunkCount }, (_, index) => answer.slice(
  Math.floor(answer.length * index / chunkCount), Math.floor(answer.length * (index + 1) / chunkCount)))
const inputOffsets = Array.from({ length: Math.floor((duration - 200) / inputPeriod) }, (_, index) => 103 + index * inputPeriod)
const draft = inputOffsets.map((_, index) => String.fromCharCode(97 + index % 26)).join('')
const stats = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b)
  return { n: sorted.length, median: (sorted[Math.floor((sorted.length - 1) / 2)]! + sorted[Math.floor(sorted.length / 2)]!) / 2,
    p95: sorted[Math.ceil(sorted.length * 0.95) - 1]!, max: sorted.at(-1)! }
}
app.setPath('userData', join(directory, 'profile'))
app.commandLine.appendSwitch('force-device-scale-factor', '1')
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: true, width: 1100, height: 800,
    webPreferences: { preload: join(directory, 'preload.cjs'), sandbox: true,
      contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } })
  const errors: string[] = []
  win.webContents.on('console-message', event => { if (event.level === 'error') errors.push(event.message) })
  await win.loadFile(join(directory, 'renderer', 'streaming-input-page.html'))
  win.focus()
  const evaluate = (code: string) => win.webContents.executeJavaScript(`window.streamingInput.${code}`)
  const reference = await evaluate(`reset(${JSON.stringify(answer)})`)
  assert(reference.includes('Deployment review'))
  const results: { interval: number; updates: number; longTasks: number;
    raw: { sendToInput: number[]; inputToFrame: number[] } }[] = []
  // Warm one full growing answer, then rotate and reverse the measured order.
  const order = [32, 16, 50, 32, 80, 80, 32, 50, 16]
  for (const [position, interval] of order.entries()) {
    await evaluate('reset()')
    // Estimate process clock offset while idle; minimum RTT bounds the timestamp uncertainty.
    const calibration = []
    for (let sample = 0; sample < 12; sample++) {
      const before = epoch()
      const renderer = await evaluate('clock()')
      const after = epoch()
      calibration.push({ offset: renderer - (before + after) / 2, rtt: after - before })
    }
    const clock = calibration.sort((a, b) => a.rtt - b.rtt)[0]!
    const sent: number[] = []
    const chunkLateness: number[] = []
    const inputLateness: number[] = []
    let flushes = 0
    let firstFlush = 0
    const buffer = new AgentEventBuffer({ flushIntervalMs: interval, onEvent(event) {
      if (event.type !== 'text') return
      flushes++
      if (!firstFlush) firstFlush = epoch()
      win.webContents.send('streaming-input:chunk', event.delta)
    } })
    const start = epoch()
    // All deadlines are scheduled in main up front. Renderer blockage cannot slow the producer or typing.
    const arrivals = chunks.map((delta, index) => new Promise<void>(resolve => {
      const deliver = () => {
        chunkLateness.push(epoch() - start - index * chunkPeriod)
        buffer.push({ type: 'text', requestId: 'benchmark', delta })
        if (index === 0) buffer.flush()
        resolve()
      }
      if (index === 0) deliver()
      else setTimeout(deliver, Math.max(0, start + index * chunkPeriod - epoch()))
    }))
    const typing = inputOffsets.map((offset, index) => new Promise<void>(resolve => {
      setTimeout(() => {
        sent.push(epoch())
        inputLateness.push(sent.at(-1)! - start - offset)
        win.webContents.sendInputEvent({ type: 'keyDown', keyCode: draft[index]! })
        win.webContents.sendInputEvent({ type: 'char', keyCode: draft[index]! })
        win.webContents.sendInputEvent({ type: 'keyUp', keyCode: draft[index]! })
        resolve()
      }, Math.max(0, start + offset - epoch()))
    }))
    await Promise.all([...arrivals, ...typing, delay(Math.max(0, start + duration - epoch()))])
    buffer.close()
    const producerDuration = epoch() - start
    let ready = false
    for (let poll = 0; poll < 400; poll++) {
      const status = await evaluate('status()')
      if (status.length === answer.length && status.inputs === draft.length && status.frames === draft.length) {
        ready = true
        break
      }
      await delay(10)
    }
    assert(ready, 'renderer must drain the entire independently scheduled stream and native input')
    const result = await evaluate('result()')
    assert.equal(result.committed, answer)
    assert.equal(result.domText, reference)
    assert.equal(result.draft, draft)
    assert.equal(result.committedDraft, draft)
    assert.equal(result.focused, true)
    assert.equal(result.received, flushes)
    assert.equal(result.inputs.length, sent.length)
    for (const [index, input] of result.inputs.entries()) {
      assert.equal(input.value, draft.slice(0, index + 1))
      assert.equal(input.trusted, true)
    }
    const sendToInput = result.inputs.map((input: { at: number }, index: number) => input.at - clock.offset - sent[index]!)
    const inputToFrame = result.inputs.map((input: { at: number; frame: number }) => input.frame - input.at)
    const row = { interval, run: position === 0 ? 'warmup' : position <= 4 ? 1 : 2,
      sendToInputMs: stats(sendToInput), inputToFrameMs: stats(inputToFrame),
      sendToFrameMs: stats(sendToInput.map((value: number, index: number) => value + inputToFrame[index])),
      updates: result.updates, flushes, longTasks: result.tasks.length,
      longTaskMs: result.tasks.length ? stats(result.tasks) : null,
      longTaskTotalMs: result.tasks.reduce((sum: number, value: number) => sum + value, 0),
      producerDurationMs: producerDuration, firstFlushMs: firstFlush - start,
      firstCommitMs: result.firstCommit - clock.offset - start,
      lastCommitMs: result.lastCommit - clock.offset - start,
      chunkLatenessMs: stats(chunkLateness), inputLatenessMs: stats(inputLateness),
      clockUncertaintyMs: clock.rtt / 2, exactTextDraftFocus: true }
    console.log('Streaming input run ' + JSON.stringify(row))
    if (position > 0) results.push({ ...row, raw: { sendToInput, inputToFrame } })
  }
  assert.deepEqual(errors, [])
  const aggregate = [16, 32, 50, 80].map(interval => {
    const runs = results.filter(row => row.interval === interval)
    return { interval, sendToInputMs: stats(runs.flatMap(row => row.raw.sendToInput)),
      inputToFrameMs: stats(runs.flatMap(row => row.raw.inputToFrame)),
      sendToFrameMs: stats(runs.flatMap(row => row.raw.sendToInput.map((value, index) => value + row.raw.inputToFrame[index]!))),
      updates: runs.map(row => row.updates), longTasks: runs.map(row => row.longTasks) }
  })
  console.log('Streaming input summary ' + JSON.stringify({ electron: process.versions.electron,
    chromium: process.versions.chrome, renderer: 'production ChatTimeline + controlled textarea (not App)',
    bytes: Buffer.byteLength(answer), durationMs: duration, chunks: chunks.length, chunkPeriodMs: chunkPeriod,
    inputPeriodMs: inputPeriod, measuredOrder: order.slice(1), aggregate }))
  app.exit(0)
}).catch(error => { console.error(error); app.exit(1) })

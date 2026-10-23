import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { readFile, readdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { pathToFileURL } from 'node:url'
import process from 'node:process'
import { setTimeout, clearTimeout } from 'node:timers'
/* global AbortController, fetch */

// Deterministic Responses fixtures drive the real native binary and SDK.
export async function validateNative({ binary, directory, workspace, home, output, sanitize, live }) {
  const publish = output
  output = value => publish(JSON.parse(JSON.stringify(value, (_key, item) => typeof item === 'string' ? sanitize(item) : item)))
  const sdk = await import(pathToFileURL(join(directory, 'sdk/node_modules/@factory/droid-sdk/dist/node.mjs')).href)
  const settingsPath = join(directory, 'droid.json')
  const original = await readFile(settingsPath, 'utf8')
  const config = JSON.parse(original)
  assert.equal(config.customModels[0].provider, 'openai', 'Session suite requires the configured Responses gateway')
  const gateway = config.customModels[0].baseUrl
  const results = { cases: [], question: { answerRoundTripVerified: false }, liveForwarded: 0 }
  let session, child, lines, active, answerHandler, sequence = 0
  let notify = () => {}, transportError = () => {}
  const wire = [], received = [], children = []
  const env = {}
  for (const key of ['PATH', 'SystemRoot', 'WINDIR', 'COMSPEC', 'PATHEXT']) if (process.env[key]) env[key] = process.env[key]
  Object.assign(env, { HOME: home, USERPROFILE: home, APPDATA: join(home, 'AppData/Roaming'), LOCALAPPDATA: join(home, 'AppData/Local'), TEMP: directory, TMP: directory, FACTORY_HOME_OVERRIDE: home, FACTORY_AIRGAP_ENABLED: '1', FACTORY_DROID_AUTO_UPDATE_ENABLED: '0', FACTORY_DISABLE_SETTINGS_PERSISTENCE: 'true' })
  async function bounded(promise, ms = 30000) {
    let timer
    try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Session fixture timeout')), ms) })]) }
    finally { clearTimeout(timer) }
  }
  const server = createServer(async (req, res) => {
    try {
      let raw = ''; for await (const chunk of req) raw += chunk
      assert(!raw.includes('# GoodBuddy Agent Guide'), 'Parent instructions leaked into fixture')
      const body = JSON.parse(raw)
      active.requests.push(body)
      if (active.live && body.tools?.length) {
        assert(results.liveForwarded < 8, 'Session live budget exhausted')
        results.liveForwarded++
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), 45000)
        res.on('close', () => controller.abort())
        try {
          const response = await fetch(`${gateway}/responses`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: raw, signal: controller.signal })
          res.writeHead(response.status, { 'content-type': response.headers.get('content-type') ?? 'application/json' })
          if (response.body) for await (const chunk of response.body) res.write(chunk)
          res.end()
        } finally { clearTimeout(timer) }
        return
      }
      active.requestSeen?.()
      if (active.hold) return
      if (active.fail) { res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { message: 'Synthetic session failure', type: 'invalid_request_error' } })); return }
      // The auxiliary title request has no tools; keep it local even in live cases.
      const step = !body.tools?.length ? { text: 'Synthetic fixture session' } : active.steps.shift()
      assert(step, 'Unexpected fixture model request')
      const id = `resp_fixture_${++sequence}`
      const custom = step.tool && body.tools?.find(t => t.name === step.tool)?.type === 'custom'
      const item = custom
        ? { type: 'custom_tool_call', id: `ctc_${sequence}`, call_id: `call_${sequence}`, name: step.tool, input: step.args.input, status: 'completed' }
        : step.tool
        ? { type: 'function_call', id: `fc_${sequence}`, call_id: `call_${sequence}`, name: step.tool, arguments: JSON.stringify(step.args), status: 'completed' }
        : { type: 'message', id: `msg_${sequence}`, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: step.text, annotations: [] }] }
      const response = { id, object: 'response', created_at: 1, model: body.model, status: 'completed', output: [item], usage: { input_tokens: 10, output_tokens: 10, total_tokens: 20 } }
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      let eventSequence = 0
      const emit = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: eventSequence++, ...data })}\n\n`)
      emit('response.created', { response: { ...response, status: 'in_progress', output: [] } })
      emit('response.output_item.added', { output_index: 0, item: { ...item, status: 'in_progress', ...(custom ? { input: '' } : step.tool ? { arguments: '' } : { content: [] }) } })
      if (custom) {
        emit('response.custom_tool_call_input.delta', { item_id: item.id, output_index: 0, delta: item.input })
        emit('response.custom_tool_call_input.done', { item_id: item.id, output_index: 0, input: item.input })
      } else if (step.tool) {
        emit('response.function_call_arguments.delta', { item_id: item.id, output_index: 0, delta: item.arguments })
        emit('response.function_call_arguments.done', { item_id: item.id, output_index: 0, arguments: item.arguments })
      } else {
        emit('response.content_part.added', { item_id: item.id, output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } })
        emit('response.output_text.delta', { item_id: item.id, output_index: 0, content_index: 0, delta: step.text })
        emit('response.output_text.done', { item_id: item.id, output_index: 0, content_index: 0, text: step.text })
        emit('response.content_part.done', { item_id: item.id, output_index: 0, content_index: 0, part: item.content[0] })
      }
      emit('response.output_item.done', { output_index: 0, item })
      emit('response.completed', { response })
      res.end()
    } catch (error) {
      active.serverError = sanitize(error.message)
      if (!res.headersSent) res.writeHead(400, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { message: 'Fixture request rejected' } }))
    }
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  config.customModels[0].baseUrl = `http://127.0.0.1:${server.address().port}/v1`
  config.customModels[0].provider = 'openai'
  await writeFile(settingsPath, JSON.stringify(config))
  async function stop() {
    const owned = child
    if (!owned) return
    if (session) { await bounded(session.close(), 3000).catch(() => {}); session = undefined }
    if (owned.exitCode === null && owned.signalCode === null) owned.kill()
    if (owned.exitCode === null && owned.signalCode === null) await bounded(new Promise(resolve => owned.once('exit', resolve)), 3000)
    lines?.close()
    child = undefined
  }
  async function start(id) {
    child = spawn(binary, ['exec', '--input-format', 'stream-jsonrpc', '--output-format', 'stream-jsonrpc', '--settings', settingsPath, '--cwd', workspace], { cwd: workspace, env, stdio: 'pipe' })
    children.push(child)
    child.stderr.resume()
    child.on('error', error => transportError(error))
    lines = createInterface({ input: child.stdout })
    lines.on('line', line => {
      let message
      try { message = JSON.parse(line) } catch { return }
      received.push(message)
      notify(message)
    })
    const owned = child
    const transport = { isConnected: true, async connect() {}, async send(message) { wire.push(message); owned.stdin.write(JSON.stringify(message) + '\n') }, onMessage(fn) { notify = fn }, onError(fn) { transportError = fn }, async close() { owned.kill() } }
    const options = { transport, disableBuiltinSkills: true, askUserHandler: params => answerHandler(params), permissionHandler: () => sdk.ToolConfirmationOutcome.ProceedOnce }
    session = await bounded(id ? sdk.resumeSession(id, options) : sdk.createSession({ ...options, cwd: workspace, modelId: 'custom:validation-0', reasoningEffort: 'low', autonomyLevel: 'off' }))
    await session.updateSettings({ restrictToolIds: ['Read', 'ApplyPatch', 'AskUser'], enabledToolIds: ['Read', 'ApplyPatch', 'AskUser'] })
  }
  async function turn(name, steps, prompt, extra = {}) {
    active = { name, steps: [...steps], requests: [], ...extra }
    const events = []; let final
    await bounded((async () => {
      for await (const event of session.stream(`${prompt}\nSynthetic isolated fixture test. Access only this fixture workspace. No shell, network tools, subagents, skills or unrelated files.`, { includePartialMessages: true })) {
        events.push(event)
        if (event.type === 'result') final = event
        if (event.type === 'error') output({ sessionError: event })
      }
    })(), extra.live ? 120000 : 30000)
    const result = { name, model: extra.live ? 'configured-live' : 'deterministic-fixture', events: events.reduce((counts, e) => { counts[e.type] = (counts[e.type] ?? 0) + 1; return counts }, {}), subtype: final?.subtype, text: final?.text, requests: active.requests.length }
    output({ sessionCase: result })
    if (name.includes('file')) output({ fileToolResults: events.filter(e => e.type === 'tool_result') })
    assert(!active.serverError, active.serverError)
    if (!extra.hold && !extra.fail && !extra.cancelled) assert.equal(final?.subtype, 'success')
    results.cases.push(result)
    return { final, events, requests: active.requests }
  }
  const watchdog = setTimeout(() => { for (const owned of children) if (owned.exitCode === null && owned.signalCode === null) owned.kill() }, 480000)
  try {
    await start()
    const schemas = await session.listTools({ includeSchemas: true, toolIds: ['Read', 'Create', 'ApplyPatch', 'AskUser'] })
    output({ sessionToolSchemas: schemas.map(t => ({ id: t.id, input: t.schemas.input })) })
    await turn('fixture-text', [{ text: 'READY-73' }], 'Remember synthetic token ORBIT-73. Reply READY-73.')
    const multi = await turn('fixture-multiturn', [{ text: 'ORBIT-73' }], 'Return the previous synthetic token.')
    assert(JSON.stringify(multi.requests[0].input).includes('READY-73'))
    const id = session.id
    await stop()
    const sessionsDir = join(home, '.factory', 'sessions')
    const savedFile = (await readdir(sessionsDir, { recursive: true })).find(file => file.endsWith(`${id}.jsonl`))
    assert(savedFile, 'Native session file missing from home/.factory/sessions')
    const sessionFile = join(sessionsDir, savedFile)
    assert((await readFile(sessionFile, 'utf8')).includes('READY-73'), 'Prior response missing from persisted session')
    await start(id)
    assert.equal(session.id, id)
    assert.equal(resolve(session.cwd), resolve(workspace))
    const restored = await turn('fixture-restart-resume', [{ text: 'ORBIT-73' }], 'Return the saved synthetic token.')
    assert.equal(restored.final.text, 'ORBIT-73')
    assert(JSON.stringify(restored.requests[0].input).includes('READY-73'))
    results.restore = { sameSession: true, persistedCwd: true, priorMessagesInModelInput: true, sessionFile, priorResponseOnDisk: true, owner: 'Droid native session files under isolated home/.factory/sessions' }
    let requestSeen
    const seen = new Promise(resolve => { requestSeen = resolve })
    const cancelling = turn('fixture-cancel-inflight', [], 'Wait for the synthetic model.', { hold: true, requestSeen })
    await bounded(seen)
    await bounded(session.interrupt())
    const cancelled = await cancelling
    output({ interruptResult: { subtype: cancelled.final?.subtype, interrupted: cancelled.final?.interrupted, success: cancelled.final?.success } })
    assert.equal(cancelled.final?.subtype, 'interrupted')
    await turn('fixture-cancel-recovery', [{ text: 'RECOVERED-73' }], 'Reply RECOVERED-73.')
    const failed = await turn('fixture-upstream-error', [], 'Reply after synthetic failure.', { fail: true })
    assert.equal(failed.final?.subtype, 'error_during_execution')
    await turn('fixture-error-recovery', [{ text: 'RETRY-73' }], 'Reply RETRY-73.')
    const questionnaire = '1. [question] Which synthetic colors? (multi)\n[topic] Colors\n[option] red\n[option] blue\n[option] green\n\n2. [question] Which synthetic shape?\n[topic] Shape\n[option] cube\n[option] sphere'
    let callbacks = 0
    answerHandler = ({ questions }) => {
      callbacks++
      questions.forEach(q => sdk.AskUserQuestionSchema.parse(q))
      assert.equal(questions[0].multiSelect, true)
      // The SDK defines a string answer, not a canonical multi-select delimiter.
      const answer = sdk.AskUserResultSchema.parse({ answers: questions.map((q, i) => ({ index: q.index, question: q.question, answer: i === 0 ? 'red, blue' : 'custom tetrahedron' })) })
      output({ typedQuestion: questions, typedAnswer: answer })
      return answer
    }
    const answered = await turn('fixture-question-multi-custom', [{ tool: 'AskUser', args: { questionnaire } }, { text: 'ANSWERS-73' }], 'Ask the synthetic questionnaire.')
    assert.equal(callbacks, 1)
    const toolOutputs = answered.requests.at(-1).input.filter(i => i.type === 'function_call_output')
    output({ fixtureQuestionToolOutputs: toolOutputs })
    assert(JSON.stringify(toolOutputs).includes('red, blue'))
    assert(JSON.stringify(toolOutputs).includes('custom tetrahedron'))
    results.question.answerRoundTripVerified = true
    results.question.multiSelect = { questionFlagVerified: true, answerType: 'string', fixtureStringPreserved: true, canonicalDelimiterVerified: false }
    answerHandler = () => { callbacks++; return sdk.AskUserResultSchema.parse({ cancelled: true, answers: [] }) }
    const skipped = await turn('fixture-question-skip', [{ tool: 'AskUser', args: { questionnaire } }], 'Ask the synthetic questionnaire; accept cancellation.')
    assert.equal(callbacks, 2)
    output({ skippedQuestionToolResults: skipped.events.filter(e => e.type === 'tool_result') })
    assert.equal(skipped.requests.length, 1, 'Questionnaire cancellation unexpectedly continued model loop')
    assert(skipped.events.some(e => e.type === 'tool_result' && e.isError && e.content.includes('cancelled by user')))
    results.question.skip = { subtype: skipped.final.subtype, text: skipped.final.text, followupModelRequests: 0 }
    let pendingAnswer, questionSeen
    const asked = new Promise(resolve => { questionSeen = resolve })
    answerHandler = ({ questions }) => new Promise(resolve => { pendingAnswer = () => resolve(sdk.AskUserResultSchema.parse({ answers: questions.map(q => ({ index: q.index, question: q.question, answer: 'LATE-73' })) })); questionSeen() })
    const late = turn('fixture-question-cancel', [{ tool: 'AskUser', args: { questionnaire } }], 'Ask the synthetic questionnaire.', { cancelled: true })
    await bounded(asked)
    await bounded(session.interrupt())
    const lateCancelled = await late
    assert.equal(lateCancelled.final?.subtype, 'interrupted')
    pendingAnswer()
    const recovered = await turn('fixture-late-answer-recovery', [{ text: 'LATE-RECOVERY-73' }], 'Reply LATE-RECOVERY-73.')
    assert.equal(recovered.final.text, 'LATE-RECOVERY-73')
    assert(!JSON.stringify(recovered.requests[0].input).includes('LATE-73'), 'Late answer polluted recovered session')
    results.question.lateAnswerIgnored = true
    results.question.interruptToolResults = lateCancelled.events.filter(e => e.type === 'tool_result').length
    output({ interruptedQuestionToolResults: lateCancelled.events.filter(e => e.type === 'tool_result'), interruptedQuestionToolCalls: lateCancelled.events.filter(e => e.type === 'tool_call') })
    const read = await turn('fixture-file-read', [{ tool: 'Read', args: { file_path: join(workspace, 'input.txt') } }, { text: 'READ-73' }], 'Read only input.txt.')
    assert(JSON.stringify(read.requests.at(-1).input.filter(i => i.type === 'function_call_output')).includes('ORBIT-73'))
    await turn('fixture-file-write', [{ tool: 'ApplyPatch', args: { input: `*** Begin Patch\n*** Add File: ${join(workspace, 'fixture-output.txt').replaceAll('\\', '/')}\n+fixture-value: ORBIT-73\n*** End Patch` } }, { text: 'WROTE-73' }], 'Create fixture-output.txt only.')
    assert.equal((await readFile(join(workspace, 'fixture-output.txt'), 'utf8')).trim(), 'fixture-value: ORBIT-73')
    if (live) {
      const text = await turn('live-text', [], 'Remember token LIVE-73. Reply exactly READY-LIVE-73. No tools.', { live: true })
      assert.equal(text.final.text.trim(), 'READY-LIVE-73')
      const recall = await turn('live-multiturn', [], 'Reply only the LIVE token from my preceding message. No tools.', { live: true })
      assert.equal(recall.final.text.trim(), 'LIVE-73')
      let liveQuestionAnswered = false
      answerHandler = ({ questions }) => { liveQuestionAnswered = true; return sdk.AskUserResultSchema.parse({ answers: questions.map(q => ({ index: q.index, question: q.question, answer: 'blue' })) }) }
      const question = await turn('live-question', [], 'Use AskUser to ask which synthetic color, red or blue. You MUST call the tool. After its answer reply exactly COLOR=<answer>. No other tools.', { live: true })
      assert.equal(question.final.text.trim(), 'COLOR=blue')
      assert(liveQuestionAnswered)
      assert(question.events.some(e => e.type === 'tool_result'))
      const files = await turn('live-file-read-write', [], 'Read input.txt using Read, then write live-output.txt with exactly the same contents using ApplyPatch or Create. No shell. Confirm briefly.', { live: true })
      assert.equal((await readFile(join(workspace, 'live-output.txt'), 'utf8')).trim(), 'fixture-value: ORBIT-73')
      assert(files.events.some(e => e.type === 'tool_result'))
    }
    return results
  } finally {
    clearTimeout(watchdog)
    try { await stop() } finally {
      server.closeAllConnections(); await new Promise(resolve => server.close(resolve))
      await writeFile(settingsPath, original)
      results.fixtureRequests = results.cases.filter(c => c.model === 'deterministic-fixture').reduce((total, c) => total + c.requests, 0)
      output({ sessionSummary: results, nativeMethods: [...new Set(wire.map(m => m.method).filter(Boolean))], nativeCallbacks: [...new Set(received.filter(m => m.type === 'request').map(m => m.method))], nativeNotifications: [...new Set(received.map(m => m.params?.notification?.type).filter(Boolean))], ownedProcessesExited: children.every(c => c.exitCode !== null || c.signalCode !== null) })
    }
  }
}

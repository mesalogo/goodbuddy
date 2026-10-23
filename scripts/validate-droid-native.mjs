import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import process from 'node:process'
import { setTimeout, clearTimeout } from 'node:timers'
import assert from 'node:assert/strict'

// The launcher installs this pinned SDK in the disposable validation directory.
export async function validateNative({ binary, directory, workspace, home, output, sanitize, live }) {
  const publish = output
  output = value => publish(JSON.parse(JSON.stringify(value, (_key, item) => typeof item === 'string' ? sanitize(item) : item)))
  const sdk = await import(pathToFileURL(join(directory, 'sdk/node_modules/@factory/droid-sdk/dist/node.mjs')).href)
  const env = {}
  for (const key of ['PATH', 'SystemRoot', 'WINDIR', 'COMSPEC', 'PATHEXT']) if (process.env[key]) env[key] = process.env[key]
  Object.assign(env, { HOME: home, USERPROFILE: home, APPDATA: join(home, 'AppData/Roaming'), LOCALAPPDATA: join(home, 'AppData/Local'), TEMP: directory, TMP: directory, FACTORY_HOME_OVERRIDE: home, FACTORY_AIRGAP_ENABLED: '1', FACTORY_DROID_AUTO_UPDATE_ENABLED: '0', FACTORY_DISABLE_SETTINGS_PERSISTENCE: 'true' })
  const child = spawn(binary, ['exec', '--input-format', 'stream-jsonrpc', '--output-format', 'stream-jsonrpc', '--settings', join(directory, 'droid.json'), '--cwd', workspace], { cwd: workspace, env, stdio: 'pipe' })
  child.stderr.resume()
  let handler = () => {}
  let errorHandler = () => {}
  const incoming = []
  const outgoing = []
  const pending = new Map()
  async function raw(method, params = {}) {
    const id = `probe-${outgoing.length}`
    const message = { jsonrpc: '2.0', factoryApiVersion: '1.0.0', type: 'request', id, method, params }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error('RPC timeout')) }, 10000)
      pending.set(id, m => { clearTimeout(timer); if (m.error) reject(new Error(JSON.stringify(m.error))); else resolve(m.result) })
      void transport.send(message)
    })
  }
  child.on('error', e => errorHandler(e))
  createInterface({ input: child.stdout }).on('line', line => {
    try {
      const message = JSON.parse(line)
      incoming.push(message)
      if (pending.has(message.id)) { const done = pending.get(message.id); pending.delete(message.id); done(message); return }
      handler(message)
    } catch { /* Non-protocol diagnostics are deliberately suppressed. */ }
  })
  const transport = {
    isConnected: true,
    async connect() {},
    async send(message) { outgoing.push(message); child.stdin.write(JSON.stringify(message) + '\n') },
    onMessage(fn) { handler = fn },
    onError(fn) { errorHandler = fn },
    async close() { child.kill() }
  }
  let session
  const results = { question: { answerRoundTripVerified: false }, partials: { verified: false }, background: { stopAcknowledged: false, terminalStateVerified: false } }
  let killPromise
  let killedWorker
  const background = process.env.GB_DROID_NATIVE_BACKGROUND === 'true'
  const watchdog = setTimeout(() => child.kill(), 180000)
  try {
    session = await sdk.createSession({ transport, cwd: workspace, modelId: 'custom:validation-0', reasoningEffort: 'low', autonomyLevel: 'off', disableBuiltinSkills: true,
      askUserHandler({ questions }) {
        results.question.callbackReceived = true
        output({ nativeQuestion: questions })
        return { answers: questions.map(q => ({ index: q.index, question: q.question, answer: 'blue' })) }
      }, permissionHandler() { return sdk.ToolConfirmationOutcome.Cancel }
    })
    output({ sdkInitialize: true, settings: { modelId: session.settings.modelId }, peerVersions: [...new Set(incoming.map(m => m.factoryProtocolVersion))] })
    const models = await raw('droid.list_models')
    output({ modelCatalogKeys: Object.keys(models), customModels: models.models?.filter(m => m.isCustom).map(m => ({ id: m.id, displayName: m.displayName })) })
    const model = models.models?.find(m => m.isCustom)
    if (model) await session.updateSettings({ modelId: model.id })
    const tools = await session.listTools()
    output({ nativeTools: tools.map(t => ({ id: t.id, allowed: t.allowed })) })
    output({ toolSchemas: (await session.listTools({ includeSchemas: true, toolIds: ['AskUser', 'Execute', 'TaskOutput', 'TaskStop', 'Task'] })).map(t => ({ id: t.id, inputKeys: Object.keys(t.schemas.input.properties ?? {}), required: t.schemas.input.required, result: t.schemas.result ? Object.keys(t.schemas.result) : [] })) })
    await session.updateSettings({ enabledToolIds: ['AskUser', 'TaskOutput', 'TaskStop'], restrictToolIds: ['AskUser'] })
    output({ questionToolEnabled: (await session.listTools()).find(t => t.id === 'AskUser')?.allowed })
    if (background) {
      await session.updateSettings({ restrictToolIds: ['Task'] })
      session.onNotification(envelope => {
        const n = envelope.params.notification
        if (['child_session_available', 'tool_progress_update', 'tool_result', 'tool_call', 'agent_turn_completed'].includes(n.type)) output({ backgroundSessionId: envelope.params.sessionId, backgroundNotification: n })
        const id = n.childSessionId ?? n.update?.subagentSessionId
        if (id && !killedWorker) {
          killedWorker = id
          killPromise = (async () => {
            await new Promise(resolve => setTimeout(resolve, 1000))
            output({ stopRequested: id, at: Date.now() })
            try {
              const result = await raw('droid.kill_worker_session', { workerSessionId: id })
              results.background.stopAcknowledged = true
              output({ stopRealWorker: result, at: Date.now() })
            } catch (e) { output({ stopRealWorkerError: sanitize(e.message), at: Date.now() }) }
          })()
        }
      })
    }
    if (live) {
      for (const [name, prompt] of (background ? [
        ['background', 'Synthetic isolated protocol test. Launch exactly one Task with subagent_type worker and await=false. Give the child this task: Explain a fictional blue cube in 100 short lines; use no tools, files or network. After launch return the task id immediately and end your turn. Do not launch any additional Task, poll, or wait.']
      ] : [
        ['question', 'Synthetic protocol test. Use AskUser to ask which synthetic fixture color, red or blue. You MUST use the question tool, not plain text. After the answer, reply exactly COLOR=<answer>. No other tools.'],
        ['partials', 'No tools. Write twelve short numbered sentences about an imaginary blue cube.']
      ])) {
        const counts = {}; let final
        for await (const e of session.stream(prompt, { includePartialMessages: true })) {
          counts[e.type] = (counts[e.type] ?? 0) + 1
          if (e.type === 'result') final = { subtype: e.subtype, text: e.text }
        }
        output({ nativeTurn: name, counts, final })
        if (!background) assert.equal(final?.subtype, 'success', 'Native turn failed')
        if (name === 'question') {
          assert.equal(final.text.trim(), 'COLOR=blue')
          assert(results.question.callbackReceived)
          results.question.answerRoundTripVerified = true
        }
        if (name === 'partials') {
          assert(counts.assistant_text_delta > 1, 'Missing incremental text')
          results.partials = { verified: true, deltas: counts.assistant_text_delta }
        }
      }
      if (killPromise) await killPromise
      if (background) {
        await new Promise(resolve => setTimeout(resolve, 1500))
        output({ isolatedSessions: (await sdk.listSessions({ sessionsDir: join(home, '.factory', 'sessions'), cwd: workspace, fetchOutsideCWD: true })).map(s => ({ id: s.id, messageCount: s.messageCount })) })
        const parent = await raw('droid.load_session', { sessionId: session.id, loadAllMessages: true })
        const summary = parent.subagentInvocations?.find(s => s.childSessionId === killedWorker)
        results.background.parentSummaryStatus = summary?.status ?? null
        output({ parentReload: { keys: Object.keys(parent), summaries: parent.subagentInvocations, workingState: parent.workingState, isAgentLoopInProgress: parent.isAgentLoopInProgress } })
        results.background.terminalStateVerified = summary?.status === 'cancelled'
        if (killedWorker) {
          const worker = await raw('droid.load_session', { sessionId: killedWorker, loadAllMessages: true })
          results.background.workerWorkingState = worker.workingState
          results.background.workerAssistantMessages = worker.session?.messages.filter(m => m.role === 'assistant').length ?? 0
          output({ workerReload: { keys: Object.keys(worker), workingState: worker.workingState, isAgentLoopInProgress: worker.isAgentLoopInProgress, agentTurnOutcome: worker.agentTurnOutcome, messages: worker.session?.messages.map(m => ({ id: m.id, role: m.role, contentTypes: m.content.map(c => c.type), text: m.role === 'assistant' ? m.content.filter(c => c.type === 'text').map(c => c.text).join('') : undefined })) } })
        }
        output({ backgroundEvidence: results.background })
        assert(results.background.stopAcknowledged, 'Real worker stop was not acknowledged')
        assert(results.background.terminalStateVerified, 'Stop acknowledged but cancelled terminal state was not verified')
      }
    }
    if (!live && background) {
      const loaded = await raw('droid.load_session', { sessionId: session.id, loadAllMessages: true })
      output({ noModelReload: { keys: Object.keys(loaded), workingState: loaded.workingState, messages: loaded.session?.messages.length } })
    }
    return results
  } catch (e) {
    output({ sdkFailure: sanitize(e.message).slice(0, 1200), name: e.name,
      wire: incoming.map(m => ({ type: m.type, method: m.method, version: m.factoryProtocolVersion, error: m.error ? sanitize(JSON.stringify(m.error)).slice(0, 1500) : undefined, resultKeys: Object.keys(m.result ?? {}) })).slice(-8) })
    throw e
  } finally {
    output({ nativeSent: outgoing.map(m => ({ method: m.method, type: m.type, version: m.factoryProtocolVersion, paramKeys: Object.keys(m.params ?? {}) })), nativeReceived: incoming.reduce((a, m) => { const key = m.method ?? m.type; a[key] = (a[key] ?? 0) + 1; return a }, {}) })
    clearTimeout(watchdog)
    if (session) await session.close()
    child.kill()
    if (child.exitCode === null) await new Promise(resolve => child.once('exit', resolve))
  }
}

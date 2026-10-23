import { spawn, execFile } from 'node:child_process'
import { createInterface } from 'node:readline'
import { createServer } from 'node:http'
import { readFile, writeFile, stat } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import process from 'node:process'
import { setTimeout, clearTimeout } from 'node:timers'
import assert from 'node:assert/strict'
import { promisify } from 'node:util'

const delay = ms => new Promise(resolve => setTimeout(resolve, ms))

// Synthetic model responses exercise the installed binary's real native tools.
// No private SDK members, Mission kill, or user workspace are used.
export async function validateNative({ binary, directory, workspace, home, output, sanitize, live }) {
  const publish = output
  output = value => publish(JSON.parse(JSON.stringify(value, (_key, item) => typeof item === 'string' ? sanitize(item) : item)))
  const sdk = await import(pathToFileURL(join(directory, 'sdk/node_modules/@factory/droid-sdk/dist/node.mjs')).href)
  const originalSettings = await readFile(join(directory, 'droid.json'), 'utf8')
  const report = { sdk: sdk.SDK_VERSION, binary: (await promisify(execFile)(binary, ['--version'], { timeout: 10000 })).stdout.trim(), deterministicRequests: 0, cases: { liveTodo: { status: live ? 'pending' : 'skipped' } }, notifications: {}, gaps: ['Product checklist source and native task binding are not implemented by this test.', 'Execute fireAndForget returns PID/output path, not a Task session ID; daemon Task interruption does not establish a shell stop API.', 'Network isolation and Linux/remote Agent behavior are not covered.'] }
  const env = {}
  for (const key of ['PATH', 'SystemRoot', 'WINDIR', 'COMSPEC', 'PATHEXT']) if (process.env[key]) env[key] = process.env[key]
  // Factory appends .factory to this home override; it is not the config directory itself.
  Object.assign(env, { HOME: home, USERPROFILE: home, APPDATA: join(home, 'AppData/Roaming'), LOCALAPPDATA: join(home, 'AppData/Local'), TEMP: directory, TMP: directory, FACTORY_HOME_OVERRIDE: home, FACTORY_AIRGAP_ENABLED: '1', FACTORY_DROID_AUTO_UPDATE_ENABLED: '0', FACTORY_DISABLE_SETTINGS_PERSISTENCE: 'true' })
  let session, child, daemon, daemonChild, stage = 'schema', step = 0, rpc, foregroundReleased = false
  const events = [], children = [], held = new Map()
  let todoInput, stopTaskId, serviceCommand, serviceInfo
  const server = createServer(async (req, res) => {
    try {
      let text = ''; for await (const chunk of req) text += chunk
      assert(!text.includes('# GoodBuddy Agent Guide'))
      const body = JSON.parse(text)
      report.deterministicRequests++
      const messages = body.messages ?? []
      const lastUser = messages.filter(m => m.role === 'user').at(-1)
      const userText = JSON.stringify(lastUser?.content ?? '')
      output({ fixtureRequest: report.deterministicRequests, stage, tools: body.tools?.length ?? 0 })
      let calls = [], answer = 'FIXTURE_OK'
      if (userText.includes('PARENT_HOLD') && !foregroundReleased) {
        await new Promise(resolve => held.set('parent', () => { foregroundReleased = true; held.delete('parent'); resolve() }))
      } else if (/CHILD_[ABC]/.test(userText) && !userText.includes('PARENT_CREATE')) {
        const label = /CHILD_([ABC])/.exec(userText)[1]
        await new Promise(resolve => { held.set(label, () => { held.delete(label); resolve() }); res.on('close', () => { held.delete(label); resolve() }) })
        answer = `CHILD_${label}_DONE`
      } else if (body.tools?.length && step++ === 0) {
        if (stage === 'todo-create' || stage === 'todo-update') calls = [{ name: 'TodoWrite', arguments: todoInput }]
        if (stage === 'background') calls = ['A', 'B'].map(label => ({ name: 'Task', arguments: { subagent_type: 'worker', description: `Fixture ${label}`, prompt: `CHILD_${label}: Reply CHILD_${label}_DONE. No tools.`, await: false } }))
        if (stage === 'ordinary-task') calls = [{ name: 'Task', arguments: { subagent_type: 'worker', description: 'Fixture C', prompt: 'CHILD_C: Reply CHILD_C_DONE. No tools.', await: false } }]
        if (stage === 'native-task-stop') calls = [{ name: 'TaskStop', arguments: { task_id: stopTaskId } }]
        if (stage === 'service-start' || stage === 'service-stop' || stage === 'shell-failure' || stage === 'shell-explicit-exit') calls = [{ name: 'Execute', arguments: { summary: 'Run owned process fixture', command: serviceCommand, riskLevel: 'low', fireAndForget: stage === 'service-start' } }]
        if (stage === 'output') calls = children.map(c => ({ name: 'TaskOutput', arguments: { task_id: c.childSessionId, block: false } }))
        if (stage === 'shell') calls = [{ name: 'Execute', arguments: { summary: 'Run bounded synthetic process', command: 'node -e "console.log(\'SHELL_STARTED\');setTimeout(()=>console.log(\'SHELL_DONE\'),1500)"', riskLevel: 'low', fireAndForget: true } }]
      }
      if (res.destroyed) return
      const tool_calls = calls.map((call, index) => ({ index, id: `call_${stage}_${index}`, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.arguments) } }))
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      const chunk = delta => ({ id: `fixture-${report.deterministicRequests}`, object: 'chat.completion.chunk', created: 1, model: body.model, choices: [{ index: 0, delta, finish_reason: null }] })
      res.write(`data: ${JSON.stringify(chunk({ role: 'assistant', ...(calls.length ? { tool_calls } : { content: answer }) }))}\n\n`)
      const end = chunk({}); end.choices[0].finish_reason = calls.length ? 'tool_calls' : 'stop'
      res.end(`data: ${JSON.stringify(end)}\n\ndata: [DONE]\n\n`)
    } catch (error) { output({ fixtureError: error.message }); if (!res.headersSent) res.writeHead(400); res.end() }
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  await writeFile(join(directory, 'tasks.json'), JSON.stringify({ customModels: [{ model: 'fixture-model', displayName: 'tasks-fixture', baseUrl: `http://127.0.0.1:${server.address().port}/v1`, apiKey: 'fixture', provider: 'generic-chat-completion-api', maxOutputTokens: 1000 }] }))
  async function start(settings = 'tasks.json', resumeId) {
    child = spawn(binary, ['exec', '--input-format', 'stream-jsonrpc', '--output-format', 'stream-jsonrpc', '--settings', join(directory, settings), '--cwd', workspace], { cwd: workspace, env, stdio: 'pipe' })
    child.stderr.resume()
    let handler = () => {}, errorHandler = () => {}, sequence = 0
    const pending = new Map()
    const transport = { isConnected: true, async connect() {}, async send(m) { child.stdin.write(JSON.stringify(m) + '\n') }, onMessage(fn) { handler = fn }, onError(fn) { errorHandler = fn }, async close() { child.kill() } }
    child.on('error', e => errorHandler(e))
    rpc = (method, params) => new Promise((resolve, reject) => {
      const id = `tasks-${sequence++}`, timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timeout`)) }, 10000)
      pending.set(id, m => { clearTimeout(timer); if (m.error) reject(new Error(JSON.stringify(m.error))); else resolve(m.result) })
      void transport.send({ jsonrpc: '2.0', factoryApiVersion: '1.0.0', type: 'request', id, method, params })
    })
    createInterface({ input: child.stdout }).on('line', line => { let m; try { m = JSON.parse(line) } catch { return }; if (pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) } else handler(m) })
    const options = { transport, cwd: workspace, modelId: settings === 'tasks.json' ? 'custom:tasks-fixture-0' : 'custom:validation-0', autonomyLevel: 'high', disableBuiltinSkills: true, permissionHandler: () => sdk.ToolConfirmationOutcome.ProceedOnce }
    session = resumeId ? await sdk.resumeSession(resumeId, options) : await sdk.createSession(options)
    session.onNotification(observe)
    await session.updateSettings({ enabledToolIds: ['TodoWrite', 'Task', 'TaskOutput', 'TaskStop', 'Execute'], restrictToolIds: ['TodoWrite', 'Task', 'TaskOutput', 'TaskStop', 'Execute'] })
  }
  function observe(envelope) {
      const n = envelope.params.notification
      events.push({ sessionId: envelope.params.sessionId, ...n })
      report.notifications[n.type] = (report.notifications[n.type] ?? 0) + 1
      if (n.type === 'child_session_available') children.push(n)
      if (/todo|tool_call$|tool_result$|tool_progress|child_session|agent_turn_completed/.test(n.type)) output({ stage, sessionId: envelope.params.sessionId, notification: n })
  }
  async function waitFor(predicate, description) {
    const deadline = Date.now() + 15000
    while (!predicate()) { assert(Date.now() < deadline, description); await delay(50) }
  }
  async function daemonTurn(id, name, text) {
    stage = name; step = 0
    const start = events.length
    await daemon.addUserMessage({ sessionId: id, text })
    const belongs = e => e.sessionId === id && e.type === 'agent_turn_completed' && !e.turnId.startsWith('task-completion:')
    await waitFor(() => events.slice(start).some(belongs), `${name} did not complete`)
    const result = events.slice(start).find(belongs)
    output({ daemonTurn: name, result })
    assert.equal(result.reason, 'completed')
  }
  async function turn(name, prompt) {
    stage = name; step = 0
    let result
    for await (const event of session.stream(prompt, { includePartialMessages: true })) if (event.type === 'result') result = { subtype: event.subtype, text: event.text }
    output({ turn: name, result })
    assert.equal(result?.subtype, 'success')
    return result
  }
  async function stop() {
    if (session) { await session.close(); session = undefined }
    if (child && child.exitCode === null && child.signalCode === null) { child.kill(); await Promise.race([new Promise(resolve => child.once('exit', resolve)), delay(3000)]) }
  }
  const watchdog = setTimeout(() => { for (const release of held.values()) release(); child?.kill() }, 150000)
  try {
    await start()
    const tools = await session.listTools({ includeSchemas: true, toolIds: ['TodoWrite', 'Task', 'TaskOutput', 'TaskStop', 'Execute'] })
    const sdkSource = await readFile(join(directory, 'sdk/node_modules/@factory/droid-sdk/dist/node.mjs'), 'utf8')
    report.controlDiscovery = { toolContracts: tools.filter(t => ['Execute', 'TaskStop'].includes(t.id)).map(t => ({ id: t.id, description: t.id === 'Execute' ? t.schemas.input.properties.fireAndForget.description : t.description })), sdkBackgroundReferences: [...sdkSource.matchAll(/.{0,100}(?:[Bb]ackground[Jj]ob|background_job|stopProcess|killProcess).{0,200}/g)].map(m => m[0]).slice(0, 30) }
    output({ controlDiscovery: report.controlDiscovery })
    output({ schemas: tools.map(t => ({ id: t.id, allowed: t.allowed, input: JSON.parse(JSON.stringify(t.schemas.input, (key, value) => key === 'description' && typeof value === 'string' ? undefined : value)) })), daemonControlMethods: ['initializeSession', 'loadSession', 'interruptSession', 'getSessionMessages', 'listOpenedSessions', 'closeSession'] })
    const todo = tools.find(t => t.id === 'TodoWrite')
    assert(todo, 'TodoWrite unavailable')
    todoInput = { todos: '1. [in_progress] Inspect synthetic cube\n2. [pending] Verify synthetic cube' }
    await turn('todo-create', 'Create the synthetic checklist.')
    todoInput = { todos: '1. [completed] Inspect synthetic cube\n2. [in_progress] Verify synthetic cube' }
    await turn('todo-update', 'Update the synthetic checklist.')
    const snapshot = await rpc('droid.load_session', { sessionId: session.id, loadAllMessages: true })
    const todoCalls = snapshot.session.messages.flatMap(m => m.content).filter(c => c.type === 'tool_use' && c.name === 'TodoWrite')
    assert.equal(todoCalls.length, 2)
    assert.equal(todoCalls.at(-1).input.todos, todoInput.todos)
    const todoResults = events.filter(e => e.type === 'tool_result')
    assert.equal(todoResults.length, 2)
    assert(todoResults.every(e => e.isError === false && e.content === 'TODO List Updated'))
    report.cases.todo = { created: true, updated: true, recoveredFromSuccessfulToolHistory: true, mappedItems: todoInput.todos.split('\n').map(line => { const match = /^\d+\. \[(pending|in_progress|completed)\] (.+)$/.exec(line); assert(match); return { content: match[2], status: match[1] } }), sourceContractGap: 'runtimeChecklistSchema.source only accepts opencode/continue; no native priority or cancelled Todo state verified' }
    output({ todoRecovery: { keys: Object.keys(snapshot), todoCalls, mappedItems: report.cases.todo.mappedItems } })
    const todoSessionId = session.id
    await stop()
    await start('tasks.json', todoSessionId)
    const cold = await rpc('droid.load_session', { sessionId: session.id, loadAllMessages: true })
    assert.equal(cold.session.messages.flatMap(m => m.content).filter(c => c.type === 'tool_use' && c.name === 'TodoWrite').at(-1).input.todos, todoInput.todos)
    report.cases.todo.coldRestore = true
    await turn('after-recovery', 'Reply FIXTURE_OK. No tools.')
    await turn('shell', 'Run the bounded synthetic process.')
    await delay(2500)
    const shellResult = events.find(e => e.type === 'tool_result' && e.toolUseId === 'call_shell_0')
    assert.equal(shellResult?.isError, false)
    const pid = Number(/PID: (\d+)/.exec(shellResult.content)?.[1])
    const logPath = /^Output: (.+)$/m.exec(shellResult.content)?.[1]?.trim()
    assert(pid > 0 && resolve(logPath).startsWith(resolve(directory) + sep))
    const shellOutput = await readFile(logPath, 'utf8')
    assert(shellOutput.includes('SHELL_STARTED') && shellOutput.includes('SHELL_DONE'))
    let alive = true
    try { process.kill(pid, 0) } catch (error) { if (error.code === 'ESRCH') alive = false; else throw error }
    assert.equal(alive, false, 'Owned bounded shell process still alive')
    report.cases.shell = { launched: true, output: shellOutput.trim(), pid, processExited: true, termination: 'bounded natural exit', targetedStop: 'not verified', taskId: null }
    serviceCommand = 'node -e "console.error(\'EXPECTED_FAILURE\');process.exit(7)"'
    await turn('shell-failure', 'Run the controlled failing command.')
    const failedShell = events.find(e => e.type === 'tool_result' && e.toolUseId === 'call_shell-failure_0')
    assert(failedShell?.content.includes('EXPECTED_FAILURE'))
    assert.equal(failedShell.isError, true)
    const failureProgress = events.findLast(e => e.toolUseId === 'call_shell-failure_0' && e.update?.exitCode != null)
    assert(failureProgress.update.exitCode !== 0)
    report.cases.shellFailure = { command: serviceCommand, requestedExitCode: 7, observedExitCode: failureProgress.update.exitCode, exactExitCodePreserved: failureProgress.update.exitCode === 7, qualification: 'No explicit shell exit propagation; wrapper status is not evidence of a Droid exit-code defect.', result: failedShell }
    serviceCommand = process.platform === 'win32'
      ? `Write-Output ('FIXTURE_SHELL=PowerShell ' + $PSVersionTable.PSVersion.ToString()); ${serviceCommand}; exit $LASTEXITCODE`
      : `${serviceCommand}; exit $?`
    await turn('shell-explicit-exit', 'Run the failing command with explicit shell exit propagation.')
    const explicitFailure = events.find(e => e.type === 'tool_result' && e.toolUseId === 'call_shell-explicit-exit_0')
    const explicitProgress = events.findLast(e => e.toolUseId === 'call_shell-explicit-exit_0' && e.update?.exitCode != null)
    assert.equal(explicitFailure?.isError, true)
    assert(explicitFailure.content.includes('EXPECTED_FAILURE'))
    assert.equal(explicitProgress?.update.exitCode, 7)
    assert(explicitFailure.content.includes('[Process exited with code 7]'))
    const shellIdentity = /FIXTURE_SHELL=([^\r\n]+)/.exec(explicitFailure.content)?.[1]
    if (process.platform === 'win32') assert(shellIdentity?.startsWith('PowerShell '))
    report.cases.shellExplicitExit = { command: serviceCommand, shellIdentity, requestedExitCode: 7, observedExitCode: explicitProgress.update.exitCode, result: explicitFailure }
    // The service has a bounded fallback lifetime even if validation fails.
    const serviceFile = join(workspace, 'owned-service.cjs')
    await writeFile(serviceFile, "const http=require('node:http');const s=http.createServer((q,r)=>r.end('OWNED_SERVICE'));s.listen(0,'127.0.0.1',()=>console.log(JSON.stringify({port:s.address().port,pid:process.pid})));setTimeout(()=>s.close(),30000);\n")
    serviceCommand = `node "${serviceFile}"`
    await turn('service-start', 'Start the owned localhost service.')
    const serviceResult = events.find(e => e.type === 'tool_result' && e.toolUseId === 'call_service-start_0')
    assert.equal(serviceResult?.isError, false)
    const serviceLog = /^Output: (.+)$/m.exec(serviceResult.content)?.[1]?.trim()
    assert(resolve(serviceLog).startsWith(resolve(directory) + sep))
    for (let i = 0; i < 100 && !serviceInfo; i++) {
      const text = await readFile(serviceLog, 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error })
      if (text.trim()) serviceInfo = JSON.parse(text.trim())
      else await delay(50)
    }
    assert(serviceInfo?.pid > 0)
    assert.equal(await (await globalThis.fetch(`http://127.0.0.1:${serviceInfo.port}`)).text(), 'OWNED_SERVICE')
    await stop()
    assert.equal(await (await globalThis.fetch(`http://127.0.0.1:${serviceInfo.port}`)).text(), 'OWNED_SERVICE')
    await start('tasks.json', todoSessionId)
    // Execute documents OS process management, not a native stop RPC.
    serviceCommand = `node -e "process.kill(${serviceInfo.pid});console.log('OWNED_PROCESS_STOP_SENT')"`
    await turn('service-stop', 'Stop only the owned fixture process using OS process management.')
    const serviceStop = events.find(e => e.type === 'tool_result' && e.toolUseId === 'call_service-stop_0')
    assert.equal(serviceStop?.isError, false)
    await waitFor(() => {
      try { process.kill(serviceInfo.pid, 0); return false } catch (error) { if (error.code === 'ESRCH') return true; throw error }
    }, 'Owned service PID still alive after stop')
    const rebound = createServer()
    await new Promise((resolve, reject) => { rebound.once('error', reject); rebound.listen(serviceInfo.port, '127.0.0.1', resolve) })
    await new Promise(resolve => rebound.close(resolve))
    report.cases.service = { ...serviceInfo, startupLog: await readFile(serviceLog, 'utf8'), responded: true, survivedCliExit: true, processExited: true, portFreed: true, stopMechanism: 'model Execute -> Node process.kill (OS control, not native stop API)', nativeStopVerified: false }
    serviceInfo = undefined
    const sessionsDir = join(home, '.factory/sessions')
    const isolatedSessions = await sdk.listSessions({ sessionsDir, cwd: workspace, fetchOutsideCWD: true })
    assert(isolatedSessions.some(s => s.id === todoSessionId), 'Session missing from the expected Factory home')
    output({ isolatedSessions })
    await stop()
    const portServer = createServer(); await new Promise(resolve => portServer.listen(0, '127.0.0.1', resolve))
    const port = portServer.address().port; await new Promise(resolve => portServer.close(resolve))
    daemonChild = spawn(binary, ['daemon', '--port', String(port), '--host', '127.0.0.1', '--droid-path', binary, '--settings', join(directory, 'tasks.json')], { cwd: workspace, env, stdio: ['ignore', 'pipe', 'pipe'] })
    let ready = false
    for (const stream of [daemonChild.stdout, daemonChild.stderr]) stream.on('data', chunk => { if (String(chunk).includes('WebSocket endpoint:')) ready = true })
    await waitFor(() => ready, 'Isolated daemon did not become ready')
    const logsDir = join(home, '.factory/logs')
    assert((await stat(logsDir)).isDirectory())
    report.isolation = { factoryHomeOverride: home, factoryRoot: join(home, '.factory'), sessionsDir, daemonLogsDir: logsDir, ambientHomeRedirected: true, inheritedEnvironmentKeys: Object.keys(env), cloudRegistrationRequested: false, networkIsolationProven: false }
    daemon = sdk.createWebSocketDaemonClient({ machineType: 'local', requestTimeout: 10000, transportConfig: { maxConnectRetries: 0 } })
    daemon.onTransportMessage(message => { if (message.method === 'daemon.session_notification') observe(message) })
    await daemon.connect(`ws://127.0.0.1:${port}`)
    const auth = await daemon.authenticate({ token: 'synthetic-airgap-token', caller: 'goodbuddy-validation' })
    assert.deepEqual(auth, { userId: 'airgapped-user', orgId: 'airgapped-org' })
    output({ daemonAuth: auth, isolation: report.isolation })
    const initialized = await daemon.initializeSession({ machineId: 'local', cwd: workspace, token: 'synthetic-airgap-token', modelId: 'custom:tasks-fixture-0', autonomyLevel: 'high', disableBuiltinSkills: true, runtimeSettingsPath: join(directory, 'tasks.json'), enabledToolIds: ['Task', 'TaskOutput', 'TaskStop'], restrictToolIds: ['Task', 'TaskOutput', 'TaskStop'] })
    output({ daemonInitialized: { sessionId: initialized.sessionId, settings: initialized.settings } })
    assert.deepEqual(initialized.availableModels.map(m => m.id), ['custom:tasks-fixture-0'])
    const parentId = initialized.sessionId
    await daemonTurn(parentId, 'background', 'PARENT_CREATE: launch two independent synthetic workers, then finish.')
    await waitFor(() => held.size === 2, 'Two worker requests did not start')
    assert.equal(children.length, 2)
    report.cases.background = { parentCompleted: true, children: [...children], heldAfterParentCompletion: [...held.keys()] }
    await daemonTurn(parentId, 'next-foreground', 'Reply FIXTURE_OK. No tools.')
    report.cases.nextForeground = { completed: true, held: [...held.keys()] }
    output({ openedBeforeStop: await daemon.listOpenedSessions({}) })
    const target = children.find(c => c.description === 'Fixture A').childSessionId
    const sibling = children.find(c => c.description === 'Fixture B').childSessionId
    const activeParent = daemonTurn(parentId, 'foreground-during-stop', 'PARENT_HOLD: Reply FIXTURE_OK. No tools.')
    // Keep rejection observed while the independent control requests are running.
    activeParent.catch(() => {})
    await waitFor(() => held.has('parent'), 'Parent request did not start')
    const childRead = await daemon.getSessionMessages({ sessionId: target, limit: 20 })
    output({ childRead: { count: childRead.messages.length, hasMore: childRead.hasMore } })
    const attachment = await daemon.loadSession({ sessionId: target, token: 'synthetic-airgap-token', loadAllMessages: true })
    output({ childAttachment: { workingState: attachment.workingState, isAgentLoopInProgress: attachment.isAgentLoopInProgress } })
    try {
      output({ targetedInterrupt: await daemon.interruptSession({ sessionId: target }) })
      report.cases.targetedStop = { acknowledged: true }
    } catch (error) { report.cases.targetedStop = { acknowledged: false, error: error.message } }
    await delay(500)
    const afterStop = await daemon.listOpenedSessions({})
    output({ openedAfterStop: afterStop })
    assert.equal(afterStop.sessions.find(s => s.sessionId === target)?.workingState, 'idle')
    assert.equal(afterStop.sessions.find(s => s.sessionId === sibling)?.workingState, 'thinking')
    assert.equal(afterStop.sessions.find(s => s.sessionId === parentId)?.workingState, 'thinking')
    assert(events.some(e => e.sessionId === target && e.type === 'agent_turn_completed' && e.reason === 'cancelled'))
    held.get('parent')()
    await activeParent
    report.cases.targetedStop.activeParentUnaffected = true
    await daemonTurn(parentId, 'after-stop', 'Reply FIXTURE_OK. No tools.')
    report.cases.targetedStop.parentResponsive = true
    report.cases.targetedStop.siblingStillHeld = held.has('B')
    assert(report.cases.targetedStop.siblingStillHeld)
    held.get('B')?.()
    held.get('A')?.()
    await delay(1500)
    const siblingOutput = await daemon.getSessionMessages({ sessionId: sibling, limit: 20 })
    const targetOutput = await daemon.getSessionMessages({ sessionId: target, limit: 20 })
    assert(siblingOutput.messages.some(m => m.role === 'assistant' && m.content.some(c => c.text === 'CHILD_B_DONE')))
    assert(!targetOutput.messages.some(m => m.role === 'assistant'))
    report.cases.output = { independentRead: true, siblingText: 'CHILD_B_DONE', stoppedTargetHasNoAssistantOutput: true }
    await daemonTurn(parentId, 'output', 'Read both synthetic task results without waiting.')
    const recovered = await daemon.loadSession({ sessionId: parentId, token: 'synthetic-airgap-token', loadAllMessages: true })
    output({ parentRecovery: { workingState: recovered.workingState, subagentInvocations: recovered.subagentInvocations } })
    assert.equal(recovered.subagentInvocations.find(s => s.childSessionId === target)?.status, 'cancelled')
    assert.equal(recovered.subagentInvocations.find(s => s.childSessionId === sibling)?.status, 'completed')
    report.cases.targetedStop.terminalStates = recovered.subagentInvocations
    assert(events.some(e => e.type === 'tool_result' && e.content.includes(`Task ID: ${target}`) && e.content.includes('Status: stopped')))
    assert(events.some(e => e.type === 'tool_result' && e.content.includes(`Task ID: ${sibling}`) && e.content.includes('Status: completed')))
    report.cases.output.nativeTaskOutputVerified = true
    await daemonTurn(parentId, 'ordinary-task', 'Launch another ordinary detached task.')
    await waitFor(() => held.has('C'), 'Third worker did not start')
    stopTaskId = children.find(c => c.description === 'Fixture C').childSessionId
    foregroundReleased = false
    stage = 'parent-interrupt'; step = 0
    const beforeInterrupt = events.length
    await daemon.addUserMessage({ sessionId: parentId, text: 'PARENT_HOLD: hold parent only.' })
    await waitFor(() => held.has('parent'), 'Parent interrupt request did not start')
    await daemon.interruptSession({ sessionId: parentId })
    await waitFor(() => events.slice(beforeInterrupt).some(e => e.sessionId === parentId && e.type === 'agent_turn_completed' && e.reason === 'cancelled'), 'Parent cancellation not observed')
    const afterParentInterrupt = await daemon.listOpenedSessions({})
    report.cases.parentInterrupt = { childSessionId: stopTaskId, childWorkingState: afterParentInterrupt.sessions.find(s => s.sessionId === stopTaskId)?.workingState }
    assert.equal(report.cases.parentInterrupt.childWorkingState, 'thinking')
    held.get('parent')?.()
    await daemonTurn(parentId, 'native-task-stop', 'Stop the owned ordinary task with TaskStop.')
    const nativeStop = events.find(e => e.type === 'tool_result' && e.toolUseId === 'call_native-task-stop_0')
    assert.equal(nativeStop?.isError, false)
    const nativeStopped = await daemon.loadSession({ sessionId: parentId, token: 'synthetic-airgap-token', loadAllMessages: true })
    assert.equal(nativeStopped.subagentInvocations.find(s => s.childSessionId === stopTaskId)?.status, 'cancelled')
    report.cases.nativeTaskStop = { input: { task_id: stopTaskId }, result: nativeStop, recoveredStatus: 'cancelled', binding: 'model tool, not client RPC' }
    held.get('C')?.()
    await daemonTurn(parentId, 'after-native-stop', 'Reply FIXTURE_OK. No tools.')
    await daemon.closeSession({ sessionId: parentId })
    daemon.disconnect(); daemon = undefined
    if (live) {
      await start('droid.json')
      const before = events.length
      const result = await turn('live-todo', 'Synthetic native tool validation. Use TodoWrite exactly once as the final update to create two completed items: Inspect synthetic cube, Verify synthetic cube. Then reply LIVE_TODO_OK. No other tools.')
      const liveEvents = events.slice(before)
      const calls = liveEvents.filter(e => e.type === 'tool_call')
      assert(calls.every(e => e.toolUse.name === 'TodoWrite'), 'Unexpected live tool')
      const ids = [...new Set(calls.map(e => e.toolUse.id))]
      assert.equal(ids.length, 1, 'Expected exactly one distinct TodoWrite call')
      // Streaming emits an empty input first; count calls by ID, not notification count.
      const complete = calls.filter(e => typeof e.toolUse.input.todos === 'string')
      assert(complete.length > 0, 'Missing complete TodoWrite input')
      const items = complete.map(call => call.toolUse.input.todos.trim().split(/\r?\n/).map(line => {
        const match = /^\s*\d+\.\s+\[(pending|in_progress|completed)\]\s+(.+?)\s*$/.exec(line)
        assert(match, 'Invalid TodoWrite item syntax')
        return { content: match[2], status: match[1] }
      }))
      const expected = [
        { content: 'Inspect synthetic cube', status: 'completed' },
        { content: 'Verify synthetic cube', status: 'completed' }
      ]
      for (const parsed of items) assert.deepEqual(parsed, expected, 'Unexpected live TodoWrite items')
      assert(liveEvents.some(e => e.type === 'tool_result' && e.toolUseId === ids[0] && e.isError === false && e.content === 'TODO List Updated'), 'Missing successful result for the TodoWrite call')
      assert.equal(result.text.trim(), 'LIVE_TODO_OK')
      report.cases.liveTodo = { status: 'passed', observed: true, distinctCallCount: ids.length, toolUseId: ids[0], input: complete.at(-1).toolUse.input, parsedItems: items.at(-1), exactItemsVerified: true, matchedSuccessfulResult: true, finalReplyVerified: true }
    }
    return report
  } catch (error) {
    report.failure = { stage, message: error.message }
    throw error
  } finally {
    clearTimeout(watchdog)
    if (serviceInfo) { try { process.kill(serviceInfo.pid) } catch (error) { if (error.code !== 'ESRCH') output({ serviceCleanupError: error.message }) } }
    for (const release of held.values()) release()
    daemon?.disconnect()
    if (daemonChild && daemonChild.exitCode === null && daemonChild.signalCode === null) {
      if (process.platform === 'win32') await new Promise(resolve => spawn('taskkill', ['/PID', String(daemonChild.pid), '/T', '/F'], { stdio: 'ignore' }).once('exit', resolve))
      else daemonChild.kill()
    }
    await stop()
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve))
    assert.equal(await readFile(join(directory, 'droid.json'), 'utf8'), originalSettings)
    output({ tasksReport: report })
  }
}

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createInterface } from 'node:readline'
import process from 'node:process'
import { homedir } from 'node:os'
import { setTimeout, clearTimeout } from 'node:timers'
/* global fetch, URL, AbortController */

// Keep literal source: bundling a function's dynamic imports adds external helpers.
const stdioFixture = String.raw`(() => {
  const fs = require('node:fs')
  fs.writeFileSync(process.argv[2], String(process.pid))
  const { createInterface } = require('node:readline')
  createInterface({ input: process.stdin }).on('line', line => {
    const m = JSON.parse(line)
    if (m.id === undefined) return
    let result = {}
    if (m.method === 'initialize') result = { protocolVersion: m.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'fixture-stdio', version: '1' } }
    if (m.method === 'tools/list') result = { tools: [{ name: 'echo', description: 'Synthetic echo', inputSchema: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'] } }] }
    if (m.method === 'tools/call') result = { content: [{ type: 'text', text: 'STDIO:' + m.params.arguments.value }] }
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result }) + '\n')
  }).on('close', () => process.exit(0))
})()
`

export async function validateNative({ binary, directory, workspace, home, output, sanitize, live }) {
  const publish = output
  output = value => publish(JSON.parse(JSON.stringify(value, (_key, item) => typeof item === 'string' ? sanitize(item) : item)))
  const sdk = await import(pathToFileURL(join(directory, 'sdk/node_modules/@factory/droid-sdk/dist/node.mjs')).href)
  const results = { suite: 'capabilities', sdk: '0.10.0', realModelCalls: 0, liveHttpStatuses: [], liveRequested: live, cases: [], mockRequests: 0 }
  const globalFiles = ['settings.json', 'config.json', 'mcp.json'].map(name => join(homedir(), '.factory', name))
  const snapshot = () => Promise.all(globalFiles.map(file => readFile(file).catch(e => { if (e.code === 'ENOENT') return null; throw e })))
  const originalGlobals = await snapshot()
  const notifications = []
  const toggleRequests = []
  const httpCalls = []
  const children = []
  const sessions = []
  let steps = []
  let requests = []
  let activeSession
  let cancelPending
  let slowResponse
  let slowClosed
  let liveTarget
  let liveFailed = false
  const liveBodies = new Set()
  const relay = createServer(async (req, res) => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 50000)
    res.on('close', () => controller.abort())
    try {
      let body = ''; for await (const chunk of req) body += chunk
      if (!liveTarget || liveFailed || liveBodies.has(body) || results.realModelCalls >= Math.min(8, Number(process.env.GB_DROID_MAX_CALLS ?? 8))) {
        res.writeHead(400).end('{"error":{"message":"Live validation forwarding stopped; no retries"}}'); return
      }
      assert(!body.includes('# GoodBuddy Agent Guide'))
      liveBodies.add(body)
      results.realModelCalls++
      const response = await fetch(new URL(req.url, liveTarget), { method: 'POST', headers: { 'content-type': 'application/json' }, body, signal: controller.signal })
      results.liveHttpStatuses.push(response.status)
      if (!response.ok) liveFailed = true
      res.writeHead(response.status, { 'content-type': response.headers.get('content-type') ?? 'application/json' })
      if (response.body) for await (const chunk of response.body) res.write(chunk)
      res.end()
    } catch { liveFailed = true; if (!res.headersSent) res.writeHead(502); res.end() }
    finally { clearTimeout(timer) }
  })
  const token = 'synthetic-capabilities-token'
  const factory = join(home, '.factory')
  const project = join(workspace, '.factory')
  const fixture = join(workspace, 'mcp-fixture.cjs')
  const pidFile = join(workspace, 'mcp.pid')
  const projectPidFile = join(workspace, 'mcp-project.pid')
  function isAlive(pid) {
    try { process.kill(pid, 0); return true } catch (error) { if (error.code === 'ESRCH') return false; throw error }
  }
  const script = join(project, 'skills', 'fixture-skill', 'produce.cjs')
  const command = `node "${script}"`
  const env = {}
  for (const key of ['PATH', 'SystemRoot', 'WINDIR', 'COMSPEC', 'PATHEXT']) if (process.env[key]) env[key] = process.env[key]
  Object.assign(env, { HOME: home, USERPROFILE: home, APPDATA: join(home, 'AppData/Roaming'), LOCALAPPDATA: join(home, 'AppData/Local'), TEMP: directory, TMP: directory, FACTORY_HOME_OVERRIDE: home, FACTORY_AIRGAP_ENABLED: '1', FACTORY_DROID_AUTO_UPDATE_ENABLED: '0', FACTORY_DISABLE_SETTINGS_PERSISTENCE: 'true' })
  async function check(name, action) {
    try { const evidence = await action(); results.cases.push({ name, pass: true, evidence }); output(results.cases.at(-1)) }
    catch (error) { results.cases.push({ name, pass: false, error: sanitize(error.message) }); output(results.cases.at(-1)) }
  }
  async function bounded(promise, label, ms = 25000) {
    let timer
    try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timeout`)), ms) })]) }
    finally { clearTimeout(timer) }
  }
  async function skill(base, name, body, front = '') {
    const folder = join(base, 'skills', name)
    await mkdir(folder, { recursive: true })
    await writeFile(join(folder, 'SKILL.md'), `---\nname: ${name}\ndescription: Synthetic capability validation ${name}\n${front}---\n${body}\n`)
  }
  const model = createServer(async (req, res) => {
    try {
      let raw = ''; for await (const chunk of req) raw += chunk
      const body = JSON.parse(raw)
      results.mockRequests++
      assert(results.mockRequests <= 45, 'Local model request budget exhausted')
      assert(!raw.includes('# GoodBuddy Agent Guide'), 'Parent instructions leaked')
      requests.push(body)
      const step = body.tools?.length ? steps[0] : undefined
      const delta = { role: 'assistant', content: step ? null : 'FIXTURE-DONE' }
      if (step) {
        const tool = body.tools?.find(t => t.function.name === step.name || t.function.name.endsWith(step.name))
        assert(tool, `Model tool absent: ${step.name}; available=${body.tools?.map(t => t.function.name).join(',')}`)
        steps.shift()
        delta.tool_calls = [{ index: 0, id: `call_${results.mockRequests}`, type: 'function', function: { name: tool.function.name, arguments: JSON.stringify(step.input) } }]
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      for (const [d, reason] of [[delta, null], [{}, step ? 'tool_calls' : 'stop']]) res.write(`data: ${JSON.stringify({ id: `chatcmpl-${results.mockRequests}`, object: 'chat.completion.chunk', created: 1, model: 'fixture', choices: [{ index: 0, delta: d, finish_reason: reason }] })}\n\n`)
      res.end('data: [DONE]\n\n')
    } catch (error) { output({ mockError: error.message }); res.writeHead(400).end(JSON.stringify({ error: { message: error.message } })) }
  })
  const mcp = createServer(async (req, res) => {
    if (req.headers.authorization !== `Bearer ${token}`) { httpCalls.push({ unauthorized: true, path: req.url, verb: req.method }); res.writeHead(401).end(); return }
    if (req.method !== 'POST') { res.writeHead(405).end(); return }
    let raw = ''; for await (const chunk of req) raw += chunk
    const m = JSON.parse(raw)
    httpCalls.push({ method: m.method, name: m.params?.name })
    if (m.id === undefined) {
      if (m.method === 'notifications/cancelled') slowResponse?.end()
      res.writeHead(202).end(); return
    }
    let result = {}
    if (m.method === 'initialize') result = { protocolVersion: m.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'fixture-http', version: '1' } }
    if (m.method === 'tools/list') result = { tools: ['echo', 'fail', 'slow'].map(name => ({ name, description: `Synthetic ${name}`, inputSchema: { type: 'object', properties: { value: { type: 'string' } } } })) }
    if (m.method === 'tools/call') {
      if (m.params.name === 'slow') {
        slowResponse = res
        slowClosed = new Promise(resolve => res.on('close', () => { httpCalls.push({ slowClosed: true }); resolve() }))
        cancelPending = activeSession.interrupt()
        return
      }
      result = { content: [{ type: 'text', text: m.params.name === 'fail' ? 'SYNTHETIC_TOOL_ERROR' : `HTTP:${m.params.arguments.value}` }], isError: m.params.name === 'fail' }
    }
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: m.id, result }))
  })
  async function start(cwd = workspace) {
    const child = spawn(binary, ['exec', '--input-format', 'stream-jsonrpc', '--output-format', 'stream-jsonrpc', '--settings', join(directory, 'capabilities.json'), '--cwd', cwd], { cwd, env, stdio: 'pipe' })
    children.push(child)
    child.stderr.resume()
    let handler = () => {}; let errorHandler = () => {}
    child.on('error', e => errorHandler(e))
    createInterface({ input: child.stdout }).on('line', line => {
      let m; try { m = JSON.parse(line) } catch { return }
      if (m.method === 'droid.session_notification') notifications.push(m.params)
      handler(m)
    })
    const transport = { isConnected: true, async connect() {}, async send(m) {
      if (m.method === 'droid.toggle_mcp_server') toggleRequests.push(m.params)
      child.stdin.write(JSON.stringify(m) + '\n')
    }, onMessage(fn) { handler = fn }, onError(fn) { errorHandler = fn }, async close() { child.stdin.end() } }
    const session = await bounded(sdk.createSession({ transport, cwd, modelId: 'custom:capabilities-0', autonomyLevel: 'off', disableBuiltinSkills: true,
      permissionHandler({ toolUses }) {
        const allowed = toolUses.length > 0 && toolUses.every(t => (t.details.type === sdk.ToolConfirmationType.Execute && t.details.fullCommand === command) || (t.details.type === sdk.ToolConfirmationType.McpTool && ['fixture-http', 'fixture-stdio'].includes(t.details.serverName)))
        output({ permission: toolUses.map(t => t.details), allowed })
        return allowed ? sdk.ToolConfirmationOutcome.ProceedOnce : sdk.ToolConfirmationOutcome.Cancel
      }
    }), 'initialize')
    sessions.push(session)
    return session
  }
  async function turn(session, sequence) {
    activeSession = session; steps = [...sequence]; requests = []
    const events = []
    await bounded((async () => { for await (const e of session.stream('Run the synthetic fixture validation. Use only the requested fixture tools.', { includePartialMessages: true })) events.push(e) })(), 'turn')
    assert.equal(steps.length, 0, 'Unconsumed scripted calls')
    output({ turnEvents: events.filter(e => ['tool_call', 'tool_result', 'result'].includes(e.type)).map(e => e.type === 'result' ? { type: e.type, subtype: e.subtype, interrupted: e.interrupted } : e) })
    return { events, context: JSON.stringify(requests) }
  }
  try {
    await Promise.all([new Promise(resolve => model.listen(0, '127.0.0.1', resolve)), new Promise(resolve => mcp.listen(0, '127.0.0.1', resolve))])
    results.droid = await bounded(new Promise((resolve, reject) => {
      const version = spawn(binary, ['--version'], { env, stdio: ['ignore', 'pipe', 'ignore'] })
      children.push(version)
      let text = ''; version.stdout.on('data', chunk => { text += chunk })
      version.once('error', reject); version.once('exit', code => code === 0 ? resolve(text.trim()) : reject(new Error('Version check failed')))
    }), 'version')
    await skill(factory, 'fixture-skill', 'USER-VERSION')
    await skill(project, 'fixture-skill', `PROJECT-VERSION\nRun Execute with command: ${command}\nThe script writes skill-output.txt with PROJECT-73.`)
    await skill(factory, 'user-only', 'USER-ONLY')
    await skill(project, 'disabled-front', 'DISABLED-BODY', 'enabled: false\n')
    await skill(project, 'disabled-ledger', 'LEDGER-BODY')
    if (live) await skill(project, 'live-capability', 'Use the secret synthetic value LIVE-SKILL-ORCHID-927. Call both already loaded fixture-stdio___echo and fixture-http___echo tools with value equal to that secret value. After both results return, quote both complete returned strings in your final answer. No other tools, files, or network. Do not retry failed calls.')
    await writeFile(join(project, 'settings.json'), JSON.stringify({ disabledSkills: ['disabled-ledger'] }))
    await writeFile(script, "require('node:fs').writeFileSync('skill-output.txt', 'PROJECT-73\\n'); console.log('SCRIPT-73')\n")
    await writeFile(fixture, stdioFixture)
    await writeFile(join(project, 'mcp.json'), JSON.stringify({ mcpServers: {
      'fixture-stdio': { type: 'stdio', command: 'node', args: [fixture, pidFile] },
      'fixture-project-toggle': { type: 'stdio', command: 'node', args: [fixture, projectPidFile] },
      'fixture-http': { type: 'http', url: `http://127.0.0.1:${mcp.address().port}/mcp`, headers: { Authorization: `Bearer ${token}` }, oauth: false },
      'fixture-badauth': { type: 'http', url: `http://127.0.0.1:${mcp.address().port}/badauth`, headers: { Authorization: 'Bearer synthetic-wrong' }, oauth: false, connectTimeout: 2000 },
      'fixture-disabled': { type: 'http', url: `http://127.0.0.1:${mcp.address().port}/disabled`, disabled: true, oauth: false }
    } }))
    const customModels = [{ model: 'fixture', displayName: 'capabilities', baseUrl: `http://127.0.0.1:${model.address().port}/v1`, apiKey: 'synthetic', provider: 'generic-chat-completion-api', maxOutputTokens: 800 }]
    if (live) {
      const settings = JSON.parse(await readFile(join(directory, 'droid.json'), 'utf8'))
      liveTarget = settings.customModels[0].baseUrl
      assert.equal(new URL(liveTarget).hostname, '127.0.0.1')
      results.liveModel = settings.customModels[0].model
      await new Promise(resolve => relay.listen(0, '127.0.0.1', resolve))
      settings.customModels[0].baseUrl = `http://127.0.0.1:${relay.address().port}/v1`
      customModels.push(settings.customModels[0])
    }
    await writeFile(join(directory, 'capabilities.json'), JSON.stringify({ customModels }))
    const session = await start()
    await check('skill-discovery-precedence', async () => {
      const { skills } = await session.listSkills()
      output({ skills })
      const selected = skills.find(s => s.name === 'fixture-skill' && s.enabled !== false)
      assert(selected?.content.includes('PROJECT-VERSION'))
      assert.equal(skills.find(s => s.name === 'disabled-front')?.enabled, false)
      assert.equal(skills.find(s => s.name === 'disabled-ledger')?.enabled, false)
      assert(skills.some(s => s.name === 'user-only'))
      assert(skills.every(s => s.filePath.startsWith(directory)))
      return { projectWins: true, frontmatterDisabled: true, ledgerDisabled: true, isolated: true }
    })
    await check('skill-toggle', async () => {
      assert((await session.setSkillDisabled({ skillName: 'fixture-skill', disabled: true, settingsLevel: sdk.SettingsLevel.Project })).success)
      assert.equal((await session.listSkills()).skills.find(s => s.name === 'fixture-skill')?.enabled, false)
      assert((await session.setSkillDisabled({ skillName: 'fixture-skill', disabled: false, settingsLevel: sdk.SettingsLevel.Project })).success)
      assert.notEqual((await session.listSkills()).skills.find(s => s.name === 'fixture-skill')?.enabled, false)
    })
    const tools = await session.listTools({ includeSchemas: true })
    output({ capabilityTools: tools.filter(t => ['Skill', 'Execute', 'ToolSearch'].includes(t.id) || t.id.startsWith('fixture-')).map(t => ({ id: t.id, allowed: t.allowed, inputKeys: Object.keys(t.schemas.input.properties), required: t.schemas.input.required })) })
    await check('skill-load-and-script', async () => {
      const { context } = await turn(session, [{ name: 'Skill', input: { skill: 'fixture-skill' } }, { name: 'Execute', input: { command, summary: 'Write synthetic skill output', riskLevel: 'medium' } }])
      assert(context.includes('PROJECT-VERSION')); assert(context.includes('SCRIPT-73'))
      assert.equal((await readFile(join(workspace, 'skill-output.txt'), 'utf8')).trim(), 'PROJECT-73')
    })
    await check('disabled-skill-not-invocable', async () => {
      const { events } = await turn(session, [{ name: 'Skill', input: { skill: 'disabled-front' } }])
      assert(events.some(e => e.type === 'tool_result' && e.toolName === 'Skill' && e.isError))
      assert(!JSON.stringify(requests).includes('DISABLED-BODY'))
    })
    await check('mcp-discovery', async () => {
      const servers = await session.listMcpServers(); const tools = await session.listMcpTools()
      output({ servers, mcpTools: tools })
      for (const name of ['fixture-stdio', 'fixture-http']) assert(tools.some(t => t.serverName === name))
      assert(!tools.some(t => ['fixture-disabled', 'fixture-unassigned'].includes(t.serverName)))
      assert(!requests.some(r => JSON.stringify(r.tools).includes('fixture-disabled')))
      return { disabledAbsent: true, unassignedAbsent: true }
    })
    const mcpTools = await session.listMcpTools()
    await check('mcp-authentication', async () => {
      const { servers } = await session.listMcpServers()
      assert.equal(servers.find(s => s.name === 'fixture-http')?.status, 'connected')
      assert.notEqual(servers.find(s => s.name === 'fixture-badauth')?.status, 'connected')
      assert(!mcpTools.some(t => t.serverName === 'fixture-badauth'))
      assert(httpCalls.some(c => c.unauthorized && c.path === '/badauth'))
      return { syntheticHeaderAccepted: true, wrongHeaderRejected: true, status: servers.find(s => s.name === 'fixture-badauth')?.status }
    })
    for (const [server, name, expected] of [['fixture-stdio', 'echo', 'STDIO:ORBIT-73'], ['fixture-http', 'echo', 'HTTP:ORBIT-73'], ['fixture-http', 'fail', 'SYNTHETIC_TOOL_ERROR']]) {
      await check(`${server}-${name}`, async () => {
        const found = mcpTools.find(t => t.serverName === server && t.name === name)
        assert(found, 'MCP tool not discovered')
        const id = tools.find(t => t.id === `${server}___${name}`)?.id
        assert(id)
        const { context, events } = await turn(session, [{ name: 'ToolSearch', input: { query: `select:${id}` } }, { name: id, input: { value: 'ORBIT-73' } }])
        assert(context.includes(expected), 'Tool result not returned to model')
        assert(events.some(e => e.type === 'tool_result' && e.content?.includes(expected) && Boolean(e.isError) === (name === 'fail')))
      })
    }
    await check('mcp-cancel', async () => {
      const found = mcpTools.find(t => t.serverName === 'fixture-http' && t.name === 'slow')
      assert(found)
      const { events } = await turn(session, [{ name: 'ToolSearch', input: { query: 'select:fixture-http___slow' } }, { name: 'fixture-http___slow', input: {} }])
      assert(cancelPending, 'Slow MCP tool was never called')
      await cancelPending
      assert(events.some(e => e.type === 'result' && e.interrupted === true), 'Cancellation did not produce interrupted result')
      assert(httpCalls.some(c => c.method === 'notifications/cancelled'), 'MCP peer did not receive cancellation')
      assert(slowClosed, 'Slow response close listener was not installed')
      await bounded(slowClosed, 'cooperative MCP response closure', 3000)
      results.httpCancellationReleased = true
      return { subtype: events.find(e => e.type === 'result')?.subtype, responseClosedBeforeTeardown: true, closureMechanism: 'Cooperative fixture ends response on notifications/cancelled; not proof of forced transport abort' }
    })
    await check('cancel-recovery', async () => {
      const { events } = await turn(session, [{ name: 'fixture-http___echo', input: { value: 'RECOVERED-73' } }])
      assert(events.some(e => e.type === 'tool_result' && e.content === 'HTTP:RECOVERED-73'))
    })
    if (live) await check(process.env.GB_DROID_CAPABILITIES_STDIO_ONLY === 'true' ? 'live-stdio-follow-up' : 'live-skill-and-mcp', async () => {
      const stdioOnly = process.env.GB_DROID_CAPABILITIES_STDIO_ONLY === 'true'
      const marker = 'LIVE-SKILL-ORCHID-927'
      const realSession = session
      await realSession.updateSettings({ modelId: 'custom:validation-1' })
      const events = []
      try {
        await bounded((async () => {
          for await (const event of realSession.stream(stdioOnly ? 'Synthetic acceptance follow-up. Call the already loaded fixture-stdio___echo tool once with value LIVE-STDIO-483, then quote its complete result. No other tools or retries.' : 'Synthetic capability acceptance test. Invoke Skill live-capability and follow its instructions exactly. It provides the secret value, so load the Skill before calling echo tools. Do not read files or use other skills. Keep the final answer short.', { includePartialMessages: true })) events.push(event)
        })(), 'live capability turn', 120000)
      } finally { await realSession.interrupt() }
      output({ liveEvents: events.filter(e => ['tool_call', 'tool_result', 'result'].includes(e.type)).map(e => e.type === 'result' ? { type: e.type, subtype: e.subtype, text: e.text } : e) })
      const expected = stdioOnly ? 'LIVE-STDIO-483' : marker
      if (!stdioOnly) assert(events.some(e => e.type === 'tool_result' && e.toolName === 'Skill' && !e.isError && e.content.includes(marker)))
      for (const [name, prefix] of (stdioOnly ? [['fixture-stdio___echo', 'STDIO']] : [['fixture-stdio___echo', 'STDIO'], ['fixture-http___echo', 'HTTP']])) {
        assert(events.some(e => e.type === 'tool_call' && e.name === name && e.input.value === expected))
        assert(events.some(e => e.type === 'tool_result' && e.toolName === name && !e.isError && e.content === `${prefix}:${expected}`))
      }
      const final = events.find(e => e.type === 'result')
      assert.equal(final?.subtype, 'success')
      assert(final.text.includes(`STDIO:${expected}`) && (stdioOnly || final.text.includes(`HTTP:${marker}`)))
      assert(!liveFailed)
      return { model: results.liveModel, calls: results.realModelCalls, statuses: results.liveHttpStatuses, scope: stdioOnly ? 'stdio-follow-up' : 'skill-stdio-http' }
    })
    const toggleSchema = sdk.ToggleMcpServerRequestParamsSchema
    const sdkSource = await readFile(join(directory, 'sdk/node_modules/@factory/droid-sdk/dist/node.mjs'), 'utf8')
    output({ toggleApi: {
      userAcceptedBySchema: toggleSchema.safeParse({ serverName: 'fixture-stdio', enabled: false, settingsLevel: sdk.SettingsLevel.User }).success,
      projectAcceptedBySchema: toggleSchema.safeParse({ serverName: 'fixture-project-toggle', enabled: false, settingsLevel: sdk.SettingsLevel.Project }).success,
      omittedScopeAcceptedBySchema: toggleSchema.safeParse({ serverName: 'fixture-stdio', enabled: false }).success,
      implementation: sdkSource.match(/async toggleMcpServer\(params\)\s*\{[\s\S]{0,700}?\n {2}\}/g)
    } })
    for (const [name, serverName, level, file] of [
      ['mcp-project-disable', 'fixture-project-toggle', sdk.SettingsLevel.Project, projectPidFile],
      ['mcp-user-override-disable', 'fixture-stdio', sdk.SettingsLevel.User, pidFile]
    ]) await check(name, async () => {
      const began = Date.now()
      // Capture the exact peer before toggling, before any second session exists.
      const pid = Number(await readFile(file, 'utf8'))
      assert(pid > 0 && isAlive(pid), 'Target fixture process was not running')
      const projectBefore = await readFile(join(project, 'mcp.json'))
      let ack
      try { ack = await session.toggleMcpServer({ serverName, enabled: false, settingsLevel: level }) }
      catch (error) {
        output({ rejectedToggleObservation: { scope: level, serverName, sentToDroid: toggleRequests.some(p => p.serverName === serverName), projectFileUnchanged: (await readFile(join(project, 'mcp.json'))).equals(projectBefore), targetStillAliveBeforeTeardown: isAlive(pid), status: (await session.listMcpServers()).servers.find(s => s.name === serverName)?.status, toolsStillEnabled: (await session.listMcpTools()).some(t => t.serverName === serverName && t.isEnabled), error: error.message } })
        throw error
      }
      assert(ack.success)
      let status
      for (let i = 0; i < 100; i++) {
        status = (await session.listMcpServers()).servers.find(s => s.name === serverName)?.status
        if (status === 'disabled' && !isAlive(pid)) break
        await new Promise(resolve => setTimeout(resolve, 100))
      }
      const projectAfter = await readFile(join(project, 'mcp.json'))
      const userConfig = JSON.parse(await readFile(join(factory, 'mcp.json'), 'utf8').catch(e => { if (e.code === 'ENOENT') return '{}'; throw e }))
      const evidence = { scope: level, serverName, elapsedMs: Date.now() - began, status, tools: (await session.listMcpTools()).filter(t => t.serverName === serverName), projectPersistedDisabled: JSON.parse(projectAfter).mcpServers?.[serverName]?.disabled ?? false, userPersistedDisabled: userConfig.mcpServers?.[serverName]?.disabled ?? false, projectFileUnchanged: projectAfter.equals(projectBefore), targetPid: pid, targetExitedBeforeTeardown: !isAlive(pid) }
      output({ disableObservation: evidence })
      if (level === sdk.SettingsLevel.Project) assert(evidence.projectPersistedDisabled, 'Project toggle did not persist in project config')
      else { assert(evidence.userPersistedDisabled); assert(evidence.projectFileUnchanged) }
      assert.equal(status, 'disabled')
      assert(!evidence.tools.some(t => t.isEnabled))
      assert(evidence.targetExitedBeforeTeardown, 'Target MCP process remained alive after disable')
      return evidence
    })
    await check('project-isolation-user-fallback', async () => {
      const other = join(directory, 'other-workspace')
      await mkdir(other, { recursive: true })
      await new Promise((resolve, reject) => {
        const git = spawn('git', ['init', '--quiet', other], { stdio: 'ignore' })
        git.once('error', reject); git.once('exit', code => code === 0 ? resolve() : reject(new Error('git init failed')))
      })
      const isolated = await start(other)
      const { skills } = await isolated.listSkills()
      assert.equal(skills.find(s => s.name === 'fixture-skill')?.content, 'USER-VERSION')
      assert(!skills.some(s => s.location === 'project'))
      assert(!(await isolated.listMcpTools()).some(t => t.serverName === 'fixture-http'))
      return { projectSkillsAbsent: true, projectMcpAbsent: true, userVersionLoaded: true }
    })
    output({ capabilityNotifications: notifications.filter(n => ['tool_call', 'tool_result', 'mcp_status_changed', 'agent_turn_completed'].includes(n.notification.type)).map(n => ({ sessionId: n.sessionId, type: n.notification.type, keys: Object.keys(n.notification), toolUseId: n.notification.toolUseId ?? n.notification.toolUse?.id, messageId: n.notification.messageId, isError: n.notification.isError, reason: n.notification.reason, servers: n.notification.servers })), httpCalls })
  } finally {
    for (const session of sessions) await bounded(session.close(), 'close', 5000).catch(e => output({ closeError: e.message }))
    for (const child of children) {
      if (child.exitCode === null) child.kill()
      if (child.exitCode === null) await bounded(new Promise(resolve => child.once('exit', resolve)), 'process exit', 5000)
    }
    model.closeAllConnections(); mcp.closeAllConnections(); relay.closeAllConnections()
    await Promise.all([new Promise(resolve => model.close(resolve)), new Promise(resolve => mcp.close(resolve)), new Promise(resolve => relay.close(resolve))])
    results.stdioExited = true
    for (const file of [pidFile, projectPidFile]) {
      const pid = Number(await readFile(file, 'utf8').catch(() => '0'))
      if (pid) {
        const alive = isAlive(pid)
        results.stdioExited &&= !alive
        if (alive) process.kill(pid)
      } else results.stdioExited = false
    }
    const afterGlobals = await snapshot()
    results.globalConfigsUnchanged = originalGlobals.every((before, i) => before === null ? afterGlobals[i] === null : afterGlobals[i] !== null && before.equals(afterGlobals[i]))
    output({ capabilities: results })
  }
  assert(results.globalConfigsUnchanged, 'Original Factory configs changed')
  assert(results.stdioExited, 'Droid left its fixture stdio process running')
  assert(results.httpCancellationReleased, 'Cancelled HTTP fixture connection remained open')
  assert(results.cases.every(c => c.pass), 'Capability assertions failed; see individual cases')
  return results
}

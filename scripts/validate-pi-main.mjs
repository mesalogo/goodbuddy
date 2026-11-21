import { app, net, safeStorage, utilityProcess } from 'electron'
import { createServer } from 'node:http'
import { existsSync } from 'node:fs'
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import process from 'node:process'
import console from 'node:console'
import { setTimeout } from 'node:timers'
import { setTimeout as delay } from 'node:timers/promises'
import assert from 'node:assert/strict'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { z } from 'zod'
import { RuntimeSettingsStore } from '../src/main/runtime-settings-store'
import { createOpenAIResponsesUrl, createOpenAIChatCompletionsUrl } from '../src/main/agent/openai-endpoint'
/* global AbortController */

const directory = process.env.GB_PI_DIRECTORY
const live = process.env.GB_PI_LIVE === 'true'
const maxCalls = Number(process.env.GB_PI_MAX_CALLS ?? 0)
const bundle = process.env.GB_PI_BUNDLE
const workspace = join(directory, 'workspace')
const home = join(directory, 'home')
const agentDir = join(home, '.pi', 'agent')
const sessionDirectory = join(directory, 'sessions')
const skillDirectory = join(directory, 'skills')
const mcpToken = `probe-${process.pid}-${Date.now()}`
app.setPath('userData', join(directory, 'electron'))
const report = { live, stages: [], requests: [], paidAttempts: 0, networkIsolationProven: false }
const output = value => console.log(`PI_REPORT ${JSON.stringify(value)}`)
let profile
let host
let events = []
let todos = []
let subagents = []
let pendingQuestions = []
let answerWith = 'blue'
let mockMode = 'script'
let readyMessage
const waiters = new Set()
const sanitize = value => {
  for (const secret of [profile?.apiKey, ...Object.values(profile?.requestHeaders ?? {})]) if (secret) value = value.replaceAll(secret, '[redacted]')
  return value.replace(/https?:\/\/\S+/g, '[endpoint]').replace(/(?:sk-|fk-)[\w-]+/g, '[credential]')
}

function onHostMessage(message) {
  if (message.type === 'event') events.push(message.event)
  if (message.type === 'todo') todos.push(message)
  if (message.type === 'subagent') subagents.push(message)
  if (message.type === 'question') {
    pendingQuestions.push(message)
    if (answerWith !== null) setTimeout(() => host.postMessage({ type: 'answer', id: message.id, value: answerWith === 'skip' ? undefined : answerWith }), 150)
  }
  for (const waiter of [...waiters]) if (waiter.match(message)) { waiters.delete(waiter); waiter.resolve(message) }
}
function waitFor(match, ms = 60000) {
  return new Promise((resolve, reject) => {
    const waiter = { match, resolve }
    waiters.add(waiter)
    setTimeout(() => { if (waiters.delete(waiter)) reject(new Error('stage timeout')) }, ms)
  })
}
async function startHost(extra = {}) {
  const env = { HOME: home, USERPROFILE: home, APPDATA: join(home, 'AppData', 'Roaming'), LOCALAPPDATA: join(home, 'AppData', 'Local'), TEMP: directory, TMP: directory,
    PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: '1', PI_SKIP_VERSION_CHECK: '1', PI_TELEMETRY: '0' }
  for (const key of ['PATH', 'Path', 'SystemRoot', 'WINDIR', 'COMSPEC', 'PATHEXT', 'ProgramFiles', 'ProgramW6432']) if (process.env[key]) env[key] = process.env[key]
  host = utilityProcess.fork(join(directory, 'host.mjs'), [], { cwd: workspace, env, serviceName: 'goodbuddy-pi-validation', stdio: ['ignore', 'ignore', 'pipe'] })
  host.stderr.resume()
  host.on('message', onHostMessage)
  const ready = waitFor(message => message.type === 'ready' || message.type === 'fatal', 60000)
  host.postMessage({ type: 'start', config: {
    bundle, workspace, agentDir, sessionDirectory, skillDirectory, model: profile?.modelName ?? 'goodbuddy-script', noDiscoveredExtensions: true,
    tools: process.platform === 'win32' ? ['read', 'powershell', 'edit', 'write', 'grep', 'find', 'ls'] : ['read', 'bash', 'edit', 'write', 'grep', 'find', 'ls'],
    instructions: 'GoodBuddy validation session. Use only the fixture workspace.', ...extra
  } })
  readyMessage = await ready
  if (readyMessage.type === 'fatal') throw new Error(readyMessage.message)
  return readyMessage
}
async function stopHost() {
  if (!host) return
  const owned = host
  host = undefined
  const exited = new Promise(resolve => owned.once('exit', resolve))
  owned.postMessage({ type: 'dispose' })
  await Promise.race([exited, delay(3000).then(() => owned.kill())])
}
let promptSequence = 0
async function prompt(text, ms = 60000) {
  events = []
  const id = ++promptSequence
  const done = waitFor(message => message.type === 'prompt-done' && message.id === id, ms)
  host.postMessage({ type: 'prompt', id, text })
  const result = await done
  const deltas = events.filter(e => e.kind === 'text' && !e.parent)
  return { stopReason: result.stopReason, error: result.error && sanitize(result.error), text: sanitize(result.text), textDeltas: deltas.length, tools: events.filter(e => e.kind === 'tool' && !e.parent).map(e => `${e.name}:${e.state}`), childEvents: events.filter(e => e.parent).length, settled: events.some(e => e.kind === 'settled' && !e.parent), rss: result.rss }
}
async function run(name, action) {
  const started = Date.now()
  try { const result = await action(); report.stages.push({ name, ok: true, ms: Date.now() - started, result }) }
  catch (error) { report.stages.push({ name, ok: false, ms: Date.now() - started, error: sanitize(String(error?.message ?? error)).slice(0, 400) }) }
  output(report.stages.at(-1))
}

// Deterministic OpenAI Chat Completions model. Each scenario is selected by a marker in the latest user turn.
function contentText(content) { return typeof content === 'string' ? content : JSON.stringify(content ?? '') }
function script(body) {
  const messages = body.messages ?? []
  const system = messages.filter(m => m.role === 'system' || m.role === 'developer').map(m => contentText(m.content)).join('\n')
  const lastUser = [...messages].reverse().find(m => m.role === 'user')
  const marker = /SCENARIO:([\w-]+)/.exec(contentText(lastUser?.content))?.[1]
  const last = messages.at(-1)
  const toolResult = last?.role === 'tool' ? contentText(last.content) : undefined
  const call = (name, args) => ({ tool: { name, args } })
  if (system.includes('read-only child agent')) return { text: 'CHILD-OK' }
  if (marker === 'remember') return { text: 'READY-41' }
  if (marker === 'recall') return { text: messages.some(m => m.role === 'user' && contentText(m.content).includes('PI-TOKEN-41')) ? 'PI-TOKEN-41' : 'MISSING' }
  if (marker === 'shell') return toolResult ? { text: `SHELL=${toolResult.includes('PI-SHELL-OK') ? 'ok' : 'bad'}` } : call(process.platform === 'win32' ? 'powershell' : 'bash', { command: 'Write-Output PI-SHELL-OK; $PSVersionTable.PSVersion.Major' })
  if (marker === 'files') {
    const toolCount = messages.slice(messages.lastIndexOf(lastUser)).filter(m => m.role === 'tool').length
    if (toolCount === 0) return call('read', { path: 'input.txt' })
    if (toolCount === 1) return call('write', { path: 'output.txt', content: /fixture-value: PI-\d+/.exec(toolResult ?? '')?.[0] ?? `missing:${String(toolResult).slice(0, 120)}` })
    return { text: 'FILES-DONE' }
  }
  if (marker === 'skill') {
    const location = /<location>([^<]+gb-probe-skill[^<]*)<\/location>/.exec(system)?.[1]
    if (!location) return { text: 'SKILL-NOT-ADVERTISED' }
    return toolResult ? { text: /SKILL-MARKER-\d+/.exec(toolResult)?.[0] ?? 'SKILL-UNREAD' } : call('read', { path: location })
  }
  if (marker === 'mcp') return toolResult ? { text: `MCP=${/MCP-ECHO:\S+/.exec(toolResult)?.[0] ?? 'missing'}` } : call('mcp__probe__echo', { value: 'blue-41' })
  if (marker === 'question') return toolResult ? { text: `COLOR=${toolResult.trim()}` } : call('goodbuddy_ask_user', { question: 'Which fixture color?', options: ['red', 'blue'] })
  if (marker === 'todo') return toolResult ? { text: 'TODO-DONE' } : call('goodbuddy_todo_write', { items: [{ content: 'Inspect fixture', status: 'completed' }, { content: 'Report result', status: 'in_progress' }] })
  if (marker === 'subagent') return toolResult ? { text: `PARENT-SAW=${toolResult.trim()}` } : call('goodbuddy_subagent', { task: 'Reply CHILD-OK' })
  if (marker === 'cancel') return toolResult ? { text: 'UNEXPECTED-COMPLETE' } : call(process.platform === 'win32' ? 'powershell' : 'bash', {
    command: 'node -e "const f=require(\'fs\');f.writeFileSync(\'pid.txt\',String(process.pid));setTimeout(()=>f.writeFileSync(\'late.txt\',\'late\'),9000)"', timeout: 60
  })
  if (marker === 'error') return { error: true }
  return { text: 'UNKNOWN-SCENARIO' }
}
function writeChunk(res, delta, finish) { res.write(`data: ${JSON.stringify({ id: 'mock', object: 'chat.completion.chunk', created: 0, model: 'goodbuddy-script', choices: [{ index: 0, delta, finish_reason: finish ?? null }] })}\n\n`) }
async function mockChat(body, res) {
  const plan = script(body)
  report.requests.push({ mode: 'script', tools: (body.tools ?? []).map(tool => tool.function?.name).filter(Boolean).sort().join(','), result: plan.tool?.name ?? plan.text ?? 'error' })
  if (plan.error) { res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { message: 'Synthetic mock upstream failure' } })); return }
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  writeChunk(res, { role: 'assistant' })
  if (plan.tool) {
    writeChunk(res, { tool_calls: [{ index: 0, id: `call_${report.requests.length}`, type: 'function', function: { name: plan.tool.name, arguments: '' } }] })
    const args = JSON.stringify(plan.tool.args)
    for (let i = 0; i < args.length; i += 24) writeChunk(res, { tool_calls: [{ index: 0, function: { arguments: args.slice(i, i + 24) } }] })
    writeChunk(res, {}, 'tool_calls')
  } else {
    for (const part of plan.text.match(/.{1,4}/g)) { writeChunk(res, { content: part }); await delay(5) }
    writeChunk(res, {}, 'stop')
  }
  res.write(`data: ${JSON.stringify({ id: 'mock', object: 'chat.completion.chunk', created: 0, model: 'goodbuddy-script', choices: [], usage: { prompt_tokens: 11, completion_tokens: 3, total_tokens: 14 } })}\n\n`)
  res.end('data: [DONE]\n\n')
}
async function forward(path, raw, req, res) {
  const record = { mode: 'live', status: null }
  report.requests.push(record)
  if (report.paidAttempts >= maxCalls) { record.status = 429; res.writeHead(429, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { message: 'Validation request budget exhausted' } })); return }
  report.paidAttempts++
  const controller = new AbortController()
  res.on('close', () => controller.abort())
  try {
    const body = { ...JSON.parse(raw), ...profile.requestBody, model: profile.modelName }
    const headers = { 'Content-Type': 'application/json', ...profile.requestHeaders }
    if (profile.authentication !== 'none' && profile.apiKey) headers.Authorization = `Bearer ${profile.apiKey}`
    const url = path.endsWith('/responses') ? createOpenAIResponsesUrl(profile.baseUrl) : createOpenAIChatCompletionsUrl(profile.baseUrl)
    const response = await net.fetch(url.toString(), { method: 'POST', headers, body: JSON.stringify(body), signal: controller.signal, redirect: 'error' })
    record.status = response.status
    res.writeHead(response.status, { 'content-type': response.headers.get('content-type') ?? 'application/json' })
    if (response.body) for await (const chunk of response.body) res.write(chunk)
    res.end()
  } catch (error) {
    record.error = controller.signal.aborted ? 'aborted' : sanitize(String(error?.message ?? '')).slice(0, 160)
    if (!res.headersSent) res.writeHead(502)
    res.end()
  }
}
function createMcp() {
  const server = createServer(async (req, res) => {
    if (req.headers.authorization !== `Bearer ${mcpToken}`) { report.mcpRejected = (report.mcpRejected ?? 0) + 1; res.writeHead(401).end(); return }
    const mcp = new McpServer({ name: 'probe', version: '1.0.0' })
    mcp.registerTool('echo', { description: 'Echo a fixture value', inputSchema: { value: z.string() } }, async ({ value }) => ({ content: [{ type: 'text', text: `MCP-ECHO:${value}` }] }))
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
    res.on('close', () => { void transport.close(); void mcp.close() })
    await mcp.connect(transport)
    let raw = ''; for await (const chunk of req) raw += chunk
    await transport.handleRequest(req, res, raw ? JSON.parse(raw) : undefined)
  })
  return server
}
const alive = pid => { try { process.kill(pid, 0); return true } catch { return false } }

async function main() {
  await Promise.all([workspace, agentDir, sessionDirectory, join(skillDirectory, 'gb-probe-skill'), join(directory, 'electron')].map(p => mkdir(p, { recursive: true })))
  await writeFile(join(workspace, 'input.txt'), 'fixture-value: PI-41\n')
  await writeFile(join(skillDirectory, 'gb-probe-skill', 'SKILL.md'), '---\nname: gb-probe-skill\ndescription: GoodBuddy probe skill. Read it when asked for the probe skill marker.\n---\n\nThe probe marker is SKILL-MARKER-4127.\n')
  await app.whenReady()
  if (live) {
    const source = process.env.GB_PI_SETTINGS ?? join(process.env.APPDATA, 'goodbuddy', 'runtime-settings.json')
    const snapshot = join(directory, 'snapshot.json')
    await writeFile(snapshot, await readFile(source))
    const settings = await new RuntimeSettingsStore(snapshot, { isAvailable: () => safeStorage.isEncryptionAvailable(), encrypt: () => { throw new Error('read only') }, decrypt: value => safeStorage.decryptString(value) }, {}).getResolvedSettings()
    await unlink(snapshot)
    profile = settings.modelProfiles.find(p => p.id === settings.defaultModelProfileId)
    if (!profile || !['openai-responses', 'openai-chat-completions'].includes(profile.protocol)) throw new Error('Default profile must use an OpenAI protocol')
    report.model = profile.modelName; report.protocol = profile.protocol
  }
  const modelServer = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk
    if (mockMode === 'live') return forward(req.url, raw, req, res)
    if (!req.url.endsWith('/chat/completions')) { res.writeHead(404).end(); return }
    return mockChat(JSON.parse(raw), res)
  })
  const mcpServer = createMcp()
  await Promise.all([modelServer, mcpServer].map(server => new Promise(resolve => server.listen(0, '127.0.0.1', resolve))))
  const modelPort = modelServer.address().port
  const api = live ? (profile.protocol === 'openai-responses' ? 'openai-responses' : 'openai-completions') : 'openai-completions'
  await writeFile(join(agentDir, 'models.json'), JSON.stringify({ providers: { goodbuddy: { baseUrl: `http://127.0.0.1:${modelPort}/v1`, api, apiKey: 'goodbuddy-loopback-placeholder', authHeader: true,
    models: [{ id: profile?.modelName ?? 'goodbuddy-script', name: 'GoodBuddy', reasoning: false, input: ['text'], contextWindow: 128000, maxTokens: 4000, compat: { supportsStrictMode: false } }] } } }))
  await writeFile(join(agentDir, 'mcp.json'), JSON.stringify({ mcpServers: { probe: { url: `http://127.0.0.1:${mcpServer.address().port}/mcp`, headers: { Authorization: `Bearer ${mcpToken}` }, exposure: 'direct' } } }))
  try {
    await run('start', async () => { const r = await startHost(); return { ms: r.ms, rssMiB: +(r.rss / 1048576).toFixed(1), version: r.version, tools: r.tools.join(','), skills: r.skills, extensionErrors: r.extensionErrors } })
    if (!live) {
      await run('text-stream', async () => { const r = await prompt('SCENARIO:remember Remember PI-TOKEN-41. Reply READY-41.'); assert.equal(r.text, 'READY-41'); assert(r.textDeltas > 1); assert(r.settled); return r })
      await run('multiturn', async () => { const r = await prompt('SCENARIO:recall Which token?'); assert.equal(r.text, 'PI-TOKEN-41'); return r })
      await run('shell', async () => { const r = await prompt('SCENARIO:shell'); assert.equal(r.text, 'SHELL=ok'); return r })
      await run('files', async () => { const r = await prompt('SCENARIO:files'); assert.equal((await readFile(join(workspace, 'output.txt'), 'utf8')).trim(), 'fixture-value: PI-41'); return r })
      await run('skill', async () => { const r = await prompt('SCENARIO:skill'); assert.equal(r.text, 'SKILL-MARKER-4127'); return r })
      await run('mcp', async () => { const r = await prompt('SCENARIO:mcp'); assert.equal(r.text, 'MCP=MCP-ECHO:blue-41'); return { ...r, mcpRejected: report.mcpRejected ?? 0 } })
      await run('question-answer', async () => { pendingQuestions = []; answerWith = 'blue'; const r = await prompt('SCENARIO:question'); assert.equal(r.text, 'COLOR=blue'); return { ...r, questions: pendingQuestions.map(q => ({ title: q.title, options: q.options })) } })
      await run('question-skip', async () => { answerWith = 'skip'; const r = await prompt('SCENARIO:question'); assert.match(r.text, /skipped/i); return r })
      answerWith = 'blue'
      await run('todo', async () => { todos = []; const r = await prompt('SCENARIO:todo'); assert.equal(todos.length, 1); assert.deepEqual(todos[0].items.map(i => i.status), ['completed', 'in_progress']); return { ...r, todo: todos[0].items } })
      await run('subagent', async () => { subagents = []; const r = await prompt('SCENARIO:subagent'); assert.equal(r.text, 'PARENT-SAW=CHILD-OK'); assert(r.childEvents > 0); return { ...r, subagentStates: subagents.map(s => s.state) } })
      await run('upstream-error', async () => { const r = await prompt('SCENARIO:error'); assert.equal(r.stopReason, 'error'); return r })
      await run('error-recovery', async () => { const r = await prompt('SCENARIO:recall again'); assert.equal(r.text, 'PI-TOKEN-41'); return r })
      await run('cancel-command', async () => {
        await unlink(join(workspace, 'pid.txt')).catch(() => {})
        const pending = prompt('SCENARIO:cancel')
        for (let i = 0; i < 100 && !existsSync(join(workspace, 'pid.txt')); i++) await delay(100)
        const pid = Number(await readFile(join(workspace, 'pid.txt'), 'utf8'))
        const aborted = waitFor(m => m.type === 'aborted', 15000)
        host.postMessage({ type: 'abort' })
        await aborted
        const r = await pending
        await delay(10000)
        assert.equal(alive(pid), false, 'descendant still alive')
        assert.equal(existsSync(join(workspace, 'late.txt')), false, 'descendant completed after cancel')
        return { ...r, descendantExited: true }
      })
      await run('cancel-recovery', async () => { const r = await prompt('SCENARIO:recall after cancel'); assert.equal(r.text, 'PI-TOKEN-41'); return r })
      await run('restart-resume', async () => {
        const file = readyMessage.sessionFile
        await stopHost()
        const r0 = await startHost({ sessionFile: file })
        const r = await prompt('SCENARIO:recall after restart')
        assert.equal(r.text, 'PI-TOKEN-41')
        return { ...r, sameSession: r0.sessionFile === file }
      })
    } else {
      mockMode = 'live'
      await run('live-text', async () => { const r = await prompt('Reply exactly PI-LIVE-OK. Do not use tools.'); assert.equal(r.text.trim(), 'PI-LIVE-OK'); return r })
      await run('live-shell', async () => { const r = await prompt(`Use the ${process.platform === 'win32' ? 'powershell' : 'bash'} tool to run: Write-Output PI-SHELL-OK . Then reply only with the command output line.`); assert.match(r.text, /PI-SHELL-OK/); return r })
      await run('live-skill', async () => { const r = await prompt('Read the gb-probe-skill skill file and reply only with its probe marker.'); assert.match(r.text, /SKILL-MARKER-4127/); return r })
      await run('live-mcp', async () => { const r = await prompt('Call the mcp__probe__echo tool with value "live-41" and reply only with its exact output.'); assert.match(r.text, /MCP-ECHO:live-41/); return r })
      await run('live-question', async () => { pendingQuestions = []; answerWith = 'blue'; const r = await prompt('Call goodbuddy_ask_user with question "Which fixture color?" and options ["red","blue"]. Then reply exactly COLOR=<answer>.'); assert.equal(r.text.trim(), 'COLOR=blue'); return { ...r, questions: pendingQuestions.length } })
      await run('live-todo-subagent', async () => { todos = []; subagents = []; const r = await prompt('First call goodbuddy_todo_write with two items: "Ask child" in_progress and "Report" pending. Then call goodbuddy_subagent with task "Reply exactly CHILD-LIVE-OK". Finally reply only with the child answer.'); assert.match(r.text, /CHILD-LIVE-OK/); assert(todos.length >= 1); return { ...r, todoUpdates: todos.length, subagentStates: subagents.map(s => s.state) } })
    }
  } finally {
    await stopHost()
    modelServer.closeAllConnections(); mcpServer.closeAllConnections()
    await Promise.all([modelServer, mcpServer].map(server => new Promise(resolve => server.close(() => resolve()))))
    output({ summary: { passed: report.stages.filter(s => s.ok).length, failed: report.stages.filter(s => !s.ok).map(s => s.name), paidAttempts: report.paidAttempts, liveStatuses: report.requests.filter(r => r.mode === 'live').map(r => r.status ?? r.error), scriptedRequests: report.requests.filter(r => r.mode === 'script').length } })
  }
}
main().then(() => app.exit(report.stages.some(s => !s.ok) ? 1 : 0)).catch(error => { output({ fatal: sanitize(String(error?.message ?? error)).slice(0, 400) }); void stopHost().finally(() => app.exit(1)) })

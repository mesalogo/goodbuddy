import { app, safeStorage, net } from 'electron'
import { readFile, writeFile, mkdir, unlink } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import { homedir } from 'node:os'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { createInterface } from 'node:readline'
import { RuntimeSettingsStore } from '../src/main/runtime-settings-store'
import { createOpenAIResponsesUrl, createOpenAIChatCompletionsUrl } from '../src/main/agent/openai-endpoint'
import process from 'node:process'
import console from 'node:console'
import { setTimeout, clearTimeout } from 'node:timers'
import assert from 'node:assert/strict'
import { validateNative } from './validate-droid-native.mjs'
import { validateNative as validateCapabilities } from './validate-droid-capabilities.mjs'
import { validateNative as validateTasks } from './validate-droid-tasks.mjs'
import { validateNative as validateSession } from './validate-droid-session.mjs'
/* global AbortController */

const directory = process.env.GB_DROID_DIRECTORY
const live = process.env.GB_DROID_LIVE === 'true'
const questionOnly = process.env.GB_DROID_QUESTION_ONLY === 'true'
const textOnly = process.env.GB_DROID_TEXT_ONLY === 'true'
const source = process.env.GB_DROID_SETTINGS ?? join(process.env.APPDATA, 'goodbuddy', 'runtime-settings.json')
const binary = process.env.GB_DROID_BINARY ?? join(homedir(), 'bin', 'droid.exe')
const workspace = join(directory, 'workspace')
const home = join(directory, 'home')
const profileDir = join(directory, 'electron')
app.setPath('userData', profileDir)
const report = { live, stages: [], attempts: [], callbacks: [], methods: [], updates: {}, tools: [], networkIsolationProven: false }
let stage = 'bootstrap'
let child
let profile
let proxyMode = 'blocked'
let sequence = 0
let text = ''
let chunks = 0
let cancelOnRequest = false
let sessionId = ''
const pending = new Map()
const output = value => console.log(`DROID_REPORT ${JSON.stringify(value)}`)
function sanitize(value) {
  for (const secret of [profile?.apiKey, ...Object.values(profile?.requestHeaders ?? {})]) if (secret) value = value.replaceAll(secret, '[redacted]')
  return value.replace(/https?:\/\/\S+/g, '[endpoint]').replace(/(?:sk-|fk-)[\w-]+/g, '[credential]')
}
const safeError = error => ({ code: error?.code, message: /timeout/i.test(error?.message ?? '') ? 'stage timeout' : sanitize(String(error?.message ?? '')).slice(0, 240) })
function send(method, params, notification = false) {
  report.methods.push(method)
  const id = ++sequence
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...(notification ? {} : { id }), method, params }) + '\n')
  if (notification) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('stage timeout')) }, 55000)
    pending.set(id, { resolve, reject, timer })
  })
}
async function run(name, action) {
  stage = name
  const started = Date.now()
  try { const result = await action(); report.stages.push({ name, ok: true, ms: Date.now() - started, result }); output(report.stages.at(-1)); return result }
  catch (error) {
    if (/timeout/i.test(error.message) && child?.stdin.writable && sessionId) {
      await send('session/cancel', { sessionId }, true).catch(() => {})
    }
    report.stages.push({ name, ok: false, ms: Date.now() - started, error: safeError(error) }); output(report.stages.at(-1)); return undefined
  }
}
async function stop() {
  if (!child) return
  const owned = child
  if (owned.exitCode === null) {
    owned.kill()
    await Promise.race([new Promise(resolve => owned.once('exit', resolve)), new Promise(resolve => setTimeout(resolve, 3000))])
  }
  for (const p of pending.values()) { clearTimeout(p.timer); p.reject(new Error('runtime stopped')) }
  pending.clear()
}
async function start() {
  const env = {}
  for (const key of ['PATH', 'SystemRoot', 'WINDIR', 'COMSPEC', 'PATHEXT']) if (process.env[key]) env[key] = process.env[key]
  Object.assign(env, { HOME: home, USERPROFILE: home, APPDATA: join(home, 'AppData', 'Roaming'), LOCALAPPDATA: join(home, 'AppData', 'Local'), TEMP: directory, TMP: directory,
    FACTORY_HOME_OVERRIDE: home, FACTORY_AIRGAP_ENABLED: '1', FACTORY_DROID_AUTO_UPDATE_ENABLED: '0', FACTORY_DISABLE_SETTINGS_PERSISTENCE: 'true' })
  child = spawn(binary, ['exec', '--output-format', 'acp', '--settings', join(directory, 'droid.json'), '--cwd', workspace], { cwd: workspace, env, stdio: 'pipe' })
  child.stderr.resume()
  createInterface({ input: child.stdout }).on('line', async line => {
    let message
    try { message = JSON.parse(line) } catch { return }
    if (!message.method) {
      const waiter = pending.get(message.id)
      if (!waiter) return
      clearTimeout(waiter.timer); pending.delete(message.id)
      if (message.error) waiter.reject(Object.assign(new Error(message.error.message), { code: message.error.code }))
      else waiter.resolve(message.result)
      return
    }
    if (message.method === 'session/update') {
      const u = message.params.update
      report.updates[u.sessionUpdate] = (report.updates[u.sessionUpdate] ?? 0) + 1
      if (u.sessionUpdate === 'tool_call' || u.sessionUpdate === 'tool_call_update') report.tools.push({ stage, type: u.sessionUpdate, title: sanitize(u.title ?? ''), kind: u.kind, status: u.status, inputKeys: Object.keys(u.rawInput ?? {}), content: stage === 'ask-user-question' ? sanitize(JSON.stringify(u.content ?? [])).slice(0, 1500) : undefined })
      if (u.sessionUpdate === 'agent_message_chunk' && u.content?.type === 'text') { text += u.content.text; chunks++ }
      return
    }
    if (message.id === undefined) return
    report.callbacks.push({ stage, method: message.method })
    let result
    try {
      if (message.method === 'session/request_permission') {
        const option = message.params.options.find(o => o.kind === 'allow_once')
        result = option ? { outcome: { outcome: 'selected', optionId: option.optionId } } : { outcome: { outcome: 'cancelled' } }
      } else if (message.method === 'fs/read_text_file' || message.method === 'fs/write_text_file') {
        const file = resolve(message.params.path)
        if (!file.startsWith(workspace + sep)) throw new Error('outside fixture')
        if (message.method === 'fs/read_text_file') result = { content: await readFile(file, 'utf8') }
        else { await writeFile(file, message.params.content); result = {} }
      } else throw new Error('unsupported callback')
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }) + '\n')
    } catch { child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Unsupported fixture callback' } }) + '\n') }
  })
  return send('initialize', { protocolVersion: 1, clientInfo: { name: 'goodbuddy-droid-validation', version: '1' }, clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: false } })
}
async function prompt(value, expectedText) {
  text = ''; chunks = 0
  const result = await send('session/prompt', { sessionId, prompt: [{ type: 'text', text: value + '\nSynthetic validation only. Do not access files outside the current fixture workspace. No network tools, subagents, or shell commands.' }] })
  if (expectedText) {
    assert.equal(text.trim(), expectedText, 'Unexpected synthetic response')
    assert(chunks > 0, 'No ACP text chunk received')
  }
  return { ...result, text: sanitize(text).slice(0, 500), chunks }
}

async function main() {
  await Promise.all([mkdir(workspace, { recursive: true }), mkdir(home, { recursive: true }), mkdir(profileDir, { recursive: true })])
  // Stop repository discovery at the synthetic fixture instead of the parent checkout.
  await new Promise((resolve, reject) => {
    const git = spawn('git', ['init', '--quiet', workspace], { stdio: 'ignore' })
    git.once('error', reject)
    git.once('exit', code => code === 0 ? resolve() : reject(new Error('Fixture repository initialization failed')))
  })
  const original = await readFile(source)
  await app.whenReady()
  const snapshot = join(directory, 'snapshot.json')
  await writeFile(snapshot, original)
  const settings = await new RuntimeSettingsStore(snapshot, { isAvailable: () => safeStorage.isEncryptionAvailable(), encrypt: () => { throw new Error('read only') }, decrypt: value => safeStorage.decryptString(value) }, {}).getResolvedSettings()
  await unlink(snapshot)
  profile = settings.modelProfiles.find(p => p.id === settings.defaultModelProfileId)
  if (!profile || /claude|fable|opus|sonnet|haiku/i.test(profile.modelName)) throw new Error('default model excluded')
  if (!['openai-responses', 'openai-chat-completions'].includes(profile.protocol)) throw new Error('This harness supports OpenAI Responses and Chat protocols only')
  report.model = profile.modelName; report.protocol = profile.protocol
  report.credentialPreflight = { authentication: profile.authentication, profileKeyAvailable: Boolean(profile.apiKey), defaultKeyAvailable: Boolean(settings.apiKey), customHeaderCount: Object.keys(profile.requestHeaders ?? {}).length, customBodyCount: Object.keys(profile.requestBody ?? {}).length }
  output({ credentialPreflight: report.credentialPreflight })
  const server = createServer(async (req, res) => {
    const record = { stage, mode: proxyMode, paidAttempt: false, status: null }
    report.attempts.push(record)
    if (proxyMode !== 'live' || report.attempts.filter(a => a.paidAttempt).length >= Number(process.env.GB_DROID_MAX_CALLS ?? 16)) {
      record.status = 400
      res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { message: 'Synthetic mock upstream failure', type: 'invalid_request_error' } }))
      return
    }
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 45000)
    res.on('close', () => controller.abort())
    try {
      let raw = ''; for await (const chunk of req) raw += chunk
      assert(!raw.includes('# GoodBuddy Agent Guide'), 'Parent repository instructions reached model request')
      const body = { ...JSON.parse(raw), ...profile.requestBody, model: profile.modelName }
      const headers = { 'Content-Type': 'application/json', ...profile.requestHeaders }
      if (profile.authentication !== 'none' && profile.apiKey) headers.Authorization = `Bearer ${profile.apiKey}`
      const url = profile.protocol === 'openai-responses' ? createOpenAIResponsesUrl(profile.baseUrl) : createOpenAIChatCompletionsUrl(profile.baseUrl)
      // Reserve the attempt after body reads, without yielding before forwarding.
      if (report.attempts.filter(a => a.paidAttempt).length >= Number(process.env.GB_DROID_MAX_CALLS ?? 16)) {
        record.status = 400
        res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { message: 'Validation request budget exhausted', type: 'invalid_request_error' } }))
        return
      }
      record.paidAttempt = true
      if (cancelOnRequest) { cancelOnRequest = false; setTimeout(() => void send('session/cancel', { sessionId }, true), 300) }
      const response = await net.fetch(url.toString(), { method: 'POST', headers, body: JSON.stringify(body), signal: controller.signal, redirect: 'error' })
      record.status = response.status
      res.writeHead(response.status, { 'content-type': response.headers.get('content-type') ?? 'application/json' })
      if (response.body) for await (const chunk of response.body) res.write(chunk)
      res.end()
    } catch (error) {
      record.error = controller.signal.aborted ? 'aborted' : sanitize(String(error?.message ?? '')).slice(0, 160)
      if (!res.headersSent) res.writeHead(502)
      res.end()
    } finally { clearTimeout(timer) }
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  await writeFile(join(directory, 'droid.json'), JSON.stringify({ customModels: [{ model: profile.modelName, displayName: 'validation', baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'dummy-validation-key', provider: profile.protocol === 'openai-responses' ? 'openai' : 'generic-chat-completion-api', maxOutputTokens: 800, reasoningEffort: 'low' }] }))
  await writeFile(join(workspace, 'input.txt'), 'fixture-value: ORBIT-73\n')
  try {
    if (process.env.GB_DROID_NATIVE === 'true') {
      proxyMode = live ? 'live' : 'blocked'
      const suite = process.env.GB_DROID_SUITE ?? 'native'
      const validate = { native: validateNative, capabilities: validateCapabilities, tasks: validateTasks, session: validateSession }[suite]
      assert(validate, 'Unknown Droid validation suite')
      report.native = await run(suite, () => validate({ binary, directory, workspace, home, output, sanitize, live }))
      return
    }
    report.initialize = await run('initialize', start)
    const created = await run('session/new', () => send('session/new', { cwd: workspace, mcpServers: [] }))
    if (!created) return
    sessionId = created.sessionId
    const models = created.models?.availableModels ?? []
    report.customModelIds = models.filter(m => m.modelId.startsWith('custom:')).map(m => m.modelId)
    const modelId = report.customModelIds.find(id => id.includes('validation')) ?? report.customModelIds[0]
    await run('invalid-model', async () => {
      try { await send('session/set_model', { sessionId, modelId: 'custom:nonexistent-validation-model' }) } catch (e) { return { rejected: true, error: safeError(e) } }
      throw new Error('invalid model accepted')
    })
    if (!modelId) throw new Error('isolated custom model missing')
    await run('select-model', () => send('session/set_model', { sessionId, modelId }))
    await run('reasoning-low', () => send('session/set_config_option', { sessionId, configId: 'reasoning_effort', value: 'low' }))
    proxyMode = 'mock-failure'
    await run('mock-upstream-failure', async () => {
      try { await prompt('Reply MOCK. Do not use tools.') } catch (error) {
        if (error.code === -32603 && error.message.includes('Synthetic mock upstream failure')) return { rejected: true, error: safeError(error) }
        throw error
      }
      throw new Error('Mock failure was not surfaced')
    })
    if (live && !profile.apiKey && profile.authentication !== 'none') throw new Error('Credential preflight failed')
    if (live && (profile.apiKey || profile.authentication === 'none')) {
      proxyMode = 'live'
      if (textOnly) {
        await run('text-stream', () => prompt('No tools. Write exactly twelve short numbered sentences about an imaginary blue cube. This is synthetic text streaming validation.'))
      } else if (questionOnly) {
        await run('ask-user-question', () => prompt('Call AskUserQuestion with one question: Which synthetic fixture color? Options red and blue. This is a tool-protocol test; do not substitute a plain text question.'))
      } else {
      await run('text-stream', () => prompt('Remember the synthetic token ORBIT-73. Reply exactly READY-73. Do not use tools.', 'READY-73'))
      await run('multiturn', () => prompt('What synthetic token did I ask you to remember? Reply only that token. Do not use tools.', 'ORBIT-73'))
      await run('fixture-read-write', async () => {
        const result = await prompt('Use Read to read input.txt, then use Create or ApplyPatch to create output.txt containing the same fixture-value line. Do not use shell. Confirm briefly.')
        assert.equal((await readFile(join(workspace, 'output.txt'), 'utf8')).trim(), 'fixture-value: ORBIT-73')
        assert(report.callbacks.some(c => c.stage === stage && c.method === 'session/request_permission'), 'Permission callback missing')
        return { ...result, fileCorrect: true }
      })
      await run('ask-user-question', () => prompt('Use AskUserQuestion now to ask whether the synthetic fixture color should be red or blue. Do not choose for me.'))
      cancelOnRequest = true
      await run('cancel', async () => {
        const result = await prompt('Write a long numbered list of 100 synthetic color names. No tools.')
        assert.equal(result.stopReason, 'cancelled')
        return result
      })
      cancelOnRequest = false
      await run('cancel-recovery', () => prompt('Reply exactly RECOVERED-73. No tools.', 'RECOVERED-73'))
      }
    }
    await stop()
    await run('restart-initialize', start)
    await run('session/load', () => send('session/load', { sessionId, cwd: workspace, mcpServers: [] }))
    if (live && !questionOnly && !textOnly) {
      await run('reselect-after-load', () => send('session/set_model', { sessionId, modelId }))
      await run('restart-context', () => prompt('What synthetic ORBIT token appeared earlier? Reply only the token. No tools.', 'ORBIT-73'))
    }
  } finally {
    await stop()
    server.closeAllConnections(); await new Promise(resolve => server.close(() => resolve()))
    report.originalSettingsUnchanged = (await readFile(source)).equals(original)
    report.paidAttempts = report.attempts.filter(a => a.paidAttempt).length
    report.methods = [...new Set(report.methods)]
    report.questionObservation = process.env.GB_DROID_NATIVE === 'true' ? report.native?.question : {
      toolInvoked: report.tools.some(t => t.stage === 'ask-user-question' && t.title === 'Ask User'),
      failedTool: report.tools.some(t => t.stage === 'ask-user-question' && t.status === 'failed'),
      clientCallbacks: report.callbacks.filter(c => c.stage === 'ask-user-question').map(c => c.method),
      answerRoundTripVerified: false
    }
    output(report)
  }
}
main().then(() => app.exit(report.stages.some(s => !s.ok) || !report.originalSettingsUnchanged ? 1 : 0)).catch(() => { output({ fatal: 'Harness preflight or execution failed; raw details suppressed' }); void stop().finally(() => app.exit(1)) })

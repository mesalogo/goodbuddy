/* eslint-disable @typescript-eslint/no-explicit-any -- This manual probe records heterogeneous upstream wire catalogs and events verbatim. */
import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve, dirname } from 'node:path'
import { createServer } from 'node:http'
import electron from 'electron'
import { ContinueAgentRuntime } from '../src/main/agent/continue-runtime'
import { createContinueUtilityProcessChild } from '../src/main/agent/continue-utility-process-adapter'
import { DeepSeekHarnessRuntime } from '../src/main/agent/deepseek-harness-runtime'
import { startControlledDeepSeekHarnessHost, createBoundedNdJsonStream } from '../src/main/deepseek-harness-host'
import { NativeDshWebClientService } from '../src/main/agent/native-dsh-web-client'
import { AgentModelCallLedger } from '../src/agent-daemon/agent-model-gateway'

const root = process.env.GB_TASK_PROBE_ROOT!
const { app, utilityProcess } = electron as unknown as typeof import('electron')
const node = process.env.GB_TASK_PROBE_NODE!
const report: any = { externalModelCalls: 0, cases: [], catalogs: {}, modelCalls: {}, commands: [], hosts: [] }
const sleep = (ms: number) => new Promise(resolveWait => setTimeout(resolveWait, ms))
const alive = (pid: number) => { try { process.kill(pid, 0); return true } catch { return false } }
async function until(check: () => Promise<boolean> | boolean, timeout = 20000) {
  const start = Date.now()
  while (!(await check())) { assert(Date.now() - start < timeout, 'condition timed out'); await sleep(50) }
}
async function* chunks(name: string | undefined, args: any, id: string) {
  if (name) {
    yield { type: 'block-start', index: 0, blockType: 'tool-call' }
    yield { type: 'tool-call-delta', index: 0, id, name, argumentsDelta: JSON.stringify(args) }
    yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name, arguments: JSON.stringify(args) } }
  } else {
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: 'PROBE_DONE' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'PROBE_DONE' } }
  }
  yield { type: 'finish', reason: { kind: name ? 'tool-calls' : 'stop' } }
}
function sse(name?: string, args?: any, id = 'probe') {
  const delta = name ? { role: 'assistant', tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] }
    : { role: 'assistant', content: 'PROBE_DONE' }
  return [{ choices: [{ index: 0, delta, finish_reason: null }] },
    { choices: [{ index: 0, delta: {}, finish_reason: name ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } }]
    .map(value => `data: ${JSON.stringify({ id, object: 'chat.completion.chunk', model: 'probe', ...value })}\n\n`).join('') + 'data: [DONE]\n\n'
}
const fixtures = new Map<string, { command: string; pid: string; finished: string }>()
const results = new Map<string, string>()
function model(provider: string, body: any) {
  report.modelCalls[provider] = (report.modelCalls[provider] ?? 0) + 1
  const catalog = body.tools.map((tool: any) => tool.function ?? tool)
  report.catalogs[provider] = catalog.map((tool: any) => ({ name: tool.name, parameters: tool.parameters ?? tool.inputSchema }))
  const text = JSON.stringify(body.messages.filter((message: any) => message.role === 'user'))
  const key = [...fixtures.keys()].find(value => text.includes(value))
  if (provider === 'continue' && text.includes('continue_inventory')) {
    const result = body.messages.find((message: any) => message.role === 'tool')
    if (result) { results.set('continue_inventory', result.content); return { name: undefined, args: {}, id: 'inventory' } }
    return { name: 'CheckBackgroundJob', args: { job_id: 'probe-nonexistent' }, id: 'inventory' }
  }
  if (!key) return { name: undefined, args: {}, id: 'inventory' }
  const id = `call_${key}`
  const result = body.messages.find((message: any) => message.role === 'tool' && (message.tool_call_id ?? message.toolCallId) === id)
  if (result) { results.set(key, typeof result.content === 'string' ? result.content : JSON.stringify(result.content)); return { name: undefined, args: {}, id } }
  const shell = catalog.find((tool: any) => /^(bash|pwsh|run_terminal_command|Bash)$/i.test(tool.name))
  assert(shell, `No shell in ${provider}: ${catalog.map((tool: any) => tool.name)}`)
  const args = { command: fixtures.get(key)!.command, description: 'Bounded local lifecycle fixture' }
  report.commands.push({ provider, key, tool: shell.name, ...args })
  return { name: shell.name, args, id }
}
async function fixture(key: string, duration: number, code = 0) {
  const script = join(root, `${key}.cjs`), pid = join(root, `${key}.pid`), finished = join(root, `${key}.finished`)
  await writeFile(script, `const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(pid)},String(process.pid));console.log('STDOUT_${key}');console.error('STDERR_${key}');setTimeout(()=>{fs.writeFileSync(${JSON.stringify(finished)},'done');console.log('END_${key}');process.exit(${code})},${duration});`)
  fixtures.set(key, { command: `"${node}" "${script}"`, pid, finished })
}
async function collect(runtime: any, key: string, signal: AbortSignal) {
  const events: any[] = []
  let error: string | undefined
  try { for await (const event of runtime.run({ requestId: key, conversationId: key, prompt: key }, signal)) events.push(event) }
  catch (caught) { error = String(caught) }
  return { events, error }
}
async function exercise(provider: string, runtime: any) {
  for (const [suffix, duration, code] of [['await', 1500, 0], ['exit', 50, 7], ['parent', 15000, 0], ['sibling', 3000, 0]] as const) {
    await fixture(`${provider}_${suffix}`, duration, code)
    if (process.platform === 'win32') fixtures.get(`${provider}_${suffix}`)!.command = '& ' + fixtures.get(`${provider}_${suffix}`)!.command + '; exit $LASTEXITCODE'
  }
  for (const suffix of ['await', 'exit']) {
    const key = `${provider}_${suffix}`, start = Date.now()
    const run = await collect(runtime, key, AbortSignal.timeout(30000))
    const output = results.get(key) ?? ''
    const pass = !run.error && run.events.at(-1)?.type === 'done' && output.includes(`STDERR_${key}`) &&
      (suffix === 'exit' ? /exit code[: ]+7/.test(output) : output.includes(`END_${key}`) && Date.now() - start >= 1500)
    report.cases.push({ provider, case: suffix, pass, ms: Date.now() - start, output, ...run })
    console.log('CASE', provider, suffix, pass, output)
  }
  const parentKey = `${provider}_parent`, siblingKey = `${provider}_sibling`
  const controller = new AbortController()
  const parent = collect(runtime, parentKey, controller.signal)
  const sibling = collect(runtime, siblingKey, AbortSignal.timeout(30000))
  let parentPid = 0, siblingPid = 0
  await until(async () => {
    try { parentPid = Number(await readFile(fixtures.get(parentKey)!.pid, 'utf8')); siblingPid = Number(await readFile(fixtures.get(siblingKey)!.pid, 'utf8')); return true } catch { return false }
  })
  const start = Date.now()
  controller.abort(new Error('PROBE_PARENT_STOP'))
  const stopped = await parent
  const callerCancelMs = Date.now() - start
  const siblingAliveAfterStop = alive(siblingPid)
  await sleep(500)
  const parentAliveAfterStop = alive(parentPid)
  const aliveSampleAfterAbortMs = Date.now() - start
  const aliveSampleAfterCallerSettlementMs = aliveSampleAfterAbortMs - callerCancelMs
  await until(() => !alive(parentPid), 20000)
  const parentSettledMs = Date.now() - start
  const finishedMarker = await readFile(fixtures.get(parentKey)!.finished, 'utf8').catch(() => undefined)
  const finishedNaturally = finishedMarker === 'done'
  const other = await sibling
  const pass = !!stopped.error && siblingAliveAfterStop && !other.error && other.events.at(-1)?.type === 'done' && !!results.get(siblingKey)?.includes(`END_${siblingKey}`)
  report.cases.push({ provider, case: 'parent-stop-sibling', pass, callerCancelMs, parentPid, siblingPid, siblingAliveAfterStop, stopped, sibling: other })
  report.cases.push({ provider, case: 'stop-descendant-process', pass: !parentAliveAfterStop && !finishedNaturally,
    measuredProcess: 'Node fixture descendant (not necessarily its shell)', timingOrigin: 'immediately before controller.abort()',
    parentAliveAfterStop, aliveSampleAfterAbortMs, aliveSampleAfterCallerSettlementMs, parentSettledMs,
    finishedNaturally, finishedMarkerPath: fixtures.get(parentKey)!.finished, finishedMarker })
  console.log('CASE', provider, 'parent-stop-sibling', pass)
  const recovery = await collect(runtime, `${provider}_inventory`, AbortSignal.timeout(30000))
  report.cases.push({ provider, case: 'after-stop-request', pass: !recovery.error && recovery.events.at(-1)?.type === 'done', output: results.get(`${provider}_inventory`), ...recovery })
  const names = report.catalogs[provider].map((tool: any) => tool.name)
  const shell = report.catalogs[provider].find((tool: any) => tool.name === (provider === 'dsh' ? 'pwsh' : 'Bash'))
  report.cases.push({ provider, case: 'mounted-catalog', pass: !names.some((name: string) => /^(subagent|subagent_fork|delegate|job_list|job_kill|job_output)$/i.test(name)) && !shell.parameters.properties.run_in_background,
    names, shellParameters: Object.keys(shell.parameters.properties), backgroundCheckOnly: names.includes('CheckBackgroundJob') })
}
async function main() {
  await app?.whenReady()
  await mkdir(join(root, 'home'), { recursive: true })
  for (const packageName of ['@continuedev/cli', '@deepseek-ai/dsh', '@deepseek-ai/dsh-agent']) {
    console.log('VERSION', packageName, JSON.parse(await readFile(resolve('node_modules', packageName, 'package.json'), 'utf8')).version)
  }
  const server = createServer(async (request, response) => {
    try {
      let text = ''; for await (const chunk of request) text += chunk
      const answer = model('continue', JSON.parse(text))
      response.writeHead(200, { 'content-type': 'text/event-stream' }).end(sse(answer.name, answer.args, answer.id))
    } catch (error) { response.writeHead(500).end(String(error)) }
  })
  await new Promise<void>(resolveListen => server.listen(0, '127.0.0.1', resolveListen))
  const profile = { id: 'probe', name: 'probe', protocol: 'openai-chat-completions' as const, authentication: 'none' as const,
    baseUrl: `http://127.0.0.1:${(server.address() as any).port}/v1`, modelName: 'probe' }
  const continueRuntime = new ContinueAgentRuntime({ binaryPath: resolve('node_modules/@continuedev/cli/dist/cn.js'), configPath: '',
    defaultWorkspace: root, hostCacheRoot: join(root, 'continue-cache'), modelProfile: profile,
    launchHost(entry, args, options) {
      const utility = utilityProcess.fork(join(dirname(entry), 'utility-bootstrap.mjs'), [entry, ...args], { ...options, stdio: 'pipe' })
      utility.on('spawn', () => report.hosts.push({ provider: 'continue', pid: utility.pid }))
      return createContinueUtilityProcessChild({ get pid() { return utility.pid }, stdout: utility.stdout, stderr: utility.stderr,
        kill: () => utility.kill(), onExit: listener => { utility.on('exit', listener) }, onceExit: listener => { utility.once('exit', listener) },
        onceError: listener => { utility.once('error', listener) }, removeExitListener: listener => { utility.removeListener('exit', listener) }, removeErrorListener: listener => { utility.removeListener('error', listener) } })
    } })
  const dsh = new DeepSeekHarnessRuntime({ defaultWorkspace: root, baseUrl: 'http://127.0.0.1:1/v1', model: 'probe',
    credentialRefs: { GOODBUDDY_HARNESS_MODEL_API_KEY: 'local-unused' }, initializationTimeoutMs: 20000, promptTimeoutMs: 30000, shutdownTimeoutMs: 5000,
    async launch(options) {
      const input = new TransformStream<Uint8Array, Uint8Array>(), output = new TransformStream<Uint8Array, Uint8Array>()
      let exit!: (value: any) => void
      const exited = new Promise<any>(resolveExit => { exit = resolveExit })
      const host = await startControlledDeepSeekHarnessHost({ workspace: options.cwd, dshHome: join(root, 'home'), baseUrl: options.baseUrl,
        api: 'openai-completions', provider: 'goodbuddy', model: options.model, harnessVersion: '0.2.1-rc.2', supportsImageInput: false,
        credentialRefs: options.credentialRefs, skillPackages: options.skillPackages, extensionPackages: options.extensionPackages,
        stream: createBoundedNdJsonStream(output.writable, input.readable, 8 * 1024 * 1024) })
      report.controlledDshHosts = (report.controlledDshHosts ?? 0) + 1
      host.context.on('llm/stream', (body: any) => { const answer = model('dsh', body); return chunks(answer.name, answer.args, answer.id) as any }, { global: true, prepend: true })
      return { stdin: input.writable, stdout: output.readable, exited, async terminate() { await host.dispose(); exit({ exitCode: 0 }) } }
    } })
  try {
    for (const [name, runtime] of [['continue', continueRuntime], ['dsh', dsh]] as const) {
      if (name !== process.env.GB_TASK_PROBE_PROVIDER) continue
      try { await exercise(name, runtime) } catch (error) { report.cases.push({ provider: name, case: 'probe', pass: false, error: String(error) }); console.error(error) }
      finally { await runtime.dispose() }
    }
  } finally { server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())) }
  if (process.env.GB_TASK_PROBE_PROVIDER === 'dsh') {
  const web = new NativeDshWebClientService({ rootDirectory: join(root, 'web-home'), temporaryRoot: join(root, 'web-temp'),
    cliPath: resolve('node_modules/@deepseek-ai/dsh/lib/bin.js'), openModelCallLedger: async path => new AgentModelCallLedger(path),
    resolveLaunchEnvironment: async () => ({ nodeExecutablePath: node, environment: process.env }),
    fetcher: async (_url, init) => {
      const body = JSON.parse(String(init?.body)); report.catalogs.nativeWeb = body.tools.map((tool: any) => ({ name: tool.function.name }))
      report.modelCalls.nativeWeb = (report.modelCalls.nativeWeb ?? 0) + 1
      return new Response(sse(), { headers: { 'content-type': 'text/event-stream' } })
    } })
  try {
    const handle = await web.start({ projectId: 'inventory', workspace: root, profile })
    const auth = await fetch(handle.url, { redirect: 'manual' }), cookie = auth.headers.getSetCookie().map(value => value.split(';')[0]).join('; ')
    async function rpc(method: string, request: any) {
      const response = await fetch(new URL(`/api/${method}`, handle.url), { method: 'POST', headers: { 'content-type': 'application/json', cookie, origin: new URL(handle.url).origin },
        body: JSON.stringify({ type: 'client-request', rpcId: crypto.randomUUID(), method, payload: { args: { request } } }) })
      const body = await response.json() as any; assert(body.result?.ok, JSON.stringify(body)); return body.result.value
    }
    const session = await rpc('session/create', { cwd: root })
    await rpc('session/prompt', { sessionId: session.sessionId, requestId: crypto.randomUUID(), mode: 'queue', content: [{ type: 'text', text: 'Inventory only' }] })
    await until(() => !!report.catalogs.nativeWeb)
    report.cases.push({ provider: 'nativeWeb', case: 'inventory-only-not-production-chat', pass: true })
  } catch (error) { report.cases.push({ provider: 'nativeWeb', case: 'inventory', pass: false, error: String(error) }) }
  finally { await web.dispose() }
  }
  await until(() => report.hosts.every((host: any) => !alive(host.pid)))
  report.cleanup = { continueHostsExited: report.hosts.every((host: any) => !alive(host.pid)), fixtures: [] }
  for (const [key, value] of fixtures) {
    try { const pid = Number(await readFile(value.pid, 'utf8')); report.cleanup.fixtures.push({ key, pid, alive: alive(pid) }) } catch { /* Unstarted fixture. */ }
  }
  for (const entry of report.cases) {
    for (const run of [entry, entry.stopped, entry.sibling]) {
      if (run?.events) run.events = run.events.map((event: any) => ({ requestId: event.requestId, type: event.type, callId: event.callId, name: event.name, state: event.state, output: event.output, error: event.error, sessionId: event.sessionId }))
    }
  }
  report.catalogs = Object.fromEntries(Object.entries(report.catalogs).map(([provider, tools]: any) => [provider, tools.map((tool: any) => tool.name)]))
  console.log('REPORT', JSON.stringify(report, null, 2))
  assert(report.cases.every((entry: any) => entry.pass), 'One or more probe cases failed')
  assert(report.cleanup.fixtures.every((entry: any) => !entry.alive), 'Fixture process survived cleanup')
}
const exit = (code: number) => app ? app.exit(code) : process.exit(code)
void main().then(() => exit(0), error => { console.error(error); exit(1) })

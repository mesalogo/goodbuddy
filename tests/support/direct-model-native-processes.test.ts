// @vitest-environment node
import { randomUUID } from 'node:crypto'
import { appendFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { LocalDirectModelProcessService, processExecuteInputSchema } from '../../src/main/agent/direct-model-process-service'
import type { PagedOutputBackingStore } from '../../src/main/agent/paged-output-store'
import { ModelAgentRuntime } from '../../src/main/agent/model-runtime'
import { SubagentScheduler } from '../../src/main/assistant/subagent-scheduler'
import { LocalWorkspaceAccess } from '../../src/main/workspace'

const root = resolve('temp/direct-model-native-processes')
let directory: string
const cleanups: Array<() => Promise<void>> = []
const pids = new Set<number>()

beforeEach(async () => {
  directory = join(root, randomUUID())
  await mkdir(directory, { recursive: true })
})

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch { return false }
}

afterEach(async () => {
  const results = await Promise.allSettled(cleanups.splice(0).reverse().map(async cleanup => cleanup()))
  results.push(...await Promise.allSettled(
    ['background', 'first', 'second', 'server', 'timeout', 'delegated'].map(async name => {
      try {
        const value = JSON.parse(await readFile(join(directory, `${name}.json`), 'utf8'))
        if (Number.isSafeInteger(value.pid) && value.pid > 0) pids.add(value.pid)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    })
  ))
  const survivors = [...pids].filter(alive)
  results.push(...await Promise.allSettled(survivors.map(async pid => {
    if (alive(pid)) process.kill(pid, 'SIGKILL')
    await vi.waitFor(() => expect(alive(pid)).toBe(false), { timeout: 5000 })
  })))
  pids.clear()
  results.push(...await Promise.allSettled([rm(root, { recursive: true, force: true })]))
  const failures = results.filter(result => result.status === 'rejected').map(result => result.reason)
  if (failures.length) throw new AggregateError(failures, 'Fixture cleanup failed')
  expect(survivors, 'production cleanup must leave no fixture children').toEqual([])
})

// Test-only asynchronous backing; production capture/paging logic is unchanged.
function backing(): PagedOutputBackingStore {
  const entries = new Map<string, { owner: string; path: string }>()
  const entry = (owner: string, handle: string) => {
    const value = entries.get(handle)
    if (!value || value.owner !== owner) throw new Error('Unknown fixture output owner')
    return value.path
  }
  return {
    async create(owner, handle) {
      const path = join(directory, randomUUID())
      await writeFile(path, '')
      entries.set(handle, { owner, path })
    },
    async append(owner, handle, bytes) { await appendFile(entry(owner, handle), bytes) },
    async finish(owner, handle, total) { expect((await readFile(entry(owner, handle))).length).toBe(total) },
    async read(owner, handle, cursor, length) { return (await readFile(entry(owner, handle))).subarray(cursor, cursor + length) },
    async release(owner, handle) {
      await rm(entry(owner, handle), { force: true })
      entries.delete(handle)
    }
  }
}

async function fixture(name: string, code: string): Promise<string> {
  const path = join(directory, `${name}.cjs`)
  await writeFile(path, code)
  const quote = (value: string) => `'${value.replaceAll("'", "'" + (process.platform === 'win32' ? "'" : '\\' + "''"))}'`
  return `${process.platform === 'win32' ? '& ' : ''}${quote(process.execPath)} ${quote(path)}`
}

async function marker(name: string): Promise<{ pid: number; port?: number }> {
  let value!: { pid: number; port?: number }
  await vi.waitFor(async () => {
    value = JSON.parse(await readFile(join(directory, name), 'utf8'))
    expect(alive(value.pid)).toBe(true)
  }, { timeout: 8000 })
  pids.add(value.pid)
  return value
}

function service() {
  const value = new LocalDirectModelProcessService({
    environment: { ...process.env, TEMP: directory, TMP: directory, TMPDIR: directory },
    outputStore: { backingStore: backing() }
  })
  cleanups.push(() => value.dispose())
  return value
}

function context(conversationId: string, signal = new AbortController().signal) {
  return { conversationId, signal, workspace: new LocalWorkspaceAccess(directory) }
}

function report(name: string, result: unknown) {
  console.log(`DIRECT_MODEL_NATIVE ${name} ${JSON.stringify(result)}`)
}

it('measures detached noninteractive child lifetime without claiming a managed background handle', async () => {
  const processes = service()
  const childCode = "require('fs').writeFileSync('background.json',JSON.stringify({pid:process.pid})); require('fs').writeFileSync('background-output.txt','background-ready'); setTimeout(()=>require('fs').appendFileSync('background-output.txt',' background-done'),1500)"
  const command = await fixture('background-parent', `const child=require('child_process').spawn(process.execPath,['-e',${JSON.stringify(childCode)}],{detached:true,stdio:'ignore'}); child.unref(); console.log('launcher-done');`)
  const pending = processes.execute({ command }, context('background'))
  const child = await marker('background.json')
  const result = await pending
  expect(result.exitCode).toBe(0)
  expect(result.stdout).toContain('launcher-done')
  const aliveAtReturn = alive(child.pid)
  if (process.platform === 'win32') expect(aliveAtReturn).toBe(false)
  await processes.releaseConversation('background')
  const aliveAfterRelease = alive(child.pid)
  await vi.waitFor(() => expect(alive(child.pid)).toBe(false), { timeout: 5000 })
  const output = await readFile(join(directory, 'background-output.txt'), 'utf8')
  expect(output).toBe('background-ready background-done')
  report('detached-background-lifetime', { child, result, aliveAtReturn, aliveAfterRelease, output, finalAlive: alive(child.pid) })
}, 15000)

it('runs concurrent noninteractive children; targeted abort preserves the same-conversation sibling', async () => {
  const processes = service()
  const firstCommand = await fixture('first', "require('fs').writeFileSync('first.json',JSON.stringify({pid:process.pid})); console.log('first-ready'); setInterval(()=>{},1000)")
  const secondCommand = await fixture('second', "require('fs').writeFileSync('second.json',JSON.stringify({pid:process.pid})); console.log('second-ready'); setTimeout(()=>{console.log('second-done');},1500)")
  const abort = new AbortController()
  const first = processes.execute({ command: firstCommand }, context('siblings', abort.signal))
  const second = processes.execute({ command: secondCommand }, context('siblings'))
  const a = await marker('first.json')
  const b = await marker('second.json')
  abort.abort()
  const stopped = await first
  expect(stopped.terminationReason).toBe('cancelled')
  expect(alive(a.pid)).toBe(false)
  expect(alive(b.pid)).toBe(true)
  const completed = await second
  expect(completed.exitCode).toBe(0)
  expect(completed.stdout).toContain('second-done')
  expect(alive(b.pid)).toBe(false)
  report('targeted-abort', { pids: [a.pid, b.pid], stopped, completed })
}, 15000)

it('releases an active localhost service, frees its port, and allows a next-turn call', async () => {
  const processes = service()
  const command = await fixture('server', "const s=require('net').createServer(c=>c.end('ready')); s.listen(0,'127.0.0.1',()=>{require('fs').writeFileSync('server.json',JSON.stringify({pid:process.pid,port:s.address().port})); console.log('listening');})")
  let settled = false
  const pending = processes.execute({ command }, context('server-owner')).finally(() => { settled = true })
  const child = await marker('server.json')
  expect(settled).toBe(false)
  await processes.releaseConversation('server-owner')
  const result = await pending
  expect(result.terminationReason).toBe('cancelled')
  expect(alive(child.pid)).toBe(false)
  const rebound = createServer()
  await new Promise<void>((resolveListen, reject) => {
    rebound.once('error', reject)
    rebound.listen(child.port, '127.0.0.1', resolveListen)
  })
  await new Promise<void>((resolveClose, reject) => rebound.close(error => error ? reject(error) : resolveClose()))
  const next = await processes.execute({ command: await fixture('next', "console.log('next-turn')") }, context('server-owner'))
  expect(next.stdout).toContain('next-turn')
  expect(next.exitCode).toBe(0)
  report('release-port-next-turn', { child, result, next })
}, 15000)

it('times out a real child and reports absent background/input/stop contracts', async () => {
  const processes = service()
  const command = await fixture('timeout', "require('fs').writeFileSync('timeout.json',JSON.stringify({pid:process.pid})); console.log('timeout-ready'); setInterval(()=>{},1000)")
  const pending = processes.execute({ command, timeoutMs: 2000 }, context('timeout'))
  const child = await marker('timeout.json')
  const result = await pending
  expect(result.terminationReason).toBe('timeout')
  expect(alive(child.pid)).toBe(false)
  const errors = ['background', 'stdin', 'pty'].map(field => {
    const parsed = processExecuteInputSchema.safeParse({ command: 'unused', [field]: true })
    expect(parsed.success).toBe(false)
    return { field, error: parsed.success ? null : parsed.error.issues }
  })
  for (const method of ['writeInput', 'sendInput', 'stopProcess', 'listProcesses']) expect(method in processes).toBe(false)
  report('timeout-contracts', { child, result, errors })
}, 15000)

it('runs a real subagent process and pages delegated assistant output on the next turn', async () => {
  const scheduler = new SubagentScheduler({ concurrency: 2, queueLimit: 4, timeoutMs: 15000 })
  const command = await fixture('delegated', "require('fs').writeFileSync('delegated.json',JSON.stringify({pid:process.pid})); console.log('native-pid:'+process.pid); process.stdout.write('x'.repeat(120000)+'native-end');")
  const tool = (name: string, args: unknown) => ({ role: 'assistant', content: null, tool_calls: [{ id: randomUUID(), type: 'function', function: { name, arguments: JSON.stringify(args) } }] })
  const messages: Record<string, unknown>[] = [
    tool('subagent_delegate', { task: 'Run the deterministic process fixture.' }),
    tool('process_execute', { command }),
    { role: 'assistant', content: 's'.repeat(240000) + 'delegated-end' },
    { role: 'assistant', content: 'parent-done' }
  ]
  const requests: Array<{ tools: Array<{ function: { name: string } }>; messages: Array<{ role: string; content: string }> }> = []
  const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
    requests.push(JSON.parse(String(init?.body)))
    const message = messages.shift()
    if (!message) throw new Error('Unexpected model fixture request')
    return Response.json({ choices: [{ message }] })
  })
  const runtime = new ModelAgentRuntime({
    baseUrl: 'http://fixture.invalid/v1', model: 'deterministic-fixture',
    protocol: 'openai-chat-completions', authentication: 'none', fetcher,
    defaultWorkspace: directory, directModelSubagentScheduler: scheduler,
    outputStore: { backingStore: backing() }
  })
  cleanups.push(async () => {
    try { await runtime.dispose() } finally { scheduler.dispose(); await scheduler.waitForIdle() }
  })
  const events = []
  for await (const event of runtime.run({ requestId: randomUUID(), conversationId: 'parent', prompt: 'Delegate fixture' }, new AbortController().signal)) events.push(event)
  expect(fetcher).toHaveBeenCalledTimes(4)
  expect(requests[1]!.tools.map(t => t.function.name)).not.toContain('subagent_delegate')
  const processResult = JSON.parse(requests[2]!.messages.filter(m => m.role === 'tool').at(-1)!.content)
  expect(processResult.exitCode).toBe(0)
  expect(processResult.stdoutTruncated).toBe(true)
  const pid = Number(/native-pid:(\d+)/.exec(processResult.stdout)![1])
  expect(alive(pid)).toBe(false)
  const delegated = JSON.parse(requests[3]!.messages.filter(m => m.role === 'tool').at(-1)!.content)
  expect(delegated.status).toBe('completed')
  expect(delegated.outputReference).toBeDefined()
  expect(events.filter(e => e.type === 'subagent').map(e => e.state)).toEqual(['queued', 'running', 'completed'])
  messages.push(tool('output_read', { handle: delegated.outputReference.handle, cursor: 239990, limitBytes: 100 }), { role: 'assistant', content: 'paged' })
  for await (const event of runtime.run({ requestId: randomUUID(), conversationId: 'parent', prompt: 'Read prior child output' }, new AbortController().signal)) events.push(event)
  const page = JSON.parse(requests[5]!.messages.filter(m => m.role === 'tool').at(-1)!.content)
  expect(page.content).toBe('s'.repeat(10) + 'delegated-end')
  expect(page.eof).toBe(true)
  await runtime.releaseConversation('parent')
  messages.push(tool('output_read', { handle: delegated.outputReference.handle }), { role: 'assistant', content: 'released' })
  for await (const event of runtime.run({ requestId: randomUUID(), conversationId: 'parent', prompt: 'Read released output' }, new AbortController().signal)) events.push(event)
  const released = JSON.parse(requests[7]!.messages.filter(m => m.role === 'tool').at(-1)!.content)
  expect(released.ok).toBe(false)
  report('runtime-delegation-pages', { modelFixtureRequests: fetcher.mock.calls.length, pid, processExitCode: processResult.exitCode, processDurationMs: processResult.durationMs, delegatedStatus: delegated.status, page, released })
}, 25000)

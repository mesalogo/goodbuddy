// @vitest-environment node
import { EventEmitter } from 'node:events'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { chmod, mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { build } from 'esbuild'
import { expect, it } from 'vitest'
import { ReadonlyQueryReader, deserializeWorkerError, type ReadonlyQueryRequest } from './readonly-query-reader'
import { storageDataBytes } from './desktop-storage-contracts'
import { AssistantDatabase } from './assistant/assistant-database'
import { DatabaseSync } from 'node:sqlite'

class Transport extends EventEmitter {
  messages: Array<ReadonlyQueryRequest | { type: 'cancel'; id: number }> = []
  stopped = false
  postMessage(message: ReadonlyQueryRequest | { type: 'cancel'; id: number }): void { this.messages.push(message) }
  ref(): void {}
  unref(): void {}
  async terminate(): Promise<number> { this.stopped = true; return 0 }
}

const settleAll = (transport: Transport, settled: Set<number>): void => {
  for (const message of transport.messages) {
    if (message.type === 'query' && !settled.has(message.id)) { settled.add(message.id); transport.emit('message', { id: message.id, result: message.id }) }
  }
}

it('retains cancelled capacity until settlement, returns committed success, and drains before transport close', async () => {
  const transport = new Transport()
  const reader = new ReadonlyQueryReader('assistant', '', '', Date.now, { createTransport: () => transport, maxPending: 1 })
  const abort = new AbortController()
  const pending = reader.call('assistant.save', ['content'], abort.signal)
  abort.abort()
  expect(reader.pendingCount).toBe(1)
  expect(transport.messages.at(-1)).toEqual({ type: 'cancel', id: 1 })
  // The next request waits for the slot instead of being rejected.
  const next = reader.call('assistant.save', ['other content'])
  expect(reader.waitingCount).toBe(1)
  transport.emit('message', { id: 1, result: { committed: true } })
  expect(await pending).toEqual({ committed: true })
  const close = reader.close()
  expect(transport.stopped).toBe(false)
  transport.emit('message', { id: 2, result: 'second' })
  expect(await next).toBe('second')
  await close
  expect(transport.stopped).toBe(true)
  expect(reader.pendingCount).toBe(0)
})

it('passes storage requests through without a product admission limit', async () => {
  const transport = new Transport()
  const reader = new ReadonlyQueryReader('assistant', '', '', Date.now, { createTransport: () => transport })
  const calls = Array.from({ length: 96 }, (_, index) => reader.call(index % 3 ? 'assistant.listConversationQueueItems' : 'assistant.appendConversationMessage', [index]))
  expect(reader.pendingCount).toBe(96)
  expect(reader.waitingCount).toBe(0)
  const settled = new Set<number>()
  while (settled.size < calls.length) { settleAll(transport, settled); await Promise.resolve() }
  const posted = transport.messages.filter(message => message.type === 'query').map(message => message.args[0])
  expect(posted).toEqual(calls.map((_, index) => index))
  await expect(Promise.all(calls)).resolves.toHaveLength(calls.length)
  expect(reader.admissionHighWaterOperations).toBe(96)
  await reader.close()
})

it('removes a cancelled waiting request without posting it', async () => {
  const transport = new Transport()
  const reader = new ReadonlyQueryReader('assistant', '', '', Date.now, { createTransport: () => transport, maxPending: 1 })
  const first = reader.call('assistant.listProjects', [])
  const cancelled = new AbortController()
  const waiting = reader.call('assistant.listProjects', ['waiting'], cancelled.signal)
  cancelled.abort(new Error('waiting cancelled'))
  await expect(waiting).rejects.toThrow('waiting cancelled')
  expect(reader.waitingCount).toBe(0)
  transport.emit('message', { id: 1, result: [] })
  await first
  expect(transport.messages.filter(message => message.type === 'query')).toHaveLength(1)
  await reader.close()
})

it('keeps usable error codes and causes and rejects live handles', () => {
  const error = deserializeWorkerError({ name: 'RangeError', message: 'bounded', code: 'STORAGE_CAPACITY', cause: { name: 'Error', message: 'source' } })
  expect(error).toBeInstanceOf(RangeError)
  expect(error).toMatchObject({ code: 'STORAGE_CAPACITY', cause: { message: 'source' } })
  expect(() => storageDataBytes(new AbortController().signal)).toThrow('plain data')
  expect(() => storageDataBytes({ callback: () => undefined })).toThrow('callbacks')
})

it('awaits a termination already in progress before close settles or capacity can reopen', async () => {
  let exited!: () => void
  class DelayedTransport extends Transport {
    override terminate(): Promise<number> { return new Promise(resolve => { exited = () => resolve(0) }) }
  }
  const transport = new DelayedTransport()
  const reader = new ReadonlyQueryReader('assistant', '', '', Date.now, { createTransport: () => transport })
  const pending = reader.call('assistant.save', [])
  const rejected = expect(pending).rejects.toMatchObject({ code: 'STORAGE_UNCONFIRMED' })
  transport.emit('error', new Error('host failed'))
  reader.resetBackoffForTest()
  expect(reader.available).toBe(false)
  await expect(reader.call('assistant.read', [])).rejects.toThrow('backing off')
  let closed = false
  const close = reader.close().then(() => { closed = true })
  await Promise.resolve()
  expect(closed).toBe(false)
  exited()
  await rejected
  await close
  expect(closed).toBe(true)
})

it('runs real utility-process storage, read workers, transactions, serialization, drain and reopen', async () => {
  const parent = resolve('temp/goodbuddy-storage-foundation')
  await mkdir(parent, { recursive: true })
    const directory = await mkdtemp(join(parent, 'electron-'))
    await chmod(directory, 0o700)
  try {
    const seed = new AssistantDatabase(join(directory, 'assistant.sqlite'))
    seed.initialize(directory)
    seed.close()
    const legacy = new DatabaseSync(join(directory, 'assistant.sqlite'))
    legacy.exec('PRAGMA user_version = 61')
    legacy.close()
    for (const [entry, output, format] of [
      ['desktop-storage-entry', 'desktop-storage-entry.mjs', 'esm'],
      ['desktop-storage-electron-fixture', 'main.mjs', 'esm'],
      ['desktop-storage-echo-fixture', 'desktop-storage-echo.cjs', 'cjs'],
      ['readonly-query-worker', 'readonly-query-worker.cjs', 'cjs'],
      ['assistant-storage-worker', 'assistant-storage-worker.cjs', 'cjs']
    ] as const) await build({ entryPoints: [resolve(`src/main/${entry}.ts`)], outfile: join(directory, output),
      bundle: true, platform: 'node', format, external: ['electron', '@napi-rs/canvas'], logLevel: 'silent' })
    const env: NodeJS.ProcessEnv = { ...process.env, GB_STORAGE_TEST_ROOT: directory, TEMP: directory, TMP: directory, TMPDIR: directory }
    delete env.ELECTRON_RUN_AS_NODE
    const child = spawn(createRequire(import.meta.url)('electron'), [join(directory, 'main.mjs')], { env, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    child.stdout.on('data', data => { output += data })
    child.stderr.on('data', data => { output += data })
    const timer = setTimeout(() => child.kill(), 60_000)
    try {
      const code = await new Promise<number | null>((resolve, reject) => { child.once('exit', resolve); child.once('error', reject) })
      expect(code, output).toBe(0)
      expect(output).toContain('desktop-storage-electron: passed')
      const memory = output.split(/\r?\n/).find(line => line.startsWith('storage-memory:'))
      expect(memory).toBeDefined()
      process.stdout.write(`${memory}\n`)
    } finally { clearTimeout(timer) }
  } finally { await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) }
}, 90_000)

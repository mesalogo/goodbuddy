import { afterEach, expect, it, vi } from 'vitest'
import type { AgentRuntime } from '../agent/runtime'
import { ModelAgentRuntime, noModelTools } from '../agent/model-runtime'
import { AssistantDatabase } from './assistant-database'
import { SupervisionModelPool } from './supervision-model-pool'
import { createProductionSuggestionPhraser } from './supervision-production'

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
  vi.useRealTimers()
})

function fixture(run: AgentRuntime['run'], timeoutSeconds = 30) {
  vi.useFakeTimers()
  const db = new AssistantDatabase(':memory:')
  db.initialize(process.cwd())
  const pool = new SupervisionModelPool()
  const release = vi.fn<NonNullable<AgentRuntime['releaseConversation']>>(async () => {})
  const dispose = vi.fn(async () => {})
  const runtime = { run: vi.fn(run), releaseConversation: release, dispose } as unknown as AgentRuntime
  const statuses = vi.spyOn(db, 'updateTaskStatus')
  const phrase = createProductionSuggestionPhraser(db, async () => ({ supervisorModelConcurrency: 1,
    supervisorOrganizeTimeoutSeconds: timeoutSeconds }), async () => runtime, pool)
  cleanups.push(() => { pool.dispose(); db.close() })
  return { db, pool, runtime, release, dispose, statuses,
    start: () => phrase({ systemInstruction: 'Suggest', outputContract: '{}', candidates: [] }) }
}

it.each([
  Object.assign(new Error('Slow down'), { status: 429 }),
  Object.assign(new Error('Gateway unavailable'), { statusCode: 502 }),
  new TypeError('fetch failed', { cause: Object.assign(new Error('socket closed'), { code: 'ECONNRESET' }) }),
  new TypeError('terminated'),
  '模型接口请求失败（HTTP 503）',
  'Gateway Timeout (HTTP 504)',
  'TypeError: terminated',
  '模型接口流式响应意外中断',
  'Rate limit exceeded'
])('retries a transient failure once with fresh text, usage identities and cleanup: %s', async failure => {
  let calls = 0
  const finalized = vi.fn()
  const f = fixture(async function* (input, signal) {
    calls++
    try {
      yield { type: 'model-usage', requestId: input.requestId, callId: 'provider-call', runtime: 'model', provider: 'openai',
        model: 'fake', inputTokens: 10, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 }
      if (calls === 1) {
        yield { type: 'text', requestId: input.requestId, delta: 'discard partial {' }
        if (typeof failure === 'string') yield { type: 'error', status: 'failed', requestId: input.requestId, message: failure }
        else throw failure
      } else {
        expect(f.release).toHaveBeenCalledTimes(1)
        expect(signal.aborted).toBe(false)
        yield { type: 'text', requestId: input.requestId, delta: 'clean result' }
        yield { type: 'done', requestId: input.requestId }
      }
    } finally { finalized() }
  })
  const result = f.start()
  await vi.advanceTimersByTimeAsync(499)
  expect(calls).toBe(1)
  expect(f.release).toHaveBeenCalledTimes(1)
  await vi.advanceTimersByTimeAsync(1)
  await expect(result).resolves.toBe('clean result')
  expect(calls).toBe(2)
  expect(finalized).toHaveBeenCalledTimes(2)
  expect(f.release).toHaveBeenCalledTimes(2)
  expect(new Set(f.release.mock.calls.map(args => args[0])).size).toBe(2)
  expect(f.dispose).toHaveBeenCalledOnce()
  expect(f.statuses.mock.calls.map(args => args[1])).toEqual(['failed', 'completed'])
  expect(f.db.getTokenUsageSummary().systemTotals).toMatchObject({ callCount: 2, input: 20, output: 4 })
  expect(f.db.listTasks()).toEqual([])
  await expect(f.pool.run(async () => 'released')).resolves.toBe('released')
  expect(vi.getTimerCount()).toBe(0)
})

it('makes exactly two calls on persistent transient failure and releases the pool', async () => {
  const failure = Object.assign(new Error('Unavailable'), { status: 503 })
  const f = fixture(async function* (input) { yield { type: 'status', requestId: input.requestId, message: 'starting' }; throw failure })
  const result = expect(f.start()).rejects.toBe(failure)
  await vi.runAllTimersAsync()
  await result
  expect(f.runtime.run).toHaveBeenCalledTimes(2)
  expect(f.release).toHaveBeenCalledTimes(2)
  expect(f.dispose).toHaveBeenCalledOnce()
  await expect(f.pool.run(async () => true)).resolves.toBe(true)
  expect(vi.getTimerCount()).toBe(0)
})

it.each([
  Object.assign(new Error('Unauthorized'), { status: 401 }),
  Object.assign(new Error('Forbidden'), { status: 403 }),
  Object.assign(new Error('Not implemented'), { status: 501 }),
  Object.assign(new Error('Insufficient quota'), { status: 429 }),
  Object.assign(new Error('Context length exceeded'), { status: 503 }),
  Object.assign(new Error('Invalid API key'), { status: 429 }),
  new Error('模型接口请求超时', { cause: new TypeError('terminated') }),
  new DOMException('aborted', 'AbortError'),
  new Error('模型接口返回了无效的流式 JSON'),
  new Error('Provider unavailable'),
  new Error('Configuration invalid'),
  new TypeError('fetch failed', { cause: Object.assign(new Error('bad host'), { code: 'ENOTFOUND' }) }),
  new TypeError('fetch failed', { cause: Object.assign(new Error('bad certificate'), { code: 'CERT_HAS_EXPIRED' }) }),
  new Error('单次模型响应超过 100 KiB'),
  new Error('Unrelated error mentioning 429')
])('does not retry nontransient errors, thrown or emitted: %s', async failure => {
  for (const emitted of [false, true]) {
    const f = fixture(async function* (input) {
      if (emitted && !failure.cause) yield { type: 'error', status: 'failed', requestId: input.requestId, message: failure.message }
      else throw failure
    })
    await expect(f.start()).rejects.toThrow(failure.message)
    expect(f.runtime.run).toHaveBeenCalledOnce()
    expect(f.release).toHaveBeenCalledOnce()
    expect(f.dispose).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  }
})

it('cancels during the retry wait without dispatching another request', async () => {
  const f = fixture(async function* (input) { yield { type: 'error', status: 'failed', requestId: input.requestId, message: 'terminated' } })
  const result = expect(f.start()).rejects.toThrow()
  await vi.advanceTimersByTimeAsync(100)
  expect(f.release).toHaveBeenCalledOnce()
  f.pool.cancelAll(new Error('User cancelled'))
  await result
  await vi.runAllTimersAsync()
  expect(f.runtime.run).toHaveBeenCalledOnce()
  expect(f.dispose).toHaveBeenCalledOnce()
  await expect(f.pool.run(async () => true)).resolves.toBe(true)
  expect(vi.getTimerCount()).toBe(0)
})

it('does not retry cancellation disguised as a transient stream error', async () => {
  const f = fixture(async function* (input) {
    yield { type: 'status', requestId: input.requestId, message: 'starting' }
    f.pool.cancelAll(new Error('User cancelled'))
    throw new TypeError('terminated')
  })
  await expect(f.start()).rejects.toThrow('User cancelled')
  expect(f.runtime.run).toHaveBeenCalledOnce()
  expect(f.statuses).toHaveBeenLastCalledWith(expect.any(String), 'cancelled', 'User cancelled')
})

it.each([false, true])('keeps a per-attempt timeout and never retries timeout (transient first: %s)', async transientFirst => {
  let calls = 0
  const f = fixture(async function* (input, signal) {
    calls++
    if (transientFirst && calls === 1) {
      await new Promise(resolve => setTimeout(resolve, 900))
      throw new TypeError('terminated')
    }
    await new Promise<void>((_, reject) => signal.addEventListener('abort', () => reject(new TypeError('terminated')), { once: true }))
    yield { type: 'done', requestId: input.requestId }
  }, 1)
  const result = expect(f.start()).rejects.toThrow('超过 1 秒')
  await vi.advanceTimersByTimeAsync(transientFirst ? 2300 : 900)
  expect(calls).toBe(transientFirst ? 2 : 1)
  expect(f.dispose).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(100)
  await result
  expect(f.release).toHaveBeenCalledTimes(transientFirst ? 2 : 1)
  expect(f.dispose).toHaveBeenCalledOnce()
  expect(vi.getTimerCount()).toBe(0)
})

it('does not retry a cancelled runtime error event with a transient-looking message', async () => {
  const f = fixture(async function* (input) {
    yield { type: 'error', status: 'cancelled', requestId: input.requestId, message: 'terminated' }
  })
  await expect(f.start()).rejects.toThrow('terminated')
  expect(f.runtime.run).toHaveBeenCalledOnce()
  expect(f.statuses).toHaveBeenLastCalledWith(expect.any(String), 'cancelled', 'terminated')
  expect(f.release).toHaveBeenCalledOnce()
})

it('does not dispatch a retry if conversation cleanup fails', async () => {
  const f = fixture(async function* (input) {
    yield { type: 'error', status: 'failed', requestId: input.requestId, message: 'terminated' }
  })
  f.release.mockRejectedValueOnce(new Error('Cleanup failed'))
  await expect(f.start()).rejects.toThrow('Cleanup failed')
  expect(f.runtime.run).toHaveBeenCalledOnce()
  expect(f.dispose).toHaveBeenCalledOnce()
  await expect(f.pool.run(async () => true)).resolves.toBe(true)
  expect(vi.getTimerCount()).toBe(0)
})

it.each([429, 500, 502, 503, 504])('retries actual direct-model HTTP %i with provider detail intact', async status => {
  const detail = status === 504 ? 'Gateway Timeout' : 'Provider detail'
  const fetcher = vi.fn<typeof fetch>()
    .mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: detail } }), { status }))
    .mockResolvedValueOnce(new Response('data: {"choices":[{"delta":{"content":"success"}}]}\n\ndata: [DONE]\n\n'))
  const runtime = new ModelAgentRuntime({ baseUrl: 'https://model.invalid', model: 'fake', authentication: 'none',
    protocol: 'openai-chat-completions', toolProvider: noModelTools, fetcher })
  const f = fixture(runtime.run.bind(runtime))
  f.release.mockImplementation(runtime.releaseConversation.bind(runtime))
  f.dispose.mockImplementation(runtime.dispose.bind(runtime))
  const result = expect(f.start()).resolves.toBe('success')
  await vi.runAllTimersAsync()
  await result
  expect(fetcher).toHaveBeenCalledTimes(2)
  expect(f.statuses.mock.calls[0]?.[2]).toBe(detail)
  expect(f.release).toHaveBeenCalledTimes(2)
  expect(f.dispose).toHaveBeenCalledOnce()
})

it('retries an actual interrupted direct-model stream and retains its reported usage', async () => {
  let reads = 0
  const stream = new ReadableStream<Uint8Array>({ pull(controller) {
    if (reads++ === 0) controller.enqueue(new TextEncoder().encode(
      'data: {"choices":[{"delta":{"content":"discard me"}}],"usage":{"prompt_tokens":12,"completion_tokens":3}}\n\n'))
    else controller.error(new TypeError('terminated'))
  } })
  const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(stream))
    .mockResolvedValueOnce(new Response('data: {"choices":[{"delta":{"content":"success"}}],"usage":{"prompt_tokens":14,"completion_tokens":4}}\n\ndata: [DONE]\n\n'))
  const runtime = new ModelAgentRuntime({ baseUrl: 'https://model.invalid', model: 'fake', authentication: 'none',
    protocol: 'openai-chat-completions', toolProvider: noModelTools, fetcher })
  const f = fixture(runtime.run.bind(runtime))
  f.release.mockImplementation(runtime.releaseConversation.bind(runtime))
  f.dispose.mockImplementation(runtime.dispose.bind(runtime))
  const result = expect(f.start()).resolves.toBe('success')
  await vi.runAllTimersAsync()
  await result
  expect(fetcher).toHaveBeenCalledTimes(2)
  expect(stream.locked).toBe(false)
  expect(f.db.getTokenUsageSummary().systemTotals).toMatchObject({ callCount: 2, input: 26, output: 7 })
  expect(f.release).toHaveBeenCalledTimes(2)
  expect(f.dispose).toHaveBeenCalledOnce()
})

it.each([
  ['openai-chat-completions', false], ['anthropic-messages', false],
  ['openai-chat-completions', true], ['anthropic-messages', true]
] as const)(
  'retains reported usage when %s output exceeds capacity without retrying (buffered=%s)', async (protocol, buffered) => {
    const text = 'x'.repeat(1024 * 1024 + 1)
    const events = protocol === 'anthropic-messages'
      ? [{ type: 'message_start', message: { id: 'call', model: 'fake', usage: { input_tokens: 12, output_tokens: 3 } } },
          { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }]
      : [{ choices: [{ delta: { content: text } }], usage: { prompt_tokens: 12, completion_tokens: 3 } }]
    let body!: ReadableStreamDefaultController<Uint8Array>
    const stream = new ReadableStream<Uint8Array>({ start(controller) { body = controller } })
    body.enqueue(new TextEncoder().encode(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('')))
    if (buffered) {
      body.enqueue(new TextEncoder().encode(protocol === 'anthropic-messages' ? 'data: {"type":"message_stop"}\n\n' : 'data: [DONE]\n\n'))
      body.close()
    }
    const fetcher = vi.fn<typeof fetch>(async (_input, init) => {
      if (!buffered) init!.signal!.addEventListener('abort', () => body.error(init!.signal!.reason), { once: true })
      return new Response(stream)
    })
    const runtime = new ModelAgentRuntime({ baseUrl: 'https://model.invalid', model: 'fake', authentication: 'none',
      protocol, toolProvider: noModelTools, fetcher })
    const f = fixture(runtime.run.bind(runtime))
    f.release.mockImplementation(runtime.releaseConversation.bind(runtime))
    f.dispose.mockImplementation(runtime.dispose.bind(runtime))
    await expect(f.start()).rejects.toThrow('1024 KiB')
    expect(fetcher).toHaveBeenCalledOnce()
    expect(stream.locked).toBe(false)
    expect(f.db.getTokenUsageSummary().systemTotals).toMatchObject({ callCount: 1, input: 12, output: 3 })
    expect(f.release).toHaveBeenCalledOnce()
    expect(f.dispose).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })

it('drains usage only after overflow and preserves the cap error over later errors and timeout', async () => {
  let reason: unknown
  const finalized = vi.fn()
  const f = fixture(async function* (input, signal) {
    try {
      yield { type: 'text', requestId: input.requestId, delta: 'x'.repeat(1024 * 1024 + 1) }
      reason = signal.reason
      expect(signal.aborted).toBe(true)
      await new Promise(resolve => setTimeout(resolve, 200))
      yield { type: 'text', requestId: input.requestId, delta: 'discard trailing text' }
      yield { type: 'model-usage', requestId: input.requestId, callId: 'call', runtime: 'model', provider: 'openai',
        model: 'fake', inputTokens: 12, outputTokens: 3, cacheReadTokens: 0, cacheWriteTokens: 0 }
      yield { type: 'error', requestId: input.requestId, status: 'failed', message: 'terminated' }
      yield { type: 'done', requestId: input.requestId }
    } finally { finalized() }
  }, 0.1)
  const pending = f.start().catch(error => error)
  await vi.advanceTimersByTimeAsync(250)
  expect(await pending).toBe(reason)
  expect(reason).toBeInstanceOf(Error)
  expect((reason as Error).message).toContain('1024 KiB')
  expect(f.runtime.run).toHaveBeenCalledOnce()
  expect(finalized).toHaveBeenCalledOnce()
  expect(f.db.getTokenUsageSummary().systemTotals).toMatchObject({ callCount: 1, input: 12, output: 3 })
  expect(f.release).toHaveBeenCalledOnce()
  expect(f.dispose).toHaveBeenCalledOnce()
  expect(vi.getTimerCount()).toBe(0)
})

it('bounds overflow accounting drain and ignores events arriving after cleanup', async () => {
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const finalized = vi.fn()
  const f = fixture(async function* (input) {
    try {
      yield { type: 'text', requestId: input.requestId, delta: 'x'.repeat(1024 * 1024 + 1) }
      await gate
      yield { type: 'model-usage', requestId: input.requestId, callId: 'late', runtime: 'model', provider: 'openai',
        model: 'fake', inputTokens: 12, outputTokens: 3, cacheReadTokens: 0, cacheWriteTokens: 0 }
    } finally { finalized() }
  })
  const pending = f.start().catch(error => error)
  try {
    await vi.advanceTimersByTimeAsync(999)
    expect(f.release).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(await pending).toMatchObject({ message: expect.stringContaining('1024 KiB') })
    expect(f.release).toHaveBeenCalledOnce()
    expect(f.dispose).toHaveBeenCalledOnce()
    await expect(f.pool.run(async () => 'released')).resolves.toBe('released')
  } finally { release(); await vi.advanceTimersByTimeAsync(1) }
  expect(finalized).toHaveBeenCalledOnce()
  expect(f.db.getTokenUsageSummary().systemTotals).toMatchObject({ callCount: 0 })
  expect(vi.getTimerCount()).toBe(0)
})

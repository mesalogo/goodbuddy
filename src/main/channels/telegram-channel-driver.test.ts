import { afterEach, describe, expect, it, vi } from 'vitest'
import { channelInboundTextSchema, type ChannelResultMessage } from '../../shared/channel-contracts'
import { TelegramChannelDriver } from './telegram-channel-driver'
import { ChannelService } from './channel-service'
import { MemoryOutbox } from './channel-driver'

const netFetch = vi.hoisted(() => vi.fn())
vi.mock('electron', () => ({ net: { fetch: netFetch } }))

const secret = 'test-only-placeholder'
const drivers: TelegramChannelDriver[] = []
const ok = (result: unknown) => Response.json({ ok: true, result })
const error = (code: number, retryAfter = 2) => Response.json({ ok: false, error_code: code, parameters: { retry_after: retryAfter }, description: `https://api.telegram.org/bot${secret}/getUpdates` }, { status: code })
const pending = (signal: AbortSignal) => new Promise<Response>((_resolve, reject) => {
  if (signal.aborted) reject(new Error(secret))
  else signal.addEventListener('abort', () => reject(new Error(secret)), { once: true })
})
const update = (id: number, text = 'hello', extra: Record<string, unknown> = {}) => ({
  update_id: id,
  message: { message_id: id + 100, date: 1234, from: { id: 7, is_bot: false }, chat: { id: 7, type: 'private' }, text, ...extra }
})
function setup(allowedSenderIds: string[] = ['7']) {
  const calls: { method: string; body: Record<string, unknown>; signal: AbortSignal }[] = []
  const polls: ((signal: AbortSignal) => Response | Promise<Response>)[] = []
  const sends: (() => Response | Promise<Response>)[] = []
  const onStatus = vi.fn()
  const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
    const method = String(input).split('/').at(-1)!
    const signal = init!.signal!
    calls.push({ method, body: JSON.parse(String(init!.body)), signal })
    if (method === 'getMe') return ok({ id: 42, is_bot: true, username: 'example_bot' })
    if (method === 'getWebhookInfo') return ok({ url: '' })
    if (method === 'getUpdates') return polls.shift()?.(signal) ?? pending(signal)
    if (method === 'sendMessage') return sends.shift()?.() ?? ok({ message_id: 99 })
    return ok(true)
  })
  const driver = new TelegramChannelDriver({ secret, allowedSenderIds, fetch, onStatus })
  drivers.push(driver)
  return { driver, calls, polls, sends, fetch, onStatus }
}

afterEach(async () => {
  await Promise.all(drivers.splice(0).map((driver) => driver.stop()))
  vi.useRealTimers()
})

const result = (overrides: Partial<ChannelResultMessage> = {}): ChannelResultMessage => ({
  channel: 'telegram', eventId: '1', conversationId: '42:7', recipientId: '7', status: 'completed', output: 'answer', ...overrides
})

describe('TelegramChannelDriver', () => {
  it('is lazy, validates with getMe/getWebhookInfo only, and never polls during repeated tests', async () => {
    const { driver, calls } = setup()
    expect(calls).toEqual([])
    expect(await driver.testConnection()).toEqual({ botId: '42', botUsername: 'example_bot' })
    await driver.testConnection()
    expect(calls.map((call) => call.method)).toEqual(['getMe', 'getWebhookInfo', 'getMe', 'getWebhookInfo'])
  })

  it('refuses a webhook without deleting it or polling', async () => {
    const { driver, fetch, calls } = setup()
    fetch.mockResolvedValueOnce(ok({ id: 42, is_bot: true })).mockResolvedValueOnce(ok({ url: 'https://example.invalid/hook' }))
    await expect(driver.testConnection()).rejects.toThrow('webhook')
    expect(calls).toHaveLength(0)
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('keeps test requests separate from the running poller', async () => {
    const { driver, calls } = setup()
    await driver.start(vi.fn())
    await driver.testConnection()
    expect(calls.filter((call) => call.method === 'getUpdates')).toHaveLength(1)
  })

  it('allows bounded private help with an empty whitelist but no ordinary requests', async () => {
    const { driver, polls, calls } = setup([])
    polls.push(() => ok([update(1, '/whoami'), update(2, '/whoami'), update(3, 'ordinary'), update(4, '/start')]))
    const handler = vi.fn()
    await driver.start(handler)
    await vi.waitFor(() => expect(calls.filter((call) => call.method === 'sendMessage')).toHaveLength(2))
    expect(handler).not.toHaveBeenCalled()
    expect(calls.find((call) => call.method === 'sendMessage')?.body.text).toBe('7')
    expect(calls.filter((call) => call.method === 'sendMessage')[1]?.body.text).toContain('Offline messages')
  })

  it('requires numeric whitelist IDs', () => {
    expect(() => setup(['@somebody'])).toThrow('numeric')
  })

  it('preserves all unknown slash text, Bot scope, event ID and millisecond date', async () => {
    const { driver, polls } = setup()
    polls.push(() => ok(['/ask', '/execute something', '/exec', '/unknown'].map((text, i) => update(i + 1, text))))
    const handler = vi.fn(async (message, ack) => { channelInboundTextSchema.parse(message); ack() })
    await driver.start(handler)
    await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(4))
    expect(handler.mock.calls.map(([message]) => message.text)).toEqual(['/ask', '/execute something', '/exec', '/unknown'])
    expect(handler.mock.calls[0]?.[0]).toEqual({ channel: 'telegram', accountId: '42', eventId: '1', senderId: '7', conversationId: '42:7', conversationType: 'direct', text: '/ask', mentioned: false, receivedAt: 1234000 })
  })

  it('ignores groups, topics, bots, edits, unauthorized users and media captions', async () => {
    const { driver, polls, calls } = setup()
    polls.push(() => ok([
      update(1, '/whoami', { chat: { id: -7, type: 'group' } }),
      update(2, 'topic', { message_thread_id: 1 }),
      update(3, 'bot', { from: { id: 7, is_bot: true } }),
      { update_id: 4, edited_message: update(4).message },
      update(5, 'unauthorized', { from: { id: 9, is_bot: false } }),
      update(6, '/start', { photo: [], caption: 'execute caption' }),
      update(7, '', { photo: [], from: { id: 9, is_bot: false } }),
      update(8, '   '), update(9, 'valid')
    ]))
    const handler = vi.fn(async (_message, ack) => ack())
    await driver.start(handler)
    await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(1))
    expect(handler.mock.calls[0]?.[0].text).toBe('valid')
    expect(calls.filter((call) => call.method === 'sendMessage').map((call) => call.body.text)).toEqual(['Only text messages are supported. Please describe your request in text.'])
  })

  it('does not advance past unacknowledged input and skips duplicates after acknowledgment', async () => {
    const { driver, polls, calls } = setup()
    polls.push(() => ok([update(10)]), () => ok([update(10), update(11)]), () => ok([update(11)]))
    let attempts = 0
    const handler = vi.fn(async (_message, ack) => { if (++attempts > 1) ack() })
    await driver.start(handler)
    await vi.waitFor(() => expect(calls.filter((call) => call.method === 'getUpdates')).toHaveLength(4), { timeout: 3000 })
    expect(calls.filter((call) => call.method === 'getUpdates').map((call) => call.body.offset)).toEqual([0, 0, 12, 12])
    expect(handler).toHaveBeenCalledTimes(3)
  })

  it('stop aborts long polling and waits for fetch cleanup', async () => {
    const { driver, calls } = setup()
    await driver.start(vi.fn())
    await vi.waitFor(() => expect(calls.some((call) => call.method === 'getUpdates')).toBe(true))
    await driver.stop()
    expect(calls.find((call) => call.method === 'getUpdates')?.signal.aborted).toBe(true)
    await expect(driver.send(result(), new AbortController().signal)).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('cancels validation without starting a poller', async () => {
    const { driver, fetch } = setup()
    fetch.mockImplementationOnce((_input, init) => pending(init!.signal!))
    await driver.start(vi.fn())
    const sending = driver.send(result(), new AbortController().signal)
    const rejected = expect(sending).rejects.toMatchObject({ name: 'AbortError' })
    await driver.stop()
    await rejected
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('waits on 429 and cancellation interrupts retry_after', async () => {
    const { driver, polls, calls, onStatus } = setup()
    polls.push(() => error(429, 60))
    await driver.start(vi.fn())
    await vi.waitFor(() => expect(onStatus).toHaveBeenCalledWith(expect.objectContaining({ state: 'starting', lastError: expect.stringContaining('rate limit') })))
    await driver.stop()
    expect(calls.filter((call) => call.method === 'getUpdates')).toHaveLength(1)
  })

  it('backs off transient failures and recovers status', async () => {
    const { driver, polls, onStatus, calls } = setup()
    polls.push(() => error(503), () => ok([]))
    await driver.start(vi.fn())
    await vi.waitFor(() => expect(calls.filter((call) => call.method === 'getUpdates').length).toBeGreaterThanOrEqual(2), { timeout: 2500 })
    expect(onStatus.mock.calls.some(([status]) => status.lastError?.includes('503'))).toBe(true)
    expect(onStatus.mock.calls.at(-1)?.[0]).toEqual({ state: 'running' })
  })

  it.each([401, 403, 409])('stops polling with a clear redacted %i error', async (code) => {
    const { driver, polls, calls, onStatus } = setup()
    polls.push(() => error(code))
    await driver.start(vi.fn())
    await vi.waitFor(() => expect(onStatus).toHaveBeenCalledWith(expect.objectContaining({ state: 'error' })))
    const status = onStatus.mock.calls.at(-1)![0]
    expect(status.lastError).not.toContain(secret)
    expect(status.lastError).not.toContain('https://')
    expect(calls.filter((call) => call.method === 'getUpdates')).toHaveLength(1)
  })

  it('delivers accepted work after a polling conflict without terminating its outbox entry', async () => {
    const { driver, polls, calls, onStatus } = setup()
    const outbox = new MemoryOutbox()
    let finish!: (value: { status: string; output: string }) => void
    const executor = vi.fn(() => new Promise<{ status: string; output: string }>((resolve) => { finish = resolve }))
    const service = new ChannelService(driver, executor, { allowedSenderIds: ['7'], outbox })
    polls.push(() => ok([update(1)]), () => error(409))
    try {
      await service.start()
      await vi.waitFor(() => expect(executor).toHaveBeenCalledOnce())
      await vi.waitFor(() => expect(onStatus.mock.calls.at(-1)?.[0].state).toBe('error'))
      finish({ status: 'completed', output: 'accepted work result' })
      await vi.waitFor(() => expect(calls.filter((call) => call.method === 'sendMessage')).toHaveLength(1))
      expect(calls.find((call) => call.method === 'sendMessage')?.body.text).toBe('accepted work result')
      expect(outbox.listUndelivered()).toEqual([])
      expect(onStatus.mock.calls.at(-1)?.[0].state).toBe('error')
    } finally {
      await service.stop()
    }
  })

  it('splits pure text at 4096 UTF16 units without splitting emoji and includes error and attachment notice', async () => {
    const { driver, calls } = setup()
    await driver.start(vi.fn())
    const output = `${'a'.repeat(4095)}\uD83D\uDE00${'b'.repeat(4100)}`
    await driver.send(result({ output, error: 'task failed', attachments: [{ name: 'file.txt', mimeType: 'text/plain', size: 1, kind: 'file', dataBase64: 'YQ==' }] }), new AbortController().signal)
    const parts = calls.filter((call) => call.method === 'sendMessage').map((call) => call.body.text as string)
    expect(parts).toHaveLength(3)
    expect(parts.every((part) => part.length <= 4096 && !/[\uD800-\uDBFF]$/u.test(part) && !/^[\uDC00-\uDFFF]/u.test(part))).toBe(true)
    expect(parts.join('')).toBe(`${output}\n\ntask failed\n\nAttachments are available in GoodBuddy on the desktop; no attachments were sent to Telegram.`)
    expect(calls.filter((call) => call.method === 'sendMessage').every((call) => call.body.parse_mode === undefined)).toBe(true)
  })

  it('resumes unsent chunks within the bounded in-memory progress cache', async () => {
    const { driver, sends, calls } = setup()
    await driver.start(vi.fn())
    sends.push(() => ok(true), () => error(503))
    const message = result({ output: 'a'.repeat(4096) + 'tail' })
    await expect(driver.send(message, new AbortController().signal)).rejects.toThrow('503')
    await driver.send(message, new AbortController().signal)
    expect(calls.filter((call) => call.method === 'sendMessage').map((call) => call.body.text)).toEqual(['a'.repeat(4096), 'tail', 'tail'])
  })

  it('refuses persisted outbox replies from another Bot and unscoped IDs', async () => {
    const { driver, calls } = setup()
    await driver.start(vi.fn())
    for (const conversationId of ['41:7', '7', '42:-7', '42:8']) {
      await expect(driver.send(result({ conversationId }), new AbortController().signal)).rejects.toMatchObject({ message: expect.stringContaining('another Bot'), permanent: true, terminal: true })
    }
    expect(calls.filter((call) => call.method === 'sendMessage')).toHaveLength(0)
  })

  it('redacts fetch errors, raw Telegram URLs, Token and runtime errors', async () => {
    const { driver, fetch, calls } = setup()
    fetch.mockRejectedValueOnce(new Error(`https://api.telegram.org/bot${secret}/getMe`))
    await expect(driver.testConnection()).rejects.toThrow('network')
    await driver.start(vi.fn())
    await driver.send(result({ output: secret, error: `https://api.telegram.org/bot${secret}/getUpdates token=private` }), new AbortController().signal)
    const text = String(calls.find((call) => call.method === 'sendMessage')?.body.text)
    expect(text).not.toContain(secret)
    expect(text).not.toContain('api.telegram.org')
    expect(text).not.toContain('private')
  })

  it('cancels outbound rate-limit waits and avoids repeating permanent send failures', async () => {
    const { driver, sends, calls } = setup()
    await driver.start(vi.fn())
    sends.push(() => error(429, 60))
    const controller = new AbortController()
    const sending = driver.send(result(), controller.signal)
    const rejected = expect(sending).rejects.toMatchObject({ name: 'AbortError' })
    await vi.waitFor(() => expect(calls.filter((call) => call.method === 'sendMessage')).toHaveLength(1))
    controller.abort(new Error(secret))
    await rejected
    sends.push(() => error(403))
    await expect(driver.send(result(), new AbortController().signal)).rejects.toMatchObject({ permanent: true, terminal: true })
    await expect(driver.send(result(), new AbortController().signal)).rejects.toThrow('forbidden')
    expect(calls.filter((call) => call.method === 'sendMessage')).toHaveLength(2)
  })

  it('uses Electron net.fetch for the production network path', async () => {
    netFetch.mockResolvedValueOnce(ok({ id: 42, is_bot: true })).mockResolvedValueOnce(ok({ url: '' }))
    const driver = new TelegramChannelDriver({ secret, allowedSenderIds: [] })
    drivers.push(driver)
    expect(netFetch).not.toHaveBeenCalled()
    await expect(driver.testConnection()).resolves.toEqual({ botId: '42' })
    expect(netFetch).toHaveBeenCalledTimes(2)
  })

  it('honors retry_after before retrying an outbound chunk', async () => {
    const { driver, sends, calls } = setup()
    await driver.start(vi.fn())
    sends.push(() => error(429, 1), () => ok(true))
    const started = Date.now()
    await driver.send(result(), new AbortController().signal)
    expect(Date.now() - started).toBeGreaterThanOrEqual(990)
    expect(calls.filter((call) => call.method === 'sendMessage')).toHaveLength(2)
  })

  it('stop cancels and joins active outbound requests', async () => {
    const { driver, fetch, calls } = setup()
    await driver.start(vi.fn())
    await vi.waitFor(() => expect(calls.some((call) => call.method === 'getUpdates')).toBe(true))
    fetch.mockImplementationOnce((_input, init) => pending(init!.signal!))
    const sending = driver.send(result(), new AbortController().signal)
    const rejected = expect(sending).rejects.toMatchObject({ name: 'AbortError' })
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(4))
    await driver.stop()
    await rejected
  })

  it('retains HTTP authentication errors even for non-JSON responses', async () => {
    const { driver, fetch } = setup()
    fetch.mockResolvedValueOnce(new Response('not JSON', { status: 401 }))
    await expect(driver.testConnection()).rejects.toThrow('Token is invalid')
  })

  it('returns from start while offline, reconnects and releases queued sends only after validation', async () => {
    const { driver, fetch, calls, onStatus } = setup()
    fetch.mockRejectedValueOnce(new Error(secret))
    await driver.start(vi.fn())
    const sending = driver.send(result(), new AbortController().signal)
    await vi.waitFor(() => expect(onStatus).toHaveBeenCalledWith(expect.objectContaining({ state: 'starting', lastError: expect.stringContaining('Reconnecting') })))
    expect(calls).toHaveLength(0)
    await sending
    expect(calls.map((call) => call.method)).toEqual(['getMe', 'getWebhookInfo', 'getUpdates', 'sendMessage'])
    expect(onStatus.mock.calls.at(-1)?.[0]).toEqual({ state: 'running' })
  })

  it('stop cancels startup backoff and all identity waiters', async () => {
    const { driver, fetch, onStatus } = setup()
    fetch.mockRejectedValueOnce(new Error(secret))
    await driver.start(vi.fn())
    const sending = driver.send(result(), new AbortController().signal)
    const rejected = expect(sending).rejects.toMatchObject({ name: 'AbortError' })
    await vi.waitFor(() => expect(onStatus).toHaveBeenCalledWith(expect.objectContaining({ lastError: expect.stringContaining('Reconnecting') })))
    await driver.stop()
    await rejected
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(onStatus.mock.calls.at(-1)?.[0]).toEqual({ state: 'stopped' })
  })

  it('rechecks a transient webhook failure before polling after identifying the Bot', async () => {
    const { driver, fetch, calls, onStatus } = setup()
    fetch.mockResolvedValueOnce(ok({ id: 42, is_bot: true }))
      .mockResolvedValueOnce(error(503))
    await driver.start(vi.fn())
    await vi.waitFor(() => expect(onStatus).toHaveBeenCalledWith(expect.objectContaining({ state: 'starting', lastError: expect.stringContaining('503') })))
    expect(calls.some(call => call.method === 'getUpdates')).toBe(false)
    await vi.waitFor(() => expect(calls.some(call => call.method === 'getUpdates')).toBe(true), { timeout: 2500 })
    expect(fetch.mock.calls.map(([input]) => String(input).split('/').at(-1)))
      .toEqual(['getMe', 'getWebhookInfo', 'getWebhookInfo', 'getUpdates'])
  })

  it('caller cancellation releases an identity waiter without cancelling startup', async () => {
    const { driver, fetch, onStatus } = setup()
    let validationSignal: AbortSignal | undefined
    fetch.mockImplementationOnce((_input, init) => {
      validationSignal = init!.signal!
      return pending(validationSignal)
    })
    await driver.start(vi.fn())
    const controller = new AbortController()
    const sending = driver.send(result(), controller.signal)
    const rejected = expect(sending).rejects.toMatchObject({ name: 'AbortError' })
    controller.abort()
    await rejected
    expect(validationSignal?.aborted).toBe(false)
    expect(onStatus.mock.calls.at(-1)?.[0]).toEqual({ state: 'starting' })
  })

  it.each([401, 409])('reports terminal startup %i and rejects waiting sends without retrying', async (code) => {
    const { driver, fetch, onStatus } = setup()
    fetch.mockResolvedValueOnce(error(code))
    await driver.start(vi.fn())
    await expect(driver.send(result(), new AbortController().signal)).rejects.toMatchObject({ code, permanent: true, terminal: true })
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(onStatus.mock.calls.at(-1)?.[0].state).toBe('error')
  })

  it('updates the numeric whitelist atomically for subsequent input without restarting', async () => {
    const { driver, polls, calls } = setup()
    expect(() => driver.updateAllowedSenderIds(['invalid'])).toThrow('numeric')
    polls.push(() => ok([update(1), update(2), update(3, 'new user', { from: { id: 8, is_bot: false }, chat: { id: 8, type: 'private' } })]))
    const handler = vi.fn(async (_message, ack) => {
      ack()
      driver.updateAllowedSenderIds(['8'])
    })
    await driver.start(handler)
    await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(2))
    expect(handler.mock.calls.map(([message]) => message.senderId)).toEqual(['7', '8'])
    expect(calls.filter((call) => call.method === 'getMe')).toHaveLength(1)
    expect(calls.every((call) => !call.signal.aborted)).toBe(true)
    // Previously authorized work can still deliver after its sender is removed.
    await driver.send(result(), new AbortController().signal)
    expect(calls.at(-1)?.method).toBe('sendMessage')
  })

  it('help rate limits never hold up subsequent inbound requests', async () => {
    const { driver, polls, sends, calls } = setup()
    sends.push(() => error(429, 86400))
    polls.push(() => ok([update(1, '/start'), update(2, 'business request')]))
    const handler = vi.fn(async (_message, ack) => ack())
    await driver.start(handler)
    await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(1))
    expect(calls.filter((call) => call.method === 'sendMessage')).toHaveLength(1)
  })

  it('testConnection fails fast on rate limiting and cannot replace the running identity', async () => {
    const { driver, fetch, calls } = setup()
    fetch.mockResolvedValueOnce(error(429, 86400))
    await expect(driver.testConnection()).rejects.toMatchObject({ code: 429 })
    expect(fetch).toHaveBeenCalledTimes(1)
    await driver.start(vi.fn())
    await vi.waitFor(() => expect(calls.some((call) => call.method === 'getUpdates')).toBe(true))
    fetch.mockResolvedValueOnce(ok({ id: 99, is_bot: true })).mockResolvedValueOnce(ok({ url: '' }))
    await expect(driver.testConnection()).resolves.toEqual({ botId: '99' })
    await driver.send(result(), new AbortController().signal)
    await expect(driver.send(result({ conversationId: '99:7' }), new AbortController().signal)).rejects.toMatchObject({ terminal: true })
  })
})

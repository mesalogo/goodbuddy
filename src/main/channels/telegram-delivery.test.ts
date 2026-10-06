// @vitest-environment node
import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { describe, expect, it, vi } from 'vitest'
import { AssistantDatabase } from '../assistant/assistant-database'
import { ChannelManager } from './channel-manager'
import { ChannelSettingsStore } from './channel-settings-store'
import { SqliteChannelOutbox } from './sqlite-channel-state'
import { TelegramChannelDriver } from './telegram-channel-driver'
import type { ChannelRuntimeStatusChange } from '../../shared/channel-settings-contracts'

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'goodbuddy-telegram-delivery-'))
  const database = new AssistantDatabase(':memory:')
  database.initialize(root)
  const outbox = new SqliteChannelOutbox(database)
  const settings = new ChannelSettingsStore(join(root, 'channels.json'), {
    isAvailable: () => true, encrypt: value => Buffer.from(value), decrypt: value => value.toString()
  }, {})
  const secret = 'synthetic-telegram-delivery-token'
  await settings.apply({ telegram: { enabled: true, secret: { action: 'replace', value: secret },
    allowedSenderIds: ['7'], allowGroupMessages: false } })
  const state = { webhook: '', pollingCode: 0, polls: 0,
    updates: [] as object[], sends: [] as { text: string; time: number }[],
    sendErrors: [] as { code: number; retryAfter?: number }[] }
  const server = createServer(async (request, response) => {
    let body = ''
    for await (const chunk of request) body += String(chunk)
    const method = request.url!.slice(1)
    let result: unknown
    let failure: { code: number; retryAfter?: number } | undefined
    if (method === 'getMe') result = { id: 42, is_bot: true }
    else if (method === 'getWebhookInfo') result = { url: state.webhook }
    else if (method === 'getUpdates') {
      state.polls++
      if (state.pollingCode) failure = { code: state.pollingCode }
      else result = state.updates.splice(0)
    } else if (method === 'sendMessage') {
      state.sends.push({ text: JSON.parse(body).text, time: performance.now() })
      failure = state.sendErrors.shift()
      result = { message_id: state.sends.length }
    } else if (method === 'sendChatAction') result = true
    else throw new Error('Unexpected fixture method')
    response.setHeader('content-type', 'application/json')
    response.statusCode = failure?.code ?? 200
    response.end(JSON.stringify(failure
      ? { ok: false, error_code: failure.code, parameters: { retry_after: failure.retryAfter },
          description: `token=${secret} https://api.telegram.org/bot${secret}/sendMessage` }
      : { ok: true, result }))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as { port: number }
  const execute = vi.fn(async () => ({ status: 'completed', output: 'synthetic result' }))
  const changes: ChannelRuntimeStatusChange[] = []
  const manager = new ChannelManager(settings, execute, {
    outbox, onStatusChanged: change => changes.push(change),
    createDriver: (resolved, onStatus) => new TelegramChannelDriver({
      secret: resolved.channel === 'telegram' ? resolved.secret! : '',
      allowedSenderIds: resolved.allowedSenderIds, onStatus,
      fetch: (input, init) => fetch(`http://127.0.0.1:${address.port}/${String(input).split('/').at(-1)}`, init)
    })
  })
  return { state, outbox, manager, execute, changes, secret,
    enqueue: (eventId: string, bot = '42') => outbox.enqueue({ channel: 'telegram', eventId,
      conversationId: `${bot}:7`, recipientId: '7', status: 'completed', output: eventId }),
    inbound: (id: number) => state.updates.push({ update_id: id, message: { message_id: id,
      date: 1234, from: { id: 7, is_bot: false }, chat: { id: 7, type: 'private' }, text: 'request' } }),
    async close() {
      await manager.stopAll()
      server.closeAllConnections()
      await new Promise<void>(resolve => server.close(() => resolve()))
      database.close()
      await rm(root, { recursive: true, force: true })
    }
  }
}

describe('Telegram delivery through loopback HTTP and SQLite', () => {
  it('delivers identity-matched pending replies during a startup webhook conflict without sending another Bot results', async () => {
    const f = await fixture()
    try {
      f.state.webhook = 'https://example.invalid/webhook'
      f.enqueue('same-bot')
      f.enqueue('other-bot', '41')
      await f.manager.initialize()
      await vi.waitFor(async () => expect((await f.manager.snapshot()).telegram.status).toMatchObject({
        state: 'error', lastError: expect.stringContaining('polling conflict')
      }))
      await vi.waitFor(async () => expect((await f.outbox.listUndelivered()).every(entry => entry.state === 'terminal')).toBe(true))
      expect(f.state.sends.map(send => send.text)).toEqual(['same-bot'])
      expect((await f.outbox.listUndelivered()).map(entry => [entry.message.eventId, entry.state])).toEqual([['other-bot', 'terminal']])
      expect(f.state.polls).toBe(0)
      f.state.webhook = ''
      await f.manager.reload('telegram')
      await vi.waitFor(async () => expect((await f.manager.snapshot()).telegram.status.state).toBe('running'))
      expect(f.state.sends.map(send => send.text)).toEqual(['same-bot'])
      expect(f.execute).not.toHaveBeenCalled()
    } finally { await f.close() }
  })

  it('surfaces sanitized sending failures without changing polling state or clearing them on healthy polls', async () => {
    const f = await fixture()
    try {
      f.state.sendErrors.push({ code: 403 })
      f.inbound(1)
      await f.manager.initialize()
      await vi.waitFor(async () => expect((await f.outbox.listUndelivered())[0]).toMatchObject({ state: 'terminal', attempts: 1 }))
      await vi.waitFor(() => expect(f.state.polls).toBeGreaterThanOrEqual(2))
      expect((await f.manager.snapshot()).telegram.status).toEqual({ state: 'running',
        lastError: expect.stringMatching(/sending failed.*forbidden/i) })
      expect(JSON.stringify(f.changes)).not.toContain(f.secret)
      expect(JSON.stringify(f.changes)).not.toContain('api.telegram.org')
      f.inbound(2)
      await vi.waitFor(() => expect(f.state.sends).toHaveLength(2))
      await vi.waitFor(async () => expect((await f.manager.snapshot()).telegram.status).toEqual({ state: 'running' }))
      expect(f.execute).toHaveBeenCalledTimes(2)
    } finally { await f.close() }
  })

  it('honors the latest retry_after when an exhausted driver attempt passes to the outbox', async () => {
    const f = await fixture()
    try {
      f.state.sendErrors.push({ code: 429, retryAfter: 1 }, { code: 429, retryAfter: 1 },
        { code: 429, retryAfter: 1 }, { code: 429, retryAfter: 3 })
      f.inbound(1)
      await f.manager.initialize()
      await vi.waitFor(() => expect(f.state.sends).toHaveLength(5), { timeout: 10_000 })
      expect(f.state.sends[4]!.time - f.state.sends[3]!.time).toBeGreaterThanOrEqual(2995)
      await vi.waitFor(async () => expect(await f.outbox.listUndelivered()).toEqual([]))
      expect(f.state.sends.every(send => send.text === 'synthetic result')).toBe(true)
      expect(f.execute).toHaveBeenCalledOnce()
    } finally { await f.close() }
  }, 15_000)

  it('cancels the final rate-limit wait without consuming or duplicating the pending reply', async () => {
    const f = await fixture()
    try {
      f.state.sendErrors.push({ code: 429, retryAfter: 1 }, { code: 429, retryAfter: 1 },
        { code: 429, retryAfter: 1 }, { code: 429, retryAfter: 86400 })
      f.enqueue('cancelled-wait')
      await f.manager.initialize()
      await vi.waitFor(() => expect(f.state.sends).toHaveLength(4), { timeout: 5000 })
      await f.manager.stopAll()
      expect((await f.outbox.listUndelivered())[0]).toMatchObject({ state: 'pending', attempts: 0 })
      expect(f.state.sends).toHaveLength(4)
      await f.manager.initialize()
      await vi.waitFor(async () => expect(await f.outbox.listUndelivered()).toEqual([]))
      expect(f.state.sends).toHaveLength(5)
      expect(f.execute).not.toHaveBeenCalled()
    } finally { await f.close() }
  }, 10_000)
})

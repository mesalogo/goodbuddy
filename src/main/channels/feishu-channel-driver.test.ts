import { describe, expect, it, vi } from 'vitest'
import { channelInboundTextSchema } from '../../shared/channel-contracts'
import { FeishuChannelDriver, feishuMessageText, type FeishuMessageEvent } from './feishu-channel-driver'

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
}

function fakeFetch() {
  const calls: { url: string; init?: RequestInit }[] = []
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init })
    if (url.endsWith('/tenant_access_token/internal')) return jsonResponse({ code: 0, tenant_access_token: 't-1', expire: 7200 })
    if (url.endsWith('/bot/v3/info')) return jsonResponse({ code: 0, bot: { open_id: 'ou_bot', app_name: 'GoodBuddy' } })
    if (url.includes('/reply')) return jsonResponse({ code: 0, data: { message_id: 'om_reply' } })
    return jsonResponse({ code: 404, msg: 'unexpected' })
  })
  return { fetch, calls }
}

function event(overrides: Partial<NonNullable<FeishuMessageEvent['message']>> = {}, sender = 'ou_user'): FeishuMessageEvent {
  return {
    sender: { sender_id: { open_id: sender }, sender_type: 'user' },
    message: {
      message_id: 'om_1', chat_id: 'oc_1', chat_type: 'p2p', message_type: 'text',
      content: JSON.stringify({ text: '你好' }), create_time: '1760000000000', ...overrides
    }
  }
}

async function startDriver(allowed = ['ou_user']) {
  const { fetch, calls } = fakeFetch()
  let deliver!: (event: FeishuMessageEvent) => void
  const transport = { start: vi.fn(async (on: (e: FeishuMessageEvent) => void) => { deliver = on }), stop: vi.fn() }
  const onStatus = vi.fn()
  const driver = new FeishuChannelDriver({
    appId: 'cli_app', appSecret: 'secret', domain: 'feishu', allowedSenderIds: allowed, fetch, onStatus,
    createTransport: () => transport
  })
  const handler = vi.fn()
  await driver.start(handler)
  return { driver, handler, deliver: (e: FeishuMessageEvent) => { deliver(e) }, transport, calls, onStatus }
}

describe('feishuMessageText', () => {
  it('reads text and post messages and replaces mention placeholders', () => {
    expect(feishuMessageText(event({ content: JSON.stringify({ text: '@_user_1 帮我看看' }),
      mentions: [{ key: '@_user_1', name: 'GoodBuddy', id: { open_id: 'ou_bot' } }] }))).toBe('@GoodBuddy 帮我看看')
    expect(feishuMessageText(event({ message_type: 'post', content: JSON.stringify({
      title: '标题', content: [[{ tag: 'text', text: '第一段' }], [{ tag: 'a', text: '链接', href: 'https://x' }]]
    }) }))).toBe('标题\n第一段\n链接 https://x')
    expect(feishuMessageText(event({ message_type: 'image', content: '{}' }))).toBeUndefined()
    expect(feishuMessageText(event({ content: 'not json' }))).toBeUndefined()
  })
})

describe('FeishuChannelDriver', () => {
  it('verifies the bot, forwards allowed direct messages, and replies to the source message', async () => {
    const { driver, handler, deliver, calls, onStatus } = await startDriver()
    expect(onStatus).toHaveBeenCalledWith({ state: 'running' })
    deliver(event())
    await vi.waitFor(() => expect(handler).toHaveBeenCalledOnce())
    const inbound = handler.mock.calls[0]![0]
    expect(channelInboundTextSchema.parse(inbound)).toMatchObject({
      channel: 'feishu', accountId: 'cli_app', eventId: 'om_1', senderId: 'ou_user',
      conversationId: 'oc_1', conversationType: 'direct', text: '你好', mentioned: true, receivedAt: 1760000000000
    })
    await driver.send({ channel: 'feishu', eventId: 'om_1', conversationId: 'oc_1', recipientId: 'ou_user', status: 'completed', output: '收到' }, new AbortController().signal)
    const reply = calls.find(call => call.url.includes('/reply'))!
    expect(reply.url).toBe('https://open.feishu.cn/open-apis/im/v1/messages/om_1/reply')
    expect(JSON.parse(String(reply.init!.body))).toEqual({ msg_type: 'text', content: JSON.stringify({ text: '收到' }) })
    expect((reply.init!.headers as Record<string, string>).authorization).toBe('Bearer t-1')
    await expect(driver.send({ channel: 'feishu', eventId: 'om_1', conversationId: 'oc_1', recipientId: 'ou_user', status: 'completed' },
      new AbortController().signal)).rejects.toThrow('回复上下文')
  })

  it('passes unknown direct senders on, drops unknown group senders, bots, duplicates and unsupported messages', async () => {
    const { handler, deliver } = await startDriver()
    deliver(event({ message_id: 'om_g', chat_type: 'group' }, 'ou_stranger'))
    deliver(event({ message_id: 'om_s' }, 'ou_stranger'))
    await vi.waitFor(() => expect(handler).toHaveBeenCalledOnce())
    expect(handler.mock.calls[0]![0]).toMatchObject({ eventId: 'om_s', senderId: 'ou_stranger' })
    handler.mockClear()
    deliver({ ...event({ message_id: 'om_2' }), sender: { sender_id: { open_id: 'ou_user' }, sender_type: 'app' } })
    deliver(event({ message_id: 'om_3', message_type: 'image', content: '{}' }))
    deliver(event({ message_id: 'om_4' }))
    deliver(event({ message_id: 'om_4' }))
    await vi.waitFor(() => expect(handler).toHaveBeenCalledOnce())
    expect(handler.mock.calls[0]![0]).toMatchObject({ eventId: 'om_4' })
  })

  it('marks group messages as mentioned only when the bot is mentioned', async () => {
    const { handler, deliver } = await startDriver()
    deliver(event({ message_id: 'g1', chat_type: 'group' }))
    deliver(event({ message_id: 'g2', chat_type: 'group', content: JSON.stringify({ text: '@_user_1 hi' }),
      mentions: [{ key: '@_user_1', name: 'Bot', id: { open_id: 'ou_bot' } }] }))
    await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(2))
    expect(handler.mock.calls.map(call => [call[0].eventId, call[0].conversationType, call[0].mentioned]))
      .toEqual([['g1', 'group', false], ['g2', 'group', true]])
  })

  it('reports invalid credentials without leaking the secret', async () => {
    const fetch = vi.fn(async (url: string) => { void url; return jsonResponse({ code: 10014, msg: 'app secret invalid' }) })
    const driver = new FeishuChannelDriver({ appId: 'cli_app', appSecret: 'top-secret', domain: 'lark', allowedSenderIds: ['ou_user'], fetch,
      createTransport: () => ({ start: vi.fn(), stop: vi.fn() }) })
    await expect(driver.testConnection()).rejects.toThrow('app secret invalid')
    await expect(driver.start(vi.fn())).rejects.toThrow(/飞书通道启动失败/)
    expect(String(fetch.mock.calls[0]![0])).toBe('https://open.larksuite.com/open-apis/auth/v3/tenant_access_token/internal')
    expect(JSON.stringify(fetch.mock.calls.map(call => String(call[0])))).not.toContain('top-secret')
  })
})

import { describe, expect, it, vi } from 'vitest'
import { createServer } from 'node:http'
import { AssistantDatabase } from '../assistant/assistant-database'
import { ChannelService } from './channel-service'
import { SqliteChannelOutbox } from './sqlite-channel-state'
import {
  DingTalkChannelDriver,
  createOfficialDingTalkTransportFactory
} from './dingtalk-channel-driver'
import type {
  DingTalkStreamEnvelope,
  DingTalkStreamTransport,
  DingTalkTransportFactory
} from './dingtalk-driver'

const SESSION_WEBHOOK =
  'https://oapi.dingtalk.com/robot/sendBySession?session=opaque'

class FakeTransport implements DingTalkStreamTransport {
  listener?: (envelope: DingTalkStreamEnvelope) => Promise<void>
  readonly stop = vi.fn(async () => undefined)
  readonly replyText = vi.fn(async () => undefined)

  async start(
    listener: (envelope: DingTalkStreamEnvelope) => Promise<void>
  ): Promise<void> {
    this.listener = listener
  }
}

function envelope(
  messageId = 'event-1',
  conversationType = '2'
): DingTalkStreamEnvelope {
  return {
    headers: { messageId },
    data: JSON.stringify({
      conversationId: 'conversation-1',
      conversationType,
      createAt: 1_800_000_000_000,
      isInAtList: conversationType === '2',
      msgId: 'provider-1',
      msgtype: 'text',
      senderStaffId: 'USER-1',
      sessionWebhook: SESSION_WEBHOOK,
      sessionWebhookExpiredTime: 4_000_000_000_000,
      text: { content: '请总结进展' }
    })
  }
}

describe('DingTalkChannelDriver', () => {
  it('retries an HTTP 200 business failure through the production transport and SQLite outbox', async () => {
    const requests: string[] = []
    const server = createServer(async (request, response) => {
      let body = ''
      for await (const chunk of request) body += String(chunk)
      requests.push(body)
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify(requests.length === 1
        ? { errcode: 130101, errmsg: 'synthetic rate limit' }
        : { errcode: 0, errmsg: 'ok' }))
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address() as { port: number }
    const database = new AssistantDatabase(':memory:')
    database.initialize('C:\\Workspace')
    const outbox = new SqliteChannelOutbox(database)
    let receive!: (message: { headers: { messageId: string }; data: string }) => void
    const driver = new DingTalkChannelDriver({
      clientId: 'client-id', clientSecret: 'synthetic-secret', allowedSenderIds: ['user-1'],
      transportFactory: createOfficialDingTalkTransportFactory({
        clientFactory: async () => ({
          registerCallbackListener: (_topic, listener) => { receive = listener },
          socketCallBackResponse: () => undefined,
          connect: async () => undefined, disconnect: () => undefined
        }),
        fetchImpl: (_input, init) => fetch(`http://127.0.0.1:${address.port}/reply`, init)
      })
    })
    const executor = vi.fn(async () => ({ status: 'completed', output: 'synthetic reply' }))
    const failure = vi.fn()
    const service = new ChannelService(driver, executor, {
      allowedSenderIds: ['user-1'], allowGroupMessages: true, outbox, onDeliveryFailure: failure
    })
    try {
      await service.start()
      receive(envelope())
      await vi.waitFor(() => expect(failure).toHaveBeenCalledOnce())
      expect(failure.mock.calls[0]?.[0]).toMatchObject({ message: '钉钉回复请求失败 (130101)' })
      expect((await outbox.listUndelivered())[0]).toMatchObject({ state: 'failed', attempts: 1 })
      await vi.waitFor(() => expect(requests).toHaveLength(2), { timeout: 3000 })
      await vi.waitFor(async () => expect(await outbox.listUndelivered()).toEqual([]))
      expect(requests[1]).toBe(requests[0])
      expect(executor).toHaveBeenCalledOnce()
    } finally {
      await service.stop()
      database.close()
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    }
  })

  it.each(['', '{}', 'null', 'not JSON', JSON.stringify({ errcode: 0, padding: 'x'.repeat(65_536) })])(
    'rejects invalid or oversized successful HTTP responses (%#)', async (body) => {
      const transport = await createOfficialDingTalkTransportFactory({
        fetchImpl: async () => new Response(body)
      }).create({ clientId: 'synthetic', clientSecret: 'synthetic' })
      await expect(transport.replyText(SESSION_WEBHOOK, 'reply')).rejects.toThrow()
    }
  )

  it('adapts group text and consumes only the issued reply context', async () => {
    const transport = new FakeTransport()
    const factory: DingTalkTransportFactory = {
      create: async () => transport
    }
    const driver = new DingTalkChannelDriver({
      clientId: 'client-id',
      clientSecret: 'client-secret',
      allowedSenderIds: ['user-1'],
      transportFactory: factory
    })
    const messages: unknown[] = []
    await driver.start((message) => {
      messages.push(message)
    })

    await transport.listener?.(envelope())
    expect(messages).toEqual([
      {
        channel: 'dingtalk',
        accountId: 'client-id',
        eventId: 'event-1',
        senderId: 'user-1',
        conversationId: 'conversation-1',
        conversationType: 'group',
        text: '请总结进展',
        mentioned: true,
        receivedAt: 1_800_000_000_000
      }
    ])

    await driver.send(
      {
        channel: 'dingtalk',
        eventId: 'event-1',
        conversationId: 'conversation-1',
        recipientId: 'user-1',
        status: 'completed',
        output: '已完成'
      },
      new AbortController().signal
    )
    expect(transport.replyText).toHaveBeenCalledWith(
      SESSION_WEBHOOK,
      '已完成'
    )
    await expect(
      driver.send(
        {
          channel: 'dingtalk',
          eventId: 'event-1',
          conversationId: 'conversation-1',
          recipientId: 'user-1',
          status: 'completed',
          output: '重复回复'
        },
        new AbortController().signal
      )
    ).rejects.toThrow('上下文无效')
  })

  it('acks official Stream callbacks before asynchronous processing', async () => {
    const order: string[] = []
    let listener:
      | ((message: {
          headers: { messageId: string }
          data: string
        }) => void)
      | undefined
    const client = {
      registerCallbackListener: vi.fn(
        (
          _topic: string,
          value: (message: {
            headers: { messageId: string }
            data: string
          }) => void
        ) => {
          listener = value
        }
      ),
      socketCallBackResponse: vi.fn(() => {
        order.push('ack')
      }),
      connect: vi.fn(async () => undefined),
      disconnect: vi.fn()
    }
    const fetchImpl = vi.fn(async () => Response.json({ errcode: 0, errmsg: 'ok' }))
    const factory = createOfficialDingTalkTransportFactory({
      clientFactory: async (credentials) => {
        expect(credentials).toEqual({
          clientId: 'client-id',
          clientSecret: 'client-secret'
        })
        return client
      },
      fetchImpl
    })
    const transport = await factory.create({
      clientId: 'client-id',
      clientSecret: 'client-secret'
    })
    await transport.start(async () => {
      order.push('processed')
    })

    listener?.({
      headers: { messageId: 'stream-1' },
      data: '{}'
    })
    expect(order).toEqual(['ack'])
    await vi.waitFor(() => {
      expect(order).toEqual(['ack', 'processed'])
    })
    await transport.replyText(SESSION_WEBHOOK, '安全回复')
    expect(fetchImpl).toHaveBeenCalledWith(
      SESSION_WEBHOOK,
      expect.objectContaining({
        method: 'POST',
        redirect: 'error'
      })
    )
    expect(client.registerCallbackListener).toHaveBeenCalledWith(
      '/v1.0/im/bot/messages/get',
      expect.any(Function)
    )
    expect(client.socketCallBackResponse).toHaveBeenCalledWith(
      'stream-1',
      { status: 'SUCCESS' }
    )
  })

  it('rejects unsupported attachments without consuming the reply context', async () => {
    const transport = new FakeTransport()
    const driver = new DingTalkChannelDriver({
      clientId: 'client-id',
      clientSecret: 'client-secret',
      allowedSenderIds: ['user-1'],
      transportFactory: {
        create: async () => transport
      }
    })
    await driver.start(() => undefined)
    await transport.listener?.(envelope('media-event'))

    const message = {
      channel: 'dingtalk' as const,
      eventId: 'media-event',
      conversationId: 'conversation-1',
      recipientId: 'user-1',
      status: 'completed',
      output: '文件已生成',
      attachments: [
        {
          name: 'result.txt',
          mimeType: 'text/plain',
          size: 2,
          kind: 'file' as const,
          dataBase64: 'b2s='
        }
      ]
    }
    await expect(
      driver.send(message, new AbortController().signal)
    ).rejects.toThrow('暂不支持发送附件')
    await driver.send(
      { ...message, attachments: undefined },
      new AbortController().signal
    )
    expect(transport.replyText).toHaveBeenCalledOnce()
    await driver.stop()
  })
})

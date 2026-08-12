import { describe, expect, it, vi } from 'vitest'
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
        workMode: 'ask',
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
    const fetchImpl = vi.fn(async () => new Response(null, { status: 200 }))
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

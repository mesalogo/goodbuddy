import { describe, expect, it, vi } from 'vitest'
import {
  DingTalkDriver,
  type DingTalkInboundTextMessage,
  type DingTalkStreamEnvelope,
  type DingTalkStreamTransport,
  type DingTalkTransportFactory,
  normalizeDingTalkStaffId,
  parseDingTalkStreamMessage
} from './dingtalk-driver'

const NOW = 1_800_000_000_000
const SESSION_WEBHOOK =
  'https://oapi.dingtalk.com/robot/sendBySession?session=opaque'

function envelope(
  overrides: Record<string, unknown> = {},
  messageId = 'stream-message-1'
): DingTalkStreamEnvelope {
  return {
    headers: { messageId },
    data: JSON.stringify({
      conversationId: 'conversation-1',
      conversationType: '1',
      createAt: NOW - 1_000,
      isInAtList: false,
      msgId: 'provider-message-1',
      msgtype: 'text',
      senderNick: '测试用户',
      senderStaffId: ' Staff-Ａ ',
      sessionWebhook: SESSION_WEBHOOK,
      sessionWebhookExpiredTime: NOW + 60_000,
      text: { content: ' 你好，GoodBuddy ' },
      ...overrides
    })
  }
}

class FakeTransport implements DingTalkStreamTransport {
  readonly start = vi.fn(
    async (
      onEnvelope: (
        value: DingTalkStreamEnvelope
      ) => Promise<void>
    ) => {
      this.onEnvelope = onEnvelope
    }
  )

  readonly stop = vi.fn(async () => undefined)
  readonly replyText = vi.fn(async () => undefined)
  private onEnvelope?: (
    value: DingTalkStreamEnvelope
  ) => Promise<void>

  async emit(value: DingTalkStreamEnvelope): Promise<void> {
    if (!this.onEnvelope) {
      throw new Error('transport not started')
    }
    await this.onEnvelope(value)
  }
}

function createDriver(options?: {
  allowedSenderStaffIds?: readonly string[]
  onMessage?: (message: DingTalkInboundTextMessage) => Promise<void>
  maxProcessedMessageIds?: number
  transports?: FakeTransport[]
}) {
  const transports = options?.transports ?? [new FakeTransport()]
  let factoryIndex = 0
  const factory: DingTalkTransportFactory = {
    create: vi.fn(async (credentials) => {
      expect(credentials).toEqual({
        clientId: 'client-id',
        clientSecret: 'client-secret'
      })
      const transport = transports[factoryIndex]
      factoryIndex += 1
      if (!transport) {
        throw new Error('missing fake transport')
      }
      return transport
    })
  }
  const handler =
    options?.onMessage ?? vi.fn(async () => undefined)
  const driver = new DingTalkDriver(
    {
      clientId: 'client-id',
      clientSecret: 'client-secret',
      allowedSenderStaffIds:
        options?.allowedSenderStaffIds ?? ['staff-a'],
      onMessage: handler,
      maxProcessedMessageIds: options?.maxProcessedMessageIds,
      now: () => NOW
    },
    factory
  )

  return { driver, factory, handler, transports }
}

describe('parseDingTalkStreamMessage', () => {
  it('strictly parses text and carries a bounded reply context', () => {
    expect(parseDingTalkStreamMessage(envelope())).toEqual({
      channel: 'dingtalk',
      kind: 'text',
      messageId: 'stream-message-1',
      providerMessageId: 'provider-message-1',
      dedupeKey: 'stream-message-1',
      conversationId: 'conversation-1',
      conversationType: 'direct',
      senderId: 'staff-a',
      senderName: '测试用户',
      text: '你好，GoodBuddy',
      createdAt: NOW - 1_000,
      replyContext: {
        channel: 'dingtalk',
        sessionWebhook: SESSION_WEBHOOK,
        expiresAt: NOW + 60_000
      }
    })
    expect(normalizeDingTalkStaffId(' ＳＴＡＦＦ-A ')).toBe(
      'staff-a'
    )
  })

  it('ignores attachment messages without reading attachment fields', () => {
    expect(
      parseDingTalkStreamMessage(
        envelope({
          msgtype: 'picture',
          text: undefined,
          content: {
            downloadCode: 'must-not-be-used'
          }
        })
      )
    ).toBeNull()
  })

  it('requires an explicit bot mention in group conversations', () => {
    expect(
      parseDingTalkStreamMessage(
        envelope({
          conversationType: '2',
          isInAtList: false
        })
      )
    ).toBeNull()
    expect(
      parseDingTalkStreamMessage(
        envelope({
          conversationType: '2',
          isInAtList: true
        })
      )?.conversationType
    ).toBe('group')
  })

  it.each([
    [
      'non-JSON data',
      { headers: { messageId: 'id' }, data: '{' }
    ],
    [
      'blank stream message ID',
      envelope({}, '  ')
    ],
    [
      'missing senderStaffId',
      envelope({ senderStaffId: undefined })
    ],
    [
      'blank text',
      envelope({ text: { content: ' ' } })
    ],
    [
      'unknown conversation type',
      envelope({ conversationType: '3' })
    ],
    [
      'non-DingTalk reply host',
      envelope({
        sessionWebhook:
          'https://example.com/steal-session-token'
      })
    ],
    [
      'insecure reply URL',
      envelope({
        sessionWebhook:
          'http://oapi.dingtalk.com/robot/sendBySession'
      })
    ]
  ])('rejects malformed payload: %s', (_name, value) => {
    expect(() =>
      parseDingTalkStreamMessage(value as DingTalkStreamEnvelope)
    ).toThrow()
  })
})

describe('DingTalkDriver', () => {
  it('normalizes the sender allowlist and deduplicates message IDs', async () => {
    const { driver, handler, transports } = createDriver({
      allowedSenderStaffIds: [' STAFF-A ']
    })
    await driver.start()

    await transports[0]?.emit(envelope())
    await transports[0]?.emit(
      envelope({ msgId: 'redelivered-provider-id' })
    )
    await transports[0]?.emit(
      envelope(
        {
          senderStaffId: 'not-allowed',
          msgId: 'provider-message-2'
        },
        'stream-message-2'
      )
    )

    expect(handler).toHaveBeenCalledTimes(1)
  })

  it('does not mark a failed delivery as processed', async () => {
    const handler = vi
      .fn<(message: DingTalkInboundTextMessage) => Promise<void>>()
      .mockRejectedValueOnce(new Error('temporary failure'))
      .mockResolvedValue()
    const { driver, transports } = createDriver({ onMessage: handler })
    await driver.start()

    await expect(transports[0]?.emit(envelope())).rejects.toThrow(
      'temporary failure'
    )
    await transports[0]?.emit(envelope())

    expect(handler).toHaveBeenCalledTimes(2)
  })

  it('bounds the in-memory deduplication window', async () => {
    const { driver, handler, transports } = createDriver({
      maxProcessedMessageIds: 2
    })
    await driver.start()

    await transports[0]?.emit(envelope({}, 'stream-message-1'))
    await transports[0]?.emit(envelope({}, 'stream-message-2'))
    await transports[0]?.emit(envelope({}, 'stream-message-3'))
    await transports[0]?.emit(envelope({}, 'stream-message-1'))

    expect(handler).toHaveBeenCalledTimes(4)
  })

  it('replies only through the current unexpired session webhook', async () => {
    const { driver, transports } = createDriver()
    await driver.start()
    const parsed = parseDingTalkStreamMessage(envelope())
    expect(parsed).not.toBeNull()

    await driver.reply(parsed!.replyContext, '回复内容')

    expect(transports[0]?.replyText).toHaveBeenCalledWith(
      SESSION_WEBHOOK,
      '回复内容'
    )
    await expect(
      driver.reply(
        {
          ...parsed!.replyContext,
          expiresAt: NOW
        },
        'too late'
      )
    ).rejects.toThrow('已过期')
    await expect(
      driver.reply(
        {
          ...parsed!.replyContext,
          sessionWebhook: 'https://example.com/not-trusted'
        },
        'unsafe'
      )
    ).rejects.toThrow('不是受信任')
  })

  it('serializes idempotent start and stop calls and can restart', async () => {
    const firstTransport = new FakeTransport()
    const secondTransport = new FakeTransport()
    const { driver, factory } = createDriver({
      transports: [firstTransport, secondTransport]
    })

    await Promise.all([driver.start(), driver.start()])
    expect(factory.create).toHaveBeenCalledTimes(1)
    expect(firstTransport.start).toHaveBeenCalledTimes(1)

    await Promise.all([driver.stop(), driver.stop()])
    expect(firstTransport.stop).toHaveBeenCalledTimes(1)

    await driver.start()
    expect(factory.create).toHaveBeenCalledTimes(2)
    expect(secondTransport.start).toHaveBeenCalledTimes(1)
  })

  it('cleans up a failed transport start and allows retry', async () => {
    const failedTransport = new FakeTransport()
    failedTransport.start.mockRejectedValueOnce(
      new Error('connect failed')
    )
    const retryTransport = new FakeTransport()
    const { driver } = createDriver({
      transports: [failedTransport, retryTransport]
    })

    await expect(driver.start()).rejects.toThrow('connect failed')
    expect(failedTransport.stop).toHaveBeenCalledTimes(1)

    await driver.start()
    expect(retryTransport.start).toHaveBeenCalledTimes(1)
  })
})

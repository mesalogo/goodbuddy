import { describe, expect, it, vi } from 'vitest'
import {
  channelInboundTextSchema,
  type ChannelInboundText,
  type ChannelResultMessage
} from '../../shared/channel-contracts'
import {
  MemoryDedupStore,
  MemoryOutbox,
  type ChannelDriver,
  type ChannelInboundHandler
} from './channel-driver'
import { ChannelService } from './channel-service'

class FakeChannelDriver implements ChannelDriver {
  readonly channel = 'fake'
  readonly sent: ChannelResultMessage[] = []
  acknowledgements = 0
  stopped = false
  private handler?: ChannelInboundHandler

  start(handler: ChannelInboundHandler): void {
    this.handler = handler
  }

  async send(
    message: ChannelResultMessage,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    this.sent.push(structuredClone(message))
  }

  stop(): void {
    this.stopped = true
  }

  async emit(message: unknown): Promise<void> {
    if (!this.handler) {
      throw new Error('Fake driver was not started')
    }
    await this.handler(message, () => {
      this.acknowledgements += 1
    })
  }
}

function inbound(
  overrides: Partial<ChannelInboundText> = {}
): ChannelInboundText {
  return {
    channel: 'fake',
    accountId: 'default',
    eventId: 'event-1',
    senderId: 'allowed-user',
    conversationId: 'conversation-1',
    conversationType: 'direct',
    text: '你好',
    mentioned: false,
    workMode: 'ask',
    ...overrides
  }
}

async function waitForSent(
  driver: FakeChannelDriver,
  count: number
): Promise<void> {
  await vi.waitFor(() => {
    expect(driver.sent).toHaveLength(count)
  })
}

describe('channel contracts', () => {
  it('normalizes text, defaults to ask, and refuses non-ask modes', () => {
    expect(
      channelInboundTextSchema.parse({
        channel: ' fake ',
        eventId: ' event-1 ',
        senderId: ' user-1 ',
        conversationId: ' direct-1 ',
        conversationType: 'direct',
        text: ' 你好 '
      })
    ).toEqual({
      channel: 'fake',
      accountId: 'default',
      eventId: 'event-1',
      senderId: 'user-1',
      conversationId: 'direct-1',
      conversationType: 'direct',
      text: '你好',
      mentioned: false,
      workMode: 'ask'
    })

    expect(
      channelInboundTextSchema.safeParse({
        ...inbound(),
        workMode: 'execute'
      }).success
    ).toBe(false)
    expect(
      channelInboundTextSchema.safeParse({
        ...inbound(),
        workMode: 'plan'
      }).success
    ).toBe(false)
    expect(
      channelInboundTextSchema.parse({
        channel: 'fake',
        eventId: 'media-event',
        senderId: 'user-1',
        conversationId: 'direct-1',
        conversationType: 'direct',
        attachments: [
          {
            name: 'photo.png',
            mimeType: 'image/png',
            size: 4,
            kind: 'image',
            dataBase64: 'iVBORw=='
          }
        ]
      })
    ).toMatchObject({
      text: '',
      attachments: [expect.objectContaining({ name: 'photo.png' })]
    })
    expect(
      channelInboundTextSchema.safeParse({
        ...inbound(),
        platformPayload: { token: 'must not pass through' }
      }).success
    ).toBe(false)
  })
})

describe('ChannelService', () => {
  it('acknowledges after accepting input and denies all senders when no allowlist is configured', async () => {
    const driver = new FakeChannelDriver()
    const executor = vi.fn()
    const service = new ChannelService(driver, executor)
    await service.start()

    await driver.emit(inbound())

    expect(driver.acknowledgements).toBe(1)
    expect(executor).not.toHaveBeenCalled()
    expect(driver.sent).toEqual([])
    await service.stop()
  })

  it('does not acknowledge malformed input', async () => {
    const driver = new FakeChannelDriver()
    const service = new ChannelService(driver, vi.fn())
    await service.start()

    await driver.emit({ channel: 'fake' })

    expect(driver.acknowledgements).toBe(0)
    await service.stop()
  })

  it('executes an allowed request asynchronously with the normalized ask mode', async () => {
    const driver = new FakeChannelDriver()
    let finish: ((value: { status: string; output: string }) => void) | undefined
    const executor = vi.fn(
      () =>
        new Promise<{ status: string; output: string }>((resolve) => {
          finish = resolve
        })
    )
    const service = new ChannelService(driver, executor, {
      allowedSenderIds: ['allowed-user']
    })
    await service.start()

    await driver.emit({
      channel: 'fake',
      eventId: 'event-1',
      senderId: 'allowed-user',
      conversationId: 'conversation-1',
      conversationType: 'direct',
      text: '  帮我分析  '
    })

    expect(driver.acknowledgements).toBe(1)
    await vi.waitFor(() => {
      expect(executor).toHaveBeenCalledOnce()
    })
    expect(executor).toHaveBeenCalledWith(
      expect.objectContaining({
        text: '帮我分析',
        workMode: 'ask'
      }),
      expect.any(AbortSignal),
      expect.any(Function)
    )
    expect(driver.sent).toEqual([])

    finish?.({ status: 'completed', output: '完成' })
    await waitForSent(driver, 1)
    expect(driver.sent[0]).toMatchObject({
      eventId: 'event-1',
      recipientId: 'allowed-user',
      status: 'completed',
      output: '完成'
    })
    await service.stop()
  })

  it('delivers a bounded waiting message before the final result', async () => {
    const driver = new FakeChannelDriver()
    const executor = vi.fn(
      async (
        _message: unknown,
        _signal: AbortSignal,
        reportProgress: (
          result: { status: string; output: string }
        ) => Promise<void>
      ) => {
        await reportProgress({
          status: 'waiting_approval',
          output: '等待电脑端确认'
        })
        return { status: 'completed', output: '执行完成' }
      }
    )
    const service = new ChannelService(driver, executor, {
      allowedSenderIds: ['allowed-user']
    })
    await service.start()
    await driver.emit(
      inbound({
        eventId: 'progress-event',
        senderId: 'allowed-user'
      })
    )

    await waitForSent(driver, 2)
    expect(driver.sent.map((message) => message.status)).toEqual([
      'waiting_approval',
      'completed'
    ])
    await service.stop()
  })

  it('requires both explicit group enablement and an @ mention', async () => {
    const blockedDriver = new FakeChannelDriver()
    const blockedExecutor = vi.fn(async () => ({ status: 'completed' }))
    const blockedService = new ChannelService(
      blockedDriver,
      blockedExecutor,
      {
        allowedSenderIds: ['allowed-user']
      }
    )
    await blockedService.start()
    await blockedDriver.emit(
      inbound({
        conversationType: 'group',
        mentioned: true
      })
    )
    expect(blockedExecutor).not.toHaveBeenCalled()
    await blockedService.stop()

    const driver = new FakeChannelDriver()
    const executor = vi.fn(async () => ({ status: 'completed' }))
    const service = new ChannelService(driver, executor, {
      allowedSenderIds: ['allowed-user'],
      allowGroupMessages: true
    })
    await service.start()
    await driver.emit(
      inbound({
        eventId: 'without-mention',
        conversationType: 'group',
        mentioned: false
      })
    )
    await driver.emit(
      inbound({
        eventId: 'with-mention',
        conversationType: 'group',
        mentioned: true
      })
    )

    await waitForSent(driver, 1)
    expect(executor).toHaveBeenCalledOnce()
    expect(driver.sent[0]?.eventId).toBe('with-mention')
    await service.stop()
  })

  it('deduplicates by channel and event id', async () => {
    const store = new MemoryDedupStore()
    expect(store.claim('first', 'account-1', 'same-id')).toBe(true)
    expect(store.claim('first', 'account-1', 'same-id')).toBe(false)
    expect(store.claim('first', 'account-2', 'same-id')).toBe(true)
    expect(store.claim('second', 'account-1', 'same-id')).toBe(true)

    const driver = new FakeChannelDriver()
    const executor = vi.fn(async () => ({
      status: 'completed',
      output: 'only once'
    }))
    const service = new ChannelService(driver, executor, {
      allowedSenderIds: ['allowed-user'],
      dedupStore: store
    })
    await service.start()
    await driver.emit(inbound())
    await driver.emit(inbound())

    await waitForSent(driver, 1)
    expect(executor).toHaveBeenCalledOnce()
    expect(driver.acknowledgements).toBe(2)
    await service.stop()
  })

  it('does not deduplicate matching event ids from different accounts', async () => {
    const driver = new FakeChannelDriver()
    const executor = vi.fn(async () => ({
      status: 'completed',
      output: 'done'
    }))
    const service = new ChannelService(driver, executor, {
      allowedSenderIds: ['allowed-user']
    })
    await service.start()

    await driver.emit(
      inbound({
        accountId: 'account-1',
        eventId: 'shared-event',
        conversationId: 'shared-conversation'
      })
    )
    await driver.emit(
      inbound({
        accountId: 'account-2',
        eventId: 'shared-event',
        conversationId: 'shared-conversation'
      })
    )

    await waitForSent(driver, 2)
    expect(executor).toHaveBeenCalledTimes(2)
    await service.stop()
  })

  it('serializes requests from the same conversation', async () => {
    const driver = new FakeChannelDriver()
    const finishes: Array<() => void> = []
    const executor = vi.fn(
      (message: ChannelInboundText) =>
        new Promise<{ status: string; output: string }>((resolve) => {
          finishes.push(() =>
            resolve({
              status: 'completed',
              output: message.eventId
            })
          )
        })
    )
    const service = new ChannelService(driver, executor, {
      allowedSenderIds: ['allowed-user'],
      maximumConcurrency: 2
    })
    await service.start()

    await driver.emit(inbound({ eventId: 'first' }))
    await driver.emit(inbound({ eventId: 'second' }))

    expect(executor).toHaveBeenCalledOnce()
    finishes[0]?.()
    await vi.waitFor(() => {
      expect(executor).toHaveBeenCalledTimes(2)
    })
    finishes[1]?.()
    await waitForSent(driver, 2)
    expect(driver.sent.map((message) => message.output)).toEqual([
      'first',
      'second'
    ])
    await service.stop()
  })

  it('keeps failed deliveries in the outbox without sending a second result', async () => {
    class FailingDriver extends FakeChannelDriver {
      attempts = 0

      override async send(
        message: ChannelResultMessage,
        signal: AbortSignal
      ): Promise<void> {
        void message
        void signal
        this.attempts += 1
        throw new Error('offline')
      }
    }

    const driver = new FailingDriver()
    const outbox = new MemoryOutbox()
    const service = new ChannelService(
      driver,
      async () => ({ status: 'completed', output: '完成' }),
      {
        allowedSenderIds: ['allowed-user'],
        outbox
      }
    )
    await service.start()
    await driver.emit(inbound({ eventId: 'delivery-failure' }))

    await vi.waitFor(() => {
      expect(driver.attempts).toBe(1)
    })
    expect(await outbox.listUndelivered()).toEqual([
      expect.objectContaining({
        state: 'failed',
        attempts: 1,
        message: expect.objectContaining({
          eventId: 'delivery-failure',
          status: 'completed'
        })
      })
    ])
    await service.stop()
  })

  it('releases the event claim when no durable result can be queued', async () => {
    const driver = new FakeChannelDriver()
    const store = new MemoryDedupStore()
    const outbox = {
      enqueue: vi.fn(() => {
        throw new Error('database unavailable')
      }),
      markDelivered: vi.fn(),
      markFailed: vi.fn(),
      listUndelivered: vi.fn(() => [])
    }
    const deliveryFailure = vi.fn()
    const executor = vi.fn(async () => ({
      status: 'completed',
      output: '完成'
    }))
    const service = new ChannelService(driver, executor, {
      allowedSenderIds: ['allowed-user'],
      dedupStore: store,
      outbox,
      onDeliveryFailure: deliveryFailure
    })
    await service.start()
    await driver.emit(inbound({ eventId: 'retryable' }))
    await vi.waitFor(() => {
      expect(outbox.enqueue).toHaveBeenCalledOnce()
    })
    await driver.emit(inbound({ eventId: 'retryable' }))
    await vi.waitFor(() => {
      expect(outbox.enqueue).toHaveBeenCalledTimes(2)
    })
    expect(executor).toHaveBeenCalledTimes(2)
    expect(deliveryFailure).toHaveBeenCalled()
    await service.stop()
  })

  it('enforces concurrency and input length limits', async () => {
    const driver = new FakeChannelDriver()
    let finish: (() => void) | undefined
    const executor = vi.fn(
      () =>
        new Promise<{ status: string }>((resolve) => {
          finish = () => resolve({ status: 'completed' })
        })
    )
    const service = new ChannelService(driver, executor, {
      allowedSenderIds: ['allowed-user'],
      maximumConcurrency: 1,
      maximumInputLength: 5
    })
    await service.start()

    await driver.emit(inbound({ eventId: 'active', text: '12345' }))
    await driver.emit(
      inbound({
        eventId: 'busy',
        conversationId: 'conversation-2',
        text: '12345'
      })
    )
    await driver.emit(
      inbound({
        eventId: 'too-long',
        conversationId: 'conversation-3',
        text: '123456'
      })
    )

    await waitForSent(driver, 2)
    expect(driver.sent).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          eventId: 'busy',
          status: 'busy'
        }),
        expect.objectContaining({
          eventId: 'too-long',
          status: 'rejected'
        })
      ])
    )
    finish?.()
    await waitForSent(driver, 3)
    expect(executor).toHaveBeenCalledOnce()
    await service.stop()
  })

  it('bounds output and redacts executor-provided error details', async () => {
    const driver = new FakeChannelDriver()
    const outbox = new MemoryOutbox()
    const executor = vi
      .fn()
      .mockResolvedValueOnce({
        status: 'completed',
        output: 'x'.repeat(100)
      })
      .mockResolvedValueOnce({
        status: 'failed',
        error:
          'Authorization: Bearer top-secret token=abc123 path=C:\\Users\\private\\file.txt'
      })
    const service = new ChannelService(driver, executor, {
      allowedSenderIds: ['allowed-user'],
      maximumResultLength: 32,
      outbox
    })
    await service.start()

    await driver.emit(inbound({ eventId: 'long-output' }))
    await driver.emit(inbound({ eventId: 'secret-error' }))
    await waitForSent(driver, 2)

    expect(driver.sent[0]?.output).toHaveLength(32)
    const serialized = JSON.stringify(driver.sent[1])
    expect(serialized).not.toContain('top-secret')
    expect(serialized).not.toContain('abc123')
    expect(serialized).not.toContain('Users')
    expect(serialized).toContain('已隐藏')
    expect(await outbox.listUndelivered()).toEqual([])
    await service.stop()
  })

  it('delivers media results and removes binary payloads after delivery', async () => {
    const driver = new FakeChannelDriver()
    const outbox = new MemoryOutbox()
    const service = new ChannelService(
      driver,
      async () => ({
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
      }),
      {
        allowedSenderIds: ['allowed-user'],
        outbox
      }
    )
    await service.start()
    await driver.emit(inbound({ eventId: 'media-result' }))
    await waitForSent(driver, 1)

    expect(driver.sent[0]?.attachments).toEqual([
      expect.objectContaining({ name: 'result.txt' })
    ])
    expect(await outbox.listUndelivered()).toEqual([])
    const storedEntries = (
      outbox as unknown as {
        entries: Map<string, { message: ChannelResultMessage }>
      }
    ).entries
    expect(
      [...storedEntries.values()][0]?.message.attachments
    ).toBeUndefined()
    await service.stop()
  })

  it('cancels an active executor and stops the driver', async () => {
    const driver = new FakeChannelDriver()
    let receivedSignal: AbortSignal | undefined
    const executor = vi.fn(
      (_message: ChannelInboundText, signal: AbortSignal) =>
        new Promise<never>(() => {
          receivedSignal = signal
        })
    )
    const service = new ChannelService(driver, executor, {
      allowedSenderIds: ['allowed-user']
    })
    await service.start()
    await driver.emit(inbound({ eventId: 'cancel-me' }))

    expect(service.cancel('cancel-me')).toBe(true)
    await waitForSent(driver, 1)
    expect(receivedSignal?.aborted).toBe(true)
    expect(driver.sent[0]).toMatchObject({
      eventId: 'cancel-me',
      status: 'cancelled',
      error: '请求已取消'
    })

    await service.stop()
    expect(driver.stopped).toBe(true)
    expect(service.cancel('cancel-me')).toBe(false)
    await expect(service.start()).rejects.toThrow('已停止')
  })
})

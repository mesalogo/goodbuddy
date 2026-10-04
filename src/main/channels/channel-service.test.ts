import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  channelInboundTextSchema,
  type ChannelInboundText,
  type ChannelResultMessage
} from '../../shared/channel-contracts'
import {
  MemoryDedupStore,
  MemoryOutbox,
  isPermanentChannelError,
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
  it('normalizes text without a mode and rejects obsolete mode fields', () => {
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
      mentioned: false
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
  afterEach(() => {
    vi.useRealTimers()
  })

  it('stops the active request without launching queued conversation requests', async () => {
    const driver = new FakeChannelDriver()
    const executor = vi.fn((_message: ChannelInboundText, _signal: AbortSignal) => {
      void _message
      void _signal
      return new Promise<never>(() => undefined)
    })
    const service = new ChannelService(driver, executor, {
      allowedSenderIds: ['allowed-user']
    })
    await service.start()
    await driver.emit(inbound())
    await driver.emit(inbound({ eventId: 'queued' }))
    await service.stop()
    expect(executor).toHaveBeenCalledOnce()
    expect(executor.mock.calls[0]?.[1].aborted).toBe(true)
    expect(driver.sent).toEqual([])
  })

  it('does not launch a request whose asynchronous event claim finishes after stop', async () => {
    const driver = new FakeChannelDriver()
    let finishClaim!: (claimed: boolean) => void
    const release = vi.fn()
    const executor = vi.fn()
    const service = new ChannelService(driver, executor, {
      allowedSenderIds: ['allowed-user'],
      dedupStore: {
        claim: () => new Promise<boolean>((resolve) => { finishClaim = resolve }),
        release
      }
    })
    await service.start()
    await driver.emit(inbound())
    const stopped = service.stop()
    finishClaim(true)
    await stopped
    expect(executor).not.toHaveBeenCalled()
    expect(release).toHaveBeenCalledWith('fake', 'default', 'event-1')
  })

  it('updates and validates the whitelist without cancelling active work', async () => {
    const driver = new FakeChannelDriver()
    let finish!: (result: { status: string }) => void
    const executor = vi.fn((_message: ChannelInboundText, _signal: AbortSignal) => {
      void _message
      void _signal
      return new Promise<{ status: string }>((resolve) => { finish = resolve })
    })
    const service = new ChannelService(driver, executor, {
      allowedSenderIds: ['allowed-user']
    })
    await service.start()
    await driver.emit(inbound())
    await driver.emit(inbound({ eventId: 'queued' }))
    service.updateAllowedSenderIds([' new-user '])
    expect(() => service.updateAllowedSenderIds([' '])).toThrow('白名单')
    expect(executor.mock.calls[0]?.[1].aborted).toBe(false)
    finish({ status: 'completed' })
    await waitForSent(driver, 1)
    await driver.emit(inbound({ senderId: 'new-user', eventId: 'new-user' }))
    await vi.waitFor(() => expect(executor).toHaveBeenCalledTimes(2))
    finish({ status: 'completed' })
    await waitForSent(driver, 2)
    expect(driver.sent.map((message) => message.eventId)).toEqual(['event-1', 'new-user'])
    await service.stop()
  })

  it('starts without waiting for a blocked retry, then cancels and awaits it on stop', async () => {
    vi.useFakeTimers()
    const driver = new FakeChannelDriver()
    const outbox = new MemoryOutbox()
    outbox.enqueue({ ...inbound(), status: 'completed', recipientId: 'allowed-user' })
    let finish!: () => void
    let retrySignal!: AbortSignal
    const send = vi.spyOn(driver, 'send').mockImplementation((_message, signal) => {
      retrySignal = signal
      return new Promise<void>((resolve) => { finish = resolve })
    })
    const service = new ChannelService(driver, vi.fn(), { outbox })
    await service.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(send).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(120_000)
    expect(send).toHaveBeenCalledOnce()
    let stopped = false
    const stop = service.stop().then(() => { stopped = true })
    await Promise.resolve()
    expect(retrySignal.aborted).toBe(true)
    expect(stopped).toBe(false)
    finish()
    await stop
    expect(stopped).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('retries failed runtime results on recovery and does not poll an empty outbox', async () => {
    vi.useFakeTimers()
    const driver = new FakeChannelDriver()
    const outbox = new MemoryOutbox()
    const list = vi.spyOn(outbox, 'listUndelivered')
    const send = vi.spyOn(driver, 'send').mockRejectedValueOnce(new Error('offline'))
    const executor = vi.fn(async () => ({ status: 'failed', error: 'runtime failed' }))
    const service = new ChannelService(driver, executor, {
      outbox, allowedSenderIds: ['allowed-user']
    })
    await service.start()
    await vi.advanceTimersByTimeAsync(0)
    const idleReads = list.mock.calls.length
    await vi.advanceTimersByTimeAsync(120_000)
    expect(list).toHaveBeenCalledTimes(idleReads)
    await driver.emit(inbound())
    await vi.advanceTimersByTimeAsync(0)
    expect(send).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(999)
    expect(send).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(1)
    expect(send).toHaveBeenCalledTimes(2)
    expect(driver.sent[0]?.status).toBe('failed')
    expect(outbox.listUndelivered()).toEqual([])
    expect(executor).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
    await service.stop()
  })

  it('backs off and stops retrying after five failed sends', async () => {
    vi.useFakeTimers()
    const driver = new FakeChannelDriver()
    const outbox = new MemoryOutbox()
    const send = vi.spyOn(driver, 'send').mockRejectedValue(new Error('offline'))
    const service = new ChannelService(driver, async () => ({ status: 'completed' }), {
      outbox, allowedSenderIds: ['allowed-user']
    })
    await service.start()
    await vi.advanceTimersByTimeAsync(0)
    await driver.emit(inbound())
    await vi.advanceTimersByTimeAsync(0)
    for (const [index, delay] of [1_000, 2_000, 4_000, 8_000].entries()) {
      await vi.advanceTimersByTimeAsync(delay - 1)
      expect(send).toHaveBeenCalledTimes(index + 1)
      await vi.advanceTimersByTimeAsync(1)
      expect(send).toHaveBeenCalledTimes(index + 2)
    }
    expect(outbox.listUndelivered()[0]).toMatchObject({ state: 'terminal', attempts: 5 })
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(120_000)
    expect(send).toHaveBeenCalledTimes(5)
    await service.stop()
  })

  it('bounds recovery passes and backs off after three consecutive failures', async () => {
    vi.useFakeTimers()
    const driver = new FakeChannelDriver()
    const outbox = new MemoryOutbox()
    for (let index = 0; index < 101; index += 1) {
      outbox.enqueue({
        channel: 'fake', eventId: `saved-${index}`, conversationId: 'conversation-1',
        recipientId: 'allowed-user', status: 'completed'
      })
    }
    const send = vi.spyOn(driver, 'send').mockRejectedValue(new Error('offline'))
    const service = new ChannelService(driver, vi.fn(), { outbox })
    await service.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(send).toHaveBeenCalledTimes(3)
    send.mockResolvedValue(undefined)
    await vi.advanceTimersByTimeAsync(1_999)
    expect(send).toHaveBeenCalledTimes(3)
    await vi.advanceTimersByTimeAsync(1)
    expect(send).toHaveBeenCalledTimes(103)
    expect(outbox.listUndelivered()).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(send).toHaveBeenCalledTimes(104)
    expect(outbox.listUndelivered()).toEqual([])
    expect(vi.getTimerCount()).toBe(0)
    await service.stop()
  })

  it('does not retry an in-flight live delivery and aborts its send on stop', async () => {
    vi.useFakeTimers()
    const driver = new FakeChannelDriver()
    let liveSignal!: AbortSignal
    const send = vi.spyOn(driver, 'send').mockImplementation((message, signal) => {
      if (message.eventId === 'held') {
        liveSignal = signal
        return new Promise<void>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true })
        })
      }
      return Promise.reject(new Error('offline'))
    })
    const service = new ChannelService(driver, async () => ({ status: 'completed' }), {
      allowedSenderIds: ['allowed-user']
    })
    await service.start()
    await vi.advanceTimersByTimeAsync(0)
    await driver.emit(inbound({ eventId: 'held' }))
    await driver.emit(inbound({ eventId: 'failed', conversationId: 'another' }))
    await vi.advanceTimersByTimeAsync(1_000)
    expect(send.mock.calls.filter(([message]) => message.eventId === 'held')).toHaveLength(1)
    expect(send.mock.calls.filter(([message]) => message.eventId === 'failed')).toHaveLength(2)
    await service.stop()
    expect(liveSignal.aborted).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('excludes live deliveries from a retry snapshot even if they finish before the retry reaches them', async () => {
    vi.useFakeTimers()
    const driver = new FakeChannelDriver()
    const outbox = new MemoryOutbox()
    let finishLive!: () => void
    let finishRetry!: () => void
    const send = vi.spyOn(driver, 'send').mockImplementation((message) =>
      new Promise<void>((resolve) => {
        if (message.eventId === 'live') finishLive = resolve
        else finishRetry = resolve
      })
    )
    const service = new ChannelService(driver, async () => ({ status: 'completed' }), {
      outbox, allowedSenderIds: ['allowed-user']
    })
    await service.start()
    await vi.advanceTimersByTimeAsync(0)
    outbox.enqueue({ ...inbound({ eventId: 'retry' }), recipientId: 'allowed-user', status: 'completed' })
    await driver.emit(inbound({ eventId: 'live' }))
    await vi.advanceTimersByTimeAsync(0)
    // A failed delivery schedules the recovery pass through the public path.
    send.mockRejectedValueOnce(new Error('offline'))
    await driver.emit(inbound({ eventId: 'failed', conversationId: 'another' }))
    await vi.advanceTimersByTimeAsync(1_000)
    expect(send.mock.calls.map(([message]) => message.eventId)).toEqual(['live', 'failed', 'retry'])
    finishLive()
    await vi.advanceTimersByTimeAsync(0)
    expect(outbox.listUndelivered().some((entry) => entry.message.eventId === 'live')).toBe(false)
    send.mockResolvedValue(undefined)
    finishRetry()
    await vi.advanceTimersByTimeAsync(0)
    expect(send.mock.calls.filter(([message]) => message.eventId === 'live')).toHaveLength(1)
    expect(outbox.listUndelivered()).toEqual([])
    await service.stop()
  })

  it.each(['field', 'getter'] as const)('terminates permanent %s errors without resending after restart', async (kind) => {
    vi.useFakeTimers()
    const error = kind === 'field'
      ? Object.assign(new Error('forbidden'), { permanent: true })
      : new class extends Error { get permanent(): boolean { return true } }('forbidden')
    expect(isPermanentChannelError(error)).toBe(true)
    expect(isPermanentChannelError(new Error('offline'))).toBe(false)
    const driver = new FakeChannelDriver()
    const outbox = new MemoryOutbox()
    const send = vi.spyOn(driver, 'send').mockRejectedValue(error)
    const service = new ChannelService(driver, async () => ({
      status: 'completed',
      attachments: [{ name: 'result.txt', mimeType: 'text/plain', size: 2, kind: 'file', dataBase64: 'b2s=' }]
    }), { outbox, allowedSenderIds: ['allowed-user'] })
    await service.start()
    await vi.advanceTimersByTimeAsync(0)
    await driver.emit(inbound())
    await vi.advanceTimersByTimeAsync(0)
    expect(outbox.listUndelivered()[0]).toMatchObject({ state: 'terminal', attempts: 1 })
    expect(outbox.listUndelivered()[0]?.message.attachments).toBeUndefined()
    await service.stop()
    const restarted = new ChannelService(driver, vi.fn(), { outbox })
    await restarted.start()
    await vi.advanceTimersByTimeAsync(120_000)
    expect(send).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
    await restarted.stop()
  })

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

  it('executes an allowed request asynchronously without a mode', async () => {
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
        text: '帮我分析'
      }),
      expect.any(AbortSignal),
      expect.any(Function)
    )
    expect(executor).toHaveBeenCalledWith(
      expect.not.objectContaining({ workMode: expect.anything() }),
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

  it('reports terminal outbox entries without retrying them', async () => {
    const driver = new FakeChannelDriver()
    const outbox = new MemoryOutbox()
    const entry = outbox.enqueue({
      channel: driver.channel,
      eventId: 'terminal-delivery',
      conversationId: 'conversation-1',
      recipientId: 'allowed-user',
      status: 'completed',
      output: '完成'
    })
    for (let attempt = 0; attempt < 5; attempt += 1) {
      outbox.markFailed(entry.id)
    }
    const deliveryFailure = vi.fn()
    const service = new ChannelService(
      driver,
      async () => ({ status: 'completed' }),
      {
        allowedSenderIds: ['allowed-user'],
        outbox,
        onDeliveryFailure: deliveryFailure
      }
    )

    await service.start()

    expect(driver.sent).toEqual([])
    await vi.waitFor(() => {
      expect(deliveryFailure).toHaveBeenCalledWith(
        expect.objectContaining({
          message: expect.stringContaining('已达到重试上限')
        })
      )
    })
    expect(await outbox.listUndelivered()).toEqual([
      expect.objectContaining({
        id: entry.id,
        state: 'terminal',
        attempts: 5
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

  it('preserves output and redacts executor-provided error details', async () => {
    const driver = new FakeChannelDriver()
    const outbox = new MemoryOutbox()
    const output = 'x'.repeat(20_000)
    const executor = vi
      .fn()
      .mockResolvedValueOnce({
        status: 'completed',
        output
      })
      .mockResolvedValueOnce({
        status: 'failed',
        error:
          'Authorization: Bearer top-secret token=abc123 path=C:\\Users\\private\\file.txt'
      })
    const service = new ChannelService(driver, executor, {
      allowedSenderIds: ['allowed-user'],
      outbox
    })
    await service.start()

    await driver.emit(inbound({ eventId: 'long-output' }))
    await driver.emit(inbound({ eventId: 'secret-error' }))
    await waitForSent(driver, 2)

    expect(driver.sent[0]?.output).toBe(output)
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

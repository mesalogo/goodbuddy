import { describe, expect, it, vi } from 'vitest'
import {
  WECOM_TEXT_MAX_BYTES,
  WeComDriver,
  WeComDriverError,
  type WeComInboundMessage,
  type WeComSdkTransport,
  type WeComTransportCredentials
} from './wecom-driver'

type MessageListener = (frame: unknown) => void
type ErrorListener = (error: Error) => void
type AuthenticatedListener = () => void

class FakeTransport implements WeComSdkTransport {
  readonly connect = vi.fn(() => {
    if (this.autoAuthenticate) {
      this.emitAuthenticated()
    }
  })
  readonly disconnect = vi.fn(() => undefined)
  readonly replyStream = vi.fn<WeComSdkTransport['replyStream']>(
    async () => ({})
  )

  readonly #messageListeners = new Set<MessageListener>()
  readonly #errorListeners = new Set<ErrorListener>()
  readonly #authenticatedListeners = new Set<AuthenticatedListener>()

  constructor(private readonly autoAuthenticate = true) {}

  on(event: 'message', listener: MessageListener): unknown
  on(event: 'error', listener: ErrorListener): unknown
  on(event: 'authenticated', listener: AuthenticatedListener): unknown
  on(
    event: 'message' | 'error' | 'authenticated',
    listener: MessageListener | ErrorListener | AuthenticatedListener
  ): unknown {
    if (event === 'message') {
      this.#messageListeners.add(listener as MessageListener)
    } else if (event === 'error') {
      this.#errorListeners.add(listener as ErrorListener)
    } else {
      this.#authenticatedListeners.add(
        listener as AuthenticatedListener
      )
    }
    return this
  }

  off(event: 'message', listener: MessageListener): unknown
  off(event: 'error', listener: ErrorListener): unknown
  off(event: 'authenticated', listener: AuthenticatedListener): unknown
  off(
    event: 'message' | 'error' | 'authenticated',
    listener: MessageListener | ErrorListener | AuthenticatedListener
  ): unknown {
    if (event === 'message') {
      this.#messageListeners.delete(listener as MessageListener)
    } else if (event === 'error') {
      this.#errorListeners.delete(listener as ErrorListener)
    } else {
      this.#authenticatedListeners.delete(
        listener as AuthenticatedListener
      )
    }
    return this
  }

  emitAuthenticated(): void {
    for (const listener of this.#authenticatedListeners) {
      listener()
    }
  }

  emitMessage(frame: unknown): void {
    for (const listener of this.#messageListeners) {
      listener(frame)
    }
  }

  emitError(error: Error): void {
    for (const listener of this.#errorListeners) {
      listener(error)
    }
  }

  get listenerCounts(): {
    message: number
    error: number
    authenticated: number
  } {
    return {
      message: this.#messageListeners.size,
      error: this.#errorListeners.size,
      authenticated: this.#authenticatedListeners.size
    }
  }
}

function textFrame(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    cmd: 'aibot_msg_callback',
    headers: { req_id: 'request-1' },
    body: {
      msgid: 'message-1',
      aibotid: 'bot-main',
      chatid: 'group-1',
      chattype: 'group',
      from: { userid: 'user-1' },
      create_time: 1_700_000_000,
      msgtype: 'text',
      text: { content: '@GoodBuddy 请总结今天的进展' },
      quote: {
        msgtype: 'text',
        text: { content: '昨天完成了基础设计' }
      },
      ...overrides
    }
  }
}

function createHarness(): {
  driver: WeComDriver
  transport: FakeTransport
  messages: WeComInboundMessage[]
  rejected: Array<{ reason: string; eventId?: string; messageType?: string }>
  errors: WeComDriverError[]
  credentials: WeComTransportCredentials[]
} {
  const transport = new FakeTransport()
  const messages: WeComInboundMessage[] = []
  const rejected: Array<{
    reason: string
    eventId?: string
    messageType?: string
  }> = []
  const errors: WeComDriverError[] = []
  const credentials: WeComTransportCredentials[] = []
  const driver = new WeComDriver({
    botId: 'bot-main',
    secret: 'main-process-secret',
    transportFactory: (value) => {
      credentials.push(value)
      return transport
    },
    streamIdFactory: () => 'stream-fixed',
    onMessage: (message) => {
      messages.push(message)
    },
    onRejected: (rejection) => {
      rejected.push(rejection)
    },
    onError: (error) => {
      errors.push(error)
    }
  })
  return {
    driver,
    transport,
    messages,
    rejected,
    errors,
    credentials
  }
}

describe('WeComDriver', () => {
  it('normalizes a group text callback with stable identities and reply context', async () => {
    const { driver, transport, messages, credentials } = createHarness()

    await driver.start()
    transport.emitMessage(textFrame())

    expect(credentials).toEqual([
      { botId: 'bot-main', secret: 'main-process-secret' }
    ])
    expect(Object.isFrozen(credentials[0])).toBe(true)
    expect(messages).toEqual([
      {
        channel: 'wecom',
        eventId: 'message-1',
        userId: 'user-1',
        conversationId: 'group-1',
        chatType: 'group',
        mentionedBot: true,
        text: '@GoodBuddy 请总结今天的进展',
        quotedText: '昨天完成了基础设计',
        createdAt: 1_700_000_000,
        replyContext: {
          channel: 'wecom',
          eventId: 'message-1',
          requestId: 'request-1'
        }
      }
    ])
    expect(Object.isFrozen(messages[0])).toBe(true)
    expect(Object.isFrozen(messages[0]?.replyContext)).toBe(true)
    expect(JSON.stringify(messages[0])).not.toContain('main-process-secret')
    expect(JSON.stringify(messages[0])).not.toContain('bot-main')
  })

  it('uses the user id as a single-chat conversation id without mention semantics', async () => {
    const { driver, transport, messages } = createHarness()
    await driver.start()

    transport.emitMessage(
      textFrame({
        chatid: undefined,
        chattype: 'single',
        from: { userid: 'direct-user' },
        text: { content: '你好' },
        quote: undefined,
        create_time: undefined
      })
    )

    expect(messages[0]).toMatchObject({
      userId: 'direct-user',
      conversationId: 'direct-user',
      chatType: 'single',
      mentionedBot: false,
      text: '你好'
    })
    expect(messages[0]).not.toHaveProperty('createdAt')
    expect(messages[0]).not.toHaveProperty('quotedText')
  })

  it('rejects malformed and wrong-bot callbacks at the boundary', async () => {
    const { driver, transport, messages, rejected } = createHarness()
    await driver.start()

    transport.emitMessage(null)
    transport.emitMessage(textFrame({ aibotid: 'another-bot' }))
    transport.emitMessage(textFrame({ from: {} }))
    transport.emitMessage(textFrame({ chattype: 'group', chatid: '' }))
    transport.emitMessage(textFrame({ text: { content: '   ' } }))
    transport.emitMessage(textFrame({ create_time: -1 }))

    expect(messages).toHaveLength(0)
    expect(rejected.map(({ reason }) => reason)).toEqual([
      'invalid_message',
      'bot_mismatch',
      'invalid_message',
      'invalid_message',
      'invalid_message',
      'invalid_message'
    ])
    expect(rejected[1]).toEqual({
      reason: 'bot_mismatch',
      eventId: 'message-1',
      messageType: 'text',
      channel: 'wecom'
    })
  })

  it.each(['file', 'image', 'mixed', 'video', 'voice'])(
    'rejects inbound %s attachments without fetching them',
    async (messageType) => {
      const { driver, transport, messages, rejected } = createHarness()
      await driver.start()

      transport.emitMessage(
        textFrame({
          msgtype: messageType,
          text: undefined,
          [messageType]: {
            url: 'https://example.invalid/private',
            aeskey: 'do-not-use'
          }
        })
      )

      expect(messages).toHaveLength(0)
      expect(rejected).toEqual([
        {
          channel: 'wecom',
          reason: 'attachment_not_supported',
          eventId: 'message-1',
          messageType
        }
      ])
    }
  )

  it('rejects an attachment quote instead of silently dropping it', async () => {
    const { driver, transport, messages, rejected } = createHarness()
    await driver.start()

    transport.emitMessage(
      textFrame({
        quote: {
          msgtype: 'file',
          file: {
            url: 'https://example.invalid/document',
            aeskey: 'do-not-use'
          }
        }
      })
    )

    expect(messages).toHaveLength(0)
    expect(rejected[0]?.reason).toBe('attachment_not_supported')
  })

  it('enforces the official 20480-byte UTF-8 text limit inbound and outbound', async () => {
    const { driver, transport, messages, rejected } = createHarness()
    await driver.start()

    transport.emitMessage(
      textFrame({ text: { content: 'x'.repeat(WECOM_TEXT_MAX_BYTES) } })
    )
    transport.emitMessage(
      textFrame({
        msgid: 'message-too-large',
        text: { content: '你'.repeat(6_827) }
      })
    )

    expect(messages).toHaveLength(1)
    expect(rejected).toContainEqual({
      channel: 'wecom',
      reason: 'text_too_large',
      eventId: 'message-too-large',
      messageType: 'text'
    })

    const context = messages[0]?.replyContext
    if (context === undefined) {
      throw new Error('Expected a reply context')
    }
    await driver.reply(context, {
      text: 'y'.repeat(WECOM_TEXT_MAX_BYTES)
    })
    await expect(
      driver.reply(context, { text: '你'.repeat(6_827) })
    ).rejects.toMatchObject({ code: 'invalid_text' })
    expect(transport.replyStream).toHaveBeenCalledOnce()
  })

  it('uses only an issued reply context and the callback request id', async () => {
    const { driver, transport, messages } = createHarness()
    await driver.start()
    transport.emitMessage(textFrame())

    const context = messages[0]?.replyContext
    if (context === undefined) {
      throw new Error('Expected a reply context')
    }
    await driver.reply(context, { text: '已完成总结' })

    expect(transport.replyStream).toHaveBeenCalledWith(
      { headers: { req_id: 'request-1' } },
      'stream-fixed',
      '已完成总结',
      true
    )
    await expect(
      driver.reply({ ...context }, { text: '伪造上下文' })
    ).rejects.toMatchObject({ code: 'context_expired' })
    await expect(
      driver.reply(context, {
        text: '附件',
        attachments: [{}]
      })
    ).rejects.toMatchObject({ code: 'unsupported_attachment' })
  })

  it('makes concurrent start and repeated stop idempotent and detaches listeners', async () => {
    const { driver, transport, messages } = createHarness()

    await Promise.all([driver.start(), driver.start(), driver.start()])
    expect(transport.connect).toHaveBeenCalledOnce()
    expect(transport.listenerCounts).toEqual({
      message: 1,
      error: 1,
      authenticated: 0
    })
    expect(driver.started).toBe(true)

    await driver.stop()
    await driver.stop()
    expect(transport.disconnect).toHaveBeenCalledOnce()
    expect(transport.listenerCounts).toEqual({
      message: 0,
      error: 0,
      authenticated: 0
    })
    expect(driver.started).toBe(false)

    transport.emitMessage(textFrame())
    expect(messages).toHaveLength(0)
  })

  it('does not finish starting until the SDK authenticates', async () => {
    const transport = new FakeTransport(false)
    const driver = new WeComDriver({
      botId: 'bot-main',
      secret: 'main-process-secret',
      transportFactory: () => transport,
      authenticationTimeoutMs: 100,
      onMessage: () => undefined
    })
    let completed = false

    const start = driver.start().then(() => {
      completed = true
    })
    await Promise.resolve()
    expect(completed).toBe(false)

    transport.emitAuthenticated()
    await start
    expect(completed).toBe(true)
    await driver.stop()
  })

  it('fails startup when the SDK reports an authentication error', async () => {
    const transport = new FakeTransport(false)
    const driver = new WeComDriver({
      botId: 'bot-main',
      secret: 'main-process-secret',
      transportFactory: () => transport,
      authenticationTimeoutMs: 100,
      onMessage: () => undefined
    })

    const start = driver.start()
    await Promise.resolve()
    transport.emitError(new Error('invalid credentials'))

    await expect(start).rejects.toMatchObject({
      code: 'transport_error'
    })
    expect(transport.disconnect).toHaveBeenCalledOnce()
    expect(driver.started).toBe(false)
  })

  it('shares an in-flight authentication failure with later start calls', async () => {
    const transport = new FakeTransport(false)
    const driver = new WeComDriver({
      botId: 'bot-main',
      secret: 'main-process-secret',
      transportFactory: () => transport,
      authenticationTimeoutMs: 100,
      onMessage: () => undefined
    })

    const first = driver.start()
    await vi.waitFor(() =>
      expect(transport.connect).toHaveBeenCalledOnce()
    )
    const second = driver.start()
    transport.emitError(new Error('invalid credentials'))

    const results = await Promise.allSettled([first, second])
    expect(results.map((result) => result.status)).toEqual([
      'rejected',
      'rejected'
    ])
    expect(
      results.map((result) =>
        result.status === 'rejected' ? result.reason : undefined
      )
    ).toEqual([
      expect.objectContaining({ code: 'transport_error' }),
      expect.objectContaining({ code: 'transport_error' })
    ])
    expect(transport.connect).toHaveBeenCalledOnce()
    expect(transport.disconnect).toHaveBeenCalledOnce()
  })

  it('invalidates reply contexts when restarted with another transport', async () => {
    const first = new FakeTransport()
    const second = new FakeTransport()
    const messages: WeComInboundMessage[] = []
    const factory = vi
      .fn<(credentials: WeComTransportCredentials) => WeComSdkTransport>()
      .mockReturnValueOnce(first)
      .mockReturnValueOnce(second)
    const driver = new WeComDriver({
      botId: 'bot-main',
      secret: 'main-process-secret',
      transportFactory: factory,
      onMessage: (message) => {
        messages.push(message)
      }
    })

    await driver.start()
    first.emitMessage(textFrame())
    const oldContext = messages[0]?.replyContext
    if (oldContext === undefined) {
      throw new Error('Expected a reply context')
    }
    await driver.stop()
    await driver.start()

    await expect(
      driver.reply(oldContext, { text: '迟到的回复' })
    ).rejects.toMatchObject({ code: 'context_expired' })
    expect(second.replyStream).not.toHaveBeenCalled()
  })

  it('reports sanitized transport and handler errors', async () => {
    const transport = new FakeTransport()
    const errors: WeComDriverError[] = []
    const driver = new WeComDriver({
      botId: 'bot-main',
      secret: 'main-process-secret',
      transportFactory: () => transport,
      onMessage: async () => {
        throw new Error('main-process-secret')
      },
      onRejected: async () => {
        throw new Error('main-process-secret')
      },
      onError: (error) => {
        errors.push(error)
      }
    })
    await driver.start()

    transport.emitMessage(textFrame())
    transport.emitMessage(textFrame({ aibotid: 'wrong-bot' }))
    transport.emitError(new Error('main-process-secret'))
    await Promise.resolve()

    expect(errors).toHaveLength(3)
    expect(errors.every(({ code }) => code === 'transport_error')).toBe(true)
    expect(JSON.stringify(errors)).not.toContain('main-process-secret')
  })
})

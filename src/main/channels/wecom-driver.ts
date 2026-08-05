import { randomUUID } from 'node:crypto'

export const WECOM_TEXT_MAX_BYTES = 20_480

const IDENTIFIER_MAX_BYTES = 1_024
const WECOM_MESSAGE_EVENT = 'message'
const WECOM_ERROR_EVENT = 'error'

export type WeComChatType = 'single' | 'group'

export interface WeComReplyContext {
  readonly channel: 'wecom'
  readonly eventId: string
  readonly requestId: string
}

export interface WeComInboundMessage {
  readonly channel: 'wecom'
  readonly eventId: string
  readonly userId: string
  readonly conversationId: string
  readonly chatType: WeComChatType
  /**
   * WeCom only delivers group messages to an AI bot when the bot is
   * mentioned. The display-name mention remains in `text`, because the
   * protocol does not provide a reliable display-name boundary to remove.
   */
  readonly mentionedBot: boolean
  readonly text: string
  readonly createdAt?: number
  readonly quotedText?: string
  readonly replyContext: WeComReplyContext
}

export type WeComRejectionReason =
  | 'attachment_not_supported'
  | 'bot_mismatch'
  | 'invalid_message'
  | 'text_too_large'

export interface WeComRejectedMessage {
  readonly channel: 'wecom'
  readonly reason: WeComRejectionReason
  readonly eventId?: string
  readonly messageType?: string
}

export interface WeComOutboundMessage {
  readonly text: string
  readonly attachments?: readonly unknown[]
}

export type WeComDriverErrorCode =
  | 'context_expired'
  | 'invalid_credentials'
  | 'invalid_text'
  | 'not_started'
  | 'transport_error'
  | 'unsupported_attachment'

export class WeComDriverError extends Error {
  readonly code: WeComDriverErrorCode

  constructor(code: WeComDriverErrorCode, message: string) {
    super(message)
    this.name = 'WeComDriverError'
    this.code = code
  }
}

interface WeComFrameHeaders {
  readonly headers: {
    readonly req_id: string
  }
}

export interface WeComSdkTransport {
  on(event: 'message', listener: (frame: unknown) => void): unknown
  on(event: 'error', listener: (error: Error) => void): unknown
  off(event: 'message', listener: (frame: unknown) => void): unknown
  off(event: 'error', listener: (error: Error) => void): unknown
  connect(): unknown
  disconnect(): unknown
  replyStream(
    frame: WeComFrameHeaders,
    streamId: string,
    content: string,
    finish: boolean
  ): Promise<unknown>
}

export interface WeComTransportCredentials {
  readonly botId: string
  readonly secret: string
}

export type WeComTransportFactory = (
  credentials: WeComTransportCredentials
) => WeComSdkTransport | Promise<WeComSdkTransport>

export interface WeComDriverOptions extends WeComTransportCredentials {
  readonly onMessage: (
    message: WeComInboundMessage
  ) => void | Promise<void>
  readonly onRejected?: (
    rejection: WeComRejectedMessage
  ) => void | Promise<void>
  readonly onError?: (error: WeComDriverError) => void
  readonly transportFactory?: WeComTransportFactory
  readonly streamIdFactory?: () => string
}

interface NormalizedWeComPayload {
  readonly eventId: string
  readonly requestId: string
  readonly userId: string
  readonly conversationId: string
  readonly chatType: WeComChatType
  readonly mentionedBot: boolean
  readonly text: string
  readonly createdAt?: number
  readonly quotedText?: string
  readonly frame: WeComFrameHeaders
}

type NormalizationResult =
  | { readonly ok: true; readonly value: NormalizedWeComPayload }
  | { readonly ok: false; readonly rejection: WeComRejectedMessage }

interface ReplyRecord {
  readonly frame: WeComFrameHeaders
  readonly transport: WeComSdkTransport
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function utf8Length(value: string): number {
  return Buffer.byteLength(value, 'utf8')
}

function isBoundedIdentifier(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    utf8Length(value) <= IDENTIFIER_MAX_BYTES
  )
}

function optionalEventId(frame: unknown): string | undefined {
  if (!isRecord(frame) || !isRecord(frame.body)) {
    return undefined
  }
  return isBoundedIdentifier(frame.body.msgid) ? frame.body.msgid : undefined
}

function optionalMessageType(frame: unknown): string | undefined {
  if (!isRecord(frame) || !isRecord(frame.body)) {
    return undefined
  }
  return typeof frame.body.msgtype === 'string'
    ? frame.body.msgtype
    : undefined
}

function reject(
  frame: unknown,
  reason: WeComRejectionReason
): NormalizationResult {
  const eventId = optionalEventId(frame)
  const messageType = optionalMessageType(frame)
  return {
    ok: false,
    rejection: {
      channel: 'wecom',
      reason,
      ...(eventId === undefined ? {} : { eventId }),
      ...(messageType === undefined ? {} : { messageType })
    }
  }
}

function normalizeQuotedText(quote: unknown): string | undefined | null {
  if (quote === undefined) {
    return undefined
  }
  if (!isRecord(quote) || quote.msgtype !== 'text' || !isRecord(quote.text)) {
    return null
  }
  const content = quote.text.content
  if (
    typeof content !== 'string' ||
    content.trim().length === 0 ||
    utf8Length(content) > WECOM_TEXT_MAX_BYTES
  ) {
    return null
  }
  return content
}

function normalizeWeComFrame(
  frame: unknown,
  expectedBotId: string
): NormalizationResult {
  if (
    !isRecord(frame) ||
    frame.cmd !== 'aibot_msg_callback' ||
    !isRecord(frame.headers) ||
    !isRecord(frame.body)
  ) {
    return reject(frame, 'invalid_message')
  }

  const requestId = frame.headers.req_id
  const body = frame.body
  const eventId = body.msgid
  const userId = isRecord(body.from) ? body.from.userid : undefined
  if (
    !isBoundedIdentifier(requestId) ||
    !isBoundedIdentifier(eventId) ||
    !isBoundedIdentifier(body.aibotid) ||
    !isBoundedIdentifier(userId) ||
    (body.chattype !== 'single' && body.chattype !== 'group') ||
    typeof body.msgtype !== 'string'
  ) {
    return reject(frame, 'invalid_message')
  }

  if (body.aibotid !== expectedBotId) {
    return reject(frame, 'bot_mismatch')
  }

  if (body.msgtype !== 'text') {
    const attachmentTypes = new Set([
      'file',
      'image',
      'mixed',
      'video',
      'voice'
    ])
    return reject(
      frame,
      attachmentTypes.has(body.msgtype)
        ? 'attachment_not_supported'
        : 'invalid_message'
    )
  }

  if (!isRecord(body.text) || typeof body.text.content !== 'string') {
    return reject(frame, 'invalid_message')
  }
  const text = body.text.content
  if (text.trim().length === 0) {
    return reject(frame, 'invalid_message')
  }
  if (utf8Length(text) > WECOM_TEXT_MAX_BYTES) {
    return reject(frame, 'text_too_large')
  }

  const chatType = body.chattype
  const conversationId =
    chatType === 'group'
      ? body.chatid
      : userId
  if (!isBoundedIdentifier(conversationId)) {
    return reject(frame, 'invalid_message')
  }

  const createdAt = body.create_time
  if (
    createdAt !== undefined &&
    (typeof createdAt !== 'number' ||
      !Number.isSafeInteger(createdAt) ||
      createdAt < 0)
  ) {
    return reject(frame, 'invalid_message')
  }

  const quotedText = normalizeQuotedText(body.quote)
  if (quotedText === null) {
    return reject(
      frame,
      isRecord(body.quote) && body.quote.msgtype !== 'text'
        ? 'attachment_not_supported'
        : 'invalid_message'
    )
  }

  const normalized: NormalizedWeComPayload = {
    eventId,
    requestId,
    userId,
    conversationId,
    chatType,
    mentionedBot: chatType === 'group',
    text,
    frame: {
      headers: {
        req_id: requestId
      }
    },
    ...(createdAt === undefined ? {} : { createdAt }),
    ...(quotedText === undefined ? {} : { quotedText })
  }
  return { ok: true, value: normalized }
}

/**
 * Default factory for the verified @wecom/aibot-node-sdk v1 transport surface.
 * The dynamic import keeps tests isolated from the SDK and creates the client
 * only in Electron's main process when the driver is started.
 */
export const createOfficialWeComTransport: WeComTransportFactory = async (
  credentials
) => {
  const { WSClient } = await import('@wecom/aibot-node-sdk')
  return new WSClient({
    botId: credentials.botId,
    secret: credentials.secret
  })
}

export class WeComDriver {
  readonly #botId: string
  readonly #secret: string
  readonly #onMessage: WeComDriverOptions['onMessage']
  readonly #onRejected: WeComDriverOptions['onRejected']
  readonly #onError: WeComDriverOptions['onError']
  readonly #transportFactory: WeComTransportFactory
  readonly #streamIdFactory: () => string
  readonly #replyRecords = new WeakMap<WeComReplyContext, ReplyRecord>()

  #transport: WeComSdkTransport | undefined
  #startPromise: Promise<void> | undefined
  #lifecycleVersion = 0

  constructor(options: WeComDriverOptions) {
    if (
      !isBoundedIdentifier(options.botId) ||
      !isBoundedIdentifier(options.secret)
    ) {
      throw new WeComDriverError(
        'invalid_credentials',
        '企业微信机器人凭据无效'
      )
    }
    this.#botId = options.botId
    this.#secret = options.secret
    this.#onMessage = options.onMessage
    this.#onRejected = options.onRejected
    this.#onError = options.onError
    this.#transportFactory =
      options.transportFactory ?? createOfficialWeComTransport
    this.#streamIdFactory =
      options.streamIdFactory ?? (() => `goodbuddy_${randomUUID()}`)
  }

  get started(): boolean {
    return this.#transport !== undefined
  }

  async start(): Promise<void> {
    if (this.#transport !== undefined) {
      return
    }
    if (this.#startPromise !== undefined) {
      return this.#startPromise
    }

    const version = ++this.#lifecycleVersion
    const startPromise = this.#createAndConnect(version)
    this.#startPromise = startPromise
    try {
      await startPromise
    } catch {
      throw new WeComDriverError(
        'transport_error',
        '企业微信长连接启动失败'
      )
    } finally {
      if (this.#startPromise === startPromise) {
        this.#startPromise = undefined
      }
    }
  }

  async stop(): Promise<void> {
    ++this.#lifecycleVersion
    const pendingStart = this.#startPromise
    if (pendingStart !== undefined) {
      await pendingStart.catch(() => undefined)
    }

    const transport = this.#transport
    if (transport === undefined) {
      return
    }
    this.#transport = undefined
    this.#detachTransport(transport)
    try {
      await transport.disconnect()
    } catch {
      throw new WeComDriverError(
        'transport_error',
        '企业微信长连接停止失败'
      )
    }
  }

  async reply(
    context: WeComReplyContext,
    message: WeComOutboundMessage
  ): Promise<void> {
    if (message.attachments !== undefined && message.attachments.length > 0) {
      throw new WeComDriverError(
        'unsupported_attachment',
        '企业微信适配器暂不支持发送附件'
      )
    }
    validateOutboundText(message.text)

    const transport = this.#transport
    if (transport === undefined) {
      throw new WeComDriverError(
        'not_started',
        '企业微信适配器尚未启动'
      )
    }
    const replyRecord = this.#replyRecords.get(context)
    if (replyRecord === undefined || replyRecord.transport !== transport) {
      throw new WeComDriverError(
        'context_expired',
        '企业微信回复上下文无效或已过期'
      )
    }

    const streamId = this.#streamIdFactory()
    if (!isBoundedIdentifier(streamId)) {
      throw new WeComDriverError(
        'invalid_text',
        '企业微信流式消息标识无效'
      )
    }
    try {
      await transport.replyStream(
        replyRecord.frame,
        streamId,
        message.text,
        true
      )
    } catch {
      throw new WeComDriverError(
        'transport_error',
        '企业微信消息回复失败'
      )
    }
  }

  async #createAndConnect(version: number): Promise<void> {
    const credentials = Object.freeze({
      botId: this.#botId,
      secret: this.#secret
    })
    const transport = await this.#transportFactory(credentials)
    if (version !== this.#lifecycleVersion) {
      await transport.disconnect()
      return
    }

    this.#transport = transport
    this.#attachTransport(transport)
    try {
      await transport.connect()
    } catch (error) {
      if (this.#transport === transport) {
        this.#transport = undefined
      }
      this.#detachTransport(transport)
      await Promise.resolve(transport.disconnect()).catch(() => undefined)
      throw error
    }

    if (version !== this.#lifecycleVersion) {
      if (this.#transport === transport) {
        this.#transport = undefined
      }
      this.#detachTransport(transport)
      await transport.disconnect()
    }
  }

  readonly #handleMessage = (frame: unknown): void => {
    const transport = this.#transport
    if (transport === undefined) {
      return
    }
    const result = normalizeWeComFrame(frame, this.#botId)
    if (!result.ok) {
      if (this.#onRejected !== undefined) {
        void Promise.resolve(this.#onRejected(result.rejection)).catch(() => {
          this.#emitTransportError()
        })
      }
      return
    }

    const replyContext = Object.freeze<WeComReplyContext>({
      channel: 'wecom',
      eventId: result.value.eventId,
      requestId: result.value.requestId
    })
    this.#replyRecords.set(replyContext, {
      frame: result.value.frame,
      transport
    })
    const message: WeComInboundMessage = Object.freeze({
      channel: 'wecom',
      eventId: result.value.eventId,
      userId: result.value.userId,
      conversationId: result.value.conversationId,
      chatType: result.value.chatType,
      mentionedBot: result.value.mentionedBot,
      text: result.value.text,
      replyContext,
      ...(result.value.createdAt === undefined
        ? {}
        : { createdAt: result.value.createdAt }),
      ...(result.value.quotedText === undefined
        ? {}
        : { quotedText: result.value.quotedText })
    })

    void Promise.resolve(this.#onMessage(message)).catch(() => {
      this.#emitTransportError()
    })
  }

  readonly #handleTransportError = (): void => {
    this.#emitTransportError()
  }

  #emitTransportError(): void {
    this.#onError?.(
      new WeComDriverError(
        'transport_error',
        '企业微信长连接处理失败'
      )
    )
  }

  #attachTransport(transport: WeComSdkTransport): void {
    transport.on(WECOM_MESSAGE_EVENT, this.#handleMessage)
    transport.on(WECOM_ERROR_EVENT, this.#handleTransportError)
  }

  #detachTransport(transport: WeComSdkTransport): void {
    transport.off(WECOM_MESSAGE_EVENT, this.#handleMessage)
    transport.off(WECOM_ERROR_EVENT, this.#handleTransportError)
  }
}

function validateOutboundText(text: unknown): asserts text is string {
  if (typeof text !== 'string' || text.trim().length === 0) {
    throw new WeComDriverError(
      'invalid_text',
      '企业微信回复文本不能为空'
    )
  }
  if (utf8Length(text) > WECOM_TEXT_MAX_BYTES) {
    throw new WeComDriverError(
      'invalid_text',
      `企业微信回复文本不能超过 ${WECOM_TEXT_MAX_BYTES} 字节`
    )
  }
}

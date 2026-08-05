const DINGTALK_CHANNEL = 'dingtalk' as const
const DIRECT_CONVERSATION = '1'
const GROUP_CONVERSATION = '2'
const MAX_STREAM_DATA_BYTES = 64 * 1024
const DEFAULT_MAX_PROCESSED_MESSAGE_IDS = 1_000
const DINGTALK_SESSION_WEBHOOK_HOST = 'oapi.dingtalk.com'

export interface DingTalkStreamEnvelope {
  headers: {
    messageId: string
  }
  data: string
}

export interface DingTalkReplyContext {
  channel: typeof DINGTALK_CHANNEL
  sessionWebhook: string
  expiresAt: number
}

export interface DingTalkInboundTextMessage {
  channel: typeof DINGTALK_CHANNEL
  kind: 'text'
  messageId: string
  providerMessageId: string
  dedupeKey: string
  conversationId: string
  conversationType: 'direct' | 'group'
  senderId: string
  senderName?: string
  text: string
  createdAt: number
  replyContext: DingTalkReplyContext
}

export type DingTalkMessageHandler = (
  message: DingTalkInboundTextMessage
) => Promise<void> | void

/**
 * The SDK-specific boundary. An implementation may wrap DWClient and an HTTP
 * session-webhook replier; unit tests can provide an entirely local transport.
 */
export interface DingTalkStreamTransport {
  start(
    onEnvelope: (envelope: DingTalkStreamEnvelope) => Promise<void>
  ): Promise<void>
  stop(): Promise<void>
  replyText(sessionWebhook: string, text: string): Promise<void>
}

export interface DingTalkTransportCredentials {
  clientId: string
  clientSecret: string
}

export interface DingTalkTransportFactory {
  create(
    credentials: DingTalkTransportCredentials
  ): DingTalkStreamTransport | Promise<DingTalkStreamTransport>
}

export interface DingTalkDriverOptions {
  clientId: string
  clientSecret: string
  allowedSenderStaffIds: readonly string[]
  onMessage?: DingTalkMessageHandler
  maxProcessedMessageIds?: number
  now?: () => number
}

export function normalizeDingTalkStaffId(staffId: string): string {
  return staffId.normalize('NFKC').trim().toLocaleLowerCase('en-US')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value)
  )
}

function requiredString(
  value: unknown,
  field: string,
  options: { trim?: boolean } = {}
): string {
  if (typeof value !== 'string') {
    throw new Error(`钉钉消息字段 ${field} 必须是字符串`)
  }

  const result = options.trim === false ? value : value.trim()
  if (value.trim().length === 0) {
    throw new Error(`钉钉消息字段 ${field} 不能为空`)
  }
  return result
}

function requiredTimestamp(value: unknown, field: string): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value <= 0
  ) {
    throw new Error(`钉钉消息字段 ${field} 必须是正整数时间戳`)
  }
  return value
}

function parseSessionWebhook(value: unknown): string {
  const sessionWebhook = requiredString(value, 'sessionWebhook')
  let parsed: URL
  try {
    parsed = new URL(sessionWebhook)
  } catch {
    throw new Error('钉钉消息字段 sessionWebhook 无效')
  }

  if (
    parsed.protocol !== 'https:' ||
    parsed.hostname.toLowerCase() !== DINGTALK_SESSION_WEBHOOK_HOST ||
    parsed.pathname !== '/robot/sendBySession' ||
    parsed.username ||
    parsed.password
  ) {
    throw new Error('钉钉消息字段 sessionWebhook 不是受信任的钉钉地址')
  }
  return parsed.toString()
}

function parsePayloadData(data: string): Record<string, unknown> {
  if (Buffer.byteLength(data, 'utf8') > MAX_STREAM_DATA_BYTES) {
    throw new Error('钉钉消息内容过大')
  }

  let payload: unknown
  try {
    payload = JSON.parse(data)
  } catch {
    throw new Error('钉钉消息不是有效的 JSON')
  }
  if (!isRecord(payload)) {
    throw new Error('钉钉消息 payload 必须是对象')
  }
  return payload
}

/**
 * Parses one official robot callback frame. Non-text callbacks and group
 * messages that did not mention the bot are intentionally ignored.
 */
export function parseDingTalkStreamMessage(
  envelope: DingTalkStreamEnvelope
): DingTalkInboundTextMessage | null {
  if (!isRecord(envelope) || !isRecord(envelope.headers)) {
    throw new Error('钉钉 Stream 消息格式无效')
  }

  const messageId = requiredString(
    envelope.headers.messageId,
    'headers.messageId'
  )
  if (typeof envelope.data !== 'string') {
    throw new Error('钉钉消息字段 data 必须是 JSON 字符串')
  }

  const payload = parsePayloadData(envelope.data)
  const messageType = requiredString(payload.msgtype, 'msgtype')
  if (messageType !== 'text') {
    return null
  }

  const conversationType = requiredString(
    payload.conversationType,
    'conversationType'
  )
  if (
    conversationType !== DIRECT_CONVERSATION &&
    conversationType !== GROUP_CONVERSATION
  ) {
    throw new Error('钉钉消息字段 conversationType 无效')
  }
  if (
    conversationType === GROUP_CONVERSATION &&
    payload.isInAtList !== true
  ) {
    return null
  }

  if (!isRecord(payload.text)) {
    throw new Error('钉钉文本消息字段 text 必须是对象')
  }
  const text = requiredString(payload.text.content, 'text.content')
  const rawSenderId = requiredString(
    payload.senderStaffId,
    'senderStaffId'
  )
  const senderId = normalizeDingTalkStaffId(rawSenderId)
  if (!senderId) {
    throw new Error('钉钉消息字段 senderStaffId 不能为空')
  }

  const senderName =
    typeof payload.senderNick === 'string' &&
    payload.senderNick.trim().length > 0
      ? payload.senderNick.trim()
      : undefined
  const replyContext: DingTalkReplyContext = {
    channel: DINGTALK_CHANNEL,
    sessionWebhook: parseSessionWebhook(payload.sessionWebhook),
    expiresAt: requiredTimestamp(
      payload.sessionWebhookExpiredTime,
      'sessionWebhookExpiredTime'
    )
  }

  return {
    channel: DINGTALK_CHANNEL,
    kind: 'text',
    messageId,
    providerMessageId: requiredString(payload.msgId, 'msgId'),
    dedupeKey: messageId,
    conversationId: requiredString(
      payload.conversationId,
      'conversationId'
    ),
    conversationType:
      conversationType === GROUP_CONVERSATION ? 'group' : 'direct',
    senderId,
    ...(senderName ? { senderName } : {}),
    text,
    createdAt: requiredTimestamp(payload.createAt, 'createAt'),
    replyContext
  }
}

export class DingTalkDriver {
  readonly channel = DINGTALK_CHANNEL

  private readonly credentials: DingTalkTransportCredentials
  private readonly allowedSenderIds: ReadonlySet<string>
  private readonly maxProcessedMessageIds: number
  private readonly now: () => number
  private handler?: DingTalkMessageHandler
  private transport?: DingTalkStreamTransport
  private lifecycle: Promise<void> = Promise.resolve()
  private readonly inFlightMessageIds = new Set<string>()
  private readonly processedMessageIds = new Set<string>()

  constructor(
    options: DingTalkDriverOptions,
    private readonly transportFactory: DingTalkTransportFactory
  ) {
    this.credentials = {
      clientId: requiredString(options.clientId, 'clientId'),
      clientSecret: requiredString(options.clientSecret, 'clientSecret')
    }
    this.allowedSenderIds = new Set(
      options.allowedSenderStaffIds
        .map((staffId) =>
          normalizeDingTalkStaffId(
            requiredString(staffId, 'allowedSenderStaffIds')
          )
        )
        .filter((staffId) => staffId.length > 0)
    )
    this.handler = options.onMessage
    this.now = options.now ?? Date.now

    const maximum =
      options.maxProcessedMessageIds ??
      DEFAULT_MAX_PROCESSED_MESSAGE_IDS
    if (!Number.isSafeInteger(maximum) || maximum <= 0) {
      throw new Error('maxProcessedMessageIds 必须是正整数')
    }
    this.maxProcessedMessageIds = maximum
  }

  start(handler?: DingTalkMessageHandler): Promise<void> {
    return this.enqueueLifecycle(async () => {
      if (handler) {
        this.handler = handler
      }
      if (this.transport) {
        return
      }
      if (!this.handler) {
        throw new Error('启动钉钉通道前必须设置消息处理器')
      }

      const transport = await this.transportFactory.create(
        this.credentials
      )
      this.transport = transport
      try {
        await transport.start((envelope) =>
          this.handleEnvelope(envelope)
        )
      } catch (error) {
        this.transport = undefined
        try {
          await transport.stop()
        } catch {
          // Keep the original startup failure; the transport owns cleanup.
        }
        throw error
      }
    })
  }

  stop(): Promise<void> {
    return this.enqueueLifecycle(async () => {
      const transport = this.transport
      if (!transport) {
        return
      }
      await transport.stop()
      this.transport = undefined
    })
  }

  async reply(
    context: DingTalkReplyContext,
    text: string
  ): Promise<void> {
    const transport = this.transport
    if (!transport) {
      throw new Error('钉钉通道尚未启动')
    }
    if (context.channel !== DINGTALK_CHANNEL) {
      throw new Error('回复上下文不属于钉钉通道')
    }
    const sessionWebhook = parseSessionWebhook(
      context.sessionWebhook
    )
    if (
      !Number.isSafeInteger(context.expiresAt) ||
      context.expiresAt <= this.now()
    ) {
      throw new Error('钉钉会话回复地址已过期')
    }

    await transport.replyText(
      sessionWebhook,
      requiredString(text, 'reply.text', { trim: false })
    )
  }

  private enqueueLifecycle(operation: () => Promise<void>): Promise<void> {
    const result = this.lifecycle.then(operation, operation)
    this.lifecycle = result.then(
      () => undefined,
      () => undefined
    )
    return result
  }

  private async handleEnvelope(
    envelope: DingTalkStreamEnvelope
  ): Promise<void> {
    const message = parseDingTalkStreamMessage(envelope)
    if (
      !message ||
      !this.allowedSenderIds.has(message.senderId) ||
      this.processedMessageIds.has(message.dedupeKey) ||
      this.inFlightMessageIds.has(message.dedupeKey)
    ) {
      return
    }

    const handler = this.handler
    if (!handler) {
      throw new Error('钉钉通道没有消息处理器')
    }

    this.inFlightMessageIds.add(message.dedupeKey)
    try {
      await handler(message)
      this.rememberProcessedMessageId(message.dedupeKey)
    } finally {
      this.inFlightMessageIds.delete(message.dedupeKey)
    }
  }

  private rememberProcessedMessageId(messageId: string): void {
    this.processedMessageIds.add(messageId)
    while (
      this.processedMessageIds.size >
      this.maxProcessedMessageIds
    ) {
      const oldestMessageId =
        this.processedMessageIds.values().next().value
      if (typeof oldestMessageId !== 'string') {
        break
      }
      this.processedMessageIds.delete(oldestMessageId)
    }
  }
}

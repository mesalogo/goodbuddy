import type {
  ChannelInboundText,
  ChannelResultMessage
} from '../../shared/channel-contracts'
import type { ChannelRuntimeStatus, FeishuDomain } from '../../shared/channel-settings-contracts'
import { FeishuApi, type FeishuFetch } from '../feishu/feishu-api'
import type { ChannelDriver, ChannelInboundHandler } from './channel-driver'

const MAX_REPLY_CONTEXTS = 1000
const MAX_TEXT_LENGTH = 32_000
const MAX_REPLY_CHARACTERS = 20_000

/** The fields of `im.message.receive_v1` the driver reads. */
export type FeishuMessageEvent = {
  sender?: { sender_id?: { open_id?: string }; sender_type?: string }
  message?: {
    message_id?: string
    chat_id?: string
    chat_type?: string
    message_type?: string
    content?: string
    create_time?: string
    mentions?: { key?: string; id?: { open_id?: string }; name?: string }[]
  }
}

/** Long-connection transport; the default implementation uses the official SDK WSClient. */
export type FeishuEventTransport = {
  start(onMessage: (event: FeishuMessageEvent) => void): Promise<void>
  stop(): void
}

export type FeishuChannelDriverOptions = {
  appId: string
  appSecret: string
  domain: FeishuDomain
  allowedSenderIds: readonly string[]
  onStatus?: (status: ChannelRuntimeStatus) => void
  fetch?: FeishuFetch
  createTransport?: (credentials: { appId: string; appSecret: string; domain: FeishuDomain }, callbacks: {
    onReconnecting: () => void
    onReconnected: () => void
    onError: (error: Error) => void
  }) => FeishuEventTransport | Promise<FeishuEventTransport>
}

type ReplyRecord = { messageId: string; conversationId: string; senderId: string }

async function officialTransport(
  credentials: { appId: string; appSecret: string; domain: FeishuDomain },
  callbacks: { onReconnecting: () => void; onReconnected: () => void; onError: (error: Error) => void }
): Promise<FeishuEventTransport> {
  const lark = await import('@larksuiteoapi/node-sdk')
  let client: InstanceType<typeof lark.WSClient> | undefined
  return {
    async start(onMessage) {
      client = new lark.WSClient({
        appId: credentials.appId,
        appSecret: credentials.appSecret,
        domain: credentials.domain === 'lark' ? lark.Domain.Lark : lark.Domain.Feishu,
        loggerLevel: lark.LoggerLevel.error,
        autoReconnect: true,
        handshakeTimeoutMs: 15_000,
        source: 'goodbuddy',
        onReconnecting: callbacks.onReconnecting,
        onReconnected: callbacks.onReconnected,
        onError: callbacks.onError
      })
      const dispatcher = new lark.EventDispatcher({ loggerLevel: lark.LoggerLevel.error }).register({
        'im.message.receive_v1': async (data: unknown) => { onMessage(data as FeishuMessageEvent) }
      })
      await client.start({ eventDispatcher: dispatcher })
    },
    stop() {
      client?.close({ force: true })
      client = undefined
    }
  }
}

/** Extracts plain text from a text or post message and strips bot mention placeholders. */
export function feishuMessageText(event: FeishuMessageEvent): string | undefined {
  const message = event.message
  if (!message?.content || message.content.length > MAX_TEXT_LENGTH * 4) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(message.content)
  } catch {
    return undefined
  }
  let text: string
  if (message.message_type === 'text' && parsed && typeof parsed === 'object' && typeof (parsed as { text?: unknown }).text === 'string') {
    text = (parsed as { text: string }).text
  } else if (message.message_type === 'post' && parsed && typeof parsed === 'object') {
    const post = parsed as { title?: unknown; content?: unknown }
    const lines: string[] = typeof post.title === 'string' && post.title ? [post.title] : []
    if (Array.isArray(post.content)) {
      for (const paragraph of post.content) {
        if (!Array.isArray(paragraph)) continue
        lines.push(paragraph.map((node: { tag?: string; text?: string; href?: string }) =>
          node?.tag === 'a' ? `${node.text ?? ''} ${node.href ?? ''}`.trim() : typeof node?.text === 'string' ? node.text : '').join(''))
      }
    }
    text = lines.join('\n')
  } else {
    return undefined
  }
  for (const mention of message.mentions ?? []) {
    if (mention.key) text = text.split(mention.key).join(mention.name ? `@${mention.name}` : '')
  }
  text = text.trim()
  return text ? text.slice(0, MAX_TEXT_LENGTH) : undefined
}

/** Feishu/Lark bot channel: receives over the long connection, replies to the triggering message. */
export class FeishuChannelDriver implements ChannelDriver {
  readonly channel = 'feishu'
  private readonly api: FeishuApi
  private readonly replyContexts = new Map<string, ReplyRecord>()
  private readonly seen = new Set<string>()
  private allowedSenderIds: ReadonlySet<string>
  private transport?: FeishuEventTransport
  private handler?: ChannelInboundHandler
  private botOpenId?: string

  constructor(private readonly options: FeishuChannelDriverOptions) {
    this.api = new FeishuApi({ appId: options.appId, appSecret: options.appSecret, domain: options.domain }, options.fetch)
    this.allowedSenderIds = new Set(options.allowedSenderIds)
  }

  updateAllowedSenderIds(ids: readonly string[]): void {
    this.allowedSenderIds = new Set(ids)
  }

  async testConnection(): Promise<{ botId: string }> {
    const bot = await this.api.botInfo()
    return { botId: bot.openId ?? this.options.appId }
  }

  async start(handler: ChannelInboundHandler): Promise<void> {
    this.handler = handler
    try {
      this.botOpenId = (await this.api.botInfo()).openId
      const transport = await (this.options.createTransport ?? officialTransport)(
        { appId: this.options.appId, appSecret: this.options.appSecret, domain: this.options.domain },
        {
          onReconnecting: () => this.options.onStatus?.({ state: 'starting' }),
          onReconnected: () => this.options.onStatus?.({ state: 'running' }),
          onError: (error) => this.options.onStatus?.({ state: 'error', lastError: error.message.slice(0, 300) })
        }
      )
      this.transport = transport
      await transport.start((event) => { void this.handleEvent(event) })
      this.options.onStatus?.({ state: 'running' })
    } catch (error) {
      this.handler = undefined
      this.transport?.stop()
      this.transport = undefined
      throw new Error(`飞书通道启动失败：${error instanceof Error ? error.message : String(error)}`, { cause: error })
    }
  }

  async send(message: ChannelResultMessage, signal: AbortSignal): Promise<void> {
    if (message.attachments?.length) {
      throw Object.assign(new Error('飞书通道暂不支持发送附件'), { permanent: true })
    }
    const record = this.replyContexts.get(message.eventId)
    if (!record || message.channel !== this.channel ||
      message.conversationId !== record.conversationId || message.recipientId !== record.senderId) {
      throw Object.assign(new Error('飞书回复上下文无效或已过期'), { permanent: true })
    }
    const text = (message.output?.trim() || message.error?.trim() || '请求已完成').slice(0, MAX_REPLY_CHARACTERS)
    await this.api.request('POST', `/open-apis/im/v1/messages/${encodeURIComponent(record.messageId)}/reply`, {
      body: { msg_type: 'text', content: JSON.stringify({ text }) },
      signal
    })
    this.replyContexts.delete(message.eventId)
  }

  stop(): void {
    this.handler = undefined
    this.transport?.stop()
    this.transport = undefined
    this.replyContexts.clear()
  }

  private async handleEvent(event: FeishuMessageEvent): Promise<void> {
    const handler = this.handler
    const message = event.message
    const senderId = event.sender?.sender_id?.open_id
    if (!handler || !message?.message_id || !message.chat_id || !senderId) return
    if (event.sender?.sender_type && event.sender.sender_type !== 'user') return
    // Unknown direct senders go on so the service can tell them their open_id.
    if (message.chat_type !== 'p2p' && !this.allowedSenderIds.has(senderId)) return
    if (this.seen.has(message.message_id)) return
    this.seen.add(message.message_id)
    if (this.seen.size > MAX_REPLY_CONTEXTS) this.seen.delete(this.seen.values().next().value!)
    const text = feishuMessageText(event)
    if (!text) return
    const conversationType = message.chat_type === 'p2p' ? 'direct' : 'group'
    const mentioned = conversationType === 'direct' ||
      (message.mentions ?? []).some(mention => mention.id?.open_id && mention.id.open_id === this.botOpenId)
    this.replyContexts.set(message.message_id, { messageId: message.message_id, conversationId: message.chat_id, senderId })
    while (this.replyContexts.size > MAX_REPLY_CONTEXTS) this.replyContexts.delete(this.replyContexts.keys().next().value!)
    const createdAt = Number(message.create_time)
    const inbound: ChannelInboundText = {
      channel: this.channel,
      accountId: this.options.appId,
      eventId: message.message_id,
      senderId,
      conversationId: message.chat_id,
      conversationType,
      text,
      mentioned,
      ...(Number.isInteger(createdAt) && createdAt > 0 ? { receivedAt: createdAt } : {})
    }
    await handler(inbound, () => undefined)
  }
}

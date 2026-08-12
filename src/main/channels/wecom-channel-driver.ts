import type {
  ChannelInboundText,
  ChannelResultMessage
} from '../../shared/channel-contracts'
import type { ChannelDriver, ChannelInboundHandler } from './channel-driver'
import {
  WeComDriver,
  type WeComInboundMessage,
  type WeComReplyContext,
  type WeComTransportFactory
} from './wecom-driver'

const DEFAULT_MAXIMUM_REPLY_CONTEXTS = 1_000

type ReplyRecord = {
  context: WeComReplyContext
  conversationId: string
  senderId: string
}

export type WeComChannelDriverOptions = {
  botId: string
  secret: string
  transportFactory?: WeComTransportFactory
  maximumReplyContexts?: number
}

function maximumReplyContexts(value: number | undefined): number {
  const candidate = value ?? DEFAULT_MAXIMUM_REPLY_CONTEXTS
  if (!Number.isSafeInteger(candidate) || candidate < 1) {
    throw new Error('企业微信回复上下文容量无效')
  }
  return candidate
}

function resultText(message: ChannelResultMessage): string {
  return message.output?.trim() || message.error?.trim() || '请求已完成'
}

export class WeComChannelDriver implements ChannelDriver {
  readonly channel = 'wecom'

  private readonly accountId: string
  private readonly driver: WeComDriver
  private readonly maximumContexts: number
  private readonly replyContexts = new Map<string, ReplyRecord>()
  private handler?: ChannelInboundHandler

  constructor(options: WeComChannelDriverOptions) {
    this.accountId = options.botId
    this.maximumContexts = maximumReplyContexts(
      options.maximumReplyContexts
    )
    this.driver = new WeComDriver({
      botId: options.botId,
      secret: options.secret,
      onMessage: (message) => this.handleMessage(message),
      ...(options.transportFactory
        ? { transportFactory: options.transportFactory }
        : {})
    })
  }

  async start(handler: ChannelInboundHandler): Promise<void> {
    this.handler = handler
    try {
      await this.driver.start()
    } catch {
      this.handler = undefined
      throw new Error('企业微信通道启动失败')
    }
  }

  async send(
    message: ChannelResultMessage,
    signal: AbortSignal
  ): Promise<void> {
    const record = this.replyContexts.get(message.eventId)
    if (
      !record ||
      message.channel !== this.channel ||
      message.conversationId !== record.conversationId ||
      message.recipientId !== record.senderId
    ) {
      throw new Error('企业微信回复上下文无效或已过期')
    }

    try {
      signal.throwIfAborted()
      await this.driver.reply(record.context, {
        text: resultText(message),
        attachments: message.attachments
      })
    } catch {
      throw new Error('企业微信消息回复失败')
    }
    if (!message.attachments?.length) {
      this.replyContexts.delete(message.eventId)
    }
  }

  async stop(): Promise<void> {
    this.handler = undefined
    this.replyContexts.clear()
    try {
      await this.driver.stop()
    } catch {
      throw new Error('企业微信通道停止失败')
    }
  }

  private async handleMessage(message: WeComInboundMessage): Promise<void> {
    const handler = this.handler
    if (!handler) {
      return
    }

    this.replyContexts.set(message.eventId, {
      context: message.replyContext,
      conversationId: message.conversationId,
      senderId: message.userId
    })
    this.enforceContextLimit()
    const inbound: ChannelInboundText = {
      channel: this.channel,
      accountId: this.accountId,
      eventId: message.eventId,
      senderId: message.userId,
      conversationId: message.conversationId,
      conversationType:
        message.chatType === 'group' ? 'group' : 'direct',
      text: message.text,
      mentioned: message.mentionedBot,
      workMode: 'ask',
      ...(message.createdAt === undefined
        ? {}
        : { receivedAt: message.createdAt })
    }
    await handler(inbound, () => undefined)
  }

  private enforceContextLimit(): void {
    while (this.replyContexts.size > this.maximumContexts) {
      const oldest = this.replyContexts.keys().next().value
      if (typeof oldest !== 'string') {
        return
      }
      this.replyContexts.delete(oldest)
    }
  }
}

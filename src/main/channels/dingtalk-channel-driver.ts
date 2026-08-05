import type {
  ChannelInboundText,
  ChannelResultMessage
} from '../../shared/channel-contracts'
import type { ChannelDriver, ChannelInboundHandler } from './channel-driver'
import {
  DingTalkDriver,
  type DingTalkStreamEnvelope,
  type DingTalkStreamTransport,
  type DingTalkInboundTextMessage,
  type DingTalkReplyContext,
  type DingTalkTransportCredentials,
  type DingTalkTransportFactory
} from './dingtalk-driver'

const DEFAULT_MAXIMUM_REPLY_CONTEXTS = 1_000
const MAXIMUM_REPLY_BYTES = 32 * 1024
const MAXIMUM_RESPONSE_BYTES = 64 * 1024
const REPLY_TIMEOUT_MS = 10_000
const DINGTALK_ROBOT_TOPIC = '/v1.0/im/bot/messages/get'

type ReplyRecord = {
  context: DingTalkReplyContext
  conversationId: string
  senderId: string
}

export type DingTalkChannelDriverOptions = {
  clientId: string
  clientSecret: string
  allowedSenderIds: readonly string[]
  transportFactory?: DingTalkTransportFactory
  maximumReplyContexts?: number
}

type DingTalkSdkClient = {
  registerCallbackListener(
    topic: string,
    listener: (message: {
      headers: { messageId: string }
      data: string
    }) => void
  ): unknown
  socketCallBackResponse(messageId: string, result: unknown): void
  connect(): Promise<void>
  disconnect(): void
}

type DingTalkClientFactory = (
  credentials: DingTalkTransportCredentials
) => Promise<DingTalkSdkClient>

type DingTalkFetch = (
  input: string,
  init: RequestInit
) => Promise<Response>

export type OfficialDingTalkTransportOptions = {
  clientFactory?: DingTalkClientFactory
  fetchImpl?: DingTalkFetch
}

async function defaultClientFactory(
  credentials: DingTalkTransportCredentials
): Promise<DingTalkSdkClient> {
  const { DWClient } = await import('dingtalk-stream')
  return new DWClient({
    clientId: credentials.clientId,
    clientSecret: credentials.clientSecret,
    debug: false
  })
}

class OfficialDingTalkTransport implements DingTalkStreamTransport {
  private client?: DingTalkSdkClient

  constructor(
    private readonly credentials: DingTalkTransportCredentials,
    private readonly clientFactory: DingTalkClientFactory,
    private readonly fetchImpl: DingTalkFetch
  ) {}

  async start(
    onEnvelope: (envelope: DingTalkStreamEnvelope) => Promise<void>
  ): Promise<void> {
    const client = await this.clientFactory(this.credentials)
    client.registerCallbackListener(
      DINGTALK_ROBOT_TOPIC,
      (message) => {
        const messageId = message.headers.messageId
        client.socketCallBackResponse(messageId, {
          status: 'SUCCESS'
        })
        void Promise.resolve()
          .then(() =>
            onEnvelope({
              headers: { messageId },
              data: message.data
            })
          )
          .catch(() => undefined)
      }
    )
    this.client = client
    try {
      await client.connect()
    } catch {
      this.client = undefined
      client.disconnect()
      throw new Error('钉钉 Stream 连接失败')
    }
  }

  async stop(): Promise<void> {
    const client = this.client
    this.client = undefined
    client?.disconnect()
  }

  async replyText(sessionWebhook: string, text: string): Promise<void> {
    const body = JSON.stringify({
      msgtype: 'text',
      text: { content: text }
    })
    if (
      Buffer.byteLength(text, 'utf8') > MAXIMUM_REPLY_BYTES ||
      Buffer.byteLength(body, 'utf8') > MAXIMUM_REPLY_BYTES
    ) {
      throw new Error('钉钉回复内容过大')
    }

    const controller = new AbortController()
    const timeout = setTimeout(() => {
      controller.abort(new Error('钉钉回复超时'))
    }, REPLY_TIMEOUT_MS)
    try {
      const response = await this.fetchImpl(sessionWebhook, {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'content-type': 'application/json'
        },
        body,
        redirect: 'error',
        signal: controller.signal
      })
      const responseLength = Number(
        response.headers.get('content-length') ?? '0'
      )
      if (
        !response.ok ||
        !Number.isFinite(responseLength) ||
        responseLength > MAXIMUM_RESPONSE_BYTES
      ) {
        throw new Error('钉钉回复请求失败')
      }
      await response.body?.cancel()
    } catch {
      throw new Error('钉钉回复请求失败')
    } finally {
      clearTimeout(timeout)
    }
  }
}

export function createOfficialDingTalkTransportFactory(
  options: OfficialDingTalkTransportOptions = {}
): DingTalkTransportFactory {
  const clientFactory = options.clientFactory ?? defaultClientFactory
  const fetchImpl =
    options.fetchImpl ??
    ((input, init) => fetch(input, init))
  return {
    create: (credentials) =>
      new OfficialDingTalkTransport(
        credentials,
        clientFactory,
        fetchImpl
      )
  }
}

function maximumReplyContexts(value: number | undefined): number {
  const candidate = value ?? DEFAULT_MAXIMUM_REPLY_CONTEXTS
  if (!Number.isSafeInteger(candidate) || candidate < 1) {
    throw new Error('钉钉回复上下文容量无效')
  }
  return candidate
}

function resultText(message: ChannelResultMessage): string {
  return message.output?.trim() || message.error?.trim() || '请求已完成'
}

export class DingTalkChannelDriver implements ChannelDriver {
  readonly channel = 'dingtalk'

  private readonly driver: DingTalkDriver
  private readonly maximumContexts: number
  private readonly replyContexts = new Map<string, ReplyRecord>()
  private handler?: ChannelInboundHandler

  constructor(options: DingTalkChannelDriverOptions) {
    this.maximumContexts = maximumReplyContexts(
      options.maximumReplyContexts
    )
    this.driver = new DingTalkDriver(
      {
        clientId: options.clientId,
        clientSecret: options.clientSecret,
        allowedSenderStaffIds: options.allowedSenderIds,
        onMessage: (message) => this.handleMessage(message)
      },
      options.transportFactory ??
        createOfficialDingTalkTransportFactory()
    )
  }

  async start(handler: ChannelInboundHandler): Promise<void> {
    this.handler = handler
    try {
      await this.driver.start()
    } catch {
      this.handler = undefined
      throw new Error('钉钉通道启动失败')
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
      throw new Error('钉钉回复上下文无效或已过期')
    }

    try {
      signal.throwIfAborted()
      await this.driver.reply(record.context, resultText(message))
    } catch {
      throw new Error('钉钉消息回复失败')
    } finally {
      this.replyContexts.delete(message.eventId)
    }
  }

  async stop(): Promise<void> {
    this.handler = undefined
    this.replyContexts.clear()
    try {
      await this.driver.stop()
    } catch {
      throw new Error('钉钉通道停止失败')
    }
  }

  private async handleMessage(
    message: DingTalkInboundTextMessage
  ): Promise<void> {
    const handler = this.handler
    if (!handler) {
      return
    }

    this.replyContexts.set(message.dedupeKey, {
      context: message.replyContext,
      conversationId: message.conversationId,
      senderId: message.senderId
    })
    this.enforceContextLimit()
    const inbound: ChannelInboundText = {
      channel: this.channel,
      eventId: message.dedupeKey,
      senderId: message.senderId,
      conversationId: message.conversationId,
      conversationType: message.conversationType,
      text: message.text,
      mentioned: message.conversationType === 'group',
      workMode: 'ask',
      receivedAt: message.createdAt
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

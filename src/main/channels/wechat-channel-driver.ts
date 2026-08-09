import type { ChannelResultMessage } from '../../shared/channel-contracts'
import type {
  ChannelDriver,
  ChannelInboundHandler
} from './channel-driver'
import type { ResolvedChannelSettings } from './channel-settings-store'
import {
  WechatSidecarClient,
  type WechatSidecarLauncher
} from './wechat-sidecar-client'
import type {
  WechatSidecarCredentialMessage,
  WechatSidecarMessage
} from './wechat-sidecar-protocol'

type ResolvedWeixinSettings = Extract<
  ResolvedChannelSettings,
  { channel: 'weixin' }
>

type PendingReply = {
  resolve: () => void
  reject: (error: Error) => void
}

const REPLY_TIMEOUT_MS = 6 * 60_000

export class WechatChannelDriver implements ChannelDriver {
  readonly channel = 'weixin'
  private readonly client: WechatSidecarClient
  private readonly pendingReplies = new Map<string, PendingReply>()
  private handler?: ChannelInboundHandler
  private unsubscribe?: () => void
  private state: 'idle' | 'running' | 'stopped' = 'idle'

  constructor(
    private readonly settings: ResolvedWeixinSettings,
    launcher: WechatSidecarLauncher
  ) {
    this.client = new WechatSidecarClient(launcher)
  }

  async start(handler: ChannelInboundHandler): Promise<void> {
    if (this.state === 'running') {
      return
    }
    if (this.state === 'stopped') {
      throw new Error('微信通道已停止')
    }
    if (
      !this.settings.token ||
      !this.settings.accountId ||
      !this.settings.userId ||
      !this.settings.baseUrl
    ) {
      throw new Error('微信 ClawBot 尚未完成扫码绑定')
    }
    this.handler = handler
    this.unsubscribe = this.client.subscribe((message) => {
      this.handleMessage(message)
    })
    this.client.start()
    const connected = this.waitUntilConnected()
    try {
      this.client.send({
        type: 'start_account',
        accountId: this.settings.accountId,
        userId: this.settings.userId,
        baseUrl: this.settings.baseUrl,
        token: this.settings.token
      })
    } catch (error) {
      void connected.catch(() => undefined)
      this.stop()
      throw error
    }
    await connected
    this.state = 'running'
  }

  send(message: ChannelResultMessage, signal: AbortSignal): Promise<void> {
    if (this.state !== 'running') {
      return Promise.reject(new Error('微信通道尚未连接'))
    }
    if (signal.aborted) {
      return Promise.reject(signal.reason)
    }
    const text =
      message.output?.trim() ||
      message.error?.trim() ||
      `任务状态：${message.status}`
    const replyId = crypto.randomUUID()
    return new Promise<void>((resolve, reject) => {
      const cancelSidecarReply = (): void => {
        try {
          this.client.send({ type: 'cancel_reply', replyId })
        } catch {
          // A dead sidecar no longer has in-flight network work.
        }
      }
      const timeout = setTimeout(() => {
        cancelSidecarReply()
        finish(() => reject(new Error('微信回复超时')))
      }, REPLY_TIMEOUT_MS)
      const finish = (callback: () => void): void => {
        clearTimeout(timeout)
        signal.removeEventListener('abort', abort)
        this.pendingReplies.delete(replyId)
        callback()
      }
      const abort = (): void => {
        cancelSidecarReply()
        finish(() => reject(new Error('微信回复已取消')))
      }
      this.pendingReplies.set(replyId, {
        resolve: () => finish(resolve),
        reject: (error) => finish(() => reject(error))
      })
      signal.addEventListener('abort', abort, { once: true })
      if (signal.aborted) {
        abort()
        return
      }
      try {
        this.client.send({
          type: 'reply',
          replyId,
          inReplyToEventId: message.eventId,
          conversationId: message.conversationId,
          text,
          attachments: message.attachments
        })
      } catch (error) {
        finish(() =>
          reject(error instanceof Error ? error : new Error('微信回复失败'))
        )
      }
    })
  }

  stop(): void {
    if (this.state === 'stopped') {
      return
    }
    this.state = 'stopped'
    this.handler = undefined
    this.unsubscribe?.()
    this.unsubscribe = undefined
    this.rejectPendingReplies(new Error('微信通道已停止'))
    try {
      this.client.send({ type: 'disconnect' })
    } catch {
      // A dead sidecar is already disconnected.
    }
    this.client.stop()
  }

  private waitUntilConnected(): Promise<void> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        remove()
        reject(new Error('微信通道连接超时'))
      }, 15_000)
      const remove = this.client.subscribe((message) => {
        if (message.type === 'status' && message.status === 'connected') {
          clearTimeout(timeout)
          remove()
          resolve()
        } else if (
          message.type === 'status' &&
          message.status === 'failed'
        ) {
          clearTimeout(timeout)
          remove()
          reject(new Error(message.detail ?? '微信通道连接失败'))
        }
      })
    })
  }

  private handleMessage(
    message: WechatSidecarMessage | WechatSidecarCredentialMessage
  ): void {
    if (message.type === 'inbound_message') {
      void Promise.resolve(
        this.handler?.(
          {
            channel: this.channel,
            eventId: message.eventId,
            senderId: message.senderId,
            conversationId: message.conversationId,
            conversationType: 'direct',
            text: message.text,
            attachments: message.attachments,
            attachmentError: message.attachmentError,
            mentioned: false,
            workMode: 'ask',
            receivedAt: Date.now()
          },
          () => undefined
        )
      ).catch(() => undefined)
      return
    }
    if (message.type === 'reply_result') {
      const pending = this.pendingReplies.get(message.replyId)
      if (!pending) {
        return
      }
      if (message.ok) {
        pending.resolve()
      } else {
        pending.reject(new Error(message.error ?? '微信回复失败'))
      }
      return
    }
    if (
      message.type === 'status' &&
      (message.status === 'failed' || message.status === 'stopped')
    ) {
      this.rejectPendingReplies(
        new Error(message.detail ?? '微信 Sidecar 已断开')
      )
      if (message.status === 'stopped') {
        this.state = 'stopped'
      }
    }
  }

  private rejectPendingReplies(error: Error): void {
    for (const pending of [...this.pendingReplies.values()]) {
      pending.reject(error)
    }
    this.pendingReplies.clear()
  }
}

import {
  wechatSidecarCredentialMessageSchema,
  wechatSidecarMessageSchema,
  type WechatSidecarCommand,
  type WechatSidecarCredentialMessage,
  type WechatSidecarMessage,
  type WechatSidecarStartAccountCommand
} from './wechat-sidecar-protocol'

export interface WechatSidecarChild {
  postMessage(message: unknown): void
  kill(): boolean
  on(event: 'message', listener: (message: unknown) => void): this
  once(
    event: 'exit',
    listener: (code: number | null) => void
  ): this
  once(
    event: 'error',
    listener: (error: Error) => void
  ): this
}

export type WechatSidecarLauncher = () => WechatSidecarChild

type SidecarListener = (
  message: WechatSidecarMessage | WechatSidecarCredentialMessage
) => void

export class WechatSidecarClient {
  private child?: WechatSidecarChild
  private readonly listeners = new Set<SidecarListener>()
  private exitError?: Error

  constructor(private readonly launch: WechatSidecarLauncher) {}

  start(): void {
    if (this.child) {
      return
    }
    this.exitError = undefined
    const child = this.launch()
    this.child = child
    child.on('message', (raw) => {
      const payload =
        raw !== null &&
        typeof raw === 'object' &&
        'data' in raw
          ? raw.data
          : raw
      const publicMessage = wechatSidecarMessageSchema.safeParse(payload)
      if (publicMessage.success) {
        this.publish(publicMessage.data)
        return
      }
      const credential =
        wechatSidecarCredentialMessageSchema.safeParse(payload)
      if (credential.success) {
        this.publish(credential.data)
      }
    })
    child.once('error', (error) => {
      this.exitError = new Error(
        `微信 Sidecar 异常：${error.message.slice(0, 300)}`
      )
      this.publish({
        type: 'status',
        status: 'failed',
        detail: this.exitError.message
      })
    })
    child.once('exit', (code) => {
      if (this.child !== child) {
        return
      }
      this.child = undefined
      if (code !== 0 && this.exitError === undefined) {
        this.publish({
          type: 'status',
          status: 'failed',
          detail: `微信 Sidecar 已退出（${code ?? '未知状态'}）`
        })
      }
    })
  }

  send(
    command: WechatSidecarCommand | WechatSidecarStartAccountCommand
  ): void {
    if (!this.child) {
      throw this.exitError ?? new Error('微信 Sidecar 尚未启动')
    }
    this.child.postMessage(command)
  }

  subscribe(listener: SidecarListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  stop(): void {
    const child = this.child
    this.child = undefined
    if (!child) {
      return
    }
    try {
      child.postMessage({ type: 'shutdown' })
    } finally {
      setTimeout(() => child.kill(), 2_000).unref()
    }
  }

  private publish(
    message: WechatSidecarMessage | WechatSidecarCredentialMessage
  ): void {
    for (const listener of this.listeners) {
      listener(message)
    }
  }
}

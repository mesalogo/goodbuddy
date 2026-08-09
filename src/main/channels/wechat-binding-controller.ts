import {
  weixinAccountDisplay,
  type WeixinBindingSnapshot
} from '../../shared/weixin-channel-contracts'
import { ChannelSettingsStore } from './channel-settings-store'
import {
  WechatSidecarClient,
  type WechatSidecarLauncher
} from './wechat-sidecar-client'
import type {
  WechatSidecarCredentialMessage,
  WechatSidecarMessage
} from './wechat-sidecar-protocol'

export class WechatBindingController {
  private client?: WechatSidecarClient
  private unsubscribe?: () => void
  private snapshotValue: WeixinBindingSnapshot = {
    status: 'stopped'
  }
  private credentialSave: Promise<void> = Promise.resolve()
  private generation = 0
  private savingCredential = false

  constructor(
    private readonly store: ChannelSettingsStore,
    private readonly launcher: WechatSidecarLauncher,
    private readonly onChanged: () => Promise<void>,
    private readonly publish: (snapshot: WeixinBindingSnapshot) => void
  ) {}

  snapshot(): WeixinBindingSnapshot {
    return structuredClone(this.snapshotValue)
  }

  start(): WeixinBindingSnapshot {
    if (this.savingCredential) {
      throw new Error('微信绑定凭据正在保存，请稍后重试')
    }
    this.stopClient()
    const generation = ++this.generation
    const client = new WechatSidecarClient(this.launcher)
    this.client = client
    this.unsubscribe = client.subscribe((message) => {
      this.handleMessage(message, generation)
    })
    this.setSnapshot({ status: 'starting' })
    client.start()
    client.send({ type: 'start_login' })
    return this.snapshot()
  }

  submitVerification(code: string): WeixinBindingSnapshot {
    if (!this.client) {
      throw new Error('当前没有进行中的微信绑定')
    }
    this.client.send({ type: 'submit_verification', code })
    this.setSnapshot({ status: 'scanned' })
    return this.snapshot()
  }

  async disconnect(): Promise<WeixinBindingSnapshot> {
    this.generation += 1
    this.stopClient()
    await this.credentialSave
    await this.store.clearWeixinBinding()
    await this.onChanged()
    this.setSnapshot({ status: 'stopped' })
    return this.snapshot()
  }

  stop(): void {
    this.generation += 1
    this.stopClient()
    this.snapshotValue = { status: 'stopped' }
  }

  private handleMessage(
    message: WechatSidecarMessage | WechatSidecarCredentialMessage,
    generation: number
  ): void {
    if (generation !== this.generation) {
      return
    }
    if (message.type === 'credential') {
      this.savingCredential = true
      this.credentialSave = this.credentialSave
        .then(async () => {
          if (generation !== this.generation) {
            return
          }
          this.stopClient()
          await this.store.saveWeixinBinding({
            accountId: message.accountId,
            userId: message.userId,
            baseUrl: message.baseUrl,
            token: message.token
          })
          if (generation !== this.generation) {
            return
          }
          await this.onChanged()
          if (generation !== this.generation) {
            return
          }
          this.setSnapshot({
            status: 'connected',
            accountDisplay: weixinAccountDisplay(message.userId)
          })
        })
        .catch((error: unknown) => {
          if (generation !== this.generation) {
            return
          }
          this.setSnapshot({
            status: 'failed',
            detail:
              error instanceof Error
                ? error.message.slice(0, 512)
                : '微信绑定保存失败'
          })
        })
        .finally(() => {
          this.savingCredential = false
        })
      return
    }
    if (message.type === 'qr') {
      this.setSnapshot({
        status: 'pending',
        qrPayload: message.payload,
        qrExpiresAt: message.expiresAt
      })
      return
    }
    if (message.type === 'verification_required') {
      this.setSnapshot({
        ...this.snapshotValue,
        status: 'verification_required',
        detail: message.prompt
      })
      return
    }
    if (message.type === 'connected') {
      return
    }
    if (message.type === 'status') {
      this.setSnapshot({
        ...this.snapshotValue,
        status: message.status,
        ...(message.detail ? { detail: message.detail } : {})
      })
    }
  }

  private setSnapshot(snapshot: WeixinBindingSnapshot): void {
    this.snapshotValue = structuredClone(snapshot)
    this.publish(this.snapshot())
  }

  private stopClient(): void {
    this.unsubscribe?.()
    this.unsubscribe = undefined
    this.client?.stop()
    this.client = undefined
  }
}

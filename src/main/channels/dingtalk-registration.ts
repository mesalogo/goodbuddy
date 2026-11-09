/**
 * Device Flow used by DingTalk's official connector (MIT):
 * https://github.com/DingTalk-Real-AI/dingtalk-openclaw-connector/blob/88df00ee594072e9941ef3f71da90a37f3291ad3/bin/dingtalk-connector.js
 * The registration source is the upstream service's identifier, not a GoodBuddy app ID.
 */
import { setTimeout as delay } from 'node:timers/promises'
import { z } from 'zod'
import type { ChannelSettingsSnapshot } from '../../shared/channel-settings-contracts'
import type { DingTalkRegistrationSnapshot, DingTalkRegistrationState } from '../../shared/dingtalk-registration-contracts'
import type { ChannelManager } from './channel-manager'

const BASE_URL = 'https://oapi.dingtalk.com/app/registration/'
const credentialsSchema = z.object({ client_id: z.string().trim().min(1).max(256), client_secret: z.string().trim().min(1).max(4096) })
const sessionSchema = z.object({
  device_code: z.string().min(1),
  verification_uri_complete: z.string().url(),
  interval: z.number().positive(),
  expires_in: z.number().positive()
})
export type DingTalkRegisteredApp = { clientId: string; clientSecret: string }
export type DingTalkRegistrationFetch = typeof fetch

async function post(fetchImpl: DingTalkRegistrationFetch, path: string, body: object, signal: AbortSignal): Promise<Record<string, unknown>> {
  const response = await fetchImpl(`${BASE_URL}${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)])
  })
  if (!response.ok) throw new Error(`钉钉扫码接口返回 HTTP ${response.status}`)
  const result = z.record(z.string(), z.unknown()).parse(await response.json())
  if (result.errcode !== 0) throw new Error(`钉钉扫码失败：${String(result.errmsg ?? result.errcode).slice(0, 300)}`)
  return result
}

export async function beginDingTalkRegistration(fetchImpl: DingTalkRegistrationFetch, signal: AbortSignal) {
  const init = await post(fetchImpl, 'init', { source: 'DING_DWS_CLAW' }, signal)
  const nonce = z.string().min(1).parse(init.nonce)
  const session = sessionSchema.parse(await post(fetchImpl, 'begin', { nonce }, signal))
  if (new URL(session.verification_uri_complete).protocol !== 'https:') throw new Error('钉钉返回的扫码地址无效')
  return session
}

export async function pollDingTalkRegistration(
  fetchImpl: DingTalkRegistrationFetch,
  session: z.infer<typeof sessionSchema>,
  signal: AbortSignal
): Promise<DingTalkRegisteredApp> {
  const deadline = Date.now() + session.expires_in * 1000
  while (Date.now() < deadline) {
    await delay(Math.min(session.interval * 1000, deadline - Date.now()), undefined, { signal })
    if (Date.now() >= deadline) break
    const result = await post(fetchImpl, 'poll', { device_code: session.device_code }, signal)
    signal.throwIfAborted()
    const status = String(result.status ?? '').toUpperCase()
    if (status === 'WAITING') continue
    if (status === 'SUCCESS') {
      const parsed = credentialsSchema.safeParse(result)
      if (!parsed.success) throw new Error('扫码成功，但钉钉未返回完整应用凭据，请重试或手动填写')
      return { clientId: parsed.data.client_id, clientSecret: parsed.data.client_secret }
    }
    if (status === 'EXPIRED') break
    throw new Error(status === 'FAIL' ? '已在钉钉中取消或拒绝创建机器人，请重试' : '钉钉返回了无法识别的扫码状态，请重试')
  }
  throw new Error('二维码已过期，请重新扫码')
}

/** One in-memory registration per desktop; no credentials cross the preload bridge. */
export class DingTalkRegistrationController {
  private value: DingTalkRegistrationSnapshot = { revision: 0, state: 'idle' }
  private controller?: AbortController
  private pending?: Promise<void>
  constructor(private readonly options: {
    fetch?: DingTalkRegistrationFetch
    assertWritable(): Promise<void>
    save(app: DingTalkRegisteredApp): Promise<ChannelSettingsSnapshot>
    onChanged(snapshot: DingTalkRegistrationSnapshot): void
  }) {}

  snapshot(): DingTalkRegistrationSnapshot { return this.value }

  private publish(value: DingTalkRegistrationState): DingTalkRegistrationSnapshot {
    this.value = { ...value, revision: this.value.revision + 1 }
    this.options.onChanged(this.value)
    return this.value
  }

  async start(): Promise<DingTalkRegistrationSnapshot> {
    if (this.value.state === 'saving') return this.value
    this.controller?.abort()
    const controller = new AbortController()
    this.controller = controller
    this.publish({ state: 'starting' })
    const fetchImpl = this.options.fetch ?? fetch
    try {
      await this.options.assertWritable()
      controller.signal.throwIfAborted()
      const session = await beginDingTalkRegistration(fetchImpl, controller.signal)
      if (this.controller !== controller || controller.signal.aborted) return this.value
      this.publish({ state: 'waiting', url: session.verification_uri_complete, expiresAt: new Date(Date.now() + session.expires_in * 1000).toISOString() })
      this.pending = this.finish(fetchImpl, session, controller)
    } catch (error) {
      if (this.controller === controller && !controller.signal.aborted) {
        this.controller = undefined
        this.publish({ state: 'failed', message: error instanceof Error ? error.message : String(error) })
      }
    }
    return this.value
  }

  private async finish(fetchImpl: DingTalkRegistrationFetch, session: z.infer<typeof sessionSchema>, controller: AbortController): Promise<void> {
    let secret: string | undefined
    try {
      const app = await pollDingTalkRegistration(fetchImpl, session, controller.signal)
      if (this.controller !== controller || controller.signal.aborted) return
      secret = app.clientSecret
      this.publish({ state: 'saving' })
      const channels = await this.options.save(app)
      this.publish({ state: 'completed', channels })
    } catch (error) {
      if (this.controller !== controller || controller.signal.aborted) return
      const message = error instanceof Error ? error.message : String(error)
      this.publish({ state: 'failed', message: secret ? message.split(secret).join('***') : message })
    } finally {
      if (this.controller === controller) this.controller = undefined
    }
  }

  async cancel(): Promise<DingTalkRegistrationSnapshot> {
    // Once saving begins it must settle before disconnect/replacement can run.
    if (this.value.state === 'saving') { await this.pending; return this.value }
    this.controller?.abort()
    this.controller = undefined
    return this.publish({ state: 'idle' })
  }

  async dispose(): Promise<void> { await this.cancel(); await this.pending }
}

/** Uses the same encrypted settings and start/stop path as manual configuration. */
export function createDingTalkRegistration(
  manager: Pick<ChannelManager, 'getSnapshot' | 'apply'>,
  onChanged: (snapshot: DingTalkRegistrationSnapshot) => void,
  fetchImpl?: DingTalkRegistrationFetch
): DingTalkRegistrationController {
  return new DingTalkRegistrationController({
    fetch: fetchImpl,
    assertWritable: async () => {
      if ((await manager.getSnapshot()).dingtalk.readOnly) throw new Error('钉钉由环境变量配置，不能扫码替换')
    },
    save: async ({ clientId, clientSecret }) => {
      const current = (await manager.getSnapshot()).dingtalk
      return manager.apply({ dingtalk: {
        enabled: true, clientId, secret: { action: 'replace', value: clientSecret },
        allowedSenderIds: current.clientId === clientId ? current.allowedSenderIds : [],
        allowGroupMessages: current.clientId === clientId && current.allowGroupMessages
      } })
    },
    onChanged
  })
}

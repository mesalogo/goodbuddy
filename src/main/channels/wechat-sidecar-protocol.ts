import { z } from 'zod'

export const WECHAT_SIDECAR_MAX_TEXT_LENGTH = 8_000
export const WECHAT_SIDECAR_MAX_QR_PAYLOAD_LENGTH = 4_096
export const WECHAT_SIDECAR_MAX_QR_TTL_MS = 5 * 60 * 1_000

function containsControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0)
    if (code !== undefined && (code <= 31 || code === 127)) {
      return true
    }
  }
  return false
}

function containsWhitespaceOrControlCharacter(value: string): boolean {
  for (const character of value) {
    if (
      character.trim() === '' ||
      containsControlCharacter(character)
    ) {
      return true
    }
  }
  return false
}

const identifierSchema = z
  .string()
  .min(1)
  .max(256)
  .refine((value) => !containsWhitespaceOrControlCharacter(value))

const textSchema = z
  .string()
  .min(1)
  .max(WECHAT_SIDECAR_MAX_TEXT_LENGTH)

export const wechatSidecarStatusSchema = z.enum([
  'stopped',
  'starting',
  'pending',
  'scanned',
  'connected',
  'expired',
  'failed'
])

export type WechatSidecarStatus = z.infer<
  typeof wechatSidecarStatusSchema
>

export const wechatSidecarStatusMessageSchema = z
  .object({
    type: z.literal('status'),
    status: wechatSidecarStatusSchema,
    detail: z.string().min(1).max(512).optional()
  })
  .strict()

export const wechatSidecarQrMessageSchema = z
  .object({
    type: z.literal('qr'),
    qrId: identifierSchema,
    payload: z
      .string()
      .min(1)
      .max(WECHAT_SIDECAR_MAX_QR_PAYLOAD_LENGTH)
      .refine((value) => !containsControlCharacter(value)),
    expiresAt: z.string().datetime({ offset: true })
  })
  .strict()

export const wechatSidecarInboundTextMessageSchema = z
  .object({
    type: z.literal('inbound_text'),
    eventId: identifierSchema,
    senderId: identifierSchema,
    conversationId: identifierSchema,
    text: textSchema
  })
  .strict()

export const wechatSidecarReplyMessageSchema = z
  .object({
    type: z.literal('reply'),
    replyId: identifierSchema,
    inReplyToEventId: identifierSchema,
    conversationId: identifierSchema,
    text: textSchema
  })
  .strict()

export const wechatSidecarMessageSchema = z.discriminatedUnion('type', [
  wechatSidecarStatusMessageSchema,
  wechatSidecarQrMessageSchema,
  wechatSidecarInboundTextMessageSchema,
  wechatSidecarReplyMessageSchema
])

export type WechatSidecarMessage = z.infer<
  typeof wechatSidecarMessageSchema
>
export type WechatSidecarQrMessage = z.infer<
  typeof wechatSidecarQrMessageSchema
>

const allowedTransitions: Readonly<
  Record<WechatSidecarStatus, ReadonlySet<WechatSidecarStatus>>
> = {
  stopped: new Set(['stopped', 'starting']),
  starting: new Set(['starting', 'pending', 'failed', 'stopped']),
  pending: new Set([
    'pending',
    'scanned',
    'expired',
    'failed',
    'stopped'
  ]),
  scanned: new Set([
    'scanned',
    'connected',
    'expired',
    'failed',
    'stopped'
  ]),
  connected: new Set(['connected', 'failed', 'stopped']),
  expired: new Set(['expired', 'starting', 'stopped']),
  failed: new Set(['failed', 'starting', 'stopped'])
}

export type WechatQrStateSnapshot = {
  status: WechatSidecarStatus
  qr?: WechatSidecarQrMessage
}

export class WechatQrStateMachine {
  private status: WechatSidecarStatus = 'stopped'
  private qr?: WechatSidecarQrMessage

  snapshot(): WechatQrStateSnapshot {
    return {
      status: this.status,
      ...(this.qr ? { qr: { ...this.qr } } : {})
    }
  }

  transition(
    next: WechatSidecarStatus,
    now = Date.now()
  ): WechatQrStateSnapshot {
    this.assertTimestamp(now)
    this.expire(now)

    if (!allowedTransitions[this.status].has(next)) {
      throw new Error(
        `非法的微信扫码状态转换：${this.status} -> ${next}`
      )
    }
    if (
      next === 'scanned' &&
      (!this.qr || Date.parse(this.qr.expiresAt) <= now)
    ) {
      throw new Error('无法扫描已过期或不存在的二维码')
    }

    this.status = next
    if (
      next === 'stopped' ||
      next === 'starting' ||
      next === 'connected' ||
      next === 'expired' ||
      next === 'failed'
    ) {
      this.qr = undefined
    }
    return this.snapshot()
  }

  setQr(input: unknown, now = Date.now()): WechatQrStateSnapshot {
    this.assertTimestamp(now)
    this.expire(now)
    if (this.status !== 'pending') {
      throw new Error('仅等待扫码状态可以接收二维码')
    }

    const qr = wechatSidecarQrMessageSchema.parse(input)
    const expiresAt = Date.parse(qr.expiresAt)
    if (
      !Number.isFinite(expiresAt) ||
      expiresAt <= now ||
      expiresAt - now > WECHAT_SIDECAR_MAX_QR_TTL_MS
    ) {
      throw new Error('二维码有效期无效')
    }
    this.qr = qr
    return this.snapshot()
  }

  expire(now = Date.now()): boolean {
    this.assertTimestamp(now)
    if (
      (this.status === 'pending' || this.status === 'scanned') &&
      this.qr &&
      Date.parse(this.qr.expiresAt) <= now
    ) {
      this.status = 'expired'
      this.qr = undefined
      return true
    }
    return false
  }

  private assertTimestamp(now: number): void {
    if (!Number.isFinite(now) || now < 0) {
      throw new Error('状态机时间无效')
    }
  }
}

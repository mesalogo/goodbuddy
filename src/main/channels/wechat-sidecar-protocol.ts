import { z } from 'zod'
import {
  weixinBindingStatusSchema,
  weixinVerificationInputSchema
} from '../../shared/weixin-channel-contracts'

export const WECHAT_SIDECAR_MAX_TEXT_LENGTH = 8_000
export const WECHAT_SIDECAR_MAX_QR_PAYLOAD_LENGTH = 4_096
export const WECHAT_SIDECAR_MAX_QR_TTL_MS = 5 * 60 * 1_000
export const WECHAT_SIDECAR_PROTOCOL_VERSION = 1

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

export const wechatSidecarStatusSchema = weixinBindingStatusSchema

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

export const wechatSidecarVerificationRequiredMessageSchema = z
  .object({
    type: z.literal('verification_required'),
    prompt: z.string().trim().min(1).max(256)
  })
  .strict()

export const wechatSidecarConnectedMessageSchema = z
  .object({
    type: z.literal('connected'),
    accountId: identifierSchema,
    userId: identifierSchema
  })
  .strict()

export const wechatSidecarReplyResultMessageSchema = z
  .object({
    type: z.literal('reply_result'),
    replyId: identifierSchema,
    ok: z.boolean(),
    error: z.string().trim().min(1).max(512).optional()
  })
  .strict()
  .superRefine((result, context) => {
    if (result.ok === (result.error !== undefined)) {
      context.addIssue({
        code: 'custom',
        path: ['error'],
        message: result.ok
          ? '成功回复不能包含错误'
          : '失败回复必须包含错误'
      })
    }
  })

export const wechatSidecarReplyCommandSchema = z
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
  wechatSidecarVerificationRequiredMessageSchema,
  wechatSidecarConnectedMessageSchema,
  wechatSidecarReplyResultMessageSchema
])

export type WechatSidecarMessage = z.infer<
  typeof wechatSidecarMessageSchema
>
export type WechatSidecarQrMessage = z.infer<
  typeof wechatSidecarQrMessageSchema
>

export const wechatSidecarStartLoginCommandSchema = z
  .object({
    type: z.literal('start_login')
  })
  .strict()

export const wechatSidecarSubmitVerificationCommandSchema = z
  .object({
    type: z.literal('submit_verification'),
    code: weixinVerificationInputSchema.shape.code
  })
  .strict()

export const wechatSidecarDisconnectCommandSchema = z
  .object({
    type: z.literal('disconnect')
  })
  .strict()

export const wechatSidecarShutdownCommandSchema = z
  .object({
    type: z.literal('shutdown')
  })
  .strict()

export const wechatSidecarCommandSchema = z.discriminatedUnion('type', [
  wechatSidecarStartLoginCommandSchema,
  wechatSidecarSubmitVerificationCommandSchema,
  wechatSidecarReplyCommandSchema,
  wechatSidecarDisconnectCommandSchema,
  wechatSidecarShutdownCommandSchema
])
export type WechatSidecarCommand = z.infer<
  typeof wechatSidecarCommandSchema
>

export const wechatSidecarStartAccountCommandSchema = z
  .object({
    type: z.literal('start_account'),
    accountId: identifierSchema,
    userId: identifierSchema,
    baseUrl: z.string().url().max(2_048),
    token: z.string().trim().min(1).max(4_096)
  })
  .strict()

export const wechatSidecarCredentialMessageSchema = z
  .object({
    type: z.literal('credential'),
    accountId: identifierSchema,
    userId: identifierSchema,
    baseUrl: z.string().url().max(2_048),
    token: z.string().trim().min(1).max(4_096)
  })
  .strict()

export type WechatSidecarStartAccountCommand = z.infer<
  typeof wechatSidecarStartAccountCommandSchema
>
export type WechatSidecarCredentialMessage = z.infer<
  typeof wechatSidecarCredentialMessageSchema
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
    'verification_required',
    'connected',
    'expired',
    'failed',
    'stopped'
  ]),
  verification_required: new Set([
    'verification_required',
    'scanned',
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
      (this.status === 'pending' ||
        this.status === 'scanned' ||
        this.status === 'verification_required') &&
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

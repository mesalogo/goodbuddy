import { z } from 'zod'

export const weixinBindingStatusSchema = z.enum([
  'stopped',
  'starting',
  'pending',
  'scanned',
  'verification_required',
  'connected',
  'expired',
  'failed'
])
export type WeixinBindingStatus = z.infer<
  typeof weixinBindingStatusSchema
>

export const weixinBindingSnapshotSchema = z
  .object({
    status: weixinBindingStatusSchema,
    qrPayload: z.string().min(1).max(4_096).optional(),
    qrExpiresAt: z.string().datetime({ offset: true }).optional(),
    accountDisplay: z.string().trim().min(1).max(64).optional(),
    detail: z.string().trim().min(1).max(512).optional()
  })
  .strict()
export type WeixinBindingSnapshot = z.infer<
  typeof weixinBindingSnapshotSchema
>

export const weixinVerificationInputSchema = z
  .object({
    code: z
      .string()
      .trim()
      .min(1)
      .max(32)
      .regex(/^[0-9]+$/u, '验证码只能包含数字')
  })
  .strict()
export type WeixinVerificationInput = z.infer<
  typeof weixinVerificationInputSchema
>

export function weixinAccountDisplay(value: string): string | undefined {
  const normalized = value.trim()
  return normalized
    ? `微信用户 ****${normalized.slice(-4)}`
    : undefined
}

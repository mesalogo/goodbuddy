import { z } from 'zod'

export const speechSettingsSchema = z.object({
  provider: z.enum(['local', 'openai-compatible']).default('local'),
  baseUrl: z.string().trim().max(2048).default(''),
  model: z.string().trim().max(256).default(''),
  language: z.string().trim().max(32).default('zh'),
  stream: z.boolean().default(false)
}).strict().superRefine((value, context) => {
  if (value.provider === 'local') return
  try {
    const url = new URL(value.baseUrl)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error()
  } catch {
    context.addIssue({ code: 'custom', path: ['baseUrl'], message: '请输入有效的 HTTP 或 HTTPS API 基础地址' })
  }
  if (!value.model) context.addIssue({ code: 'custom', path: ['model'], message: '请输入语音识别模型名称' })
})

export const speechSettingsUpdateSchema = z.object({
  settings: speechSettingsSchema,
  apiKey: z.discriminatedUnion('action', [
    z.object({ action: z.literal('keep') }).strict(),
    z.object({ action: z.literal('clear') }).strict(),
    z.object({ action: z.literal('replace'), value: z.string().trim().min(1).max(16384) }).strict()
  ])
}).strict()

export const speechTranscriptionProgressSchema = z.object({
  requestId: z.string().uuid(),
  text: z.string().max(20_000)
}).strict()

export type SpeechSettings = z.infer<typeof speechSettingsSchema>
export type SpeechSettingsUpdate = z.infer<typeof speechSettingsUpdateSchema>
export type SpeechSettingsSnapshot = { settings: SpeechSettings; apiKeyConfigured: boolean; secureStorageAvailable: boolean }
export type SpeechTranscriptionProgress = z.infer<typeof speechTranscriptionProgressSchema>

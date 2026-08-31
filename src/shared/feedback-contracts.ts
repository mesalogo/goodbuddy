import { z } from 'zod'

export const feedbackCategories = [
  'bug',
  'feature',
  'experience',
  'other'
] as const

const maximumDescriptionCharacters = 5_000
const maximumDiagnosticsSummaryCharacters = 1_600
const diagnosticsDescriptionSeparatorCharacters = '\n\n'.length

export const feedbackLimits = {
  maximumTitleCharacters: 120,
  minimumDescriptionCharacters: 10,
  maximumDescriptionCharacters,
  maximumDiagnosticsSummaryCharacters,
  maximumDiagnosticRecords: 20,
  maximumDescriptionCharactersWithDiagnostics:
    maximumDescriptionCharacters -
    maximumDiagnosticsSummaryCharacters -
    diagnosticsDescriptionSeparatorCharacters,
  maximumEmailCharacters: 254,
  maximumScreenshotBytes: 5 * 1_024 * 1_024,
  maximumScreenshotDimension: 8_192,
  maximumScreenshotPixels: 32_000_000
} as const

export const feedbackCategorySchema = z.enum(feedbackCategories)
export const feedbackLocaleSchema = z.enum(['zh-CN', 'en-US'])
export const feedbackScreenshotMimeTypeSchema = z.enum([
  'image/png',
  'image/jpeg',
  'image/webp'
])
export const feedbackContactEmailSchema = z
  .email()
  .max(feedbackLimits.maximumEmailCharacters)

export const feedbackScreenshotInputSchema = z
  .object({
    data: z
      .instanceof(Uint8Array)
      .refine(
        (data) =>
          data.byteLength > 0 &&
          data.byteLength <= feedbackLimits.maximumScreenshotBytes,
        'Screenshot is empty or exceeds the size limit'
      ),
    mimeType: feedbackScreenshotMimeTypeSchema
  })
  .strict()

const feedbackContentSchema = z
  .object({
    category: feedbackCategorySchema,
    title: z
      .string()
      .trim()
      .min(1)
      .max(feedbackLimits.maximumTitleCharacters),
    description: z
      .string()
      .trim()
      .min(feedbackLimits.minimumDescriptionCharacters)
      .max(feedbackLimits.maximumDescriptionCharacters),
    contactEmail: feedbackContactEmailSchema.optional()
  })
  .strict()

export const feedbackSubmitInputSchema = feedbackContentSchema
  .extend({
    includeDiagnostics: z.boolean(),
    locale: feedbackLocaleSchema,
    clientRequestId: z.uuid(),
    screenshot: feedbackScreenshotInputSchema.optional()
  })
  .strict()
  .superRefine((input, context) => {
    if (
      input.includeDiagnostics &&
      input.description.length >
        feedbackLimits.maximumDescriptionCharactersWithDiagnostics
    ) {
      context.addIssue({
        code: 'too_big',
        maximum:
          feedbackLimits.maximumDescriptionCharactersWithDiagnostics,
        origin: 'string',
        inclusive: true,
        path: ['description'],
        message:
          'Description exceeds the limit when diagnostics are included'
      })
    }
  })

export const feedbackEnvironmentSchema = z
  .object({
    appVersion: z.string().trim().min(1).max(64),
    platform: z.enum(['windows', 'macos', 'linux', 'unknown']),
    architecture: z.enum(['x64', 'arm64', 'unknown']),
    locale: feedbackLocaleSchema
  })
  .strict()

export const feedbackPublicPayloadSchema = feedbackContentSchema
  .extend({
    schemaVersion: z.literal(1),
    productKey: z.literal('goodbuddy'),
    environment: feedbackEnvironmentSchema,
    installationId: z.uuid(),
    clientRequestId: z.uuid()
  })
  .strict()

export const feedbackPublicResponseSchema = z
  .object({
    reference: z.string().regex(/^[A-Z0-9]{2,12}-\d{6,}$/u),
    duplicate: z.boolean()
  })
  .strict()

export const feedbackSubmissionErrorCodes = [
  'invalid-submission',
  'incompatible-client',
  'unavailable',
  'busy',
  'screenshot-too-large',
  'rate-limited',
  'service-error',
  'network',
  'timeout',
  'invalid-response',
  'diagnostics-unavailable'
] as const

export const feedbackSubmitResultSchema = z.discriminatedUnion('ok', [
  z
    .object({
      ok: z.literal(true),
      reference: feedbackPublicResponseSchema.shape.reference,
      duplicate: z.boolean()
    })
    .strict(),
  z
    .object({
      ok: z.literal(false),
      error: z.enum(feedbackSubmissionErrorCodes)
    })
    .strict()
])

export type FeedbackCategory = z.infer<typeof feedbackCategorySchema>
export type FeedbackScreenshotInput = z.infer<
  typeof feedbackScreenshotInputSchema
>
export type FeedbackSubmitInput = z.infer<
  typeof feedbackSubmitInputSchema
>
export type FeedbackEnvironment = z.infer<
  typeof feedbackEnvironmentSchema
>
export type FeedbackPublicPayload = z.infer<
  typeof feedbackPublicPayloadSchema
>
export type FeedbackPublicResponse = z.infer<
  typeof feedbackPublicResponseSchema
>
export type FeedbackSubmissionErrorCode =
  (typeof feedbackSubmissionErrorCodes)[number]
export type FeedbackSubmitResult = z.infer<
  typeof feedbackSubmitResultSchema
>

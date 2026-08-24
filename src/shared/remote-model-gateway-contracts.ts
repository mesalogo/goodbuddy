import { z } from 'zod'
import { utf8StringSchema } from './agent-protocol/contracts'

export const REMOTE_MODEL_GATEWAY_LIMITS = {
  maximumRequestBodyBytes: 768 * 1024,
  maximumResponseBodyBytes: 768 * 1024,
  maximumHeaderValueBytes: 1_024
} as const

const requestHeaderNameSchema = z.enum([
  'accept',
  'content-type'
])

const requestHeaderValueSchema = utf8StringSchema(
  REMOTE_MODEL_GATEWAY_LIMITS.maximumHeaderValueBytes,
  {
    minimumBytes: 1,
    label: 'Remote model request header value'
  }
).refine(
  (value) => !/[\r\n]/u.test(value),
  'Header values cannot contain line breaks'
)

const responseHeaderNameSchema = z.enum([
  'content-type',
  'openai-request-id',
  'request-id',
  'x-request-id'
])

function boundedCanonicalBase64Schema(maximumBytes: number) {
  return z
    .string()
    .max(Math.ceil(maximumBytes / 3) * 4)
    .regex(
      /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u,
      'Body must use canonical base64'
    )
    .refine(
      (value) => Buffer.byteLength(value, 'base64') <= maximumBytes,
      `Decoded body exceeds ${maximumBytes} bytes`
    )
    .refine(
      (value) =>
        Buffer.from(value, 'base64').toString('base64') === value,
      'Body must use canonical base64'
    )
}

export const remoteModelApiPathSchema = z.enum([
  '/v1/messages',
  '/chat/completions',
  '/v1/chat/completions',
  '/responses',
  '/v1/responses'
])
export type RemoteModelApiPath = z.infer<typeof remoteModelApiPathSchema>

export const remoteModelRequestHeadersSchema = z
  .partialRecord(requestHeaderNameSchema, requestHeaderValueSchema)
  .superRefine((headers, context) => {
    for (const name of Object.keys(headers)) {
      if (name !== name.toLowerCase()) {
        context.addIssue({
          code: 'custom',
          path: [name],
          message: 'Header names must be lowercase'
        })
      }
    }
  })

export const remoteModelGatewayRequestSchema = z
  .object({
    method: z.literal('POST'),
    path: remoteModelApiPathSchema,
    headers: remoteModelRequestHeadersSchema,
    bodyBase64: boundedCanonicalBase64Schema(
      REMOTE_MODEL_GATEWAY_LIMITS.maximumRequestBodyBytes
    )
  })
  .strict()
export type RemoteModelGatewayRequest = z.infer<
  typeof remoteModelGatewayRequestSchema
>

export const remoteModelResponseHeadersSchema = z.partialRecord(
  responseHeaderNameSchema,
  requestHeaderValueSchema
)

export const remoteModelGatewayResponseSchema = z
  .object({
    status: z.number().int().min(100).max(599),
    headers: remoteModelResponseHeadersSchema,
    bodyBase64: boundedCanonicalBase64Schema(
      REMOTE_MODEL_GATEWAY_LIMITS.maximumResponseBodyBytes
    )
  })
  .strict()
export type RemoteModelGatewayResponse = z.infer<
  typeof remoteModelGatewayResponseSchema
>

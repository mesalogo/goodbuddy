import { z } from 'zod'
import {
  agentIdentifierSchema,
  sha256DigestSchema,
  utf8StringSchema
} from './agent-protocol/contracts'
import { canonicalJson } from './agent-protocol/canonical'
import {
  REMOTE_MODEL_GATEWAY_LIMITS,
  remoteModelGatewayRequestSchema,
  remoteModelGatewayResponseSchema
} from './remote-model-gateway-contracts'

const textEncoder = new TextEncoder()
const fatalTextDecoder = new TextDecoder('utf-8', { fatal: true })

export const MODEL_BRIDGE_LIMITS = {
  maximumMessageBytes:
    Math.ceil(
      Math.max(
        REMOTE_MODEL_GATEWAY_LIMITS.maximumRequestBodyBytes,
        REMOTE_MODEL_GATEWAY_LIMITS.maximumResponseBodyBytes
      ) / 3
    ) *
      4 +
    16 * 1024,
  maximumErrorMessageBytes: 2_048,
  maximumModelNameBytes: 256
} as const

export const MODEL_BRIDGE_PROTOCOL = 'goodbuddy-model-bridge-v1' as const

export const modelBridgeModelProtocolSchema = z.enum([
  'anthropic-messages',
  'openai-responses',
  'openai-chat-completions'
])
export type ModelBridgeModelProtocol = z.infer<
  typeof modelBridgeModelProtocolSchema
>

const modelNameSchema = utf8StringSchema(
  MODEL_BRIDGE_LIMITS.maximumModelNameBytes,
  {
    minimumBytes: 1,
    label: 'Model bridge model name'
  }
)
  .refine(
    (value) => value.trim() === value,
    'Model name must not have outer whitespace'
  )
  .refine(
    (value) =>
      Array.from(value).every((character) => {
        const codePoint = character.codePointAt(0)!
        return codePoint > 0x1f && codePoint !== 0x7f
      }),
    'Model name cannot contain control characters'
  )

const modelProfileTextSchema = (label: string) =>
  utf8StringSchema(512, {
    minimumBytes: 1,
    label
  })
    .refine(
      (value) => value.trim() === value,
      `${label} must not have outer whitespace`
    )
    .refine(
      (value) => !/[\0\r\n]/u.test(value),
      `${label} cannot contain control characters`
    )

const modelProviderBaseUrlSchema = utf8StringSchema(4_096, {
  minimumBytes: 1,
  label: 'Model provider base URL'
}).superRefine((value, context) => {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    context.addIssue({
      code: 'custom',
      message: 'Model provider base URL is invalid'
    })
    return
  }
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username !== '' ||
    url.password !== '' ||
    url.hash !== ''
  ) {
    context.addIssue({
      code: 'custom',
      message: 'Model provider base URL must be credential-free HTTP(S)'
    })
  }
})

/**
 * A bounded prompt-scoped provider snapshot. The API key is deliberately kept
 * out of ModelBridgePolicy because policy is safe to persist and log, while
 * this profile must only be retained by the Agent for the active prompt.
 */
export const agentPromptModelProfileSchema = z
  .object({
    profileId: modelProfileTextSchema('Model profile identifier'),
    modelProfileDigest: sha256DigestSchema,
    provider: z.enum(['anthropic', 'openai']),
    baseUrl: modelProviderBaseUrlSchema,
    model: modelNameSchema,
    protocol: modelBridgeModelProtocolSchema,
    authentication: z.enum(['api-key', 'none']),
    apiKey: utf8StringSchema(16 * 1_024, {
      minimumBytes: 1,
      label: 'Model provider API key'
    }).optional(),
    capabilities: z
      .object({
        imageInput: z.boolean()
      })
      .strict(),
    limits: z
      .object({
        maximumOutputTokens: z.number().int().min(1).max(1_000_000),
        maximumModelCalls: z.number().int().min(1).max(10_000),
        maximumTotalOutputTokens: z.number().int().min(1).max(10_000_000),
        requestTimeoutMilliseconds: z
          .number()
          .int()
          .min(1)
          .max(300_000)
      })
      .strict()
  })
  .strict()
  .superRefine((profile, context) => {
    if (
      (profile.authentication === 'api-key') !==
      (profile.apiKey !== undefined)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['apiKey'],
        message: 'API-key authentication requires exactly one prompt credential'
      })
    }
    if (
      profile.provider === 'anthropic' !==
      (profile.protocol === 'anthropic-messages')
    ) {
      context.addIssue({
        code: 'custom',
        path: ['provider'],
        message: 'Model provider does not match its wire protocol'
      })
    }
    if (
      profile.limits.maximumOutputTokens >
      profile.limits.maximumTotalOutputTokens
    ) {
      context.addIssue({
        code: 'custom',
        path: ['limits', 'maximumOutputTokens'],
        message: 'Per-call output limit exceeds the prompt total'
      })
    }
  })
export type AgentPromptModelProfile = z.infer<
  typeof agentPromptModelProfileSchema
>

export const modelBridgePolicySchema = z
  .object({
    protocol: modelBridgeModelProtocolSchema,
    model: modelNameSchema,
    modelProfileDigest: sha256DigestSchema,
    // Accepted only so persisted pre-removal bindings can be read and
    // retired normally. Current code neither emits nor enforces these fields.
    maximumOutputTokens: z.number().int().min(1).optional(),
    maximumModelCalls: z.number().int().min(1).optional(),
    maximumTotalOutputTokens: z.number().int().min(1).optional(),
    supportsImageInput: z.boolean()
  })
  .strict()
export type ModelBridgePolicy = z.infer<
  typeof modelBridgePolicySchema
>

export const modelBridgeIdentitySchema = z
  .object({
    bindingId: agentIdentifierSchema,
    promptOperationId: agentIdentifierSchema,
    requestId: agentIdentifierSchema,
    roundIndex: z
      .number()
      .int()
      .nonnegative()
      .max(Number.MAX_SAFE_INTEGER),
    modelProfileDigest: sha256DigestSchema,
    messageId: agentIdentifierSchema
  })
  .strict()
export type ModelBridgeIdentity = z.infer<
  typeof modelBridgeIdentitySchema
>

const modelBridgeRequestMessageBaseSchema = z
  .object({
    protocol: z.literal(MODEL_BRIDGE_PROTOCOL),
    kind: z.literal('request'),
    identity: modelBridgeIdentitySchema,
    policy: modelBridgePolicySchema,
    requestDigest: sha256DigestSchema,
    request: remoteModelGatewayRequestSchema
  })
  .strict()

export const modelBridgeRequestMessageSchema =
  modelBridgeRequestMessageBaseSchema.superRefine((message, context) => {
    if (
      message.identity.modelProfileDigest !==
      message.policy.modelProfileDigest
    ) {
      context.addIssue({
        code: 'custom',
        path: ['policy', 'modelProfileDigest'],
        message: 'Policy model profile digest does not match the message identity'
      })
    }
    if (!pathMatchesProtocol(message.policy.protocol, message.request.path)) {
      context.addIssue({
        code: 'custom',
        path: ['request', 'path'],
        message: 'Provider path does not match the model bridge policy protocol'
      })
    }
  })
export type ModelBridgeRequestMessage = z.infer<
  typeof modelBridgeRequestMessageSchema
>

export const modelBridgeResponseMessageSchema = z
  .object({
    protocol: z.literal(MODEL_BRIDGE_PROTOCOL),
    kind: z.literal('response'),
    identity: modelBridgeIdentitySchema,
    requestDigest: sha256DigestSchema,
    response: remoteModelGatewayResponseSchema
  })
  .strict()
export type ModelBridgeResponseMessage = z.infer<
  typeof modelBridgeResponseMessageSchema
>

export const modelBridgeErrorSchema = z
  .object({
    code: agentIdentifierSchema,
    message: utf8StringSchema(
      MODEL_BRIDGE_LIMITS.maximumErrorMessageBytes,
      {
        minimumBytes: 1,
        label: 'Model bridge error message'
      }
    ),
    retryable: z.boolean(),
    poisoned: z.boolean(),
    outcomeUnknown: z.boolean()
  })
  .strict()
export type ModelBridgeError = z.infer<
  typeof modelBridgeErrorSchema
>

export const modelBridgeErrorMessageSchema = z
  .object({
    protocol: z.literal(MODEL_BRIDGE_PROTOCOL),
    kind: z.literal('error'),
    identity: modelBridgeIdentitySchema,
    requestDigest: sha256DigestSchema,
    error: modelBridgeErrorSchema
  })
  .strict()
export type ModelBridgeErrorMessage = z.infer<
  typeof modelBridgeErrorMessageSchema
>

export const modelBridgeDeliveryAckMessageSchema = z
  .object({
    protocol: z.literal(MODEL_BRIDGE_PROTOCOL),
    kind: z.literal('response-delivered'),
    identity: modelBridgeIdentitySchema,
    requestDigest: sha256DigestSchema
  })
  .strict()
export type ModelBridgeDeliveryAckMessage = z.infer<
  typeof modelBridgeDeliveryAckMessageSchema
>

export const modelBridgeMessageSchema = z.discriminatedUnion('kind', [
  modelBridgeRequestMessageSchema,
  modelBridgeResponseMessageSchema,
  modelBridgeErrorMessageSchema,
  modelBridgeDeliveryAckMessageSchema
])
export type ModelBridgeMessage = z.infer<
  typeof modelBridgeMessageSchema
>

export type ModelBridgeCodecErrorCode =
  | 'digest-mismatch'
  | 'identity-mismatch'
  | 'invalid-message'
  | 'oversized'

export class ModelBridgeCodecError extends Error {
  readonly code: ModelBridgeCodecErrorCode

  constructor(code: ModelBridgeCodecErrorCode, message: string) {
    super(message)
    this.name = 'ModelBridgeCodecError'
    this.code = code
  }
}

export async function digestModelBridgeRequest(
  request: unknown
): Promise<string> {
  const parsed = remoteModelGatewayRequestSchema.parse(request)
  return sha256Digest(
    canonicalJson({
      protocol: MODEL_BRIDGE_PROTOCOL,
      request: parsed
    })
  )
}

export async function createModelBridgeRequestMessage(input: {
  identity: unknown
  policy: unknown
  request: unknown
}): Promise<ModelBridgeRequestMessage> {
  const identity = modelBridgeIdentitySchema.parse(input.identity)
  const policy = modelBridgePolicySchema.parse(input.policy)
  const request = remoteModelGatewayRequestSchema.parse(input.request)
  return modelBridgeRequestMessageSchema.parse({
    protocol: MODEL_BRIDGE_PROTOCOL,
    kind: 'request',
    identity,
    policy,
    requestDigest: await digestModelBridgeRequest(request),
    request
  })
}

export async function assertModelBridgeRequestDigest(
  message: ModelBridgeRequestMessage
): Promise<void> {
  const actualDigest = await digestModelBridgeRequest(message.request)
  if (actualDigest !== message.requestDigest) {
    throw new ModelBridgeCodecError(
      'digest-mismatch',
      'Model bridge request digest does not match the exact request'
    )
  }
}

export async function encodeModelBridgeMessage(
  input: unknown
): Promise<Uint8Array> {
  const message = modelBridgeMessageSchema.parse(input)
  if (message.kind === 'request') {
    await assertModelBridgeRequestDigest(message)
  }
  const bytes = textEncoder.encode(canonicalJson(message))
  if (bytes.byteLength > MODEL_BRIDGE_LIMITS.maximumMessageBytes) {
    throw new ModelBridgeCodecError(
      'oversized',
      'Model bridge message exceeds its byte limit'
    )
  }
  return bytes
}

export type ModelBridgeDecodeOptions = {
  expectedIdentity?: ModelBridgeIdentity
  expectedRequestDigest?: string
  maximumMessageBytes?: number
}

export async function decodeModelBridgeMessage(
  input: Uint8Array,
  options: ModelBridgeDecodeOptions = {}
): Promise<ModelBridgeMessage> {
  const maximumMessageBytes =
    options.maximumMessageBytes ?? MODEL_BRIDGE_LIMITS.maximumMessageBytes
  if (
    !Number.isSafeInteger(maximumMessageBytes) ||
    maximumMessageBytes < 1 ||
    maximumMessageBytes > MODEL_BRIDGE_LIMITS.maximumMessageBytes
  ) {
    throw new RangeError('Invalid model bridge message limit')
  }
  if (input.byteLength < 1 || input.byteLength > maximumMessageBytes) {
    throw new ModelBridgeCodecError(
      'oversized',
      'Model bridge message exceeds its configured byte limit'
    )
  }
  let text: string
  let unparsed: unknown
  try {
    text = fatalTextDecoder.decode(input)
    unparsed = JSON.parse(text) as unknown
  } catch {
    throw new ModelBridgeCodecError(
      'invalid-message',
      'Model bridge message is not canonical UTF-8 JSON'
    )
  }
  let canonical: string
  try {
    canonical = canonicalJson(unparsed)
  } catch {
    throw new ModelBridgeCodecError(
      'invalid-message',
      'Model bridge message is not canonical JSON'
    )
  }
  if (canonical !== text) {
    throw new ModelBridgeCodecError(
      'invalid-message',
      'Model bridge message JSON is not canonical'
    )
  }
  const parsed = modelBridgeMessageSchema.safeParse(unparsed)
  if (!parsed.success) {
    throw new ModelBridgeCodecError(
      'invalid-message',
      'Model bridge message does not match the wire contract'
    )
  }
  const message = parsed.data
  const expectedIdentity =
    options.expectedIdentity === undefined
      ? undefined
      : modelBridgeIdentitySchema.parse(options.expectedIdentity)
  if (
    expectedIdentity !== undefined &&
    !sameIdentity(message.identity, expectedIdentity)
  ) {
    throw new ModelBridgeCodecError(
      'identity-mismatch',
      'Model bridge message identity does not match the expected request'
    )
  }
  const expectedRequestDigest =
    options.expectedRequestDigest === undefined
      ? undefined
      : sha256DigestSchema.parse(options.expectedRequestDigest)
  if (
    expectedRequestDigest !== undefined &&
    message.requestDigest !== expectedRequestDigest
  ) {
    throw new ModelBridgeCodecError(
      'digest-mismatch',
      'Model bridge message does not match the expected request digest'
    )
  }
  if (message.kind === 'request') {
    await assertModelBridgeRequestDigest(message)
  }
  return message
}
function sameIdentity(
  left: ModelBridgeIdentity,
  right: ModelBridgeIdentity
): boolean {
  return (
    left.bindingId === right.bindingId &&
    left.promptOperationId === right.promptOperationId &&
    left.requestId === right.requestId &&
    left.roundIndex === right.roundIndex &&
    left.modelProfileDigest === right.modelProfileDigest &&
    left.messageId === right.messageId
  )
}

function pathMatchesProtocol(
  protocol: ModelBridgeModelProtocol,
  path: string
): boolean {
  switch (protocol) {
    case 'anthropic-messages':
      return path === '/v1/messages'
    case 'openai-chat-completions':
      return (
        path === '/chat/completions' ||
        path === '/v1/chat/completions'
      )
    case 'openai-responses':
      return path === '/responses' || path === '/v1/responses'
  }
}

async function sha256Digest(value: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest(
    'SHA-256',
    textEncoder.encode(value)
  )
  return `sha256:${Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, '0')
  ).join('')}`
}

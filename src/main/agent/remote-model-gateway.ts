import { createHash } from 'node:crypto'
import {
  modelCallIdentitySchema,
  modelCallResultMetadataSchema,
  modelCallUsageMetadataSchema,
  type ModelCallResultMetadata,
  type ModelCallUsageMetadata
} from '../../shared/model-call-operation-contracts'
import {
  REMOTE_MODEL_GATEWAY_LIMITS,
  remoteModelGatewayRequestSchema,
  remoteModelGatewayResponseSchema,
  type RemoteModelGatewayRequest,
  type RemoteModelGatewayResponse
} from '../../shared/remote-model-gateway-contracts'
import type { ResolvedModelProfile } from '../runtime-settings-store'
import { createAnthropicMessagesUrl } from './anthropic-endpoint'
import { ModelCallOperationStore } from './model-call-operation-store'
import {
  createOpenAIChatCompletionsUrl,
  createOpenAIResponsesUrl
} from './openai-endpoint'
import {
  BoundedResponseTooLargeError,
  readBoundedResponseBytes
} from './bounded-response'
import {
  assertTextModelRequestPolicy,
  ModelRequestPolicyError
} from '../../shared/model-request-policy'
import { modelBridgePathMatchesProtocol } from '../../shared/model-bridge-contracts'
import { canonicalJson } from '../../shared/agent-protocol/canonical'
import {
  canonicalModelRequestHeaders,
  mergeModelRequestBody,
  mergeModelRequestHeaders
} from '../../shared/model-request-customization'

const DEFAULT_TIMEOUT_MS = 60_000
const RESPONSE_HEADER_NAMES = [
  'content-type',
  'openai-request-id',
  'request-id',
  'x-request-id'
] as const

export type RemoteModelGatewayDispatchContext = {
  requestId: string
  bindingId: string
  promptOperationId: string
  promptSequence: number
  roundIndex: number
  modelProfileDigest: string
  modelProfile: ResolvedModelProfile
}

export type RemoteModelGatewayOptions = {
  store: ModelCallOperationStore
  fetcher?: (
    input: URL,
    init: RequestInit
  ) => Promise<Response>
  timeoutMs?: number
}

export class RemoteModelGatewayError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'RemoteModelGatewayError'
    this.code = code
  }
}

/**
 * Main-process-only, one-shot provider forwarder. Remote runtimes choose only
 * a protocol-specific relative path and a bounded payload. Provider location,
 * credentials, stable operation identity, and dispatch ownership stay in Main.
 */
export class RemoteModelGateway {
  readonly #store: ModelCallOperationStore
  readonly #fetcher: NonNullable<RemoteModelGatewayOptions['fetcher']>
  readonly #timeoutMs: number

  constructor(options: RemoteModelGatewayOptions) {
    this.#store = options.store
    this.#fetcher = options.fetcher ?? fetch
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    if (
      !Number.isSafeInteger(timeoutMs) ||
      timeoutMs < 1 ||
      timeoutMs > 300_000
    ) {
      throw new RangeError('Remote model gateway timeout is invalid')
    }
    this.#timeoutMs = timeoutMs
  }

  async dispatch(
    context: RemoteModelGatewayDispatchContext,
    request: RemoteModelGatewayRequest,
    signal: AbortSignal
  ): Promise<RemoteModelGatewayResponse> {
    signal.throwIfAborted()
    const prepared = prepareDispatch(context, request)

    this.#store.prepare({
      identity: prepared.identity,
      requestDigest: prepared.requestDigest,
      modelProfileDigest: prepared.modelProfileDigest
    })
    const claim = this.#store.beginDispatch(
      prepared.identity.callOperationId
    )
    if (!claim.permitted) {
      throw new RemoteModelGatewayError(
        'already-dispatched',
        'Remote model request was already dispatched'
      )
    }

    const timeoutController = new AbortController()
    const timeoutError = new RemoteModelGatewayError(
      'timeout',
      'Remote model request timed out'
    )
    const timer = setTimeout(
      () => timeoutController.abort(timeoutError),
      this.#timeoutMs
    )
    const requestSignal = AbortSignal.any([
      signal,
      timeoutController.signal
    ])

    let response: Response
    try {
      response = await this.#fetcher(prepared.url, {
        method: 'POST',
        redirect: 'error',
        headers: prepared.headers,
        body: prepared.body,
        signal: requestSignal
      })
    } catch {
      clearTimeout(timer)
      const code =
        timeoutController.signal.aborted
          ? 'timeout'
          : signal.aborted
            ? 'cancelled'
            : 'network-error'
      return this.#markUnknownAndThrow(
        prepared.identity.callOperationId,
        code
      )
    }

    let responseBody: Uint8Array
    try {
      responseBody = await readBoundedResponseBytes(response, {
        maxBytes:
          REMOTE_MODEL_GATEWAY_LIMITS.maximumResponseBodyBytes,
        tooLargeMessage: 'Remote model response is too large',
        truncatedMessage: 'Remote model response was truncated'
      })
    } catch (error) {
      clearTimeout(timer)
      const code =
        timeoutController.signal.aborted
          ? 'timeout'
          : signal.aborted
            ? 'cancelled'
            : error instanceof BoundedResponseTooLargeError
              ? 'response-too-large'
              : 'response-read-failed'
      return this.#markUnknownAndThrow(
        prepared.identity.callOperationId,
        code
      )
    } finally {
      clearTimeout(timer)
    }
    if (timeoutController.signal.aborted || signal.aborted) {
      const code = timeoutController.signal.aborted
        ? 'timeout'
        : 'cancelled'
      return this.#markUnknownAndThrow(
        prepared.identity.callOperationId,
        code
      )
    }

    const responseHeaders = selectResponseHeaders(response.headers)
    const providerRequestId =
      safeProviderIdentifier(
        response.headers.get('x-request-id')
      ) ??
      safeProviderIdentifier(
        response.headers.get('openai-request-id')
      ) ??
      safeProviderIdentifier(response.headers.get('request-id'))
    let bridgeResponse: RemoteModelGatewayResponse
    try {
      bridgeResponse = remoteModelGatewayResponseSchema.parse({
        status: response.status,
        headers: responseHeaders,
        bodyBase64: Buffer.from(responseBody).toString('base64')
      })
    } catch {
      return this.#markUnknownAndThrow(
        prepared.identity.callOperationId,
        'invalid-bridge-response'
      )
    }
    const parsedMetadata = parseResponseMetadata(responseBody)
    this.#store.complete(prepared.identity.callOperationId, {
      status: 'completed',
      ...(providerRequestId ? { providerRequestId } : {}),
      ...(parsedMetadata.providerResponseId
        ? { providerResponseId: parsedMetadata.providerResponseId }
        : {}),
      result: {
        outputDigest: sha256(responseBody),
        ...(parsedMetadata.result ?? {})
      },
      ...(parsedMetadata.usage ? { usage: parsedMetadata.usage } : {})
    })

    return bridgeResponse
  }

  markResponseDelivered(
    context: Pick<
      RemoteModelGatewayDispatchContext,
      'bindingId' | 'promptOperationId' | 'roundIndex'
    >
  ): void {
    this.#store.markResponseDelivered(
      createModelCallOperationId(context)
    )
  }

  finalizePrompt(context: {
    bindingId: string
    promptOperationId: string
    promptSequence: number
  }): void {
    this.#store.finalizePrompt(context)
  }

  #markUnknownAndThrow(
    callOperationId: string,
    code: string
  ): never {
    this.#store.markOutcomeUnknown(callOperationId, {
      status: 'outcome-unknown',
      reason: {
        code,
        retryable: false
      }
    })
    throw new RemoteModelGatewayError(
      code,
      remoteModelGatewayErrorMessage(code)
    )
  }
}

function prepareDispatch(
  context: RemoteModelGatewayDispatchContext,
  request: RemoteModelGatewayRequest
): {
  identity: ReturnType<typeof modelCallIdentitySchema.parse>
  requestDigest: string
  modelProfileDigest: string
  url: URL
  headers: Record<string, string>
  body: Uint8Array
} {
  const parsedRequest = remoteModelGatewayRequestSchema.parse(request)
  const profile = context.modelProfile
  const modelProfileDigest = createResolvedModelProfileDigest(profile)
  if (modelProfileDigest !== context.modelProfileDigest) {
    throw new RemoteModelGatewayError(
      'model-profile-digest-mismatch',
      'Trusted model profile snapshot does not match its digest'
    )
  }
  const url = providerUrl(profile, parsedRequest.path)
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password
  ) {
    throw new RemoteModelGatewayError(
      'invalid-provider-endpoint',
      'Configured model provider endpoint is invalid'
    )
  }
  if (profile.authentication === 'api-key' && !profile.apiKey) {
    throw new RemoteModelGatewayError(
      'missing-provider-credential',
      'Configured model provider credential is unavailable'
    )
  }
  const body = normalizeProviderRequestBody(
    profile,
    Buffer.from(parsedRequest.bodyBase64, 'base64')
  )
  if (
    body.byteLength >
    REMOTE_MODEL_GATEWAY_LIMITS.maximumRequestBodyBytes
  ) {
    throw new RemoteModelGatewayError(
      'request-too-large',
      'Customized remote model request is too large'
    )
  }
  const providerHeaders = mergeModelRequestHeaders(
    profile.requestHeaders ?? {},
    parsedRequest.headers
  )
  if (profile.protocol === 'anthropic-messages') {
    providerHeaders.set('anthropic-version', '2023-06-01')
  }
  const canonicalHeaders =
    canonicalModelRequestHeaders(providerHeaders)
  const normalizedBodyBase64 = body.toString('base64')
  const canonicalRequest = JSON.stringify({
    profileId: profile.id,
    protocol: profile.protocol,
    authentication: profile.authentication,
    model: profile.modelName,
    url: url.toString(),
    request: {
      method: parsedRequest.method,
      path: parsedRequest.path,
      headers: canonicalHeaders,
      bodyBase64: normalizedBodyBase64
    }
  })
  const requestDigest = sha256(canonicalRequest)
  const callOperationId = createModelCallOperationId(context)
  const identity = modelCallIdentitySchema.parse({
    callOperationId,
    requestId: context.requestId,
    bindingId: context.bindingId,
    promptOperationId: context.promptOperationId,
    promptSequence: context.promptSequence,
    roundIndex: context.roundIndex,
    provider:
      profile.protocol === 'anthropic-messages'
        ? 'anthropic'
        : 'openai',
    profile: profile.id,
    model: profile.modelName,
    protocol: profile.protocol
  })

  if (profile.protocol === 'anthropic-messages') {
    if (profile.authentication === 'api-key') {
      providerHeaders.set('x-api-key', profile.apiKey!)
    }
  } else if (profile.authentication === 'api-key') {
    providerHeaders.set('authorization', `Bearer ${profile.apiKey!}`)
  }

  return {
    identity,
    requestDigest,
    modelProfileDigest,
    url,
    headers: Object.fromEntries(providerHeaders.entries()),
    body
  }
}

export function createModelCallOperationId(
  context: Pick<
    RemoteModelGatewayDispatchContext,
    'bindingId' | 'promptOperationId' | 'roundIndex'
  >
): string {
  return `model-call-${createHash('sha256')
    .update(
      JSON.stringify({
        bindingId: context.bindingId,
        promptOperationId: context.promptOperationId,
        roundIndex: context.roundIndex
      })
    )
    .digest('hex')}`
}

export function createResolvedModelProfileDigest(
  profile: ResolvedModelProfile
): string {
  return sha256(
    canonicalJson({
      id: profile.id,
      name: profile.name,
      baseUrl: profile.baseUrl,
      modelName: profile.modelName,
      protocol: profile.protocol,
      authentication: profile.authentication,
      supportsImageInput: profile.supportsImageInput === true,
      contextWindowTokens: profile.contextWindowTokens ?? null,
      maximumOutputTokens: profile.maximumOutputTokens ?? null,
      imageGenerationQuality: profile.imageGenerationQuality ?? null,
      requestHeaders: Object.fromEntries(
        Object.entries(profile.requestHeaders ?? {}).map(
          ([name, value]) => [name.toLowerCase(), value]
        )
      ),
      requestBody: profile.requestBody ?? {}
    })
  )
}

function normalizeProviderRequestBody(
  profile: ResolvedModelProfile,
  body: Buffer
): Buffer {
  let value: unknown
  try {
    value = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(body)
    ) as unknown
  } catch {
    throw requestPolicyError()
  }
  if (
    profile.protocol !== 'anthropic-messages' &&
    profile.protocol !== 'openai-chat-completions' &&
    profile.protocol !== 'openai-responses'
  ) {
    throw requestPolicyError()
  }
  const request = mergeModelRequestBody(
    profile.requestBody ?? {},
    value as Record<string, unknown>
  )
  try {
    assertTextModelRequestPolicy(
      {
        protocol: profile.protocol,
        model: profile.modelName,
        supportsImageInput: profile.supportsImageInput === true
      },
      request
    )
  } catch (error) {
    if (!(error instanceof ModelRequestPolicyError)) {
      throw error
    }
    throw requestPolicyError()
  }
  return Buffer.from(canonicalJson(request), 'utf8')
}

function requestPolicyError(): RemoteModelGatewayError {
  return new RemoteModelGatewayError(
    'request-policy-mismatch',
    'Remote model request does not match the trusted model policy'
  )
}

function providerUrl(
  profile: ResolvedModelProfile,
  path: string
): URL {
  if (
    profile.protocol === 'openai-images-generations' ||
    !modelBridgePathMatchesProtocol(profile.protocol, path)
  ) {
    throw protocolPathError()
  }
  if (profile.protocol === 'anthropic-messages') {
    return createAnthropicMessagesUrl(profile.baseUrl)
  }
  if (profile.protocol === 'openai-chat-completions') {
    return createOpenAIChatCompletionsUrl(profile.baseUrl)
  }
  if (profile.protocol === 'openai-responses') {
    return createOpenAIResponsesUrl(profile.baseUrl)
  }
  throw protocolPathError()
}

function protocolPathError(): RemoteModelGatewayError {
  return new RemoteModelGatewayError(
    'protocol-path-mismatch',
    'Remote model request path does not match the configured protocol'
  )
}

function selectResponseHeaders(
  headers: Headers
): Record<string, string> {
  const selected: Record<string, string> = {}
  for (const name of RESPONSE_HEADER_NAMES) {
    const value = headers.get(name)
    const encodedBytes =
      value === null ? 0 : new TextEncoder().encode(value).byteLength
    if (
      value !== null &&
      encodedBytes > 0 &&
      !/[\r\n]/u.test(value) &&
      encodedBytes <= REMOTE_MODEL_GATEWAY_LIMITS.maximumHeaderValueBytes
    ) {
      selected[name] = value
    }
  }
  return selected
}

function parseResponseMetadata(body: Uint8Array): {
  providerResponseId?: string
  result?: ModelCallResultMetadata
  usage?: ModelCallUsageMetadata
} {
  let parsed: unknown
  try {
    parsed = JSON.parse(new TextDecoder().decode(body)) as unknown
  } catch {
    return {}
  }
  if (!isRecord(parsed)) {
    return {}
  }
  const providerResponseId = safeProviderIdentifier(parsed.id)
  const finishReason = safeFinishReason(
    isRecordArray(parsed.choices) &&
      isRecord(parsed.choices[0])
      ? parsed.choices[0].finish_reason
      : parsed.stop_reason
  )
  const resultCandidate = {
    ...(finishReason ? { finishReason } : {})
  }
  const result = modelCallResultMetadataSchema.safeParse(resultCandidate)
  const usage = parseUsage(parsed.usage)
  return {
    ...(providerResponseId ? { providerResponseId } : {}),
    ...(result.success && Object.keys(result.data).length > 0
      ? { result: result.data }
      : {}),
    ...(usage ? { usage } : {})
  }
}

function parseUsage(value: unknown): ModelCallUsageMetadata | undefined {
  if (!isRecord(value)) {
    return undefined
  }
  const promptDetails = isRecord(value.prompt_tokens_details)
    ? value.prompt_tokens_details
    : undefined
  const inputDetails = isRecord(value.input_tokens_details)
    ? value.input_tokens_details
    : undefined
  const completionDetails = isRecord(value.completion_tokens_details)
    ? value.completion_tokens_details
    : undefined
  const outputDetails = isRecord(value.output_tokens_details)
    ? value.output_tokens_details
    : undefined
  const candidate = {
    inputTokens: safeTokenCount(value.input_tokens ?? value.prompt_tokens),
    outputTokens: safeTokenCount(
      value.output_tokens ?? value.completion_tokens
    ),
    cachedInputTokens: safeTokenCount(
      value.cache_read_input_tokens ??
        inputDetails?.cached_tokens ??
        promptDetails?.cached_tokens
    ),
    reasoningTokens: safeTokenCount(
      outputDetails?.reasoning_tokens ??
        completionDetails?.reasoning_tokens
    )
  }
  const compact = Object.fromEntries(
    Object.entries(candidate).filter((entry) => entry[1] !== undefined)
  )
  const result = modelCallUsageMetadataSchema.safeParse(compact)
  return result.success && Object.keys(result.data).length > 0
    ? result.data
    : undefined
}

function safeTokenCount(value: unknown): number | undefined {
  return typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= 0
    ? value
    : undefined
}

function safeProviderIdentifier(value: unknown): string | undefined {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 256 ||
    value.trim() !== value ||
    new TextEncoder().encode(value).byteLength > 256
  ) {
    return undefined
  }
  return value
}

function safeFinishReason(value: unknown): string | undefined {
  const result =
    modelCallResultMetadataSchema.shape.finishReason.safeParse(value)
  return result.success ? result.data : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value)
  )
}

function isRecordArray(value: unknown): value is Record<string, unknown>[] {
  return Array.isArray(value) && value.every(isRecord)
}

function sha256(value: string | Uint8Array): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`
}

function remoteModelGatewayErrorMessage(code: string): string {
  switch (code) {
    case 'timeout':
      return 'Remote model request timed out after dispatch'
    case 'cancelled':
      return 'Remote model request was cancelled after dispatch'
    case 'response-too-large':
      return 'Remote model response exceeded the allowed size'
    case 'response-read-failed':
      return 'Remote model response could not be read'
    case 'invalid-bridge-response':
      return 'Remote model response could not be safely delivered'
    default:
      return 'Remote model request outcome is unknown'
  }
}

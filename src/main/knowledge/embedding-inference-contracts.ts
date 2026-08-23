export const EMBEDDING_INFERENCE_PROTOCOL =
  'goodbuddy.embedding-inference'
export const EMBEDDING_INFERENCE_PROTOCOL_VERSION = 1

export const EMBEDDING_INFERENCE_MAX_TEXTS = 64
export const EMBEDDING_INFERENCE_MAX_TEXT_LENGTH = 16_000
export const EMBEDDING_INFERENCE_MAX_TOTAL_TEXT_LENGTH = 128_000
export const EMBEDDING_INFERENCE_MAX_DIMENSIONS = 8_192
export const EMBEDDING_INFERENCE_MAX_IN_FLIGHT = 8
export const EMBEDDING_INFERENCE_MAX_ERROR_LENGTH = 256

export type EmbeddingInferenceRole = 'query' | 'document'

type ProtocolBase = {
  readonly protocol: typeof EMBEDDING_INFERENCE_PROTOCOL
  readonly version: typeof EMBEDDING_INFERENCE_PROTOCOL_VERSION
}

export type EmbeddingInferenceRequest =
  | (ProtocolBase & {
      readonly type: 'embed'
      readonly requestId: string
      readonly role: EmbeddingInferenceRole
      readonly texts: readonly string[]
    })
  | (ProtocolBase & {
      readonly type: 'cancel'
      readonly requestId: string
    })
  | (ProtocolBase & {
      readonly type: 'shutdown'
    })

export type EmbeddingInferenceErrorCode =
  | 'CANCELLED'
  | 'ENGINE_FAILURE'
  | 'INVALID_RESULT'
  | 'OVERLOADED'

export type EmbeddingInferenceResponse =
  | (ProtocolBase & {
      readonly type: 'result'
      readonly requestId: string
      readonly vectors: readonly (readonly number[])[]
    })
  | (ProtocolBase & {
      readonly type: 'error'
      readonly requestId: string
      readonly code: EmbeddingInferenceErrorCode
      readonly message: string
    })
  | (ProtocolBase & {
      readonly type: 'fatal'
      readonly code: 'PROTOCOL_VIOLATION'
    })
  | (ProtocolBase & {
      readonly type: 'shutdown-complete'
    })

const BASE_KEYS = ['protocol', 'version', 'type'] as const
const REQUEST_ID_KEYS = [...BASE_KEYS, 'requestId'] as const
const EMBED_KEYS = [...REQUEST_ID_KEYS, 'role', 'texts'] as const
const RESULT_KEYS = [...REQUEST_ID_KEYS, 'vectors'] as const
const ERROR_KEYS = [...REQUEST_ID_KEYS, 'code', 'message'] as const
const FATAL_KEYS = [...BASE_KEYS, 'code'] as const

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false
  }
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[]
): boolean {
  const keys = Object.keys(value)
  return (
    keys.length === expected.length &&
    expected.every((key) => Object.prototype.hasOwnProperty.call(value, key))
  )
}

function hasProtocolBase(value: Record<string, unknown>): boolean {
  return (
    value.protocol === EMBEDDING_INFERENCE_PROTOCOL &&
    value.version === EMBEDDING_INFERENCE_PROTOCOL_VERSION &&
    typeof value.type === 'string'
  )
}

export function isEmbeddingInferenceRequestId(
  value: unknown
): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value)
}

export function validateEmbeddingInferenceTexts(
  value: unknown
): readonly string[] {
  if (
    !Array.isArray(value) ||
    value.length < 1 ||
    value.length > EMBEDDING_INFERENCE_MAX_TEXTS
  ) {
    throw new RangeError(
      `texts must contain between 1 and ${EMBEDDING_INFERENCE_MAX_TEXTS} items`
    )
  }

  let totalLength = 0
  for (const [index, text] of value.entries()) {
    if (typeof text !== 'string' || text.length < 1) {
      throw new TypeError(`texts[${index}] must be a non-empty string`)
    }
    if (text.length > EMBEDDING_INFERENCE_MAX_TEXT_LENGTH) {
      throw new RangeError(
        `texts[${index}] must be at most ${EMBEDDING_INFERENCE_MAX_TEXT_LENGTH} characters`
      )
    }
    totalLength += text.length
    if (totalLength > EMBEDDING_INFERENCE_MAX_TOTAL_TEXT_LENGTH) {
      throw new RangeError(
        `texts must total at most ${EMBEDDING_INFERENCE_MAX_TOTAL_TEXT_LENGTH} characters`
      )
    }
  }
  return value as readonly string[]
}

export function validateEmbeddingInferenceVectors(
  value: unknown,
  expectedCount: number
): number[][] {
  if (!Array.isArray(value) || value.length !== expectedCount) {
    throw new RangeError('Embedding result count does not match the request')
  }

  let dimensions: number | undefined
  return value.map((rawVector, vectorIndex) => {
    if (
      !Array.isArray(rawVector) ||
      rawVector.length < 1 ||
      rawVector.length > EMBEDDING_INFERENCE_MAX_DIMENSIONS
    ) {
      throw new RangeError(
        `Embedding ${vectorIndex} has invalid dimensions`
      )
    }
    if (dimensions === undefined) {
      dimensions = rawVector.length
    } else if (rawVector.length !== dimensions) {
      throw new RangeError('Embeddings have inconsistent dimensions')
    }

    let magnitudeSquared = 0
    const vector = rawVector.map((component) => {
      if (typeof component !== 'number' || !Number.isFinite(component)) {
        throw new TypeError('Embeddings must contain finite numbers')
      }
      magnitudeSquared += component * component
      return component
    })
    if (!Number.isFinite(magnitudeSquared) || magnitudeSquared <= 0) {
      throw new RangeError('Embeddings must have a finite non-zero norm')
    }
    return vector
  })
}

export function parseEmbeddingInferenceRequest(
  value: unknown
): EmbeddingInferenceRequest | undefined {
  if (!isRecord(value) || !hasProtocolBase(value)) {
    return undefined
  }
  if (value.type === 'shutdown') {
    return hasExactKeys(value, BASE_KEYS)
      ? (value as EmbeddingInferenceRequest)
      : undefined
  }
  if (
    value.type === 'cancel' &&
    hasExactKeys(value, REQUEST_ID_KEYS) &&
    isEmbeddingInferenceRequestId(value.requestId)
  ) {
    return value as EmbeddingInferenceRequest
  }
  if (
    value.type !== 'embed' ||
    !hasExactKeys(value, EMBED_KEYS) ||
    !isEmbeddingInferenceRequestId(value.requestId) ||
    (value.role !== 'query' && value.role !== 'document')
  ) {
    return undefined
  }
  try {
    validateEmbeddingInferenceTexts(value.texts)
    return value as EmbeddingInferenceRequest
  } catch {
    return undefined
  }
}

export function parseEmbeddingInferenceResponse(
  value: unknown
): EmbeddingInferenceResponse | undefined {
  if (!isRecord(value) || !hasProtocolBase(value)) {
    return undefined
  }
  if (value.type === 'shutdown-complete') {
    return hasExactKeys(value, BASE_KEYS)
      ? (value as EmbeddingInferenceResponse)
      : undefined
  }
  if (
    value.type === 'fatal' &&
    hasExactKeys(value, FATAL_KEYS) &&
    value.code === 'PROTOCOL_VIOLATION'
  ) {
    return value as EmbeddingInferenceResponse
  }
  if (
    value.type === 'result' &&
    hasExactKeys(value, RESULT_KEYS) &&
    isEmbeddingInferenceRequestId(value.requestId) &&
    Array.isArray(value.vectors)
  ) {
    return value as EmbeddingInferenceResponse
  }
  const errorCodes: readonly EmbeddingInferenceErrorCode[] = [
    'CANCELLED',
    'ENGINE_FAILURE',
    'INVALID_RESULT',
    'OVERLOADED'
  ]
  if (
    value.type === 'error' &&
    hasExactKeys(value, ERROR_KEYS) &&
    isEmbeddingInferenceRequestId(value.requestId) &&
    typeof value.code === 'string' &&
    errorCodes.includes(value.code as EmbeddingInferenceErrorCode) &&
    typeof value.message === 'string' &&
    value.message.length > 0 &&
    value.message.length <= EMBEDDING_INFERENCE_MAX_ERROR_LENGTH
  ) {
    return value as EmbeddingInferenceResponse
  }
  return undefined
}

export function embeddingInferenceProtocolBase(): ProtocolBase {
  return {
    protocol: EMBEDDING_INFERENCE_PROTOCOL,
    version: EMBEDDING_INFERENCE_PROTOCOL_VERSION
  }
}

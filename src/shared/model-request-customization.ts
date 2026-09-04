import { z } from 'zod'
import type { CanonicalJsonValue } from './agent-protocol/canonical'

export const MODEL_REQUEST_CUSTOMIZATION_LIMITS = {
  maximumHeaders: 64,
  maximumHeaderNameLength: 128,
  maximumHeaderValueLength: 4_096,
  maximumBodyBytes: 64 * 1024,
  maximumBodyDepth: 16,
  maximumBodyNodes: 4_096,
  maximumBodyEntries: 256,
  maximumBodyKeyLength: 256,
  maximumBodyStringLength: 32_768
} as const

const reservedHeaderNames = new Set([
  'anthropic-version',
  'api-key',
  'authorization',
  'connection',
  'content-length',
  'content-type',
  'host',
  'transfer-encoding',
  'user-agent',
  'x-api-key'
])

const reservedBodyKeys = new Set([
  'input',
  'instructions',
  'max_output_tokens',
  'max_tokens',
  'messages',
  'model',
  'n',
  'parallel_tool_calls',
  'prompt',
  'quality',
  'response_format',
  'stream',
  'stream_options',
  'system',
  'tool_choice',
  'tools'
])

export type ModelRequestHeaders = Record<string, string>

export type ModelRequestJsonValue = CanonicalJsonValue

export type ModelRequestBody = Record<string, ModelRequestJsonValue>

function hasInvalidHeaderValueCharacter(value: string): boolean {
  return [...value].some((character) => {
    const code = character.charCodeAt(0)
    return code <= 31 || code === 127 || code > 255
  })
}

function isHeaderName(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <=
      MODEL_REQUEST_CUSTOMIZATION_LIMITS.maximumHeaderNameLength &&
    /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/u.test(value)
  )
}

function isModelRequestHeaders(value: unknown): value is ModelRequestHeaders {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    return false
  }
  const entries = Object.entries(value)
  if (
    entries.length >
    MODEL_REQUEST_CUSTOMIZATION_LIMITS.maximumHeaders
  ) {
    return false
  }
  const normalizedNames = new Set<string>()
  for (const [name, headerValue] of entries) {
    const normalizedName = name.toLowerCase()
    if (
      !isHeaderName(name) ||
      normalizedNames.has(normalizedName) ||
      reservedHeaderNames.has(normalizedName) ||
      typeof headerValue !== 'string' ||
      headerValue.length >
        MODEL_REQUEST_CUSTOMIZATION_LIMITS.maximumHeaderValueLength ||
      hasInvalidHeaderValueCharacter(headerValue)
    ) {
      return false
    }
    normalizedNames.add(normalizedName)
  }
  return true
}

function isModelRequestBody(value: unknown): value is ModelRequestBody {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    return false
  }
  if (
    Object.keys(value).some((key) =>
      reservedBodyKeys.has(key.toLowerCase())
    )
  ) {
    return false
  }
  const pending: Array<{ value: unknown; depth: number }> = [
    { value, depth: 0 }
  ]
  const seen = new Set<object>()
  let nodes = 0
  while (pending.length > 0) {
    const current = pending.pop()!
    nodes += 1
    if (
      nodes > MODEL_REQUEST_CUSTOMIZATION_LIMITS.maximumBodyNodes ||
      current.depth >
        MODEL_REQUEST_CUSTOMIZATION_LIMITS.maximumBodyDepth
    ) {
      return false
    }
    if (
      current.value === null ||
      typeof current.value === 'boolean'
    ) {
      continue
    }
    if (typeof current.value === 'number') {
      if (!Number.isFinite(current.value)) {
        return false
      }
      continue
    }
    if (typeof current.value === 'string') {
      if (
        current.value.length >
        MODEL_REQUEST_CUSTOMIZATION_LIMITS.maximumBodyStringLength
      ) {
        return false
      }
      continue
    }
    if (
      !current.value ||
      typeof current.value !== 'object' ||
      seen.has(current.value)
    ) {
      return false
    }
    seen.add(current.value)
    if (Array.isArray(current.value)) {
      if (
        current.value.length >
        MODEL_REQUEST_CUSTOMIZATION_LIMITS.maximumBodyEntries
      ) {
        return false
      }
      for (const item of current.value) {
        pending.push({ value: item, depth: current.depth + 1 })
      }
      continue
    }
    const prototype = Object.getPrototypeOf(current.value)
    if (prototype !== Object.prototype && prototype !== null) {
      return false
    }
    const entries = Object.entries(current.value)
    if (
      entries.length >
      MODEL_REQUEST_CUSTOMIZATION_LIMITS.maximumBodyEntries
    ) {
      return false
    }
    for (const [key, item] of entries) {
      if (
        key.length === 0 ||
        key.length >
          MODEL_REQUEST_CUSTOMIZATION_LIMITS.maximumBodyKeyLength
      ) {
        return false
      }
      pending.push({ value: item, depth: current.depth + 1 })
    }
  }
  try {
    return (
      new TextEncoder().encode(JSON.stringify(value)).byteLength <=
      MODEL_REQUEST_CUSTOMIZATION_LIMITS.maximumBodyBytes
    )
  } catch {
    return false
  }
}

export const modelRequestHeadersSchema =
  z.custom<ModelRequestHeaders>(
    isModelRequestHeaders,
    '自定义请求头必须是有界的字符串对象，且不能覆盖认证或传输头'
  )

export const modelRequestBodySchema = z.custom<ModelRequestBody>(
  isModelRequestBody,
  '自定义请求体必须是有界的 JSON 对象，且不能覆盖模型、消息、工具或流式字段'
)

export function mergeModelRequestHeaders(
  customHeaders: ModelRequestHeaders,
  runtimeHeaders: ConstructorParameters<typeof Headers>[0]
): Headers {
  const headers = new Headers(customHeaders)
  const runtime = new Headers(runtimeHeaders)
  runtime.forEach((value, name) => headers.set(name, value))
  return headers
}

export function mergeModelRequestBody(
  customBody: ModelRequestBody,
  runtimeBody: Record<string, unknown>
): Record<string, unknown> {
  return {
    ...customBody,
    ...runtimeBody
  }
}

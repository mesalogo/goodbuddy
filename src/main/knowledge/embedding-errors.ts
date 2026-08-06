import type {
  EmbeddingErrorCode,
  EmbeddingSafeError
} from '../../shared/embedding-contracts'

const MAX_SAFE_MESSAGE_LENGTH = 500

const descriptors: Record<
  EmbeddingErrorCode,
  Omit<EmbeddingSafeError, 'code'>
> = {
  model_not_found: {
    message: '未找到指定的向量模型。',
    retryable: false,
    remedy: '请确认模型名称正确，并确认该模型已在服务端启用。'
  },
  authentication: {
    message: '向量服务身份验证失败。',
    retryable: false,
    remedy: '请检查访问密钥是否有效以及是否具备调用向量模型的权限。'
  },
  rate_limited: {
    message: '向量服务当前请求过多。',
    retryable: true,
    remedy: '请稍后重试，或检查服务配额与速率限制。'
  },
  timeout: {
    message: '向量服务响应超时。',
    retryable: true,
    remedy: '请检查网络和服务状态，然后重试。'
  },
  network: {
    message: '无法连接到向量服务。',
    retryable: true,
    remedy: '请检查服务地址、网络连接和代理设置。'
  },
  provider_unavailable: {
    message: '向量服务暂时不可用。',
    retryable: true,
    remedy: '请稍后重试并检查服务运行状态。'
  },
  invalid_configuration: {
    message: '向量模型配置无效。',
    retryable: false,
    remedy: '请检查服务地址、模型名称和配置参数。'
  },
  invalid_response: {
    message: '向量服务返回了无效结果。',
    retryable: false,
    remedy: '请确认服务兼容 OpenAI 向量接口并返回有效向量。'
  },
  cancelled: {
    message: '向量操作已取消。',
    retryable: true
  },
  unknown: {
    message: '向量操作失败。',
    retryable: false,
    remedy: '请检查向量服务配置后重试。'
  }
}

function errorText(error: unknown): string {
  if (error instanceof Error) {
    return `${error.name} ${error.message}`.toLowerCase()
  }
  return typeof error === 'string' ? error.toLowerCase() : ''
}

function numericStatus(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) {
    return undefined
  }
  for (const key of ['status', 'statusCode', 'code'] as const) {
    const value = Reflect.get(error, key)
    if (typeof value === 'number' && Number.isInteger(value)) {
      return value
    }
    if (
      typeof value === 'string' &&
      /^\d{3}$/u.test(value) &&
      Number.isInteger(Number(value))
    ) {
      return Number(value)
    }
  }
  return undefined
}

function statusFromText(text: string): number | undefined {
  const match = /\b(?:http|status(?: code)?)\s*[:=]?\s*(\d{3})\b/iu.exec(
    text
  )
  return match?.[1] ? Number(match[1]) : undefined
}

function hasAny(text: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => text.includes(pattern))
}

function classifyCode(
  error: unknown,
  options: { cancelled?: boolean; timedOut?: boolean }
): EmbeddingErrorCode {
  const text = errorText(error)
  const status = numericStatus(error) ?? statusFromText(text)

  if (
    options.cancelled ||
    hasAny(text, ['aborterror', 'aborted', 'cancelled', 'canceled'])
  ) {
    return 'cancelled'
  }
  if (
    options.timedOut ||
    hasAny(text, ['timeout', 'timed out', 'etimedout'])
  ) {
    return 'timeout'
  }
  if (
    status === 401 ||
    status === 403 ||
    hasAny(text, [
      'unauthorized',
      'forbidden',
      'authentication',
      'invalid api key',
      'incorrect api key'
    ])
  ) {
    return 'authentication'
  }
  if (
    status === 404 ||
    hasAny(text, [
      'model not found',
      'model_not_found',
      'unknown model',
      'does not exist'
    ])
  ) {
    return 'model_not_found'
  }
  if (
    status === 429 ||
    hasAny(text, ['rate limit', 'rate_limit', 'too many requests', 'quota'])
  ) {
    return 'rate_limited'
  }
  if (
    status === 408 ||
    status === 504
  ) {
    return 'timeout'
  }
  if (
    status !== undefined &&
    status >= 500 &&
    status <= 599
  ) {
    return 'provider_unavailable'
  }
  if (
    hasAny(text, [
      'econnrefused',
      'econnreset',
      'enotfound',
      'fetch failed',
      'network',
      'failed to fetch',
      'socket'
    ])
  ) {
    return 'network'
  }
  if (
    error instanceof RangeError ||
    hasAny(text, [
      'endpoint must',
      'model must',
      'invalid endpoint',
      'invalid configuration'
    ])
  ) {
    return 'invalid_configuration'
  }
  if (
    error instanceof TypeError ||
    hasAny(text, [
      'invalid dimensions',
      'invalid result',
      'invalid indexes',
      'inconsistent dimensions',
      'finite numbers',
      'valid json',
      'invalid response'
    ])
  ) {
    return 'invalid_response'
  }
  return 'unknown'
}

/**
 * Converts provider and transport failures into a bounded, user-safe error.
 * Raw provider response bodies, endpoints, keys and nested causes are never
 * copied into the returned value.
 */
export function classifyEmbeddingError(
  error: unknown,
  options: { cancelled?: boolean; timedOut?: boolean } = {}
): EmbeddingSafeError {
  const code = classifyCode(error, options)
  const descriptor = descriptors[code]
  return {
    code,
    message: descriptor.message.slice(0, MAX_SAFE_MESSAGE_LENGTH),
    retryable: descriptor.retryable,
    ...(descriptor.remedy
      ? { remedy: descriptor.remedy.slice(0, MAX_SAFE_MESSAGE_LENGTH) }
      : {})
  }
}

export class EmbeddingOperationError extends Error {
  readonly code: EmbeddingErrorCode
  readonly retryable: boolean
  readonly remedy?: string

  constructor(error: EmbeddingSafeError) {
    super(error.message)
    this.name = 'EmbeddingOperationError'
    this.code = error.code
    this.retryable = error.retryable
    this.remedy = error.remedy
  }

  toSafeError(): EmbeddingSafeError {
    return {
      code: this.code,
      message: this.message,
      retryable: this.retryable,
      ...(this.remedy ? { remedy: this.remedy } : {})
    }
  }
}

export function toEmbeddingOperationError(
  error: unknown,
  options?: { cancelled?: boolean; timedOut?: boolean }
): EmbeddingOperationError {
  return error instanceof EmbeddingOperationError
    ? error
    : new EmbeddingOperationError(classifyEmbeddingError(error, options))
}

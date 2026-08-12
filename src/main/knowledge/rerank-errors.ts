import type {
  RerankErrorCode,
  RerankSafeError
} from '../../shared/rerank-contracts'

const MAX_SAFE_MESSAGE_LENGTH = 500

const descriptors: Record<RerankErrorCode, Omit<RerankSafeError, 'code'>> = {
  model_not_found: {
    message: '未找到指定的重排模型。',
    retryable: false,
    remedy: '请确认模型名称正确，并确认该模型已在服务端启用。'
  },
  authentication: {
    message: '重排服务身份验证失败。',
    retryable: false,
    remedy: '请检查访问密钥是否有效以及是否具备调用重排模型的权限。'
  },
  rate_limited: {
    message: '重排服务当前请求过多。',
    retryable: true,
    remedy: '请稍后重试，或检查服务配额与速率限制。'
  },
  timeout: {
    message: '重排服务响应超时。',
    retryable: true,
    remedy: '请检查网络和服务状态，然后重试。'
  },
  network: {
    message: '无法连接到重排服务。',
    retryable: true,
    remedy: '请检查服务地址、网络连接和代理设置。'
  },
  provider_unavailable: {
    message: '重排服务暂时不可用。',
    retryable: true,
    remedy: '请稍后重试并检查服务运行状态。'
  },
  invalid_configuration: {
    message: '重排模型配置无效。',
    retryable: false,
    remedy: '请检查服务地址、模型名称和配置参数。'
  },
  invalid_response: {
    message: '重排服务返回了无效结果。',
    retryable: false,
    remedy: '请确认服务兼容 Cohere 重排接口并返回有效分数。'
  },
  cancelled: {
    message: '重排操作已取消。',
    retryable: true
  },
  unknown: {
    message: '重排操作失败。',
    retryable: false,
    remedy: '请检查重排服务配置后重试。'
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
    if (typeof value === 'string' && /^\d{3}$/u.test(value)) {
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
): RerankErrorCode {
  const text = errorText(error)
  const status = numericStatus(error) ?? statusFromText(text)

  if (error instanceof Error && error.name === 'TimeoutError') {
    return 'timeout'
  }
  if (error instanceof Error && error.name === 'AbortError') {
    return 'cancelled'
  }
  if (options.timedOut) {
    return 'timeout'
  }
  if (
    options.cancelled ||
    hasAny(text, ['aborterror', 'aborted', 'cancelled', 'canceled'])
  ) {
    return 'cancelled'
  }
  if (hasAny(text, ['timeout', 'timed out', 'etimedout'])) {
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
  if (status === 408 || status === 504) {
    return 'timeout'
  }
  if (status !== undefined && status >= 500 && status <= 599) {
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
    hasAny(text, [
      'endpoint must',
      'model must',
      'invalid endpoint',
      'invalid configuration',
      'request body is too large'
    ])
  ) {
    return 'invalid_configuration'
  }
  if (
    error instanceof TypeError ||
    hasAny(text, [
      'invalid shape',
      'invalid result',
      'invalid index',
      'invalid score',
      'result count',
      'must contain exactly',
      'response item',
      'valid json',
      'response is too large',
      'invalid response'
    ])
  ) {
    return 'invalid_response'
  }
  if (error instanceof RangeError) {
    return 'invalid_configuration'
  }
  return 'unknown'
}

/**
 * Converts provider and transport failures to bounded, localized data. Raw
 * bodies, endpoints, credentials and nested causes are never copied.
 */
export function classifyRerankError(
  error: unknown,
  options: { cancelled?: boolean; timedOut?: boolean } = {}
): RerankSafeError {
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

export class RerankOperationError extends Error {
  readonly code: RerankErrorCode
  readonly retryable: boolean
  readonly remedy?: string

  constructor(error: RerankSafeError) {
    super(error.message)
    this.name = 'RerankOperationError'
    this.code = error.code
    this.retryable = error.retryable
    this.remedy = error.remedy
  }

  toSafeError(): RerankSafeError {
    return {
      code: this.code,
      message: this.message,
      retryable: this.retryable,
      ...(this.remedy ? { remedy: this.remedy } : {})
    }
  }
}

export function toRerankOperationError(
  error: unknown,
  options?: { cancelled?: boolean; timedOut?: boolean }
): RerankOperationError {
  return error instanceof RerankOperationError
    ? error
    : new RerankOperationError(classifyRerankError(error, options))
}

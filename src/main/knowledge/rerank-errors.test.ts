import { describe, expect, it } from 'vitest'
import {
  classifyRerankError,
  RerankOperationError,
  toRerankOperationError
} from './rerank-errors'

describe('rerank error classification', () => {
  it.each([
    [new Error('Rerank request failed with HTTP 404'), 'model_not_found'],
    [new Error('unknown model vendor/rerank-v9'), 'model_not_found'],
    [{ status: 401 }, 'authentication'],
    [new Error('Incorrect API key provided'), 'authentication'],
    [{ statusCode: 429 }, 'rate_limited'],
    [new Error('request ETIMEDOUT'), 'timeout'],
    [new TypeError('fetch failed'), 'network'],
    [{ code: 503 }, 'provider_unavailable']
  ])('classifies %p as %s', (error, code) => {
    expect(classifyRerankError(error).code).toBe(code)
  })

  it('distinguishes explicit cancellation from timeout aborts', () => {
    const abort = new Error('The operation was aborted')
    abort.name = 'AbortError'
    expect(classifyRerankError(abort).code).toBe('cancelled')
    expect(classifyRerankError(abort, { timedOut: true }).code).toBe(
      'cancelled'
    )
    const timeout = new Error('Rerank request timed out')
    timeout.name = 'TimeoutError'
    expect(classifyRerankError(timeout, { cancelled: true }).code).toBe(
      'timeout'
    )
  })

  it('separates invalid configuration from invalid provider responses', () => {
    expect(
      classifyRerankError(
        new RangeError('endpoint must use HTTP or HTTPS')
      ).code
    ).toBe('invalid_configuration')
    expect(
      classifyRerankError(
        new RangeError('Rerank response is too large')
      ).code
    ).toBe('invalid_response')
    expect(
      classifyRerankError(
        new Error('Rerank response must contain exactly 2 results')
      ).code
    ).toBe('invalid_response')
  })

  it('never returns provider bodies, credentials, endpoints or causes', () => {
    const secret =
      'rk-secret-value https://rerank.example/v1 {"private":"document"}'
    const source = Object.assign(new Error(secret), {
      status: 401,
      response: {
        body: secret,
        headers: { authorization: `Bearer ${secret}` }
      },
      cause: new Error(secret)
    })

    const result = classifyRerankError(source)
    const serialized = JSON.stringify(result)
    expect(result).toEqual({
      code: 'authentication',
      message: '重排服务身份验证失败。',
      retryable: false,
      remedy: '请检查访问密钥是否有效以及是否具备调用重排模型的权限。'
    })
    expect(serialized).not.toContain('secret')
    expect(serialized).not.toContain('rerank.example')
    expect(serialized).not.toContain('private')
  })

  it('wraps unknown errors in a safe serializable operation error', () => {
    const wrapped = toRerankOperationError(
      new Error('raw provider payload with token')
    )
    expect(wrapped).toBeInstanceOf(RerankOperationError)
    expect(wrapped.toSafeError()).toEqual({
      code: 'unknown',
      message: '重排操作失败。',
      retryable: false,
      remedy: '请检查重排服务配置后重试。'
    })
    expect(JSON.stringify(wrapped.toSafeError())).not.toContain('token')
    expect(toRerankOperationError(wrapped)).toBe(wrapped)
  })
})

import { describe, expect, it } from 'vitest'
import {
  classifyEmbeddingError,
  EmbeddingOperationError,
  toEmbeddingOperationError
} from './embedding-errors'

describe('embedding error classification', () => {
  it.each([
    [new Error('Embedding request failed with HTTP 404'), 'model_not_found'],
    [new Error('unknown model vendor/embed-v9'), 'model_not_found'],
    [{ status: 401 }, 'authentication'],
    [new Error('Incorrect API key provided'), 'authentication'],
    [{ statusCode: 429 }, 'rate_limited'],
    [new Error('request ETIMEDOUT'), 'timeout'],
    [new TypeError('fetch failed'), 'network'],
    [{ code: 503 }, 'provider_unavailable']
  ])('classifies %p as %s', (error, code) => {
    expect(classifyEmbeddingError(error).code).toBe(code)
  })

  it('distinguishes explicit cancellation from timeout aborts', () => {
    const abort = new Error('The operation was aborted')
    abort.name = 'AbortError'
    expect(classifyEmbeddingError(abort).code).toBe('cancelled')
    expect(
      classifyEmbeddingError(abort, { timedOut: true }).code
    ).toBe('cancelled')
    expect(
      classifyEmbeddingError(new Error('request stopped'), {
        timedOut: true
      }).code
    ).toBe('timeout')
    const timeout = new Error('Embedding request timed out')
    timeout.name = 'TimeoutError'
    expect(
      classifyEmbeddingError(timeout, { cancelled: true }).code
    ).toBe('timeout')
  })

  it('never returns provider bodies, credentials, endpoints or nested causes', () => {
    const secret =
      'sk-secret-value https://vectors.example/v1 {"private":"document"}'
    const source = Object.assign(new Error(secret), {
      status: 401,
      response: {
        body: secret,
        headers: { authorization: `Bearer ${secret}` }
      },
      cause: new Error(secret)
    })

    const result = classifyEmbeddingError(source)
    const serialized = JSON.stringify(result)
    expect(result).toEqual({
      code: 'authentication',
      message: '向量服务身份验证失败。',
      retryable: false,
      remedy: '请检查访问密钥是否有效以及是否具备调用向量模型的权限。'
    })
    expect(serialized).not.toContain('secret')
    expect(serialized).not.toContain('vectors.example')
    expect(serialized).not.toContain('private')
  })

  it('wraps unknown errors in a safe serializable operation error', () => {
    const wrapped = toEmbeddingOperationError(
      new Error('raw provider payload with token')
    )
    expect(wrapped).toBeInstanceOf(EmbeddingOperationError)
    expect(wrapped.toSafeError()).toEqual({
      code: 'unknown',
      message: '向量操作失败。',
      retryable: false,
      remedy: '请检查向量服务配置后重试。'
    })
    expect(JSON.stringify(wrapped.toSafeError())).not.toContain('token')
    expect(toEmbeddingOperationError(wrapped)).toBe(wrapped)
  })
})

import { describe, expect, it } from 'vitest'
import {
  rerankConfigurationSummarySchema,
  rerankDiagnosticResultSchema,
  rerankExecutionDiagnosticsSchema,
  rerankSafeErrorSchema
} from './rerank-contracts'

describe('rerank contracts', () => {
  it('publishes configuration without coupling it to credentials', () => {
    expect(
      rerankConfigurationSummarySchema.parse({
        provider: 'cohere-compatible',
        model: 'rerank-v3.5',
        endpoint: 'https://api.example/v1/rerank',
        credentialConfigured: true
      })
    ).toEqual({
      provider: 'cohere-compatible',
      model: 'rerank-v3.5',
      endpoint: 'https://api.example/v1/rerank',
      credentialConfigured: true
    })
    expect(
      rerankConfigurationSummarySchema.safeParse({
        provider: 'cohere-compatible',
        model: 'rerank-v3.5',
        credentialConfigured: true,
        apiKey: 'secret'
      }).success
    ).toBe(false)
  })

  it('accepts safe available and unavailable diagnostics', () => {
    expect(
      rerankDiagnosticResultSchema.safeParse({
        status: 'available',
        provider: 'cohere-compatible',
        model: 'rerank-v3.5',
        checkedAt: 1_700_000_000_000,
        latencyMs: 82
      }).success
    ).toBe(true)
    expect(
      rerankDiagnosticResultSchema.safeParse({
        status: 'unavailable',
        provider: 'cohere-compatible',
        model: 'rerank-v3.5',
        checkedAt: 1_700_000_000_000,
        latencyMs: 82,
        error: {
          code: 'authentication',
          message: '重排服务身份验证失败。',
          retryable: false
        }
      }).success
    ).toBe(true)
  })

  it('bounds safe errors and rejects raw provider details', () => {
    expect(
      rerankSafeErrorSchema.safeParse({
        code: 'unknown',
        message: 'x'.repeat(501),
        retryable: false
      }).success
    ).toBe(false)
    expect(
      rerankSafeErrorSchema.safeParse({
        code: 'authentication',
        message: '重排服务身份验证失败。',
        retryable: false,
        rawResponse: '{"token":"secret"}'
      }).success
    ).toBe(false)
  })

  it('describes requested, used and fallback rerank modes safely', () => {
    expect(
      rerankExecutionDiagnosticsSchema.parse({
        requested: 'learned',
        used: 'learned',
        status: 'applied',
        candidateCount: 24,
        durationMs: 91,
        model: 'rerank-v3.5'
      })
    ).toMatchObject({ status: 'applied', used: 'learned' })
    expect(
      rerankExecutionDiagnosticsSchema.safeParse({
        requested: 'learned',
        used: 'local',
        status: 'fallback',
        candidateCount: 24,
        durationMs: 91,
        reason: '服务暂时不可用。'
      }).success
    ).toBe(true)
    expect(
      rerankExecutionDiagnosticsSchema.safeParse({
        requested: 'learned',
        used: 'learned',
        status: 'fallback',
        candidateCount: 24,
        durationMs: 91,
        model: 'rerank-v3.5'
      }).success
    ).toBe(false)
    expect(
      rerankExecutionDiagnosticsSchema.safeParse({
        requested: 'none',
        used: 'none',
        status: 'skipped',
        candidateCount: 101,
        durationMs: 0
      }).success
    ).toBe(false)
  })
})

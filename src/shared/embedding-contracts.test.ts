import { describe, expect, it } from 'vitest'
import {
  embeddingDiagnosticResultSchema,
  embeddingIndexJobSchema,
  embeddingIndexStatusSchema,
  embeddingSettingsSnapshotSchema,
  knowledgeEmbeddingIndexSnapshotSchema,
  embeddingSafeErrorSchema,
  isEmbeddingIndexJobActive
} from './embedding-contracts'

describe('embedding contracts', () => {
  it('accepts a real successful model test result', () => {
    expect(
      embeddingDiagnosticResultSchema.parse({
        status: 'available',
        provider: 'openai-compatible',
        model: 'text-embedding-3-small',
        checkedAt: 1_700_000_000_000,
        latencyMs: 184,
        dimensions: 1_536
      })
    ).toMatchObject({
      status: 'available',
      latencyMs: 184,
      dimensions: 1_536
    })
    expect(
      embeddingDiagnosticResultSchema.safeParse({
        status: 'available',
        provider: 'provider',
        model: 'slow-local-model',
        checkedAt: 1_700_000_000_000,
        latencyMs: 120_001,
        dimensions: 4_096
      }).success
    ).toBe(true)

    expect(
      embeddingDiagnosticResultSchema.safeParse({
        status: 'available',
        provider: 'provider',
        model: 'model',
        checkedAt: 1,
        latencyMs: 1,
        dimensions: 0,
        reachable: true
      }).success
    ).toBe(false)
  })

  it('bounds safe failures and excludes raw provider details', () => {
    expect(
      embeddingSafeErrorSchema.safeParse({
        code: 'authentication',
        message: '身份验证失败。',
        retryable: false,
        rawResponse: '{"api_key":"secret"}'
      }).success
    ).toBe(false)
    expect(
      embeddingSafeErrorSchema.safeParse({
        code: 'unknown',
        message: 'x'.repeat(501),
        retryable: false
      }).success
    ).toBe(false)
  })

  it('keeps credentials, vectors, and Main-only paths out of settings snapshots', () => {
    const snapshot = {
      configuration: {
        provider: 'builtin',
        model: 'granite-embedding',
        credentialConfigured: false
      },
      connections: [
        {
          id: '00000000-0000-4000-8000-000000000002',
          name: 'GoodBuddy built-in',
          kind: 'builtin' as const,
          model: 'granite-embedding',
          credentialConfigured: false
        }
      ],
      currentConnectionId:
        '00000000-0000-4000-8000-000000000002',
      models: {
        selectedDownloadSource: 'modelscope' as const,
        catalog: [],
        installed: [],
        operations: []
      }
    }
    expect(
      embeddingSettingsSnapshotSchema.safeParse(snapshot).success
    ).toBe(true)
    for (const forbidden of [
      { apiKey: 'secret' },
      { vectors: [[0.1, 0.2]] },
      { modelDirectory: 'C:\\private\\embedding' }
    ]) {
      expect(
        embeddingSettingsSnapshotSchema.safeParse({
          ...snapshot,
          ...forbidden
        }).success
      ).toBe(false)
    }
  })

  it('validates queued, running and terminal index jobs', () => {
    const base = {
      id: 'job-1',
      provider: 'provider',
      model: 'model',
      createdAt: 10
    }
    const queued = embeddingIndexJobSchema.parse({
      ...base,
      status: 'queued',
      progress: { completed: 0, total: 0, percent: 0 }
    })
    const running = embeddingIndexJobSchema.parse({
      ...base,
      status: 'running',
      startedAt: 11,
      progress: { completed: 3, total: 4, percent: 75 }
    })
    expect(isEmbeddingIndexJobActive(queued)).toBe(true)
    expect(isEmbeddingIndexJobActive(running)).toBe(true)

    for (const status of ['completed', 'failed', 'cancelled'] as const) {
      const result = embeddingIndexJobSchema.safeParse({
        ...base,
        status,
        startedAt: 11,
        completedAt: 12,
        progress:
          status === 'completed'
            ? { completed: 4, total: 4, percent: 100 }
            : { completed: 2, total: 4, percent: 50 },
        ...(status === 'failed'
          ? {
              error: {
                code: 'network',
                message: '无法连接到向量服务。',
                retryable: true
              }
            }
          : {})
      })
      expect(result.success, status).toBe(true)
    }
  })

  it('exposes only the persisted rebuild job in index status', () => {
    const parsed = embeddingIndexStatusSchema.parse({
      job: {
        id: 'job-new',
        status: 'running',
        provider: 'provider',
        model: 'new-model',
        progress: { completed: 5, total: 20, percent: 25 },
        createdAt: 11,
        startedAt: 12
      }
    })
    expect(parsed.job?.model).toBe('new-model')
    expect(
      embeddingIndexStatusSchema.safeParse({
        job: null,
        servingSnapshot: null
      }).success
    ).toBe(false)
  })

  it('validates library-scoped embedding coverage totals', () => {
    const base = {
      knowledgeBaseId: '11111111-1111-4111-8111-111111111111',
      enabled: true,
      coverage: { total: 4, indexed: 2, missing: 1, error: 1 },
      indexStatus: { job: null }
    }
    expect(
      knowledgeEmbeddingIndexSnapshotSchema.safeParse(base).success
    ).toBe(true)
    expect(
      knowledgeEmbeddingIndexSnapshotSchema.safeParse({
        ...base,
        coverage: { total: 4, indexed: 2, missing: 2, error: 1 }
      }).success
    ).toBe(false)
  })
})

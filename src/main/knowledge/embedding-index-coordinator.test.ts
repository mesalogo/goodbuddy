import { describe, expect, it, vi } from 'vitest'
import type {
  EmbeddingIndexJob,
  EmbeddingIndexStatus
} from '../../shared/embedding-contracts'
import {
  EmbeddingIndexCoordinator,
  type EmbeddingIndexProvider,
  type EmbeddingIndexRecord,
  type EmbeddingIndexRepository
} from './embedding-index-coordinator'

class MemoryRepository implements EmbeddingIndexRepository {
  readonly documents = [
    {
      id: 'document-1',
      items: [
        { id: 'chunk-1', content: 'alpha', contentChecksum: 'sum-1' }
      ]
    },
    {
      id: 'document-2',
      items: [
        { id: 'chunk-2', content: 'beta', contentChecksum: 'sum-2' },
        { id: 'chunk-3', content: 'gamma', contentChecksum: 'sum-3' }
      ]
    }
  ]
  readonly records = new Map<string, readonly EmbeddingIndexRecord[]>([
    [
      'document-1',
      [{ itemId: 'chunk-1', contentChecksum: 'sum-1', vector: [0, 1] }]
    ],
    [
      'document-2',
      [
        { itemId: 'chunk-2', contentChecksum: 'sum-2', vector: [0, 1] },
        { itemId: 'chunk-3', contentChecksum: 'sum-3', vector: [0, 1] }
      ]
    ]
  ])
  readonly errors = new Map<string, string>()
  readonly pendingRecords = new Map<
    string,
    { documentId: string; records: EmbeddingIndexRecord[] }
  >()
  readonly events: string[] = []
  lastJob: EmbeddingIndexJob | null = null
  readonly savedStatuses: EmbeddingIndexStatus[] = []

  async getLastJob(): Promise<EmbeddingIndexJob | null> {
    return this.lastJob
  }

  async saveStatus(status: EmbeddingIndexStatus): Promise<void> {
    this.savedStatuses.push(status)
    this.lastJob = status.job
  }

  async listIndexDocumentIds(): Promise<string[]> {
    return this.documents.map((document) => document.id)
  }

  async getIndexDocument(
    documentId: string
  ): Promise<(typeof this.documents)[number] | undefined> {
    this.events.push(`load:${documentId}`)
    return this.documents.find((document) => document.id === documentId)
  }

  async beginDocumentReplacement(
    documentId: string
  ): Promise<string> {
    const replacementId = `replacement-${documentId}`
    this.pendingRecords.set(replacementId, {
      documentId,
      records: []
    })
    this.events.push(`begin:${documentId}`)
    return replacementId
  }

  async appendDocumentReplacement(
    replacementId: string,
    _documentId: string,
    _provider: string,
    _model: string,
    records: readonly EmbeddingIndexRecord[]
  ): Promise<void> {
    this.pendingRecords.get(replacementId)?.records.push(...records)
    this.events.push(`append:${replacementId}`)
  }

  async finishDocumentReplacement(
    replacementId: string,
    documentId: string
  ): Promise<void> {
    const pending = this.pendingRecords.get(replacementId)
    if (!pending) {
      throw new Error('Missing pending replacement')
    }
    this.records.set(documentId, pending.records)
    this.errors.delete(documentId)
    this.pendingRecords.delete(replacementId)
    this.events.push(`finish:${documentId}`)
  }

  async discardDocumentReplacement(
    replacementId: string
  ): Promise<void> {
    this.pendingRecords.delete(replacementId)
    this.events.push(`discard:${replacementId}`)
  }

  async recordDocumentError(
    documentId: string,
    _provider: string,
    _model: string,
    error: string
  ): Promise<void> {
    this.errors.set(documentId, error)
  }
}

function provider(
  embed: EmbeddingIndexProvider['embed']
): EmbeddingIndexProvider {
  return {
    provider: 'openai-compatible',
    model: 'embed-v2',
    fingerprint: 'openai-compatible:https://safe.invalid:embed-v2',
    embed
  }
}

describe('EmbeddingIndexCoordinator', () => {
  it('performs a real embedding request for diagnostics', async () => {
    const repository = new MemoryRepository()
    const embed = vi.fn(async () => [[0.25, 0.5, 0.75]])
    const times = [100, 137]
    const coordinator = new EmbeddingIndexCoordinator(repository, {
      now: () => times.shift() ?? 137
    })

    await expect(coordinator.diagnose(provider(embed))).resolves.toEqual({
      status: 'available',
      provider: 'openai-compatible',
      model: 'embed-v2',
      checkedAt: 137,
      latencyMs: 37,
      dimensions: 3
    })
    expect(embed).toHaveBeenCalledWith(
      ['GoodBuddy 向量模型连接测试'],
      undefined
    )
  })

  it('reports a safe diagnostic failure instead of treating config as success', async () => {
    const repository = new MemoryRepository()
    const coordinator = new EmbeddingIndexCoordinator(repository, {
      now: () => 100
    })
    const result = await coordinator.diagnose(
      provider(async () => {
        throw Object.assign(
          new Error('Bearer sk-secret failed with private payload'),
          { status: 401 }
        )
      })
    )

    expect(result).toMatchObject({
      status: 'unavailable',
      error: {
        code: 'authentication',
        retryable: false
      }
    })
    expect(JSON.stringify(result)).not.toContain('sk-secret')
    expect(JSON.stringify(result)).not.toContain('private payload')
  })

  it('preserves a provider timeout when the diagnostic signal aborts later', async () => {
    const repository = new MemoryRepository()
    const coordinator = new EmbeddingIndexCoordinator(repository)
    const controller = new AbortController()
    let rejectProvider:
      | ((reason?: unknown) => void)
      | undefined
    const diagnostic = coordinator.diagnose(
      provider(
        () =>
          new Promise<number[][]>((_resolve, reject) => {
            rejectProvider = reject
          })
      ),
      { signal: controller.signal }
    )
    await vi.waitFor(() => {
      expect(rejectProvider).toBeDefined()
    })

    const timeout = new Error('Embedding request timed out')
    timeout.name = 'TimeoutError'
    controller.abort()
    rejectProvider?.(timeout)

    await expect(diagnostic).resolves.toMatchObject({
      status: 'unavailable',
      error: {
        code: 'timeout'
      }
    })
  })

  it('keeps diagnostics independent from an active rebuild cancellation', async () => {
    const repository = new MemoryRepository()
    let rebuildSignal: AbortSignal | undefined
    let resolveDiagnostic: ((vectors: number[][]) => void) | undefined
    const embed = vi.fn<EmbeddingIndexProvider['embed']>(
      (input, signal) => {
        if (input[0] === 'GoodBuddy 向量模型连接测试') {
          return new Promise<number[][]>((resolve) => {
            resolveDiagnostic = resolve
          })
        }
        return new Promise<number[][]>((_resolve, reject) => {
          rebuildSignal = signal
          signal?.addEventListener(
            'abort',
            () => reject(signal.reason),
            { once: true }
          )
        })
      }
    )
    const sharedProvider = provider(embed)
    const coordinator = new EmbeddingIndexCoordinator(repository, {
      createId: () => 'job-concurrent'
    })
    coordinator.startRebuild(sharedProvider)
    await vi.waitFor(() => {
      expect(rebuildSignal).toBeDefined()
    })

    const diagnostic = coordinator.diagnose(sharedProvider)
    await vi.waitFor(() => {
      expect(resolveDiagnostic).toBeDefined()
    })
    expect(coordinator.cancel('job-concurrent')).toBe(true)
    resolveDiagnostic?.([[0.25, 0.5, 0.75]])

    await expect(diagnostic).resolves.toMatchObject({
      status: 'available',
      dimensions: 3
    })
    await expect(coordinator.waitForCompletion()).resolves.toMatchObject({
      status: 'cancelled'
    })
    expect(embed.mock.calls).toContainEqual([
      ['GoodBuddy 向量模型连接测试'],
      undefined
    ])
  })

  it('replaces each document atomically and persists completed progress', async () => {
    const repository = new MemoryRepository()
    const coordinator = new EmbeddingIndexCoordinator(repository, {
      batchSize: 2,
      now: (() => {
        let value = 10
        return () => value++
      })(),
      createId: () => 'job-1'
    })
    await coordinator.initialize()
    const statuses: string[] = []
    coordinator.subscribe((status) => {
      statuses.push(status.job?.status ?? 'idle')
    })

    const queued = coordinator.startRebuild(
      provider(async (input) =>
        input.map((text) =>
          text === 'beta' ? [0, 1] : [1, 0]
        )
      )
    )
    expect(queued.status).toBe('queued')

    const completed = await coordinator.waitForCompletion()
    expect(completed).toMatchObject({
      status: 'completed',
      progress: { completed: 2, total: 2, percent: 100 }
    })
    expect(statuses).toContain('queued')
    expect(statuses).toContain('running')
    expect(statuses.at(-1)).toBe('completed')
    expect(repository.records.get('document-1')).toEqual([
      expect.objectContaining({ itemId: 'chunk-1', vector: [1, 0] })
    ])
    expect(repository.records.get('document-2')).toEqual([
      expect.objectContaining({ itemId: 'chunk-2', vector: [0, 1] }),
      expect.objectContaining({ itemId: 'chunk-3', vector: [1, 0] })
    ])
    expect(repository.events.indexOf('finish:document-1')).toBeLessThan(
      repository.events.indexOf('load:document-2')
    )
    expect(repository.pendingRecords.size).toBe(0)
    expect(repository.lastJob).toEqual(completed)
  })

  it('keeps completed documents and records a safe error on the failed document', async () => {
    const repository = new MemoryRepository()
    const coordinator = new EmbeddingIndexCoordinator(repository, {
      batchSize: 2,
      now: () => 20,
      createId: () => 'job-failed'
    })
    await coordinator.initialize()
    coordinator.startRebuild(
      provider(async (input) => {
        if (input.includes('beta')) {
          throw Object.assign(new Error('raw upstream token sk-private'), {
            status: 429
          })
        }
        return input.map(() => [1, 0])
      })
    )

    const failed = await coordinator.waitForCompletion()
    expect(failed).toMatchObject({
      status: 'failed',
      error: {
        code: 'rate_limited',
        retryable: true
      }
    })
    expect(JSON.stringify(failed)).not.toContain('sk-private')
    expect(failed?.progress).toEqual({
      completed: 1,
      total: 2,
      percent: 50
    })
    expect(repository.records.get('document-1')?.[0]?.vector).toEqual([1, 0])
    expect(repository.records.get('document-2')?.[0]?.vector).toEqual([0, 1])
    expect(repository.errors.get('document-2')).toBe(
      '向量服务当前请求过多。'
    )
    expect(repository.pendingRecords.size).toBe(0)
    expect(JSON.stringify(repository.savedStatuses)).not.toContain(
      'sk-private'
    )
  })

  it('keeps completed documents and leaves unfinished documents unchanged when cancelled', async () => {
    const repository = new MemoryRepository()
    let receivedSignal: AbortSignal | undefined
    const coordinator = new EmbeddingIndexCoordinator(repository, {
      now: () => 30,
      createId: () => 'job-cancelled'
    })
    await coordinator.initialize()
    coordinator.startRebuild(
      provider(
        (input, signal) => {
          if (input.includes('alpha')) {
            return Promise.resolve(input.map(() => [1, 0]))
          }
          return new Promise<number[][]>((_resolve, reject) => {
            receivedSignal = signal
            signal?.addEventListener(
              'abort',
              () => reject(signal.reason),
              { once: true }
            )
          })
        }
      )
    )
    await vi.waitFor(() => {
      expect(coordinator.status().job?.status).toBe('running')
      expect(receivedSignal).toBeDefined()
    })

    expect(coordinator.cancel('another-job')).toBe(false)
    expect(coordinator.cancel('job-cancelled')).toBe(true)
    const cancelled = await coordinator.waitForCompletion()

    expect(receivedSignal?.aborted).toBe(true)
    expect(cancelled).toMatchObject({
      status: 'cancelled',
      completedAt: 30,
      progress: { completed: 1, total: 2, percent: 50 }
    })
    expect(cancelled).not.toHaveProperty('error')
    expect(repository.records.get('document-1')?.[0]?.vector).toEqual([1, 0])
    expect(repository.records.get('document-2')?.[0]?.vector).toEqual([0, 1])
    expect(repository.errors.has('document-2')).toBe(false)
    expect(repository.pendingRecords.size).toBe(0)
    expect(repository.lastJob).toEqual(cancelled)
  })

  it('preserves a provider timeout when rebuild cancellation arrives later', async () => {
    const repository = new MemoryRepository()
    const coordinator = new EmbeddingIndexCoordinator(repository, {
      createId: () => 'job-timeout'
    })
    let rejectProvider:
      | ((reason?: unknown) => void)
      | undefined
    coordinator.startRebuild(
      provider(
        () =>
          new Promise<number[][]>((_resolve, reject) => {
            rejectProvider = reject
          })
      )
    )
    await vi.waitFor(() => {
      expect(rejectProvider).toBeDefined()
    })

    const timeout = new Error('Embedding request timed out')
    timeout.name = 'TimeoutError'
    expect(coordinator.cancel('job-timeout')).toBe(true)
    rejectProvider?.(timeout)

    await expect(coordinator.waitForCompletion()).resolves.toMatchObject({
      status: 'failed',
      error: {
        code: 'timeout'
      }
    })
    expect(repository.errors.get('document-1')).toBe(
      '向量服务响应超时。'
    )
  })

  it('marks an interrupted persisted job cancelled during initialization', async () => {
    const repository = new MemoryRepository()
    repository.lastJob = {
      id: 'interrupted-job',
      status: 'running',
      provider: 'provider',
      model: 'model',
      progress: { completed: 1, total: 2, percent: 50 },
      createdAt: 10,
      startedAt: 11
    }
    const coordinator = new EmbeddingIndexCoordinator(repository, {
      now: () => 12
    })

    await expect(coordinator.initialize()).resolves.toEqual({
      job: expect.objectContaining({
        id: 'interrupted-job',
        status: 'cancelled',
        completedAt: 12
      })
    })
    expect(repository.lastJob).toMatchObject({
      status: 'cancelled',
      completedAt: 12
    })
  })

  it('rejects overlapping rebuilds', async () => {
    const repository = new MemoryRepository()
    const coordinator = new EmbeddingIndexCoordinator(repository)
    coordinator.startRebuild(
      provider(
        (_input, signal) =>
          new Promise<number[][]>((_resolve, reject) => {
            signal?.addEventListener('abort', () => reject(signal.reason), {
              once: true
            })
          })
      )
    )
    expect(() =>
      coordinator.startRebuild(provider(async () => [[1, 0]]))
    ).toThrow('already active')
    coordinator.cancel()
    await coordinator.waitForCompletion()
  })
})

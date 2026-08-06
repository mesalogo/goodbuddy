import { randomUUID } from 'node:crypto'
import type {
  EmbeddingDiagnosticResult,
  EmbeddingIndexJob,
  EmbeddingIndexStatus
} from '../../shared/embedding-contracts'
import {
  classifyEmbeddingError,
  EmbeddingOperationError
} from './embedding-errors'

const DEFAULT_BATCH_SIZE = 32
const MAX_BATCH_SIZE = 256
const MAX_VECTOR_DIMENSIONS = 8_192

export interface EmbeddingIndexProvider {
  readonly provider: string
  readonly model: string
  readonly fingerprint?: string
  embed(input: readonly string[], signal?: AbortSignal): Promise<number[][]>
}

export interface EmbeddingIndexItem {
  id: string
  content: string
  contentChecksum?: string
}

export interface EmbeddingIndexRecord {
  itemId: string
  contentChecksum?: string
  vector: readonly number[]
}

export interface EmbeddingIndexDocument {
  id: string
  items: readonly EmbeddingIndexItem[]
}

export interface EmbeddingIndexRepository {
  getLastJob?(): Promise<EmbeddingIndexJob | null>
  saveStatus?(status: EmbeddingIndexStatus): Promise<void>
  listIndexDocumentIds(
    signal: AbortSignal
  ): Promise<readonly string[]>
  getIndexDocument(
    documentId: string,
    signal: AbortSignal
  ): Promise<EmbeddingIndexDocument | undefined>
  beginDocumentReplacement(
    documentId: string,
    provider: string,
    model: string,
    signal: AbortSignal
  ): Promise<string>
  appendDocumentReplacement(
    replacementId: string,
    documentId: string,
    provider: string,
    model: string,
    records: readonly EmbeddingIndexRecord[],
    signal: AbortSignal
  ): Promise<void>
  finishDocumentReplacement(
    replacementId: string,
    documentId: string,
    provider: string,
    model: string,
    signal: AbortSignal
  ): Promise<void>
  discardDocumentReplacement(replacementId: string): Promise<void>
  recordDocumentError(
    documentId: string,
    provider: string,
    model: string,
    error: string
  ): Promise<void>
}

export interface EmbeddingIndexCoordinatorOptions {
  batchSize?: number
  now?: () => number
  createId?: () => string
}

export interface EmbeddingDiagnosticOptions {
  signal?: AbortSignal
  probeText?: string
}

export interface EmbeddingRebuildOptions {
  signal?: AbortSignal
}

type JobListener = (status: EmbeddingIndexStatus) => void

function validatedLabel(value: string, name: string): string {
  const normalized = value.trim()
  if (normalized.length < 1 || normalized.length > 256) {
    throw new RangeError(`${name} must contain between 1 and 256 characters`)
  }
  return normalized
}

function validateVector(
  vector: readonly number[],
  expectedDimensions?: number
): number {
  if (
    !Array.isArray(vector) ||
    vector.length < 1 ||
    vector.length > MAX_VECTOR_DIMENSIONS
  ) {
    throw new EmbeddingOperationError({
      code: 'invalid_response',
      message: '向量服务返回了无效结果。',
      retryable: false,
      remedy: '请确认服务返回维度一致的有效向量。'
    })
  }
  let magnitudeSquared = 0
  for (const component of vector) {
    if (typeof component !== 'number' || !Number.isFinite(component)) {
      throw new EmbeddingOperationError({
        code: 'invalid_response',
        message: '向量服务返回了无效结果。',
        retryable: false,
        remedy: '请确认服务返回维度一致的有效向量。'
      })
    }
    magnitudeSquared += component * component
  }
  if (
    !Number.isFinite(magnitudeSquared) ||
    magnitudeSquared <= 0 ||
    (expectedDimensions !== undefined &&
      vector.length !== expectedDimensions)
  ) {
    throw new EmbeddingOperationError({
      code: 'invalid_response',
      message: '向量服务返回了无效结果。',
      retryable: false,
      remedy: '请确认服务返回维度一致的有效向量。'
    })
  }
  return vector.length
}

function percent(completed: number, total: number): number {
  return total === 0 ? 0 : (completed / total) * 100
}

export class EmbeddingIndexCoordinator {
  private readonly repository: EmbeddingIndexRepository
  private readonly batchSize: number
  private readonly now: () => number
  private readonly createId: () => string
  private readonly listeners = new Set<JobListener>()
  private job: EmbeddingIndexJob | null = null
  private controller: AbortController | null = null
  private completion: Promise<EmbeddingIndexJob> | null = null
  private persistenceTail: Promise<void> = Promise.resolve()

  constructor(
    repository: EmbeddingIndexRepository,
    options: EmbeddingIndexCoordinatorOptions = {}
  ) {
    this.repository = repository
    const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE
    if (
      !Number.isSafeInteger(batchSize) ||
      batchSize < 1 ||
      batchSize > MAX_BATCH_SIZE
    ) {
      throw new RangeError(
        `batchSize must be an integer between 1 and ${MAX_BATCH_SIZE}`
      )
    }
    this.batchSize = batchSize
    this.now = options.now ?? Date.now
    this.createId = options.createId ?? randomUUID
  }

  async initialize(): Promise<EmbeddingIndexStatus> {
    this.job = (await this.repository.getLastJob?.()) ?? null
    if (
      this.job?.status === 'queued' ||
      this.job?.status === 'running'
    ) {
      this.job = {
        ...this.job,
        status: 'cancelled',
        completedAt: this.now()
      }
      await this.persistStatus()
    }
    return this.status()
  }

  status(): EmbeddingIndexStatus {
    return {
      job: this.job
    }
  }

  subscribe(listener: JobListener): () => void {
    this.listeners.add(listener)
    listener(this.status())
    return () => {
      this.listeners.delete(listener)
    }
  }

  async diagnose(
    provider: EmbeddingIndexProvider,
    options: EmbeddingDiagnosticOptions = {}
  ): Promise<EmbeddingDiagnosticResult> {
    const providerName = validatedLabel(provider.provider, 'provider')
    const model = validatedLabel(provider.model, 'model')
    const startedAt = this.now()
    try {
      const vectors = await provider.embed(
        [options.probeText ?? 'GoodBuddy 向量模型连接测试'],
        options.signal
      )
      if (vectors.length !== 1 || !vectors[0]) {
        throw new EmbeddingOperationError({
          code: 'invalid_response',
          message: '向量服务返回了无效结果。',
          retryable: false,
          remedy: '请确认服务为每个输入返回一个有效向量。'
        })
      }
      const dimensions = validateVector(vectors[0])
      const checkedAt = this.now()
      return {
        status: 'available',
        provider: providerName,
        model,
        checkedAt,
        latencyMs: Math.max(0, checkedAt - startedAt),
        dimensions
      }
    } catch (error) {
      const checkedAt = this.now()
      return {
        status: 'unavailable',
        provider: providerName,
        model,
        checkedAt,
        latencyMs: Math.max(0, checkedAt - startedAt),
        error:
          error instanceof EmbeddingOperationError
            ? error.toSafeError()
            : classifyEmbeddingError(error, {
                cancelled: options.signal?.aborted
              })
      }
    }
  }

  startRebuild(
    provider: EmbeddingIndexProvider,
    options: EmbeddingRebuildOptions = {}
  ): EmbeddingIndexJob {
    if (
      this.job?.status === 'queued' ||
      this.job?.status === 'running'
    ) {
      throw new Error('An embedding index rebuild is already active')
    }
    const providerName = validatedLabel(provider.provider, 'provider')
    const model = validatedLabel(provider.model, 'model')
    const controller = new AbortController()
    const createdAt = this.now()
    this.job = {
      id: this.createId(),
      status: 'queued',
      provider: providerName,
      model,
      progress: { completed: 0, total: 0, percent: 0 },
      createdAt
    }
    this.controller = controller
    this.emit()

    const externalSignal = options.signal
    const forwardAbort = (): void => {
      controller.abort(externalSignal?.reason)
    }
    if (externalSignal?.aborted) {
      forwardAbort()
    } else {
      externalSignal?.addEventListener('abort', forwardAbort, {
        once: true
      })
    }

    this.completion = Promise.resolve()
      .then(() => this.runRebuild(provider, controller.signal))
      .finally(() => {
        externalSignal?.removeEventListener('abort', forwardAbort)
        if (this.controller === controller) {
          this.controller = null
        }
      })
    return this.job
  }

  async waitForCompletion(): Promise<EmbeddingIndexJob | null> {
    return this.completion
  }

  cancel(jobId?: string): boolean {
    if (
      !this.controller ||
      !this.job ||
      (jobId !== undefined && this.job.id !== jobId) ||
      !['queued', 'running'].includes(this.job.status)
    ) {
      return false
    }
    this.controller.abort(new Error('Embedding index rebuild cancelled'))
    return true
  }

  private async runRebuild(
    provider: EmbeddingIndexProvider,
    signal: AbortSignal
  ): Promise<EmbeddingIndexJob> {
    try {
      signal.throwIfAborted()
      const documentIds =
        await this.repository.listIndexDocumentIds(signal)
      signal.throwIfAborted()
      this.updateJob({
        status: 'running',
        startedAt: this.now(),
        progress: {
          completed: 0,
          total: documentIds.length,
          percent: 0
        }
      })

      let completed = 0
      let dimensions: number | undefined
      for (const documentId of documentIds) {
        signal.throwIfAborted()
        const document = await this.repository.getIndexDocument(
          documentId,
          signal
        )
        if (!document) {
          completed += 1
          this.updateJob({
            progress: {
              completed,
              total: documentIds.length,
              percent: percent(completed, documentIds.length)
            }
          })
          continue
        }
        const replacementId =
          await this.repository.beginDocumentReplacement(
            document.id,
            provider.provider,
            provider.model,
            signal
          )
        try {
          for (
            let offset = 0;
            offset < document.items.length;
            offset += this.batchSize
          ) {
            signal.throwIfAborted()
            const batch = document.items.slice(
              offset,
              offset + this.batchSize
            )
            const vectors = await provider.embed(
              batch.map((item) => item.content),
              signal
            )
            if (vectors.length !== batch.length) {
              throw new EmbeddingOperationError({
                code: 'invalid_response',
                message: '向量服务返回了无效结果。',
                retryable: false,
                remedy: '请确认服务为每个输入返回一个有效向量。'
              })
            }
            const records = batch.map((item, index) => {
                const vector = vectors[index]
                if (!vector) {
                  throw new EmbeddingOperationError({
                    code: 'invalid_response',
                    message: '向量服务返回了无效结果。',
                    retryable: false
                  })
                }
                dimensions = validateVector(vector, dimensions)
                return {
                  itemId: item.id,
                  ...(item.contentChecksum
                    ? { contentChecksum: item.contentChecksum }
                    : {}),
                  vector
                }
              })
            await this.repository.appendDocumentReplacement(
              replacementId,
              document.id,
              provider.provider,
              provider.model,
              records,
              signal
            )
          }
          signal.throwIfAborted()
          await this.repository.finishDocumentReplacement(
            replacementId,
            document.id,
            provider.provider,
            provider.model,
            signal
          )
        } catch (error) {
          await this.repository
            .discardDocumentReplacement(replacementId)
            .catch(() => undefined)
          const safeError =
            error instanceof EmbeddingOperationError
              ? error.toSafeError()
              : classifyEmbeddingError(error, {
                  cancelled: signal.aborted
                })
          if (safeError.code === 'cancelled') {
            throw error
          }
          await this.repository.recordDocumentError(
            document.id,
            provider.provider,
            provider.model,
            safeError.message
          )
          throw error
        }
        completed += 1
        this.updateJob({
          progress: {
            completed,
            total: documentIds.length,
            percent: percent(completed, documentIds.length)
          }
        })
      }

      signal.throwIfAborted()
      this.updateJob({
        status: 'completed',
        completedAt: this.now(),
        progress: {
          completed: documentIds.length,
          total: documentIds.length,
          percent: 100
        }
      })
    } catch (error) {
      const safeError =
        error instanceof EmbeddingOperationError
          ? error.toSafeError()
          : classifyEmbeddingError(error, {
              cancelled: signal.aborted
            })
      const cancelled = safeError.code === 'cancelled'
      this.updateJob(
        cancelled
          ? {
              status: 'cancelled',
              completedAt: this.now()
            }
          : {
              status: 'failed',
              completedAt: this.now(),
              error: safeError
            }
      )
    }
    await this.persistenceTail
    if (!this.job) {
      throw new Error('Embedding index job state was lost')
    }
    return this.job
  }

  private updateJob(update: Partial<EmbeddingIndexJob>): void {
    if (!this.job) {
      throw new Error('No embedding index job is active')
    }
    this.job = {
      ...this.job,
      ...update
    }
    this.emit()
  }

  private emit(): void {
    const status = this.status()
    this.persistenceTail = this.persistenceTail.then(async () => {
      try {
        await this.repository.saveStatus?.(status)
      } catch {
        // Persistence failure must not interrupt an active provider operation.
      }
    })
    for (const listener of this.listeners) {
      listener(status)
    }
  }

  private async persistStatus(): Promise<void> {
    const status = this.status()
    this.persistenceTail = this.persistenceTail.then(async () => {
      try {
        await this.repository.saveStatus?.(status)
      } catch {
        // Persistence failure must not interrupt initialization.
      }
    })
    await this.persistenceTail
  }
}

import type { EmbeddingIndexStatus } from '../../shared/embedding-contracts'
import type {
  EmbeddingIndexRecord,
  EmbeddingIndexRepository
} from './embedding-index-coordinator'
import type { KnowledgeDatabase } from './knowledge-database'

export class KnowledgeEmbeddingIndexRepository
implements EmbeddingIndexRepository {
  constructor(
    private readonly database: KnowledgeDatabase,
    private readonly knowledgeBaseId: string
  ) {}

  async getLastJob(): Promise<EmbeddingIndexStatus['job']> {
    return this.database.getLastEmbeddingIndexJob(this.knowledgeBaseId)
  }

  async saveStatus(status: EmbeddingIndexStatus): Promise<void> {
    this.database.saveEmbeddingIndexJob(
      this.knowledgeBaseId,
      status.job
    )
  }

  async listIndexDocumentIds(signal: AbortSignal) {
    signal.throwIfAborted()
    const documentIds =
      this.database.listEmbeddingIndexDocumentIds(
        this.knowledgeBaseId
      )
    signal.throwIfAborted()
    return documentIds
  }

  async getIndexDocument(
    documentId: string,
    signal: AbortSignal
  ) {
    signal.throwIfAborted()
    const document =
      this.database.getEmbeddingIndexDocument(documentId)
    signal.throwIfAborted()
    return document
  }

  async beginDocumentReplacement(
    documentId: string,
    provider: string,
    model: string,
    signal: AbortSignal
  ): Promise<string> {
    signal.throwIfAborted()
    const replacementId =
      this.database.beginDocumentEmbeddingReplacement(
        documentId,
        provider,
        model
      )
    signal.throwIfAborted()
    return replacementId
  }

  async appendDocumentReplacement(
    replacementId: string,
    documentId: string,
    provider: string,
    model: string,
    records: readonly EmbeddingIndexRecord[],
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    this.database.appendDocumentEmbeddingBatch(
      replacementId,
      documentId,
      provider,
      model,
      records.map((record) => ({
        chunkId: record.itemId,
        contentChecksum: record.contentChecksum ?? '',
        vector: record.vector
      }))
    )
    signal.throwIfAborted()
  }

  async finishDocumentReplacement(
    replacementId: string,
    documentId: string,
    provider: string,
    model: string,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    this.database.finishDocumentEmbeddingReplacement(
      replacementId,
      documentId,
      provider,
      model
    )
    signal.throwIfAborted()
  }

  async discardDocumentReplacement(
    replacementId: string
  ): Promise<void> {
    this.database.discardDocumentEmbeddingReplacement(
      replacementId
    )
  }

  async recordDocumentError(
    documentId: string,
    provider: string,
    model: string,
    error: string
  ): Promise<void> {
    this.database.recordEmbeddingIndexError(
      documentId,
      provider,
      model,
      error
    )
  }
}

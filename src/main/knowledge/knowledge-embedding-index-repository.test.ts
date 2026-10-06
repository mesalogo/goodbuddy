import { expect, it, vi } from 'vitest'
import { KnowledgeEmbeddingIndexRepository } from './knowledge-embedding-index-repository'
import type { EmbeddingIndexState } from './types'

function fixture() {
  const state: EmbeddingIndexState = {
    documentId: 'document', knowledgeBaseId: 'library', provider: 'provider',
    model: 'model', contentChecksum: 'checksum', status: 'ready',
    updatedAt: '2026-10-05T00:00:00.000Z'
  }
  const database = {
    getLastEmbeddingIndexJob: () => null,
    saveEmbeddingIndexJob: vi.fn(async () => undefined),
    listEmbeddingIndexDocumentIds: () => ['document'],
    getEmbeddingIndexDocument: () => ({ id: 'document', items: [] }),
    beginDocumentEmbeddingReplacement: vi.fn(async () => 'replacement'),
    appendDocumentEmbeddingBatch: vi.fn(async () => undefined),
    finishDocumentEmbeddingReplacement: vi.fn(async () => state),
    discardDocumentEmbeddingReplacement: vi.fn(async () => undefined),
    recordEmbeddingIndexError: vi.fn(async (): Promise<EmbeddingIndexState> => ({ ...state, status: 'error' }))
  }
  return { database, state, repository: new KnowledgeEmbeddingIndexRepository(database, 'library') }
}

it('does not acknowledge a batch before its asynchronous storage commit', async () => {
  const { database, repository } = fixture()
  let commit!: () => void
  database.appendDocumentEmbeddingBatch.mockImplementation(() => new Promise(resolve => { commit = () => resolve(undefined) }))
  const settled = vi.fn()
  const pending = repository.appendDocumentReplacement('replacement', 'document', 'provider', 'model', [
    { itemId: 'chunk', contentChecksum: 'checksum', vector: [1, 0] }
  ], new AbortController().signal).then(settled)
  await Promise.resolve()
  expect(settled).not.toHaveBeenCalled()
  expect(database.appendDocumentEmbeddingBatch).toHaveBeenCalledWith('replacement', 'document', 'provider', 'model', [
    { chunkId: 'chunk', contentChecksum: 'checksum', vector: [1, 0] }
  ])
  commit()
  await pending
  expect(settled).toHaveBeenCalledOnce()
})

it('returns an admitted replacement for cleanup even when cancellation arrives with its reply', async () => {
  const { database, repository } = fixture()
  const controller = new AbortController()
  database.beginDocumentEmbeddingReplacement.mockImplementation(async () => {
    controller.abort()
    return 'replacement'
  })
  await expect(repository.beginDocumentReplacement('document', 'provider', 'model', controller.signal)).resolves.toBe('replacement')
  await repository.discardDocumentReplacement('replacement')
  expect(database.discardDocumentEmbeddingReplacement).toHaveBeenCalledWith('replacement')
})

it('reports a committed finish as success when cancellation arrives too late', async () => {
  const { database, state, repository } = fixture()
  const controller = new AbortController()
  database.finishDocumentEmbeddingReplacement.mockImplementation(async () => { controller.abort(); return state })
  await expect(repository.finishDocumentReplacement('replacement', 'document', 'provider', 'model', controller.signal)).resolves.toBeUndefined()
})

it('propagates storage exit failures instead of acknowledging the status write', async () => {
  const { database, repository } = fixture()
  database.saveEmbeddingIndexJob.mockRejectedValue(new Error('storage exited'))
  await expect(repository.saveStatus({ job: null })).rejects.toThrow('storage exited')
})

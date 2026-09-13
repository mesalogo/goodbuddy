import type { KnowledgeSearchReference } from './contracts'
import { stripKnowledgeHighlightTags } from './knowledge-text'
import type { KnowledgeRetrievalResponse } from './knowledge-contracts'

export function knowledgeReferenceKey(reference: KnowledgeSearchReference): string {
  const external = reference.external
  return JSON.stringify([
    reference.libraryId, reference.documentId, reference.chunkId,
    external?.provider, external?.instanceId, external?.remoteKnowledgeBaseId,
    external?.remoteDocumentId, external?.remoteChunkId,
    external?.location ?? reference.locator, external?.sourceUrl, reference.snippet
  ])
}

export function toKnowledgeReference(
  result: KnowledgeRetrievalResponse['results'][number], libraryName: string
): KnowledgeSearchReference {
  return {
    libraryId: result.knowledgeBaseId, libraryName: libraryName.slice(0, 200),
    documentId: result.documentId, chunkId: result.chunkId,
    documentName: result.documentTitle.slice(0, 500), sourceName: result.sourceDisplayName.slice(0, 500),
    locator: (result.external?.location ?? result.location)?.slice(0, 1000),
    snippet: stripKnowledgeHighlightTags(result.snippet).slice(0, 16000),
    rank: result.rank, external: result.external,
    score: result.external ? undefined : result.scores.fusedScore,
    lexicalRank: result.scores.ftsRank, vectorRank: result.scores.vectorRank,
    graphRank: result.scores.graphRank, similarity: result.scores.vectorSimilarity,
    retrievalChannels: result.channels
  }
}

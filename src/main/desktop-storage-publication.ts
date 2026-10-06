import type { KnowledgeDatabase } from './knowledge/knowledge-database'
import { storeExtractedGraph } from './desktop-storage-knowledge-operations'
import type { PublishDocumentOptions } from './desktop-storage-contracts'

/** The graph callback is created here, inside the owner's publication transaction. */
export function publishStorageDocument(
  database: KnowledgeDatabase,
  input: Parameters<KnowledgeDatabase['publishDocument']>[0],
  chunks: Parameters<KnowledgeDatabase['publishDocument']>[1],
  options: PublishDocumentOptions = {}
): ReturnType<KnowledgeDatabase['publishDocument']> {
  const { graph, ...publication } = options
  return database.publishDocument(input, chunks, {
    ...publication,
    afterChunksInserted: graph ? document => {
      storeExtractedGraph(database, database.getKnowledgeBase(document.knowledgeBaseId)!, document, graph)
    } : undefined
  })
}

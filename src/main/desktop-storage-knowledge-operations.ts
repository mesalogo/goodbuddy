import type { KnowledgeDatabase } from './knowledge/knowledge-database'
import { normalizeEntityAlias, type GraphExtractionResult } from './knowledge/graph-extractor'
import type { KnowledgeBase, Document, GraphEntity } from './knowledge/types'

export function replaceDocumentGraph(database: KnowledgeDatabase, library: KnowledgeBase, document: Document, result: GraphExtractionResult): void {
  database.replaceEvidenceForDocument(document.id, () => storeExtractedGraph(database, library, document, result))
}

export function storeExtractedGraph(
    database: KnowledgeDatabase,
    library: KnowledgeBase,
    document: Document,
    result: GraphExtractionResult
  ): void {
    const chunksById = new Map(
      database
        .listChunks(document.id)
        .map((chunk) => [chunk.id, chunk])
    )
    const entityIds = new Map<string, string>()
    const existingEntitiesByIdentity = new Map<string, GraphEntity>()
    for (const entity of database.listEntitiesForIdentity(library.id)) {
      for (const name of [entity.name, ...entity.aliases]) {
        existingEntitiesByIdentity.set(
          `${entity.type}\0${normalizeEntityAlias(name)}`,
          entity
        )
      }
    }
    for (const entity of result.entities) {
      const identity = `${entity.type}\0${normalizeEntityAlias(entity.name)}`
      const existing = existingEntitiesByIdentity.get(identity)
      const stored = existing
        ? existing.locked
          ? existing
          : database.updateEntity(existing.id, {
              aliases: [...new Set([...existing.aliases, ...entity.aliases])]
            })
        : database.createEntity({
            knowledgeBaseId: library.id,
            name: entity.name,
            type: entity.type,
            aliases: entity.aliases,
            locked: false
          })
      for (const name of [stored.name, ...stored.aliases]) {
        existingEntitiesByIdentity.set(
          `${stored.type}\0${normalizeEntityAlias(name)}`,
          stored
        )
      }
      entityIds.set(entity.id, stored.id)
      for (const evidence of entity.evidence) {
        database.createEvidence({
          knowledgeBaseId: library.id,
          entityId: stored.id,
          documentId: document.id,
          chunkId: evidence.chunkId,
          quote: evidence.quote,
          location: chunksById.get(evidence.chunkId)?.location,
          start: evidence.start,
          end: evidence.end,
          confidence: evidence.confidence,
          source: evidence.source,
          provenance: {
            strategy: result.strategy,
            ontologyVersion: library.ontologySettings.version
          }
        })
      }
    }
    for (const relation of result.relations) {
      const sourceEntityId = entityIds.get(relation.sourceId)
      const targetEntityId = entityIds.get(relation.targetId)
      if (!sourceEntityId || !targetEntityId) {
        continue
      }
      const existing = database.findRelationByIdentity(
        library.id,
        sourceEntityId,
        targetEntityId,
        relation.type
      )
      const stored =
        existing ??
        database.createRelation({
          knowledgeBaseId: library.id,
          sourceEntityId,
          targetEntityId,
          type: relation.type,
          locked: false
        })
      for (const evidence of relation.evidence) {
        database.createEvidence({
          knowledgeBaseId: library.id,
          relationId: stored.id,
          documentId: document.id,
          chunkId: evidence.chunkId,
          quote: evidence.quote,
          location: chunksById.get(evidence.chunkId)?.location,
          start: evidence.start,
          end: evidence.end,
          confidence: evidence.confidence,
          source: evidence.source,
          provenance: {
            strategy: result.strategy,
            ontologyVersion: library.ontologySettings.version
          }
        })
      }
    }
  }

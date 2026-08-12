import { describe, expect, it } from 'vitest'
import {
  defaultKnowledgeChunkingSettings,
  defaultKnowledgeRetrievalSettings,
  knowledgeChunkingSettingsSchema,
  knowledgeChunkUpdateInputSchema,
  knowledgeRetrievalSettingsSchema,
  knowledgeRetrieveInputSchema
} from './knowledge-contracts'

describe('knowledge contracts', () => {
  it('provides the approved strict retrieval defaults', () => {
    expect(defaultKnowledgeRetrievalSettings).toEqual({
      version: 1,
      topK: 6,
      minimumVectorSimilarity: 0,
      ftsWeight: 1,
      vectorWeight: 1,
      graphWeight: 0.8,
      candidateMultiplier: 4,
      contextMaxCharacters: 16_000,
      adjacentChunkCount: 0,
      localRerankEnabled: false,
      rerankMode: 'none'
    })
    expect(
      knowledgeRetrievalSettingsSchema.safeParse({
        ...defaultKnowledgeRetrievalSettings,
        ftsWeight: 0,
        vectorWeight: 0,
        graphWeight: 0
      }).success
    ).toBe(false)
    expect(
      knowledgeRetrievalSettingsSchema.safeParse({
        ...defaultKnowledgeRetrievalSettings,
        extra: true
      }).success
    ).toBe(false)
    expect(
      knowledgeRetrievalSettingsSchema.parse({
        ...defaultKnowledgeRetrievalSettings,
        minimumVectorSimilarity: -1
      }).minimumVectorSimilarity
    ).toBe(0)
  })

  it('bounds chunking settings and validates dependent values', () => {
    expect(defaultKnowledgeChunkingSettings).toEqual({
      version: 1,
      mode: 'structure',
      targetCharacters: 1_600,
      overlapCharacters: 160,
      parentCharacters: 4_800,
      childCharacters: 900,
      contextualIndexingEnabled: false
    })
    expect(
      knowledgeChunkingSettingsSchema.safeParse({
        ...defaultKnowledgeChunkingSettings,
        targetCharacters: 400,
        overlapCharacters: 161
      }).success
    ).toBe(false)
    expect(
      knowledgeChunkingSettingsSchema.safeParse({
        ...defaultKnowledgeChunkingSettings,
        parentCharacters: 1_600,
        childCharacters: 1_601
      }).success
    ).toBe(false)
  })

  it('bounds retrieval and chunk mutation inputs', () => {
    expect(
      knowledgeRetrieveInputSchema.safeParse({
        knowledgeBaseId: 'library',
        query: 'x'.repeat(4_001)
      }).success
    ).toBe(false)
    expect(
      knowledgeChunkUpdateInputSchema.safeParse({
        knowledgeBaseId: 'library',
        documentId: 'document',
        chunkId: 'chunk'
      }).success
    ).toBe(false)
  })
})

import { mkdtemp, rm } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { KnowledgeDatabase } from './knowledge-database'

const temporaryDirectories: string[] = []
const openDatabases: KnowledgeDatabase[] = []

async function createDatabase(): Promise<{
  database: KnowledgeDatabase
  path: string
}> {
  const directory = await mkdtemp(join(tmpdir(), 'goodbuddy-knowledge-'))
  temporaryDirectories.push(directory)
  const path = join(directory, 'knowledge.sqlite')
  const database = new KnowledgeDatabase(path)
  database.initialize()
  openDatabases.push(database)
  return { database, path }
}

function seedDocument(
  database: KnowledgeDatabase,
  knowledgeBaseId: string,
  marker: string
): { documentId: string; chunkId: string; sourceId: string } {
  const source = database.upsertSource({
    knowledgeBaseId,
    type: 'file',
    location: `C:\\notes\\${marker}.md`,
    displayName: `${marker}.md`,
    status: 'ready'
  })
  const document = database.upsertDocument(
    {
      knowledgeBaseId,
      sourceId: source.id,
      externalId: marker,
      title: marker,
      sourceLocation: source.location
    },
    [
      {
        id: `${marker}-chunk`,
        ordinal: 0,
        content: `${marker} contains the searchable lighthouse phrase`,
        location: 'line 1'
      }
    ]
  )
  return {
    documentId: document.id,
    chunkId: `${marker}-chunk`,
    sourceId: source.id
  }
}

afterEach(async () => {
  for (const database of openDatabases.splice(0)) {
    database.close()
  }
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })
    )
  )
})

describe('KnowledgeDatabase', () => {
  it('migrates transactionally and persists data after close and reopen', async () => {
    const { database, path } = await createDatabase()
    const knowledgeBase = database.createKnowledgeBase({
      id: 'persistent-base',
      name: 'Persistent notes',
      description: 'survives restart',
      storageMode: 'managed',
      graphEnabled: true,
      graphStrategy: 'ask'
    })
    seedDocument(database, knowledgeBase.id, 'persistent')
    database.close()

    const inspection = new DatabaseSync(path)
    expect(
      inspection.prepare('PRAGMA user_version').get()
    ).toEqual({ user_version: 2 })
    expect(
      inspection
        .prepare('SELECT version FROM schema_migrations ORDER BY version')
        .all()
    ).toEqual([{ version: 1 }, { version: 2 }])
    inspection.close()

    const reopened = new KnowledgeDatabase(path)
    openDatabases.push(reopened)
    reopened.initialize()
    reopened.initialize()
    expect(reopened.getKnowledgeBase(knowledgeBase.id)).toMatchObject({
      name: 'Persistent notes',
      storageMode: 'managed',
      graphStrategy: 'ask'
    })
    expect(reopened.listDocuments(knowledgeBase.id)).toHaveLength(1)
    expect(reopened.search({ knowledgeBaseId: knowledgeBase.id, query: 'lighthouse' }))
      .toHaveLength(1)
  })

  it('upgrades an existing v1 database to vector schema v2', async () => {
    const { database, path } = await createDatabase()
    const knowledgeBase = database.createKnowledgeBase({
      name: 'Version one data',
      storageMode: 'reference'
    })
    seedDocument(database, knowledgeBase.id, 'version-one')
    database.close()

    const downgrade = new DatabaseSync(path)
    downgrade.exec(`
      DROP TABLE embedding_index_state;
      DROP TABLE chunk_embeddings;
      DELETE FROM schema_migrations WHERE version = 2;
      PRAGMA user_version = 1;
    `)
    downgrade.close()

    const upgraded = new KnowledgeDatabase(path)
    openDatabases.push(upgraded)
    upgraded.initialize()
    const inspection = new DatabaseSync(path)
    expect(inspection.prepare('PRAGMA user_version').get()).toEqual({
      user_version: 2
    })
    expect(
      inspection
        .prepare(
          `SELECT name FROM sqlite_master
           WHERE type = 'table' AND name IN
             ('chunk_embeddings', 'embedding_index_state')
           ORDER BY name`
        )
        .all()
    ).toEqual([
      { name: 'chunk_embeddings' },
      { name: 'embedding_index_state' }
    ])
    inspection.close()
    expect(
      upgraded.search({
        knowledgeBaseId: knowledgeBase.id,
        query: 'lighthouse'
      })
    ).toHaveLength(1)
  })

  it('isolates FTS results by knowledge base and replaces indexed chunks', async () => {
    const { database } = await createDatabase()
    const first = database.createKnowledgeBase({
      name: 'First',
      storageMode: 'reference'
    })
    const second = database.createKnowledgeBase({
      name: 'Second',
      storageMode: 'reference'
    })
    const firstSeed = seedDocument(database, first.id, 'alpha')
    seedDocument(database, second.id, 'beta')

    const firstResults = database.search({
      knowledgeBaseId: first.id,
      query: 'lighthouse'
    })
    expect(firstResults).toHaveLength(1)
    expect(firstResults[0]).toMatchObject({
      document: { title: 'alpha' },
      source: {
        location: 'C:\\notes\\alpha.md',
        displayName: 'alpha.md'
      },
      chunk: { location: 'line 1' }
    })
    expect(firstResults[0]?.snippet).toContain('<mark>lighthouse</mark>')
    expect(
      database.search({
        knowledgeBaseId: second.id,
        query: 'lighthouse'
      })
    ).toHaveLength(1)

    database.upsertDocument(
      {
        id: firstSeed.documentId,
        knowledgeBaseId: first.id,
        sourceId: firstSeed.sourceId,
        externalId: 'alpha',
        title: 'alpha'
      },
      [{ ordinal: 0, content: 'replacement text without the old keyword' }]
    )
    expect(
      database.search({
        knowledgeBaseId: first.id,
        query: 'lighthouse'
      })
    ).toEqual([])
    expect(
      database.search({
        knowledgeBaseId: first.id,
        query: 'replacement'
      })
    ).toHaveLength(1)
  })

  it('cascades knowledge base deletion through sources, documents, chunks, and graph', async () => {
    const { database } = await createDatabase()
    const knowledgeBase = database.createKnowledgeBase({
      name: 'Disposable',
      storageMode: 'managed'
    })
    const seeded = seedDocument(database, knowledgeBase.id, 'disposable')
    const entity = database.createEntity({
      knowledgeBaseId: knowledgeBase.id,
      name: 'Disposable entity',
      type: 'topic'
    })
    database.createEvidence({
      knowledgeBaseId: knowledgeBase.id,
      entityId: entity.id,
      documentId: seeded.documentId,
      chunkId: seeded.chunkId
    })

    expect(database.deleteKnowledgeBase(knowledgeBase.id)).toBe(true)
    expect(database.getKnowledgeBase(knowledgeBase.id)).toBeUndefined()
    expect(database.listSources(knowledgeBase.id)).toEqual([])
    expect(database.listDocuments(knowledgeBase.id)).toEqual([])
    expect(database.listEntities(knowledgeBase.id)).toEqual([])
    expect(database.listEvidence(knowledgeBase.id)).toEqual([])
    expect(
      database.search({
        knowledgeBaseId: knowledgeBase.id,
        query: 'lighthouse'
      })
    ).toEqual([])
  })

  it('edits graph records and merges entities while retaining evidence and locks', async () => {
    const { database } = await createDatabase()
    const knowledgeBase = database.createKnowledgeBase({
      name: 'Graph',
      storageMode: 'reference',
      graphStrategy: 'hybrid'
    })
    const seeded = seedDocument(database, knowledgeBase.id, 'graph')
    const target = database.createEntity({
      knowledgeBaseId: knowledgeBase.id,
      name: 'GoodBuddy',
      type: 'product',
      aliases: ['Buddy'],
      properties: { owner: 'team' }
    })
    const source = database.createEntity({
      knowledgeBaseId: knowledgeBase.id,
      name: 'Good Buddy',
      type: 'product',
      aliases: ['GB'],
      properties: { language: 'TypeScript' },
      locked: true
    })
    const other = database.createEntity({
      knowledgeBaseId: knowledgeBase.id,
      name: 'SQLite',
      type: 'technology'
    })
    const relation = database.createRelation({
      knowledgeBaseId: knowledgeBase.id,
      sourceEntityId: source.id,
      targetEntityId: other.id,
      type: 'uses',
      locked: true
    })
    const entityEvidence = database.createEvidence({
      knowledgeBaseId: knowledgeBase.id,
      entityId: source.id,
      documentId: seeded.documentId,
      chunkId: seeded.chunkId,
      quote: 'graph evidence'
    })
    const relationEvidence = database.createEvidence({
      knowledgeBaseId: knowledgeBase.id,
      relationId: relation.id,
      documentId: seeded.documentId
    })

    const merged = database.mergeEntities(target.id, source.id)
    expect(merged).toMatchObject({
      id: target.id,
      locked: true,
      properties: { language: 'TypeScript', owner: 'team' }
    })
    expect(merged.aliases).toEqual(
      expect.arrayContaining(['Buddy', 'Good Buddy', 'GB'])
    )
    expect(database.getEntity(source.id)).toBeUndefined()
    expect(database.getRelation(relation.id)).toMatchObject({
      sourceEntityId: target.id,
      locked: true
    })
    expect(database.listEvidence(knowledgeBase.id)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: entityEvidence.id, entityId: target.id }),
        expect.objectContaining({
          id: relationEvidence.id,
          relationId: relation.id
        })
      ])
    )

    expect(
      database.updateEntity(target.id, {
        description: 'Manually curated',
        aliases: ['GB2'],
        locked: true
      })
    ).toMatchObject({ description: 'Manually curated', aliases: ['GB2'] })
    expect(
      database.updateRelation(relation.id, {
        label: 'built with',
        properties: { confidence: 1 }
      })
    ).toMatchObject({
      label: 'built with',
      properties: { confidence: 1 },
      locked: true
    })
    expect(
      database.updateEvidence(entityEvidence.id, {
        location: 'paragraph 2'
      })
    ).toMatchObject({ location: 'paragraph 2' })

    expect(database.deleteEvidence(entityEvidence.id)).toBe(true)
    expect(database.deleteRelation(relation.id)).toBe(true)
    expect(database.deleteEntity(other.id)).toBe(true)
  })

  it('persists isolated Float32 embeddings and clears stale index state transactionally', async () => {
    const created = await createDatabase()
    let database = created.database
    const knowledgeBase = database.createKnowledgeBase({
      name: 'Vectors',
      storageMode: 'reference'
    })
    const alpha = seedDocument(database, knowledgeBase.id, 'alpha-vector')
    const beta = seedDocument(database, knowledgeBase.id, 'beta-vector')
    const checksum = (value: string): string =>
      createHash('sha256').update(value).digest('hex')
    const alphaContent =
      'alpha-vector contains the searchable lighthouse phrase'
    const betaContent =
      'beta-vector contains the searchable lighthouse phrase'

    expect(
      database.replaceDocumentEmbeddings(
        alpha.documentId,
        'ollama',
        'test-model',
        [
          {
            chunkId: alpha.chunkId,
            contentChecksum: checksum(alphaContent),
            vector: [1, 0]
          }
        ]
      )
    ).toMatchObject({ status: 'ready', dimensions: 2 })
    database.replaceDocumentEmbeddings(
      beta.documentId,
      'ollama',
      'test-model',
      [
        {
          chunkId: beta.chunkId,
          contentChecksum: checksum(betaContent),
          vector: [0, 1]
        }
      ]
    )
    database.close()
    database = new KnowledgeDatabase(created.path)
    openDatabases.push(database)
    database.initialize()

    expect(
      database.vectorSearch({
        knowledgeBaseId: knowledgeBase.id,
        provider: 'ollama',
        model: 'test-model',
        vector: [0.9, 0.1]
      }).map((result) => result.chunk.id)
    ).toEqual([alpha.chunkId, beta.chunkId])
    expect(
      database.vectorSearch({
        knowledgeBaseId: knowledgeBase.id,
        provider: 'ollama',
        model: 'other-model',
        vector: [0.9, 0.1]
      })
    ).toEqual([])
    expect(() =>
      database.replaceDocumentEmbeddings(
        alpha.documentId,
        'ollama',
        'test-model',
        [
          {
            chunkId: alpha.chunkId,
            contentChecksum: '0'.repeat(64),
            vector: [1, 0]
          }
        ]
      )
    ).toThrow('checksum')
    expect(
      database.vectorSearch({
        knowledgeBaseId: knowledgeBase.id,
        provider: 'ollama',
        model: 'test-model',
        vector: [1, 0],
        limit: 1
      })[0]?.chunk.id
    ).toBe(alpha.chunkId)

    database.upsertDocument(
      {
        id: alpha.documentId,
        knowledgeBaseId: knowledgeBase.id,
        sourceId: alpha.sourceId,
        externalId: 'alpha-vector',
        title: 'alpha-vector'
      },
      [{ id: alpha.chunkId, ordinal: 0, content: 'fresh lexical fallback' }]
    )
    expect(
      database.getEmbeddingIndexState(
        alpha.documentId,
        'ollama',
        'test-model'
      )
    ).toBeUndefined()
    expect(
      database.vectorSearch({
        knowledgeBaseId: knowledgeBase.id,
        provider: 'ollama',
        model: 'test-model',
        vector: [1, 0]
      }).map((result) => result.chunk.id)
    ).not.toContain(alpha.chunkId)
    expect(
      database.search({
        knowledgeBaseId: knowledgeBase.id,
        query: 'fallback'
      })
    ).toHaveLength(1)
  })

  it('fuses FTS and vector ranks while isolating providers and libraries', async () => {
    const { database } = await createDatabase()
    const first = database.createKnowledgeBase({
      name: 'Hybrid one',
      storageMode: 'reference',
      graphEnabled: false
    })
    const second = database.createKnowledgeBase({
      name: 'Hybrid two',
      storageMode: 'reference',
      graphEnabled: false
    })
    const firstSeed = seedDocument(database, first.id, 'hybrid-first')
    const secondSeed = seedDocument(database, second.id, 'hybrid-second')
    for (const [databaseId, seed, marker] of [
      [first.id, firstSeed, 'hybrid-first'],
      [second.id, secondSeed, 'hybrid-second']
    ] as const) {
      const content = `${marker} contains the searchable lighthouse phrase`
      database.replaceDocumentEmbeddings(
        seed.documentId,
        'ollama',
        'hybrid-model',
        [
          {
            chunkId: seed.chunkId,
            contentChecksum: createHash('sha256').update(content).digest('hex'),
            vector: [1, 0, 0]
          }
        ]
      )
      expect(databaseId).toBeTruthy()
    }

    const results = database.hybridSearch({
      knowledgeBaseId: first.id,
      query: 'lighthouse',
      provider: 'ollama',
      model: 'hybrid-model',
      vector: [1, 0, 0],
      graphEnabled: false
    })
    expect(results).toHaveLength(1)
    expect(results[0]?.chunk.id).toBe(firstSeed.chunkId)
    expect(results[0]?.retrieval.channels).toEqual(['fts', 'vector'])
    expect(results[0]?.retrieval.similarity).toBeCloseTo(1)
    expect(results.map((result) => result.chunk.id)).not.toContain(
      secondSeed.chunkId
    )
  })

  it('expands persisted graph seeds only through evidence-backed same-library paths', async () => {
    const { database } = await createDatabase()
    const first = database.createKnowledgeBase({
      name: 'GraphRAG one',
      storageMode: 'reference'
    })
    const second = database.createKnowledgeBase({
      name: 'GraphRAG two',
      storageMode: 'reference'
    })
    const goodBuddy = seedDocument(database, first.id, 'GoodBuddy')
    const electron = seedDocument(database, first.id, 'Electron')
    const foreign = seedDocument(database, second.id, 'GoodBuddy-foreign')
    const source = database.createEntity({
      knowledgeBaseId: first.id,
      name: 'GoodBuddy',
      type: 'product'
    })
    const target = database.createEntity({
      knowledgeBaseId: first.id,
      name: 'Electron',
      type: 'framework'
    })
    const relation = database.createRelation({
      knowledgeBaseId: first.id,
      sourceEntityId: source.id,
      targetEntityId: target.id,
      type: 'uses'
    })
    expect(() =>
      database.createEvidence({
        knowledgeBaseId: first.id,
        entityId: source.id,
        documentId: goodBuddy.documentId,
        chunkId: electron.chunkId
      })
    ).toThrow('must belong')
    database.createEvidence({
      knowledgeBaseId: first.id,
      entityId: source.id,
      documentId: goodBuddy.documentId,
      chunkId: goodBuddy.chunkId
    })
    database.createEvidence({
      knowledgeBaseId: first.id,
      entityId: target.id,
      documentId: electron.documentId,
      chunkId: electron.chunkId
    })
    database.createEvidence({
      knowledgeBaseId: first.id,
      relationId: relation.id,
      documentId: goodBuddy.documentId,
      chunkId: goodBuddy.chunkId
    })
    const unbacked = database.createEntity({
      knowledgeBaseId: first.id,
      name: 'Unbacked',
      type: 'concept'
    })
    const foreignEntity = database.createEntity({
      knowledgeBaseId: second.id,
      name: 'GoodBuddy',
      type: 'foreign'
    })
    database.createEvidence({
      knowledgeBaseId: second.id,
      entityId: foreignEntity.id,
      documentId: foreign.documentId,
      chunkId: foreign.chunkId
    })

    const graphResults = database.graphSearch(first.id, 'GoodBuddy', 10, 1)
    expect(graphResults.map((result) => result.chunk.id)).toEqual(
      expect.arrayContaining([goodBuddy.chunkId, electron.chunkId])
    )
    expect(
      graphResults.every(
        (result) =>
          result.retrieval.channels[0] === 'graph' &&
          result.retrieval.evidenceIds.length > 0
      )
    ).toBe(true)
    expect(graphResults.map((result) => result.chunk.id)).not.toContain(
      foreign.chunkId
    )
    expect(database.graphSearch(first.id, unbacked.name)).toEqual([])
  })

  it('bounds inputs and rejects API keys in extensible metadata', async () => {
    const { database } = await createDatabase()
    expect(() =>
      database.createKnowledgeBase({
        name: 'x'.repeat(513),
        storageMode: 'reference'
      })
    ).toThrow('at most 512')

    const knowledgeBase = database.createKnowledgeBase({
      name: 'Safe metadata',
      storageMode: 'reference'
    })
    expect(() =>
      database.upsertSource({
        knowledgeBaseId: knowledgeBase.id,
        type: 'url',
        location: 'https://example.test',
        displayName: 'Example',
        metadata: { api_key: 'must-not-be-stored' }
      })
    ).toThrow('must not contain API keys')
  })
})

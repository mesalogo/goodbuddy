import { mkdtemp, rm } from 'node:fs/promises'
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
    ).toEqual({ user_version: 1 })
    expect(
      inspection
        .prepare('SELECT version FROM schema_migrations ORDER BY version')
        .all()
    ).toEqual([{ version: 1 }])
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

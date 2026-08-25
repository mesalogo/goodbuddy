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
    ).toEqual({ user_version: 11 })
    expect(
      inspection
        .prepare('SELECT version FROM schema_migrations ORDER BY version')
        .all()
    ).toEqual([
      { version: 1 },
      { version: 2 },
      { version: 3 },
      { version: 4 },
      { version: 5 },
      { version: 6 },
      { version: 7 },
      { version: 8 },
      { version: 9 },
      { version: 10 },
      { version: 11 }
    ])
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

  it('repairs a mismatched user version without losing current-schema data', async () => {
    const { database, path } = await createDatabase()
    const knowledgeBase = database.createKnowledgeBase({
      name: 'Mismatch repair',
      storageMode: 'reference'
    })
    seedDocument(database, knowledgeBase.id, 'mismatch-repair')
    database.close()

    const mismatch = new DatabaseSync(path)
    mismatch.exec('PRAGMA user_version = 10')
    mismatch.close()

    const repaired = new KnowledgeDatabase(path)
    openDatabases.push(repaired)
    repaired.initialize()

    expect(repaired.getKnowledgeBase(knowledgeBase.id)).toMatchObject({
      name: 'Mismatch repair'
    })
    expect(repaired.listDocuments(knowledgeBase.id)).toHaveLength(1)
    const inspection = new DatabaseSync(path)
    expect(inspection.prepare('PRAGMA user_version').get()).toEqual({
      user_version: 11
    })
    inspection.close()
  })

  it.each([
    ['migration version', 'INSERT INTO schema_migrations VALUES (12, ?)', true],
    ['user version', 'PRAGMA user_version = 12', false]
  ])('rejects a future %s without downgrading it', async (
    _label,
    statement,
    hasParameter
  ) => {
    const { database, path } = await createDatabase()
    database.close()
    const future = new DatabaseSync(path)
    if (hasParameter) {
      future.prepare(statement).run(new Date().toISOString())
    } else {
      future.exec(statement)
    }
    future.close()

    const unsupported = new KnowledgeDatabase(path)
    expect(() => unsupported.initialize()).toThrow(
      'newer than supported version 11'
    )

    const inspection = new DatabaseSync(path)
    expect(inspection.prepare('PRAGMA user_version').get()).toEqual({
      user_version: hasParameter ? 11 : 12
    })
    expect(
      inspection
        .prepare('SELECT MAX(version) AS version FROM schema_migrations')
        .get()
    ).toEqual({ version: hasParameter ? 12 : 11 })
    inspection.close()
  })

  it('keeps graph generation off unless explicitly enabled', async () => {
    const { database } = await createDatabase()
    const defaultLibrary = database.createKnowledgeBase({
      name: 'Default graph setting',
      storageMode: 'reference'
    })
    const graphLibrary = database.createKnowledgeBase({
      name: 'Explicit graph setting',
      storageMode: 'reference',
      graphEnabled: true
    })

    expect(defaultLibrary.graphEnabled).toBe(false)
    expect(graphLibrary.graphEnabled).toBe(true)
    expect(defaultLibrary.ontologyRebuildRequired).toBe(false)
    expect(graphLibrary.ontologyRebuildRequired).toBe(false)

    expect(
      database.updateKnowledgeBase(graphLibrary.id, {
        graphStrategy: 'rules'
      }).ontologyRebuildRequired
    ).toBe(true)
  })

  it('normalizes legacy negative vector thresholds without losing settings', async () => {
    const { database, path } = await createDatabase()
    const library = database.createKnowledgeBase({
      name: 'Legacy retrieval settings',
      storageMode: 'reference'
    })
    database.close()
    const inspection = new DatabaseSync(path)
    inspection
      .prepare(
        `UPDATE knowledge_bases
         SET retrieval_settings = ?
         WHERE id = ?`
      )
      .run(
        JSON.stringify({
          version: 1,
          topK: 9,
          minimumVectorSimilarity: -1,
          ftsWeight: 1.2,
          vectorWeight: 0.8,
          graphWeight: 0,
          candidateMultiplier: 5,
          contextMaxCharacters: 20_000,
          adjacentChunkCount: 1,
          localRerankEnabled: true
        }),
        library.id
      )
    inspection.close()

    const reopened = new KnowledgeDatabase(path)
    openDatabases.push(reopened)
    reopened.initialize()

    expect(reopened.getKnowledgeBase(library.id)?.retrievalSettings).toEqual({
      version: 1,
      topK: 9,
      minimumVectorSimilarity: 0,
      ftsWeight: 1.2,
      vectorWeight: 0.8,
      graphWeight: 0,
      candidateMultiplier: 5,
      contextMaxCharacters: 20_000,
      adjacentChunkCount: 1,
      localRerankEnabled: true,
      rerankMode: 'local'
    })
  })

  it('upgrades an existing v1 database through knowledge schema v11', async () => {
    const { database, path } = await createDatabase()
    const knowledgeBase = database.createKnowledgeBase({
      name: 'Version one data',
      storageMode: 'reference'
    })
    seedDocument(database, knowledgeBase.id, 'version-one')
    database.close()

    const downgrade = new DatabaseSync(path)
    downgrade.exec(`
      DROP TABLE embedding_rebuild_staging;
      DROP TABLE embedding_index_job;
      DROP TABLE embedding_index_state;
      DROP TABLE chunk_embeddings;
      DROP TABLE knowledge_tasks;
      DELETE FROM schema_migrations
      WHERE version IN (2, 3, 4, 5, 6, 7, 8, 9, 10, 11);
      PRAGMA user_version = 1;
    `)
    downgrade.close()

    const upgraded = new KnowledgeDatabase(path)
    openDatabases.push(upgraded)
    upgraded.initialize()
    const inspection = new DatabaseSync(path)
    expect(inspection.prepare('PRAGMA user_version').get()).toEqual({
      user_version: 11
    })
    expect(
      inspection
        .prepare(
          `SELECT name FROM sqlite_master
           WHERE type = 'table'
             AND (name = 'chunk_embeddings' OR name LIKE 'embedding_%')
           ORDER BY name`
        )
        .all()
    ).toEqual([
      { name: 'chunk_embeddings' },
      { name: 'embedding_index_job' },
      { name: 'embedding_index_state' },
      { name: 'embedding_rebuild_staging' }
    ])
    inspection.close()
    expect(
      upgraded.search({
        knowledgeBaseId: knowledgeBase.id,
        query: 'lighthouse'
      })
    ).toHaveLength(1)
  })

  it('migrates version 8 contextual indexes and remains idempotent', async () => {
    const { database, path } = await createDatabase()
    const library = database.createKnowledgeBase({
      name: 'Version eight context',
      storageMode: 'reference'
    })
    database.updateKnowledgeSettings({
      knowledgeBaseId: library.id,
      chunking: {
        ...library.chunkingSettings,
        contextualIndexingEnabled: true
      }
    })
    const emptyLibrary = database.createKnowledgeBase({
      name: 'Empty version eight context',
      storageMode: 'reference'
    })
    database.updateKnowledgeSettings({
      knowledgeBaseId: emptyLibrary.id,
      chunking: {
        ...emptyLibrary.chunkingSettings,
        contextualIndexingEnabled: true
      }
    })
    const source = database.upsertSource({
      knowledgeBaseId: library.id,
      type: 'file',
      location: 'C:\\migration-context.md',
      displayName: 'migration-context.md',
      status: 'ready'
    })
    const rawContent = 'Only the source body is shown to users.'
    const contextPrefix =
      '[context title="Migration handbook" heading="Recovery"]\n'
    const document = database.upsertDocument(
      {
        knowledgeBaseId: library.id,
        sourceId: source.id,
        externalId: 'version-eight-context',
        title: 'Migration handbook'
      },
      [{
        id: 'version-eight-context-chunk',
        ordinal: 0,
        content: rawContent,
        metadata: { contextPrefix }
      }]
    )
    database.close()

    const downgrade = new DatabaseSync(path)
    downgrade.exec(`
      DROP TRIGGER IF EXISTS chunks_after_insert;
      DROP TRIGGER IF EXISTS chunks_after_delete;
      DROP TRIGGER IF EXISTS chunks_after_update;
      DROP TABLE chunks_fts;
      CREATE VIRTUAL TABLE chunks_fts USING fts5(
        content,
        content='chunks',
        content_rowid='rowid',
        tokenize='unicode61'
      );
      CREATE TRIGGER chunks_after_insert AFTER INSERT ON chunks BEGIN
        INSERT INTO chunks_fts(rowid, content)
          SELECT new.rowid, new.content
          WHERE new.enabled = 1 AND new.role <> 'parent';
      END;
      CREATE TRIGGER chunks_after_delete AFTER DELETE ON chunks
        WHEN old.enabled = 1 AND old.role <> 'parent' BEGIN
        INSERT INTO chunks_fts(chunks_fts, rowid, content)
          VALUES ('delete', old.rowid, old.content);
      END;
      CREATE TRIGGER chunks_after_update AFTER UPDATE ON chunks BEGIN
        INSERT INTO chunks_fts(chunks_fts, rowid, content)
          SELECT 'delete', old.rowid, old.content
          WHERE old.enabled = 1 AND old.role <> 'parent';
        INSERT INTO chunks_fts(rowid, content)
          SELECT new.rowid, new.content
          WHERE new.enabled = 1 AND new.role <> 'parent';
      END;
      INSERT INTO chunks_fts(chunks_fts) VALUES ('rebuild');
      DELETE FROM schema_migrations WHERE version IN (9, 10, 11);
      PRAGMA user_version = 8;
    `)
    downgrade
      .prepare(
        `UPDATE knowledge_bases
         SET chunking_rebuild_required = 1
         WHERE id = ?`
      )
      .run(emptyLibrary.id)
    downgrade.close()

    const upgraded = new KnowledgeDatabase(path)
    openDatabases.push(upgraded)
    upgraded.initialize()
    upgraded.initialize()

    expect(upgraded.getKnowledgeBase(library.id)).toMatchObject({
      chunkingRebuildRequired: true
    })
    expect(upgraded.getKnowledgeBase(emptyLibrary.id)).toMatchObject({
      chunkingRebuildRequired: false
    })
    expect(
      upgraded.search({
        knowledgeBaseId: library.id,
        query: 'Recovery'
      })[0]
    ).toMatchObject({
      chunk: { content: rawContent },
      snippet: expect.not.stringContaining('[context')
    })
    expect(upgraded.getEmbeddingIndexDocument(document.id)?.items[0])
      .toMatchObject({
        content: `${contextPrefix}${rawContent}`,
        contentChecksum: createHash('sha256')
          .update(`${contextPrefix}${rawContent}`)
          .digest('hex')
      })

    upgraded.close()
    const reopened = new KnowledgeDatabase(path)
    openDatabases.push(reopened)
    reopened.initialize()
    expect(reopened.search({
      knowledgeBaseId: library.id,
      query: 'Recovery'
    })).toHaveLength(1)
  })

  it('indexes deterministic context while preserving raw chunks and citations', async () => {
    const { database } = await createDatabase()
    const library = database.createKnowledgeBase({
      name: 'Contextual index',
      storageMode: 'reference'
    })
    const source = database.upsertSource({
      knowledgeBaseId: library.id,
      type: 'file',
      location: 'C:\\context.md',
      displayName: 'context.md',
      status: 'ready'
    })
    const rawContent = '正文只保留原始内容。'
    const contextPrefix =
      '[context title="季度计划" heading="部署 > 离线安装"]\n'
    const document = database.upsertDocument(
      {
        knowledgeBaseId: library.id,
        sourceId: source.id,
        externalId: 'context',
        title: '季度计划'
      },
      [
        {
          id: 'context-chunk',
          ordinal: 0,
          content: rawContent,
          location: '第 3 页',
          metadata: {
            contextPrefix,
            pageNumber: 3,
            headingPath: ['部署', '离线安装'],
            blockKind: 'text'
          }
        }
      ]
    )

    const result = database.search({
      knowledgeBaseId: library.id,
      query: '离线安装'
    })[0]
    expect(result?.chunk.content).toBe(rawContent)
    expect(result?.snippet).not.toContain('[context')
    expect(result?.chunk.location).toBe('第 3 页')
    expect(database.getEmbeddingIndexDocument(document.id)?.items[0])
      .toMatchObject({
        id: 'context-chunk',
        content: `${contextPrefix}${rawContent}`,
        contentChecksum: createHash('sha256')
          .update(`${contextPrefix}${rawContent}`)
          .digest('hex')
      })
  })

  it('persists tasks, interrupts active work, dedupes, and guards terminal updates', async () => {
    const created = await createDatabase()
    let database = created.database
    const library = database.createKnowledgeBase({
      name: 'Durable tasks',
      storageMode: 'reference'
    })
    const first = database.createKnowledgeTask({
      libraryId: library.id,
      documentName: library.name,
      scope: 'library',
      kind: 'library-rebuild',
      dedupeKey: `library-rebuild:${library.id}`
    })
    expect(
      database.createKnowledgeTask({
        libraryId: library.id,
        documentName: library.name,
        scope: 'library',
        kind: 'library-rebuild',
        dedupeKey: `library-rebuild:${library.id}`
      }).id
    ).toBe(first.id)
    database.updateKnowledgeTask(first.id, {
      status: 'running',
      stage: 'parsing',
      progress: 30
    })
    database.close()

    database = new KnowledgeDatabase(created.path)
    openDatabases.push(database)
    database.initialize()
    expect(database.getKnowledgeTask(first.id)).toMatchObject({
      status: 'interrupted',
      progress: 30,
      canRetry: true,
      error: { message: expect.stringContaining('重启') }
    })
    expect(
      database.updateKnowledgeTask(first.id, {
        status: 'succeeded',
        progress: 100
      })
    ).toMatchObject({ status: 'interrupted', progress: 30 })
  })

  it('bounds task status text from runtime failures', async () => {
    const { database } = await createDatabase()
    const library = database.createKnowledgeBase({
      name: 'Bounded task status',
      storageMode: 'reference'
    })
    const task = database.createKnowledgeTask({
      libraryId: library.id,
      documentName: library.name,
      scope: 'library',
      kind: 'library-rebuild'
    })

    expect(
      database.updateKnowledgeTask(task.id, {
        status: 'failed',
        message: 'm'.repeat(2_000),
        error: {
          message: 'e'.repeat(2_000),
          remedy: 'r'.repeat(2_000)
        }
      })
    ).toMatchObject({
      status: 'failed',
      message: 'm'.repeat(1_000),
      error: {
        message: 'e'.repeat(1_000),
        remedy: 'r'.repeat(1_000)
      }
    })
  })

  it('lists every active task in addition to the terminal history limit', async () => {
    const { database } = await createDatabase()
    const library = database.createKnowledgeBase({
      name: 'Task listing',
      storageMode: 'reference'
    })
    const active = database.createKnowledgeTask({
      id: '00000000-0000-4000-8000-000000000001',
      libraryId: library.id,
      documentName: library.name,
      scope: 'library',
      kind: 'library-rebuild'
    })
    for (let index = 0; index < 501; index += 1) {
      database.createKnowledgeTask({
        libraryId: library.id,
        documentName: `terminal-${index}`,
        scope: 'document',
        kind: 'parsing',
        status: 'skipped'
      })
    }
    database.pruneKnowledgeTasks(library.id)

    const listed = database.listKnowledgeTasks(library.id)
    expect(listed).toHaveLength(501)
    expect(listed.map((task) => task.id)).toContain(active.id)
    expect(listed.filter((task) => !task.canCancel)).toHaveLength(500)
  })

  it('retains task ancestors and disables retry after targets are deleted', async () => {
    const { database } = await createDatabase()
    const library = database.createKnowledgeBase({
      name: 'Task lineage retention',
      storageMode: 'reference'
    })
    const seeded = seedDocument(database, library.id, 'lineage-target')
    const parent = database.createKnowledgeTask({
      libraryId: library.id,
      documentName: 'retained parent',
      scope: 'library',
      kind: 'library-rebuild',
      status: 'succeeded'
    })
    for (let index = 0; index < 500; index += 1) {
      database.createKnowledgeTask({
        libraryId: library.id,
        documentName: `retention-${index}`,
        scope: 'document',
        kind: 'parsing',
        status: 'skipped'
      })
    }
    database.createKnowledgeTask({
      libraryId: library.id,
      parentTaskId: parent.id,
      documentName: 'retained child',
      scope: 'document',
      kind: 'parsing',
      status: 'skipped'
    })
    const sourceTask = database.createKnowledgeTask({
      libraryId: library.id,
      sourceId: seeded.sourceId,
      documentName: 'source retry',
      scope: 'source',
      kind: 'source-sync',
      status: 'failed',
      error: { message: 'failed source' }
    })
    const documentTask = database.createKnowledgeTask({
      libraryId: library.id,
      documentId: seeded.documentId,
      sourceId: seeded.sourceId,
      documentName: 'document retry',
      scope: 'document',
      kind: 'document-rebuild',
      status: 'failed',
      error: { message: 'failed document' }
    })
    database.pruneKnowledgeTasks(library.id)

    database.removeSource(seeded.sourceId)
    expect(database.getKnowledgeTask(sourceTask.id)).toMatchObject({
      sourceId: undefined,
      canRetry: false
    })
    expect(database.getKnowledgeTask(documentTask.id)).toMatchObject({
      documentId: undefined,
      canRetry: false
    })
    expect(database.getKnowledgeTask(parent.id)).toBeDefined()
    const listed = database.listKnowledgeTasks(library.id)
    expect(listed.map((task) => task.id)).toContain(parent.id)
    expect(listed.some((task) => task.parentTaskId === parent.id)).toBe(true)
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
    expect(firstResults[0]?.snippet).toContain('lighthouse')
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

  it('lists complete source and document snapshots beyond display limits', async () => {
    const { database } = await createDatabase()
    const library = database.createKnowledgeBase({
      name: 'Complete snapshot',
      storageMode: 'reference'
    })
    for (let index = 0; index < 501; index += 1) {
      seedDocument(database, library.id, `snapshot-${index}`)
    }

    expect(database.listSources(library.id)).toHaveLength(500)
    expect(database.listDocuments(library.id)).toHaveLength(500)
    expect(database.listSourcesForSnapshot(library.id)).toHaveLength(501)
    expect(database.listDocumentsForSnapshot(library.id)).toHaveLength(501)
  }, 10_000)

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
      type: 'organization',
      aliases: ['Buddy'],
      properties: { owner: 'team' }
    })
    const source = database.createEntity({
      knowledgeBaseId: knowledgeBase.id,
      name: 'Good Buddy',
      type: 'organization',
      aliases: ['GB'],
      properties: { language: 'TypeScript' },
      locked: true
    })
    const other = database.createEntity({
      knowledgeBaseId: knowledgeBase.id,
      name: 'SQLite',
      type: 'concept'
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
      quote: 'graph evidence',
      start: 2,
      end: 8,
      confidence: 0.92,
      source: 'model',
      provenance: { strategy: 'hybrid', ontologyVersion: 1 }
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
        expect.objectContaining({
          id: entityEvidence.id,
          entityId: target.id,
          start: 2,
          end: 8,
          confidence: 0.92,
          source: 'model',
          provenance: { strategy: 'hybrid', ontologyVersion: 1 }
        }),
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

  it('finds graph identities beyond the ordinary list limit', async () => {
    const { database } = await createDatabase()
    const knowledgeBase = database.createKnowledgeBase({
      name: 'Large graph identity',
      storageMode: 'reference'
    })
    let expectedEntityId = ''
    const targetEntityIds: string[] = []
    for (let index = 0; index < 501; index += 1) {
      const entity = database.createEntity({
        knowledgeBaseId: knowledgeBase.id,
        name: `Entity ${String(index).padStart(3, '0')}`,
        type: 'CONCEPT',
        locked: false
      })
      targetEntityIds.push(entity.id)
      if (index === 500) {
        expectedEntityId = entity.id
      }
    }
    const source = database.createEntity({
      knowledgeBaseId: knowledgeBase.id,
      name: 'Relation Source',
      type: 'CONCEPT',
      locked: false
    })
    let expectedRelationId = ''
    for (let index = 0; index < 501; index += 1) {
      const relation = database.createRelation({
        knowledgeBaseId: knowledgeBase.id,
        sourceEntityId: source.id,
        targetEntityId: targetEntityIds[index]!,
        type: 'RELATED_TO',
        locked: false
      })
      if (index === 500) {
        expectedRelationId = relation.id
      }
    }

    expect(
      database.findEntityByCanonicalName(
        knowledgeBase.id,
        'CONCEPT',
        'Entity 500'
      )?.id
    ).toBe(expectedEntityId)
    expect(
      database.findRelationByIdentity(
        knowledgeBase.id,
        source.id,
        targetEntityIds[500]!,
        'RELATED_TO'
      )?.id
    ).toBe(expectedRelationId)
  }, 15_000)

  it('persists controlled ontology updates and marks graph rebuild state', async () => {
    const { database } = await createDatabase()
    const library = database.createKnowledgeBase({
      name: 'Controlled ontology',
      storageMode: 'reference',
      graphEnabled: true
    })
    const ontology = {
      ...library.ontologySettings,
      entityTypes: [
        ...library.ontologySettings.entityTypes,
        {
          id: 'PRODUCT',
          name: { zh: '产品', en: 'Product' },
          aliases: ['product', '产品']
        }
      ]
    }
    const updated = database.updateKnowledgeSettings({
      knowledgeBaseId: library.id,
      ontology
    })
    expect(updated.ontologySettings.entityTypes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'PRODUCT' })
      ])
    )
    expect(updated.ontologyRebuildRequired).toBe(true)
    database.markKnowledgeOntologyRebuilt(library.id)
    expect(database.getKnowledgeBase(library.id)?.ontologyRebuildRequired)
      .toBe(false)
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
      type: 'product',
      aliases: ['好伙伴']
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
    expect(
      database
        .graphSearch(first.id, '好伙伴使用了什么框架？', 10, 1)
        .map((result) => result.chunk.id)
    ).toEqual(expect.arrayContaining([goodBuddy.chunkId, electron.chunkId]))
  })

  it('lists rebuild work by document and updates embedding state incrementally', async () => {
    const { database } = await createDatabase()
    const knowledgeBase = database.createKnowledgeBase({
      name: 'Incremental index',
      storageMode: 'reference',
      graphEnabled: false
    })
    const alpha = seedDocument(database, knowledgeBase.id, 'incremental-alpha')
    const beta = seedDocument(database, knowledgeBase.id, 'incremental-beta')
    const documentIds = database.listEmbeddingIndexDocumentIds(
      knowledgeBase.id
    )
    const documents = documentIds.map(
      (documentId) =>
        database.getEmbeddingIndexDocument(documentId)!
    )
    expect(documentIds).toEqual(
      expect.arrayContaining([alpha.documentId, beta.documentId])
    )
    expect(documents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: alpha.documentId,
          items: [
            expect.objectContaining({
              id: alpha.chunkId,
              content: expect.stringContaining('lighthouse'),
              contentChecksum: expect.stringMatching(/^[a-f0-9]{64}$/u)
            })
          ]
        }),
        expect.objectContaining({
          id: beta.documentId,
          items: [
            expect.objectContaining({
              id: beta.chunkId,
              content: expect.stringContaining('lighthouse'),
              contentChecksum: expect.stringMatching(/^[a-f0-9]{64}$/u)
            })
          ]
        })
      ])
    )
    const alphaDocument = documents.find(
      (document) => document.id === alpha.documentId
    )!
    const betaDocument = documents.find(
      (document) => document.id === beta.documentId
    )!
    for (const [document, vector] of [
      [alphaDocument, [1, 0]],
      [betaDocument, [0, 1]]
    ] as const) {
      database.replaceDocumentEmbeddings(
        document.id,
        'openai-compatible',
        'embed-v1',
        document.items.map((item) => ({
          chunkId: item.id,
          contentChecksum: item.contentChecksum!,
          vector
        }))
      )
    }

    database.recordEmbeddingIndexError(
      beta.documentId,
      'openai-compatible',
      'embed-v1',
      '向量服务暂时不可用。'
    )
    expect(
      database.getEmbeddingIndexState(
        alpha.documentId,
        'openai-compatible',
        'embed-v1'
      )
    ).toMatchObject({ status: 'ready' })
    expect(
      database.getEmbeddingIndexState(
        beta.documentId,
        'openai-compatible',
        'embed-v1'
      )
    ).toMatchObject({
      status: 'ready',
      lastError: '向量服务暂时不可用。'
    })
    expect(
      database
        .vectorSearch({
          knowledgeBaseId: knowledgeBase.id,
          provider: 'openai-compatible',
          model: 'embed-v1',
          vector: [0, 1]
        })
        .map((result) => result.chunk.id)
    ).toContain(beta.chunkId)
    expect(
      database.getEmbeddingIndexCoverage(
        knowledgeBase.id,
        'openai-compatible',
        'embed-v1'
      )
    ).toEqual({
      total: 2,
      indexed: 2,
      missing: 0,
      error: 0
    })
  })

  it('stages embedding batches before atomically replacing a document index', async () => {
    const { database } = await createDatabase()
    const knowledgeBase = database.createKnowledgeBase({
      name: 'Bounded rebuild',
      storageMode: 'reference'
    })
    const seeded = seedDocument(
      database,
      knowledgeBase.id,
      'bounded-rebuild'
    )
    const document =
      database.getEmbeddingIndexDocument(seeded.documentId)!
    const item = document.items[0]!
    database.replaceDocumentEmbeddings(
      document.id,
      'openai-compatible',
      'embed-v1',
      [
        {
          chunkId: item.id,
          contentChecksum: item.contentChecksum!,
          vector: [1, 0]
        }
      ]
    )
    const replacementId =
      database.beginDocumentEmbeddingReplacement(
        document.id,
        'openai-compatible',
        'embed-v1'
      )
    database.appendDocumentEmbeddingBatch(
      replacementId,
      document.id,
      'openai-compatible',
      'embed-v1',
      [
        {
          chunkId: item.id,
          contentChecksum: item.contentChecksum!,
          vector: [0, 1]
        }
      ]
    )
    const concurrentReplacementId =
      database.beginDocumentEmbeddingReplacement(
        document.id,
        'openai-compatible',
        'embed-v1'
      )

    expect(
      database.vectorSearch({
        knowledgeBaseId: knowledgeBase.id,
        provider: 'openai-compatible',
        model: 'embed-v1',
        vector: [1, 0]
      })[0]?.chunk.id
    ).toBe(item.id)
    database.finishDocumentEmbeddingReplacement(
      replacementId,
      document.id,
      'openai-compatible',
      'embed-v1'
    )
    database.discardDocumentEmbeddingReplacement(
      concurrentReplacementId
    )
    expect(
      database.vectorSearch({
        knowledgeBaseId: knowledgeBase.id,
        provider: 'openai-compatible',
        model: 'embed-v1',
        vector: [0, 1]
      })[0]?.chunk.id
    ).toBe(item.id)
  })

  it('rejects a staged embedding replacement after chunk content changes', async () => {
    const { database } = await createDatabase()
    const knowledgeBase = database.createKnowledgeBase({
      name: 'Stale replacement',
      storageMode: 'reference'
    })
    const seeded = seedDocument(
      database,
      knowledgeBase.id,
      'stale-replacement'
    )
    const document =
      database.getEmbeddingIndexDocument(seeded.documentId)!
    const item = document.items[0]!
    const replacementId =
      database.beginDocumentEmbeddingReplacement(
        document.id,
        'openai-compatible',
        'embed-v1'
      )
    database.appendDocumentEmbeddingBatch(
      replacementId,
      document.id,
      'openai-compatible',
      'embed-v1',
      [{
        chunkId: item.id,
        contentChecksum: item.contentChecksum!,
        vector: [1, 0]
      }]
    )
    database.updateChunk({
      knowledgeBaseId: knowledgeBase.id,
      documentId: document.id,
      chunkId: item.id,
      content: 'newer content'
    })

    expect(() =>
      database.finishDocumentEmbeddingReplacement(
        replacementId,
        document.id,
        'openai-compatible',
        'embed-v1'
      )
    ).toThrow('content changed')
    database.discardDocumentEmbeddingReplacement(replacementId)
  })

  it('publishes candidate chunks, vectors, and graph evidence atomically', async () => {
    const { database } = await createDatabase()
    const library = database.createKnowledgeBase({
      name: 'Atomic publication',
      storageMode: 'reference',
      graphEnabled: true,
      graphStrategy: 'rules'
    })
    const seeded = seedDocument(database, library.id, 'atomic-publication')
    const originalContent =
      'atomic-publication contains the searchable lighthouse phrase'
    database.replaceDocumentEmbeddings(
      seeded.documentId,
      'provider',
      'model',
      [{
        chunkId: seeded.chunkId,
        contentChecksum: createHash('sha256')
          .update(originalContent)
          .digest('hex'),
        vector: [1, 0]
      }]
    )
    const originalEntity = database.createEntity({
      knowledgeBaseId: library.id,
      name: 'Original Entity',
      type: 'CONCEPT'
    })
    database.createEvidence({
      knowledgeBaseId: library.id,
      entityId: originalEntity.id,
      documentId: seeded.documentId,
      chunkId: seeded.chunkId,
      quote: originalContent
    })
    const candidateChunkId = 'atomic-publication-candidate'
    const candidateContent = 'candidate searchable content'
    const replacementId =
      database.beginPreparedDocumentEmbeddingReplacement(
        seeded.documentId,
        'provider',
        'model'
      )
    database.appendPreparedDocumentEmbeddingBatch(
      replacementId,
      seeded.documentId,
      'provider',
      'model',
      [{
        chunkId: candidateChunkId,
        contentChecksum: createHash('sha256')
          .update(candidateContent)
          .digest('hex'),
        vector: [0, 1]
      }]
    )
    expect(() =>
      database.publishDocument(
        {
          id: seeded.documentId,
          knowledgeBaseId: library.id,
          sourceId: seeded.sourceId,
          externalId: 'atomic-publication',
          title: 'candidate'
        },
        [{
          id: candidateChunkId,
          ordinal: 0,
          content: candidateContent
        }],
        {
          embeddingReplacement: {
            replacementId,
            provider: 'provider',
            model: 'model'
          },
          afterChunksInserted: () => {
            throw new Error('synthetic graph failure')
          }
        }
      )
    ).toThrow('synthetic graph failure')
    database.discardDocumentEmbeddingReplacement(replacementId)
    expect(database.search({
      knowledgeBaseId: library.id,
      query: 'lighthouse'
    })[0]?.chunk.id).toBe(seeded.chunkId)
    expect(database.vectorSearch({
      knowledgeBaseId: library.id,
      provider: 'provider',
      model: 'model',
      vector: [1, 0],
      limit: 1
    })[0]?.chunk.id).toBe(seeded.chunkId)
    expect(database.listEvidence(library.id)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          documentId: seeded.documentId,
          chunkId: seeded.chunkId
        })
      ])
    )

    const successfulReplacementId =
      database.beginPreparedDocumentEmbeddingReplacement(
        seeded.documentId,
        'provider',
        'model'
      )
    database.appendPreparedDocumentEmbeddingBatch(
      successfulReplacementId,
      seeded.documentId,
      'provider',
      'model',
      [{
        chunkId: candidateChunkId,
        contentChecksum: createHash('sha256')
          .update(candidateContent)
          .digest('hex'),
        vector: [0, 1]
      }]
    )
    const candidateEntity = database.createEntity({
      knowledgeBaseId: library.id,
      name: 'Candidate Entity',
      type: 'CONCEPT'
    })
    database.publishDocument(
      {
        id: seeded.documentId,
        knowledgeBaseId: library.id,
        sourceId: seeded.sourceId,
        externalId: 'atomic-publication',
        title: 'candidate'
      },
      [{
        id: candidateChunkId,
        ordinal: 0,
        content: candidateContent
      }],
      {
        embeddingReplacement: {
          replacementId: successfulReplacementId,
          provider: 'provider',
          model: 'model'
        },
        afterChunksInserted: (document) => {
          database.createEvidence({
            knowledgeBaseId: library.id,
            entityId: candidateEntity.id,
            documentId: document.id,
            chunkId: candidateChunkId,
            quote: candidateContent
          })
        }
      }
    )
    expect(database.search({
      knowledgeBaseId: library.id,
      query: 'candidate'
    })[0]?.chunk.id).toBe(candidateChunkId)
    expect(database.vectorSearch({
      knowledgeBaseId: library.id,
      provider: 'provider',
      model: 'model',
      vector: [0, 1],
      limit: 1
    })[0]?.chunk.id).toBe(candidateChunkId)
    expect(database.listEvidence(library.id)).toEqual([
      expect.objectContaining({
        documentId: seeded.documentId,
        chunkId: candidateChunkId
      })
    ])
  })

  it('persists embedding index jobs independently by knowledge base', async () => {
    const created = await createDatabase()
    let database = created.database
    const knowledgeBase = database.createKnowledgeBase({
      name: 'Persisted vector job',
      storageMode: 'reference'
    })
    const otherKnowledgeBase = database.createKnowledgeBase({
      name: 'Other persisted vector job',
      storageMode: 'reference'
    })
    expect(
      database.getLastEmbeddingIndexJob(knowledgeBase.id)
    ).toBeNull()

    database.saveEmbeddingIndexJob(knowledgeBase.id, {
      id: 'job-1',
      status: 'running',
      provider: 'openai-compatible',
      model: 'embed-v1',
      progress: { completed: 1, total: 2, percent: 50 },
      createdAt: 10,
      startedAt: 11
    })
    database.saveEmbeddingIndexJob(otherKnowledgeBase.id, {
      id: 'job-2',
      status: 'completed',
      provider: 'openai-compatible',
      model: 'embed-v1',
      progress: { completed: 3, total: 3, percent: 100 },
      createdAt: 20,
      startedAt: 21,
      completedAt: 22
    })
    database.close()
    database = new KnowledgeDatabase(created.path)
    openDatabases.push(database)
    database.initialize()

    expect(
      database.getLastEmbeddingIndexJob(knowledgeBase.id)
    ).toMatchObject({
      id: 'job-1',
      status: 'running',
      progress: { completed: 1, total: 2, percent: 50 }
    })
    expect(
      database.getLastEmbeddingIndexJob(otherKnowledgeBase.id)
    ).toMatchObject({
      id: 'job-2',
      status: 'completed'
    })
    database.saveEmbeddingIndexJob(knowledgeBase.id, null)
    expect(
      database.getLastEmbeddingIndexJob(knowledgeBase.id)
    ).toBeNull()
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

  it('persists per-library settings and recalls Chinese text with indexed bigrams', async () => {
    const { database } = await createDatabase()
    const library = database.createKnowledgeBase({
      name: '中文制度',
      storageMode: 'reference',
      graphEnabled: false
    })
    const source = database.upsertSource({
      knowledgeBaseId: library.id,
      type: 'file',
      location: 'C:\\制度.md',
      displayName: '制度.md',
      status: 'ready'
    })
    database.upsertDocument(
      {
        knowledgeBaseId: library.id,
        sourceId: source.id,
        externalId: '制度',
        title: '远程办公制度'
      },
      [
        {
          ordinal: 0,
          content: '员工申请远程办公需要提前提交审批材料。'
        }
      ]
    )
    expect(
      database.search({
        knowledgeBaseId: library.id,
        query: '远程工作怎么申请'
      })
    ).toHaveLength(1)

    const updated = database.updateKnowledgeSettings({
      knowledgeBaseId: library.id,
      retrieval: {
        ...library.retrievalSettings,
        topK: 9,
        vectorWeight: 0.5
      },
      chunking: {
        ...library.chunkingSettings,
        mode: 'parent-child'
      }
    })
    expect(updated.retrievalSettings).toMatchObject({
      topK: 9,
      vectorWeight: 0.5
    })
    expect(updated.chunkingRebuildRequired).toBe(true)
  })

  it('keeps parent chunks out of recall and synchronizes chunk mutations', async () => {
    const { database } = await createDatabase()
    const library = database.createKnowledgeBase({
      name: 'Chunk states',
      storageMode: 'reference',
      graphEnabled: false
    })
    const source = database.upsertSource({
      knowledgeBaseId: library.id,
      type: 'file',
      location: 'C:\\parent.md',
      displayName: 'parent.md',
      status: 'ready'
    })
    const document = database.upsertDocument(
      {
        knowledgeBaseId: library.id,
        sourceId: source.id,
        externalId: 'parent',
        title: 'Parent'
      },
      [
        {
          id: 'child-chunk',
          ordinal: 1,
          role: 'child',
          parentChunkId: 'parent-chunk',
          content: 'recallable child text'
        },
        {
          id: 'parent-chunk',
          ordinal: 0,
          role: 'parent',
          content: 'parent-only-secret complete context'
        }
      ]
    )
    expect(
      database.search({
        knowledgeBaseId: library.id,
        query: 'parent-only-secret'
      })
    ).toEqual([])
    expect(
      database.search({ knowledgeBaseId: library.id, query: 'recallable' })
    ).toHaveLength(1)
    expect(
      database.listContextChunks(
        database.listChunks(document.id, 10)[1]!,
        0
      ).map((chunk) => chunk.id)
    ).toEqual(['parent-chunk'])
    const graphEntity = database.createEntity({
      knowledgeBaseId: library.id,
      name: 'Chunk evidence',
      type: 'CONCEPT',
      locked: false
    })
    const evidence = database.createEvidence({
      knowledgeBaseId: library.id,
      entityId: graphEntity.id,
      documentId: document.id,
      chunkId: 'child-chunk',
      quote: 'recallable child text',
      source: 'rules'
    })

    database.updateChunk({
      knowledgeBaseId: library.id,
      documentId: document.id,
      chunkId: 'child-chunk',
      enabled: false
    })
    expect(
      database.search({ knowledgeBaseId: library.id, query: 'recallable' })
    ).toEqual([])
    expect(database.listEvidence(library.id)).toEqual([
      expect.objectContaining({ id: evidence.id })
    ])
    expect(
      database.graphSearch(library.id, 'Chunk evidence')
    ).toEqual([])
    database.updateChunk({
      knowledgeBaseId: library.id,
      documentId: document.id,
      chunkId: 'child-chunk',
      enabled: true,
      content: '人工修正后的可检索文本'
    })
    expect(
      database.search({ knowledgeBaseId: library.id, query: '人工修正' })
    ).toHaveLength(1)
    expect(database.listEvidence(library.id)).toEqual([])
    expect(
      database.listChunksPage({
        knowledgeBaseId: library.id,
        documentId: document.id,
        page: 1,
        pageSize: 10,
        search: '修正'
      })
    ).toMatchObject({
      total: 1,
      items: [
        expect.objectContaining({
          id: 'child-chunk',
          enabled: true,
          manuallyEdited: true
        })
      ]
    })
    expect(
      database.deleteChunk({
        knowledgeBaseId: library.id,
        documentId: document.id,
        chunkId: 'child-chunk'
      })
    ).toBe(true)
  })

  it('streams exact vector search beyond five thousand chunks', async () => {
    const { database } = await createDatabase()
    const library = database.createKnowledgeBase({
      name: 'Large vectors',
      storageMode: 'reference',
      graphEnabled: false
    })
    const source = database.upsertSource({
      knowledgeBaseId: library.id,
      type: 'file',
      location: 'C:\\large.txt',
      displayName: 'large.txt',
      status: 'ready'
    })
    const chunks = Array.from({ length: 5_001 }, (_, index) => ({
      id: `large-${index}`,
      ordinal: index,
      content: `bounded vector content ${index}`
    }))
    const document = database.upsertDocument(
      {
        knowledgeBaseId: library.id,
        sourceId: source.id,
        externalId: 'large',
        title: 'Large'
      },
      chunks
    )
    database.replaceDocumentEmbeddings(
      document.id,
      'provider',
      'model',
      chunks.map((chunk, index) => ({
        chunkId: chunk.id,
        contentChecksum: createHash('sha256')
          .update(chunk.content)
          .digest('hex'),
        vector: index === chunks.length - 1 ? [1, 0] : [0, 1]
      }))
    )
    expect(
      database.vectorSearch({
        knowledgeBaseId: library.id,
        provider: 'provider',
        model: 'model',
        vector: [1, 0],
        limit: 1,
        minimumSimilarity: 0.5
      })[0]?.chunk.id
    ).toBe('large-5000')
  })
})

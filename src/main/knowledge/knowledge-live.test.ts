import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { KnowledgeService } from './knowledge-service'
import { OpenAIEmbeddingClient } from './openai-embedding-client'

const endpoint =
  process.env.GOODBUDDY_LIVE_EMBEDDING_ENDPOINT?.trim()
const model = process.env.GOODBUDDY_LIVE_EMBEDDING_MODEL?.trim()
const liveIt = endpoint && model ? it : it.skip

describe('live knowledge embeddings', () => {
  liveIt(
    'uses the configured provider for indexing and semantic retrieval',
    async () => {
      const directory = await mkdtemp(
        join(tmpdir(), 'goodbuddy-live-embedding-')
      )
      const client = new OpenAIEmbeddingClient({
        endpoint: endpoint!,
        model: model!,
        apiKey:
          process.env.GOODBUDDY_LIVE_EMBEDDING_API_KEY,
        batchSize: 8,
        timeoutMs: 60_000
      })
      const service = new KnowledgeService({
        databasePath: join(directory, 'knowledge.sqlite'),
        managedRoot: join(directory, 'managed'),
        embeddingProvider: client
      })
      try {
        await service.initialize()
        const sourcePath = join(directory, 'offline-guide.txt')
        await writeFile(
          sourcePath,
          '在没有网络的环境中，先准备经过校验的安装包，再导入本地部署。',
          'utf8'
        )
        const library = service.createLibrary({
          name: 'Live embedding test',
          storageMode: 'reference',
          graphEnabled: false
        })
        await service.importPaths(library.id, [sourcePath])

        const response = await service.retrieve({
          knowledgeBaseId: library.id,
          query: '断网时怎样安装软件？',
          settings: {
            ...library.retrievalSettings,
            ftsWeight: 0,
            vectorWeight: 1,
            graphWeight: 0,
            minimumVectorSimilarity: 0
          }
        })
        expect(response.diagnostics.vectorScannedCount).toBeGreaterThan(0)
        expect(response.results[0]?.channels).toContain('vector')
        expect(response.results[0]?.documentTitle).toBe(
          'offline-guide'
        )
      } finally {
        await service.dispose()
        await rm(directory, { recursive: true, force: true })
      }
    },
    180_000
  )
})

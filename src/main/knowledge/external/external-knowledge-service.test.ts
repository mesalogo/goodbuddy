import { createServer, type Server } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, expect, it, vi } from 'vitest'
import { KnowledgeService } from '../knowledge-service'
import { KnowledgeMcpGateway } from '../../agent/knowledge-mcp-gateway'
import { knowledgeReferenceKey, toKnowledgeReference } from '../../../shared/knowledge-reference'
import { conversationMessageSchema } from '../../../shared/assistant-contracts'

const services: KnowledgeService[] = []
const directories: string[] = []
const servers: Server[] = []
afterEach(async () => {
  await Promise.all(services.splice(0).map(service => service.dispose()))
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))))
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

async function setup(fetcher?: typeof fetch) {
  const directory = await mkdtemp(join(tmpdir(), 'external-kb-'))
  directories.push(directory)
  const path = join(directory, 'knowledge.db')
  const cipher = { isAvailable: () => true, encrypt: (value: string) => Buffer.from(value), decrypt: (value: Buffer) => value.toString() }
  const options = { databasePath: path, managedRoot: join(directory, 'managed'), externalFetcher: fetcher, credentialCipher: cipher }
  const service = new KnowledgeService(options)
  await service.initialize()
  services.push(service)
  return { service, path, cipher, options }
}

const commonConfig = { resultLimit: 20, requestTimeoutMs: 1000, maxSnippetCharacters: 8000 }
const providerConfig = { provider: 'dify' as const, useDatasetDefaults: true as const }
const records = (count = 1, size = 16) => ({ records: Array.from({ length: count }, (_, index) => ({
  score: 0.8, segment: { id: `chunk-${index}`, content: 'e'.repeat(size), document: { id: 'remote-doc', name: 'Handbook' } }
})) })

function instance(service: KnowledgeService, baseUrl = 'https://kb.example/v1') {
  return service.external.saveInstance({ name: 'Dify', provider: 'dify', baseUrl, enabled: true, credential: { action: 'replace', value: 'test-key' } })
}

function bindingInput(instanceId: string, remoteKnowledgeBaseId = 'dataset') {
  return { instanceId, remoteKnowledgeBaseId, name: 'Handbook', remoteName: 'Remote handbook', testQuery: 'policy', commonConfig, providerConfig }
}

function retrievalInput(instanceId: string) {
  return { instanceId, remoteKnowledgeBaseId: 'dataset', testQuery: 'policy', commonConfig, providerConfig }
}

it('routes the real HTTP client through directory, detail, binding and scoped MCP without remote writes', async () => {
  const requests: string[] = []
  const server = createServer((request, response) => {
    requests.push(`${request.method} ${request.url}`)
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify(request.url?.includes('/retrieve') ? records() : request.url?.includes('?')
      ? { data: [{ id: 'dataset', name: 'Handbook' }], has_more: false }
      : { id: 'dataset', name: 'Handbook' }))
  })
  servers.push(server)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as { port: number }
  const { service } = await setup()
  const saved = instance(service, `http://127.0.0.1:${address.port}/v1`)
  expect(saved).not.toHaveProperty('credential')
  expect((await service.external.listCatalog({ instanceId: saved.id })).items).toHaveLength(1)
  expect(await service.external.getCatalog({ instanceId: saved.id, remoteKnowledgeBaseId: 'dataset' })).toMatchObject({ id: 'dataset' })
  const binding = await service.external.saveBinding(bindingInput(saved.id))
  const gateway = new KnowledgeMcpGateway(service)
  const token = gateway.grant('request', [binding.knowledgeBaseId], new AbortController().signal)!
  try {
    const references = await gateway.search(token, { query: 'policy' })
    expect(references).toHaveLength(1)
    expect(references[0]).toMatchObject({ external: { remoteDocumentId: 'remote-doc', remoteChunkId: 'chunk-0', providerScore: 0.8 } })
    expect(references[0]?.documentId).toBeUndefined()
    expect(service.database.listDocuments(binding.knowledgeBaseId)).toEqual([])
    expect(requests).toEqual(['GET /v1/datasets?page=1&limit=100', 'GET /v1/datasets/dataset', 'POST /v1/datasets/dataset/retrieve', 'POST /v1/datasets/dataset/retrieve'])
  } finally { await gateway.dispose() }
})

it('keeps actual failures, bounds mixed retrieval to 48k, and rejects local mutations', async () => {
  const fetcher = vi.fn<typeof fetch>(async () => Response.json(records(20, 8000)))
  const { service } = await setup(fetcher)
  const saved = instance(service)
  const first = await service.external.saveBinding(bindingInput(saved.id))
  const second = await service.external.saveBinding(bindingInput(saved.id, 'second'))
  const results = await service.retrieveMany([first.knowledgeBaseId, second.knowledgeBaseId], 'policy')
  expect(results.flatMap(item => item.response.results).reduce((sum, result) => sum + result.snippet.length, 0)).toBe(48000)
  fetcher.mockResolvedValue(new Response('', { status: 401 }))
  const failed = await service.retrieveMany([first.knowledgeBaseId], 'policy')
  expect(failed[0]?.response.diagnostics.failure).toBe('EXTERNAL_KB_AUTH')
  await expect(service.importPaths(first.knowledgeBaseId, [])).rejects.toThrow('EXTERNAL_KB_READ_ONLY')
  await expect(service.rebuildLibrary({ knowledgeBaseId: first.knowledgeBaseId })).rejects.toThrow('EXTERNAL_KB_READ_ONLY')
  expect(() => service.updateSettings({ knowledgeBaseId: first.knowledgeBaseId, retrieval: service.database.getKnowledgeBase(first.knowledgeBaseId)!.retrievalSettings })).toThrow('EXTERNAL_KB_READ_ONLY')
  expect(() => service.database.updateKnowledgeBase(first.knowledgeBaseId, { graphEnabled: true })).toThrow('EXTERNAL_KB_READ_ONLY')
})

it('rolls metadata back with binding failures and rejects concurrent duplicate creates', async () => {
  const { service, path } = await setup(async () => Response.json(records()))
  const saved = instance(service)
  const first = await service.external.saveBinding(bindingInput(saved.id))
  const inspection = new DatabaseSync(path)
  inspection.exec("CREATE TRIGGER reject_binding BEFORE UPDATE ON external_knowledge_bindings BEGIN SELECT RAISE(ABORT, 'binding failed'); END")
  try {
    await expect(service.external.saveBinding({ ...bindingInput(saved.id), knowledgeBaseId: first.knowledgeBaseId, name: 'Changed' })).rejects.toThrow('binding failed')
    expect(service.database.getKnowledgeBase(first.knowledgeBaseId)?.name).toBe('Handbook')
    expect(inspection.prepare('PRAGMA user_version').get()).toEqual({ user_version: 12 })
  } finally { inspection.close() }
  const outcomes = await Promise.allSettled([service.external.saveBinding(bindingInput(saved.id, 'new')), service.external.saveBinding(bindingInput(saved.id, 'new'))])
  expect(outcomes.filter(item => item.status === 'fulfilled')).toHaveLength(1)
  expect(service.database.listKnowledgeBases()).toHaveLength(2)
})

it('cancels pending probes on disable and prevents shutdown writeback', async () => {
  let release!: (value: Response) => void
  const fetcher = vi.fn<typeof fetch>(() => new Promise<Response>(resolve => { release = resolve }))
  const { service } = await setup(fetcher)
  const saved = instance(service)
  const probe = service.external.testInstance(saved.id)
  service.external.setEnabled(saved.id, false)
  release(Response.json({ data: [], has_more: false }))
  await expect(probe).rejects.toThrow('EXTERNAL_KB_CONFIG_CHANGED')
  expect(service.external.listInstances()[0]?.enabled).toBe(false)
  service.external.setEnabled(saved.id, true)
  const pending = service.external.saveBinding(bindingInput(saved.id))
  const rejected = expect(pending).rejects.toThrow()
  await service.dispose()
  services.splice(services.indexOf(service), 1)
  release(Response.json(records()))
  await rejected
  expect(() => service.external.listInstances()).toThrow('EXTERNAL_KB_CANCELLED')
})

it('persists external locators without local IDs and distinguishes remote chunks', async () => {
  const { service } = await setup(async () => Response.json(records(2)))
  const binding = await service.external.saveBinding(bindingInput(instance(service).id))
  const response = await service.retrieve({ knowledgeBaseId: binding.knowledgeBaseId, query: 'policy' })
  const references = response.results.map(result => toKnowledgeReference(result, 'Handbook'))
  expect(knowledgeReferenceKey(references[0]!)).not.toBe(knowledgeReferenceKey(references[1]!))
  const message = conversationMessageSchema.parse({ id: crypto.randomUUID(), role: 'assistant', content: '', createdAt: 1, state: 'complete', sourceReferences: references })
  expect(message.sourceReferences?.[0]?.external).toEqual(references[0]?.external)
})

it('reports unusable credentials and preserves the stored key when encryption fails', async () => {
  const fetcher = vi.fn<typeof fetch>(async () => Response.json(records()))
  const { service, cipher } = await setup(fetcher)
  const saved = instance(service)
  const before = service.database.externalStore.getInstance(saved.id)
  const decrypt = vi.spyOn(cipher, 'decrypt').mockImplementation(() => { throw new Error('OS key unavailable') })
  expect(service.external.listInstances()[0]?.credentialStatus).toBe('unavailable')
  await expect(service.external.testRetrieval(retrievalInput(saved.id))).rejects.toThrow('EXTERNAL_KB_CREDENTIAL_UNAVAILABLE')
  decrypt.mockReturnValue(JSON.stringify('  '))
  expect(service.external.listInstances()[0]?.credentialStatus).toBe('unavailable')
  await expect(service.external.testRetrieval(retrievalInput(saved.id))).rejects.toThrow('EXTERNAL_KB_CREDENTIAL_UNAVAILABLE')
  expect(fetcher).not.toHaveBeenCalled()
  decrypt.mockRestore()
  vi.spyOn(cipher, 'encrypt').mockImplementation(() => { throw new Error('OS encryption failed') })
  expect(() => service.external.saveInstance({ id: saved.id, name: 'Changed', provider: saved.provider, baseUrl: saved.baseUrl, enabled: true,
    credential: { action: 'replace', value: 'new-key' } })).toThrow('EXTERNAL_KB_CREDENTIAL_UNAVAILABLE')
  expect(service.database.externalStore.getInstance(saved.id)).toEqual(before)
  expect(service.external.listInstances()[0]?.credentialStatus).toBe('configured')
})

it('persists keep and clear credential mutations and normalized binding updates across restart', async () => {
  const { service, options } = await setup(async () => Response.json(records()))
  const saved = instance(service)
  const binding = await service.external.saveBinding(bindingInput(saved.id))
  const credential = service.database.externalStore.getInstance(saved.id)?.credential
  service.external.saveInstance({ id: saved.id, name: 'Renamed', provider: saved.provider, baseUrl: saved.baseUrl, enabled: true, credential: { action: 'keep' } })
  const updated = await service.external.saveBinding({ ...bindingInput(saved.id), knowledgeBaseId: ` ${binding.knowledgeBaseId} `, name: 'Updated' })
  expect(updated.knowledgeBaseId).toBe(binding.knowledgeBaseId)
  expect(service.database.externalStore.getInstance(saved.id)?.credential).toEqual(credential)
  await service.dispose()
  services.splice(services.indexOf(service), 1)
  const reopened = new KnowledgeService(options)
  services.push(reopened)
  await reopened.initialize()
  expect(reopened.external.listInstances()[0]).toMatchObject({ name: 'Renamed', credentialStatus: 'configured', bindingCount: 1 })
  expect(reopened.database.getKnowledgeBase(binding.knowledgeBaseId)?.name).toBe('Updated')
  expect(reopened.database.externalStore.listBindings()).toEqual([updated])
  await expect(reopened.external.testRetrieval(retrievalInput(saved.id))).resolves.toMatchObject({ results: [expect.anything()] })
  reopened.external.saveInstance({ id: saved.id, name: 'Renamed', provider: saved.provider, baseUrl: saved.baseUrl, enabled: true, credential: { action: 'clear' } })
  expect(reopened.external.listInstances()[0]).toMatchObject({ credentialStatus: 'missing', bindingCount: 1 })
  const inspection = new DatabaseSync(options.databasePath)
  try {
    const row = inspection.prepare('SELECT value_json FROM external_knowledge_instances WHERE id=?').get(saved.id)!
    expect(JSON.parse(String(row.value_json))).not.toHaveProperty('credential')
  } finally { inspection.close() }
  await expect(reopened.external.testRetrieval(retrievalInput(saved.id))).rejects.toThrow('EXTERNAL_KB_CREDENTIAL_UNAVAILABLE')
})

it('does not invalidate retrieval or binding verification when a concurrent probe persists its result', async () => {
  const releases: ((response: Response) => void)[] = []
  const { service } = await setup(() => new Promise<Response>(resolve => releases.push(resolve)))
  const saved = instance(service)
  const binding = service.external.saveBinding(bindingInput(saved.id))
  const retrieval = service.external.testRetrieval(retrievalInput(saved.id))
  const probe = service.external.testInstance(saved.id)
  releases[2]!(Response.json({ data: [], has_more: false }))
  await expect(probe).resolves.toMatchObject({ probeStatus: 'catalog-ready' })
  releases[0]!(Response.json(records()))
  releases[1]!(Response.json(records()))
  await expect(binding).resolves.toMatchObject({ instanceId: saved.id })
  await expect(retrieval).resolves.toMatchObject({ results: [expect.anything()] })
  expect(service.external.listInstances()[0]?.probeStatus).toBe('catalog-ready')
})

it('normalizes pre-request cancellation and persists network probe failures as unreachable', async () => {
  const fetcher = vi.fn<typeof fetch>(async () => { throw new TypeError('fetch failed') })
  const { service } = await setup(fetcher)
  const saved = instance(service)
  await expect(service.external.testRetrieval(retrievalInput(saved.id), AbortSignal.abort())).rejects.toMatchObject({ code: 'EXTERNAL_KB_CANCELLED' })
  expect(fetcher).not.toHaveBeenCalled()
  await expect(service.external.testInstance(saved.id)).resolves.toMatchObject({ probeStatus: 'unreachable', lastErrorCode: 'EXTERNAL_KB_NETWORK' })
})

it('includes the RAGFlow capability check in the retrieval timeout budget', async () => {
  const fetcher = vi.fn<typeof fetch>(async url => {
    await new Promise(resolve => setTimeout(resolve, 600))
    return Response.json(String(url).includes('/datasets')
      ? { code: 0, data: [{ id: 'dataset', name: 'Graph', graphrag_task_finish_at: 1 }] }
      : { code: 0, data: { chunks: [] } })
  })
  const { service } = await setup(fetcher)
  const saved = service.external.saveInstance({ name: 'RAGFlow', provider: 'ragflow', baseUrl: 'https://kb.example', enabled: true, credential: { action: 'replace', value: 'test-key' } })
  await expect(service.external.testRetrieval({ ...retrievalInput(saved.id), providerConfig: {
    provider: 'ragflow', similarityThreshold: 0.2, vectorSimilarityWeight: 0.3, knnTopK: 10, useKg: true, includeKnowledgeCompilation: false
  } })).rejects.toMatchObject({ code: 'EXTERNAL_KB_TIMEOUT' })
  expect(fetcher).toHaveBeenCalledTimes(2)
})

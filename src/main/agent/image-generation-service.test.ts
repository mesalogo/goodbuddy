import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { AssistantDatabase } from '../assistant/assistant-database'
import { ImageGenerationService, type ImageServiceSettings, type ImageGenerationServiceOptions } from './image-generation-service'
import { imageOperationSchema, type ImageOperation } from '../../shared/image-generation-contracts'
import { KnowledgeMcpGateway } from './knowledge-mcp-gateway'
import { ModelToolProvider } from './model-tool-provider'

vi.mock('electron', () => ({ nativeImage: { createFromBuffer: () => ({ isEmpty: () => false, toPNG: () => Buffer.from(png, 'base64'), toJPEG: () => Buffer.from('jpeg-bytes') }) } }))
const png = 'iVBORw0KGgo='
const cleanups: (() => void | Promise<void>)[] = []
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'goodbuddy-save-image-'))
  cleanups.push(() => rm(dir, { recursive: true, force: true }))
  return dir
}
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

function setup(fetcher = vi.fn<typeof fetch>(async () => Response.json({ data: [{ b64_json: png }] })), observers: Pick<ImageGenerationServiceOptions, 'onOperation' | 'onUsage' | 'onError'> = {}) {
  const database = new AssistantDatabase(':memory:')
  database.initialize(process.cwd())
  cleanups.push(() => database.close())
  const context = { conversationId: randomUUID(), messageId: randomUUID(), requestId: randomUUID() }
  const message = { id: context.messageId, role: 'assistant' as const, content: '', createdAt: Date.now(), state: 'complete' as const }
  const header = { id: context.conversationId, title: 'Images', updatedAt: Date.now() }
  database.saveLocalConversations([{ header, messages: [message] }])
  const profile = { id: randomUUID(), name: 'Image A', modelName: 'image-a', protocol: 'openai-images-generations',
    allowConversationInvocation: true, baseUrl: 'https://provider.test/v1', authentication: 'api-key' as const, apiKey: 'test-secret' }
  const settings: ImageServiceSettings = { modelProfiles: [profile], defaultImageModelProfileId: profile.id }
  const events: ImageOperation[] = []
  const storage = {
    getConversation: async (...args: Parameters<AssistantDatabase['getConversation']>) => database.getConversation(...args),
    getArtifact: async (...args: Parameters<AssistantDatabase['getArtifact']>) => database.getArtifact(...args),
    saveConversationImageOperation: async (...args: Parameters<AssistantDatabase['saveConversationImageOperation']>) => database.saveConversationImageOperation(...args),
    saveConversationImageSources: async (...args: Parameters<AssistantDatabase['saveConversationImageSources']>) => database.saveConversationImageSources(...args),
    markUnfinishedImageOperationsUnconfirmed: async () => database.markUnfinishedImageOperationsUnconfirmed()
  }
  const service = new ImageGenerationService({ database: storage, getSettings: async () => settings, fetcher,
    onOperation: operation => { imageOperationSchema.parse(operation); events.push(operation); observers.onOperation?.(operation) }, onUsage: observers.onUsage, onError: observers.onError })
  service.initialize()
  cleanups.push(() => service.dispose())
  return { database, storage, service, context, fetcher, settings, profile, events, header, message }
}

describe('Main conversation image service', () => {
  it('awaits usage persistence and reports its failure to callers and shutdown', async () => {
    let rejectUsage!: (error: Error) => void
    const onUsage = vi.fn(() => new Promise<void>((_resolve, reject) => { rejectUsage = reject }))
    const h = setup(vi.fn<typeof fetch>(async () => Response.json({ data: [{ b64_json: png }], usage: { input_tokens: 2, output_tokens: 3 } })), { onUsage })
    const pending = h.service.bind(h.context).call({ intent: 'create', prompt: 'Blue' }, 'usage')
    const rejected = expect(pending).rejects.toThrow('Usage storage failed')
    await vi.waitFor(() => expect(onUsage).toHaveBeenCalledOnce())
    expect(h.events.at(-1)?.state).not.toBe('completed')
    rejectUsage(new Error('Usage storage failed'))
    await rejected
    await expect(h.service.dispose()).rejects.toThrow('Usage storage failed')
    cleanups.pop()
  })

  it('does not notify completion or finish shutdown before the image write commits', async () => {
    const h = setup()
    const save = h.database.saveConversationImageOperation.bind(h.database)
    let commit!: () => void
    vi.spyOn(h.storage, 'saveConversationImageOperation').mockImplementation((operation, image) => {
      if (!image) return Promise.resolve(save(operation, image))
      return new Promise(resolve => { commit = () => resolve(save(operation, image)) })
    })
    const pending = h.service.bind(h.context).call({ intent: 'create', prompt: 'Blue' }, 'delayed-write')
    await vi.waitFor(() => expect(commit).toBeTypeOf('function'))
    expect(h.events.at(-1)?.state).toBe('saving')
    const closed = vi.fn()
    const closing = h.service.dispose().then(closed)
    await Promise.resolve()
    expect(closed).not.toHaveBeenCalled()
    commit()
    expect((await pending).state).toBe('completed')
    await closing
  })

  it('does not let a destroyed Renderer prevent submission or overwrite completion', async () => {
    const onError = vi.fn()
    const h = setup(vi.fn<typeof fetch>(async () => Response.json({ data: [{ b64_json: png }], usage: { input_tokens: 2, output_tokens: 3 } })), {
      onOperation: () => { throw new Error('Renderer is destroyed') },
      onUsage: async () => {}, onError
    })
    const operation = await h.service.bind(h.context).call({ intent: 'create', prompt: 'Blue' }, 'observer')
    expect(operation.state).toBe('completed')
    expect((await h.service.getOperation(h.context.conversationId, operation.id)).state).toBe('completed')
    expect(h.fetcher).toHaveBeenCalledOnce()
    expect(onError).toHaveBeenCalled()
  })

  it('returns the known persistence failure instead of a stale running state when the database stops accepting writes', async () => {
    const onError = vi.fn()
    const h = setup(undefined, { onError })
    h.fetcher.mockImplementation(async () => {
      vi.spyOn(h.database, 'saveConversationImageOperation').mockImplementation(() => { throw new Error('Disk full') })
      return Response.json({ data: [{ b64_json: png }] })
    })
    await expect(h.service.bind(h.context).call({ intent: 'create', prompt: 'Blue' }, 'disk-full')).rejects.toThrow('Disk full')
    await expect(h.service.dispose()).rejects.toThrow('Disk full')
    cleanups.pop()
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'Disk full' }))
    expect(h.fetcher).toHaveBeenCalledOnce()
  })
  it('saves before publishing, preserves metadata against stale renderer saves, and edits durable history', async () => {
    const h = setup()
    const first = await h.service.bind(h.context).call({ intent: 'create', prompt: 'Blue circle' }, 'first')
    expect(first.state).toBe('completed')
    expect(h.database.getArtifact(first.artifactIds[0]!).content).toContain(png)
    h.database.saveLocalConversations([{ header: h.header, messages: [h.message] }])
    expect(await h.service.getOperation(h.context.conversationId, first.id)).toEqual(first)
    expect(h.database.getConversation(h.context.conversationId).messages[0]!.artifactIds).toEqual(first.artifactIds)
    h.settings.defaultImageModelProfileId = randomUUID()
    const second = await h.service.bind({ ...h.context, requestId: randomUUID() }).call({ intent: 'edit', prompt: 'Turn red', sourceArtifactIds: first.artifactIds }, 'edit')
    expect(second.modelProfileId).toBe(first.modelProfileId)
    expect(String(h.fetcher.mock.calls[1]![0])).toMatch(/images\/edits$/u)
    expect((h.fetcher.mock.calls[1]![1]!.body as FormData).get('image')).toBeInstanceOf(Blob)
    expect(h.events.map(event => event.state)).toEqual(['running', 'saving', 'completed', 'running', 'saving', 'completed'])
  })

  it('persists upload bytes and rejects cross-conversation or missing source references', async () => {
    const h = setup()
    const ids = await h.service.persistUploads(h.context, [{ name: 'upload.png', mediaType: 'image/png', data: png }])
    h.database.saveLocalConversations([{ header: h.header, messages: [h.message] }])
    expect(h.database.getConversation(h.context.conversationId).messages[0]!.imageSourceArtifactIds).toEqual(ids)
    const binding = h.service.bind(h.context)
    expect((await binding.call({ intent: 'edit', prompt: 'Blue', sourceArtifactIds: ids }, 'upload')).state).toBe('completed')
    await expect(binding.call({ intent: 'edit', prompt: 'Blue', sourceArtifactIds: [randomUUID()] }, 'foreign')).rejects.toThrow('not available')
    await expect(binding.call({ intent: 'edit', prompt: 'Blue' }, 'missing')).rejects.toThrow('requires source')
    expect(h.fetcher).toHaveBeenCalledTimes(1)
  })

  it('rejects absent, disabled, deleted defaults without silent fallback', async () => {
    const h = setup()
    const binding = h.service.bind(h.context)
    expect(await binding.describe()).toContain(h.profile.id)
    h.profile.allowConversationInvocation = false
    await expect(binding.call({ intent: 'create', prompt: 'Blue' }, 'disabled')).rejects.toThrow('unavailable')
    h.profile.allowConversationInvocation = true
    h.settings.defaultImageModelProfileId = randomUUID()
    await expect(binding.call({ intent: 'create', prompt: 'Blue' }, 'deleted')).rejects.toThrow('unavailable')
    h.settings.defaultImageModelProfileId = null
    await expect(binding.call({ intent: 'create', prompt: 'Blue' }, 'absent')).rejects.toThrow('default')
    expect(h.fetcher).not.toHaveBeenCalled()
    expect(await binding.call({ intent: 'create', prompt: 'Blue', modelProfileId: h.profile.id }, 'enabled')).toMatchObject({ state: 'completed' })
  })

  it('continues after chat abort and pins the accepted profile while a replacement binding starts', async () => {
    let resolve!: (response: Response) => void
    const h = setup(vi.fn<typeof fetch>(() => new Promise(done => { resolve = done })))
    const controller = new AbortController()
    const pending = h.service.bind(h.context).call({ intent: 'create', prompt: 'Blue' }, 'call', controller.signal)
    await vi.waitFor(() => expect(h.fetcher).toHaveBeenCalledOnce())
    const providerSignal = h.fetcher.mock.calls[0]![1]!.signal!
    controller.abort()
    expect((await pending).state).toBe('running')
    expect(providerSignal.aborted).toBe(false)
    h.profile.modelName = 'replacement'
    h.profile.allowConversationInvocation = false
    resolve(Response.json({ data: [{ b64_json: png }] }))
    await vi.waitFor(() => expect(h.events.at(-1)?.state).toBe('completed'))
    expect(h.events.at(-1)).toMatchObject({ modelName: 'image-a', modelProfileName: 'Image A' })
    expect(JSON.parse(h.fetcher.mock.calls[0]![1]!.body as string).model).toBe('image-a')
    await expect(h.service.bind({ ...h.context, requestId: randomUUID() }).call({ intent: 'create', prompt: 'Other' }, 'other')).rejects.toThrow('unavailable')
  })

  it('deduplicates one invocation, creates a new operation on manual regenerate, and retains late cancellation output', async () => {
    let resolve!: (response: Response) => void
    const h = setup(vi.fn<typeof fetch>(() => new Promise(done => { resolve = done })))
    const binding = h.service.bind(h.context)
    const input = { intent: 'create', prompt: 'Blue' }
    const one = binding.call(input, 'same')
    const two = binding.call(input, 'same')
    await vi.waitFor(() => expect(h.events).toHaveLength(1))
    await h.service.cancel(h.context.conversationId, h.events[0]!.id)
    resolve(Response.json({ data: [{ b64_json: png }] }))
    const completed = await one
    expect(await two).toEqual(completed)
    expect(completed).toMatchObject({ state: 'completed', cancellationRequested: true })
    expect(h.fetcher).toHaveBeenCalledOnce()
    h.fetcher.mockImplementation(async () => Response.json({ data: [{ b64_json: png }] }))
    const regenerated = await h.service.regenerate(h.context, completed.id)
    expect(regenerated.id).not.toBe(completed.id)
    expect(h.fetcher).toHaveBeenCalledTimes(2)
  })

  it('never falls back to a paid generation after an edit rejection and redacts provider errors', async () => {
    const h = setup(vi.fn<typeof fetch>(async () => Response.json({ error: { message: 'Image editing not supported Authorization: Bearer private-key' } }, { status: 405 })))
    const ids = await h.service.persistUploads(h.context, [{ name: 'source', mediaType: 'image/png', data: png }])
    const result = await h.service.bind(h.context).call({ intent: 'edit', prompt: 'Blue', sourceArtifactIds: ids }, 'edit')
    expect(result.state).toBe('failed')
    expect(result.error).toContain('405')
    expect(result.error).not.toContain('private-key')
    expect(h.fetcher).toHaveBeenCalledOnce()
  })

  it('does not resurrect a deleted conversation or retain its late artifact', async () => {
    let resolve!: (response: Response) => void
    const h = setup(vi.fn<typeof fetch>(() => new Promise(done => { resolve = done })))
    const pending = h.service.bind(h.context).call({ intent: 'create', prompt: 'Blue' }, 'deleted')
    await vi.waitFor(() => expect(h.fetcher).toHaveBeenCalledOnce())
    h.database.deleteLocalConversation(h.context.conversationId)
    resolve(Response.json({ data: [{ b64_json: png }] }))
    await expect(pending).rejects.toThrow()
    await expect(h.service.dispose()).rejects.toThrow()
    cleanups.pop()
    expect(() => h.database.getConversation(h.context.conversationId)).toThrow()
    expect(h.database.listArtifacts()).toHaveLength(0)
  })

  it('marks unfinished operations unconfirmed on initialization without issuing requests', () => {
    const h = setup()
    h.database.saveConversationImageOperation({ id: randomUUID(), conversationId: h.context.conversationId, messageId: h.context.messageId,
      requestId: h.context.requestId, callId: 'old', modelProfileId: h.profile.id, modelName: h.profile.name,
      input: { intent: 'create', prompt: 'Blue', sourceArtifactIds: [] }, state: 'running', artifactIds: [], createdAt: 1, updatedAt: 1 })
    h.service.initialize()
    expect(h.database.getConversation(h.context.conversationId).messages[0]!.imageOperations![0]!.state).toBe('unconfirmed')
    expect(h.fetcher).not.toHaveBeenCalled()
  })

  it('reports provider-side uncertainty after network loss and local cancellation without retrying', async () => {
    const h = setup(vi.fn<typeof fetch>(async () => { throw new TypeError('fetch failed') }))
    const uncertain = await h.service.bind(h.context).call({ intent: 'create', prompt: 'Blue' }, 'network')
    expect(uncertain.state).toBe('unconfirmed')
    h.fetcher.mockImplementation((_url, init) => new Promise((_resolve, reject) => {
      init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason), { once: true })
    }))
    const pending = h.service.bind(h.context).call({ intent: 'create', prompt: 'Blue' }, 'cancel')
    await vi.waitFor(() => expect(h.fetcher).toHaveBeenCalledTimes(2))
    await h.service.cancel(h.context.conversationId, h.events.at(-1)!.id)
    expect(await pending).toMatchObject({ state: 'stopped', cancellationRequested: true })
    expect(h.fetcher).toHaveBeenCalledTimes(2)
  })

  it('reuses an accepted invocation across bindings and does not skip a disabled historical model', async () => {
    const h = setup()
    const created = await h.service.bind(h.context).call({ intent: 'create', prompt: 'Blue' }, 'same')
    expect((await h.service.bind(h.context).call({ intent: 'create', prompt: 'Blue' }, 'same')).id).toBe(created.id)
    const other = { ...h.profile, id: randomUUID(), name: 'Other', modelName: 'other' }
    h.settings.modelProfiles = [h.profile, other]
    h.settings.defaultImageModelProfileId = other.id
    h.profile.allowConversationInvocation = false
    await expect(h.service.bind(h.context).call({ intent: 'edit', prompt: 'Red', sourceArtifactIds: created.artifactIds }, 'blocked-edit')).rejects.toThrow('unavailable')
    const edited = await h.service.bind(h.context).call({ intent: 'edit', prompt: 'Red', sourceArtifactIds: created.artifactIds, modelProfileId: other.id }, 'explicit-edit')
    expect(edited.modelProfileId).toBe(other.id)
    expect(h.fetcher).toHaveBeenCalledTimes(2)
  })

  it('dispatches the native Model tool through its scoped binding without a mode', async () => {
    const h = setup()
    const provider = new ModelToolProvider(process.cwd())
    cleanups.push(() => provider.dispose())
    const context = { conversationId: h.context.conversationId, imageToolBinding: h.service.bind(h.context), toolCallId: 'native' }
    const result = await provider.callTool('generate_image', { intent: 'create', prompt: 'Blue' }, new AbortController().signal, context)
    expect(JSON.stringify(result)).toContain('completed')
    expect(JSON.stringify(result)).not.toContain(png)
    await expect(provider.callTool('generate_image', { intent: 'create', prompt: 'Blue' }, new AbortController().signal, { conversationId: context.conversationId })).rejects.toThrow()
  })

  it('round trips image-only MCP discovery/call and does not abort accepted work on capability revocation', async () => {
    const h = setup()
    const gateway = new KnowledgeMcpGateway({} as never)
    await gateway.start()
    cleanups.push(() => gateway.dispose())
    const token = gateway.bindImageTool(h.service.bind(h.context), new AbortController().signal)
    const client = new Client({ name: 'image-test', version: '1' })
    cleanups.push(() => client.close())
    await client.connect(new StreamableHTTPClientTransport(new URL(gateway.getEndpoint()!), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }))
    expect((await client.listTools()).tools.map(tool => tool.name)).toEqual(['generate_image', 'save_image'])
    const result = await client.callTool({ name: 'generate_image', arguments: { intent: 'create', prompt: 'Blue' } })
    expect(JSON.stringify(result)).toContain('completed')
    expect(h.fetcher).toHaveBeenCalledOnce()
    const operation = JSON.parse((result.content as { text: string }[])[0]!.text) as ImageOperation
    const target = join(await tempDir(), 'mcp.png')
    const saved = await client.callTool({ name: 'save_image', arguments: { artifactId: operation.artifactIds[0], path: target } })
    expect(saved.isError).toBeFalsy()
    expect((await readFile(target)).toString('base64')).toBe(png)
    gateway.revoke(token)
  })

  it('saves conversation images to local files with conversion, overwrite protection and scoping', async () => {
    const h = setup()
    const created = await h.service.bind(h.context).call({ intent: 'create', prompt: 'Blue' }, 'save')
    const artifactId = created.artifactIds[0]!
    const binding = h.service.bind(h.context)
    const dir = await tempDir()
    const pngPath = join(dir, 'nested', 'out.png')
    expect(await binding.save!({ artifactId, path: pngPath })).toMatchObject({ path: pngPath, mimeType: 'image/png' })
    expect((await readFile(pngPath)).toString('base64')).toBe(png)
    await expect(binding.save!({ artifactId, path: pngPath })).rejects.toThrow('already exists')
    await expect(binding.save!({ artifactId, path: pngPath, overwrite: true })).resolves.toMatchObject({ path: pngPath })
    const jpgPath = join(dir, 'out.jpg')
    expect(await binding.save!({ artifactId, path: jpgPath })).toMatchObject({ mimeType: 'image/jpeg' })
    expect((await readFile(jpgPath)).toString()).toBe('jpeg-bytes')
    await expect(binding.save!({ artifactId, path: join(dir, 'out.webp') })).rejects.toThrow('WebP')
    await expect(binding.save!({ artifactId, path: join(dir, 'out.gif') })).rejects.toThrow('.png')
    await expect(binding.save!({ artifactId, path: 'relative.png' })).rejects.toThrow('absolute')
    await expect(binding.save!({ artifactId: randomUUID(), path: join(dir, 'x.png') })).rejects.toThrow('not available')
    expect((await binding.readForSave!(artifactId, 'image/png')).toString('base64')).toBe(png)
    await expect(binding.readForSave!(randomUUID(), 'image/png')).rejects.toThrow('not available')
    const provider = new ModelToolProvider(process.cwd())
    cleanups.push(() => provider.dispose())
    const context = { conversationId: h.context.conversationId, imageToolBinding: binding }
    const native = await provider.callTool('save_image', { artifactId, path: join(dir, 'native.png') }, new AbortController().signal, context)
    expect(JSON.stringify(native)).toContain('native.png')
    await expect(provider.callTool('save_image', { artifactId, path: join(dir, 'unbound.png') }, new AbortController().signal, { conversationId: context.conversationId })).rejects.toThrow()
    expect(h.fetcher).toHaveBeenCalledOnce()
  })

  it('offers save_image only when the conversation has images or can generate them', async () => {
    const h = setup()
    const binding = h.service.bind(h.context)
    expect(await binding.describeSave!()).toMatch(/none yet/)
    h.profile.allowConversationInvocation = false
    expect(await binding.describeSave!()).toBeUndefined()
    const text = h.database.createTextArtifact({ title: 'Text reply', content: 'Not an image' })
    h.database.saveLocalConversations([{ header: h.header, messages: [{ ...h.message, artifactIds: [text.id, randomUUID()] }] }])
    expect(await binding.describeSave!()).toBeUndefined()
    const [uploadId] = await h.service.persistUploads(h.context, [{ name: 'upload.png', mediaType: 'image/png', data: png }])
    // IDs are listed so the model can save images even when it cannot generate.
    expect(await binding.describeSave!()).toContain(uploadId)
    expect(await h.service.bind(h.context).describeSave!()).toContain(uploadId)
  })

  it('discovers and saves message.artifactIds-only images after reopening without image generation', async () => {
    const directory = await tempDir()
    const databasePath = join(directory, 'assistant.sqlite')
    let database = new AssistantDatabase(databasePath)
    database.initialize(directory)
    cleanups.push(() => database.close())
    const image = database.createImageArtifact({ title: 'Direct image reply', mimeType: 'image/png', base64: png })
    const context = { conversationId: randomUUID(), messageId: randomUUID(), requestId: randomUUID() }
    const message = { id: context.messageId, role: 'assistant' as const, content: 'Saved reply', createdAt: 1, state: 'complete' as const, artifactIds: [image.id] }
    database.saveLocalConversations([{ header: { id: context.conversationId, title: 'Direct images', updatedAt: 1 }, messages: [message] }])
    database.close()
    database = new AssistantDatabase(databasePath)
    database.initialize(directory)
    const service = new ImageGenerationService({ database, getSettings: async () => ({ modelProfiles: [] }) })
    cleanups.push(() => service.dispose())
    const binding = service.bind(context)
    expect(await binding.describe()).toBeUndefined()
    expect(await binding.describeSave!()).toContain(image.id)
    const provider = new ModelToolProvider(directory)
    cleanups.push(() => provider.dispose())
    const target = join(directory, 'reopened.png')
    await provider.callTool('save_image', { artifactId: image.id, path: target }, new AbortController().signal,
      { conversationId: context.conversationId, imageToolBinding: binding })
    expect(await readFile(target)).toEqual(Buffer.from(png, 'base64'))
    expect(database.getConversation(context.conversationId).messages[0]).toMatchObject(message)
    expect(database.getArtifact(image.id)).toEqual(image)
  })

  it('filters missing and non-image references and deduplicates before limiting recent images', async () => {
    const h = setup()
    const generated = await h.service.bind(h.context).call({ intent: 'create', prompt: 'Blue' }, 'catalog')
    const [upload] = await h.service.persistUploads(h.context, [{ name: 'upload.png', mediaType: 'image/png', data: png }])
    h.profile.allowConversationInvocation = false
    const text = h.database.createTextArtifact({ title: 'Text', content: 'Not an image' })
    const missing = randomUUID()
    const images = Array.from({ length: 34 }, (_, index) => h.database.createImageArtifact({ title: `Image ${index}`, mimeType: 'image/png', base64: png }).id)
    const readImages = async () => JSON.parse((await h.service.bind(h.context).describeSave!())!.split('Conversation images (oldest first): ')[1]!) as { artifactId: string; kind: string }[]
    expect(await readImages()).toEqual(expect.arrayContaining([
      { artifactId: upload, kind: 'upload' }, { artifactId: generated.artifactIds[0], kind: 'generated' }
    ]))
    h.database.saveLocalConversations([{ header: h.header, messages: [h.message,
      { ...h.message, id: randomUUID(), artifactIds: [...images, ...Array<string>(40).fill(images.at(-1)!), text.id, missing] }
    ] }])
    const catalog = await readImages()
    expect(catalog.map(image => image.artifactId)).toEqual(images.slice(-32))
    expect(catalog.every(image => image.kind === 'artifact')).toBe(true)
    const failure = new Error('Database read failed')
    const getArtifact = vi.spyOn(h.database, 'getArtifact').mockImplementation(() => { throw failure })
    await expect(h.service.bind(h.context).describeSave!()).rejects.toBe(failure)
    getArtifact.mockRestore()
  })
})

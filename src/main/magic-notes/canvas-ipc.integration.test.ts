// @vitest-environment node
import { mkdtemp, rm } from 'node:fs/promises'
import fs from 'node:fs'
import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DesktopApi } from '../../shared/contracts'
import type { MagicNoteCanvasContent, MagicNoteDetail } from '../../shared/magic-notes-contracts'
import { AssistantDatabase } from '../assistant/assistant-database'
import { registerIpcHandlers } from '../ipc'
import type { AgentExecutionRequest } from '../agent/runtime'
import { ApplicationSettingsStore } from '../application-settings-store'

const modelFactory = vi.hoisted(() => vi.fn())
vi.mock('../agent/create-runtime', async (importOriginal) => ({
  ...await importOriginal<typeof import('../agent/create-runtime')>(),
  createDefaultModelRuntime: modelFactory
}))

const bridge = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  api: undefined as DesktopApi | undefined,
  event: undefined as unknown
}))
vi.mock('electron', () => ({
  app: { getName: () => 'Canvas integration', getVersion: () => '0.0.0' },
  BrowserWindow: class {},
  Notification: class { static isSupported() { return false } },
  nativeImage: {}, clipboard: {}, dialog: {}, shell: {}, webUtils: {},
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) => bridge.handlers.set(channel, handler),
    removeHandler: (channel: string) => bridge.handlers.delete(channel)
  },
  ipcRenderer: {
    invoke: async (channel: string, ...args: unknown[]) => {
      const handler = bridge.handlers.get(channel)
      if (!handler) throw new Error(`Missing production handler: ${channel}`)
      return structuredClone(await handler(bridge.event, ...structuredClone(args)))
    },
    on: vi.fn(), removeListener: vi.fn()
  },
  contextBridge: { exposeInMainWorld: (_name: string, api: DesktopApi) => { bridge.api = api } }
}))
// Disable unrelated environment integrations; persistence, schemas and handlers are real.
vi.mock('../channels/channel-env', () => ({ startEnvironmentChannels: () => [] }))

const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII='
function canvas(): MagicNoteCanvasContent {
  return {
    version: 2, kind: 'paged-canvas',
    pages: [{ id: 'page-1', width: 794, height: 1123,
      background: { type: 'template', template: 'grid' },
      objects: [{ type: 'IText', text: 'Annotation', left: 24 }, { type: 'Image', src: png }] }],
    flow: { version: 1, ops: [{ insert: 'First task' }, { insert: '\n', attributes: { list: 'unchecked' } }] },
    assets: [{ id: 'image-1', name: 'pixel.png', mimeType: 'image/png', dataUrl: png }]
  }
}

describe('production preload -> registered IPC -> SQLite canvas persistence', () => {
  let directory: string
  let database: AssistantDatabase
  let dispose: (() => Promise<void>) | undefined
  let api: DesktopApi['magicNotes']
  let applicationSettings: ApplicationSettingsStore
  const webContents = { id: 91, mainFrame: { url: 'file:///canvas-test/index.html' },
    on: vi.fn(), removeListener: vi.fn(),
    getURL: () => 'file:///canvas-test/index.html', isDestroyed: () => false, send: vi.fn() }
  const window = { webContents, isDestroyed: () => false, isMaximized: () => false,
    on: vi.fn(), removeListener: vi.fn() }
  const getResolvedSettings = vi.fn()

  function open() {
    database = new AssistantDatabase(join(directory, 'assistant.sqlite'))
    database.initialize(directory)
    dispose = registerIpcHandlers(window as never, { capability: 'text' } as never,
      'CommandOrControl+Shift+Space', { getResolvedSettings } as never, {} as never,
      { clear: vi.fn(), cancelImport: vi.fn() } as never, {} as never, database,
      {} as never, async () => {}, undefined, undefined, undefined, undefined, applicationSettings)
  }
  async function reopen() {
    await dispose?.()
    database.close()
    open()
  }
  beforeEach(async () => {
    getResolvedSettings.mockReset()
    modelFactory.mockReset()
    directory = await mkdtemp(join(tmpdir(), 'goodbuddy-canvas-ipc-'))
    applicationSettings = new ApplicationSettingsStore(join(directory, 'application.json'))
    bridge.event = { sender: webContents, senderFrame: webContents.mainFrame }
    await import('../../preload/index')
    api = bridge.api!.magicNotes
    open()
  })
  afterEach(async () => {
    vi.restoreAllMocks()
    await dispose?.()
    database?.close()
    bridge.handlers.clear()
    await rm(directory, { recursive: true, force: true })
  })

  it('captures verified source labels and preserves them after source deletion, edits and reopen', async () => {
    const project = database.createProject({ name: 'Actual project', rootPath: directory,
      description: '', runtimeSelection: { provider: 'opencode' } })
    const header = { id: randomUUID(), title: 'Actual conversation', projectId: project.id, updatedAt: 1 }
    const messages = Array.from({ length: 120 }, (_, index) => ({ id: randomUUID(),
      role: index % 2 ? 'assistant' as const : 'user' as const,
      content: `History ${index}`, state: 'complete' as const, createdAt: index }))
    database.saveLocalConversations([{ header, messages }])
    const source = { kind: 'conversation' as const, conversationId: header.id,
      messageIds: messages.map(message => message.id), capturedAt: '2026-09-26T01:02:03.000Z',
      conversationTitle: 'Forged title', projectId: randomUUID(), projectName: 'Forged project' }
    const content = { version: 1 as const, ops: [{ insert: messages.map(message => `${message.role}: ${message.content}\n`).join('') }] }
    const created = await api.create({ title: 'Captured history', content, source })
    expect(created.createdEntryId).toBe(created.entries[0]!.id)
    const expectedSource = { ...source, conversationTitle: header.title, projectId: project.id, projectName: project.name }
    expect(created.entries[0]!.source).toEqual(expectedSource)
    expect(created.entries[0]!.content).toEqual(content)
    const appended = await api.createEntry({ noteId: created.id, content,
      source: { ...source, kind: 'message', messageIds: [messages[1]!.id] } })
    expect(appended.entries.find(entry => entry.id === appended.createdEntryId)?.source)
      .toEqual({ ...expectedSource, kind: 'message', messageIds: [messages[1]!.id] })
    database.deleteLocalConversation(header.id)
    const edited = await api.updateEntry({ entryId: created.createdEntryId!, expectedRevision: 0,
      content: { version: 1, ops: [{ insert: 'Edited copy\n' }] } })
    expect(edited.entries[0]!.source).toEqual(expectedSource)
    await reopen()
    expect(await api.get(created.id)).toEqual(edited)
    const sql = new DatabaseSync(join(directory, 'assistant.sqlite'))
    try {
      const row = sql.prepare('SELECT source_json FROM magic_note_entries WHERE id = ?').get(created.createdEntryId!) as { source_json: string }
      expect(JSON.parse(row.source_json)).toEqual(expectedSource)
    } finally { sql.close() }
    await api.remove(created.id)
    await expect(api.get(created.id)).rejects.toThrow()
  })

  it('rejects invalid source identities and source-only creates without leaving empty notes', async () => {
    const header = { id: randomUUID(), title: 'Global conversation', updatedAt: 1 }
    const message = { id: randomUUID(), role: 'assistant' as const, content: 'Answer', state: 'error' as const, createdAt: 1 }
    database.saveLocalConversations([{ header, messages: [message] }])
    const content = { version: 1 as const, ops: [{ insert: 'Edited preview\n' }] }
    const source = { kind: 'message' as const, conversationId: header.id, messageIds: [message.id],
      capturedAt: new Date().toISOString(), conversationTitle: 'Untrusted', projectId: randomUUID(), projectName: 'Untrusted' }
    await expect(api.create({ title: 'Invalid', source })).rejects.toThrow()
    await expect(api.create({ title: 'Invalid', content, source: { ...source, messageIds: [randomUUID()] } })).rejects.toThrow()
    await expect(api.create({ title: 'Invalid', content, source: { ...source, messageIds: [message.id, message.id] } })).rejects.toThrow()
    await expect(api.create({ title: 'Invalid', content, source: { ...source, conversationId: randomUUID() } })).rejects.toThrow()
    expect((await api.list()).notes).toEqual([])
    const note = await api.create({ title: 'Partial answer', content, source })
    expect(note.entries[0]!.source).toEqual({ kind: 'message', conversationId: header.id,
      messageIds: [message.id], capturedAt: source.capturedAt, conversationTitle: header.title })
    await api.remove(note.id)
    expect(database.getConversation(header.id).messages).toEqual([message])
  })

  it('rolls back a new note when writing its initial body fails and allows retry', async () => {
    const rename = fs.renameSync
    const failure = vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      if (String(to).includes('entries')) throw new Error('Initial body write failed')
      rename(from, to)
    })
    const input = { title: 'Atomic capture', content: { version: 1 as const, ops: [{ insert: 'Saved once\n' }] } }
    await expect(api.create(input)).rejects.toThrow('Initial body write failed')
    expect((await api.list()).notes).toEqual([])
    failure.mockRestore()
    const note = await api.create(input)
    expect(note.entries).toHaveLength(1)
    expect(note.createdEntryId).toBe(note.entries[0]!.id)
    expect((await api.list()).notes).toHaveLength(1)
  })

  it('searches titles and all entry bodies with note-level limits while preserving Agent entry results', async () => {
    const titleOnly = await api.create({ title: 'Needle title' })
    expect(titleOnly.createdEntryId).toBeUndefined()
    const bodyOnly = await api.create({ title: 'Body only', content: { version: 1, ops: [{ insert: 'Needle body\n' }] } })
    for (let index = 0; index < 4; index++) {
      await api.createEntry({ noteId: bodyOnly.id, content: { version: 1, ops: [{ insert: `Needle ${index}\n` }] } })
    }
    await api.createEntry({ noteId: bodyOnly.id, content: { version: 1, ops: [{ insert: 'Latest unrelated preview\n' }] } })
    const results = await api.search({ query: ' Needle ', limit: 2 })
    expect(new Set(results.map(note => note.id))).toEqual(new Set([bodyOnly.id, titleOnly.id]))
    expect(results.find(note => note.id === bodyOnly.id)).toMatchObject({ entryCount: 6, preview: 'Latest unrelated preview' })
    expect(database.searchMagicNotes('Needle', 20).filter(result => result.noteId === bodyOnly.id)).toHaveLength(5)
    await api.update({ noteId: titleOnly.id, pinned: true, expectedRevision: titleOnly.revision })
    expect((await api.search({ query: 'Needle', limit: 1 })).map(note => note.id)).toEqual([titleOnly.id])
    expect(await api.search({ query: '%' })).toEqual([])
    expect(await api.search({ query: '' })).toHaveLength(2)
    await expect(api.search({ query: 'Needle', limit: 0 })).rejects.toThrow()
    await expect(api.search({ query: 'Needle', limit: 201 })).rejects.toThrow()
  })

  it.each([true, false])('limits saved, draft and todo input using persisted page order and count (vision=%s)', async (supportsImageInput) => {
    getResolvedSettings.mockResolvedValue({ workspacePath: directory, supportsImageInput })
    const requests: AgentExecutionRequest[] = []
    modelFactory.mockReturnValue({ dispose: vi.fn(), async *run(request: AgentExecutionRequest) {
      requests.push(request)
      yield { type: 'text', delta: '{"comments":[{"kind":"summary","content":"Reviewed"}]}' }
      yield { type: 'done' }
    } })
    const content = canvas()
    content.pages = Array.from({ length: 50 }, (_, index) => ({ ...content.pages[0]!, id: `page-${50 - index}`,
      background: { type: 'template', template: 'blank' },
      objects: [{ type: 'IText', text: `OBJECT_TOKEN_${index + 1}_END` }] }))
    const note = await api.create({ title: 'Fifty pages' })
    const saved = await api.createEntry({ noteId: note.id, content })
    const entry = saved.entries[0]!
    const todo = (await api.listTodos()).todos[0]!
    for (const count of [1, 8]) {
      await applicationSettings.update({ magicNoteCanvasPageCount: count })
      const options = { requestId: crypto.randomUUID(), direction: 'general' as const, format: 'structured' as const,
        canvasImages: [...content.pages].reverse().map(page => ({ pageId: page.id, dataUrl: png })),
        canvasPageText: content.pages.slice(0, count).map((page, index) => ({ pageId: page.id, text: `FLOW_TOKEN_${index + 1}_END` })) }
      await api.analyze(entry.id, { ...options, expectedRevision: database.getMagicNoteEntry(entry.id).revision })
      await api.analyzeDraft(content, { ...options, requestId: crypto.randomUUID() })
      await api.analyzeTodo(todo.id, { ...options, requestId: crypto.randomUUID(), sourceEntryRevision: database.getMagicNoteEntry(entry.id).revision })
      for (const request of requests.slice(-3)) {
        expect(request.prompt).toContain(`OBJECT_TOKEN_${count}_END`)
        expect(request.prompt).toContain(`FLOW_TOKEN_${count}_END`)
        expect(request.prompt).not.toContain(`OBJECT_TOKEN_${count + 1}_END`)
        expect(request.prompt).not.toContain(`FLOW_TOKEN_${count + 1}_END`)
        expect(request.images?.length ?? 0).toBe(supportsImageInput ? count : 0)
      }
    }
    expect(database.getMagicNoteEntry(entry.id).content).toEqual(content)
    expect(requests).toHaveLength(6)
  })

  it.each([
    { canvasSource: true, supportsImageInput: true, inputMode: 'canvas-images' },
    { canvasSource: true, supportsImageInput: false, inputMode: 'text-fallback' },
    { canvasSource: false, supportsImageInput: true, inputMode: 'text' }
  ])('routes todo analysis through its source entry and the same resolved settings: $inputMode', async ({ canvasSource, supportsImageInput, inputMode }) => {
    const settings = { workspacePath: directory, supportsImageInput }
    getResolvedSettings.mockResolvedValue(settings)
    const requests: AgentExecutionRequest[] = []
    const runtime = {
      releaseConversation: vi.fn(async () => {}),
      dispose: vi.fn(async () => {}),
      async *run(request: AgentExecutionRequest) {
        requests.push(request)
        yield { requestId: request.requestId, type: 'text', delta: '{"comments":[{"kind":"summary","content":"Review the task."}]}' }
        yield { requestId: request.requestId, type: 'done' }
      }
    }
    modelFactory.mockReturnValue(runtime)
    const note = await api.create({ title: 'Todo analysis' })
    const saved = await api.createEntry({ noteId: note.id, content: canvasSource ? canvas() : {
      version: 1, ops: [{ insert: 'First task' }, { insert: '\n', attributes: { list: 'unchecked' } }]
    } })
    const todo = (await api.listTodos()).todos.find((item) => item.entryId === saved.entries[0]!.id)!
    const result = await api.analyzeTodo(todo.id, {
      requestId: '00000000-0000-4000-8000-000000000709',
      direction: 'general', format: 'structured',
      sourceEntryRevision: saved.entries[0]!.revision,
      canvasImages: [{ pageId: 'page-1', dataUrl: png }]
    })
    expect(getResolvedSettings).toHaveBeenCalledOnce()
    expect(modelFactory).toHaveBeenCalledWith(directory, settings)
    expect(modelFactory.mock.calls[0]![1]).toBe(settings)
    expect(requests).toHaveLength(1)
    expect(requests[0]?.prompt).toContain(todo.title)
    expect(requests[0]).not.toHaveProperty('workMode')
    if (canvasSource) expect(requests[0]?.prompt).toContain('Annotation')
    if (inputMode === 'canvas-images') {
      expect(requests[0]?.images).toEqual([{ name: 'page-1.png', mediaType: 'image/png', data: png.split(',')[1] }])
    } else {
      expect(requests[0]?.images).toBeUndefined()
      if (canvasSource) expect(requests[0]?.prompt).toContain('未查看页面图像')
    }
    expect(result.comments[0]?.inputMode).toBe(inputMode)
    expect(database.getMagicTodo(todo.id).comments[0]?.inputMode).toBe(inputMode)
    expect(result.revision).toBe(todo.revision + 1)
    expect(runtime.releaseConversation).toHaveBeenCalledWith(`magic-todos:${todo.id}`)
    expect(runtime.dispose).toHaveBeenCalledOnce()
  })

  it.each(['entry', 'todo'] as const)('rejects missing and stale screenshot revisions before %s model calls', async (kind) => {
    getResolvedSettings.mockResolvedValue({ workspacePath: directory, supportsImageInput: true })
    const note = await api.create({ title: 'Stale captures' })
    const saved = await api.createEntry({ noteId: note.id, content: canvas() })
    const entry = saved.entries[0]!
    const todo = database.listMagicTodos()[0]!
    const options = { requestId: '00000000-0000-4000-8000-000000000710', direction: 'general' as const,
      format: 'structured' as const, canvasImages: [{ pageId: 'page-1', dataUrl: png }] }
    const analyze = (revision?: number) => kind === 'entry'
      ? api.analyze(entry.id, { ...options, expectedRevision: revision })
      : api.analyzeTodo(todo.id, { ...options, sourceEntryRevision: revision })
    await expect(analyze()).rejects.toThrow('版本')
    const content = canvas()
    content.pages[0]!.objects[0]!.left = 500
    await api.updateEntry({ entryId: entry.id, expectedRevision: entry.revision, content })
    await expect(analyze(entry.revision)).rejects.toThrow('已被更新')
    expect(modelFactory).not.toHaveBeenCalled()
  })

  it.each(['entry', 'todo'] as const)('rejects late %s analysis after a source edit with no existing comments', async (kind) => {
    getResolvedSettings.mockResolvedValue({ workspacePath: directory, supportsImageInput: false })
    const note = await api.create({ title: 'Late analysis' })
    const saved = await api.createEntry({ noteId: note.id, content: canvas() })
    const entry = saved.entries[0]!
    const todo = database.listMagicTodos()[0]!
    modelFactory.mockReturnValue({ dispose: vi.fn(), async *run() {
      const content = canvas()
      content.pages[0]!.objects[0]!.text = 'Changed context'
      database.updateMagicNoteEntry({ entryId: entry.id, expectedRevision: entry.revision, content, plainText: '' })
      yield { type: 'text', delta: '{"comments":[{"kind":"summary","content":"Old result"}]}' }
      yield { type: 'done' }
    } })
    const options = { requestId: '00000000-0000-4000-8000-000000000711', direction: 'general' as const, format: 'structured' as const }
    await expect(kind === 'entry' ? api.analyze(entry.id, options) : api.analyzeTodo(todo.id, options)).rejects.toThrow('已被更新')
    expect(database.getMagicTodo(todo.id).comments).toEqual([])
    expect(database.getMagicNoteEntry(entry.id).comments).toEqual([])
  })

  it('returns the exact created ID through production IPC after an Agent append', async () => {
    const note = await api.create({ title: 'Concurrent creators' })
    const agent = database.createMagicNoteEntry({ noteId: note.id, content: { version: 1, ops: [{ insert: 'Agent A\n' }] }, plainText: 'Agent A' })
    const local = await api.createEntry({ noteId: note.id, content: { version: 1, ops: [{ insert: 'Local B\n' }] } })
    expect(local.createdEntryId).not.toBe(agent.createdEntryId)
    expect(local.entries.find((entry) => entry.id === local.createdEntryId)?.plainText).toBe('Local B')
    expect(local.entries.find((entry) => entry.id === agent.createdEntryId)?.plainText).toBe('Agent A')
    expect(await api.get(note.id)).toEqual(expect.objectContaining({ entries: local.entries }))
  })

  it('reopens canvas images, edits flow, writes todo completion back and preserves legacy rich entries', async () => {
    const note = await api.create({ title: 'Canvas integration' })
    const { createdEntryId, ...initial } = await api.createEntry({ noteId: note.id, content: canvas() })
    let saved: MagicNoteDetail = initial
    await reopen()
    expect(await api.get(note.id)).toEqual(saved)
    const entry = saved.entries.find((entry) => entry.id === createdEntryId)!
    const content = structuredClone(entry.content) as MagicNoteCanvasContent
    content.flow!.ops[0] = { insert: 'Updated task' }
    saved = await api.updateEntry({ entryId: entry.id, expectedRevision: entry.revision, content })
    expect(saved.entries[0]!.plainText).toContain('Updated task')
    const todo = (await api.listTodos()).todos.find(item => item.title === 'Updated task')!
    expect(todo).toBeDefined()
    await api.updateTodo({ todoId: todo.id, completed: true, expectedRevision: todo.revision })
    await reopen()
    const completed = (await api.get(note.id)).entries[0]!
    expect(completed.content).toMatchObject({ pages: content.pages, assets: content.assets,
      flow: { ops: [{ insert: 'Updated task' }, { insert: '\n', attributes: { list: 'checked' } }] } })
    await expect(api.updateEntry({ entryId: entry.id, expectedRevision: entry.revision, content })).rejects.toThrow()
    const rich = { version: 1 as const, ops: [{ insert: 'Legacy rich\n' }] }
    saved = await api.createEntry({ noteId: note.id, content: rich })
    const legacy = saved.entries.find(item => item.content.version === 1)!
    saved = await api.updateEntry({ entryId: legacy.id, expectedRevision: legacy.revision,
      content: { version: 1, ops: [{ insert: 'Legacy updated\n', attributes: { bold: true } }] } })
    await reopen()
    expect(await api.get(note.id)).toEqual(saved)
  })

  it('saves and reopens a 20 MiB canvas image through create and update IPC', async () => {
    const content = canvas()
    const bytes = Buffer.alloc(20 * 1024 * 1024)
    Buffer.from(png.split(',')[1]!, 'base64').copy(bytes)
    content.assets[0]!.dataUrl = `data:image/png;base64,${bytes.toString('base64')}`
    const note = await api.create({ title: 'Large canvas image' })
    const created = await api.createEntry({ noteId: note.id, content })
    await reopen()
    const entry = (await api.get(note.id)).entries.find(item => item.id === created.createdEntryId)!
    expect(entry.content).toEqual(content)
    content.flow!.ops[0] = { insert: 'Edited large image note' }
    await api.updateEntry({ entryId: entry.id, expectedRevision: entry.revision, content })
    await reopen()
    expect((await api.get(note.id)).entries.find(item => item.id === entry.id)!.content).toEqual(content)
  })

  it('preserves a real generated PDF and all page references through three reopen/save cycles', async () => {
    const { jsPDF } = await import('jspdf')
    const pdf = new jsPDF()
    pdf.text('First PDF page', 20, 20)
    pdf.addPage()
    pdf.text('Second PDF page', 20, 20)
    const dataUrl = `data:application/pdf;base64,${Buffer.from(pdf.output('arraybuffer')).toString('base64')}`
    const content = canvas()
    content.assets.push({ id: 'pdf-1', name: 'two-pages.pdf', mimeType: 'application/pdf', dataUrl })
    content.pages = [1, 2].map(number => ({ id: `pdf-page-${number}`, width: 794, height: 1123,
      background: { type: 'pdf', assetId: 'pdf-1', pageNumber: number, text: `PDF page ${number}` }, objects: [] }))
    const note = await api.create({ title: 'PDF integration' })
    const { createdEntryId, ...initial } = await api.createEntry({ noteId: note.id, content })
    let saved: MagicNoteDetail = initial
    expect(saved.entries[0]?.id).toBe(createdEntryId)
    for (let cycle = 0; cycle < 3; cycle++) {
      await reopen()
      expect(await api.get(note.id)).toEqual(saved)
      const entry = (await api.get(note.id)).entries[0]!
      const next = structuredClone(entry.content) as MagicNoteCanvasContent
      next.pages[0]!.objects.push({ type: 'IText', text: `Edit ${cycle}`, left: cycle * 10 })
      saved = await api.updateEntry({ entryId: entry.id, expectedRevision: entry.revision, content: next })
      expect((saved.entries[0]!.content as MagicNoteCanvasContent).assets).toEqual(content.assets)
    }
    await reopen()
    expect(await api.get(note.id)).toEqual(saved)
  })

  it('rejects invalid assets and references on create and update without changing persisted content', async () => {
    const note = await api.create({ title: 'Asset validation' })
    const { createdEntryId, ...saved } = await api.createEntry({ noteId: note.id, content: canvas() })
    const entry = saved.entries.find((entry) => entry.id === createdEntryId)!
    const invalid: MagicNoteCanvasContent[] = []
    let content = canvas(); content.assets[0]!.dataUrl = 'data:image/png;base64,aGVsbG8='; invalid.push(content)
    content = canvas(); content.assets[0]!.mimeType = 'image/jpeg'; invalid.push(content)
    content = canvas(); content.pages[0]!.objects = [{ type: 'Image', assetId: 'missing' }]; invalid.push(content)
    content = canvas(); content.pages[0]!.background = { type: 'pdf', assetId: 'image-1', pageNumber: 1 }; invalid.push(content)
    content = canvas(); content.assets.push({ ...content.assets[0]! }); invalid.push(content)
    content = canvas(); content.pages[0]!.objects = [{ type: 'Image', src: 'https://example.com/image.png' }]; invalid.push(content)
    for (const content of invalid) {
      await expect(api.createEntry({ noteId: note.id, content })).rejects.toThrow()
      await expect(api.updateEntry({ entryId: entry.id, expectedRevision: entry.revision, content })).rejects.toThrow()
    }
    await reopen()
    expect(await api.get(note.id)).toEqual(saved)
  })
})

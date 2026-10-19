import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserWindow, IpcMainInvokeEvent } from 'electron'
import { ipcChannels } from '../../shared/ipc-channels'
import type { AgentExecutionRequest } from '../agent/runtime'
import type { MagicNoteEntry, MagicNoteQuestionInput } from '../../shared/magic-notes-contracts'

const runtimeMocks = vi.hoisted(() => ({
  requests: [] as AgentExecutionRequest[],
  release: vi.fn(async () => undefined),
  dispose: vi.fn(async () => undefined),
  events: undefined as undefined | ((requestId: string) => unknown[])
}))

vi.mock('../agent/create-runtime', () => ({
  createDefaultModelRuntime: () => ({
    async *run(input: AgentExecutionRequest) {
      runtimeMocks.requests.push(input)
      const events = runtimeMocks.events?.(input.requestId) ?? [
        { requestId: input.requestId, type: 'text', delta: '这是回答。' },
        { requestId: input.requestId, type: 'done' }
      ]
      for (const event of events) yield event
    },
    releaseConversation: runtimeMocks.release,
    dispose: runtimeMocks.dispose
  })
}))

import { registerMagicNotesAnalysisIpcHandlers } from './magic-notes-analysis-ipc'

const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII='
const noteId = '00000000-0000-4000-8000-000000000701'
const firstEntryId = '00000000-0000-4000-8000-000000000711'
const lastEntryId = '00000000-0000-4000-8000-000000000712'
const entry = (id: string, plainText: string): MagicNoteEntry => ({ id, noteId, plainText, revision: 1, comments: [], updatedAt: '', createdAt: '2026-08-01T00:00:00.000Z', content: { version: 1, ops: [{ insert: plainText }] } })
const note = { id: noteId, entries: [entry(firstEntryId, '第一条记录正文'), entry(lastEntryId, '最后一条记录正文')] }
const question = (scope: MagicNoteQuestionInput['scope'] = 'page'): MagicNoteQuestionInput => ({
  noteId, question: '问题', scope, history: [],
  ...(scope === 'document' ? {} : { entryId: firstEntryId, pageStart: 1, pageEnd: 1 }),
  contexts: (scope === 'document' ? note.entries : [note.entries[0]!]).map(entry => ({ entryId: entry.id, revision: entry.revision, pages: entry.content.version === 2
    ? entry.content.pages.map(page => ({ pageId: page.id, text: `文字 ${page.id}`, dataUrl: `data:image/png;base64,${png}` })) : [] }))
})

const webContents = { mainFrame: { url: 'app://main' }, getURL: () => 'app://main' }
const window = { webContents } as unknown as BrowserWindow
const trustedEvent = { sender: webContents, senderFrame: webContents.mainFrame } as unknown as IpcMainInvokeEvent

function register(supportsImageInput = true) {
  const handlers = new Map<string, (event: IpcMainInvokeEvent, input: unknown) => Promise<unknown>>()
  const getMagicNote = vi.fn(async () => note)
  const persistModelUsage = vi.fn()
  registerMagicNotesAnalysisIpcHandlers(
    ((channel: string, handler: never) => { handlers.set(channel, handler) }) as never,
    {
      window,
      assistantDatabase: { getMagicNote, createTask: vi.fn(), updateTaskStatus: vi.fn() } as never,
      settingsStore: { getResolvedSettings: async () => ({ workspacePath: 'D:/workspace', supportsImageInput }) } as never,
      persistModelUsage,
      safeRuntimeError: (error, fallback) => error instanceof Error ? error.message : fallback
    }
  )
  const ask = (input: unknown, event = trustedEvent) => handlers.get(ipcChannels.magicNotesAsk)!(event, input)
  return { ask, getMagicNote, persistModelUsage }
}

beforeEach(() => {
  note.entries = [entry(firstEntryId, '第一条记录正文'), entry(lastEntryId, '最后一条记录正文')]
  runtimeMocks.requests.length = 0
  runtimeMocks.events = undefined
  runtimeMocks.release.mockClear()
  runtimeMocks.dispose.mockClear()
})

describe('magic note question IPC', () => {
  it('rejects requests from an untrusted window before touching storage', async () => {
    const { ask, getMagicNote } = register()
    const stranger = { sender: {}, senderFrame: { url: 'app://other' } } as unknown as IpcMainInvokeEvent
    await expect(ask({ noteId, question: '问题', scope: 'document' }, stranger)).rejects.toThrow('拒绝来自未知窗口的 IPC 请求')
    expect(getMagicNote).not.toHaveBeenCalled()
    expect(runtimeMocks.requests).toHaveLength(0)
  })

  it('validates the request shape', async () => {
    const { ask } = register()
    await expect(ask({ ...question('document'), question: '   ' })).rejects.toThrow()
    await expect(ask({ ...question('pages'), pageStart: 3, pageEnd: 1 })).rejects.toThrow()
    await expect(ask({ ...question('pages'), pageStart: undefined })).rejects.toThrow()
    expect(runtimeMocks.requests).toHaveLength(0)
  })

  it('answers the selected record with only that record as context', async () => {
    const { ask, persistModelUsage } = register()
    const result = await ask(question())
    expect(result).toMatchObject({ answer: '这是回答。', requestId: expect.any(String) })
    expect(runtimeMocks.requests).toHaveLength(1)
    const prompt = runtimeMocks.requests[0]!.prompt
    expect(prompt).toContain('第一条记录正文')
    expect(prompt).not.toContain('最后一条记录正文')
    expect(persistModelUsage).not.toHaveBeenCalled()
  })

  it('rejects a record that does not belong to the note', async () => {
    const { ask } = register()
    await expect(ask({ ...question(), entryId: '00000000-0000-4000-8000-000000000799' })).rejects.toThrow('所选范围没有可供问答的内容')
    expect(runtimeMocks.requests).toHaveLength(0)
  })

  it('uses every record for the whole document', async () => {
    const { ask } = register()
    await ask(question('document'))
    const prompt = runtimeMocks.requests[0]!.prompt
    expect(prompt).toContain('第一条记录正文')
    expect(prompt).toContain('最后一条记录正文')
  })

  it('answers a page range from the captured pages only, not the whole record text', async () => {
    note.entries[0]!.content = { version: 2, kind: 'paged-canvas', assets: [], pages: [1, 2, 3].map(i => ({ id: `page-${i}`, width: 100, height: 100, background: { type: 'template', template: 'blank' }, objects: [] })) }
    const { ask } = register()
    const input = question('pages')
    input.pageStart = 2
    input.pageEnd = 3
    input.contexts[0]!.pages.shift()
    await ask(input)
    const request = runtimeMocks.requests[0]!
    expect(request.prompt).toContain('文字 page-2')
    expect(request.prompt).toContain('文字 page-3')
    expect(request.prompt).not.toContain('文字 page-1')
    expect(request.prompt).not.toContain('第一条记录正文')
    expect(request.images).toHaveLength(2)
  })

  it('rejects missing captures, invalid ranges and stale revisions rather than using the full record', async () => {
    note.entries[0]!.content = { version: 2, kind: 'paged-canvas', assets: [], pages: [{ id: 'one', width: 100, height: 100, background: { type: 'template', template: 'blank' }, objects: [] }] }
    const { ask } = register()
    await expect(ask({ ...question(), contexts: [{ entryId: firstEntryId, revision: 1, pages: [] }] })).rejects.toThrow('页面上下文缺失')
    await expect(ask({ ...question('pages'), pageEnd: 2 })).rejects.toThrow('页码超出')
    const stale = question()
    stale.contexts[0]!.revision = 0
    await expect(ask(stale)).rejects.toThrow('记录已更新')
    await expect(ask({ ...question('document'), contexts: question().contexts })).rejects.toThrow('笔记记录已变化')
    expect(runtimeMocks.requests).toHaveLength(0)
  })

  it('captures all document pages, supports text-only models and keeps region context image-only', async () => {
    note.entries[0]!.content = { version: 2, kind: 'paged-canvas', assets: [], pages: Array.from({ length: 10 }, (_, i) => ({ id: `page-${i + 1}`, width: 100, height: 100, background: { type: 'template', template: 'blank' }, objects: [{ text: `stored ${i + 1}` }] })) }
    const { ask } = register()
    await ask(question('document'))
    expect(runtimeMocks.requests[0]!.images).toHaveLength(10)
    expect(runtimeMocks.requests[0]!.prompt).toContain('stored 10')
    const text = register(false)
    await expect(text.ask(question('document'))).resolves.toMatchObject({ inputMode: 'text' })
    expect(runtimeMocks.requests[1]!.images).toBeUndefined()
    expect(runtimeMocks.requests[1]!.prompt).toContain('stored 10')
    const region = question('region')
    region.contexts[0]!.pages = region.contexts[0]!.pages.slice(0, 1)
    await ask(region)
    expect(runtimeMocks.requests[2]!.images).toHaveLength(1)
    expect(runtimeMocks.requests[2]!.prompt).not.toContain('stored')
    expect(runtimeMocks.requests[2]!.prompt).not.toContain('文字')
    await expect(text.ask(region)).rejects.toThrow('区域截图需要')
  })

  it('includes rich text images in document context and rejects page two of a text record', async () => {
    note.entries[0]!.content = { version: 1, ops: [{ insert: { image: `data:image/png;base64,${png}` } }] }
    const { ask } = register()
    await ask(question('document'))
    expect(runtimeMocks.requests[0]!.images).toHaveLength(1)
    await expect(ask({ ...question('pages'), pageEnd: 2 })).rejects.toThrow('普通文本记录')
  })

  it('releases the conversation and runtime after success and after failure', async () => {
    const { ask } = register()
    await ask(question('document'))
    expect(runtimeMocks.release).toHaveBeenCalledWith(`magic-note-questions:${noteId}`)
    expect(runtimeMocks.dispose).toHaveBeenCalledOnce()

    runtimeMocks.events = (requestId) => [{ requestId, type: 'error', status: 'failed', message: '模型不可用' }]
    await expect(ask(question('document'))).rejects.toThrow('模型不可用')
    expect(runtimeMocks.release).toHaveBeenCalledTimes(2)
    expect(runtimeMocks.dispose).toHaveBeenCalledTimes(2)
  })
})

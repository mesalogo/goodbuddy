// @vitest-environment node
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { BrowserWindow, IpcMainInvokeEvent } from 'electron'
import { AssistantDatabase } from '../src/main/assistant/assistant-database'
import type { AgentExecutionRequest } from '../src/main/agent/runtime'
import type { MagicNoteQuestionResult } from '../src/shared/magic-notes-contracts'
import { ipcChannels } from '../src/shared/ipc-channels'

const runtime = vi.hoisted(() => ({ requests: [] as AgentExecutionRequest[], fail: false, release: vi.fn(), dispose: vi.fn() }))
vi.mock('../src/main/agent/create-runtime', () => ({ createDefaultModelRuntime: () => ({
  async *run(request: AgentExecutionRequest) {
    runtime.requests.push(request)
    yield { type: 'text', requestId: request.requestId, delta: 'Answer' }
    yield { type: 'model-usage', requestId: request.requestId, callId: 'call-1', runtime: 'model', provider: 'fixture', model: 'fixture', inputTokens: 17, outputTokens: 5, cacheReadTokens: 2, cacheWriteTokens: 0 }
    if (runtime.fail) yield { type: 'error', requestId: request.requestId, message: 'Model failed after reporting usage' }
    else yield { type: 'done', requestId: request.requestId }
  }, releaseConversation: runtime.release, dispose: runtime.dispose
}) }))
import { registerMagicNotesAnalysisIpcHandlers } from '../src/main/magic-notes/magic-notes-analysis-ipc'

let directory: string
let database: AssistantDatabase
let sql: DatabaseSync
beforeEach(async () => {
  await mkdir(resolve('temp'), { recursive: true })
  directory = await mkdtemp(join(resolve('temp'), 'magic-note-question-storage-'))
  const path = join(directory, 'assistant.sqlite')
  database = new AssistantDatabase(path)
  database.initialize(directory)
  sql = new DatabaseSync(path)
  runtime.requests.length = 0
  runtime.fail = false
  runtime.release.mockClear()
  runtime.dispose.mockClear()
})
afterEach(async () => { vi.restoreAllMocks(); sql?.close(); database?.close(); await rm(directory, { recursive: true, force: true }) })

function register() {
  const note = database.createMagicNote({ title: 'Usage regression', content: { version: 1, ops: [{ insert: 'Saved note\n' }] } })
  const webContents = { mainFrame: { url: 'app://main' }, getURL: () => 'app://main' }
  const event = { sender: webContents, senderFrame: webContents.mainFrame } as unknown as IpcMainInvokeEvent
  const handlers = new Map<string, (event: IpcMainInvokeEvent, input: unknown) => Promise<MagicNoteQuestionResult>>()
  registerMagicNotesAnalysisIpcHandlers(((channel: string, handler: never) => { handlers.set(channel, handler) }) as never, {
    window: { webContents } as unknown as BrowserWindow,
    assistantDatabase: database,
    settingsStore: { getResolvedSettings: async () => ({ workspacePath: directory, supportsImageInput: false }) } as never,
    // The same event-to-storage mapping as the production ipc.ts callback.
    persistModelUsage: async event => {
      database.upsertModelUsageCall({ requestId: event.requestId, callId: event.callId, runtime: event.runtime, provider: event.provider, model: event.model,
        input: event.inputTokens, output: event.outputTokens, cacheRead: event.cacheReadTokens, cacheWrite: event.cacheWriteTokens })
      expect(database.getTask(event.requestId).status).toBe('running')
    },
    safeRuntimeError: error => error instanceof Error ? error.message : String(error)
  })
  const input = { noteId: note.id, scope: 'document', question: 'Summarize', contexts: note.entries.map(entry => ({ entryId: entry.id, revision: entry.revision, pages: [] })), history: [] }
  return { note, ask: () => handlers.get(ipcChannels.magicNotesAsk)!(event, input) }
}

it('persists usage against the existing hidden question task and returns the same request ID on each turn', async () => {
  const { ask } = register()
  const first = await ask()
  const second = await ask()
  expect(first.requestId).not.toBe(second.requestId)
  for (const [index, result] of [first, second].entries()) {
    expect(result.answer).toBe('Answer')
    expect(runtime.requests[index]!.requestId).toBe(result.requestId)
    expect(database.getTask(result.requestId).origin).toBe('magic-notes')
    expect(database.getTokenUsageSummary().records.find(record => record.requestId === result.requestId)?.systemSource).toBe('magic-notes')
    expect(sql.prepare('SELECT status, visible FROM tasks WHERE id = ?').get(result.requestId)).toEqual({ status: 'completed', visible: 0 })
    expect(sql.prepare('SELECT input_tokens, output_tokens, cache_read_tokens FROM model_usage_calls WHERE request_id = ?').get(result.requestId))
      .toEqual({ input_tokens: 17, output_tokens: 5, cache_read_tokens: 2 })
  }
  expect(sql.prepare('PRAGMA foreign_key_check').all()).toEqual([])
  expect(sql.prepare('SELECT count(*) AS count FROM conversations').get()).toEqual({ count: 0 })
  expect(runtime.release).toHaveBeenCalledTimes(2)
  expect(runtime.dispose).toHaveBeenCalledTimes(2)
})

it('keeps reported usage and marks the task failed when the model subsequently fails', async () => {
  const { ask } = register()
  runtime.fail = true
  await expect(ask()).rejects.toThrow('Model failed after reporting usage')
  const id = runtime.requests[0]!.requestId
  expect(database.getTask(id).origin).toBe('magic-notes')
  expect(database.getTokenUsageSummary().records).toEqual([expect.objectContaining({ requestId: id, systemSource: 'magic-notes', totalTokens: 22 })])
  expect(sql.prepare('SELECT status, error FROM tasks WHERE id = ?').get(id)).toEqual({ status: 'failed', error: 'Model failed after reporting usage' })
  expect(sql.prepare('SELECT output_tokens FROM model_usage_calls WHERE request_id = ?').get(id)).toEqual({ output_tokens: 5 })
  expect(sql.prepare('PRAGMA foreign_key_check').all()).toEqual([])
  expect(runtime.release).toHaveBeenCalledOnce()
  expect(runtime.dispose).toHaveBeenCalledOnce()
})

it('preserves a task creation failure without running a model or updating a nonexistent task', async () => {
  const { ask } = register()
  vi.spyOn(database, 'createTask').mockImplementation(() => { throw new Error('Task storage unavailable') })
  const update = vi.spyOn(database, 'updateTaskStatus')
  await expect(ask()).rejects.toThrow('Task storage unavailable')
  expect(update).not.toHaveBeenCalled()
  expect(runtime.requests).toHaveLength(0)
  expect(runtime.dispose).toHaveBeenCalledOnce()
})

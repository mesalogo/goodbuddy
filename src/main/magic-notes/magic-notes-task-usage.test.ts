import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { BrowserWindow, IpcMainInvokeEvent } from 'electron'
import { expect, it, vi } from 'vitest'
import { ipcChannels } from '../../shared/ipc-channels'
import type { AgentExecutionRequest, RuntimeModelUsageEvent } from '../agent/runtime'
import { AssistantDatabase, ASSISTANT_DATABASE_SCHEMA_VERSION } from '../assistant/assistant-database'
import { registerMagicNotesAnalysisIpcHandlers, registerMagicTodosAnalysisIpcHandlers } from './magic-notes-analysis-ipc'

vi.mock('../agent/create-runtime', () => ({
  createDefaultModelRuntime: () => ({
    async *run(request: AgentExecutionRequest) {
      yield { requestId: request.requestId, type: 'model-usage', callId: 'call', runtime: 'model',
        provider: 'test', model: 'local-fixture', inputTokens: 10, outputTokens: 5, cacheReadTokens: 2, cacheWriteTokens: 0 }
      yield { requestId: request.requestId, type: 'text', delta: '{"comments":[{"kind":"summary","content":"Analysis"}]}' }
      yield { requestId: request.requestId, type: 'done' }
    },
    dispose: async () => undefined
  })
}))

it('persists all four hidden note task origins and consumes their usage in system grouping after reopening', async () => {
  await mkdir(join(process.cwd(), 'temp'), { recursive: true })
  const directory = await mkdtemp(join(process.cwd(), 'temp', 'magic-notes-usage-'))
  const path = join(directory, 'assistant.sqlite')
  let database = new AssistantDatabase(path)
  try {
    database.initialize(directory)
    const content = { version: 1 as const, ops: [{ insert: 'Follow up' }, { insert: '\n', attributes: { list: 'unchecked' as const } }] }
    const note = database.createMagicNote({ title: 'Notes', content })
    const entry = note.entries[0]!
    const todo = database.listMagicTodos()[0]!
    const handlers = new Map<string, (event: IpcMainInvokeEvent, input: unknown) => Promise<unknown>>()
    const register = ((channel: string, handler: never) => { handlers.set(channel, handler) }) as never
    const webContents = { mainFrame: { url: 'app://main' }, getURL: () => 'app://main' }
    const dependencies = {
      window: { webContents } as unknown as BrowserWindow,
      assistantDatabase: database,
      settingsStore: { getResolvedSettings: async () => ({ workspacePath: directory }) } as never,
      persistModelUsage: (event: RuntimeModelUsageEvent) => database.upsertModelUsageCall({
        requestId: event.requestId, callId: event.callId, runtime: event.runtime, provider: event.provider, model: event.model,
        input: event.inputTokens, output: event.outputTokens, cacheRead: event.cacheReadTokens, cacheWrite: event.cacheWriteTokens
      }),
      safeRuntimeError: (error: unknown) => String(error)
    }
    registerMagicNotesAnalysisIpcHandlers(register, dependencies)
    registerMagicTodosAnalysisIpcHandlers(register, dependencies)
    const event = { sender: webContents, senderFrame: webContents.mainFrame } as unknown as IpcMainInvokeEvent
    const options = () => ({ requestId: randomUUID(), direction: 'general', format: 'structured' })
    await handlers.get(ipcChannels.magicNotesAsk)!(event, { noteId: note.id, question: 'What next?', scope: 'document',
      contexts: [{ entryId: entry.id, revision: entry.revision, pages: [] }], history: [] })
    await handlers.get(ipcChannels.magicNotesAnalyze)!(event, { ...options(), entryId: entry.id })
    await handlers.get(ipcChannels.magicNotesAnalyzeDraft)!(event, { ...options(), content })
    await handlers.get(ipcChannels.magicTodosAnalyze)!(event, { ...options(), todoId: todo.id })
    database.close()
    database = new AssistantDatabase(path)
    database.initialize(directory)
    expect(database.listTasks()).toEqual([])
    const summary = database.getTokenUsageSummary()
    expect(summary.records).toHaveLength(4)
    for (const record of summary.records) {
      expect(database.getTask(record.requestId)).toMatchObject({ origin: 'magic-notes', status: 'completed' })
      expect(record).toMatchObject({ systemSource: 'magic-notes', callCount: 1, input: 10, output: 5 })
    }
    expect(summary.systemTotals).toMatchObject({ callCount: 4, input: 40, output: 20, cacheRead: 8, totalTokens: 60 })
    expect(summary.conversationTotals).toMatchObject({ callCount: 0, totalTokens: 0 })
  } finally {
    database.close()
    await rm(directory, { recursive: true, force: true })
  }
})

it('upgrades the released origin constraint without changing legacy tasks or usage and retains foreign keys', async () => {
  await mkdir(join(process.cwd(), 'temp'), { recursive: true })
  const directory = await mkdtemp(join(process.cwd(), 'temp', 'magic-notes-origin-'))
  const path = join(directory, 'assistant.sqlite')
  const database = new AssistantDatabase(path)
  const previous = "origin IN ('user', 'assistant', 'schedule', 'delegation', 'subagent')"
  const expanded = "origin IN ('user', 'assistant', 'schedule', 'delegation', 'subagent', 'magic-notes')"
  try {
    database.initialize(directory)
    const id = randomUUID()
    database.createTask({ id, title: 'Legacy assistant', instructions: 'Keep', origin: 'assistant', visible: false })
    database.upsertModelUsageCall({ requestId: id, callId: 'legacy', runtime: 'model', provider: 'test', model: 'fixture',
      input: 7, output: 3, cacheRead: 0, cacheWrite: 0 })
    database.close()
    const legacy = new DatabaseSync(path)
    let rows: unknown[]
    let schema: Record<string, unknown>[]
    try {
      legacy.enableDefensive(false)
      legacy.exec('PRAGMA writable_schema = ON')
      legacy.prepare("UPDATE sqlite_schema SET sql = replace(sql, ?, ?) WHERE name = 'tasks'").run(expanded, previous)
      legacy.exec('PRAGMA writable_schema = RESET; PRAGMA user_version = 64;')
      expect(() => legacy.prepare("UPDATE tasks SET origin = 'magic-notes'").run()).toThrow(/CHECK/)
      rows = ['tasks', 'model_usage_calls'].map(table => legacy.prepare(`SELECT rowid, * FROM ${table}`).all())
      schema = legacy.prepare('SELECT * FROM sqlite_schema ORDER BY name').all()
    } finally { legacy.close() }
    database.upgradeStorage(() => undefined, () => false, { migrateNotes: false, reclaimSpace: false })
    const check = new DatabaseSync(path)
    try {
      expect(check.prepare('PRAGMA user_version').get()!.user_version).toBe(ASSISTANT_DATABASE_SCHEMA_VERSION)
      expect(['tasks', 'model_usage_calls'].map(table => check.prepare(`SELECT rowid, * FROM ${table}`).all())).toEqual(rows)
      expect(check.prepare('SELECT * FROM sqlite_schema ORDER BY name').all()).toEqual(schema.map(row =>
        row.name === 'tasks' ? { ...row, sql: (row.sql as string).replace(previous, expanded) } : row))
      expect(check.prepare('PRAGMA integrity_check').get()!.integrity_check).toBe('ok')
      expect(check.prepare('PRAGMA foreign_key_check').all()).toEqual([])
      expect(() => check.prepare("UPDATE tasks SET origin = 'invalid'").run()).toThrow(/CHECK/)
    } finally { check.close() }
    database.initialize(directory)
    expect(database.getTask(id).origin).toBe('assistant')
    expect(database.getTokenUsageSummary().records[0]).toMatchObject({ requestId: id, totalTokens: 10 })
    expect(database.getTokenUsageSummary().records[0]!.systemSource).toBeUndefined()
    const newId = randomUUID()
    database.createTask({ id: newId, title: 'New note', instructions: 'Analyze', origin: 'magic-notes', visible: false })
    database.close()
    database.initialize(directory)
    expect(database.getTask(newId).origin).toBe('magic-notes')
    expect(database.getTask(id).origin).toBe('assistant')
  } finally {
    database.close()
    await rm(directory, { recursive: true, force: true })
  }
})

import type { BrowserWindow, IpcMainInvokeEvent, ipcMain } from 'electron'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it, vi } from 'vitest'
import { AssistantDatabase } from '../assistant/assistant-database'
import type { AssistantStoragePort } from '../assistant-storage-port'
import { ipcChannels } from '../../shared/ipc-channels'
import { registerMagicNotesIpcHandlers, registerMagicTodosIpcHandlers } from './magic-notes-ipc'

function fixture(database: Partial<AssistantStoragePort>) {
  const handlers = new Map<string, Parameters<typeof ipcMain.handle>[1]>()
  const register: typeof ipcMain.handle = (channel, handler) => { handlers.set(channel, handler) }
  const webContents = { mainFrame: { url: 'file:///app.html' }, getURL: () => 'file:///app.html' }
  const window = { webContents } as unknown as BrowserWindow
  const event = { sender: webContents, senderFrame: webContents.mainFrame } as unknown as IpcMainInvokeEvent
  registerMagicNotesIpcHandlers(register, window, database as AssistantStoragePort)
  registerMagicTodosIpcHandlers(register, window, database as AssistantStoragePort)
  return { invoke: (channel: string, input?: unknown, sender = event) => handlers.get(channel)!(sender, input) }
}

describe('async magic notes IPC', () => {
  it('passes an empty-cell table through schema and content validation', async () => {
    const createMagicNoteEntry = vi.fn<AssistantStoragePort['createMagicNoteEntry']>()
    createMagicNoteEntry.mockResolvedValue({
      id: 'note', title: 'Note', preview: '', entryCount: 1, pinned: false, tags: [],
      revision: 1, createdAt: '', updatedAt: '', createdEntryId: 'entry', entries: []
    })
    const f = fixture({ createMagicNoteEntry })
    const content = { version: 1 as const, ops: [{ insert: '\n', attributes: { table: 'row-1' } }] }

    await f.invoke(ipcChannels.magicNotesCreateEntry, {
      noteId: '00000000-0000-4000-8000-000000000001', content
    })
    expect(createMagicNoteEntry).toHaveBeenCalledWith(expect.objectContaining({ content, plainText: '' }))
  })

  it('returns missing note codes without swallowing other storage errors', async () => {
    const noteId = randomUUID()
    const missing = Object.assign(new Error('fixture missing note'), { code: 'magic-note-not-found' })
    const failure = new Error('fixture storage failure')
    const getMagicNote = vi.fn<AssistantStoragePort['getMagicNote']>()
      .mockRejectedValueOnce(missing).mockRejectedValueOnce(failure)
    const f = fixture({ getMagicNote, createMagicNoteEntry: async () => { throw missing } })

    await expect(f.invoke(ipcChannels.magicNotesGet, { noteId })).resolves.toEqual({ ok: false, code: 'magic-note-not-found' })
    await expect(f.invoke(ipcChannels.magicNotesCreateEntry, {
      noteId, content: { version: 1, ops: [{ insert: 'Keep draft' }] }
    })).resolves.toEqual({ ok: false, code: 'magic-note-not-found' })
    await expect(f.invoke(ipcChannels.magicNotesGet, { noteId })).rejects.toBe(failure)
  })

  it('resolves list DTOs and preserves sender/schema checks before storage', async () => {
    const listMagicNotes = vi.fn(async () => [])
    const createMagicNote = vi.fn()
    const f = fixture({ listMagicNotes, listMagicNoteTags: async () => [], createMagicNote })
    await expect(f.invoke(ipcChannels.magicNotesList)).resolves.toEqual({ notes: [], tags: [] })
    await expect(f.invoke(ipcChannels.magicNotesList, undefined, {} as IpcMainInvokeEvent)).rejects.toThrow('IPC')
    expect(listMagicNotes).toHaveBeenCalledOnce()
    await expect(f.invoke(ipcChannels.magicNotesCreate, {})).rejects.toThrow()
    expect(createMagicNote).not.toHaveBeenCalled()
  })

  it('lists every note and note todo through IPC, beyond the former 200/500 caps', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'goodbuddy-magic-notes-ipc-'))
    const databasePath = join(directory, 'assistant.sqlite')
    const database = new AssistantDatabase(databasePath)
    database.initialize('C:\\Workspace')
    try {
      const notes = Array.from({ length: 250 }, (_, index) =>
        database.createMagicNote({ title: `Note ${index}` }))
      const host = notes[0]!
      const entryId = database.getMagicNote(host.id).entries[0]?.id ??
        database.createMagicNoteEntry({ noteId: host.id, content: { version: 1, ops: [{ insert: 'x\n' }] }, plainText: 'x' }).createdEntryId
      const raw = new DatabaseSync(databasePath)
      try {
        const insert = raw.prepare(
          `INSERT INTO magic_todos (id, note_id, entry_id, source_index, source, title, created_at, updated_at)
           VALUES (?, ?, ?, ?, 'note', ?, ?, ?)`)
        raw.exec('BEGIN')
        for (let index = 0; index < 600; index += 1) {
          const at = new Date(Date.UTC(2026, 0, 1) + index * 1000).toISOString()
          insert.run(randomUUID(), host.id, entryId, 10_000 + index, `Todo ${index}`, at, at)
        }
        raw.exec('COMMIT')
      } finally { raw.close() }
      const f = fixture(database as unknown as Partial<AssistantStoragePort>)
      const listed = await f.invoke(ipcChannels.magicNotesList) as { notes: Array<{ id: string }> }
      expect(listed.notes).toHaveLength(250)
      expect(new Set(listed.notes.map(note => note.id))).toEqual(new Set(notes.map(note => note.id)))
      const todos = await f.invoke(ipcChannels.magicTodosList) as { todos: Array<{ title: string }> }
      expect(todos.todos.filter(todo => todo.title.startsWith('Todo '))).toHaveLength(600)
      // An explicit cap (tools) is still honoured.
      expect(database.listMagicNotes({ limit: 10 })).toHaveLength(10)
    } finally {
      database.close()
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('does not acknowledge deletion or read a todo note before its write commits', async () => {
    let commit!: () => void
    const deletion = new Promise<void>(resolve => { commit = resolve })
    const f = fixture({ deleteMagicNote: () => deletion })
    const pending = f.invoke(ipcChannels.magicNotesDelete, { noteId: '00000000-0000-4000-8000-000000000001' })
    expect(pending).toBe(deletion)
    commit()
    await pending

    const getMagicNote = vi.fn(async () => ({ id: 'note' }))
    let save!: (value: unknown) => void
    const updated = new Promise(resolve => { save = resolve })
    const todos = fixture({ updateMagicTodo: (() => updated) as AssistantStoragePort['updateMagicTodo'], getMagicNote: getMagicNote as never })
    const result = todos.invoke(ipcChannels.magicTodosUpdate, { todoId: '00000000-0000-4000-8000-000000000002', completed: true, expectedRevision: 0 })
    await Promise.resolve()
    expect(getMagicNote).not.toHaveBeenCalled()
    save({ noteId: 'note' })
    await expect(result).resolves.toEqual({ todo: { noteId: 'note' }, note: { id: 'note' } })
  })
})

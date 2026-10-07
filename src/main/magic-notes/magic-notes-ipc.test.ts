import type { BrowserWindow, IpcMainInvokeEvent, ipcMain } from 'electron'
import { describe, expect, it, vi } from 'vitest'
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

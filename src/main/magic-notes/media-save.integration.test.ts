// @vitest-environment node
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { AssistantDatabase } from '../assistant/assistant-database'
import { registerMagicNotesIpcHandlers } from './magic-notes-ipc'
import { ipcChannels } from '../../shared/ipc-channels'
import { compactNoteMedia, mergeNoteSaveResult } from '../../shared/magic-note-media'
import type { MagicNoteCanvasContent, MagicNoteDetail } from '../../shared/magic-notes-contracts'

let directory: string
let database: AssistantDatabase
const handlers = new Map<string, (event: unknown, input: unknown) => Promise<MagicNoteDetail>>()
const webContents = { id: 1, mainFrame: { url: 'file:///test/index.html' }, getURL: () => 'file:///test/index.html' }
const event = { sender: webContents, senderFrame: webContents.mainFrame }
beforeEach(async () => {
  await mkdir(resolve('temp'), { recursive: true })
  directory = await mkdtemp(join(resolve('temp'), 'note-media-save-'))
  database = new AssistantDatabase(join(directory, 'assistant.sqlite'))
  database.initialize(directory)
  registerMagicNotesIpcHandlers(((channel: string, handler: (event: unknown, input: unknown) => MagicNoteDetail) => handlers.set(channel, async (event, input) => handler(event, input))) as never, { webContents } as never, database)
})
afterEach(async () => { vi.restoreAllMocks(); database.close(); await rm(directory, { recursive: true, force: true }); handlers.clear() })

function pdfContent(): MagicNoteCanvasContent {
  const bytes = Buffer.alloc(2 * 1024 * 1024, 32)
  bytes.write('%PDF-1.7\n')
  return { version: 2, kind: 'paged-canvas', pages: [{ id: 'page', width: 794, height: 1123, background: { type: 'pdf', assetId: 'pdf', pageNumber: 1 }, objects: [] }],
    assets: [{ id: 'pdf', name: 'document.pdf', mimeType: 'application/pdf', dataUrl: 'data:application/pdf;base64,' + bytes.toString('base64') }] }
}

it('reuses media through the save handler, omits unchanged records, and reopens complete content', async () => {
  const content = pdfContent()
  let note = database.createMagicNote({ title: 'Media save', content })
  note = database.createMagicNoteEntry({ noteId: note.id, content, plainText: '' })
  const entry = note.entries[0]!
  const edited = { ...content, pages: content.pages.map(page => ({ ...page, objects: [{ type: 'IText', text: 'New annotation', left: 20, top: 20 }] })) }
  const compact = compactNoteMedia(edited, entry.content)
  const input = { entryId: entry.id, expectedRevision: entry.revision, ...compact, knownEntries: note.entries.map(({ id, revision }) => ({ id, revision })) }
  expect(JSON.stringify(input).length).toBeLessThan(2000)
  expect(JSON.stringify(edited).length).toBeGreaterThan(2 * 1024 * 1024)
  const response = await handlers.get(ipcChannels.magicNotesUpdateEntry)!(event, structuredClone(input))
  expect(response.entries.map(item => item.id)).toEqual([entry.id])
  const merged = mergeNoteSaveResult(response, note)
  expect(merged.entries[0]!.content).toEqual(edited)
  expect(merged.entries[1]).toBe(note.entries[1])
  await expect(handlers.get(ipcChannels.magicNotesUpdateEntry)!(event, input)).rejects.toThrow('已被更新')
  database.close(); database.initialize(directory)
  expect(database.getMagicNote(note.id).entries).toEqual(merged.entries)
  // A concurrent update changes the revision, so it must be sent back even when known.
  database.updateMagicNoteEntry({ entryId: note.entries[1]!.id, expectedRevision: note.entries[1]!.revision, content: { version: 1, ops: [{ insert: 'Changed elsewhere\n' }] }, plainText: '' })
  const next = await handlers.get(ipcChannels.magicNotesCreateEntry)!(event, { noteId: note.id, content: { version: 1, ops: [{ insert: 'New\n' }] }, knownEntries: merged.entries.map(({ id, revision }) => ({ id, revision })) })
  expect(next.entries).toHaveLength(2)
  expect(mergeNoteSaveResult(next, merged).entries).toEqual(database.getMagicNote(note.id).entries)
})

it('rejects invalid media positions without overwriting the saved entry', async () => {
  const note = database.createMagicNote({ title: 'Invalid reuse', content: pdfContent() })
  const entry = note.entries[0]!
  for (const reusedMedia of [[{ slot: 0, previousSlot: 999 }], [{ slot: 999, previousSlot: 0 }], [{ slot: 0, previousSlot: 0 }, { slot: 0, previousSlot: 0 }]]) {
    await expect(handlers.get(ipcChannels.magicNotesUpdateEntry)!(event, { entryId: entry.id, expectedRevision: entry.revision, content: entry.content, reusedMedia })).rejects.toThrow()
    expect(database.getMagicNoteEntry(entry.id)).toEqual(entry)
  }
})

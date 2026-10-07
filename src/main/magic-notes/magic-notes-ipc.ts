import type { BrowserWindow, ipcMain } from 'electron'
import { ipcChannels } from '../../shared/ipc-channels'
import {
  magicNoteCreateSchema,
  magicNoteSearchSchema,
  type MagicNoteSource,
  magicNoteDeleteSchema,
  magicNoteEntryCreateSchema,
  magicNoteEntryDeleteSchema,
  magicNoteEntryUpdateSchema,
  magicNoteTagCreateSchema,
  magicNoteTagDeleteSchema,
  magicNoteTagRenameSchema,
  magicNoteUpdateSchema,
  magicTodoUpdateSchema
} from '../../shared/magic-notes-contracts'
import type { AssistantStoragePort } from '../assistant-storage-port'
import { assertTrustedSender } from '../trusted-ipc-sender'
import { magicNotePlainText, validateMagicNoteContent } from './rich-content'

export function registerMagicNotesIpcHandlers(
  registerHandler: typeof ipcMain.handle,
  window: BrowserWindow,
  assistantDatabase: AssistantStoragePort
): void {
  const resolveMagicNoteSource = async (source?: MagicNoteSource): Promise<MagicNoteSource | undefined> => {
    if (!source) return undefined
    const conversation = await assistantDatabase.getConversation(source.conversationId)
    const messages = new Map(conversation.messages.map((message) => [message.id, message]))
    for (const id of source.messageIds) {
      const message = messages.get(id)
      if (!message || (source.kind === 'message' && message.role !== 'assistant')) {
        throw new Error('Invalid conversation source message')
      }
    }
    const project = conversation.projectId ? await assistantDatabase.getProject(conversation.projectId) : undefined
    return {
      kind: source.kind,
      conversationId: conversation.id,
      messageIds: source.messageIds,
      capturedAt: source.capturedAt,
      conversationTitle: conversation.title,
      ...(project ? { projectId: project.id, projectName: project.name } : {})
    }
  }

  registerHandler(ipcChannels.magicNotesSearch, (event, input: unknown) => {
    assertTrustedSender(event, window)
    const { query, limit } = magicNoteSearchSchema.parse(input)
    return assistantDatabase.searchMagicNoteSummaries(query, limit)
  })

  registerHandler(ipcChannels.magicNotesList, async (event) => {
    assertTrustedSender(event, window)
    return {
      notes: await assistantDatabase.listMagicNotes(),
      tags: await assistantDatabase.listMagicNoteTags()
    }
  })

  registerHandler(ipcChannels.magicNotesRenameTag, (event, input: unknown) => {
    assertTrustedSender(event, window)
    return assistantDatabase.renameMagicNoteTag(magicNoteTagRenameSchema.parse(input))
  })

  registerHandler(ipcChannels.magicNotesCreateTag, (event, input: unknown) => {
    assertTrustedSender(event, window)
    return assistantDatabase.createMagicNoteTag(magicNoteTagCreateSchema.parse(input))
  })

  registerHandler(ipcChannels.magicNotesDeleteTag, (event, input: unknown) => {
    assertTrustedSender(event, window)
    const { tagId } = magicNoteTagDeleteSchema.parse(input)
    return assistantDatabase.deleteMagicNoteTag(tagId)
  })

  registerHandler(ipcChannels.magicNotesGet, (event, input: unknown) => {
    assertTrustedSender(event, window)
    const { noteId } = magicNoteDeleteSchema.parse(input)
    return assistantDatabase.getMagicNote(noteId)
  })

  registerHandler(ipcChannels.magicNotesCreate, async (event, input: unknown) => {
    assertTrustedSender(event, window)
    const parsed = magicNoteCreateSchema.parse(input)
    return assistantDatabase.createMagicNote({ ...parsed, source: await resolveMagicNoteSource(parsed.source) })
  })

  registerHandler(ipcChannels.magicNotesUpdate, (event, input: unknown) => {
    assertTrustedSender(event, window)
    return assistantDatabase.updateMagicNote(
      magicNoteUpdateSchema.parse(input)
    )
  })

  registerHandler(ipcChannels.magicNotesDelete, (event, input: unknown) => {
    assertTrustedSender(event, window)
    const { noteId } = magicNoteDeleteSchema.parse(input)
    return assistantDatabase.deleteMagicNote(noteId)
  })

  registerHandler(
    ipcChannels.magicNotesCreateEntry,
    async (event, input: unknown) => {
      assertTrustedSender(event, window)
      const parsed = magicNoteEntryCreateSchema.parse(input)
      const content = validateMagicNoteContent(parsed.content)
      return assistantDatabase.createMagicNoteEntry({
        noteId: parsed.noteId,
        content,
        source: await resolveMagicNoteSource(parsed.source),
        plainText: magicNotePlainText(content)
      })
    }
  )

  registerHandler(
    ipcChannels.magicNotesUpdateEntry,
    (event, input: unknown) => {
      assertTrustedSender(event, window)
      const parsed = magicNoteEntryUpdateSchema.parse(input)
      const content = validateMagicNoteContent(parsed.content)
      return assistantDatabase.updateMagicNoteEntry({
        entryId: parsed.entryId,
        expectedRevision: parsed.expectedRevision,
        content,
        plainText: magicNotePlainText(content)
      })
    }
  )

  registerHandler(
    ipcChannels.magicNotesDeleteEntry,
    (event, input: unknown) => {
      assertTrustedSender(event, window)
      const { entryId } = magicNoteEntryDeleteSchema.parse(input)
      return assistantDatabase.deleteMagicNoteEntry(entryId)
    }
  )
}

export function registerMagicTodosIpcHandlers(
  registerHandler: typeof ipcMain.handle,
  window: BrowserWindow,
  assistantDatabase: AssistantStoragePort
): void {
  registerHandler(
    ipcChannels.magicTodosList,
    async (event) => {
      assertTrustedSender(event, window)
      return { todos: await assistantDatabase.listMagicTodos() }
    }
  )

  registerHandler(
    ipcChannels.magicTodosStatus,
    (event) => {
      assertTrustedSender(event, window)
      return assistantDatabase.getMagicTodoStatus()
    }
  )

  registerHandler(
    ipcChannels.magicTodosUpdate,
    async (event, input: unknown) => {
      assertTrustedSender(event, window)
      const todo = await assistantDatabase.updateMagicTodo(
        magicTodoUpdateSchema.parse(input)
      )
      return {
        todo,
        note: await assistantDatabase.getMagicNote(todo.noteId)
      }
    }
  )
}

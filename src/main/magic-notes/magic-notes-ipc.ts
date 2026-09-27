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
  magicNoteUpdateSchema,
  magicTodoUpdateSchema
} from '../../shared/magic-notes-contracts'
import type { AssistantDatabase } from '../assistant/assistant-database'
import { assertTrustedSender } from '../trusted-ipc-sender'
import { magicNotePlainText, validateMagicNoteContent } from './rich-content'

export function registerMagicNotesIpcHandlers(
  registerHandler: typeof ipcMain.handle,
  window: BrowserWindow,
  assistantDatabase: AssistantDatabase
): void {
  const resolveMagicNoteSource = (source?: MagicNoteSource): MagicNoteSource | undefined => {
    if (!source) return undefined
    const conversation = assistantDatabase.getConversation(source.conversationId)
    const messages = new Map(conversation.messages.map((message) => [message.id, message]))
    for (const id of source.messageIds) {
      const message = messages.get(id)
      if (!message || (source.kind === 'message' && message.role !== 'assistant')) {
        throw new Error('Invalid conversation source message')
      }
    }
    const project = conversation.projectId ? assistantDatabase.getProject(conversation.projectId) : undefined
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

  registerHandler(ipcChannels.magicNotesList, (event) => {
    assertTrustedSender(event, window)
    return { notes: assistantDatabase.listMagicNotes() }
  })

  registerHandler(ipcChannels.magicNotesGet, (event, input: unknown) => {
    assertTrustedSender(event, window)
    const { noteId } = magicNoteDeleteSchema.parse(input)
    return assistantDatabase.getMagicNote(noteId)
  })

  registerHandler(ipcChannels.magicNotesCreate, (event, input: unknown) => {
    assertTrustedSender(event, window)
    const parsed = magicNoteCreateSchema.parse(input)
    return assistantDatabase.createMagicNote({ ...parsed, source: resolveMagicNoteSource(parsed.source) })
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
    assistantDatabase.deleteMagicNote(noteId)
  })

  registerHandler(
    ipcChannels.magicNotesCreateEntry,
    (event, input: unknown) => {
      assertTrustedSender(event, window)
      const parsed = magicNoteEntryCreateSchema.parse(input)
      const content = validateMagicNoteContent(parsed.content)
      return assistantDatabase.createMagicNoteEntry({
        noteId: parsed.noteId,
        content,
        source: resolveMagicNoteSource(parsed.source),
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
  assistantDatabase: AssistantDatabase
): void {
  registerHandler(
    ipcChannels.magicTodosList,
    (event) => {
      assertTrustedSender(event, window)
      return { todos: assistantDatabase.listMagicTodos() }
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
    (event, input: unknown) => {
      assertTrustedSender(event, window)
      const todo = assistantDatabase.updateMagicTodo(
        magicTodoUpdateSchema.parse(input)
      )
      return {
        todo,
        note: assistantDatabase.getMagicNote(todo.noteId)
      }
    }
  )
}

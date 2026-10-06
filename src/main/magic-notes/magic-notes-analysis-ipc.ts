import { randomUUID } from 'node:crypto'
import type { BrowserWindow, ipcMain } from 'electron'
import { ipcChannels } from '../../shared/ipc-channels'
import {
  magicNoteAnalyzeSchema,
  magicNoteDraftAnalyzeSchema,
  magicTodoIdSchema
} from '../../shared/magic-notes-contracts'
import { createDefaultModelRuntime } from '../agent/create-runtime'
import type { RuntimeModelUsageEvent } from '../agent/runtime'
import type { ApplicationSettingsStore } from '../application-settings-store'
import type { AssistantStoragePort, Awaitable } from '../assistant-storage-port'
import type { RuntimeSettingsStore } from '../runtime-settings-store'
import { assertTrustedSender } from '../trusted-ipc-sender'
import {
  analyzeMagicNoteDraft,
  analyzeMagicNoteEntry,
  analyzeMagicTodo
} from './magic-note-analyzer'
import { magicNotePlainText, validateMagicNoteContent } from './rich-content'

type AnalysisDependencies = {
  window: BrowserWindow
  assistantDatabase: AssistantStoragePort
  settingsStore: Pick<RuntimeSettingsStore, 'getResolvedSettings'>
  applicationSettingsStore?: Pick<ApplicationSettingsStore, 'get'>
  persistModelUsage: (event: RuntimeModelUsageEvent) => Awaitable<void>
  safeRuntimeError: (error: unknown, fallback: string) => string
}

export function registerMagicNotesAnalysisIpcHandlers(
  registerHandler: typeof ipcMain.handle,
  { window, assistantDatabase, settingsStore, applicationSettingsStore, persistModelUsage, safeRuntimeError }: AnalysisDependencies
): void {
  registerHandler(
    ipcChannels.magicNotesAnalyze,
    async (event, input: unknown) => {
      assertTrustedSender(event, window)
      const { entryId, requestId, direction, format, canvasImages, canvasPageText, expectedRevision } =
        magicNoteAnalyzeSchema.parse(input)
      const settings = await settingsStore.getResolvedSettings()
      const entry = await assistantDatabase.getMagicNoteEntry(entryId)
      if (expectedRevision !== undefined && entry.revision !== expectedRevision) {
        throw new Error('记录已被更新，请重新捕获并分析')
      }
      const note = await assistantDatabase.getMagicNoteContext(entry.noteId)
      const canvasPageCount = (await applicationSettingsStore?.get())?.magicNoteCanvasPageCount ?? 1
      const analysisRuntime = createDefaultModelRuntime(
        settings.workspacePath,
        settings
      )
      try {
        await assistantDatabase.createTask({
          id: requestId,
          title: `分析笔记：${note.title}`,
          instructions: '使用无工具模型对笔记记录进行只读分析',
          origin: 'assistant',
          visible: false
        })
        const comments = await analyzeMagicNoteEntry(
          analysisRuntime,
          entry,
          { requestId, direction, format, canvasImages, canvasPageText },
          format === 'structured'
            ? undefined
            : (delta) => {
                if (!window.isDestroyed()) {
                  window.webContents.send(
                    ipcChannels.magicNotesAnalysisEvent,
                    {
                      requestId,
                      type: 'text',
                      delta,
                      direction,
                      format
                    }
                  )
                }
              },
          persistModelUsage,
          { supportsImageInput: settings.supportsImageInput === true, canvasPageCount }
        )
        const analyzedNote = await assistantDatabase.saveMagicNoteAnalysis({
          entryId,
          expectedRevision: entry.revision,
          comments
        })
        await assistantDatabase.updateTaskStatus(requestId, 'completed')
        return analyzedNote
      } catch (error) {
        const message = safeRuntimeError(error, '魔法笔记 AI 分析失败')
        await assistantDatabase.updateTaskStatus(requestId, 'failed', message)
        throw new Error(message, { cause: error })
      } finally {
        try {
          await analysisRuntime.releaseConversation?.(
            `magic-notes:${entry.id}`
          )
        } finally {
          await analysisRuntime.dispose()
        }
      }
    }
  )

  registerHandler(
    ipcChannels.magicNotesAnalyzeDraft,
    async (event, input: unknown) => {
      assertTrustedSender(event, window)
      const parsed = magicNoteDraftAnalyzeSchema.parse(input)
      const content = validateMagicNoteContent(parsed.content)
      const plainText = magicNotePlainText(content)
      const settings = await settingsStore.getResolvedSettings()
      const canvasPageCount = (await applicationSettingsStore?.get())?.magicNoteCanvasPageCount ?? 1
      const analysisRuntime = createDefaultModelRuntime(
        settings.workspacePath,
        settings
      )
      const { requestId, direction, format, canvasImages, canvasPageText } = parsed
      try {
        await assistantDatabase.createTask({
          id: requestId,
          title: '分析未保存笔记草稿',
          instructions: '使用无工具模型对未保存笔记草稿进行只读分析',
          origin: 'assistant',
          visible: false
        })
        const comments = await analyzeMagicNoteDraft(
          analysisRuntime,
          plainText,
          { requestId, direction, format, canvasImages, canvasPageText },
          format === 'structured'
            ? undefined
            : (delta) => {
                if (!window.isDestroyed()) {
                  window.webContents.send(
                    ipcChannels.magicNotesAnalysisEvent,
                    {
                      requestId,
                      type: 'text',
                      delta,
                      direction,
                      format
                    }
                  )
                }
              },
          persistModelUsage,
          { supportsImageInput: settings.supportsImageInput === true, content, canvasPageCount }
        )
        await assistantDatabase.updateTaskStatus(requestId, 'completed')
        return {
          id: randomUUID(),
          comments,
          inputMode: comments[0]?.inputMode,
          analyzedAt: new Date().toISOString()
        }
      } catch (error) {
        const message = safeRuntimeError(error, '魔法笔记草稿 AI 分析失败')
        await assistantDatabase.updateTaskStatus(requestId, 'failed', message)
        throw new Error(message, { cause: error })
      } finally {
        try {
          await analysisRuntime.releaseConversation?.(
            `magic-note-drafts:${requestId}`
          )
        } finally {
          await analysisRuntime.dispose()
        }
      }
    }
  )
}

export function registerMagicTodosAnalysisIpcHandlers(
  registerHandler: typeof ipcMain.handle,
  { window, assistantDatabase, settingsStore, applicationSettingsStore, persistModelUsage, safeRuntimeError }: AnalysisDependencies
): void {
  registerHandler(
    ipcChannels.magicTodosAnalyze,
    async (event, input: unknown) => {
      assertTrustedSender(event, window)
      const { todoId, requestId, direction, format, canvasImages, canvasPageText, sourceEntryRevision } =
        magicTodoIdSchema.parse(input)
      const settings = await settingsStore.getResolvedSettings()
      const todo = await assistantDatabase.getMagicTodo(todoId)
      const canvasPageCount = (await applicationSettingsStore?.get())?.magicNoteCanvasPageCount ?? 1
      const entry = await assistantDatabase.getMagicNoteEntry(todo.entryId)
      if (sourceEntryRevision !== undefined && entry.revision !== sourceEntryRevision) {
        throw new Error('来源记录已被更新，请重新捕获并分析')
      }
      const analysisRuntime = createDefaultModelRuntime(
        settings.workspacePath,
        settings
      )
      try {
        await assistantDatabase.createTask({
          id: requestId,
          title: `分析待办：${todo.title}`,
          instructions: '使用无工具模型对魔法笔记待办进行只读分析',
          origin: 'assistant',
          visible: false
        })
        const comments = await analyzeMagicTodo(
          analysisRuntime,
          todo,
          { requestId, direction, format, canvasImages, canvasPageText },
          format === 'structured'
            ? undefined
            : (delta) => {
                if (!window.isDestroyed()) {
                  window.webContents.send(
                    ipcChannels.magicNotesAnalysisEvent,
                    {
                      requestId,
                      type: 'text',
                      delta,
                      direction,
                      format
                    }
                  )
                }
              },
          persistModelUsage,
          { supportsImageInput: settings.supportsImageInput === true, content: entry.content, canvasPageCount }
        )
        const analyzedTodo = await assistantDatabase.saveMagicTodoAnalysis({
          todoId,
          expectedRevision: todo.revision,
          sourceEntryRevision: entry.revision,
          comments
        })
        await assistantDatabase.updateTaskStatus(requestId, 'completed')
        return analyzedTodo
      } catch (error) {
        const message = safeRuntimeError(error, '魔法笔记待办 AI 分析失败')
        await assistantDatabase.updateTaskStatus(requestId, 'failed', message)
        throw new Error(message, { cause: error })
      } finally {
        try {
          await analysisRuntime.releaseConversation?.(
            `magic-todos:${todo.id}`
          )
        } finally {
          await analysisRuntime.dispose()
        }
      }
    }
  )
}

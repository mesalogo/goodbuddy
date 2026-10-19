import { randomUUID } from 'node:crypto'
import type { BrowserWindow, ipcMain } from 'electron'
import { ipcChannels } from '../../shared/ipc-channels'
import {
  magicNoteAnalyzeSchema,
  magicNoteDraftAnalyzeSchema,
  magicNoteQuestionSchema,
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
  analyzeMagicTodo,
  askMagicNoteQuestion
} from './magic-note-analyzer'
import { magicNotePlainText, validateMagicNoteContent } from './rich-content'
import { magicNoteCanvasPlainText } from '../../shared/magic-note-canvas-text'

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
    ipcChannels.magicNotesAsk,
    async (event, input: unknown) => {
      assertTrustedSender(event, window)
      const parsed = magicNoteQuestionSchema.parse(input)
      const settings = await settingsStore.getResolvedSettings()
      const note = await assistantDatabase.getMagicNote(parsed.noteId)
      const selectedEntries = parsed.scope === 'document' ? note.entries : note.entries.filter((entry) => entry.id === parsed.entryId)
      if (!selectedEntries.length) throw new Error('所选范围没有可供问答的内容')
      if (parsed.contexts.length !== selectedEntries.length || new Set(parsed.contexts.map(context => context.entryId)).size !== selectedEntries.length) {
        throw new Error('笔记记录已变化，请重新捕获上下文')
      }
      const supportsImages = settings.supportsImageInput === true
      if (parsed.scope === 'region' && !supportsImages) throw new Error('区域截图需要支持图像输入的模型，请切换模型或改用页面文字问答')
      const sources: string[] = []
      for (const entry of selectedEntries) {
        const snapshot = parsed.contexts.find(context => context.entryId === entry.id)
        if (!snapshot || snapshot.revision !== entry.revision) throw new Error('记录已更新，请重新捕获上下文')
        if (entry.content.version === 1) {
          if (parsed.scope === 'region' || (parsed.scope !== 'document' && (parsed.pageStart !== 1 || parsed.pageEnd !== 1)) || snapshot.pages.length) {
            throw new Error('普通文本记录仅支持第 1 页；区域截图需要分页画布')
          }
          if (entry.plainText.trim()) sources.push(`记录 ${entry.id}：\n${entry.plainText}`)
          if (supportsImages) snapshot.pages = entry.content.ops.flatMap((op, index) => typeof op.insert === 'object' && 'image' in op.insert
            ? [{ pageId: `image-${index}`, text: '', dataUrl: op.insert.image }] : [])
          continue
        }
        const start = parsed.scope === 'document' ? 1 : parsed.pageStart!
        const end = parsed.scope === 'document' ? entry.content.pages.length : parsed.pageEnd!
        if (start < 1 || end > entry.content.pages.length || start > end) throw new Error('页码超出记录范围')
        const pages = entry.content.pages.slice(start - 1, end)
        if (snapshot.pages.length !== pages.length || pages.some((page, index) => snapshot.pages[index]?.pageId !== page.id)) {
          throw new Error('页面上下文缺失或不匹配，请重新捕获所选范围')
        }
        for (const [index, page] of pages.entries()) {
          const capture = snapshot.pages[index]!
          if (supportsImages && !capture.dataUrl) throw new Error('所选范围截图不完整，请重新捕获')
          if (!supportsImages) delete capture.dataUrl
          // Crops must not receive text outside the selected rectangle.
          const text = parsed.scope === 'region' ? '' : [capture.text, magicNoteCanvasPlainText({ ...entry.content, flow: undefined, pages: [page] })].filter(Boolean).join('\n')
          if (text.trim() || capture.dataUrl) sources.push(`记录 ${entry.id} 第 ${start + index} 页${parsed.scope === 'region' ? '所选区域' : ''}：\n${text}`)
        }
      }
      const source = sources.join('\n\n')
      const analysisRuntime = createDefaultModelRuntime(settings.workspacePath, settings)
      const requestId = randomUUID()
      let taskCreated = false
      try {
        await assistantDatabase.createTask({
          id: requestId,
          title: `笔记问答：${note.title}`,
          instructions: '使用无工具模型对所选笔记上下文进行只读问答',
          origin: 'magic-notes',
          visible: false
        })
        taskCreated = true
        const answer = await askMagicNoteQuestion(analysisRuntime, { ...parsed, requestId }, source, persistModelUsage)
        await assistantDatabase.updateTaskStatus(requestId, 'completed')
        return { requestId, answer, inputMode: supportsImages ? 'vision' : 'text' }
      } catch (error) {
        const message = safeRuntimeError(error, '魔法笔记问答失败')
        if (taskCreated) await assistantDatabase.updateTaskStatus(requestId, 'failed', message)
        throw new Error(message, { cause: error })
      } finally {
        try { await analysisRuntime.releaseConversation?.(`magic-note-questions:${parsed.noteId}`) }
        finally { await analysisRuntime.dispose() }
      }
    }
  )

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
          origin: 'magic-notes',
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
          origin: 'magic-notes',
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
          origin: 'magic-notes',
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

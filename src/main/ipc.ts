import { app, BrowserWindow, ipcMain } from 'electron'
import { z } from 'zod'
import {
  agentRequestSchema,
  runtimeSettingsInputSchema,
  type AgentEvent,
  type AppInfo,
  type RuntimeSettings
} from '../shared/contracts'
import { ipcChannels } from '../shared/ipc-channels'
import type { AgentRuntime } from './agent/runtime'
import type { ContextManager } from './context-manager'
import type { RuntimeSettingsStore } from './runtime-settings-store'
import type { ToolApprovalBroker } from './tool-approval-broker'
import { showWindow } from './window'

const requestIdSchema = z.string().uuid()
const approvalResponseSchema = z
  .object({
    approvalId: z.string().uuid(),
    approved: z.boolean()
  })
  .strict()

function assertTrustedSender(
  event: Electron.IpcMainInvokeEvent,
  window: BrowserWindow
): void {
  if (
    event.sender !== window.webContents ||
    event.senderFrame !== window.webContents.mainFrame ||
    event.senderFrame.url !== window.webContents.getURL()
  ) {
    throw new Error('拒绝来自未知窗口的 IPC 请求')
  }
}

export function registerIpcHandlers(
  window: BrowserWindow,
  runtime: AgentRuntime,
  shortcut: string,
  settingsStore: RuntimeSettingsStore,
  contextManager: ContextManager,
  approvalBroker: ToolApprovalBroker,
  defaultWorkspace: string,
  onRuntimeSettingsChanged: () => Promise<void>
): () => void {
  const activeRequests = new Map<string, AbortController>()
  const channels = Object.values(ipcChannels).filter(
    (channel) =>
      channel !== ipcChannels.agentEvent &&
      channel !== ipcChannels.conversationNew
  )

  for (const channel of channels) {
    ipcMain.removeHandler(channel)
  }

  const abortActiveRequests = (reason: string): void => {
    for (const controller of activeRequests.values()) {
      controller.abort(new Error(reason))
    }
    activeRequests.clear()
  }

  ipcMain.handle(ipcChannels.appInfo, (event): AppInfo => {
    assertTrustedSender(event, window)
    return {
      name: app.getName(),
      version: app.getVersion(),
      platform: process.platform,
      arch: process.arch,
      shortcut
    }
  })

  ipcMain.handle(ipcChannels.appShow, (event) => {
    assertTrustedSender(event, window)
    showWindow(window)
  })

  ipcMain.handle(ipcChannels.appHide, (event) => {
    assertTrustedSender(event, window)
    window.hide()
  })

  ipcMain.handle(ipcChannels.agentStatus, (event) => {
    assertTrustedSender(event, window)
    return runtime.getStatus()
  })

  ipcMain.handle(ipcChannels.agentRun, (event, input: unknown) => {
    assertTrustedSender(event, window)
    const request = contextManager.enrichRequest(agentRequestSchema.parse(input))
    if (activeRequests.has(request.requestId)) {
      throw new Error('请求正在执行')
    }

    const controller = new AbortController()
    activeRequests.set(request.requestId, controller)

    void (async () => {
      try {
        for await (const agentEvent of runtime.run(
          request,
          controller.signal,
          async (requiresToolApproval) => {
            if (!requiresToolApproval) {
              return
            }
            const settings = await settingsStore.getResolvedSettings()
            await approvalBroker.request(
              settings.toolApproval,
              request.requestId,
              defaultWorkspace,
              controller.signal,
              (approvalEvent) => {
                if (!window.isDestroyed()) {
                  window.webContents.send(
                    ipcChannels.agentEvent,
                    approvalEvent
                  )
                }
              }
            )
          }
        )) {
          if (!window.isDestroyed()) {
            window.webContents.send(ipcChannels.agentEvent, agentEvent)
          }
        }
      } catch (error) {
        if (!window.isDestroyed()) {
          const agentEvent: AgentEvent = {
            requestId: request.requestId,
            type: 'error',
            message: controller.signal.aborted
              ? '请求已取消'
              : error instanceof Error
                ? error.message
                : 'Agent Runtime 执行失败'
          }
          window.webContents.send(ipcChannels.agentEvent, agentEvent)
        }
      } finally {
        activeRequests.delete(request.requestId)
      }
    })()
  })

  ipcMain.handle(ipcChannels.agentCancel, (event, input: unknown) => {
    assertTrustedSender(event, window)
    const requestId = requestIdSchema.parse(input)
    activeRequests.get(requestId)?.abort(new Error('用户取消了请求'))
  })

  ipcMain.handle(ipcChannels.agentApprovalRespond, (event, input: unknown) => {
    assertTrustedSender(event, window)
    const response = approvalResponseSchema.parse(input)
    approvalBroker.respond(response.approvalId, response.approved)
  })

  ipcMain.handle(
    ipcChannels.runtimeSettingsGet,
    (event): Promise<RuntimeSettings> => {
      assertTrustedSender(event, window)
      return settingsStore.getPublicSettings()
    }
  )

  ipcMain.handle(
    ipcChannels.runtimeSettingsUpdate,
    async (event, input: unknown): Promise<RuntimeSettings> => {
      assertTrustedSender(event, window)
      const settings = runtimeSettingsInputSchema.parse(input)
      const savedSettings = await settingsStore.update(settings)
      abortActiveRequests('运行时设置已更改')
      await onRuntimeSettingsChanged()
      return savedSettings
    }
  )

  ipcMain.handle(ipcChannels.contextSelectFiles, (event) => {
    assertTrustedSender(event, window)
    return contextManager.selectFiles(window)
  })

  ipcMain.handle(ipcChannels.contextRemove, (event, input: unknown) => {
    assertTrustedSender(event, window)
    contextManager.remove(requestIdSchema.parse(input))
  })

  return () => {
    abortActiveRequests('应用正在退出')
    approvalBroker.clear()
    contextManager.clear()
    for (const channel of channels) {
      ipcMain.removeHandler(channel)
    }
  }
}

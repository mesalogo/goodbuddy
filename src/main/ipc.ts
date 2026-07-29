import { app, BrowserWindow, ipcMain } from 'electron'
import { z } from 'zod'
import {
  agentRequestSchema,
  type AgentEvent,
  type AppInfo
} from '../shared/contracts'
import { ipcChannels } from '../shared/ipc-channels'
import type { AgentRuntime } from './agent/runtime'
import { showWindow } from './window'

const requestIdSchema = z.string().uuid()

function assertTrustedSender(event: Electron.IpcMainInvokeEvent, window: BrowserWindow): void {
  if (event.sender !== window.webContents) {
    throw new Error('拒绝来自未知窗口的 IPC 请求')
  }
}

export function registerIpcHandlers(
  window: BrowserWindow,
  runtime: AgentRuntime,
  shortcut: string
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
    const request = agentRequestSchema.parse(input)
    if (activeRequests.has(request.requestId)) {
      throw new Error('请求正在执行')
    }

    const controller = new AbortController()
    activeRequests.set(request.requestId, controller)

    void (async () => {
      try {
        for await (const agentEvent of runtime.run(
          request,
          controller.signal
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

  return () => {
    for (const controller of activeRequests.values()) {
      controller.abort(new Error('应用正在退出'))
    }
    activeRequests.clear()
    for (const channel of channels) {
      ipcMain.removeHandler(channel)
    }
  }
}

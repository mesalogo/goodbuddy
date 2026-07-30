import { contextBridge, ipcRenderer } from 'electron'
import {
  type AgentEvent,
  type AgentRequest,
  type AgentRuntimeStatus,
  type AppInfo,
  type ContextAttachment,
  type DesktopApi,
  type RuntimeSettings,
  type RuntimeSettingsInput
} from '../shared/contracts'
import { ipcChannels } from '../shared/ipc-channels'

const desktopApi: DesktopApi = {
  app: {
    getInfo: () => ipcRenderer.invoke(ipcChannels.appInfo) as Promise<AppInfo>,
    show: async () => {
      await ipcRenderer.invoke(ipcChannels.appShow)
    },
    hide: async () => {
      await ipcRenderer.invoke(ipcChannels.appHide)
    },
    onNewConversation: (listener) => {
      const handler = (): void => listener()
      ipcRenderer.on(ipcChannels.conversationNew, handler)
      return () => ipcRenderer.removeListener(ipcChannels.conversationNew, handler)
    }
  },
  agent: {
    getStatus: () =>
      ipcRenderer.invoke(
        ipcChannels.agentStatus
      ) as Promise<AgentRuntimeStatus>,
    run: async (request: AgentRequest) => {
      await ipcRenderer.invoke(ipcChannels.agentRun, request)
    },
    cancel: async (requestId: string) => {
      await ipcRenderer.invoke(ipcChannels.agentCancel, requestId)
    },
    respondApproval: async (approvalId: string, approved: boolean) => {
      await ipcRenderer.invoke(ipcChannels.agentApprovalRespond, {
        approvalId,
        approved
      })
    },
    onEvent: (listener) => {
      const handler = (_event: Electron.IpcRendererEvent, payload: AgentEvent): void =>
        listener(payload)
      ipcRenderer.on(ipcChannels.agentEvent, handler)
      return () => ipcRenderer.removeListener(ipcChannels.agentEvent, handler)
    }
  },
  settings: {
    getRuntime: () =>
      ipcRenderer.invoke(
        ipcChannels.runtimeSettingsGet
      ) as Promise<RuntimeSettings>,
    updateRuntime: (input: RuntimeSettingsInput) =>
      ipcRenderer.invoke(
        ipcChannels.runtimeSettingsUpdate,
        input
      ) as Promise<RuntimeSettings>
  },
  context: {
    selectFiles: () =>
      ipcRenderer.invoke(
        ipcChannels.contextSelectFiles
      ) as Promise<ContextAttachment[]>,
    remove: async (contextId: string) => {
      await ipcRenderer.invoke(ipcChannels.contextRemove, contextId)
    }
  }
}

contextBridge.exposeInMainWorld('goodbuddy', desktopApi)

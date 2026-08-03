import { contextBridge, ipcRenderer, webUtils } from 'electron'
import {
  type ApprovalDecision,
  type AgentEvent,
  type AgentRequest,
  type AgentRuntimeDetection,
  type AgentRuntimeStatus,
  type AppInfo,
  type ContextAttachment,
  type DesktopApi,
  type KnowledgeLibrary,
  type KnowledgeSearchReference,
  type KnowledgeSnapshot,
  type RuntimeSettings,
  type RuntimeSettingsInput,
  type RuntimeFileSelectionKind
} from '../shared/contracts'
import { ipcChannels } from '../shared/ipc-channels'
import type {
  CapabilitySnapshot,
  McpServerTestResult
} from '../shared/capability-contracts'
import type {
  AssistantProject,
  AssistantArtifact,
  AssistantMemory,
  AssistantSchedule,
  AssistantHeartbeatConfig,
  AssistantHeartbeatEntry,
  AssistantHeartbeatRun,
  AssistantExpert,
  AssistantTask,
  TokenUsageSummary,
  ConversationSnapshot,
  WorkspaceChanges,
  WorkspaceDirectoryListing,
  WorkspaceFilePreview,
  ProjectCreateInput,
  MemoryCreateInput,
  ScheduleCreateInput,
  HeartbeatCreateInput,
  HeartbeatUpdateInput,
  ExpertCreateInput
} from '../shared/assistant-contracts'

const desktopApi: DesktopApi = {
  app: {
    getInfo: () => ipcRenderer.invoke(ipcChannels.appInfo) as Promise<AppInfo>,
    show: async () => {
      await ipcRenderer.invoke(ipcChannels.appShow)
    },
    hide: async () => {
      await ipcRenderer.invoke(ipcChannels.appHide)
    },
    minimize: async () => {
      await ipcRenderer.invoke(ipcChannels.windowMinimize)
    },
    toggleMaximize: async () => {
      await ipcRenderer.invoke(ipcChannels.windowToggleMaximize)
    },
    close: async () => {
      await ipcRenderer.invoke(ipcChannels.windowClose)
    },
    isMaximized: () =>
      ipcRenderer.invoke(ipcChannels.windowIsMaximized) as Promise<boolean>,
    onMaximizedChanged: (listener) => {
      const handler = (
        _event: Electron.IpcRendererEvent,
        maximized: boolean
      ): void => listener(maximized)
      ipcRenderer.on(ipcChannels.windowMaximizedChanged, handler)
      return () =>
        ipcRenderer.removeListener(
          ipcChannels.windowMaximizedChanged,
          handler
        )
    },
    clearLocalData: async () => {
      await ipcRenderer.invoke(ipcChannels.appClearLocalData)
    },
    onNewConversation: (listener) => {
      const handler = (): void => listener()
      ipcRenderer.on(ipcChannels.conversationNew, handler)
      return () => ipcRenderer.removeListener(ipcChannels.conversationNew, handler)
    },
    onOpenSettings: (listener) => {
      const handler = (): void => listener()
      ipcRenderer.on(ipcChannels.settingsOpen, handler)
      return () => ipcRenderer.removeListener(ipcChannels.settingsOpen, handler)
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
    respondApproval: async (
      approvalId: string,
      decision: ApprovalDecision
    ) => {
      await ipcRenderer.invoke(ipcChannels.agentApprovalRespond, {
        approvalId,
        decision
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
      ) as Promise<RuntimeSettings>,
    selectWorkspace: () =>
      ipcRenderer.invoke(
        ipcChannels.runtimeSettingsSelectWorkspace
      ) as Promise<string | undefined>,
    detectAgentRuntimes: () =>
      ipcRenderer.invoke(
        ipcChannels.runtimeSettingsDetect
      ) as Promise<AgentRuntimeDetection>,
    selectRuntimeFile: (kind: RuntimeFileSelectionKind) =>
      ipcRenderer.invoke(
        ipcChannels.runtimeSettingsSelectFile,
        kind
      ) as Promise<string | undefined>,
    testRuntime: () =>
      ipcRenderer.invoke(
        ipcChannels.runtimeSettingsTest
      ) as Promise<AgentRuntimeStatus>
  },
  projects: {
    list: (includeArchived = false) =>
      ipcRenderer.invoke(
        ipcChannels.projectsList,
        includeArchived
      ) as Promise<AssistantProject[]>,
    create: (input: ProjectCreateInput) =>
      ipcRenderer.invoke(
        ipcChannels.projectsCreate,
        input
      ) as Promise<AssistantProject>,
    update: (projectId: string, input: ProjectCreateInput) =>
      ipcRenderer.invoke(
        ipcChannels.projectsUpdate,
        { projectId, input }
      ) as Promise<AssistantProject>,
    setArchived: async (projectId: string, archived: boolean) => {
      await ipcRenderer.invoke(ipcChannels.projectsSetArchived, {
        projectId,
        archived
      })
    }
  },
  conversations: {
    list: () =>
      ipcRenderer.invoke(
        ipcChannels.conversationsList
      ) as Promise<ConversationSnapshot[]>,
    replace: async (conversations: ConversationSnapshot[]) => {
      await ipcRenderer.invoke(
        ipcChannels.conversationsReplace,
        conversations
      )
    }
  },
  workspace: {
    getChanges: (projectId: string) =>
      ipcRenderer.invoke(
        ipcChannels.workspaceChangesGet,
        projectId
      ) as Promise<WorkspaceChanges>,
    listDirectory: (projectId: string, path: string) =>
      ipcRenderer.invoke(ipcChannels.workspaceDirectoryList, {
        projectId,
        path
      }) as Promise<WorkspaceDirectoryListing>,
    readFile: (projectId: string, path: string) =>
      ipcRenderer.invoke(ipcChannels.workspaceFileRead, {
        projectId,
        path
      }) as Promise<WorkspaceFilePreview>
  },
  tasks: {
    list: () =>
      ipcRenderer.invoke(ipcChannels.tasksList) as Promise<AssistantTask[]>,
    setStatus: async (
      taskId: string,
      status: 'completed' | 'cancelled'
    ) => {
      await ipcRenderer.invoke(ipcChannels.tasksSetStatus, {
        taskId,
        status
      })
    }
  },
  usage: {
    getTokenSummary: () =>
      ipcRenderer.invoke(
        ipcChannels.tokenUsageSummary
      ) as Promise<TokenUsageSummary>
  },
  artifacts: {
    list: (projectId?: string) =>
      ipcRenderer.invoke(
        ipcChannels.artifactsList,
        projectId
      ) as Promise<AssistantArtifact[]>,
    get: (artifactId: string) =>
      ipcRenderer.invoke(
        ipcChannels.artifactsGet,
        artifactId
      ) as Promise<AssistantArtifact>,
    importFiles: (projectId?: string) =>
      ipcRenderer.invoke(
        ipcChannels.artifactsImportFiles,
        projectId
      ) as Promise<AssistantArtifact[]>
  },
  memory: {
    list: (scopeId?: string) =>
      ipcRenderer.invoke(
        ipcChannels.memoryList,
        scopeId
      ) as Promise<AssistantMemory[]>,
    create: (input: MemoryCreateInput) =>
      ipcRenderer.invoke(
        ipcChannels.memoryCreate,
        input
      ) as Promise<AssistantMemory>,
    setStatus: async (
      memoryId: string,
      status: AssistantMemory['status']
    ) => {
      await ipcRenderer.invoke(ipcChannels.memorySetStatus, {
        memoryId,
        status
      })
    },
    remove: async (memoryId: string) => {
      await ipcRenderer.invoke(ipcChannels.memoryRemove, memoryId)
    }
  },
  schedules: {
    list: (projectId?: string) =>
      ipcRenderer.invoke(
        ipcChannels.schedulesList,
        projectId
      ) as Promise<AssistantSchedule[]>,
    create: (input: ScheduleCreateInput) =>
      ipcRenderer.invoke(
        ipcChannels.schedulesCreate,
        input
      ) as Promise<AssistantSchedule>,
    setEnabled: async (scheduleId: string, enabled: boolean) => {
      await ipcRenderer.invoke(ipcChannels.schedulesSetEnabled, {
        scheduleId,
        enabled
      })
    },
    remove: async (scheduleId: string) => {
      await ipcRenderer.invoke(ipcChannels.schedulesRemove, scheduleId)
    },
    runNow: async (scheduleId: string) => {
      await ipcRenderer.invoke(ipcChannels.schedulesRunNow, scheduleId)
    }
  },
  heartbeats: {
    list: (projectId?: string) =>
      ipcRenderer.invoke(ipcChannels.heartbeatsList, {
        projectId
      }) as Promise<AssistantHeartbeatConfig[]>,
    create: (input: HeartbeatCreateInput) =>
      ipcRenderer.invoke(
        ipcChannels.heartbeatsCreate,
        input
      ) as Promise<AssistantHeartbeatConfig>,
    update: (heartbeatId: string, input: HeartbeatUpdateInput) =>
      ipcRenderer.invoke(ipcChannels.heartbeatsUpdate, {
        id: heartbeatId,
        config: input
      }) as Promise<AssistantHeartbeatConfig>,
    setPaused: async (heartbeatId: string, paused: boolean) => {
      await ipcRenderer.invoke(ipcChannels.heartbeatsSetPaused, {
        id: heartbeatId,
        paused
      })
    },
    remove: async (heartbeatId: string) => {
      await ipcRenderer.invoke(ipcChannels.heartbeatsRemove, {
        id: heartbeatId
      })
    },
    runNow: (heartbeatId: string) =>
      ipcRenderer.invoke(ipcChannels.heartbeatsRunNow, {
        id: heartbeatId,
        idempotencyKey: crypto.randomUUID()
      }) as Promise<AssistantHeartbeatRun>,
    history: (heartbeatId?: string) =>
      ipcRenderer.invoke(ipcChannels.heartbeatsHistory, {
        configId: heartbeatId,
        limit: 200
      }) as Promise<{
        runs: AssistantHeartbeatRun[]
        entries: AssistantHeartbeatEntry[]
      }>
  },
  experts: {
    list: () =>
      ipcRenderer.invoke(
        ipcChannels.expertsList
      ) as Promise<AssistantExpert[]>,
    create: (input: ExpertCreateInput) =>
      ipcRenderer.invoke(
        ipcChannels.expertsCreate,
        input
      ) as Promise<AssistantExpert>
  },
  capabilities: {
    getSnapshot: () =>
      ipcRenderer.invoke(
        ipcChannels.capabilitiesSnapshot
      ) as Promise<CapabilitySnapshot>,
    importSkill: () =>
      ipcRenderer.invoke(
        ipcChannels.capabilitiesImportSkill
      ) as Promise<CapabilitySnapshot>,
    removeSkill: (skillId) =>
      ipcRenderer.invoke(
        ipcChannels.capabilitiesRemoveSkill,
        skillId
      ) as Promise<CapabilitySnapshot>,
    setSkillEnabled: (skillId, enabled) =>
      ipcRenderer.invoke(ipcChannels.capabilitiesToggleSkill, {
        skillId,
        enabled
      }) as Promise<CapabilitySnapshot>,
    setSkillAssignments: (skillId, assignments) =>
      ipcRenderer.invoke(ipcChannels.capabilitiesAssignSkill, {
        skillId,
        assignments
      }) as Promise<CapabilitySnapshot>,
    saveMcpServer: (serverId, input) =>
      ipcRenderer.invoke(ipcChannels.capabilitiesSaveMcp, {
        serverId,
        input
      }) as Promise<CapabilitySnapshot>,
    removeMcpServer: (serverId) =>
      ipcRenderer.invoke(
        ipcChannels.capabilitiesRemoveMcp,
        serverId
      ) as Promise<CapabilitySnapshot>,
    testMcpServer: (serverId) =>
      ipcRenderer.invoke(
        ipcChannels.capabilitiesTestMcp,
        serverId
      ) as Promise<McpServerTestResult>
  },
  context: {
    selectFiles: () =>
      ipcRenderer.invoke(
        ipcChannels.contextSelectFiles
      ) as Promise<ContextAttachment[]>,
    captureScreen: () =>
      ipcRenderer.invoke(
        ipcChannels.contextCaptureScreen
      ) as Promise<ContextAttachment>,
    captureWindow: () =>
      ipcRenderer.invoke(
        ipcChannels.contextCaptureWindow
      ) as Promise<ContextAttachment>,
    readClipboard: () =>
      ipcRenderer.invoke(
        ipcChannels.contextReadClipboard
      ) as Promise<ContextAttachment>,
    remove: async (contextId: string) => {
      await ipcRenderer.invoke(ipcChannels.contextRemove, contextId)
    }
  },
  knowledge: {
    getSnapshot: (libraryId?: string) =>
      ipcRenderer.invoke(
        ipcChannels.knowledgeSnapshot,
        libraryId
      ) as Promise<KnowledgeSnapshot>,
    createLibrary: (input) =>
      ipcRenderer.invoke(
        ipcChannels.knowledgeCreateLibrary,
        input
      ) as Promise<KnowledgeLibrary>,
    updateLibrary: async (libraryId, update) => {
      await ipcRenderer.invoke(ipcChannels.knowledgeUpdateLibrary, {
        libraryId,
        ...update
      })
    },
    deleteLibrary: async (libraryId) => {
      await ipcRenderer.invoke(
        ipcChannels.knowledgeDeleteLibrary,
        libraryId
      )
    },
    selectFiles: async (libraryId, graphStrategy) => {
      await ipcRenderer.invoke(ipcChannels.knowledgeSelectFiles, {
        libraryId,
        graphStrategy
      })
    },
    selectDirectory: async (libraryId, graphStrategy) => {
      await ipcRenderer.invoke(
        ipcChannels.knowledgeSelectDirectory,
        { libraryId, graphStrategy }
      )
    },
    importDroppedFiles: async (libraryId, files, graphStrategy) => {
      const paths = files
        .map((file) => webUtils.getPathForFile(file))
        .filter(Boolean)
      await ipcRenderer.invoke(ipcChannels.knowledgeImportPaths, {
        libraryId,
        paths,
        graphStrategy
      })
    },
    importUrl: async (libraryId, url, graphStrategy) => {
      await ipcRenderer.invoke(ipcChannels.knowledgeImportUrl, {
        libraryId,
        url,
        graphStrategy
      })
    },
    syncSource: async (sourceId) => {
      await ipcRenderer.invoke(ipcChannels.knowledgeSyncSource, sourceId)
    },
    pauseSource: async (sourceId) => {
      await ipcRenderer.invoke(ipcChannels.knowledgePauseSource, sourceId)
    },
    retrySource: async (sourceId) => {
      await ipcRenderer.invoke(ipcChannels.knowledgeRetrySource, sourceId)
    },
    removeSource: async (sourceId) => {
      await ipcRenderer.invoke(ipcChannels.knowledgeRemoveSource, sourceId)
    },
    search: (libraryIds, query) =>
      ipcRenderer.invoke(ipcChannels.knowledgeSearch, {
        libraryIds,
        query
      }) as Promise<KnowledgeSearchReference[]>,
    createEntity: async (libraryId, input) => {
      await ipcRenderer.invoke(ipcChannels.knowledgeCreateEntity, {
        libraryId,
        input
      })
    },
    updateEntity: async (entityId, update) => {
      await ipcRenderer.invoke(ipcChannels.knowledgeUpdateEntity, {
        entityId,
        update
      })
    },
    moveEntity: async (entityId, position) => {
      await ipcRenderer.invoke(ipcChannels.knowledgeMoveEntity, {
        entityId,
        position
      })
    },
    deleteEntity: async (entityId) => {
      await ipcRenderer.invoke(ipcChannels.knowledgeDeleteEntity, entityId)
    },
    mergeEntities: async (sourceEntityId, targetEntityId) => {
      await ipcRenderer.invoke(ipcChannels.knowledgeMergeEntities, {
        sourceEntityId,
        targetEntityId
      })
    },
    createRelation: async (libraryId, input) => {
      await ipcRenderer.invoke(ipcChannels.knowledgeCreateRelation, {
        libraryId,
        input
      })
    },
    updateRelation: async (relationId, input) => {
      await ipcRenderer.invoke(ipcChannels.knowledgeUpdateRelation, {
        relationId,
        input
      })
    },
    deleteRelation: async (relationId) => {
      await ipcRenderer.invoke(
        ipcChannels.knowledgeDeleteRelation,
        relationId
      )
    }
  }
}

contextBridge.exposeInMainWorld('goodbuddy', desktopApi)

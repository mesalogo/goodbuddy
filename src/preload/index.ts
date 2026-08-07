import { contextBridge, ipcRenderer, webUtils } from 'electron'
import {
  type ApprovalDecision,
  type AgentEvent,
  type AgentQuestionAnswer,
  type AgentRequest,
  type AgentRuntimeDetection,
  type AgentRuntimeStatus,
  type AppInfo,
  type BrowserLiveState,
  type ContextAttachment,
  type DesktopApi,
  type KnowledgeLibrary,
  type KnowledgeSearchReference,
  type KnowledgeSnapshot,
  type RuntimeSettings,
  type RuntimeSettingsInput,
  type RuntimeConfigActionInput,
  type RuntimeFileSelectionKind,
  type WindowCaptureOption
} from '../shared/contracts'
import { ipcChannels } from '../shared/ipc-channels'
import type {
  BrowserProfileCreateInput,
  BrowserProfileRenameInput,
  CapabilityDiagnosticReport,
  CapabilitySnapshot,
  ComputerCapabilityId,
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
  ExpertCreateInput,
  ExpertUpdateInput
} from '../shared/assistant-contracts'
import type {
  ChannelConnectionTestResult,
  ChannelSettingsApply,
  ChannelSettingsSnapshot,
  DingTalkChannelSettingsInput,
  ManagedChannel,
  WeComChannelSettingsInput
} from '../shared/channel-settings-contracts'
import type {
  ApplicationSettings,
  VersionCheckResult
} from '../shared/application-settings-contracts'
import type {
  SpeechModelSnapshot,
  SpeechTranscriptionInput,
  SpeechTranscriptionResult
} from '../shared/speech-model-contracts'
import type {
  EmbeddingDiagnosticResult,
  EmbeddingIndexStatus,
  EmbeddingSettingsSnapshot
} from '../shared/embedding-contracts'
import type { AgentRuntimeSelection } from '../shared/runtime-selection-contracts'

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
    getStatus: (selection) =>
      ipcRenderer.invoke(
        ipcChannels.agentStatus,
        selection
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
    respondQuestion: async (
      questionId: string,
      answers?: AgentQuestionAnswer[]
    ) => {
      await ipcRenderer.invoke(ipcChannels.agentQuestionRespond, {
        questionId,
        answers: answers ?? []
      })
    },
    onEvent: (listener) => {
      const handler = (_event: Electron.IpcRendererEvent, payload: AgentEvent): void =>
        listener(payload)
      ipcRenderer.on(ipcChannels.agentEvent, handler)
      return () => ipcRenderer.removeListener(ipcChannels.agentEvent, handler)
    }
  },
  browser: {
    interact: async (conversationId: string) => {
      await ipcRenderer.invoke(
        ipcChannels.browserInteract,
        { conversationId }
      )
    },
    stop: async (conversationId: string) => {
      await ipcRenderer.invoke(
        ipcChannels.browserStop,
        { conversationId }
      )
    },
    onState: (listener) => {
      const handler = (
        _event: Electron.IpcRendererEvent,
        payload: BrowserLiveState
      ): void => listener(payload)
      ipcRenderer.on(ipcChannels.browserState, handler)
      return () =>
        ipcRenderer.removeListener(ipcChannels.browserState, handler)
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
    openRuntimeConfig: async (input: RuntimeConfigActionInput) => {
      await ipcRenderer.invoke(
        ipcChannels.runtimeSettingsOpenConfig,
        input
      )
    },
    testModelConnection: (profileId: string) =>
      ipcRenderer.invoke(
        ipcChannels.runtimeSettingsTestModel,
        profileId
      ) as Promise<AgentRuntimeStatus>,
    testRuntime: (selection: AgentRuntimeSelection) =>
      ipcRenderer.invoke(
        ipcChannels.runtimeSettingsTest,
        selection
      ) as Promise<AgentRuntimeStatus>
  },
  channels: {
    getSnapshot: () =>
      ipcRenderer.invoke(
        ipcChannels.channelSettingsGet
      ) as Promise<ChannelSettingsSnapshot>,
    apply: (input: ChannelSettingsApply) =>
      ipcRenderer.invoke(
        ipcChannels.channelSettingsApply,
        input
      ) as Promise<ChannelSettingsSnapshot>,
    testConnection: (
      channel: ManagedChannel,
      settings?: WeComChannelSettingsInput | DingTalkChannelSettingsInput
    ) =>
      ipcRenderer.invoke(ipcChannels.channelSettingsTest, {
        channel,
        settings
      }) as Promise<ChannelConnectionTestResult>
  },
  updates: {
    getSettings: () =>
      ipcRenderer.invoke(
        ipcChannels.applicationSettingsGet
      ) as Promise<ApplicationSettings>,
    updateSettings: (input: ApplicationSettings) =>
      ipcRenderer.invoke(
        ipcChannels.applicationSettingsUpdate,
        input
      ) as Promise<ApplicationSettings>,
    check: () =>
      ipcRenderer.invoke(
        ipcChannels.versionCheck
      ) as Promise<VersionCheckResult>,
    openReleasePage: async () => {
      await ipcRenderer.invoke(ipcChannels.versionOpenReleasePage)
    },
    onResult: (listener) => {
      const handler = (
        _event: Electron.IpcRendererEvent,
        result: VersionCheckResult
      ): void => listener(result)
      ipcRenderer.on(ipcChannels.versionCheckResult, handler)
      return () =>
        ipcRenderer.removeListener(ipcChannels.versionCheckResult, handler)
    }
  },
  speechModels: {
    getSnapshot: () =>
      ipcRenderer.invoke(
        ipcChannels.speechModelsGet
      ) as Promise<SpeechModelSnapshot>,
    install: (modelId: string) =>
      ipcRenderer.invoke(
        ipcChannels.speechModelsInstall,
        { modelId }
      ) as Promise<SpeechModelSnapshot>,
    cancel: (modelId: string) =>
      ipcRenderer.invoke(
        ipcChannels.speechModelsCancel,
        { modelId }
      ) as Promise<boolean>,
    remove: (modelId: string) =>
      ipcRenderer.invoke(
        ipcChannels.speechModelsRemove,
        { modelId }
      ) as Promise<SpeechModelSnapshot>,
    select: (modelId: string | null) =>
      ipcRenderer.invoke(
        ipcChannels.speechModelsSelect,
        { modelId }
      ) as Promise<SpeechModelSnapshot>,
    importLocalDirectory: (modelId: string) =>
      ipcRenderer.invoke(
        ipcChannels.speechModelsImportLocal,
        { modelId }
      ) as Promise<SpeechModelSnapshot | undefined>,
    openRepository: async (modelId: string) => {
      await ipcRenderer.invoke(
        ipcChannels.speechModelsOpenRepository,
        { modelId }
      )
    },
    openModelsDirectory: async () => {
      await ipcRenderer.invoke(ipcChannels.speechModelsOpenDirectory)
    }
  },
  speech: {
    transcribe: (input: SpeechTranscriptionInput) =>
      ipcRenderer.invoke(
        ipcChannels.speechTranscribe,
        input
      ) as Promise<SpeechTranscriptionResult>,
    cancel: (requestId: string) =>
      ipcRenderer.invoke(
        ipcChannels.speechTranscriptionCancel,
        requestId
      ) as Promise<boolean>
  },
  embeddings: {
    getSnapshot: () =>
      ipcRenderer.invoke(
        ipcChannels.embeddingSettingsGet
      ) as Promise<EmbeddingSettingsSnapshot>,
    diagnose: () =>
      ipcRenderer.invoke(
        ipcChannels.embeddingDiagnose
      ) as Promise<EmbeddingDiagnosticResult>,
    rebuild: () =>
      ipcRenderer.invoke(
        ipcChannels.embeddingIndexRebuild
      ) as Promise<EmbeddingIndexStatus>,
    cancel: (jobId: string) =>
      ipcRenderer.invoke(
        ipcChannels.embeddingIndexCancel,
        { jobId }
      ) as Promise<boolean>,
    onStatus: (listener) => {
      const handler = (
        _event: Electron.IpcRendererEvent,
        status: EmbeddingIndexStatus
      ): void => listener(status)
      ipcRenderer.on(ipcChannels.embeddingIndexStatusChanged, handler)
      return () =>
        ipcRenderer.removeListener(
          ipcChannels.embeddingIndexStatusChanged,
          handler
        )
    }
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
    },
    delete: async (projectId: string, confirmation: string) => {
      await ipcRenderer.invoke(ipcChannels.projectsDelete, {
        projectId,
        confirmation
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
      }) as Promise<WorkspaceFilePreview>,
    openPath: async (
      projectId: string,
      path: string,
      type: 'file' | 'directory'
    ) => {
      await ipcRenderer.invoke(ipcChannels.workspacePathOpen, {
        projectId,
        path,
        type
      })
    }
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
      ) as Promise<AssistantExpert>,
    update: (expertId: string, input: ExpertUpdateInput) =>
      ipcRenderer.invoke(ipcChannels.expertsUpdate, {
        expertId,
        input
      }) as Promise<AssistantExpert>,
    remove: async (expertId: string) => {
      await ipcRenderer.invoke(ipcChannels.expertsRemove, expertId)
    }
  },
  capabilities: {
    getSnapshot: () =>
      ipcRenderer.invoke(
        ipcChannels.capabilitiesSnapshot
      ) as Promise<CapabilitySnapshot>,
    importSkill: (kind) =>
      ipcRenderer.invoke(
        ipcChannels.capabilitiesImportSkill,
        kind
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
      ) as Promise<McpServerTestResult>,
    setComputerCapabilityEnabled: (
      capabilityId: ComputerCapabilityId,
      enabled: boolean
    ) =>
      ipcRenderer.invoke(ipcChannels.capabilitiesToggleComputer, {
        capabilityId,
        enabled
      }) as Promise<CapabilitySnapshot>,
    setComputerCapabilityBrowserProfile: (
      capabilityId: ComputerCapabilityId,
      browserProfileId: string | null
    ) =>
      ipcRenderer.invoke(ipcChannels.capabilitiesConfigureComputer, {
        capabilityId,
        browserProfileId
      }) as Promise<CapabilitySnapshot>,
    diagnoseComputerCapability: (capabilityId: ComputerCapabilityId) =>
      ipcRenderer.invoke(
        ipcChannels.capabilitiesDiagnoseComputer,
        capabilityId
      ) as Promise<CapabilityDiagnosticReport>,
    createBrowserProfile: (input: BrowserProfileCreateInput) =>
      ipcRenderer.invoke(
        ipcChannels.capabilitiesCreateBrowserProfile,
        input
      ) as Promise<CapabilitySnapshot>,
    renameBrowserProfile: (input: BrowserProfileRenameInput) =>
      ipcRenderer.invoke(
        ipcChannels.capabilitiesRenameBrowserProfile,
        input
      ) as Promise<CapabilitySnapshot>,
    setDefaultBrowserProfile: (profileId: string) =>
      ipcRenderer.invoke(ipcChannels.capabilitiesDefaultBrowserProfile, {
        profileId
      }) as Promise<CapabilitySnapshot>,
    removeBrowserProfile: (profileId: string) =>
      ipcRenderer.invoke(ipcChannels.capabilitiesRemoveBrowserProfile, {
        profileId
      }) as Promise<CapabilitySnapshot>
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
    listWindows: () =>
      ipcRenderer.invoke(
        ipcChannels.contextListWindows
      ) as Promise<WindowCaptureOption[]>,
    captureWindow: (sourceId) =>
      ipcRenderer.invoke(
        ipcChannels.contextCaptureWindow,
        { sourceId }
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

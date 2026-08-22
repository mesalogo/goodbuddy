import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
  waitFor
} from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  AgentEvent,
  BrowserLiveState,
  ContextAttachment,
  ConversationQueueDispatch,
  DesktopApi
} from '../../shared/contracts'
import type { ApplicationSettings } from '../../shared/application-settings-contracts'
import type { GlobalShortcutSettingsSnapshot } from '../../shared/shortcut'
import type {
  AssistantProject,
  AssistantSchedule,
  AssistantTask,
  ConversationSnapshot
} from '../../shared/assistant-contracts'
import {
  builtInDefaultProjectSeedDescription,
  builtInDefaultProjectSeedName
} from '../../shared/assistant-contracts'
import { agentRuntimeSelectionKey } from '../../shared/runtime-selection-contracts'

const speechRecognitionMocks = vi.hoisted(() => ({
  startPcmRecording: vi.fn()
}))

const lazyRouteMocks = vi.hoisted(() => {
  let pending: Promise<void> | undefined
  let releasePending: (() => void) | undefined
  return {
    suspendKnowledgeRoute(): void {
      pending = new Promise((resolve) => {
        releasePending = resolve
      })
    },
    releaseKnowledgeRoute(): void {
      releasePending?.()
      releasePending = undefined
      pending = undefined
    },
    async waitForKnowledgeRoute(): Promise<void> {
      await pending
    }
  }
})

const routeModuleLoads = vi.hoisted(() => ({
  activity: 0,
  heartbeat: 0,
  knowledge: 0,
  magicNotes: 0,
  settings: 0
}))

vi.mock('./speech-recognition', async (importOriginal) => ({
  ...(await importOriginal<
    typeof import('./speech-recognition')
  >()),
  startPcmRecording: speechRecognitionMocks.startPcmRecording
}))

vi.mock('./KnowledgeWorkspace', async (importOriginal) => {
  await lazyRouteMocks.waitForKnowledgeRoute()
  routeModuleLoads.knowledge += 1
  return importOriginal<typeof import('./KnowledgeWorkspace')>()
})

vi.mock('./HeartbeatCenter', async (importOriginal) => {
  routeModuleLoads.heartbeat += 1
  return importOriginal<typeof import('./HeartbeatCenter')>()
})

vi.mock('./MagicNotesWorkspace', async (importOriginal) => {
  routeModuleLoads.magicNotes += 1
  return importOriginal<typeof import('./MagicNotesWorkspace')>()
})

vi.mock('./SettingsPanel', async (importOriginal) => {
  routeModuleLoads.settings += 1
  return importOriginal<typeof import('./SettingsPanel')>()
})

vi.mock('./ActivityPanel', async (importOriginal) => {
  routeModuleLoads.activity += 1
  return importOriginal<typeof import('./ActivityPanel')>()
})

import App from './App'
import { loadActivityRecords } from './activity-store'
import { changeUiLocale } from './i18n'
import { UiLocaleProvider } from './i18n/UiLocaleProvider'

let agentListener: ((event: AgentEvent) => void) | undefined
let browserListener: ((state: BrowserLiveState) => void) | undefined
let fileSelectionProgressListener:
  | Parameters<
      DesktopApi['context']['onFileSelectionProgress']
    >[0]
  | undefined
let newConversationListener: (() => void) | undefined
let magicTodoStatusChangedListener: (() => void) | undefined
let maximizedChangedListener: ((maximized: boolean) => void) | undefined
let beforeQuitListener: (() => Promise<void>) | undefined
let conversationQueueDispatchListener:
  | ((dispatch: ConversationQueueDispatch) => void)
  | undefined
let conversationQueueChangeListener:
  | Parameters<
      DesktopApi['conversationQueue']['onChanged']
    >[0]
  | undefined
const removeMaximizedChangedListener = vi.fn()
const run = vi.fn<DesktopApi['agent']['run']>()
const modelProfileId = '00000000-0000-4000-8000-000000000001'
const projectId = '00000000-0000-4000-8000-000000000101'
const project = {
  id: projectId,
  name: builtInDefaultProjectSeedName,
  description: builtInDefaultProjectSeedDescription,
  rootPath: 'C:\\Users\\test',
  defaultWorkMode: 'ask' as const,
  kind: 'user' as const,
  builtInDefault: true,
  status: 'active' as const,
  createdAt: '2026-07-31T00:00:00.000Z',
  updatedAt: '2026-07-31T00:00:00.000Z'
}

const api: DesktopApi = {
  app: {
    getInfo: vi.fn(async () => ({
      name: 'GoodBuddy',
      version: '0.1.0',
      platform: 'win32',
      arch: 'x64',
      shortcut: 'Ctrl+Shift+Space'
    })),
    show: vi.fn(async () => {}),
    hide: vi.fn(async () => {}),
    minimize: vi.fn(async () => {}),
    toggleMaximize: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    isMaximized: vi.fn(async () => false),
    onMaximizedChanged: vi.fn((listener) => {
      maximizedChangedListener = listener
      return removeMaximizedChangedListener
    }),
    onBeforeQuit: vi.fn((listener) => {
      beforeQuitListener = listener
      return () => {
        beforeQuitListener = undefined
      }
    }),
    clearLocalData: vi.fn(async () => {}),
    onNewConversation: vi.fn((listener) => {
      newConversationListener = listener
      return () => {
        newConversationListener = undefined
      }
    }),
    onOpenSettings: vi.fn(() => () => {})
  },
  agent: {
    getStatus: vi.fn<DesktopApi['agent']['getStatus']>(async () => ({
      id: 'model' as const,
      label: 'sonnet-5',
      available: true,
      supportsToolExecution: true,
      detail: 'Ready'
    })),
    run,
    cancel: vi.fn(async () => {}),
    respondApproval: vi.fn(async () => {}),
    respondQuestion: vi.fn(async () => {}),
    compactConversation: vi.fn(async () => ({
      provider: 'continue' as const,
      strategy: 'goodbuddy-summary' as const,
      compacted: false,
      detail: 'No context to compact'
    })),
    onEvent: vi.fn((listener) => {
      agentListener = listener
      return () => {
        agentListener = undefined
      }
    })
  },
  browser: {
    interact: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
    onState: vi.fn((listener) => {
      browserListener = listener
      return () => {
        browserListener = undefined
      }
    })
  },
  speech: {
    transcribe: vi.fn(async () => ({ text: '本地语音结果' })),
    cancel: vi.fn(async () => true)
  },
  settings: {
    getRuntime: vi.fn<DesktopApi['settings']['getRuntime']>(async () => ({
      provider: 'auto',
      modelBaseUrl: 'https://bigtoken.ai',
      modelName: 'sonnet-5',
      modelProtocol: 'anthropic-messages',
      modelAuthentication: 'api-key',
      imageGenerationQuality: 'auto',
      opencodeBaseUrl: '',
      opencodeEmbedded: false,
      opencodeBinaryPath: '',
      opencodeConfigPath: '',
      continueBinaryPath: '',
      continueConfigPath: '',
      continueMode: 'chat',
      subagentSmartRoutingEnabled: false,
      knowledgeEmbeddingEnabled: false,
      knowledgeEmbeddingBaseUrl:
        'http://127.0.0.1:11434/v1/embeddings',
      knowledgeEmbeddingModel: 'nomic-embed-text',
      knowledgeEmbeddingApiKeyConfigured: false,
      knowledgeEmbeddingCredentialSource: 'none',
      workspacePath: 'C:\\Users\\test',
      apiKeyConfigured: false,
      credentialSource: 'none',
      modelProfiles: [
        {
          id: modelProfileId,
          name: '默认模型',
          baseUrl: 'https://bigtoken.ai',
          modelName: 'sonnet-5',
          protocol: 'anthropic-messages',
          authentication: 'api-key',
          imageGenerationQuality: 'auto',
          apiKeyConfigured: false,
          credentialSource: 'none'
        }
      ],
      defaultModelProfileId: modelProfileId,
      opencodeModelSource: {
        kind: 'profile',
        profileId: modelProfileId
      },
      continueModelSource: {
        kind: 'profile',
        profileId: modelProfileId
      },
      secureStorageAvailable: true,
      toolApproval: 'always'
    })),
    updateRuntime: vi.fn<DesktopApi['settings']['updateRuntime']>(
      async (input) => ({
        provider: input.provider,
        modelBaseUrl: input.modelBaseUrl,
        modelName: input.modelName,
        modelProtocol: input.modelProtocol,
        modelAuthentication: input.modelAuthentication,
        imageGenerationQuality: input.imageGenerationQuality,
        opencodeBaseUrl: input.opencodeBaseUrl,
        opencodeEmbedded: input.opencodeEmbedded,
        opencodeBinaryPath: input.opencodeBinaryPath,
        opencodeConfigPath: input.opencodeConfigPath,
        continueBinaryPath: input.continueBinaryPath,
        continueConfigPath: input.continueConfigPath,
        continueMode: input.continueMode,
        subagentSmartRoutingEnabled:
          input.subagentSmartRoutingEnabled ?? false,
        knowledgeEmbeddingEnabled: input.knowledgeEmbeddingEnabled,
        knowledgeEmbeddingBaseUrl: input.knowledgeEmbeddingBaseUrl,
        knowledgeEmbeddingModel: input.knowledgeEmbeddingModel,
        knowledgeEmbeddingApiKeyConfigured:
          input.knowledgeEmbeddingApiKey?.action === 'replace',
        knowledgeEmbeddingCredentialSource:
          input.knowledgeEmbeddingApiKey?.action === 'replace'
            ? 'encrypted'
            : 'none',
        workspacePath: input.workspacePath,
        apiKeyConfigured: input.apiKey.action === 'replace',
        credentialSource:
          input.apiKey.action === 'replace' ? 'encrypted' : 'none',
        modelProfiles: (
          input.modelProfiles ?? [
            {
              id: modelProfileId,
              name: '默认模型',
              baseUrl: input.modelBaseUrl,
              modelName: input.modelName,
              protocol: input.modelProtocol,
              authentication: input.modelAuthentication,
              imageGenerationQuality:
                input.imageGenerationQuality,
              apiKey: input.apiKey
            }
          ]
        ).map(({ apiKey, ...profile }) => ({
          ...profile,
          apiKeyConfigured: apiKey.action === 'replace',
          credentialSource:
            apiKey.action === 'replace'
              ? ('encrypted' as const)
              : ('none' as const)
        })),
        defaultModelProfileId:
          input.defaultModelProfileId ?? modelProfileId,
        opencodeModelSource:
          input.opencodeModelSource ?? { kind: 'platform' },
        continueModelSource:
          input.continueModelSource ?? { kind: 'platform' },
        secureStorageAvailable: true,
        toolApproval: input.toolApproval
      })
    ),
    selectWorkspace: vi.fn(async () => undefined),
    detectAgentRuntimes: vi.fn<
      DesktopApi['settings']['detectAgentRuntimes']
    >(async () => ({
      opencode: {
        available: false,
        detail: '未检测到 OpenCode'
      },
      continue: {
        available: false,
        detail: '未检测到 Continue'
      },
      deepseekHarness: {
        available: true,
        path: 'bundled://deepseek-harness',
        detail: 'Bundled Harness Adapter ready'
      }
    })),
    selectRuntimeFile: vi.fn(async () => undefined),
    openRuntimeConfig: vi.fn(async () => {}),
    testModelConnection: vi.fn<
      DesktopApi['settings']['testModelConnection']
    >(async () => ({
      id: 'model',
      label: 'sonnet-5',
      available: true,
      supportsToolExecution: true,
      detail: 'Ready'
    })),
    testRuntime: vi.fn<DesktopApi['settings']['testRuntime']>(
      async () => ({
        id: 'model',
        label: 'sonnet-5',
        available: true,
        supportsToolExecution: true,
        detail: 'Ready'
      })
    )
  },
  projects: {
    list: vi.fn(async () => [project]),
    create: vi.fn(async (input) => ({
      ...project,
      ...input,
      id: crypto.randomUUID()
    })),
    update: vi.fn(async (_projectId, input) => ({
      ...project,
      ...input,
      id: _projectId
    })),
    setArchived: vi.fn(async () => {}),
    delete: vi.fn(async () => {})
  },
  conversations: {
    list: vi.fn(async () => []),
    replace: vi.fn(async () => {}),
    saveLocal: vi.fn(async () => {}),
    branchLocal: vi.fn(async (input) => ({
      id: crypto.randomUUID(),
      branch: {
        sourceConversationId: input.sourceConversationId,
        sourceTitle: '新对话'
      },
      title: input.title,
      updatedAt: Date.now(),
      messages: []
    })),
    deleteLocal: vi.fn(async () => true),
    onChanged: vi.fn(() => () => undefined)
  },
  conversationQueue: {
    list: vi.fn(async () => []),
    enqueueUser: vi.fn(async (input) => {
      const item = {
        id: crypto.randomUUID(),
        conversationId: input.conversationId,
        source: 'user' as const,
        label: input.prompt,
        createdAt: '2026-07-31T00:00:00.000Z'
      }
      queueMicrotask(() =>
        conversationQueueDispatchListener?.({ item, input })
      )
      return item
    }),
    remove: vi.fn(async () => {}),
    interruptAndRun: vi.fn(async () => {}),
    releaseUser: vi.fn(async () => {}),
    ready: vi.fn(async () => {}),
    onChanged: vi.fn((listener) => {
      conversationQueueChangeListener = listener
      return () => {
        conversationQueueChangeListener = undefined
      }
    }),
    onDispatch: vi.fn((listener) => {
      conversationQueueDispatchListener = listener
      return () => {
        conversationQueueDispatchListener = undefined
      }
    })
  },
  workspace: {
    getChanges: vi.fn(async () => ({
      rootPath: 'C:\\Workspace',
      available: true,
      status: '',
      patch: '',
      files: [],
      truncated: false
    })),
    listDirectory: vi.fn(async (path: string) => ({
      path,
      entries: [],
      truncated: false
    })),
    readFile: vi.fn(async (path: string) => ({
      path,
      name: path.split('/').at(-1) ?? path,
      content: '',
      mimeType: 'text/plain' as const,
      size: 0
    })),
    openPath: vi.fn(async () => {})
  },
  tasks: {
    list: vi.fn(async () => []),
    setStatus: vi.fn(async () => {})
  },
  usage: {
    getTokenSummary: vi.fn(async () => ({
      totals: {
        callCount: 0,
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0
      },
      records: []
    }))
  },
  artifacts: {
    list: vi.fn(async () => []),
    get: vi.fn(async () => {
      throw new Error('Artifact not found')
    }),
    importFiles: vi.fn(async () => [])
  },
  memory: {
    list: vi.fn(async () => []),
    create: vi.fn(async (input) => ({
      ...input,
      id: crypto.randomUUID(),
      confidence: 1,
      salience: 1,
      status: 'confirmed' as const,
      createdAt: '2026-07-31T00:00:00.000Z',
      updatedAt: '2026-07-31T00:00:00.000Z'
    })),
    setStatus: vi.fn(async () => {}),
    remove: vi.fn(async () => {})
  },
  schedules: {
    list: vi.fn(async () => []),
    create: vi.fn(async (input) => ({
      ...input,
      id: crypto.randomUUID(),
      taskId: crypto.randomUUID(),
      conversationId: input.conversationId ?? crypto.randomUUID(),
      enabled: true,
      createdAt: '2026-07-31T00:00:00.000Z',
      updatedAt: '2026-07-31T00:00:00.000Z'
    })),
    setEnabled: vi.fn(async () => {}),
    remove: vi.fn(async () => {}),
    runNow: vi.fn(async () => {})
  },
  heartbeats: {
    list: vi.fn(async () => []),
    create: vi.fn(async (input) => ({
      ...input,
      id: crypto.randomUUID(),
      nextRunAt: '2026-08-01T09:00:00.000Z',
      createdAt: '2026-08-01T00:00:00.000Z',
      updatedAt: '2026-08-01T00:00:00.000Z'
    })),
    update: vi.fn(async (heartbeatId, input) => ({
      ...input,
      id: heartbeatId,
      nextRunAt: '2026-08-01T09:00:00.000Z',
      createdAt: '2026-08-01T00:00:00.000Z',
      updatedAt: '2026-08-01T00:00:00.000Z'
    })),
    setPaused: vi.fn(async () => {}),
    remove: vi.fn(async () => {}),
    runNow: vi.fn(async (heartbeatId) => ({
      id: crypto.randomUUID(),
      configId: heartbeatId,
      trigger: 'manual' as const,
      scheduledFor: '2026-08-01T00:00:00.000Z',
      status: 'completed' as const,
      attemptCount: 1,
      createdAt: '2026-08-01T00:00:00.000Z',
      updatedAt: '2026-08-01T00:00:00.000Z'
    })),
    history: vi.fn(async () => ({ runs: [], entries: [] }))
  },
  experts: {
    list: vi.fn(async () => []),
    create: vi.fn(async (input) => ({
      ...input,
      id: crypto.randomUUID(),
      enabled: true,
      createdAt: '2026-07-31T00:00:00.000Z',
      updatedAt: '2026-07-31T00:00:00.000Z'
    })),
    update: vi.fn(async (expertId, input) => ({
      ...input,
      id: expertId,
      enabled: true,
      createdAt: '2026-07-31T00:00:00.000Z',
      updatedAt: '2026-08-04T00:00:00.000Z'
    })),
    remove: vi.fn(async () => {})
  },
  capabilities: {
    getSnapshot: vi.fn(async () => ({
      skills: [],
      mcpServers: []
    })),
    importSkill: vi.fn(async () => ({
      skills: [],
      mcpServers: []
    })),
    removeSkill: vi.fn(async () => ({
      skills: [],
      mcpServers: []
    })),
    setSkillEnabled: vi.fn(async () => ({
      skills: [],
      mcpServers: []
    })),
    setSkillAssignments: vi.fn(async () => ({
      skills: [],
      mcpServers: []
    })),
    setBuiltinMcpServerEnabled: vi.fn(async () => ({
      skills: [],
      mcpServers: []
    })),
    setBuiltinMcpServerAssignments: vi.fn(async () => ({
      skills: [],
      mcpServers: []
    })),
    saveMcpServer: vi.fn(async () => ({
      skills: [],
      mcpServers: []
    })),
    removeMcpServer: vi.fn(async () => ({
      skills: [],
      mcpServers: []
    })),
    testMcpServer: vi.fn(async () => ({
      dynamicToolsSupported: false,
      toolCount: 0,
      tools: []
    }))
  },
  runtimeExtensions: {
    getSnapshot: vi.fn(async () => ({
      marketplaceEnabled: false,
      catalog: [],
      installed: []
    })),
    apply: vi.fn(async () => ({
      marketplaceEnabled: false,
      catalog: [],
      installed: []
    }))
  },
  runtimeCustomization: {
    getSettings: vi.fn(async () => ({
      opencode: {},
      continue: { presets: [] }
    })),
    updateSettings: vi.fn(async (settings) => settings),
    getNativeSnapshot: vi.fn(async (input) => ({
      provider: input.provider,
      available: true,
      inventoryStatus: 'available' as const,
      detail: 'Ready',
      agents: [],
      tools: [],
      toolsSupported: input.provider !== 'continue',
      commands: [],
      lsp: [],
      formatters: [],
      mcpServers: [],
      skills: [],
      rules: [],
      prompts: [],
      resources: [],
      resourcesSupported: false,
      context: {
        strategy: 'unsupported' as const,
        manualCompact: false,
        detail: 'Unsupported'
      }
    }))
  },
  context: {
    selectFiles: vi.fn(async () => []),
    onFileSelectionProgress: vi.fn((listener) => {
      fileSelectionProgressListener = listener
      return () => {
        fileSelectionProgressListener = undefined
      }
    }),
    addPastedImage: vi.fn(async () => {
      throw new Error('not used')
    }),
    captureScreen: vi.fn(async () => {
      throw new Error('not used')
    }),
    listWindows: vi.fn(async () => []),
    captureWindow: vi.fn(async () => {
      throw new Error('not used')
    }),
    readClipboard: vi.fn(async () => {
      throw new Error('not used')
    }),
    remove: vi.fn(async () => {})
  },
  magicNotes: {
    list: vi.fn(async () => ({ notes: [] })),
    get: vi.fn(async () => {
      throw new Error('not used')
    }),
    create: vi.fn(async () => {
      throw new Error('not used')
    }),
    update: vi.fn(async () => {
      throw new Error('not used')
    }),
    remove: vi.fn(async () => {}),
    createEntry: vi.fn(async () => {
      throw new Error('not used')
    }),
    updateEntry: vi.fn(async () => {
      throw new Error('not used')
    }),
    removeEntry: vi.fn(async () => {
      throw new Error('not used')
    }),
    analyze: vi.fn(async () => {
      throw new Error('not used')
    }),
    analyzeDraft: vi.fn(async () => {
      throw new Error('not used')
    }),
    listTodos: vi.fn(async () => ({ todos: [] })),
    getTodoStatus: vi.fn(async () => ({ incompleteCount: 0 })),
    updateTodo: vi.fn(async () => {
      throw new Error('not used')
    }),
    analyzeTodo: vi.fn(async () => {
      throw new Error('not used')
    }),
    onAnalysisEvent: vi.fn(() => vi.fn()),
    onTodoStatusChanged: vi.fn((listener) => {
      magicTodoStatusChangedListener = listener
      return () => {
        magicTodoStatusChangedListener = undefined
      }
    })
  },
  knowledge: {
    getSnapshot: vi.fn(async () => ({
      libraries: [],
      sources: [],
      documents: [],
      graphNodes: [],
      graphRelations: [],
      evidence: []
    })),
    createLibrary: vi.fn(async (input) => ({
      ...input,
      id: crypto.randomUUID(),
      sourceCount: 0,
      documentCount: 0,
      indexedDocumentCount: 0
    })),
    updateLibrary: vi.fn(async () => {}),
    deleteLibrary: vi.fn(async () => {}),
    reextractGraph: vi.fn(async () => {}),
    selectFiles: vi.fn(async () => {}),
    selectDirectory: vi.fn(async () => {}),
    importDroppedFiles: vi.fn(async () => {}),
    importUrl: vi.fn(async () => {}),
    syncSource: vi.fn(async () => {}),
    pauseSource: vi.fn(async () => {}),
    retrySource: vi.fn(async () => {}),
    removeSource: vi.fn(async () => {}),
    search: vi.fn(async () => []),
    retrieve: vi.fn(async (input) => ({
      query: input.query,
      durationMs: 0,
      settings: input.settings ?? {
        version: 1,
        topK: 6,
        minimumVectorSimilarity: 0,
        ftsWeight: 1,
        vectorWeight: 1,
        graphWeight: 0.8,
        candidateMultiplier: 4,
        contextMaxCharacters: 16_000,
        adjacentChunkCount: 0,
        localRerankEnabled: false,
        rerankMode: 'none'
      },
      diagnostics: {
        requestedChannels: [],
        usedChannels: [],
        degradedChannels: [],
        candidateCounts: {},
        channelDurationMs: {},
        vectorScannedCount: 0,
        filteredByThresholdCount: 0,
        filteredByBudgetCount: 0,
        rerank: {
          requested: 'none' as const,
          used: 'none' as const,
          status: 'skipped' as const,
          candidateCount: 0,
          durationMs: 0
        }
      },
      results: [],
      context: {
        characterCount: 0,
        truncated: false,
        groups: []
      }
    })),
    updateSettings: vi.fn(async () => {
      throw new Error('not used')
    }),
    listChunks: vi.fn(async () => ({
      items: [],
      page: 1,
      pageSize: 50,
      totalItems: 0
    })),
    updateChunk: vi.fn(async () => {}),
    deleteChunk: vi.fn(async () => {}),
    rebuildDocument: vi.fn(async () => ({
      libraries: [],
      sources: [],
      documents: [],
      graphNodes: [],
      graphRelations: [],
      evidence: []
    })),
    rebuildLibrary: vi.fn(async () => ({
      rebuilt: 0,
      failed: 0
    })),
    cancelRebuild: vi.fn(async () => true),
    getEmbeddingIndex: vi.fn(async (knowledgeBaseId: string) => ({
      knowledgeBaseId,
      enabled: false,
      coverage: { total: 0, indexed: 0, missing: 0, error: 0 },
      indexStatus: { job: null }
    })),
    rebuildEmbeddingIndex: vi.fn(async (knowledgeBaseId: string) => ({
      knowledgeBaseId,
      enabled: false,
      coverage: { total: 0, indexed: 0, missing: 0, error: 0 },
      indexStatus: { job: null }
    })),
    cancelEmbeddingIndex: vi.fn(async () => false),
    cancelTask: vi.fn(async () => false),
    retryTask: vi.fn(async () => {}),
    getReferenceContext: vi.fn(async () => {
      throw new Error('not used')
    }),
    openReferenceSource: vi.fn(async () => {}),
    createEntity: vi.fn(async () => {}),
    updateEntity: vi.fn(async () => {}),
    moveEntity: vi.fn(async () => {}),
    deleteEntity: vi.fn(async () => {}),
    mergeEntities: vi.fn(async () => {}),
    createRelation: vi.fn(async () => {}),
    updateRelation: vi.fn(async () => {}),
    deleteRelation: vi.fn(async () => {})
  }
}

function composerMenuTrigger(
  label: '专家角色' | '工作模式'
): HTMLButtonElement {
  return screen.getByRole('button', {
    name: new RegExp(`^${label}：`, 'u')
  })
}

function openComposerMenu(
  label: '专家角色' | '工作模式'
): HTMLElement {
  fireEvent.click(composerMenuTrigger(label))
  return screen.getByRole('menu', { name: label })
}

function selectComposerOption(
  label: '专家角色' | '工作模式',
  optionLabel: string
): void {
  const menu = openComposerMenu(label)
  const option = within(menu)
    .getByText(optionLabel, { selector: 'span' })
    .closest<HTMLButtonElement>('button')
  if (!option) {
    throw new Error(`Missing ${label} option: ${optionLabel}`)
  }
  fireEvent.click(option)
}

function selectProjectOption(projectName: string): void {
  fireEvent.click(screen.getByRole('button', { name: '当前项目' }))
  const menu = screen.getByRole('menu', { name: '当前项目' })
  const option = within(menu)
    .getByText(projectName, { selector: 'b' })
    .closest<HTMLButtonElement>('[role="menuitemradio"]')
  if (!option) {
    throw new Error(`Missing project option: ${projectName}`)
  }
  fireEvent.click(option)
}

function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
} {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

describe('App', () => {
  beforeEach(() => {
    localStorage.clear()
    delete document.documentElement.dataset.theme
    document.documentElement.style.colorScheme = ''
    vi.clearAllMocks()
    magicTodoStatusChangedListener = undefined
    vi.mocked(api.magicNotes.getTodoStatus)
      .mockReset()
      .mockResolvedValue({ incompleteCount: 0 })
    vi.mocked(api.magicNotes.onTodoStatusChanged)
      .mockReset()
      .mockImplementation((listener) => {
        magicTodoStatusChangedListener = listener
        return () => {
          magicTodoStatusChangedListener = undefined
        }
      })
    vi.mocked(api.conversations.list).mockReset().mockResolvedValue([])
    vi.mocked(api.conversations.replace)
      .mockReset()
      .mockResolvedValue()
    vi.mocked(api.conversations.saveLocal)
      .mockReset()
      .mockResolvedValue()
    vi.mocked(api.conversations.branchLocal)
      .mockReset()
      .mockImplementation(async (input) => ({
        id: crypto.randomUUID(),
        branch: {
          sourceConversationId: input.sourceConversationId,
          sourceTitle: '新对话'
        },
        title: input.title,
        updatedAt: Date.now(),
        messages: []
      }))
    vi.mocked(api.conversations.deleteLocal)
      .mockReset()
      .mockResolvedValue(true)
    vi.mocked(api.conversations.onChanged)
      .mockReset()
      .mockReturnValue(() => undefined)
    conversationQueueChangeListener = undefined
    conversationQueueDispatchListener = undefined
    vi.mocked(api.conversationQueue.list)
      .mockReset()
      .mockResolvedValue([])
    vi.mocked(api.conversationQueue.enqueueUser)
      .mockReset()
      .mockImplementation(async (input) => {
        const item = {
          id: crypto.randomUUID(),
          conversationId: input.conversationId,
          source: 'user' as const,
          label: input.prompt,
          createdAt: '2026-07-31T00:00:00.000Z'
        }
        queueMicrotask(() =>
          conversationQueueDispatchListener?.({ item, input })
        )
        return item
      })
    vi.mocked(api.conversationQueue.remove)
      .mockReset()
      .mockResolvedValue()
    vi.mocked(api.conversationQueue.interruptAndRun)
      .mockReset()
      .mockResolvedValue()
    vi.mocked(api.conversationQueue.releaseUser)
      .mockReset()
      .mockResolvedValue()
    vi.mocked(api.conversationQueue.ready)
      .mockReset()
      .mockResolvedValue()
    vi.mocked(api.conversationQueue.onChanged)
      .mockReset()
      .mockImplementation((listener) => {
        conversationQueueChangeListener = listener
        return () => {
          conversationQueueChangeListener = undefined
        }
      })
    vi.mocked(api.conversationQueue.onDispatch)
      .mockReset()
      .mockImplementation((listener) => {
        conversationQueueDispatchListener = listener
        return () => {
          conversationQueueDispatchListener = undefined
        }
      })
    vi.mocked(api.tasks.list).mockReset().mockResolvedValue([])
    vi.mocked(api.schedules.list).mockReset().mockResolvedValue([])
    api.channels = undefined
    newConversationListener = undefined
    beforeQuitListener = undefined
    browserListener = undefined
    fileSelectionProgressListener = undefined
    maximizedChangedListener = undefined
    speechRecognitionMocks.startPcmRecording.mockResolvedValue({
      result: Promise.resolve({
        audio: new Float32Array([0, 0.25, -0.25]).buffer,
        sampleRate: 16_000
      }),
      stop: vi.fn(),
      cancel: vi.fn()
    })
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia: vi.fn() }
    })
    Object.defineProperty(window, 'AudioContext', {
      configurable: true,
      value: class AudioContextMock {}
    })
    vi.mocked(api.speech!.transcribe).mockResolvedValue({
      text: '本地语音结果'
    })
    vi.mocked(api.speech!.cancel).mockResolvedValue(true)
    vi.mocked(api.agent.getStatus).mockResolvedValue({
      id: 'model',
      label: 'sonnet-5',
      available: true,
      supportsToolExecution: true,
      detail: 'Ready'
    })
    vi.stubGlobal(
      'requestIdleCallback',
      vi.fn(() => 1)
    )
    vi.stubGlobal('cancelIdleCallback', vi.fn())
    Object.defineProperty(window, 'goodbuddy', {
      configurable: true,
      value: api
    })
  })

  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('provides custom minimize, maximize, and close controls', async () => {
    const { unmount } = render(<App />)

    fireEvent.click(screen.getByLabelText('最小化窗口'))
    fireEvent.click(screen.getByLabelText('最大化窗口'))
    fireEvent.click(screen.getByLabelText('关闭窗口'))

    await waitFor(() => {
      expect(api.app.minimize).toHaveBeenCalledOnce()
      expect(api.app.toggleMaximize).toHaveBeenCalledOnce()
      expect(api.app.close).toHaveBeenCalledOnce()
    })
    act(() => maximizedChangedListener?.(true))
    expect(await screen.findByLabelText('还原窗口')).toBeInTheDocument()
    act(() => maximizedChangedListener?.(false))
    expect(screen.getByLabelText('最大化窗口')).toBeInTheDocument()

    unmount()
    expect(removeMaximizedChangedListener).toHaveBeenCalledOnce()
  })

  it('renders the core app shell in English', async () => {
    await changeUiLocale('en-US')
    try {
      render(<App />)

      expect(
        await screen.findByText('New conversation', {
          selector: '.new-chat span'
        })
      ).toBeInTheDocument()
      expect(
        screen.getByRole('navigation', {
          name: 'Main navigation'
        })
      ).toBeInTheDocument()
      expect(
        screen.getByRole('button', { name: 'Chat' })
      ).toBeInTheDocument()
      expect(screen.getByText('Desktop workspace')).toBeInTheDocument()
      expect(screen.getByText('GOODBUDDY WORKSPACE')).toBeInTheDocument()
      expect(
        screen.getByRole('heading', {
          level: 1,
          name: 'Conversation'
        })
      ).toBeInTheDocument()
      expect(
        screen.getByRole('heading', {
          level: 2,
          name: 'What would you like to accomplish today?'
        })
      ).toBeInTheDocument()
      expect(
        screen.getByRole('button', { name: 'Current project' })
      ).toHaveTextContent('Default project')
      expect(screen.getByText('Project: Default project')).toHaveClass(
        'scope-badge'
      )
      expect(
        screen.getByText(/Hi, I’m GoodBuddy/u)
      ).toBeInTheDocument()
      expect(
        screen.getByLabelText('Message GoodBuddy')
      ).toHaveAttribute(
        'placeholder',
        'Message GoodBuddy…\nEnter to send · Shift+Enter for a new line · Ctrl+V to paste an image or text'
      )
    } finally {
      cleanup()
      await changeUiLocale('zh-CN')
    }
  })

  it('localizes untouched project labels but keeps settings and destructive values raw', async () => {
    const secondProject = {
      ...project,
      id: '00000000-0000-4000-8000-000000000102',
      name: 'Second project',
      description: 'Another workspace',
      rootPath: 'C:\\Second'
    }
    vi.mocked(api.projects.list).mockResolvedValueOnce([
      project,
      secondProject
    ])
    vi.mocked(api.tasks.list).mockResolvedValueOnce([
      {
        id: '00000000-0000-4000-8000-000000000901',
        projectId,
        title: 'Seed project task',
        instructions: 'Verify the project label',
        origin: 'schedule',
        status: 'queued',
        workMode: 'ask',
        createdAt: '2026-07-31T01:00:00.000Z'
      }
    ])
    await changeUiLocale('en-US')
    try {
      render(<App />)

      const projectTrigger = await screen.findByRole('button', {
        name: 'Current project'
      })
      expect(projectTrigger).toHaveTextContent('Default project')
      fireEvent.click(projectTrigger)
      expect(
        within(
          screen.getByRole('menu', { name: 'Current project' })
        ).getByText('Default project', { selector: 'b' })
      ).toBeInTheDocument()
      fireEvent.click(projectTrigger)

      fireEvent.click(
        screen.getByLabelText('Toggle assistant workspace')
      )
      fireEvent.click(
        await screen.findByRole('tab', { name: 'Task center' })
      )
      const assistantSidebar = screen.getByLabelText(
        'Assistant workspace'
      )
      expect(
        within(assistantSidebar).getByText('Project: Default project')
      ).toBeInTheDocument()
      const taskIndexHeading = within(assistantSidebar).getByRole(
        'heading',
        { name: 'Task index' }
      )
      const newTaskButton = within(assistantSidebar).getByRole(
        'button',
        { name: 'New task' }
      )
      expect(taskIndexHeading.parentElement).toContainElement(
        newTaskButton
      )
      fireEvent.click(newTaskButton)
      const taskDialog = screen.getByRole('dialog', {
        name: 'New custom task'
      })
      expect(
        within(taskDialog).getByText('Default project')
      ).toBeInTheDocument()
      expect(
        within(taskDialog).getByRole('button', {
          name: 'Current conversation'
        })
      ).toHaveAttribute('aria-pressed', 'true')
      fireEvent.click(
        within(taskDialog).getByRole('button', {
          name: 'Close new custom task'
        })
      )
      fireEvent.click(
        screen.getByLabelText('Toggle assistant workspace')
      )

      fireEvent.click(screen.getByLabelText('Project settings'))
      const settingsDialog = screen.getByRole('dialog', {
        name: 'Project settings'
      })
      expect(
        within(settingsDialog).getByLabelText('Name')
      ).toHaveValue(builtInDefaultProjectSeedName)
      expect(
        within(settingsDialog).getByLabelText('Description')
      ).toHaveValue(builtInDefaultProjectSeedDescription)

      fireEvent.click(
        within(settingsDialog).getByRole('button', {
          name: 'Delete project'
        })
      )
      const confirmation = within(settingsDialog).getByLabelText(
        `Enter “${builtInDefaultProjectSeedName}” to confirm deletion`
      )
      const deleteButton = within(settingsDialog).getByRole('button', {
        name: 'Permanently delete project'
      })
      fireEvent.change(confirmation, {
        target: { value: 'Default project' }
      })
      expect(deleteButton).toBeDisabled()
      fireEvent.change(confirmation, {
        target: { value: builtInDefaultProjectSeedName }
      })
      expect(deleteButton).toBeEnabled()
      fireEvent.click(
        within(settingsDialog).getByRole('button', {
          name: 'Cancel deletion'
        })
      )
      fireEvent.click(
        within(settingsDialog).getByRole('button', {
          name: 'Save project'
        })
      )

      await waitFor(() =>
        expect(api.projects.update).toHaveBeenCalledWith(
          projectId,
          expect.objectContaining({
            name: builtInDefaultProjectSeedName,
            description: builtInDefaultProjectSeedDescription
          })
        )
      )
      expect(
        screen.getByRole('button', { name: 'Current project' })
      ).toHaveTextContent('Default project')
      expect(api.projects.delete).not.toHaveBeenCalled()
    } finally {
      cleanup()
      await changeUiLocale('zh-CN')
    }
  })

  it('renders localized workspace branding in Chinese', async () => {
    render(<App />)

    expect(await screen.findByText('桌面工作区')).toBeInTheDocument()
    expect(screen.getByText('GOODBUDDY 工作台')).toBeInTheDocument()
    expect(
      document.querySelector('.composer__runtime-toolbar')
    ).not.toBeInTheDocument()
  })

  it('renders the unified user and Scheduled Task queue above the Composer', async () => {
    const conversationId =
      '00000000-0000-4000-8000-000000000951'
    vi.mocked(api.conversations.list).mockResolvedValue([
      {
        id: conversationId,
        projectId,
        title: '排队对话',
        updatedAt: Date.now(),
        messages: []
      }
    ])
    vi.mocked(api.conversationQueue.list).mockResolvedValue([
      {
        id: '00000000-0000-4000-8000-000000000952',
        conversationId,
        source: 'schedule',
        label: '每日汇总',
        createdAt: '2026-08-20T09:00:00.000Z'
      },
      {
        id: '00000000-0000-4000-8000-000000000953',
        conversationId,
        source: 'user',
        label: '补充说明',
        createdAt: '2026-08-20T09:01:00.000Z'
      }
    ])

    render(<App />)

    const queue = await screen.findByRole('region', {
      name: '对话待发送队列'
    })
    expect(queue.parentElement).toHaveClass('composer-wrap')
    expect(queue.closest('.composer')).toBeNull()
    expect(queue.nextElementSibling).toHaveClass('composer')
    expect(within(queue).queryByText('待发送（2）')).not.toBeInTheDocument()
    expect(within(queue).getByText('每日汇总')).toBeInTheDocument()
    expect(within(queue).getByText('补充说明')).toBeInTheDocument()
    fireEvent.click(
      within(queue).getByRole('button', {
        name: '立即运行“每日汇总”'
      })
    )
    await waitFor(() =>
      expect(
        api.conversationQueue.interruptAndRun
      ).toHaveBeenCalledWith(
        '00000000-0000-4000-8000-000000000952'
      )
    )
    fireEvent.click(
      within(queue).getByRole('button', {
        name: '从待发送队列删除“补充说明”'
      })
    )
    await waitFor(() =>
      expect(api.conversationQueue.remove).toHaveBeenCalledWith(
        '00000000-0000-4000-8000-000000000953'
      )
    )
  })

  it('preserves scoped queue updates that arrive during another refresh', async () => {
    const firstConversationId =
      '00000000-0000-4000-8000-000000000954'
    const secondConversationId =
      '00000000-0000-4000-8000-000000000955'
    vi.mocked(api.conversations.list).mockResolvedValue([
      {
        id: firstConversationId,
        projectId,
        title: '第一条排队对话',
        updatedAt: Date.now(),
        messages: []
      },
      {
        id: secondConversationId,
        projectId,
        title: '第二条排队对话',
        updatedAt: Date.now() - 1,
        messages: []
      }
    ])
    const firstRefresh = deferred<
      Awaited<
        ReturnType<DesktopApi['conversationQueue']['list']>
      >
    >()
    vi.mocked(api.conversationQueue.list).mockImplementation(
      async (conversationId) => {
        if (conversationId === firstConversationId) {
          return firstRefresh.promise
        }
        return []
      }
    )

    render(<App />)
    await waitFor(() =>
      expect(conversationQueueChangeListener).toBeDefined()
    )
    act(() => {
      conversationQueueChangeListener?.(firstConversationId)
    })
    await waitFor(() =>
      expect(api.conversationQueue.list).toHaveBeenCalledWith(
        firstConversationId
      )
    )
    await act(async () => {
      conversationQueueChangeListener?.(secondConversationId)
      await new Promise((resolve) => window.setTimeout(resolve, 0))
    })
    act(() => {
      firstRefresh.resolve([
        {
          id: '00000000-0000-4000-8000-000000000956',
          conversationId: firstConversationId,
          source: 'user',
          label: '不能被后续刷新丢弃',
          createdAt: '2026-08-20T09:03:00.000Z'
        }
      ])
    })

    expect(
      await screen.findByText('不能被后续刷新丢弃')
    ).toBeInTheDocument()
    await waitFor(() =>
      expect(api.conversationQueue.list).toHaveBeenCalledWith(
        secondConversationId
      )
    )
  })

  it('discovers product Tasks through their Conversation without exposing Runs', async () => {
    const conversationId =
      '00000000-0000-4000-8000-000000000821'
    const taskId = '00000000-0000-4000-8000-000000000822'
    const scheduleId =
      '00000000-0000-4000-8000-000000000823'
    const conversation: ConversationSnapshot = {
      id: conversationId,
      projectId,
      title: '产品发布讨论',
      updatedAt: Date.now(),
      messages: []
    }
    const task: AssistantTask = {
      id: taskId,
      projectId,
      conversationId,
      scheduleId,
      title: '每周发布总结',
      instructions: '总结本周发布进度',
      origin: 'schedule',
      status: 'idle',
      createdAt: '2026-08-19T00:00:00.000Z'
    }
    const schedule: AssistantSchedule = {
      id: scheduleId,
      projectId,
      taskId,
      conversationId,
      title: task.title,
      prompt: task.instructions,
      workMode: 'execute',
      recurrence: 'weekly',
      nextRunAt: '2026-08-21T09:00:00.000Z',
      enabled: true,
      createdAt: task.createdAt,
      updatedAt: task.createdAt
    }
    vi.mocked(api.conversations.list).mockResolvedValue([conversation])
    vi.mocked(api.tasks.list).mockResolvedValue([task])
    vi.mocked(api.schedules.list).mockResolvedValue([schedule])

    render(<App />)

    const toggle = await screen.findByLabelText(
      '展开或折叠“产品发布讨论”中的 1 个任务'
    )
    const conversationButton =
      toggle.parentElement?.querySelector('.conversation-item')
    expect(toggle.nextElementSibling).toBe(conversationButton)
    expect(
      conversationButton?.querySelector('.conversation-item__title')
    ).toHaveAttribute('title', '产品发布讨论')
    expect(screen.queryByText('任务 1')).not.toBeInTheDocument()
    fireEvent.click(toggle)
    const taskTitle = await screen.findByText('每周发布总结', {
      selector: '.conversation-task-child__title'
    })
    const taskChild = taskTitle.closest('button')
    expect(taskChild).not.toBeNull()
    expect(
      taskChild?.querySelector('.task-status-dot')
    ).toHaveClass('task-status-dot--idle')
    expect(taskChild?.querySelector('.lucide-clock-fading'))
      .not.toBeInTheDocument()
    expect(
      taskChild?.querySelector('.conversation-task-child__meta')
    ).toHaveTextContent('Execute · 每周 · 空闲')
    expect(screen.queryByText('Run')).not.toBeInTheDocument()
    fireEvent.click(taskChild!)
    const taskRegion = await screen.findByRole('region', {
      name: '当前会话的任务'
    })
    expect(within(taskRegion).getByText('Execute')).toBeInTheDocument()
  })

  it('keeps completed Conversation Task metadata compact and accessible', async () => {
    const conversationId =
      '00000000-0000-4000-8000-000000000824'
    const scheduleId =
      '00000000-0000-4000-8000-000000000828'
    const conversation: ConversationSnapshot = {
      id: conversationId,
      projectId,
      title: '任务状态会话',
      updatedAt: Date.now(),
      messages: []
    }
    const tasks: AssistantTask[] = [
      {
        id: '00000000-0000-4000-8000-000000000825',
        projectId,
        conversationId,
        scheduleId,
        title: '归档任务',
        instructions: '检查完成状态',
        origin: 'schedule',
        status: 'completed',
        createdAt: '2026-08-19T03:00:00.000Z'
      },
      {
        id: '00000000-0000-4000-8000-000000000826',
        projectId,
        conversationId,
        title: '运行中任务',
        instructions: '检查运行状态',
        origin: 'schedule',
        status: 'running',
        createdAt: '2026-08-19T02:00:00.000Z'
      },
      {
        id: '00000000-0000-4000-8000-000000000827',
        projectId,
        conversationId,
        title: '失败任务',
        instructions: '检查失败状态',
        origin: 'schedule',
        status: 'failed',
        createdAt: '2026-08-19T01:00:00.000Z'
      }
    ]
    const schedule: AssistantSchedule = {
      id: scheduleId,
      projectId,
      taskId: tasks[0]!.id,
      conversationId,
      title: tasks[0]!.title,
      prompt: tasks[0]!.instructions,
      workMode: 'ask',
      recurrence: 'once',
      nextRunAt: '2026-08-19T03:00:00.000Z',
      enabled: false,
      createdAt: tasks[0]!.createdAt,
      updatedAt: tasks[0]!.createdAt
    }
    vi.mocked(api.conversations.list).mockResolvedValue([
      conversation
    ])
    vi.mocked(api.tasks.list).mockResolvedValue(tasks)
    vi.mocked(api.schedules.list).mockResolvedValue([schedule])

    render(<App />)

    fireEvent.click(
      await screen.findByLabelText(
        '展开或折叠“任务状态会话”中的 3 个任务'
      )
    )
    const completedTitle = await screen.findByText('归档任务', {
      selector: '.conversation-task-child__title'
    })
    const completedTask = completedTitle.closest('button')
    const completedStatus = completedTask?.querySelector(
      '.conversation-task-child__completed-status'
    )
    expect(completedStatus).toHaveClass(
      'task-status-dot',
      'task-status-dot--completed'
    )
    expect(completedStatus).toHaveAttribute('title', '已完成')
    expect(
      completedStatus?.querySelector('.lucide-check')
    ).toBeInTheDocument()
    expect(completedTask?.firstElementChild).toBe(completedTitle)
    expect(completedTask?.lastElementChild).toBe(completedStatus)
    expect(completedTask).toHaveAccessibleName(/已完成/u)
    expect(
      completedTask?.querySelector('.conversation-task-child__meta')
    ).toHaveTextContent('Ask · 仅一次')
    expect(
      completedTask?.querySelector('.conversation-task-child__meta')
    ).not.toHaveTextContent('已完成')

    for (const [title, status, label] of [
      ['运行中任务', 'running', '运行中'],
      ['失败任务', 'failed', '失败']
    ] as const) {
      const taskTitle = await screen.findByText(title, {
        selector: '.conversation-task-child__title'
      })
      const taskChild = taskTitle.closest('button')
      expect(
        taskChild?.querySelector('.task-status-dot')
      ).toHaveClass(`task-status-dot--${status}`)
      expect(taskChild?.firstElementChild).toBe(taskTitle)
      expect(taskChild?.lastElementChild).toBe(
        taskChild?.querySelector('.task-status-dot')
      )
      expect(
        taskChild?.querySelector('.conversation-task-child__meta')
      ).toHaveTextContent(label)
    }
    expect(
      document.querySelector('.conversation-task-child__icon')
    ).not.toBeInTheDocument()
  })

  it('routes scheduled Task approvals to the associated Conversation', async () => {
    const conversationId =
      '00000000-0000-4000-8000-000000000831'
    const taskId = '00000000-0000-4000-8000-000000000832'
    vi.mocked(api.conversations.list).mockResolvedValue([
      {
        id: conversationId,
        projectId,
        title: '发布审批会话',
        updatedAt: Date.now(),
        messages: []
      }
    ])
    vi.mocked(api.tasks.list).mockResolvedValue([
      {
        id: taskId,
        projectId,
        conversationId,
        scheduleId: '00000000-0000-4000-8000-000000000833',
        title: '发布任务',
        instructions: '更新发布文件',
        origin: 'schedule',
        status: 'running',
        createdAt: '2026-08-19T00:00:00.000Z'
      }
    ])
    render(<App />)
    await screen.findAllByText('发布审批会话')
    await waitFor(() => expect(api.tasks.list).toHaveBeenCalled())

    act(() => {
      agentListener?.({
        requestId: taskId,
        type: 'approval',
        approvalId: '00000000-0000-4000-8000-000000000834',
        title: '请求写入工作区',
        description: '更新发布文件',
        toolName: 'write_file',
        argumentSummary: 'release.md',
        allowPermanent: false
      })
    })

    expect(await screen.findAllByText('请求写入工作区'))
      .not.toHaveLength(0)
    expect(screen.getByText('仅此次')).toBeInTheDocument()
    expect(screen.getByLabelText('任务结果：发布任务'))
      .toBeInTheDocument()
  })

  it('idle-preloads only the small Heartbeat route at startup', async () => {
    render(<App />)

    expect(window.requestIdleCallback).toHaveBeenCalledWith(
      expect.any(Function),
      { timeout: 2000 }
    )
    const idleCallback = vi.mocked(window.requestIdleCallback)
      .mock.calls[0]?.[0]
    await act(async () => {
      idleCallback?.({
        didTimeout: false,
        timeRemaining: () => 50
      })
    })
    await waitFor(() => expect(routeModuleLoads.heartbeat).toBe(1))
    expect(routeModuleLoads).toMatchObject({
      activity: 0,
      knowledge: 0,
      magicNotes: 0,
      settings: 0
    })
  })

  it('preloads a heavy route once across repeated pointer and focus intent', async () => {
    render(<App />)
    const activity = await screen.findByRole('button', {
      name: '运行记录'
    })

    fireEvent.pointerEnter(activity)
    fireEvent.focus(activity)
    fireEvent.pointerEnter(activity)

    await waitFor(() => expect(routeModuleLoads.activity).toBe(1))
  })

  it('waits for project bootstrap before project-scoped startup loads', async () => {
    const projects = deferred<(typeof project)[]>()
    vi.mocked(api.projects.list).mockImplementationOnce(
      () => projects.promise
    )

    render(<App />)

    expect(api.projects.list).toHaveBeenCalledOnce()
    expect(api.memory.list).not.toHaveBeenCalled()
    expect(api.schedules.list).not.toHaveBeenCalled()
    expect(api.heartbeats.list).not.toHaveBeenCalled()

    await act(async () => projects.resolve([project]))

    await waitFor(() => {
      expect(api.memory.list).toHaveBeenCalledTimes(2)
      expect(api.memory.list).toHaveBeenCalledWith(projectId)
      expect(api.memory.list).toHaveBeenCalledWith()
      expect(api.schedules.list).toHaveBeenCalledOnce()
      expect(api.schedules.list).toHaveBeenCalledWith()
      expect(api.heartbeats.list).toHaveBeenCalledOnce()
    })
  })

  it('shows an accessible fallback while a lazy route loads', async () => {
    lazyRouteMocks.suspendKnowledgeRoute()
    try {
      render(<App />)

      fireEvent.click(
        await screen.findByRole('button', { name: '知识库' })
      )

      const loading = screen.getByRole('status', {
        name: '正在加载页面…'
      })
      expect(loading).toHaveAttribute('aria-live', 'polite')
      expect(loading).toHaveAttribute('aria-busy', 'true')
      await act(async () => lazyRouteMocks.releaseKnowledgeRoute())
      expect(
        await screen.findByRole(
          'heading',
          {
            level: 1,
            name: '知识库'
          },
          { timeout: 3000 }
        )
      ).toBeInTheDocument()
      expect(
        screen.queryByRole('status', { name: '正在加载页面…' })
      ).not.toBeInTheDocument()
    } finally {
      lazyRouteMocks.releaseKnowledgeRoute()
    }
  })

  it('keeps a recently visited workspace page mounted', async () => {
    render(<App />)
    fireEvent.click(
      await screen.findByRole('button', { name: '知识库' })
    )
    const heading = await screen.findByRole('heading', {
      level: 1,
      name: '知识库'
    })
    const route = heading.closest<HTMLElement>('[data-route="knowledge"]')
    expect(route).not.toHaveAttribute('hidden')

    fireEvent.click(screen.getByRole('button', { name: '对话' }))
    expect(heading).toBeInTheDocument()
    expect(route).toHaveAttribute('hidden')

    fireEvent.click(screen.getByRole('button', { name: '知识库' }))
    expect(
      await screen.findByRole('heading', {
        level: 1,
        name: '知识库'
      })
    ).toBe(heading)
    expect(route).not.toHaveAttribute('hidden')
  })

  it('enforces the workspace KeepAlive cap during rapid visits', async () => {
    let now = 2_000_000
    vi.spyOn(Date, 'now').mockImplementation(() => ++now)
    render(<App />)

    fireEvent.click(
      await screen.findByRole('button', { name: '知识库' })
    )
    await screen.findByRole('heading', { name: '知识库' })
    fireEvent.click(screen.getByRole('button', { name: '智能心跳' }))
    await screen.findByRole('heading', { name: '智能心跳' })
    fireEvent.click(screen.getByRole('button', { name: '运行记录' }))
    await screen.findByRole('heading', { name: '运行记录' })
    fireEvent.click(screen.getByRole('button', { name: '对话' }))
    fireEvent.click(
      screen.getByRole('button', { name: /本地工作区/u })
    )
    await screen.findByRole('heading', { name: '设置中心' })

    expect(
      document.querySelectorAll('.workspace-route-cache')
    ).toHaveLength(4)
    expect(
      document.querySelector('[data-route="knowledge"]')
    ).not.toBeInTheDocument()
  })

  it('preserves title, message, and project filtering with deferred search', async () => {
    vi.mocked(api.conversations.list).mockResolvedValueOnce([
      {
        id: '00000000-0000-4000-8000-000000000411',
        projectId,
        title: '标题里的 Alpha',
        updatedAt: 1_775_000_000_003,
        messages: [
          {
            id: '00000000-0000-4000-8000-000000000412',
            role: 'assistant',
            content: '普通正文',
            createdAt: 1_775_000_000_003,
            state: 'complete'
          }
        ]
      },
      {
        id: '00000000-0000-4000-8000-000000000413',
        projectId,
        title: '正文命中的会话',
        updatedAt: 1_775_000_000_002,
        messages: [
          {
            id: '00000000-0000-4000-8000-000000000414',
            role: 'user',
            content: '这里包含 Beta Needle',
            createdAt: 1_775_000_000_002,
            state: 'complete'
          }
        ]
      },
      {
        id: '00000000-0000-4000-8000-000000000415',
        projectId: '00000000-0000-4000-8000-000000000999',
        title: '其他项目里的 Alpha',
        updatedAt: 1_775_000_000_001,
        messages: [
          {
            id: '00000000-0000-4000-8000-000000000416',
            role: 'user',
            content: 'Beta Needle',
            createdAt: 1_775_000_000_001,
            state: 'complete'
          }
        ]
      }
    ])
    const { container } = render(<App />)
    const search = await screen.findByLabelText('搜索对话')
    const conversationList =
      container.querySelector<HTMLElement>('.conversation-list')
    if (!conversationList) {
      throw new Error('Missing conversation list')
    }
    expect(
      await within(conversationList).findByText('标题里的 Alpha')
    ).toBeInTheDocument()
    expect(
      within(conversationList).queryByText('其他项目里的 Alpha')
    ).not.toBeInTheDocument()

    fireEvent.change(search, { target: { value: 'beta needle' } })
    expect(search).toHaveValue('beta needle')
    await waitFor(() => {
      expect(
        within(conversationList).getByText('正文命中的会话')
      ).toBeInTheDocument()
      expect(
        within(conversationList).queryByText('标题里的 Alpha')
      ).not.toBeInTheDocument()
    })

    fireEvent.change(search, { target: { value: 'ALPHA' } })
    await waitFor(() => {
      expect(
        within(conversationList).getByText('标题里的 Alpha')
      ).toBeInTheDocument()
      expect(
        within(conversationList).queryByText('正文命中的会话')
      ).not.toBeInTheDocument()
      expect(
        within(conversationList).queryByText('其他项目里的 Alpha')
      ).not.toBeInTheDocument()
    })
  })

  it('keeps Settings open when the interface language changes', async () => {
    api.updates = {
      getSettings: vi.fn(async () => ({
        checkUpdatesOnStartup: false,
        updateSource: 'github' as const,
        modelDownloadSource: 'modelscope' as const,
        magicNotesEnabled: false,
        magicNotesShowIncompleteTodoCount: true,
        magicNoteCommentMode: 'immediate' as const,
        magicNoteCommentFormat: 'combined' as const
      })),
      updateSettings: vi.fn(),
      check: vi.fn(),
      openReleasePage: vi.fn(),
      onResult: vi.fn(() => () => {})
    }
    try {
      render(
        <UiLocaleProvider initialPreference="zh-CN">
          <App />
        </UiLocaleProvider>
      )

      fireEvent.click(
        await screen.findByRole('button', {
          name: /本地工作区/u
        })
      )
      fireEvent.click(
        await screen.findByRole('tab', { name: '外观' })
      )
      const projectsList = vi.mocked(api.projects.list)
      const expertsList = vi.mocked(api.experts.list)
      const tasksList = vi.mocked(api.tasks.list)
      await waitFor(() => {
        expect(projectsList).toHaveBeenCalled()
        expect(expertsList).toHaveBeenCalled()
        expect(tasksList).toHaveBeenCalled()
      })
      const loadCounts = {
        projects: projectsList.mock.calls.length,
        experts: expertsList.mock.calls.length,
        tasks: tasksList.mock.calls.length
      }
      fireEvent.click(
        screen.getByRole('radio', {
          name: /^English/u
        })
      )

      expect(
        await screen.findByRole('region', {
          name: 'Settings'
        })
      ).toBeInTheDocument()
      expect(
        screen.getByRole('heading', {
          level: 1,
          name: 'Settings'
        })
      ).toBeInTheDocument()
      expect(api.updates.getSettings).toHaveBeenCalledOnce()
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0))
      })
      expect(projectsList).toHaveBeenCalledTimes(loadCounts.projects)
      expect(expertsList).toHaveBeenCalledTimes(loadCounts.experts)
      expect(tasksList).toHaveBeenCalledTimes(loadCounts.tasks)
    } finally {
      delete api.updates
      cleanup()
      await changeUiLocale('zh-CN')
    }
  })

  it('checks for updates silently on startup and only reports a new version', async () => {
    const check = vi.fn(async () => ({
      updateAvailable: true,
      currentVersion: '0.8.4',
      latestVersion: '0.9.0',
      releaseUrl:
        'https://github.com/mesalogo/goodbuddy/releases/tag/v0.9.0',
      target: {
        platform: 'windows' as const,
        arch: 'x64' as const,
        formats: ['nsis', 'portable'],
        files: [
          {
            name: 'GoodBuddy-0.9.0-windows-x64-portable.zip',
            size: 1,
            sha256: 'a'.repeat(64)
          }
        ]
      }
    }))
    api.updates = {
      getSettings: vi.fn(async () => ({
        checkUpdatesOnStartup: true,
        updateSource: 'github' as const,
        modelDownloadSource: 'modelscope' as const,
        magicNotesEnabled: true,
        magicNotesShowIncompleteTodoCount: true,
        magicNoteCommentMode: 'immediate' as const,
        magicNoteCommentFormat: 'combined' as const
      })),
      updateSettings: vi.fn(async () => ({
        checkUpdatesOnStartup: true,
        updateSource: 'github' as const,
        modelDownloadSource: 'modelscope' as const,
        magicNotesEnabled: true,
        magicNotesShowIncompleteTodoCount: true,
        magicNoteCommentMode: 'immediate' as const,
        magicNoteCommentFormat: 'combined' as const
      })),
      check,
      openReleasePage: vi.fn(async () => {}),
      onResult: vi.fn(() => () => {})
    }
    try {
      render(<App />)
      await waitFor(() => expect(check).toHaveBeenCalledOnce())
      expect(
        await screen.findByText(
          '发现 GoodBuddy 0.9.0，可在“关于与更新”中查看'
        )
      ).toBeInTheDocument()
      expect(api.updates.onResult).not.toHaveBeenCalled()
    } finally {
      delete api.updates
    }
  })

  it('shows and acknowledges pending release notes on startup', async () => {
    const acknowledge = vi.fn(async () => {})
    api.releaseNotes = {
      getPending: vi.fn(async () => ({
        currentVersion: '0.8.18',
        releases: [
          {
            version: '0.8.18',
            releasedAt: '2026-08-11',
            notes: {
              'zh-CN': {
                highlights: ['多 Runtime 工作流更加连贯'],
                features: ['新增版本更新说明'],
                fixes: ['修复重复显示'],
                notices: ['Ask 模式保持只读']
              },
              'en-US': {
                highlights: ['Multi-Runtime workflows are more cohesive'],
                features: ['Added release notes'],
                fixes: ['Fixed repeated display'],
                notices: ['Ask remains read-only']
              }
            }
          }
        ]
      })),
      acknowledge
    }
    try {
      render(<App />)

      expect(
        await screen.findByRole('dialog', {
          name: 'GoodBuddy 0.8.18 更新内容'
        })
      ).toBeInTheDocument()
      fireEvent.click(screen.getByRole('button', { name: '开始使用' }))

      await waitFor(() =>
        expect(acknowledge).toHaveBeenCalledWith('0.8.18')
      )
      await waitFor(() =>
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
      )
    } finally {
      delete api.releaseNotes
    }
  })

  it('does not disturb startup when updates are current or offline', async () => {
    const currentResult = {
      updateAvailable: false,
      currentVersion: '0.8.4',
      latestVersion: '0.8.4',
      releaseUrl:
        'https://github.com/mesalogo/goodbuddy/releases/tag/v0.8.4',
      target: {
        platform: 'windows' as const,
        arch: 'x64' as const,
        formats: ['nsis', 'portable'],
        files: []
      }
    }
    const check = vi
      .fn()
      .mockResolvedValueOnce(currentResult)
      .mockRejectedValueOnce(new Error('offline'))
    api.updates = {
      getSettings: vi.fn(async () => ({
        checkUpdatesOnStartup: true,
        updateSource: 'github' as const,
        modelDownloadSource: 'modelscope' as const,
        magicNotesEnabled: true,
        magicNotesShowIncompleteTodoCount: true,
        magicNoteCommentMode: 'immediate' as const,
        magicNoteCommentFormat: 'combined' as const
      })),
      updateSettings: vi.fn(async () => ({
        checkUpdatesOnStartup: true,
        updateSource: 'github' as const,
        modelDownloadSource: 'modelscope' as const,
        magicNotesEnabled: true,
        magicNotesShowIncompleteTodoCount: true,
        magicNoteCommentMode: 'immediate' as const,
        magicNoteCommentFormat: 'combined' as const
      })),
      check,
      openReleasePage: vi.fn(async () => {}),
      onResult: vi.fn(() => () => {})
    }
    try {
      const first = render(<App />)
      await waitFor(() => expect(check).toHaveBeenCalledTimes(1))
      expect(
        screen.queryByText(/发现 GoodBuddy|版本检查失败/u)
      ).not.toBeInTheDocument()

      first.unmount()
      render(<App />)
      await waitFor(() => expect(check).toHaveBeenCalledTimes(2))
      expect(
        screen.queryByText(/发现 GoodBuddy|版本检查失败/u)
      ).not.toBeInTheDocument()
    } finally {
      delete api.updates
    }
  })

  it('keeps rendering when an older preload has no browser bridge', async () => {
    Object.defineProperty(window, 'goodbuddy', {
      configurable: true,
      value: {
        ...api,
        browser: undefined
      }
    })

    render(<App />)

    expect(
      await screen.findByLabelText('向 GoodBuddy 提问')
    ).toBeInTheDocument()
  })

  it('uses local transcription when Electron has no Web Speech API', async () => {
    Object.defineProperty(window, 'SpeechRecognition', {
      configurable: true,
      value: undefined
    })
    Object.defineProperty(window, 'webkitSpeechRecognition', {
      configurable: true,
      value: undefined
    })

    render(<App />)
    fireEvent.click(await screen.findByLabelText('语音输入'))

    await waitFor(() =>
      expect(api.speech?.transcribe).toHaveBeenCalledWith(
        expect.objectContaining({
          sampleRate: 16_000,
          audio: expect.any(ArrayBuffer)
        })
      )
    )
    expect(await screen.findByDisplayValue('本地语音结果')).toBeInTheDocument()
    expect(
      screen.getByText('快捷唤起：', { exact: false })
    ).toHaveTextContent('快捷唤起：Ctrl+Shift+Space')
    expect(
      screen.queryByText(/CommandOrControl/)
    ).not.toBeInTheDocument()
  })

  it('shows a red recording state until microphone capture stops', async () => {
    let resolveRecording!: (value: {
      audio: ArrayBuffer
      sampleRate: 16_000
    }) => void
    const stop = vi.fn()
    speechRecognitionMocks.startPcmRecording.mockResolvedValueOnce({
      result: new Promise((resolve) => {
        resolveRecording = resolve
      }),
      stop,
      cancel: vi.fn()
    })

    render(<App />)
    const input = await screen.findByLabelText('向 GoodBuddy 提问')
    expect(input).toHaveAttribute('rows', '3')
    expect(input).toHaveStyle({ height: '72px' })

    fireEvent.click(screen.getByLabelText('语音输入'))
    const recordingButton = await screen.findByRole('button', {
      name: '停止录音'
    })
    expect(recordingButton).toHaveAttribute('data-state', 'recording')
    expect(recordingButton).toHaveAttribute('aria-pressed', 'true')
    expect(recordingButton).toHaveClass(
      'composer__voice-button--recording'
    )

    fireEvent.click(recordingButton)
    expect(stop).toHaveBeenCalledOnce()
    resolveRecording({
      audio: new Float32Array([0, 0.25, -0.25]).buffer,
      sampleRate: 16_000
    })
    expect(
      await screen.findByDisplayValue('本地语音结果')
    ).toBeInTheDocument()
  })

  it('keeps conversation actions in the conversation list', async () => {
    const writeText = vi.fn(async () => {})
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText }
    })
    const { container } = render(<App />)
    const topbar = container.querySelector<HTMLElement>('.topbar')
    const conversationList =
      container.querySelector<HTMLElement>('.conversation-list')
    expect(topbar).not.toBeNull()
    expect(conversationList).not.toBeNull()
    if (!topbar || !conversationList) {
      return
    }

    expect(
      within(topbar).queryByRole('button', {
        name: /^专家角色：/u
      })
    ).not.toBeInTheDocument()
    expect(composerMenuTrigger('专家角色').closest('.composer')).not.toBeNull()

    const themeToggle = within(topbar).getByRole('button', {
      name: '切换深色主题'
    })
    fireEvent.click(themeToggle)
    await waitFor(() =>
      expect(document.documentElement.dataset.theme).toBe('dark')
    )
    expect(
      screen.queryByRole('menuitem', { name: '重命名会话' })
    ).not.toBeInTheDocument()
    expect(
      within(topbar).getByRole('button', {
        name: '切换浅色主题'
      })
    ).toBe(themeToggle)
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()

    const conversationMenuTrigger = within(
      conversationList
    ).getByLabelText('更多会话操作 新对话')
    fireEvent.click(conversationMenuTrigger)
    const renameButton = within(conversationList).getByRole('button', {
      name: '重命名会话'
    })
    expect(renameButton).toBeVisible()
    expect(
      within(conversationList).getByRole('button', {
        name: '复制完整会话'
      })
    ).toBeVisible()
    expect(
      within(conversationList).getByRole('button', {
        name: '导出 Markdown'
      })
    ).toBeVisible()

    fireEvent.click(renameButton)
    const renameInput = within(conversationList).getByLabelText(
      '重命名会话 新对话'
    )
    fireEvent.change(renameInput, {
      target: { value: '重命名后的会话' }
    })
    fireEvent.submit(renameInput.closest('form')!)
    expect(
      within(conversationList).getByText('重命名后的会话')
    ).toBeInTheDocument()
    await waitFor(() => expect(conversationMenuTrigger).toHaveFocus())

    fireEvent.click(screen.getByRole('button', { name: '知识库' }))
    fireEvent.click(
      within(conversationList).getByLabelText(
        '更多会话操作 重命名后的会话'
      )
    )
    fireEvent.click(
      within(conversationList).getByRole('button', {
        name: '复制完整会话'
      })
    )
    await waitFor(() => expect(writeText).toHaveBeenCalledOnce())
    expect(await screen.findByRole('status')).toBeVisible()
  })

  it('flushes and opens an independent conversation branch with provenance badges', async () => {
    const sourceConversationId =
      '00000000-0000-4000-8000-000000000421'
    const branchConversationId =
      '00000000-0000-4000-8000-000000000422'
    const sourceConversation: ConversationSnapshot = {
      id: sourceConversationId,
      projectId,
      title: '方案讨论',
      updatedAt: 1_775_000_000_000,
      messages: [
        {
          id: '00000000-0000-4000-8000-000000000423',
          role: 'user',
          content: '探索不同发布方案',
          createdAt: 1_775_000_000_000,
          state: 'complete'
        },
        {
          id: '00000000-0000-4000-8000-000000000424',
          role: 'assistant',
          content: '可以比较风险、成本和回滚路径。',
          createdAt: 1_775_000_001_000,
          state: 'complete'
        }
      ]
    }
    vi.mocked(api.conversations.list).mockResolvedValueOnce([
      sourceConversation
    ])
    vi.mocked(api.conversations.branchLocal).mockImplementationOnce(
      async (input) => ({
        ...sourceConversation,
        id: branchConversationId,
        branch: {
          sourceConversationId,
          sourceTitle: '方案讨论更新'
        },
        contextMetrics: undefined,
        contextCompressionState: undefined,
        title: input.title,
        updatedAt: 1_775_000_002_000,
        messages: sourceConversation.messages.map((message, index) => ({
          ...message,
          id: `00000000-0000-4000-8000-${String(
            430 + index
          ).padStart(12, '0')}`
        }))
      })
    )
    const { container } = render(<App />)
    expect(
      await screen.findByText('探索不同发布方案')
    ).toBeInTheDocument()

    fireEvent.click(
      await screen.findByLabelText('更多会话操作 方案讨论')
    )
    fireEvent.click(
      screen.getByRole('button', { name: '重命名会话' })
    )
    const renameInput = screen.getByLabelText('重命名会话 方案讨论')
    fireEvent.change(renameInput, {
      target: { value: '方案讨论更新' }
    })
    fireEvent.submit(renameInput.closest('form')!)
    expect(
      await screen.findAllByText('方案讨论更新')
    ).toHaveLength(2)
    vi.mocked(api.conversations.saveLocal).mockClear()

    fireEvent.click(
      screen.getByLabelText('更多会话操作 方案讨论更新')
    )
    const branchButton = screen.getByRole('button', {
      name: '在新会话中继续'
    })
    await waitFor(() => expect(branchButton).toBeEnabled())
    fireEvent.click(branchButton)

    await waitFor(() =>
      expect(api.conversations.saveLocal).toHaveBeenCalledWith([
        expect.objectContaining({
          header: expect.objectContaining({
            id: sourceConversationId,
            title: '方案讨论更新'
          })
        })
      ])
    )
    await waitFor(() =>
      expect(api.conversations.branchLocal).toHaveBeenCalledWith({
        sourceConversationId,
        title: '方案讨论更新 · 分支'
      })
    )
    expect(
      vi.mocked(api.conversations.saveLocal).mock.invocationCallOrder.at(-1)
    ).toBeLessThan(
      vi.mocked(api.conversations.branchLocal).mock.invocationCallOrder[0]!
    )
    expect(
      await screen.findAllByLabelText(
        '分支会话，来源：方案讨论更新'
      )
    ).toHaveLength(2)
    const sidebar = container.querySelector('.conversation-list')
    const badge = within(sidebar as HTMLElement).getByLabelText(
      '分支会话，来源：方案讨论更新'
    )
    expect(badge).toHaveClass('conversation-branch-badge')
    expect(badge.querySelector('.lucide-git-fork')).toBeInTheDocument()
    expect(
      container.querySelector('.conversation-title')
    ).toHaveTextContent('方案讨论更新 · 分支')
    await waitFor(() =>
      expect(screen.getByLabelText('向 GoodBuddy 提问')).toHaveFocus()
    )
    expect(
      screen.getAllByText('可以比较风险、成本和回滚路径。').length
    ).toBeGreaterThan(0)
    expect(
      await screen.findByText('已创建并打开分支会话')
    ).toBeInTheDocument()
  })

  it('keeps the source conversation open when branch persistence fails', async () => {
    const sourceConversationId =
      '00000000-0000-4000-8000-000000000441'
    vi.mocked(api.conversations.list).mockResolvedValueOnce([
      {
        id: sourceConversationId,
        projectId,
        title: '保留的来源会话',
        updatedAt: 1_775_000_000_000,
        messages: [
          {
            id: '00000000-0000-4000-8000-000000000442',
            role: 'user',
            content: '不能丢失的来源内容',
            createdAt: 1_775_000_000_000,
            state: 'complete'
          }
        ]
      }
    ])
    vi.mocked(api.conversations.branchLocal).mockRejectedValueOnce(
      new Error('分支数据写入失败')
    )
    const { container } = render(<App />)
    expect(
      await screen.findByText('不能丢失的来源内容')
    ).toBeInTheDocument()

    const actionTrigger = await screen.findByLabelText(
      '更多会话操作 保留的来源会话'
    )
    fireEvent.click(actionTrigger)
    const branchButton = screen.getByRole('button', {
      name: '在新会话中继续'
    })
    await waitFor(() => expect(branchButton).toBeEnabled())
    fireEvent.click(branchButton)

    expect(
      await screen.findByText('分支数据写入失败')
    ).toBeInTheDocument()
    expect(
      container.querySelector('.conversation-title')
    ).toHaveTextContent('保留的来源会话')
    expect(
      screen.getByText('不能丢失的来源内容')
    ).toBeInTheDocument()
    expect(
      screen.queryByLabelText(/^分支会话，来源：/u)
    ).not.toBeInTheDocument()
    await waitFor(() => expect(actionTrigger).toHaveFocus())
  })

  it('explains why a queued conversation cannot be branched', async () => {
    const sourceConversationId =
      '00000000-0000-4000-8000-000000000451'
    vi.mocked(api.conversations.list).mockResolvedValueOnce([
      {
        id: sourceConversationId,
        projectId,
        title: '等待队列的会话',
        updatedAt: 1_775_000_000_000,
        messages: [
          {
            id: '00000000-0000-4000-8000-000000000452',
            role: 'user',
            content: '还有待发送内容',
            createdAt: 1_775_000_000_000,
            state: 'complete'
          }
        ]
      }
    ])
    vi.mocked(api.conversationQueue.list).mockResolvedValue([
      {
        id: '00000000-0000-4000-8000-000000000453',
        conversationId: sourceConversationId,
        source: 'user',
        label: '待发送',
        createdAt: '2026-08-20T08:00:00.000Z'
      }
    ])
    render(<App />)
    expect(
      await screen.findByText('还有待发送内容')
    ).toBeInTheDocument()

    fireEvent.click(
      await screen.findByLabelText('更多会话操作 等待队列的会话')
    )
    const branchButton = screen.getByRole('button', {
      name: '在新会话中继续'
    })
    await waitFor(() =>
      expect(branchButton).toHaveAttribute('aria-disabled', 'true')
    )
    expect(branchButton).toHaveAccessibleDescription(
      '会话运行或待发送内容处理完后才能创建分支'
    )
    fireEvent.click(branchButton)
    await waitFor(() =>
      expect(
        screen.getAllByText(
          '会话运行或待发送内容处理完后才能创建分支'
        )
      ).toHaveLength(2)
    )
    expect(api.conversations.branchLocal).not.toHaveBeenCalled()
  })

  it('offers a floating control when more messages remain below', async () => {
    vi.mocked(api.conversations.list).mockResolvedValueOnce([
      {
        id: '00000000-0000-4000-8000-000000000401',
        projectId,
        title: '长会话',
        updatedAt: 1_775_000_000_000,
        messages: [
          {
            id: '00000000-0000-4000-8000-000000000402',
            role: 'assistant',
            content: '较早的会话内容',
            createdAt: 1_775_000_000_000,
            state: 'complete'
          }
        ]
      }
    ])
    const { container } = render(<App />)

    expect(await screen.findByText('较早的会话内容')).toBeInTheDocument()
    const chat = container.querySelector<HTMLElement>('.chat')
    if (!chat) {
      throw new Error('Missing chat scroll container')
    }
    Object.defineProperties(chat, {
      clientHeight: { configurable: true, value: 400 },
      scrollHeight: { configurable: true, value: 1_200 },
      scrollTop: { configurable: true, writable: true, value: 100 }
    })
    const scrollTo = vi.fn()
    chat.scrollTo = scrollTo

    fireEvent.scroll(chat)
    const scrollButton = screen.getByRole('button', {
      name: '到底部'
    })
    expect(scrollButton).toHaveAttribute(
      'aria-controls',
      'chat-message-list'
    )
    expect(scrollButton).toHaveAttribute('title', '到底部')
    expect(scrollButton).toHaveTextContent('')

    fireEvent.click(scrollButton)
    expect(scrollTo).toHaveBeenLastCalledWith({
      top: 1_200,
      behavior: 'smooth'
    })

    chat.scrollTop = 750
    fireEvent.scroll(chat)
    expect(
      screen.queryByRole('button', { name: '到底部' })
    ).not.toBeInTheDocument()
  })

  it('keeps a newly opened persisted conversation at the bottom while its content settles', async () => {
    let resizeCallback: ResizeObserverCallback | undefined
    const disconnect = vi.fn()
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(callback: ResizeObserverCallback) {
          resizeCallback = callback
        }

        observe(): void {}
        unobserve(): void {}
        disconnect(): void {
          disconnect()
        }
      }
    )
    vi.mocked(api.conversations.list).mockResolvedValueOnce([
      {
        id: '00000000-0000-4000-8000-000000000417',
        projectId,
        title: '已有会话',
        updatedAt: 1_775_000_000_000,
        messages: [
          {
            id: '00000000-0000-4000-8000-000000000418',
            role: 'user',
            content: '最后一个用户问题',
            createdAt: 1_775_000_000_000,
            state: 'complete'
          },
          {
            id: '00000000-0000-4000-8000-000000000419',
            role: 'assistant',
            content: '加载后会继续完成布局的回复',
            createdAt: 1_775_000_000_001,
            state: 'complete'
          }
        ]
      }
    ])
    const { container } = render(<App />)

    expect(
      await screen.findByText('加载后会继续完成布局的回复')
    ).toBeInTheDocument()
    const chat = container.querySelector<HTMLElement>('.chat')
    if (!chat || !resizeCallback) {
      throw new Error('Missing chat resize observer')
    }
    let scrollHeight = 1_200
    Object.defineProperties(chat, {
      clientHeight: { configurable: true, value: 400 },
      scrollHeight: {
        configurable: true,
        get: () => scrollHeight
      },
      scrollTop: { configurable: true, writable: true, value: 800 }
    })
    const scrollTo = vi.fn()
    chat.scrollTo = scrollTo

    scrollHeight = 1_800
    act(() => resizeCallback?.([], {} as ResizeObserver))
    expect(scrollTo).toHaveBeenLastCalledWith({
      top: 1_800,
      behavior: 'auto'
    })

    chat.scrollTop = 100
    fireEvent.scroll(chat)
    scrollTo.mockClear()
    scrollHeight = 2_200
    act(() => resizeCallback?.([], {} as ResizeObserver))
    expect(scrollTo).not.toHaveBeenCalled()
  })

  it('renders the latest 80 messages and preserves scroll when revealing earlier messages', async () => {
    vi.mocked(api.conversations.list).mockResolvedValueOnce([
      {
        id: '00000000-0000-4000-8000-000000000421',
        projectId,
        title: '超长会话',
        updatedAt: 1_775_000_000_000,
        messages: Array.from({ length: 161 }, (_, index) => ({
          id: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
          role: index % 2 === 0 ? ('user' as const) : ('assistant' as const),
          content: `历史消息 ${String(index).padStart(3, '0')}`,
          createdAt: 1_775_000_000_000 + index,
          state: 'complete' as const
        }))
      }
    ])
    const { container } = render(<App />)

    expect(await screen.findByText('历史消息 160')).toBeInTheDocument()
    expect(screen.queryByText('历史消息 080')).not.toBeInTheDocument()
    expect(container.querySelectorAll('.message')).toHaveLength(80)
    const chat = container.querySelector<HTMLElement>('.chat')
    if (!chat) {
      throw new Error('Missing chat scroll container')
    }
    Object.defineProperties(chat, {
      clientHeight: { configurable: true, value: 400 },
      scrollHeight: {
        configurable: true,
        get: () => container.querySelectorAll('.message').length * 10
      },
      scrollTop: {
        configurable: true,
        writable: true,
        value: 125
      }
    })

    fireEvent.click(
      screen.getByRole('button', {
        name: '加载更早的消息（还剩 81 条）'
      })
    )

    expect(container.querySelectorAll('.message')).toHaveLength(160)
    expect(screen.getByText('历史消息 001')).toBeInTheDocument()
    expect(screen.queryByText('历史消息 000')).not.toBeInTheDocument()
    expect(chat.scrollTop).toBe(925)
    fireEvent.click(
      screen.getByRole('button', {
        name: '加载更早的消息（还剩 1 条）'
      })
    )
    expect(container.querySelectorAll('.message')).toHaveLength(161)
    expect(screen.getByText('历史消息 000')).toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: /加载更早的消息/u })
    ).not.toBeInTheDocument()
    expect(
      screen.getByText('历史消息 000').closest('article')
    ).toHaveFocus()
  })

  it('keeps the reader position while a response continues below', async () => {
    render(<App />)
    fireEvent.change(await screen.findByLabelText('向 GoodBuddy 提问'), {
      target: { value: '继续生成较长回复' }
    })
    fireEvent.click(screen.getByLabelText('发送'))
    await waitFor(() => expect(run).toHaveBeenCalledOnce())
    const request = run.mock.calls[0]?.[0]
    if (!request) {
      throw new Error('Missing request')
    }
    await act(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => resolve())
        )
    )

    const chat = document.querySelector<HTMLElement>('.chat')
    if (!chat) {
      throw new Error('Missing chat scroll container')
    }
    Object.defineProperties(chat, {
      clientHeight: { configurable: true, value: 400 },
      scrollHeight: { configurable: true, value: 1_200 },
      scrollTop: { configurable: true, writable: true, value: 100 }
    })
    const scrollTo = vi.fn()
    chat.scrollTo = scrollTo
    fireEvent.scroll(chat)

    act(() => {
      agentListener?.({
        requestId: request.requestId,
        type: 'text',
        delta: '新增的回复内容'
      })
    })
    expect(await screen.findByText('新增的回复内容')).toBeInTheDocument()
    await act(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => resolve())
        )
    )

    expect(scrollTo).not.toHaveBeenCalled()
    expect(
      screen.getByRole('button', { name: '到底部' })
    ).toBeInTheDocument()
  })

  it('restores the reader position after activity continues on another page', async () => {
    const { container } = render(<App />)
    fireEvent.change(await screen.findByLabelText('向 GoodBuddy 提问'), {
      target: { value: '离开页面后继续生成' }
    })
    fireEvent.click(screen.getByLabelText('发送'))
    await waitFor(() => expect(run).toHaveBeenCalledOnce())
    const request = run.mock.calls[0]?.[0]
    if (!request) {
      throw new Error('Missing request')
    }
    const conversationList =
      container.querySelector<HTMLElement>('.conversation-list')
    if (!conversationList) {
      throw new Error('Missing conversation list')
    }
    const activeIndicator = within(conversationList).getByRole('status', {
      name: '会话正在活动'
    })
    expect(activeIndicator).toHaveClass(
      'conversation-activity-indicator'
    )
    expect(activeIndicator.closest('.conversation-row')).toHaveTextContent(
      '离开页面后继续生成'
    )
    await act(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => resolve())
        )
    )

    const chat = container.querySelector<HTMLElement>('.chat')
    if (!chat) {
      throw new Error('Missing chat scroll container')
    }
    Object.defineProperties(chat, {
      clientHeight: { configurable: true, value: 400 },
      scrollHeight: { configurable: true, value: 1_200 },
      scrollTop: { configurable: true, writable: true, value: 175 }
    })
    fireEvent.scroll(chat)

    fireEvent.click(screen.getByRole('button', { name: '知识库' }))
    expect(chat).toBeInTheDocument()
    expect(chat.closest('[data-route="chat"]')).toHaveAttribute('hidden')
    expect(
      within(conversationList).getByRole('status', {
        name: '会话正在活动'
      })
    ).toBeInTheDocument()
    act(() => {
      agentListener?.({
        requestId: request.requestId,
        type: 'text',
        delta: '后台新增的回复内容'
      })
    })
    act(() => {
      agentListener?.({
        requestId: request.requestId,
        type: 'done'
      })
    })
    await waitFor(() =>
      expect(
        within(conversationList).queryByRole('status', {
          name: '会话正在活动'
        })
      ).not.toBeInTheDocument()
    )

    fireEvent.click(screen.getByRole('button', { name: '对话' }))
    expect(await screen.findByText('后台新增的回复内容')).toBeInTheDocument()
    const restoredChat = container.querySelector<HTMLElement>('.chat')
    expect(restoredChat).toBe(chat)
    expect(restoredChat?.scrollTop).toBe(175)
    expect(
      screen.getByRole('button', { name: '到底部' })
    ).toBeInTheDocument()
  })

  it('keeps each conversation history window and reader position', async () => {
    const firstConversationId =
      '00000000-0000-4000-8000-000000000461'
    const secondConversationId =
      '00000000-0000-4000-8000-000000000462'
    const draftAttachment = {
      id: '00000000-0000-4000-8000-000000000463',
      name: '第一段草稿附件.md',
      size: 1_024,
      preview: '会话级草稿附件',
      kind: 'text' as const
    }
    vi.mocked(api.context.selectFiles).mockResolvedValueOnce([
      draftAttachment
    ])
    vi.mocked(api.conversations.list).mockResolvedValueOnce([
      {
        id: firstConversationId,
        projectId,
        title: '第一段长会话',
        updatedAt: 1_775_000_000_002,
        messages: Array.from({ length: 161 }, (_, index) => ({
          id: `00000000-0000-4000-8100-${String(index).padStart(12, '0')}`,
          role: index % 2 === 0 ? ('user' as const) : ('assistant' as const),
          content: `第一段历史 ${String(index).padStart(3, '0')}`,
          reasoning: index === 159 ? '需要保留展开状态' : undefined,
          createdAt: 1_775_000_000_000 + index,
          state: 'complete' as const
        }))
      },
      {
        id: secondConversationId,
        projectId,
        title: '第二段会话',
        updatedAt: 1_775_000_000_001,
        messages: [
          {
            id: '00000000-0000-4000-8200-000000000001',
            role: 'assistant',
            content: '第二段会话内容',
            createdAt: 1_775_000_000_001,
            state: 'complete'
          }
        ]
      }
    ])
    const { container } = render(<App />)

    expect(await screen.findByText('第一段历史 160')).toBeInTheDocument()
    fireEvent.click(
      screen.getByRole('button', {
        name: '加载更早的消息（还剩 81 条）'
      })
    )
    const firstPane = container.querySelector<HTMLElement>(
      `[data-conversation-id="${firstConversationId}"]`
    )
    expect(firstPane?.querySelectorAll('.message')).toHaveLength(160)
    const firstChat = firstPane?.querySelector<HTMLElement>('.chat')
    if (!firstChat) {
      throw new Error('Missing first chat scroll container')
    }
    const reasoningDetails = firstPane?.querySelector<HTMLDetailsElement>(
      '.message-reasoning'
    )
    if (!reasoningDetails) {
      throw new Error('Missing reasoning details')
    }
    reasoningDetails.open = true
    Object.defineProperties(firstChat, {
      clientHeight: { configurable: true, value: 400 },
      scrollHeight: { configurable: true, value: 1_600 },
      scrollTop: { configurable: true, writable: true, value: 225 }
    })
    fireEvent.scroll(firstChat)
    fireEvent.change(screen.getByLabelText('向 GoodBuddy 提问'), {
      target: { value: '第一段会话草稿' }
    })
    fireEvent.click(screen.getByLabelText('添加附件'))
    expect(
      await screen.findByText(draftAttachment.name)
    ).toBeInTheDocument()

    fireEvent.click(
      screen.getByText('第二段会话').closest('button')!
    )
    expect(await screen.findByText('第二段会话内容')).toBeInTheDocument()
    expect(screen.getByLabelText('向 GoodBuddy 提问')).toHaveValue('')
    expect(
      screen.queryByText(draftAttachment.name)
    ).not.toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('向 GoodBuddy 提问'), {
      target: { value: '第二段会话草稿' }
    })
    fireEvent.click(
      screen.getByText('第一段长会话').closest('button')!
    )

    expect(await screen.findByText('第一段历史 001')).toBeInTheDocument()
    const restoredFirstPane = container.querySelector<HTMLElement>(
      `[data-conversation-id="${firstConversationId}"]`
    )
    expect(restoredFirstPane).toBe(firstPane)
    expect(restoredFirstPane?.querySelectorAll('.message')).toHaveLength(
      160
    )
    expect(restoredFirstPane?.querySelector('.chat')).toBe(firstChat)
    expect(firstChat.scrollTop).toBe(225)
    expect(reasoningDetails).toHaveAttribute('open')
    expect(screen.getByLabelText('向 GoodBuddy 提问')).toHaveValue(
      '第一段会话草稿'
    )
    expect(screen.getByText(draftAttachment.name)).toBeInTheDocument()
  })

  it('requires an accessible confirmation before permanently deleting a conversation', async () => {
    render(<App />)
    const menuTrigger = screen.getByLabelText(
      '更多会话操作 新对话'
    )
    fireEvent.click(menuTrigger)
    const deleteTrigger = screen.getByRole('button', {
      name: '删除对话 新对话'
    })
    fireEvent.click(deleteTrigger)

    const dialog = screen.getByRole('alertdialog', {
      name: '确认永久删除对话 新对话'
    })
    expect(dialog).toHaveTextContent('将永久删除此会话的全部内容')
    expect(dialog).toHaveTextContent(
      '如果此会话有正在运行的任务，也会同时停止'
    )
    expect(dialog).toHaveTextContent('此操作不可恢复')
    const cancel = screen.getByRole('button', {
      name: '取消删除对话 新对话'
    })
    expect(cancel).toHaveFocus()

    expect(fireEvent.keyDown(dialog, { key: 'Tab' })).toBe(true)
    expect(cancel).toHaveFocus()
    fireEvent.keyDown(dialog, { key: 'Escape' })
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: '删除对话 新对话' })
      ).toHaveFocus()
    )
    expect(
      screen.queryByRole('alertdialog', {
        name: '确认永久删除对话 新对话'
      })
    ).not.toBeInTheDocument()

    fireEvent.click(
      screen.getByRole('button', { name: '删除对话 新对话' })
    )
    fireEvent.click(
      screen.getByRole('button', {
        name: '确认永久删除对话 新对话'
      })
    )
    await waitFor(() =>
      expect(
        screen.queryByRole('alertdialog', {
          name: '确认永久删除对话 新对话'
        })
      ).not.toBeInTheDocument()
    )
    expect(api.conversations.deleteLocal).toHaveBeenCalledWith(
      expect.any(String)
    )
  })

  it('keeps a local conversation visible when deleting its persisted record fails', async () => {
    const conversationId =
      '00000000-0000-4000-8000-000000000431'
    const title = '删除失败时保留的本地会话'
    vi.mocked(api.conversations.list).mockResolvedValueOnce([
      {
        id: conversationId,
        projectId,
        title,
        updatedAt: 1_775_000_000_000,
        messages: [
          {
            id: '00000000-0000-4000-8000-000000000432',
            role: 'assistant',
            content: '需要保留的消息',
            createdAt: 1_775_000_000_000,
            state: 'complete'
          }
        ]
      }
    ])
    vi.mocked(api.conversations.deleteLocal).mockRejectedValueOnce(
      new Error('delete failed')
    )
    render(<App />)

    fireEvent.click(
      await screen.findByLabelText(`更多会话操作 ${title}`)
    )
    fireEvent.click(
      screen.getByRole('button', { name: `删除对话 ${title}` })
    )
    fireEvent.click(
      screen.getByRole('button', {
        name: `确认永久删除对话 ${title}`
      })
    )

    await waitFor(() =>
      expect(api.conversations.deleteLocal).toHaveBeenCalledWith(
        conversationId
      )
    )
    expect(
      await screen.findByText('删除本地会话失败，已保留当前对话')
    ).toBeInTheDocument()
    expect(screen.getByText('需要保留的消息')).toBeInTheDocument()
    const dialog = screen.getByRole('alertdialog', {
      name: `确认永久删除对话 ${title}`
    })
    expect(
      dialog
    ).toBeInTheDocument()
    fireEvent.keyDown(dialog, { key: 'Escape' })
    expect(
      await screen.findByLabelText(`更多会话操作 ${title}`)
    ).toBeInTheDocument()
  })

  it('keeps a conversation when cancelling its active task fails', async () => {
    vi.mocked(api.agent.cancel).mockRejectedValueOnce(
      new Error('cancel failed')
    )
    render(<App />)
    const title = '取消失败时保留会话'

    fireEvent.change(screen.getByLabelText('向 GoodBuddy 提问'), {
      target: { value: title }
    })
    fireEvent.click(await screen.findByLabelText('发送'))
    await waitFor(() => expect(run).toHaveBeenCalledOnce())

    fireEvent.click(
      await screen.findByLabelText(`更多会话操作 ${title}`)
    )
    fireEvent.click(
      screen.getByRole('button', { name: `删除对话 ${title}` })
    )
    const confirm = screen.getByRole('button', {
      name: `确认永久删除对话 ${title}`
    })
    fireEvent.click(confirm)

    await waitFor(() =>
      expect(api.agent.cancel).toHaveBeenCalledOnce()
    )
    expect(
      await screen.findByText('停止会话中的运行任务失败，尚未删除对话')
    ).toBeInTheDocument()
    expect(
      screen.getByRole('alertdialog', {
        name: `确认永久删除对话 ${title}`
      })
    ).toBeInTheDocument()
    await waitFor(() => expect(confirm).toBeEnabled())

    vi.mocked(api.agent.cancel).mockResolvedValueOnce()
    fireEvent.click(confirm)
    await waitFor(() =>
      expect(
        screen.queryByRole('alertdialog', {
          name: `确认永久删除对话 ${title}`
        })
      ).not.toBeInTheDocument()
    )
  })

  it('renders streamed reasoning, text, and tools in event order', async () => {
    render(<App />)

    fireEvent.change(screen.getByLabelText('向 GoodBuddy 提问'), {
      target: { value: '帮我分析项目' }
    })
    await waitFor(() => expect(screen.getByLabelText('发送')).toBeEnabled())
    fireEvent.click(screen.getByLabelText('发送'))

    await waitFor(() => expect(run).toHaveBeenCalledOnce())
    const request = run.mock.calls[0]?.[0]
    expect(request?.prompt).toBe('帮我分析项目')
    expect(request?.runtimeSelection).toEqual({
      provider: 'model',
      profileId: modelProfileId
    })
    expect(
      screen
        .getByText('正在连接 Agent Runtime')
        .querySelector('.message__status-dot')
    ).toHaveClass('message__status-dot--active')
    const userMessage = screen
      .getAllByText('帮我分析项目')
      .map((element) => element.closest('article'))
      .find((element) => element?.classList.contains('message--user'))
    expect(userMessage).toHaveClass('message--user')

    act(() => {
      if (!request) {
        throw new Error('Missing request')
      }
      agentListener?.({
        requestId: request.requestId,
        type: 'text',
        delta: '这是'
      })
      agentListener?.({
        requestId: request.requestId,
        type: 'text',
        delta: '回答内容'
      })
      agentListener?.({
        requestId: request.requestId,
        type: 'reasoning',
        delta: '先检查项目结构'
      })
    })

    expect(await screen.findByText('这是回答内容')).toBeInTheDocument()
    const streamingReasoning = screen
      .getByText('正在推理')
      .closest('details')
    expect(streamingReasoning).toHaveAttribute('open')
    expect(screen.getByText('先检查项目结构')).toBeInTheDocument()
    const reasoningContent =
      streamingReasoning!.querySelector<HTMLElement>(
        '.message-reasoning__content'
      )
    if (!reasoningContent) {
      throw new Error('Missing reasoning content')
    }
    const reasoningScrollTo = vi.fn()
    reasoningContent.scrollTo = reasoningScrollTo
    Object.defineProperty(reasoningContent, 'scrollHeight', {
      configurable: true,
      value: 640
    })

    act(() => {
      if (!request) {
        throw new Error('Missing request')
      }
      agentListener?.({
        requestId: request.requestId,
        type: 'reasoning',
        delta: '，再确认依赖'
      })
    })

    expect(reasoningScrollTo).toHaveBeenLastCalledWith({
      top: 640,
      behavior: 'auto'
    })
    expect(screen.getByText('先检查项目结构，再确认依赖')).toBeInTheDocument()

    act(() => {
      if (!request) {
        throw new Error('Missing request')
      }
      agentListener?.({
        requestId: request.requestId,
        type: 'tool',
        callId: 'call-1',
        name: 'read',
        state: 'running',
        summary: 'OpenCode 工具：read',
        input: '{"path":"README.md"}'
      })
      agentListener?.({
        requestId: request.requestId,
        type: 'tool',
        callId: 'call-2',
        name: 'grep',
        state: 'completed',
        summary: 'OpenCode 工具：grep',
        input: '{"pattern":"runtime"}',
        output: 'src/main/agent/runtime.ts'
      })
      agentListener?.({
        requestId: request.requestId,
        type: 'reasoning',
        delta: '再检查关键文件'
      })
      agentListener?.({
        requestId: request.requestId,
        type: 'text',
        delta: '最终结论'
      })
      agentListener?.({
        requestId: request.requestId,
        type: 'tool',
        callId: 'call-1',
        name: 'read',
        state: 'completed',
        summary: 'OpenCode 工具：read',
        input: '{"path":"README.md"}',
        output:
          'README contents\nAuthorization: Bearer visible-token'
      })
    })

    const assistantArticle = screen
      .getByText('最终结论')
      .closest('article')
    const orderedBlocks = [
      ...assistantArticle!.querySelectorAll('.message-blocks > *')
    ].map((element) => element.textContent)
    expect(orderedBlocks).toEqual([
      expect.stringContaining('这是回答内容'),
      expect.stringContaining('先检查项目结构'),
      expect.stringContaining('OpenCode 工具：read'),
      expect.stringContaining('再检查关键文件'),
      expect.stringContaining('最终结论')
    ])
    expect(
      screen.getAllByText('OpenCode 工具：read')
    ).toHaveLength(1)
    expect(
      screen.getByRole('region', { name: '工具执行，共 2 项' })
    ).toBeInTheDocument()
    const readTool = screen.getByText('read').closest('details')
    const rawToolOutput =
      'README contents\nAuthorization: Bearer visible-token'
    expect(readTool).not.toHaveAttribute('open')
    expect(
      screen.getByText(
        (_, element) => element?.textContent === rawToolOutput
      )
    ).not.toBeVisible()
    fireEvent.click(screen.getByText('read').closest('summary')!)
    expect(readTool).toHaveAttribute('open')
    expect(within(readTool!).getByText('调用参数')).toBeVisible()
    expect(
      within(readTool!).getByText(
        (_, element) => element?.textContent === rawToolOutput
      )
    ).toBeVisible()
    const activeReasoning = screen.getAllByText('正在推理')
    expect(activeReasoning).toHaveLength(2)
    for (const reasoning of activeReasoning) {
      expect(reasoning.closest('details')).toHaveAttribute('open')
    }

    act(() => {
      if (!request) {
        throw new Error('Missing request')
      }
      agentListener?.({
        requestId: request.requestId,
        type: 'done'
      })
    })

    const completedReasoning = await screen.findAllByText('推理过程')
    expect(completedReasoning).toHaveLength(2)
    for (const reasoning of completedReasoning) {
      expect(reasoning.closest('details')).not.toHaveAttribute('open')
    }
    expect(screen.getByText('项目：默认项目')).toHaveClass('scope-badge')
  })

  it('persists only the changed conversation and streamed assistant message', async () => {
    const activeConversationId =
      '00000000-0000-4000-8000-000000000441'
    const activeMessageId =
      '00000000-0000-4000-8000-000000000442'
    const unrelatedConversationId =
      '00000000-0000-4000-8000-000000000443'
    const unrelatedMessageId =
      '00000000-0000-4000-8000-000000000444'
    vi.mocked(api.conversations.list).mockResolvedValueOnce([
      {
        id: activeConversationId,
        projectId,
        title: '增量持久化会话',
        updatedAt: 1_775_000_000_002,
        messages: [
          {
            id: activeMessageId,
            role: 'assistant',
            content: '原有消息',
            createdAt: 1_775_000_000_002,
            state: 'complete'
          }
        ]
      },
      {
        id: unrelatedConversationId,
        projectId,
        title: '无关会话',
        updatedAt: 1_775_000_000_001,
        messages: [
          {
            id: unrelatedMessageId,
            role: 'assistant',
            content: '不应重复保存',
            createdAt: 1_775_000_000_001,
            state: 'complete'
          }
        ]
      }
    ])
    render(<App />)
    expect(await screen.findByText('原有消息')).toBeInTheDocument()

    fireEvent.change(screen.getByLabelText('向 GoodBuddy 提问'), {
      target: { value: '只更新当前会话' }
    })
    fireEvent.click(screen.getByLabelText('发送'))
    await waitFor(() => expect(run).toHaveBeenCalledOnce())
    const request = run.mock.calls[0]?.[0]
    if (!request) {
      throw new Error('Missing request')
    }
    await waitFor(() =>
      expect(api.conversations.saveLocal).toHaveBeenCalled()
    )
    vi.mocked(api.conversations.saveLocal).mockClear()

    act(() => {
      agentListener?.({
        requestId: request.requestId,
        type: 'text',
        delta: '流式增量'
      })
    })

    await waitFor(
      () => {
        const batch = vi
          .mocked(api.conversations.saveLocal)
          .mock.calls.at(-1)?.[0]
        expect(batch).toHaveLength(1)
        expect(batch?.[0]?.header.id).toBe(activeConversationId)
        expect(batch?.[0]?.messages).toEqual([
          expect.objectContaining({
            role: 'assistant',
            content: '流式增量',
            state: 'streaming'
          })
        ])
        expect(
          batch?.some(
            (entry) => entry.header.id === unrelatedConversationId
          )
        ).toBe(false)
        expect(
          batch?.flatMap((entry) => entry.messages).some(
            (message) =>
              message.id === activeMessageId ||
              message.id === unrelatedMessageId ||
              message.role === 'user'
          )
        ).toBe(false)
      },
      { timeout: 2_000 }
    )
  })

  it('flushes pending local conversation changes before quit', async () => {
    const conversationId =
      '00000000-0000-4000-8000-000000000445'
    vi.mocked(api.conversations.list).mockResolvedValueOnce([
      {
        id: conversationId,
        projectId,
        title: '退出持久化会话',
        updatedAt: 1_775_000_000_000,
        messages: [
          {
            id: '00000000-0000-4000-8000-000000000446',
            role: 'assistant',
            content: '已有内容',
            createdAt: 1_775_000_000_000,
            state: 'complete'
          }
        ]
      }
    ])
    render(<App />)
    expect(await screen.findByText('已有内容')).toBeInTheDocument()
    vi.mocked(api.conversations.saveLocal).mockClear()

    fireEvent.change(screen.getByLabelText('向 GoodBuddy 提问'), {
      target: { value: '退出前必须保存' }
    })
    fireEvent.click(screen.getByLabelText('发送'))
    expect(
      await screen.findByText('退出前必须保存')
    ).toBeInTheDocument()
    if (!beforeQuitListener) {
      throw new Error('Missing before-quit persistence listener')
    }

    await act(async () => beforeQuitListener?.())

    expect(api.conversations.saveLocal).toHaveBeenCalledWith([
      expect.objectContaining({
        header: expect.objectContaining({ id: conversationId }),
        messages: expect.arrayContaining([
          expect.objectContaining({
            role: 'user',
            content: '退出前必须保存',
            state: 'complete'
          })
        ])
      })
    ])
  })

  it('replaces the direct-model thinking status with real reasoning', async () => {
    render(<App />)

    fireEvent.change(screen.getByLabelText('向 GoodBuddy 提问'), {
      target: { value: '分析这个问题' }
    })
    const send = await screen.findByLabelText('发送')
    await waitFor(() => expect(send).toBeEnabled())
    fireEvent.click(send)
    await waitFor(() => expect(run).toHaveBeenCalledOnce())
    const request = run.mock.calls[0]?.[0]
    if (!request) {
      throw new Error('Missing request')
    }

    act(() => {
      agentListener?.({
        requestId: request.requestId,
        type: 'status',
        message: 'deepseek-v4-flash 正在思考'
      })
    })
    expect(
      screen.getByText('deepseek-v4-flash 正在思考')
    ).toBeInTheDocument()

    act(() => {
      agentListener?.({
        requestId: request.requestId,
        type: 'reasoning',
        delta: '正在分析真实推理内容'
      })
    })

    expect(
      screen.queryByText('deepseek-v4-flash 正在思考')
    ).not.toBeInTheDocument()
    expect(screen.getByText('正在推理').closest('details')).toHaveAttribute(
      'open'
    )
    expect(screen.getByText('正在分析真实推理内容')).toBeVisible()
  })

  it('updates context usage after model responses and keeps compression status', async () => {
    const settings = await api.settings.getRuntime()
    vi.mocked(api.settings.getRuntime).mockResolvedValueOnce({
      ...settings,
      provider: 'model',
      modelProfiles: settings.modelProfiles.map((profile) => ({
        ...profile,
        contextWindowTokens: 32_000
      })),
      contextCompression: {
        enabled: true,
        triggerTokens: 200_000,
        recentRawTokens: 32_000,
        modelSource: { kind: 'current' },
        summaryPrompt: 'Preserve important facts.'
      }
    })
    render(<App />)

    await screen.findByLabelText('向 GoodBuddy 提问')
    expect(
      screen.queryByRole('progressbar', {
        name: '当前上下文使用量'
      })
    ).not.toBeInTheDocument()
    expect(
      screen.queryByText('只读问答，不修改文件')
    ).not.toBeInTheDocument()
    expect(
      await screen.findByText('快捷唤起：', { exact: false })
    ).toHaveTextContent('快捷唤起：Ctrl+Shift+Space')

    fireEvent.change(screen.getByLabelText('向 GoodBuddy 提问'), {
      target: { value: '中'.repeat(1_000) }
    })
    expect(
      screen.queryByRole('progressbar', {
        name: '当前上下文使用量'
      })
    ).not.toBeInTheDocument()
    fireEvent.click(screen.getByLabelText('发送'))
    await waitFor(() => expect(run).toHaveBeenCalledOnce())
    const request = run.mock.calls[0]?.[0]
    if (!request) {
      throw new Error('Missing request')
    }

    act(() => {
      agentListener?.({
        requestId: request.requestId,
        type: 'context-metrics',
        contextTokens: 22_000,
        effectiveTriggerTokens: 20_000,
        contextWindowTokens: 32_000,
        compressionEnabled: true,
        source: 'provider'
      })
    })
    expect(
      screen.getByText('本次调用 22.0K / 32.0K · 69%')
    ).toBeInTheDocument()

    act(() => {
      agentListener?.({
        requestId: request.requestId,
        type: 'context-compression',
        scope: 'conversation',
        state: 'started',
        estimatedBeforeTokens: 22_000,
        effectiveTriggerTokens: 20_000,
        contextWindowTokens: 32_000,
        recentRawTokens: 32_000,
        coveredMessageCount: 2
      })
    })
    expect(
      screen.getByText('正在压缩较早对话…')
    ).toBeInTheDocument()

    act(() => {
      agentListener?.({
        requestId: request.requestId,
        type: 'status',
        message: 'sonnet-5 正在思考'
      })
    })
    expect(
      screen.getByText('正在压缩较早对话…')
    ).toBeInTheDocument()
    expect(screen.getByText('sonnet-5 正在思考')).toBeInTheDocument()

    act(() => {
      agentListener?.({
        requestId: request.requestId,
        type: 'context-compression',
        scope: 'conversation',
        state: 'completed',
        estimatedBeforeTokens: 22_000,
        estimatedAfterTokens: 9_000,
        effectiveTriggerTokens: 20_000,
        contextWindowTokens: 32_000,
        recentRawTokens: 32_000,
        coveredMessageCount: 2,
        summaryTokens: 1_000
      })
    })

    expect(
      screen.getByText(
        '已压缩较早对话（估算） · ≈22.0K → ≈9.0K'
      )
    ).toBeInTheDocument()
    expect(
      screen.getByText(
        '压缩后对话估算 ≈9.0K / 32.0K · 28%'
      )
    ).toBeInTheDocument()

    act(() => {
      agentListener?.({
        requestId: request.requestId,
        type: 'context-compression',
        scope: 'agent-run',
        state: 'started',
        estimatedBeforeTokens: 24_000,
        effectiveTriggerTokens: 20_000,
        contextWindowTokens: 32_000,
        recentRawTokens: 4_000,
        compressionCount: 1
      })
    })
    expect(
      screen.getByText('正在整理 Agent 执行上下文…')
    ).toBeInTheDocument()

    act(() => {
      agentListener?.({
        requestId: request.requestId,
        type: 'context-compression',
        scope: 'agent-run',
        state: 'completed',
        estimatedBeforeTokens: 24_000,
        estimatedAfterTokens: 11_000,
        effectiveTriggerTokens: 20_000,
        contextWindowTokens: 32_000,
        recentRawTokens: 4_000,
        compressionCount: 2
      })
    })
    expect(
      screen.getByText(
        'Agent 执行期间已压缩上下文 2 次（估算） · ≈24.0K → ≈11.0K'
      )
    ).toBeInTheDocument()
    expect(
      screen.getByText(
        '已压缩较早对话（估算） · ≈22.0K → ≈9.0K'
      )
    ).toBeInTheDocument()
    expect(
      screen.getByText(
        '压缩后对话估算 ≈9.0K / 32.0K · 28%'
      )
    ).toBeInTheDocument()

    act(() => {
      agentListener?.({
        requestId: request.requestId,
        type: 'context-compression',
        scope: 'conversation',
        state: 'completed',
        estimatedBeforeTokens: 24_000,
        estimatedAfterTokens: 8_500,
        effectiveTriggerTokens: 20_000,
        contextWindowTokens: 32_000,
        recentRawTokens: 4_000,
        coveredMessageCount: 4
      })
    })
    expect(
      screen.getByText(
        'Agent 执行期间已压缩上下文 2 次（估算） · ≈24.0K → ≈11.0K'
      )
    ).toBeInTheDocument()
    expect(
      screen.getByText(
        '已压缩较早对话（估算） · ≈24.0K → ≈8.5K'
      )
    ).toBeInTheDocument()
    expect(
      screen.getByText(
        '压缩后对话估算 ≈8.5K / 32.0K · 27%'
      )
    ).toBeInTheDocument()
    expect(
      Array.from(
        document.querySelectorAll(
          '.context-compression-event__label'
        )
      ).map((element) => element.textContent)
    ).toEqual([
      'Agent 执行期间已压缩上下文 2 次（估算） · ≈24.0K → ≈11.0K',
      '已压缩较早对话（估算） · ≈24.0K → ≈8.5K'
    ])
    act(() => {
      agentListener?.({
        requestId: request.requestId,
        type: 'done'
      })
    })
    expect(
      screen.getByText(
        'Agent 执行期间已压缩上下文 2 次（估算） · ≈24.0K → ≈11.0K'
      )
    ).toBeInTheDocument()
  })

  it('does not present the compression threshold as a context-window percentage', async () => {
    const settings = await api.settings.getRuntime()
    vi.mocked(api.settings.getRuntime).mockResolvedValueOnce({
      ...settings,
      provider: 'model',
      modelProfiles: settings.modelProfiles.map((profile) => ({
        ...profile,
        contextWindowTokens: undefined
      })),
      contextCompression: {
        enabled: true,
        triggerTokens: 12_000,
        recentRawTokens: 4_000,
        modelSource: { kind: 'current' },
        summaryPrompt: 'Preserve important facts.'
      }
    })
    render(<App />)

    fireEvent.change(await screen.findByLabelText('向 GoodBuddy 提问'), {
      target: { value: '检查上下文显示' }
    })
    fireEvent.click(screen.getByLabelText('发送'))
    await waitFor(() => expect(run).toHaveBeenCalledOnce())
    const request = run.mock.calls[0]?.[0]
    if (!request) {
      throw new Error('Missing request')
    }
    act(() => {
      agentListener?.({
        requestId: request.requestId,
        type: 'context-metrics',
        contextTokens: 22_000,
        effectiveTriggerTokens: 20_000,
        compressionEnabled: true,
        source: 'provider'
      })
    })

    expect(
      screen.getByText('本次调用 22.0K · 压缩线 12.0K')
    ).toBeInTheDocument()
    expect(
      screen.queryByRole('progressbar', {
        name: '当前上下文使用量'
      })
    ).not.toBeInTheDocument()
    expect(screen.queryByText('110%')).not.toBeInTheDocument()

    act(() => {
      agentListener?.({
        requestId: request.requestId,
        type: 'context-compression',
        scope: 'conversation',
        state: 'completed',
        estimatedBeforeTokens: 22_000,
        estimatedAfterTokens: 9_400,
        effectiveTriggerTokens: 20_000,
        recentRawTokens: 4_000,
        coveredMessageCount: 2
      })
    })

    expect(
      screen.getByText(
        '压缩后对话估算 ≈9.4K · 压缩线 12.0K'
      )
    ).toBeInTheDocument()
    expect(
      screen.queryByText('本次调用 22.0K · 压缩线 12.0K')
    ).not.toBeInTheDocument()
  })

  it('updates the composer compression line immediately after settings change', async () => {
    const settings = await api.settings.getRuntime()
    const initialSettings = {
      ...settings,
      provider: 'model' as const,
      modelProfiles: settings.modelProfiles.map((profile) => ({
        ...profile,
        contextWindowTokens: undefined
      })),
      contextCompression: {
        enabled: true,
        triggerTokens: 20_000,
        recentRawTokens: 4_000,
        modelSource: { kind: 'current' as const },
        summaryPrompt: 'Preserve important facts.'
      }
    }
    vi.mocked(api.settings.getRuntime)
      .mockResolvedValueOnce(initialSettings)
      .mockResolvedValueOnce(initialSettings)
    vi.mocked(api.settings.updateRuntime).mockImplementationOnce(
      async (input) => ({
        ...initialSettings,
        contextCompression:
          input.contextCompression ??
          initialSettings.contextCompression
      })
    )
    render(<App />)

    fireEvent.change(await screen.findByLabelText('向 GoodBuddy 提问'), {
      target: { value: '检查压缩线设置刷新' }
    })
    fireEvent.click(screen.getByLabelText('发送'))
    await waitFor(() => expect(run).toHaveBeenCalledOnce())
    const request = run.mock.calls[0]?.[0]
    if (!request) {
      throw new Error('Missing request')
    }
    act(() => {
      agentListener?.({
        requestId: request.requestId,
        type: 'context-metrics',
        contextTokens: 9_000,
        effectiveTriggerTokens: 20_000,
        compressionEnabled: true,
        source: 'provider'
      })
    })
    expect(
      screen.getByText('本次调用 9.0K · 压缩线 20.0K')
    ).toBeInTheDocument()
    act(() => {
      agentListener?.({
        requestId: request.requestId,
        type: 'done'
      })
    })

    fireEvent.click(
      screen.getByRole('button', { name: /本地工作区/u })
    )
    await screen.findByRole('heading', { name: '设置中心' })
    fireEvent.click(
      screen.getByRole('tab', { name: '上下文控制' })
    )
    const trigger = await screen.findByLabelText('压缩触发阈值')
    fireEvent.change(trigger, { target: { value: '12' } })
    fireEvent.click(screen.getByRole('button', { name: '保存设置' }))
    await waitFor(() =>
      expect(api.settings.updateRuntime).toHaveBeenCalledWith(
        expect.objectContaining({
          contextCompression: expect.objectContaining({
            triggerTokens: 12_000
          })
        })
      )
    )

    fireEvent.click(screen.getByRole('button', { name: '对话' }))
    expect(
      await screen.findByText('本次调用 9.0K · 压缩线 12.0K')
    ).toBeInTheDocument()
  })

  it('guards sidebar navigation away from dirty Settings drafts', async () => {
    render(<App />)

    fireEvent.click(await screen.findByText('本地工作区'))
    await screen.findByRole('heading', { name: '设置中心' })
    fireEvent.change(await screen.findByLabelText('默认工作区目录'), {
      target: { value: 'C:\\Unsaved from App' }
    })
    fireEvent.click(
      screen.getByRole('button', { name: '知识库' })
    )

    expect(
      screen.getByRole('heading', { name: '设置中心' })
    ).toBeVisible()
    expect(screen.getByRole('alert')).toHaveTextContent(
      '当前设置有未保存更改'
    )
    fireEvent.click(
      screen.getByRole('button', { name: '放弃更改并关闭' })
    )
    expect(
      await screen.findByRole('heading', { name: '知识库' })
    ).toBeVisible()
  })

  it('updates and removes the composer shortcut hint immediately after saving Settings', async () => {
    let applicationSettings: ApplicationSettings = {
      checkUpdatesOnStartup: false,
      updateSource: 'github',
      modelDownloadSource: 'modelscope',
      magicNotesEnabled: false,
      magicNotesShowIncompleteTodoCount: true,
      magicNoteCommentMode: 'immediate',
      magicNoteCommentFormat: 'combined'
    }
    let shortcutSnapshot: GlobalShortcutSettingsSnapshot = {
      settings: {
        enabled: true,
        accelerator: 'CommandOrControl+Shift+Space'
      },
      defaultSettings: {
        enabled: true,
        accelerator: 'CommandOrControl+Shift+Space'
      },
      platform: 'win32',
      displayAccelerator: 'Ctrl+Shift+Space',
      registered: true,
      registeredAccelerator: 'CommandOrControl+Shift+Space',
      status: 'registered'
    }
    api.updates = {
      getSettings: vi.fn(async () => ({ ...applicationSettings })),
      updateSettings: vi.fn(async (input) => {
        applicationSettings = { ...applicationSettings, ...input }
        return { ...applicationSettings }
      }),
      check: vi.fn(),
      openReleasePage: vi.fn(async () => {}),
      onResult: vi.fn(() => () => {})
    }
    api.shortcuts = {
      getSettings: vi.fn(async () => shortcutSnapshot),
      updateSettings: vi.fn(async (input) => {
        shortcutSnapshot = {
          ...shortcutSnapshot,
          settings: input,
          displayAccelerator:
            input.accelerator === 'Control+Alt+K'
              ? 'Ctrl+Alt+K'
              : 'Ctrl+Shift+Space',
          registered: input.enabled,
          registeredAccelerator: input.enabled
            ? input.accelerator
            : undefined,
          status: input.enabled ? 'registered' : 'disabled'
        }
        return { ok: true as const, snapshot: shortcutSnapshot }
      })
    }
    try {
      render(<App />)
      expect(
        await screen.findByText('Ctrl+Shift+Space')
      ).toBeInTheDocument()
      fireEvent.click(await screen.findByText('本地工作区'))
      await screen.findByRole('heading', { name: '设置中心' })
      fireEvent.click(screen.getByRole('tab', { name: '平台功能' }))
      const shortcutInput = await screen.findByLabelText('快捷键')
      fireEvent.change(shortcutInput, {
        target: { value: 'Control+Alt+K' }
      })
      fireEvent.click(
        screen.getByRole('button', { name: '保存快捷键' })
      )
      await waitFor(() =>
        expect(api.shortcuts?.updateSettings).toHaveBeenCalledWith({
          enabled: true,
          accelerator: 'Control+Alt+K'
        })
      )
      fireEvent.click(screen.getByRole('button', { name: '对话' }))
      expect(await screen.findByText('Ctrl+Alt+K')).toBeInTheDocument()

      fireEvent.click(await screen.findByText('本地工作区'))
      await screen.findByRole('heading', { name: '设置中心' })
      fireEvent.click(screen.getByRole('tab', { name: '平台功能' }))
      const shortcutSwitch = await screen.findByRole('switch', {
        name: '启用全局快捷键'
      })
      fireEvent.click(shortcutSwitch)
      fireEvent.click(
        screen.getByRole('button', { name: '保存快捷键' })
      )
      await waitFor(() =>
        expect(api.shortcuts?.updateSettings).toHaveBeenCalledWith({
          enabled: false,
          accelerator: 'Control+Alt+K'
        })
      )
      fireEvent.click(screen.getByRole('button', { name: '对话' }))
      await screen.findByLabelText('向 GoodBuddy 提问')
      expect(
        screen.queryByText('Ctrl+Alt+K')
      ).not.toBeInTheDocument()
    } finally {
      delete api.shortcuts
      delete api.updates
    }
  })

  it('restores persisted context usage and compression state after restart', async () => {
    const settings = await api.settings.getRuntime()
    const profile = settings.modelProfiles[0]!
    const conversationId =
      '00000000-0000-4000-8000-000000000451'
    const compressionState = {
      coveredHistoryDigest: 'a'.repeat(64),
      coveredMessageCount: 2,
      coveredFromMessageId:
        '00000000-0000-4000-8000-000000000452',
      coveredThroughMessageId:
        '00000000-0000-4000-8000-000000000453',
      summary: 'Persisted conversation summary'
    }
    vi.mocked(api.settings.getRuntime).mockResolvedValueOnce({
      ...settings,
      provider: 'model',
      defaultModelProfileId: profile.id,
      modelProfiles: settings.modelProfiles.map((candidate) => ({
        ...candidate,
        contextWindowTokens: undefined
      })),
      contextCompression: {
        enabled: true,
        triggerTokens: 12_000,
        recentRawTokens: 4_000,
        modelSource: { kind: 'current' },
        summaryPrompt: 'Preserve important facts.'
      }
    })
    vi.mocked(api.conversations.list).mockResolvedValueOnce([
      {
        id: conversationId,
        projectId,
        runtimeSelection: {
          provider: 'model',
          profileId: profile.id
        },
        contextMetrics: {
          runtimeSelectionKey: `model:${profile.id}`,
          contextTokens: 9_000,
          source: 'estimated',
          basis: 'conversation'
        },
        contextCompressionState: compressionState,
        title: '已压缩会话',
        updatedAt: 1_775_000_000_000,
        messages: [
          {
            id: '00000000-0000-4000-8000-000000000452',
            role: 'user',
            content: '此前问题',
            createdAt: 1_775_000_000_000,
            state: 'complete'
          },
          {
            id: '00000000-0000-4000-8000-000000000453',
            role: 'assistant',
            content: '此前回答',
            createdAt: 1_775_000_000_001,
            state: 'complete',
            contextCompression: {
              state: 'completed',
              scope: 'conversation',
              estimatedBeforeTokens: 22_000,
              estimatedAfterTokens: 9_000
            }
          }
        ]
      }
    ])
    render(<App />)

    expect(
      await screen.findByText(
        '压缩后对话估算 ≈9.0K · 压缩线 12.0K'
      )
    ).toBeInTheDocument()
    expect(
      screen.getByText(
        '已压缩较早对话（估算） · ≈22.0K → ≈9.0K'
      )
    ).toBeInTheDocument()

    fireEvent.change(screen.getByLabelText('向 GoodBuddy 提问'), {
      target: { value: '继续工作' }
    })
    fireEvent.click(screen.getByLabelText('发送'))
    await waitFor(() => expect(run).toHaveBeenCalledOnce())
    expect(run.mock.calls[0]?.[0].contextCompressionState).toEqual(
      compressionState
    )
    expect(run.mock.calls[0]?.[0]).toMatchObject({
      historyMessageIds: [
        '00000000-0000-4000-8000-000000000452',
        '00000000-0000-4000-8000-000000000453'
      ],
      currentUserMessageId: expect.any(String),
      currentAssistantMessageId: expect.any(String)
    })
  })

  it('keeps a tool failure in details and hides retry after continuing', async () => {
    render(<App />)

    fireEvent.change(screen.getByLabelText('向 GoodBuddy 提问'), {
      target: { value: '读取演示文稿' }
    })
    fireEvent.click(await screen.findByLabelText('发送'))
    await waitFor(() => expect(run).toHaveBeenCalledOnce())
    const request = run.mock.calls[0]?.[0]
    if (!request) {
      throw new Error('Missing request')
    }
    const toolError =
      'Cannot read binary file: D:\\workspace\\presentation.pptx'
    const runtimeError = `OpenCode 工具执行失败（call-1）：${toolError}`

    act(() => {
      agentListener?.({
        requestId: request.requestId,
        type: 'tool',
        callId: 'call-1',
        name: 'read',
        state: 'failed',
        summary: 'OpenCode 工具：read',
        input: '{"path":"D:\\\\workspace\\\\presentation.pptx"}',
        error: toolError
      })
      agentListener?.({
        requestId: request.requestId,
        type: 'error',
        status: 'failed',
        message: runtimeError
      })
    })

    expect(screen.getByText(toolError)).toBeInTheDocument()
    expect(screen.queryByText(runtimeError)).not.toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: '重新编辑并发送' })
    ).toBeInTheDocument()

    fireEvent.change(screen.getByLabelText('向 GoodBuddy 提问'), {
      target: { value: '继续处理' }
    })
    fireEvent.click(screen.getByLabelText('发送'))
    await waitFor(() => expect(run).toHaveBeenCalledTimes(2))

    expect(
      screen.queryByRole('button', { name: '重新编辑并发送' })
    ).not.toBeInTheDocument()
  })

  it('submits knowledge scope without eager search or prompt injection and merges runtime references', async () => {
    const libraryId = '11111111-1111-4111-8111-111111111111'
    vi.mocked(api.knowledge.getSnapshot).mockResolvedValueOnce({
      libraries: [
        {
          id: libraryId,
          name: '产品知识',
          description: '',
          storageMode: 'managed',
          graphEnabled: false,
          graphStrategy: 'rules',
          sourceCount: 1,
          documentCount: 1,
          indexedDocumentCount: 1
        }
      ],
      sources: [],
      documents: [],
      graphNodes: [],
      graphRelations: [],
      evidence: []
    })
    render(<App />)
    const knowledgeScopeTrigger = await screen.findByRole('button', {
      name: '选择知识库，本次已启用 1 个'
    })
    expect(knowledgeScopeTrigger).toHaveAttribute(
      'aria-haspopup',
      'dialog'
    )
    fireEvent.click(knowledgeScopeTrigger)
    expect(knowledgeScopeTrigger).toHaveAttribute(
      'aria-expanded',
      'true'
    )
    expect(
      screen.getByRole('dialog', {
        name: '本次对话检索范围'
      })
    ).toBeInTheDocument()
    await waitFor(() =>
      expect(
        screen.getByRole('checkbox', { name: /产品知识/u })
      ).toHaveFocus()
    )
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' })
    expect(knowledgeScopeTrigger).toHaveAttribute(
      'aria-expanded',
      'false'
    )
    expect(knowledgeScopeTrigger).toHaveFocus()

    fireEvent.click(knowledgeScopeTrigger)
    const scopeCheckbox = screen.getByRole('checkbox', {
      name: /产品知识/u
    })
    await waitFor(() => expect(scopeCheckbox).toHaveFocus())
    const composerInput = screen.getByLabelText('向 GoodBuddy 提问')
    fireEvent.focusOut(scopeCheckbox, {
      relatedTarget: composerInput
    })
    composerInput.focus()
    expect(knowledgeScopeTrigger).toHaveAttribute(
      'aria-expanded',
      'false'
    )
    expect(composerInput).toHaveFocus()

    fireEvent.change(composerInput, {
      target: { value: '发布流程是什么？' }
    })
    fireEvent.click(await screen.findByLabelText('发送'))
    await waitFor(() => expect(run).toHaveBeenCalledOnce())
    const request = run.mock.calls[0]?.[0]
    expect(request).toMatchObject({
      prompt: '发布流程是什么？',
      knowledgeLibraryIds: [libraryId],
      knowledgeRetrievalMode: 'auto'
    })
    expect(api.knowledge.search).not.toHaveBeenCalled()
    expect(
      screen.queryByText(/查看 \d+ 条证据引用/u)
    ).not.toBeInTheDocument()

    act(() => {
      if (!request) {
        throw new Error('Missing request')
      }
      for (let batch = 0; batch < 5; batch += 1) {
        agentListener?.({
          requestId: request.requestId,
          type: 'source-references',
          references: Array.from({ length: 25 }, (_, index) => ({
            libraryId,
            libraryName: '产品知识',
            documentId: crypto.randomUUID(),
            chunkId: crypto.randomUUID(),
            documentName: `发布手册 ${batch}-${index}`,
            sourceName: `release-${batch}-${index}.md`,
            locator: `第 ${batch}-${index} 节`,
            snippet: `证据 ${batch}-${index}`,
            rank: index + 1
          }))
        })
      }
      agentListener?.({
        requestId: request.requestId,
        type: 'done'
      })
    })
    expect(
      await screen.findByText('查看 20 条证据引用')
    ).toBeInTheDocument()
    vi.mocked(api.knowledge.getReferenceContext).mockResolvedValueOnce({
      knowledgeBaseId: libraryId,
      documentId: 'document-context',
      chunkId: 'chunk-context',
      documentTitle: '发布手册',
      sourceDisplayName: 'release.md',
      locator: '第 4 节',
      matchedContent: '命中分块内容',
      contextContent: '上文\n\n命中分块内容\n\n下文',
      contextChunkIds: ['chunk-context'],
      truncated: false
    })
    fireEvent.click(screen.getByText('查看 20 条证据引用'))
    fireEvent.click(
      screen.getAllByRole('button', { name: '查看上下文' })[0]!
    )
    expect(
      await screen.findByRole('dialog', { name: '引用上下文' })
    ).toBeInTheDocument()
    expect(api.knowledge.getReferenceContext).toHaveBeenCalledWith(
      expect.objectContaining({
        knowledgeBaseId: libraryId
      })
    )
    fireEvent.click(
      screen.getAllByRole('button', {
        name: '关闭引用上下文'
      })[0]!
    )
    await waitFor(
      () => {
        const persistedMessages = vi
          .mocked(api.conversations.saveLocal)
          .mock.calls.flatMap(([batch]) =>
            batch.flatMap((conversation) => conversation.messages)
          )
        const persisted = persistedMessages
          .filter((message) => message.role === 'assistant')
          .slice()
          .reverse()
          .find(
            (message) => message.sourceReferences?.length === 20
          )
        expect(persisted?.sourceReferences).toHaveLength(20)
        expect(persisted?.sources).toBeUndefined()
      },
      { timeout: 2_000 }
    )
  })

  it('persists and submits always-retrieve mode for the active conversation', async () => {
    const libraryId = '11111111-1111-4111-8111-111111111111'
    vi.mocked(api.knowledge.getSnapshot).mockResolvedValueOnce({
      libraries: [
        {
          id: libraryId,
          name: '产品知识',
          description: '',
          storageMode: 'managed',
          graphEnabled: false,
          graphStrategy: 'rules',
          sourceCount: 1,
          documentCount: 1,
          indexedDocumentCount: 1
        }
      ],
      sources: [],
      documents: [],
      graphNodes: [],
      graphRelations: [],
      evidence: []
    })
    render(<App />)
    const knowledgeScope = await screen.findByRole('button', {
      name: '选择知识库，本次已启用 1 个'
    })
    fireEvent.click(knowledgeScope)
    const retrievalMode = screen.getByRole('group', {
      name: '知识检索方式'
    })
    fireEvent.click(
      within(retrievalMode).getByRole('button', {
        name: '每次先检索'
      })
    )

    fireEvent.change(screen.getByLabelText('向 GoodBuddy 提问'), {
      target: { value: '必须查询发布流程' }
    })
    fireEvent.click(screen.getByLabelText('发送'))
    await waitFor(() => expect(run).toHaveBeenCalledOnce())

    expect(run.mock.calls[0]?.[0]).toMatchObject({
      prompt: '必须查询发布流程',
      knowledgeLibraryIds: [libraryId],
      knowledgeRetrievalMode: 'always'
    })
    const request = run.mock.calls[0]?.[0]
    if (!request) {
      throw new Error('Missing request')
    }
    act(() => {
      agentListener?.({
        requestId: request.requestId,
        type: 'knowledge-retrieval',
        mode: 'always',
        state: 'degraded',
        libraryCount: 1,
        resultCount: 2,
        durationMs: 18,
        usedChannels: ['fts', 'cjk'],
        warnings: ['向量模型未配置']
      })
    })
    expect(
      await screen.findByText('知识检索已降级')
    ).toBeInTheDocument()
    expect(
      screen.getByText(/已检索 1 个知识库，获得 2 条结果/u)
    ).toBeInTheDocument()
    expect(screen.getByText('向量模型未配置')).toBeInTheDocument()
    await waitFor(() => {
      const snapshots = vi
        .mocked(api.conversations.saveLocal)
        .mock.calls.flatMap(([batch]) => batch)
      expect(
        snapshots?.some(
          (conversation) =>
            conversation.header.knowledgeRetrievalMode === 'always'
        )
      ).toBe(true)
    })
  })

  it('keeps a running response visible when cancellation fails', async () => {
    vi.mocked(api.agent.cancel).mockRejectedValueOnce(
      new Error('cancel failed')
    )
    render(<App />)

    fireEvent.change(screen.getByLabelText('向 GoodBuddy 提问'), {
      target: { value: '开始一个长任务' }
    })
    fireEvent.click(await screen.findByLabelText('发送'))
    await waitFor(() => expect(run).toHaveBeenCalledOnce())

    fireEvent.click(await screen.findByLabelText('停止生成'))

    await waitFor(() =>
      expect(api.agent.cancel).toHaveBeenCalledOnce()
    )
    expect(
      await screen.findByText(/停止生成失败，请重试/u)
    ).toBeInTheDocument()
    expect(screen.getByLabelText('停止生成')).toBeInTheDocument()
    vi.useFakeTimers()
    try {
      act(() => vi.advanceTimersByTime(10_000))
      expect(
        screen.getByText(/停止生成失败，请重试/u)
      ).toBeInTheDocument()
      fireEvent.click(
        screen.getByRole('button', {
          name: '关闭通知'
        })
      )
      expect(
        screen.queryByText(/停止生成失败，请重试/u)
      ).not.toBeInTheDocument()
    } finally {
      vi.useRealTimers()
    }
  })

  it('locks agent context controls while a response is running', async () => {
    render(<App />)

    const expertButton = composerMenuTrigger('专家角色')
    const modeButton = composerMenuTrigger('工作模式')
    const runtimeButton = await screen.findByRole('button', {
      name: /sonnet-5/u
    })
    expect(expertButton).toBeEnabled()
    expect(modeButton).toBeEnabled()
    expect(runtimeButton).toBeEnabled()

    fireEvent.change(screen.getByLabelText('向 GoodBuddy 提问'), {
      target: { value: '检查运行上下文锁定' }
    })
    openComposerMenu('专家角色')
    fireEvent.click(await screen.findByLabelText('发送'))
    await waitFor(() => expect(run).toHaveBeenCalledOnce())

    expect(
      screen.queryByRole('menu', { name: '专家角色' })
    ).not.toBeInTheDocument()
    expect(expertButton).toBeDisabled()
    expect(modeButton).toBeDisabled()
    expect(runtimeButton).toBeDisabled()

    const request = run.mock.calls[0]?.[0]
    act(() => {
      if (!request) {
        throw new Error('Missing request')
      }
      agentListener?.({
        requestId: request.requestId,
        type: 'done'
      })
    })

    await waitFor(() => expect(expertButton).toBeEnabled())
    expect(modeButton).toBeEnabled()
    expect(runtimeButton).toBeEnabled()
  })

  it('queues another ordinary message while the Conversation is running', async () => {
    render(<App />)

    fireEvent.change(screen.getByLabelText('向 GoodBuddy 提问'), {
      target: { value: '第一条长消息' }
    })
    fireEvent.click(await screen.findByLabelText('发送'))
    await waitFor(() => expect(run).toHaveBeenCalledOnce())

    const secondItem = {
      id: '00000000-0000-4000-8000-000000000941',
      conversationId: run.mock.calls[0]![0].conversationId,
      source: 'user' as const,
      label: '第二条排队消息',
      createdAt: '2026-08-20T09:01:00.000Z'
    }
    vi.mocked(api.conversationQueue.enqueueUser)
      .mockResolvedValueOnce(secondItem)
    fireEvent.change(screen.getByLabelText('向 GoodBuddy 提问'), {
      target: { value: secondItem.label }
    })
    fireEvent.click(
      await screen.findByLabelText('加入待发送队列')
    )

    await waitFor(() =>
      expect(api.conversationQueue.enqueueUser).toHaveBeenCalledTimes(2)
    )
    expect(run).toHaveBeenCalledTimes(1)
    expect(
      screen.queryByText(/当前对话已有任务正在运行/u)
    ).not.toBeInTheDocument()

    const firstRequest = run.mock.calls[0]![0]
    act(() => {
      agentListener?.({
        requestId: firstRequest.requestId,
        type: 'done'
      })
    })
    const secondInput = vi.mocked(
      api.conversationQueue.enqueueUser
    ).mock.calls[1]![0]
    act(() => {
      conversationQueueDispatchListener?.({
        item: secondItem,
        input: secondInput
      })
    })

    await waitFor(() => expect(run).toHaveBeenCalledTimes(2))
    expect(run.mock.calls[1]![0]).toMatchObject({
      queueItemId: secondItem.id,
      prompt: secondItem.label
    })
  })

  it('restores a queued message when Agent preflight rejects it', async () => {
    run.mockRejectedValueOnce(new Error('Runtime 暂不可用'))
    render(<App />)

    fireEvent.change(screen.getByLabelText('向 GoodBuddy 提问'), {
      target: { value: '需要稍后重试的消息' }
    })
    fireEvent.click(await screen.findByLabelText('发送'))

    await waitFor(() =>
      expect(api.conversationQueue.releaseUser).toHaveBeenCalledOnce()
    )
    expect(
      await screen.findByText('Runtime 暂不可用')
    ).toBeInTheDocument()
    expect(
      screen.queryByText('需要稍后重试的消息')
    ).not.toBeInTheDocument()
    expect(
      screen.queryByLabelText('停止生成')
    ).not.toBeInTheDocument()
  })

  it('keeps sent documents and images in conversation history', async () => {
    const documentAttachment = {
      id: '00000000-0000-4000-8000-000000000301',
      name: '需求说明.md',
      size: 2_048,
      preview: '需要保留在用户消息中的文档',
      kind: 'text' as const
    }
    const imageAttachment = {
      id: '00000000-0000-4000-8000-000000000302',
      name: '页面截图.png',
      size: 4_096,
      preview: '1280 × 720',
      kind: 'image' as const,
      thumbnailUrl:
        'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB',
      contentUrl:
        'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEASABIAAD/2Q=='
    }
    vi.mocked(api.context.selectFiles).mockResolvedValueOnce([
      documentAttachment,
      imageAttachment
    ])
    render(<App />)

    fireEvent.click(await screen.findByLabelText('添加附件'))
    const composer = screen
      .getByLabelText('向 GoodBuddy 提问')
      .closest<HTMLElement>('.composer')
    expect(composer).not.toBeNull()
    if (!composer) {
      return
    }
    expect(
      await within(composer).findByText('需求说明.md')
    ).toBeInTheDocument()
    expect(
      within(composer).getByText('页面截图.png')
    ).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('向 GoodBuddy 提问'), {
      target: { value: '分析这些附件' }
    })
    fireEvent.click(screen.getByLabelText('发送'))

    await waitFor(() => expect(run).toHaveBeenCalledOnce())
    expect(run.mock.calls[0]?.[0].contextIds).toEqual([
      documentAttachment.id,
      imageAttachment.id
    ])
    const userArticle = screen
      .getAllByText('分析这些附件')
      .map((element) => element.closest('article'))
      .find((element) => element?.classList.contains('message--user'))
    expect(userArticle).not.toBeNull()
    if (!userArticle) {
      return
    }
    const anchorClick = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(() => {})
    expect(within(userArticle).getByText('需求说明.md')).toBeInTheDocument()
    expect(within(userArticle).getByText('2 KB')).toBeInTheDocument()
    expect(
      within(userArticle).getByRole('img', { name: '页面截图.png' })
    ).toHaveAttribute('src', imageAttachment.contentUrl)
    const viewerTrigger = within(userArticle).getByRole('button', {
      name: '查看图片 页面截图.png'
    })
    fireEvent.click(viewerTrigger)
    const imageDialog = await screen.findByRole('dialog', {
      name: '页面截图.png'
    })
    expect(
      within(imageDialog).getByRole('img', { name: '页面截图.png' })
    ).toHaveAttribute('src', imageAttachment.contentUrl)
    const closeViewer = within(imageDialog).getByRole('button', {
      name: '关闭图片查看器'
    })
    expect(closeViewer).toHaveFocus()
    expect(document.querySelector('main')?.inert).toBe(true)
    fireEvent.keyDown(closeViewer, { key: 'Tab' })
    expect(
      within(imageDialog).getByRole('button', {
        name: '下载图片'
      })
    ).toHaveFocus()
    fireEvent.keyDown(imageDialog, { key: 'Escape' })
    await waitFor(() =>
      expect(viewerTrigger).toHaveFocus()
    )
    expect(
      screen.queryByRole('dialog', { name: '页面截图.png' })
    ).not.toBeInTheDocument()
    expect(document.querySelector('main')?.inert).toBe(false)
    fireEvent.click(
      within(userArticle).getByRole('button', {
        name: '下载图片 页面截图.png'
      })
    )
    expect(anchorClick).toHaveBeenCalledOnce()
    await waitFor(
      () =>
        expect(api.conversations.saveLocal).toHaveBeenCalledWith(
          expect.arrayContaining([
            expect.objectContaining({
              messages: expect.arrayContaining([
                expect.objectContaining({
                  role: 'user',
                  attachments: [
                    documentAttachment,
                    imageAttachment
                  ]
                })
              ])
            })
          ])
        ),
      { timeout: 2_000 }
    )
  })

  it('shows attachment parsing progress and prevents duplicate selection', async () => {
    const attachment = {
      id: '00000000-0000-4000-8000-000000000309',
      name: '扫描材料.pdf',
      size: 8_705_692,
      preview: '解析后的文档',
      kind: 'text' as const
    }
    let resolveSelection:
      | ((attachments: ContextAttachment[]) => void)
      | undefined
    vi.mocked(api.context.selectFiles).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveSelection = resolve
        })
    )
    render(<App />)

    const addButton = await screen.findByLabelText('添加附件')
    fireEvent.click(addButton)

    expect(addButton).toBeDisabled()
    expect(
      screen.getByRole('progressbar', {
        name: '附件读取与解析进度'
      })
    ).toBeInTheDocument()
    expect(screen.getByText('正在选择附件…')).toBeInTheDocument()

    act(() => {
      fileSelectionProgressListener?.({
        phase: 'parsing',
        fileName: '扫描材料.pdf',
        fileNumber: 1,
        fileCount: 1
      })
    })
    expect(screen.getByText('正在解析 扫描材料.pdf')).toBeInTheDocument()
    expect(screen.getByText('第 1 / 1 个文件')).toBeInTheDocument()
    fireEvent.click(addButton)
    expect(api.context.selectFiles).toHaveBeenCalledOnce()

    act(() => resolveSelection?.([attachment]))
    expect(await screen.findByText('扫描材料.pdf')).toBeInTheDocument()
    await waitFor(() => {
      expect(addButton).toBeEnabled()
      expect(
        screen.queryByRole('progressbar', {
          name: '附件读取与解析进度'
        })
      ).not.toBeInTheDocument()
    })
  })

  it('sends and renders five selected images together', async () => {
    const imageAttachments = Array.from({ length: 5 }, (_, index) => ({
      id: `00000000-0000-4000-8000-00000000031${index}`,
      name: `参考图-${index + 1}.png`,
      size: 4_096,
      preview: '640 × 480',
      kind: 'image' as const,
      thumbnailUrl:
        'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEASABIAAD/2Q==',
      contentUrl:
        'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEASABIAAD/2Q=='
    }))
    vi.mocked(api.context.selectFiles).mockResolvedValueOnce(imageAttachments)
    render(<App />)

    fireEvent.click(await screen.findByLabelText('添加附件'))
    const composer = screen
      .getByLabelText('向 GoodBuddy 提问')
      .closest<HTMLElement>('.composer')
    expect(composer).not.toBeNull()
    if (!composer) {
      return
    }
    await waitFor(() =>
      expect(
        within(composer).getAllByText(/^参考图-\d\.png$/u)
      ).toHaveLength(5)
    )
    fireEvent.change(screen.getByLabelText('向 GoodBuddy 提问'), {
      target: { value: '比较这五张图片' }
    })
    fireEvent.click(screen.getByLabelText('发送'))

    await waitFor(() => expect(run).toHaveBeenCalledOnce())
    expect(run.mock.calls[0]?.[0].contextIds).toEqual(
      imageAttachments.map((attachment) => attachment.id)
    )
    const userArticle = screen
      .getAllByText('比较这五张图片')
      .map((element) => element.closest('article'))
      .find((element) => element?.classList.contains('message--user'))
    expect(userArticle).not.toBeNull()
    if (!userArticle) {
      return
    }
    expect(within(userArticle).getAllByRole('img')).toHaveLength(5)
    expect(within(userArticle).getByLabelText('消息附件')).toHaveClass(
      'message-attachments'
    )
  })

  it('accepts pasted images without intercepting pasted text', async () => {
    vi.mocked(api.context.addPastedImage).mockResolvedValueOnce({
      id: '00000000-0000-4000-8000-000000000303',
      name: '粘贴图片.jpg',
      size: 120_000,
      preview: '1280 × 800',
      kind: 'image',
      thumbnailUrl:
        'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB'
    })
    const pastedImage = new File(
      [Uint8Array.from([0x89, 0x50, 0x4e, 0x47])],
      'pasted.png',
      { type: 'image/png' }
    )
    render(<App />)

    const input = await screen.findByLabelText('向 GoodBuddy 提问')
    expect(
      fireEvent.paste(input, {
        clipboardData: {
          items: [
            {
              getAsFile: () => null,
              kind: 'string',
              type: 'text/plain'
            }
          ]
        }
      })
    ).toBe(true)
    expect(api.context.addPastedImage).not.toHaveBeenCalled()

    fireEvent.paste(input, {
      clipboardData: {
        items: [
          {
            getAsFile: () => pastedImage,
            kind: 'file',
            type: 'image/png'
          }
        ]
      }
    })

    await waitFor(() =>
      expect(api.context.addPastedImage).toHaveBeenCalledWith({
        data: Uint8Array.from([0x89, 0x50, 0x4e, 0x47]),
        mimeType: 'image/png'
      })
    )
    expect(api.context.addPastedImage).toHaveBeenCalledTimes(1)
    expect(api.context.readClipboard).not.toHaveBeenCalled()
    const composer = input.closest<HTMLElement>('.composer')
    expect(composer).not.toBeNull()
    if (!composer) {
      return
    }
    expect(
      await within(composer).findByText('粘贴图片.jpg')
    ).toBeInTheDocument()
    expect(
      within(composer).queryByRole('button', {
        name: '截取当前屏幕'
      })
    ).not.toBeInTheDocument()
    expect(
      within(composer).queryByRole('button', {
        name: '捕获应用窗口'
      })
    ).not.toBeInTheDocument()
    expect(
      within(composer).queryByRole('button', {
        name: '读取剪贴板'
      })
    ).not.toBeInTheDocument()
  })

  it('keeps a draft in chat when Enter is pressed while the runtime loads', async () => {
    vi.mocked(api.agent.getStatus).mockReturnValue(
      new Promise(() => {})
    )
    render(<App />)

    const composer = screen.getByLabelText('向 GoodBuddy 提问')
    fireEvent.change(composer, {
      target: { value: '等待 Runtime' }
    })
    fireEvent.keyDown(composer, { key: 'Enter' })

    expect(composer).toHaveValue('等待 Runtime')
    expect(
      screen.queryByRole('heading', { name: '设置中心' })
    ).not.toBeInTheDocument()
    expect(
      await screen.findByText('Agent Runtime 正在加载，请稍后重试')
    ).toBeInTheDocument()
    expect(run).not.toHaveBeenCalled()
  })

  it('keeps a new-conversation draft in chat when the runtime is unavailable', async () => {
    vi.mocked(api.agent.getStatus).mockResolvedValue({
      id: 'setup',
      label: '需要配置模型',
      available: false,
      supportsToolExecution: false,
      detail: '请配置模型'
    })
    render(<App />)

    expect(
      await screen.findByRole('heading', { name: '设置中心' })
    ).toBeInTheDocument()
    const newConversation = screen.getByRole('button', {
      name: /新建对话/u
    })
    fireEvent.click(newConversation)

    const composer = screen.getByLabelText('向 GoodBuddy 提问')
    await waitFor(() => expect(composer).toHaveFocus())
    fireEvent.change(composer, {
      target: { value: '保留这条草稿' }
    })
    fireEvent.keyDown(composer, { key: 'Enter' })

    expect(composer).toHaveValue('保留这条草稿')
    expect(
      screen.queryByRole('heading', { name: '设置中心' })
    ).not.toBeInTheDocument()
    expect(screen.getByLabelText('发送')).toBeDisabled()
    expect(run).not.toHaveBeenCalled()
  })

  it('opens chat and focuses the composer for tray conversations', async () => {
    render(<App />)

    fireEvent.click(await screen.findByText('本地工作区'))
    expect(
      await screen.findByRole('heading', { name: '设置中心' })
    ).toBeInTheDocument()

    act(() => newConversationListener?.())

    const composer = await screen.findByLabelText('向 GoodBuddy 提问')
    await waitFor(() => expect(composer).toHaveFocus())
  })

  it('reuses the active empty conversation and preserves its draft', async () => {
    render(<App />)

    const composer = await screen.findByLabelText('向 GoodBuddy 提问')
    fireEvent.change(composer, {
      target: { value: '尚未发送的草稿' }
    })
    const newConversation = screen.getByRole('button', {
      name: /新建对话/u
    })
    fireEvent.click(newConversation)
    fireEvent.click(newConversation)

    expect(composer).toHaveValue('尚未发送的草稿')
    expect(
      screen.getAllByRole('button', {
        name: '更多会话操作 新对话'
      })
    ).toHaveLength(1)
  })

  it('coalesces batched new-conversation requests after a used conversation', async () => {
    render(<App />)

    fireEvent.change(await screen.findByLabelText('向 GoodBuddy 提问'), {
      target: { value: '已有内容' }
    })
    fireEvent.click(screen.getByLabelText('发送'))
    await waitFor(() => expect(run).toHaveBeenCalledOnce())
    const requestId = run.mock.calls[0]?.[0].requestId
    act(() => {
      if (requestId) {
        agentListener?.({ requestId, type: 'done' })
      }
      newConversationListener?.()
      newConversationListener?.()
    })

    expect(
      screen.getAllByRole('button', {
        name: /^更多会话操作/u
      })
    ).toHaveLength(2)
  })

  it('opens a workspace Markdown file in the right-side preview', async () => {
    vi.mocked(api.workspace.listDirectory).mockResolvedValue({
      path: '',
      entries: [
        {
          name: 'README.md',
          path: 'README.md',
          type: 'file'
        }
      ],
      truncated: false
    })
    vi.mocked(api.workspace.readFile).mockResolvedValue({
      path: 'README.md',
      name: 'README.md',
      content: '# 工作区说明',
      mimeType: 'text/markdown',
      size: 19
    })
    render(<App />)

    fireEvent.click(screen.getByLabelText('切换助手工作栏'))
    fireEvent.click(await screen.findByRole('tab', { name: '工作区' }))
    fireEvent.click(
      await screen.findByRole('button', { name: 'README.md' })
    )

    expect(
      await screen.findByRole('heading', { name: '工作区说明' })
    ).toBeInTheDocument()
    expect(
      screen.getByRole('tab', { name: '工作区' })
    ).toHaveAttribute('aria-selected', 'true')
    expect(
      screen.queryByRole('tab', { name: '预览' })
    ).not.toBeInTheDocument()
    expect(api.workspace.readFile).toHaveBeenCalledWith(
      projectId,
      'README.md'
    )
    fireEvent.click(
      screen.getByRole('button', { name: '返回工作区' })
    )
    expect(
      await screen.findByRole('button', { name: 'README.md' })
    ).toBeInTheDocument()
  })

  it('opens workspace entries from their row actions', async () => {
    vi.mocked(api.workspace.listDirectory).mockResolvedValue({
      path: '',
      entries: [
        { name: 'docs', path: 'docs', type: 'directory' },
        { name: 'README.md', path: 'README.md', type: 'file' }
      ],
      truncated: false
    })
    render(<App />)

    fireEvent.click(screen.getByLabelText('切换助手工作栏'))
    fireEvent.click(await screen.findByRole('tab', { name: '工作区' }))
    fireEvent.click(
      await screen.findByRole('button', {
        name: '在系统资源管理器中打开文件夹 docs'
      })
    )
    fireEvent.click(
      screen.getByRole('button', {
        name: '使用默认应用打开文件 README.md'
      })
    )
    await waitFor(() =>
      expect(api.workspace.openPath).toHaveBeenCalledWith(
        projectId,
        'docs',
        'directory'
      )
    )
    expect(api.workspace.openPath).toHaveBeenCalledWith(
      projectId,
      'README.md',
      'file'
    )
  })

  it('refreshes generated workspace files when a run completes', async () => {
    vi.mocked(api.workspace.getChanges)
      .mockResolvedValueOnce({
        rootPath: project.rootPath,
        available: true,
        status: '',
        patch: '',
        files: [],
        truncated: false
      })
      .mockResolvedValueOnce({
        rootPath: project.rootPath,
        available: true,
        status: '?? generated.md',
        patch: '',
        files: [{ path: 'generated.md', status: '??' }],
        truncated: false
      })
    render(<App />)

    fireEvent.click(screen.getByLabelText('切换助手工作栏'))
    fireEvent.click(await screen.findByRole('tab', { name: '工作区' }))
    await waitFor(() =>
      expect(api.workspace.getChanges).toHaveBeenCalledOnce()
    )
    fireEvent.change(screen.getByLabelText('向 GoodBuddy 提问'), {
      target: { value: '生成文件' }
    })
    fireEvent.click(screen.getByLabelText('发送'))
    await waitFor(() => expect(run).toHaveBeenCalledOnce())
    const requestId = run.mock.calls[0]?.[0].requestId
    act(() => {
      if (requestId) {
        agentListener?.({ requestId, type: 'done' })
      }
    })

    expect(await screen.findByText('generated.md')).toBeInTheDocument()
  })

  it('ignores stale Git changes after switching projects', async () => {
    const secondProject = {
      ...project,
      id: '00000000-0000-4000-8000-000000000102',
      name: '第二项目',
      rootPath: 'C:\\Second'
    }
    vi.mocked(api.projects.list).mockResolvedValueOnce([
      project,
      secondProject
    ])
    let resolveFirst:
      | ((value: Awaited<ReturnType<DesktopApi['workspace']['getChanges']>>) => void)
      | undefined
    let resolveSecond:
      | ((value: Awaited<ReturnType<DesktopApi['workspace']['getChanges']>>) => void)
      | undefined
    vi.mocked(api.workspace.getChanges)
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveFirst = resolve
          })
      )
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveSecond = resolve
          })
      )
    render(<App />)

    fireEvent.click(screen.getByLabelText('切换助手工作栏'))
    fireEvent.click(await screen.findByRole('tab', { name: '工作区' }))
    await waitFor(() =>
      expect(api.workspace.getChanges).toHaveBeenCalledWith(projectId)
    )
    fireEvent.click(screen.getByLabelText('切换助手工作栏'))
    selectProjectOption(secondProject.name)
    await waitFor(() =>
      expect(api.workspace.getChanges).toHaveBeenCalledWith(
        secondProject.id
      )
    )

    resolveSecond?.({
      rootPath: secondProject.rootPath,
      available: true,
      status: '?? second.md',
      patch: '',
      files: [{ path: 'second.md', status: '??' }],
      truncated: false
    })
    fireEvent.click(screen.getByLabelText('切换助手工作栏'))
    expect(await screen.findByText('second.md')).toBeInTheDocument()
    resolveFirst?.({
      rootPath: project.rootPath,
      available: true,
      status: '?? stale.md',
      patch: '',
      files: [{ path: 'stale.md', status: '??' }],
      truncated: false
    })

    await waitFor(() =>
      expect(screen.queryByText('stale.md')).not.toBeInTheDocument()
    )
    expect(screen.getByText('second.md')).toBeInTheDocument()
  })

  it('applies and persists a dark appearance from Settings', async () => {
    render(<App />)

    fireEvent.click(await screen.findByText('本地工作区'))
    fireEvent.click(screen.getByRole('tab', { name: '外观' }))
    fireEvent.click(screen.getByRole('radio', { name: /暗色/u }))

    await waitFor(() =>
      expect(document.documentElement.dataset.theme).toBe('dark')
    )
    expect(document.documentElement.style.colorScheme).toBe('dark')
    expect(localStorage.getItem('goodbuddy.appearance-theme')).toBe(
      'dark'
    )
  })

  it('loads token usage in activity and refreshes it when a run finishes', async () => {
    vi.mocked(api.usage.getTokenSummary).mockResolvedValueOnce({
      totals: {
        callCount: 1,
        input: 100,
        output: 20,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 120
      },
      records: [
        {
          requestId: 'usage-request-1',
          projectId,
          projectName: project.name,
          conversationId: 'usage-conversation-1',
          conversationTitle: '用量会话',
          runtime: 'model',
          provider: 'anthropic',
          model: 'sonnet-5',
          callCount: 1,
          input: 100,
          output: 20,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 120
        }
      ]
    })

    render(<App />)
    fireEvent.change(screen.getByLabelText('向 GoodBuddy 提问'), {
      target: { value: '统计用量' }
    })
    fireEvent.click(await screen.findByLabelText('发送'))
    await waitFor(() => expect(run).toHaveBeenCalledOnce())
    const request = run.mock.calls[0]?.[0]
    if (!request) {
      throw new Error('Missing request')
    }

    fireEvent.click(screen.getByText('运行记录'))
    fireEvent.click(
      await screen.findByRole('tab', { name: '用量统计' })
    )
    const stats = await screen.findByLabelText('Token 用量统计')
    expect(
      screen.getByRole('heading', { level: 1, name: '运行记录' })
    ).toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: /^专家角色：/u })
    ).not.toBeInTheDocument()
    expect(
      screen.queryByLabelText('切换助手工作栏')
    ).not.toBeInTheDocument()
    await waitFor(() =>
      expect(api.usage.getTokenSummary).toHaveBeenCalledOnce()
    )
    expect(within(stats).getByText('120')).toBeInTheDocument()

    vi.mocked(api.usage.getTokenSummary).mockResolvedValueOnce({
      totals: {
        callCount: 2,
        input: 300,
        output: 45,
        cacheRead: 10,
        cacheWrite: 5,
        totalTokens: 360
      },
      records: [
        {
          requestId: request.requestId,
          projectId,
          projectName: project.name,
          conversationId: request.conversationId,
          conversationTitle: '用量会话',
          runtime: 'model',
          provider: 'anthropic',
          model: 'sonnet-5',
          callCount: 2,
          input: 300,
          output: 45,
          cacheRead: 10,
          cacheWrite: 5,
          totalTokens: 360
        }
      ]
    })
    act(() => {
      agentListener?.({
        requestId: request.requestId,
        type: 'done'
      })
    })

    await waitFor(() =>
      expect(api.usage.getTokenSummary).toHaveBeenCalledTimes(2)
    )
    expect(within(stats).getByText('345')).toBeInTheDocument()
  })

  it('offers only Ask and Execute in visible work mode controls', async () => {
    render(<App />)

    await screen.findByRole('button', {
      name: '工作模式：Ask · 只读问答'
    })
    const modeMenu = openComposerMenu('工作模式')
    expect(
      within(modeMenu)
        .getAllByRole('menuitemradio')
        .map((option) => option.querySelector('span')?.textContent)
    ).toEqual(['Ask · 只读问答', 'Execute · 受控执行'])

    fireEvent.click(screen.getByLabelText('新建项目'))
    const dialog = screen.getByRole('dialog', { name: '新建项目' })
    const defaultMode = within(dialog).getByRole('combobox', {
      name: '默认模式'
    })
    expect(
      within(defaultMode)
        .getAllByRole('option')
        .map((option) => option.textContent)
    ).toEqual(['Ask · 只读问答', 'Execute · 受控执行'])
    expect(screen.queryByRole('option', { name: /Plan/u })).toBeNull()
  })

  it('matches expert and work mode keyboard menus to the model picker', async () => {
    render(<App />)

    const expertTrigger = await screen.findByRole('button', {
      name: '专家角色：通用助手'
    })
    expect(expertTrigger).toHaveClass('model-button')
    fireEvent.keyDown(expertTrigger, { key: 'ArrowDown' })

    const expertMenu = screen.getByRole('menu', {
      name: '专家角色'
    })
    expect(expertMenu).toHaveClass('runtime-picker__menu')
    const generalExpert = within(expertMenu).getByRole(
      'menuitemradio',
      { name: /^通用助手/u }
    )
    const expertTeam = within(expertMenu).getByRole(
      'menuitemradio',
      { name: /^专家团队（并行）/u }
    )
    await waitFor(() => expect(generalExpert).toHaveFocus())
    fireEvent.keyDown(generalExpert, { key: 'ArrowDown' })
    expect(expertTeam).toHaveFocus()
    fireEvent.keyDown(expertTeam, { key: 'Escape' })
    expect(expertTrigger).toHaveFocus()
    expect(
      screen.queryByRole('menu', { name: '专家角色' })
    ).not.toBeInTheDocument()

    const modeTrigger = composerMenuTrigger('工作模式')
    fireEvent.click(modeTrigger)
    const modeMenu = screen.getByRole('menu', { name: '工作模式' })
    expect(modeMenu).toHaveClass('runtime-picker__menu')
    fireEvent.pointerDown(screen.getByLabelText('向 GoodBuddy 提问'))
    expect(
      screen.queryByRole('menu', { name: '工作模式' })
    ).not.toBeInTheDocument()
  })

  it('groups composer tools and exposes clear control descriptions', async () => {
    render(<App />)

    const composer = (await screen.findByLabelText(
      '向 GoodBuddy 提问'
    )).closest<HTMLElement>('.composer')
    expect(composer).not.toBeNull()

    const contentTools = within(composer!).getByRole('group', {
      name: '添加内容'
    })
    expect(
      within(contentTools).getByRole('button', { name: '添加附件' })
    ).toHaveAttribute('title', '添加附件')
    expect(
      within(contentTools).getByRole('button', { name: '语音输入' })
    ).toHaveAttribute(
      'title',
      '语音转文字，转写后可编辑再发送'
    )

    const conversationSettings = within(composer!).getByRole(
      'group',
      { name: '对话设置' }
    )
    expect(
      within(conversationSettings).getByRole('button', {
        name: '专家角色：通用助手'
      })
    ).toBeInTheDocument()
    expect(
      within(conversationSettings).getByRole('button', {
        name: '工作模式：Ask · 只读问答'
      })
    ).toBeInTheDocument()
    expect(
      within(conversationSettings).getByRole('button', {
        name: '工作模式：Ask · 只读问答'
      })
    ).toHaveTextContent(/^Ask$/u)
    expect(screen.getByLabelText('向 GoodBuddy 提问')).toHaveAttribute(
      'placeholder',
      '给 GoodBuddy 发消息…\nEnter 发送 · Shift+Enter 换行 · Ctrl+V 粘贴图片或文本'
    )
    expect(
      within(conversationSettings).getByRole('button', {
        name: /默认模型/u
      })
    ).toHaveAttribute(
      'title',
      expect.stringContaining('Runtime 和模型')
    )
  })

  it('restores and persists the last active project', async () => {
    const secondProject = {
      ...project,
      id: '00000000-0000-4000-8000-000000000102',
      name: '第二项目',
      rootPath: 'C:\\Second',
      defaultWorkMode: 'execute' as const
    }
    vi.mocked(api.projects.list).mockResolvedValueOnce([
      project,
      secondProject
    ])
    localStorage.setItem(
      'goodbuddy.active-project.v1',
      secondProject.id
    )

    render(<App />)

    expect(
      await screen.findByRole('button', { name: '当前项目' })
    ).toHaveTextContent(secondProject.name)
    expect(
      screen.getByRole('button', {
        name: '工作模式：Execute · 受控执行'
      })
    ).toBeEnabled()

    selectProjectOption(project.name)
    await waitFor(() =>
      expect(
        localStorage.getItem('goodbuddy.active-project.v1')
      ).toBe(project.id)
    )
  })

  it('shows grouped project details and keeps the rich menu keyboard accessible', async () => {
    const channelProject = {
      ...project,
      id: '00000000-0000-4000-8000-000000000201',
      name: '微信 ClawBot',
      kind: 'channel' as const,
      channel: 'weixin' as const
    }
    vi.mocked(api.projects.list).mockResolvedValueOnce([
      project,
      channelProject
    ])
    render(<App />)

    const trigger = await screen.findByRole('button', {
      name: '当前项目'
    })
    fireEvent.keyDown(trigger, { key: 'ArrowDown' })

    const menu = screen.getByRole('menu', { name: '当前项目' })
    expect(
      within(menu).getByRole('group', { name: '本地项目' })
    ).toHaveTextContent('本地目录 · C:\\Users\\test')
    expect(
      within(menu).getByRole('group', { name: '远程通道' })
    ).toHaveTextContent(
      '微信 ClawBot · 远程通道 · C:\\Users\\test'
    )
    const selectedProject = within(menu)
      .getByText(project.name, { selector: 'b' })
      .closest<HTMLButtonElement>('[role="menuitemradio"]')
    const remoteProject = within(menu)
      .getByText(channelProject.name, { selector: 'b' })
      .closest<HTMLButtonElement>('[role="menuitemradio"]')
    expect(selectedProject).toHaveAttribute('aria-checked', 'true')
    await waitFor(() => expect(selectedProject).toHaveFocus())

    fireEvent.keyDown(selectedProject!, { key: 'End' })
    expect(remoteProject).toHaveFocus()
    fireEvent.keyDown(remoteProject!, { key: 'Escape' })
    expect(trigger).toHaveFocus()
    expect(
      screen.queryByRole('menu', { name: '当前项目' })
    ).not.toBeInTheDocument()
  })

  it('keeps channel projects empty until a client message creates a remote conversation', async () => {
    const channelProject = {
      ...project,
      id: '00000000-0000-4000-8000-000000000201',
      name: '微信 ClawBot',
      kind: 'channel' as const,
      channel: 'weixin' as const,
      runtimeSelection: {
        provider: 'model' as const,
        profileId: modelProfileId
      }
    }
    vi.mocked(api.projects.list).mockResolvedValueOnce([
      project,
      channelProject
    ])
    render(<App />)

    await screen.findByRole('button', { name: '当前项目' })
    selectProjectOption(channelProject.name)

    expect(
      screen.queryByRole('button', { name: /新建对话/u })
    ).not.toBeInTheDocument()
    expect(screen.queryByText('Ctrl N')).not.toBeInTheDocument()
    expect(
      screen.getAllByText('尚无远程会话').length
    ).toBeGreaterThan(0)
    expect(
      screen.getByText(
        '请先连接微信 ClawBot，远程用户发送第一条消息后，会话会自动出现在这里。'
      )
    ).toBeInTheDocument()

    fireEvent.keyDown(document, {
      key: 'n',
      ctrlKey: true
    })
    expect(
      await screen.findByText(
        '通道项目的会话由客户端收到新消息后自动创建'
      )
    ).toBeInTheDocument()
    await act(
      () =>
        new Promise((resolve) => {
          setTimeout(resolve, 550)
        })
    )
    const savedChannelHeaders = vi
      .mocked(api.conversations.saveLocal)
      .mock.calls.flatMap(([batch]) => batch.map((entry) => entry.header))
    expect(
      savedChannelHeaders.some(
        (header) => header.projectId === channelProject.id
      )
    ).toBe(false)
    expect(screen.getAllByText('尚无远程会话').length).toBeGreaterThan(0)

    fireEvent.click(screen.getByRole('button', { name: '打开设置' }))

    const channelSettingsTab = await screen.findByRole('tab', {
      name: '消息通道'
    })
    expect(channelSettingsTab).toHaveAttribute('aria-selected', 'true')
  })

  it('keeps channel project settings synchronized between both entry points', async () => {
    let channelProjects: AssistantProject[] = [
      ['weixin', '微信 ClawBot'],
      ['wecom', '企业微信'],
      ['dingtalk', '钉钉']
    ].map(([channel, name], index) => ({
      ...project,
      id: `00000000-0000-4000-8000-00000000020${index + 1}`,
      name: name!,
      description: `${name}通道项目`,
      kind: 'channel' as const,
      channel: channel as 'weixin' | 'wecom' | 'dingtalk',
      runtimeSelection: {
        provider: 'model' as const,
        profileId: modelProfileId
      }
    }))
    vi.mocked(api.projects.list).mockResolvedValueOnce([
      project,
      ...channelProjects
    ])
    vi.mocked(api.projects.update).mockImplementation(
      async (projectToUpdate, input) => {
        const existing = channelProjects.find(
          (candidate) => candidate.id === projectToUpdate
        )
        if (!existing) {
          return {
            ...project,
            ...input,
            id: projectToUpdate
          }
        }
        const updated = {
          ...existing,
          ...input,
          updatedAt: '2026-08-14T00:00:00.000Z'
        }
        channelProjects = channelProjects.map((candidate) =>
          candidate.id === updated.id ? updated : candidate
        )
        return updated
      }
    )
    api.channels = {
      getSnapshot: vi.fn(async () => ({
        weixin: {
          enabled: false,
          bindingConfigured: false,
          source: 'none' as const,
          status: { state: 'disabled' as const }
        },
        wecom: {
          enabled: false,
          botId: '',
          secretConfigured: false,
          source: 'none' as const,
          readOnly: false,
          allowedSenderIds: [],
          allowGroupMessages: false,
          status: { state: 'disabled' as const }
        },
        dingtalk: {
          enabled: false,
          clientId: '',
          secretConfigured: false,
          source: 'none' as const,
          readOnly: false,
          allowedSenderIds: [],
          allowGroupMessages: false,
          status: { state: 'disabled' as const }
        }
      })),
      apply: vi.fn(async () => {
        throw new Error('No channel connection settings changed')
      }),
      testConnection: vi.fn(async (channel) => ({
        channel,
        ok: true
      })),
      getWeixinBinding: vi.fn(async () => ({
        status: 'stopped' as const
      })),
      startWeixinBinding: vi.fn(async () => ({
        status: 'starting' as const
      })),
      submitWeixinVerification: vi.fn(async () => ({
        status: 'scanned' as const
      })),
      disconnectWeixin: vi.fn(async () => ({
        status: 'stopped' as const
      })),
      onWeixinBindingChanged: vi.fn(() => () => undefined),
      onRemoteActivity: vi.fn(() => () => undefined)
    }

    render(<App />)
    const weixinProject = channelProjects[0]!
    await screen.findByRole('button', { name: '当前项目' })
    selectProjectOption(weixinProject.name)
    fireEvent.click(
      await screen.findByRole('button', { name: '打开设置' })
    )

    expect(
      await screen.findByLabelText('微信 ClawBot 项目说明')
    ).toHaveValue('微信 ClawBot通道项目')

    fireEvent.click(screen.getByLabelText('项目设置'))
    let dialog = screen.getByRole('dialog', { name: '项目设置' })
    const dialogDescription = within(dialog).getByLabelText(
      '微信 ClawBot 项目说明'
    )
    expect(dialogDescription).toHaveFocus()
    const dialogBackend = within(dialog).getByLabelText(
      '微信 ClawBot 消息处理后端'
    )
    expect(
      within(dialogBackend).getByRole('option', {
        name: 'DeepSeek Harness（预览 · OpenAI 兼容）'
      })
    ).toBeInTheDocument()
    fireEvent.change(
      dialogDescription,
      { target: { value: '从左上角更新' } }
    )
    fireEvent.change(
      within(dialog).getByLabelText('微信 ClawBot 默认工作目录'),
      { target: { value: 'C:\\FromSwitcher' } }
    )
    fireEvent.change(
      dialogBackend,
      {
        target: {
          value: agentRuntimeSelectionKey({
            provider: 'opencode'
          })
        }
      }
    )
    fireEvent.click(
      within(
        within(dialog).getByRole('group', {
          name: '微信 ClawBot 默认模式'
        })
      ).getByRole('button', { name: '执行' })
    )
    fireEvent.click(
      within(dialog).getByRole('button', { name: '保存项目' })
    )

    await waitFor(() => {
      expect(
        screen.getByLabelText('微信 ClawBot 项目说明')
      ).toHaveValue('从左上角更新')
      expect(
        screen.getByLabelText('微信 ClawBot 默认工作目录')
      ).toHaveValue('C:\\FromSwitcher')
      expect(
        screen.getByLabelText('微信 ClawBot 消息处理后端')
      ).toHaveValue(
        agentRuntimeSelectionKey({ provider: 'opencode' })
      )
    })

    fireEvent.change(
      screen.getByLabelText('微信 ClawBot 项目说明'),
      { target: { value: '从消息通道更新' } }
    )
    fireEvent.change(
      screen.getByLabelText('微信 ClawBot 默认工作目录'),
      { target: { value: 'C:\\FromChannels' } }
    )
    fireEvent.change(
      screen.getByLabelText('微信 ClawBot 消息处理后端'),
      {
        target: {
          value: agentRuntimeSelectionKey({
            provider: 'continue'
          })
        }
      }
    )
    fireEvent.click(
      within(
        screen.getByRole('group', {
          name: '微信 ClawBot 默认模式'
        })
      ).getByRole('button', { name: '对话' })
    )
    fireEvent.click(
      screen.getByRole('button', { name: '保存通道设置' })
    )

    await waitFor(() =>
      expect(api.projects.update).toHaveBeenCalledWith(
        weixinProject.id,
        expect.objectContaining({
          description: '从消息通道更新',
          rootPath: 'C:\\FromChannels',
          defaultWorkMode: 'ask',
          runtimeSelection: { provider: 'continue' }
        })
      )
    )

    fireEvent.click(screen.getByLabelText('项目设置'))
    dialog = screen.getByRole('dialog', { name: '项目设置' })
    expect(
      within(dialog).getByLabelText('微信 ClawBot 项目说明')
    ).toHaveValue('从消息通道更新')
    expect(
      within(dialog).getByLabelText('微信 ClawBot 默认工作目录')
    ).toHaveValue('C:\\FromChannels')
    expect(
      within(dialog).getByLabelText('微信 ClawBot 消息处理后端')
    ).toHaveValue(
      agentRuntimeSelectionKey({ provider: 'continue' })
    )
    expect(
      within(
        within(dialog).getByRole('group', {
          name: '微信 ClawBot 默认模式'
        })
      ).getByRole('button', { name: '对话' })
    ).toHaveAttribute('aria-pressed', 'true')
  })

  it('shows client-created remote conversations without obsolete approval copy', async () => {
    const channelProject = {
      ...project,
      id: '00000000-0000-4000-8000-000000000201',
      name: '微信 ClawBot',
      kind: 'channel' as const,
      channel: 'weixin' as const,
      runtimeSelection: {
        provider: 'model' as const,
        profileId: modelProfileId
      }
    }
    vi.mocked(api.projects.list).mockResolvedValueOnce([
      project,
      channelProject
    ])
    vi.mocked(api.conversations.list).mockResolvedValueOnce([
      {
        id: '00000000-0000-4000-8000-000000000301',
        projectId: channelProject.id,
        runtimeSelection: channelProject.runtimeSelection,
        remote: {
          channel: 'weixin',
          accountDisplay: '发送者 ****0001',
          conversationType: 'direct'
        },
        title: '微信 ClawBot · ****0001',
        updatedAt: 1_775_000_000_000,
        messages: []
      }
    ])
    render(<App />)

    await screen.findByRole('button', { name: '当前项目' })
    selectProjectOption(channelProject.name)

    expect(
      screen.getAllByRole('button', {
        name: /微信 ClawBot · \*{4}0001/u
      }).length
    ).toBeGreaterThan(0)
    expect(
      screen.getByText(
        '请在 微信 ClawBot 客户端继续发送消息。本窗口用于查看历史、任务与执行结果。'
      )
    ).toBeInTheDocument()
    expect(screen.queryByText(/审批执行/u)).not.toBeInTheDocument()
  })

  it('falls back when the last active project is no longer available', async () => {
    localStorage.setItem(
      'goodbuddy.active-project.v1',
      '00000000-0000-4000-8000-000000000999'
    )

    render(<App />)

    expect(
      await screen.findByRole('button', { name: '当前项目' })
    ).toHaveTextContent(project.name)
    await waitFor(() =>
      expect(
        localStorage.getItem('goodbuddy.active-project.v1')
      ).toBe(project.id)
    )
  })

  it.each([
    ['opencode', 'OpenCode'],
    ['continue', 'Continue CLI']
  ] as const)(
    'lets %s select Ask or Execute',
    async (runtimeId, label) => {
    vi.mocked(api.agent.getStatus).mockResolvedValue({
      id: runtimeId,
      label,
      available: true,
      supportsToolExecution: true,
      detail: 'Ready'
    })
    render(<App />)

    const mode = await screen.findByRole('button', {
      name: '工作模式：Ask · 只读问答'
    })
    expect(mode).toBeEnabled()
    expect(mode.closest('.composer')).not.toBeNull()
    expect(
      await screen.findByText('快捷唤起：', { exact: false })
    ).toBeInTheDocument()
    selectComposerOption('工作模式', 'Execute · 受控执行')
    expect(mode).toHaveAccessibleName(
      '工作模式：Execute · 受控执行'
    )
    expect(mode).toHaveTextContent(/^Execute$/u)

    fireEvent.change(screen.getByLabelText('向 GoodBuddy 提问'), {
      target: { value: '执行任务' }
    })
    fireEvent.click(await screen.findByLabelText('发送'))

    await waitFor(() =>
      expect(run).toHaveBeenCalledWith(
        expect.objectContaining({
          prompt: '执行任务',
          workMode: 'execute'
        })
      )
    )
    }
  )

  it('submits native OpenCode Agent and Command controls', async () => {
    const settings = await api.settings.getRuntime()
    vi.mocked(api.settings.getRuntime).mockResolvedValueOnce({
      ...settings,
      provider: 'opencode',
      opencodeEmbedded: true,
      opencodeModelSource: { kind: 'platform' }
    })
    vi.mocked(api.agent.getStatus).mockResolvedValueOnce({
      id: 'opencode',
      label: 'OpenCode',
      available: true,
      supportsToolExecution: true,
      detail: 'Ready'
    })
    vi.mocked(
      api.runtimeCustomization.getSettings
    ).mockResolvedValueOnce({
      opencode: {},
      continue: { presets: [] }
    })
    vi.mocked(
      api.runtimeCustomization.getNativeSnapshot
    ).mockResolvedValueOnce({
      provider: 'opencode',
      available: true,
      inventoryStatus: 'available',
      detail: 'Ready',
      agents: [
        {
          id: 'planner',
          name: 'Planner',
          description: 'Plan before editing',
          mode: 'primary',
          native: true,
          hidden: false
        }
      ],
      tools: [],
      toolsSupported: true,
      commands: [
        {
          id: 'review',
          name: 'review',
          description: 'Review a target',
          source: 'command'
        }
      ],
      lsp: [],
      formatters: [],
      mcpServers: [],
      skills: [],
      rules: [],
      prompts: [],
      resources: [],
      resourcesSupported: true,
      context: {
        strategy: 'native',
        manualCompact: true,
        detail: 'OpenCode native context'
      }
    })

    render(<App />)

    const agentPicker = await screen.findByRole('button', {
      name: /OpenCode Runtime Agent/u
    })
    const runtimeToolbar = screen.getByRole('group', {
      name: 'OpenCode 专属功能'
    })
    const universalSettings = screen.getByRole('group', {
      name: '对话设置'
    })
    expect(runtimeToolbar).toHaveClass('composer__runtime-toolbar')
    expect(runtimeToolbar).toContainElement(agentPicker)
    expect(universalSettings).not.toContainElement(agentPicker)
    expect(universalSettings.closest('.composer__toolbar')).toHaveClass(
      'composer__toolbar--with-runtime-controls'
    )
    fireEvent.click(agentPicker)
    fireEvent.click(
      within(
        screen.getByRole('menu', {
          name: 'OpenCode Runtime Agent'
        })
      ).getByRole('menuitemradio', { name: /Planner/u })
    )
    const actionPicker = screen.getByRole('button', {
      name: /Runtime 快捷操作/u
    })
    expect(runtimeToolbar).toContainElement(actionPicker)
    fireEvent.click(actionPicker)
    fireEvent.click(
      within(
        screen.getByRole('menu', {
          name: 'Runtime 快捷操作'
        })
      ).getByRole('menuitemradio', { name: /\/review/u })
    )
    fireEvent.change(screen.getByLabelText('向 GoodBuddy 提问'), {
      target: { value: 'src/main' }
    })
    fireEvent.click(screen.getByLabelText('发送'))

    await waitFor(() =>
      expect(run).toHaveBeenCalledWith(
        expect.objectContaining({
          prompt: '/review src/main',
          runtimeControl: {
            provider: 'opencode',
            agent: 'planner',
            command: {
              name: 'review',
              arguments: 'src/main'
            }
          }
        })
      )
    )
  })

  it('fills editable Continue Prompts and submits the selected preset', async () => {
    const presetId = '00000000-0000-4000-8000-000000000721'
    const promptId = '00000000-0000-4000-8000-000000000722'
    const settings = await api.settings.getRuntime()
    vi.mocked(api.settings.getRuntime).mockResolvedValueOnce({
      ...settings,
      provider: 'continue',
      continueModelSource: { kind: 'platform' }
    })
    vi.mocked(api.agent.getStatus).mockResolvedValueOnce({
      id: 'continue',
      label: 'Continue',
      available: true,
      supportsToolExecution: true,
      detail: 'Ready'
    })
    vi.mocked(
      api.runtimeCustomization.getSettings
    ).mockResolvedValueOnce({
      opencode: {},
      continue: {
        defaultPresetId: presetId,
        presets: [
          {
            id: presetId,
            name: '代码审查',
            rules: [],
            prompts: [
              {
                id: promptId,
                name: '审查草稿',
                description: '检查当前草稿',
                prompt: '请审查当前草稿。'
              }
            ]
          }
        ]
      }
    })
    vi.mocked(
      api.runtimeCustomization.getNativeSnapshot
    ).mockResolvedValueOnce({
      provider: 'continue',
      available: true,
      inventoryStatus: 'available',
      detail: 'Ready',
      agents: [],
      tools: [],
      toolsSupported: false,
      commands: [],
      lsp: [],
      formatters: [],
      mcpServers: [],
      skills: [],
      rules: [],
      prompts: [
        {
          id: promptId,
          name: '原生同 ID Prompt',
          prompt: '不应填入此原生 Prompt。',
          source: 'configuration'
        }
      ],
      resources: [],
      resourcesSupported: false,
      context: {
        strategy: 'goodbuddy-summary',
        manualCompact: true,
        detail: 'GoodBuddy summary context'
      }
    })

    render(<App />)

    const presetPicker = await screen.findByRole('button', {
      name: /Continue 配置预设.*使用设置默认预设/u
    })
    const runtimeToolbar = screen.getByRole('group', {
      name: 'Continue 专属功能'
    })
    expect(runtimeToolbar).toHaveClass('composer__runtime-toolbar')
    expect(runtimeToolbar).toContainElement(presetPicker)
    expect(
      screen.getByRole('group', { name: '对话设置' })
    ).not.toContainElement(presetPicker)
    fireEvent.click(presetPicker)
    fireEvent.click(
      within(
        screen.getByRole('menu', {
          name: 'Continue 配置预设'
        })
      ).getByRole('menuitemradio', { name: /代码审查/u })
    )
    const actionPicker = screen.getByRole('button', {
      name: /Runtime 快捷操作/u
    })
    expect(runtimeToolbar).toContainElement(actionPicker)
    fireEvent.click(actionPicker)
    fireEvent.click(
      within(
        screen.getByRole('menu', {
          name: 'Runtime 快捷操作'
        })
      ).getByRole('menuitemradio', { name: /审查草稿/u })
    )
    const composer = screen.getByLabelText('向 GoodBuddy 提问')
    expect(composer).toHaveValue('请审查当前草稿。')
    fireEvent.change(composer, {
      target: { value: '请审查当前草稿，并优先检查权限。' }
    })
    fireEvent.click(screen.getByLabelText('发送'))

    await waitFor(() =>
      expect(run).toHaveBeenCalledWith(
        expect.objectContaining({
          prompt: '请审查当前草稿，并优先检查权限。',
          runtimeControl: {
            provider: 'continue',
            presetId
          }
        })
      )
    )
  })

  it('manually compacts Continue context and persists the summary state', async () => {
    const conversationId =
      '00000000-0000-4000-8000-000000000731'
    const messages = [
      {
        id: '00000000-0000-4000-8000-000000000732',
        role: 'user' as const,
        content: '第一轮问题',
        createdAt: 1_775_000_000_000,
        state: 'complete' as const
      },
      {
        id: '00000000-0000-4000-8000-000000000733',
        role: 'assistant' as const,
        content: '第一轮回答',
        createdAt: 1_775_000_000_001,
        state: 'complete' as const
      }
    ]
    const summaryState = {
      coveredHistoryDigest: 'a'.repeat(64),
      coveredMessageCount: 1,
      coveredFromMessageId: messages[0]!.id,
      coveredThroughMessageId: messages[0]!.id,
      summary: '用户提出了第一轮问题。'
    }
    const settings = await api.settings.getRuntime()
    vi.mocked(api.settings.getRuntime).mockResolvedValueOnce({
      ...settings,
      contextCompression: {
        enabled: true,
        triggerTokens: 20_000,
        recentRawTokens: 4_000,
        modelSource: { kind: 'current' },
        summaryPrompt: 'Preserve important facts.'
      }
    })
    vi.mocked(api.conversations.list).mockResolvedValueOnce([
      {
        id: conversationId,
        projectId,
        runtimeSelection: { provider: 'continue' },
        title: 'Continue 长对话',
        updatedAt: 1_775_000_000_001,
        messages
      }
    ])
    vi.mocked(api.agent.getStatus).mockResolvedValueOnce({
      id: 'continue',
      label: 'Continue',
      available: true,
      supportsToolExecution: true,
      detail: 'Ready'
    })
    vi.mocked(
      api.runtimeCustomization.getNativeSnapshot
    ).mockResolvedValueOnce({
      provider: 'continue',
      available: true,
      inventoryStatus: 'available',
      detail: 'Ready',
      agents: [],
      tools: [],
      toolsSupported: false,
      commands: [],
      lsp: [],
      formatters: [],
      mcpServers: [],
      skills: [],
      rules: [],
      prompts: [],
      resources: [],
      resourcesSupported: false,
      context: {
        strategy: 'goodbuddy-summary',
        manualCompact: true,
        detail: 'GoodBuddy summary context'
      }
    })
    vi.mocked(api.agent.compactConversation).mockResolvedValueOnce({
      provider: 'continue',
      strategy: 'goodbuddy-summary',
      compacted: true,
      detail: '已压缩 Continue 对话历史',
      contextCompressionState: summaryState
    })

    render(<App />)

    const compactContext = await screen.findByRole('button', {
      name: '压缩上下文'
    })
    expect(compactContext.parentElement).toHaveClass(
      'composer-meta',
      'composer-meta--with-context-compact'
    )
    expect(
      compactContext.parentElement?.firstElementChild
    ).toBe(compactContext)
    fireEvent.click(compactContext)
    await waitFor(() =>
      expect(api.agent.compactConversation).toHaveBeenCalledWith({
        requestId: expect.any(String),
        conversationId,
        projectId,
        runtimeSelection: { provider: 'continue' },
        history: messages.map(({ role, content }) => ({
          role,
          content
        })),
        historyMessageIds: messages.map((message) => message.id),
        contextCompressionState: undefined
      })
    )
    expect(
      await screen.findByText('已压缩 Continue 对话历史')
    ).toBeInTheDocument()
    expect(
      await screen.findByText(/压缩后对话估算/u)
    ).not.toHaveTextContent('压缩线')
    await waitFor(() =>
      expect(api.conversations.saveLocal).toHaveBeenCalledWith([
        expect.objectContaining({
          header: expect.objectContaining({
            contextCompressionState: summaryState,
            contextMetrics: expect.objectContaining({
              basis: 'conversation',
              source: 'estimated'
            })
          })
        })
      ])
    )
  })

  it('restores the direct-model mode after leaving an Agent Runtime', async () => {
    const settings = await api.settings.getRuntime()
    vi.mocked(api.settings.getRuntime).mockResolvedValueOnce({
      ...settings,
      provider: 'opencode',
      opencodeEmbedded: true,
      opencodeModelSource: { kind: 'platform' }
    })
    vi.mocked(api.agent.getStatus)
      .mockResolvedValueOnce({
        id: 'opencode',
        label: 'OpenCode',
        available: true,
        supportsToolExecution: true,
        detail: 'Ready'
      })
      .mockResolvedValueOnce({
        id: 'model',
        label: 'sonnet-5',
        available: true,
        supportsToolExecution: false,
        detail: 'Ready'
      })
    render(<App />)

    const mode = await screen.findByRole('button', {
      name: '工作模式：Ask · 只读问答'
    })
    expect(mode).toBeEnabled()
    selectComposerOption('工作模式', 'Execute · 受控执行')
    expect(mode).toHaveAccessibleName(
      '工作模式：Execute · 受控执行'
    )

    fireEvent.click(await screen.findByRole('button', { name: /OpenCode/u }))
    fireEvent.click(
      screen.getByRole('menuitemradio', {
        name: /^默认模型.*sonnet-5$/u
      })
    )

    await waitFor(() => {
      expect(mode).toHaveAccessibleName('工作模式：Ask · 只读问答')
      expect(mode).toBeEnabled()
    })
  })

  it('disables Execute for a runtime without tool support', async () => {
    vi.mocked(api.agent.getStatus).mockResolvedValue({
      id: 'model',
      label: 'legacy-model',
      available: true,
      supportsToolExecution: false,
      detail: 'Ready'
    })
    render(<App />)

    const mode = await screen.findByRole('button', {
      name: '工作模式：Ask · 只读问答'
    })
    const modeMenu = openComposerMenu('工作模式')
    expect(
      within(modeMenu).getByRole('menuitemradio', {
        name: /^Execute · 受控执行/u
      })
    ).toBeDisabled()
    expect(mode).toHaveAccessibleName('工作模式：Ask · 只读问答')
  })

  it('allows a direct model to submit Execute with GoodBuddy approvals', async () => {
    vi.mocked(api.agent.getStatus).mockResolvedValue({
      id: 'model',
      label: 'sonnet-5',
      available: true,
      supportsToolExecution: true,
      detail: 'Ready'
    })
    render(<App />)

    const mode = await screen.findByRole('button', {
      name: '工作模式：Ask · 只读问答'
    })
    selectComposerOption('工作模式', 'Execute · 受控执行')
    fireEvent.change(screen.getByLabelText('向 GoodBuddy 提问'), {
      target: { value: '读取项目文件' }
    })
    fireEvent.click(await screen.findByLabelText('发送'))

    await waitFor(() =>
      expect(run).toHaveBeenCalledWith(
        expect.objectContaining({
          prompt: '读取项目文件',
          workMode: 'execute'
        })
      )
    )
    expect(mode).toBeDisabled()
  })

  it('terminalizes tools and activity when a request is cancelled', async () => {
    vi.mocked(api.agent.getStatus).mockResolvedValue({
      id: 'opencode',
      label: 'OpenCode',
      available: true,
      supportsToolExecution: true,
      detail: 'Ready'
    })
    render(<App />)
    fireEvent.change(screen.getByLabelText('向 GoodBuddy 提问'), {
      target: { value: '执行长任务' }
    })
    fireEvent.click(await screen.findByLabelText('发送'))
    await waitFor(() => expect(run).toHaveBeenCalledOnce())
    const request = run.mock.calls[0]?.[0]
    if (!request) {
      throw new Error('Missing request')
    }

    act(() => {
      agentListener?.({
        requestId: request.requestId,
        type: 'tool',
        callId: 'call-1',
        name: 'bash',
        state: 'running',
        summary: 'OpenCode 工具：bash'
      })
      agentListener?.({
        requestId: request.requestId,
        type: 'error',
        status: 'cancelled',
        message: '请求已取消'
      })
    })

    expect(await screen.findByText('已取消')).toBeInTheDocument()
    const cancelledStatus = screen
      .getAllByText('请求已取消')
      .find((element) => element.classList.contains('message__status'))
    expect(cancelledStatus).toBeDefined()
    const cancelledDot = cancelledStatus?.querySelector(
      '.message__status-dot'
    )
    expect(cancelledDot).toHaveClass('message__status-dot')
    expect(cancelledDot).not.toHaveClass('message__status-dot--active')
    fireEvent.click(screen.getByText('运行记录'))
    expect((await screen.findAllByText('已取消')).length).toBeGreaterThan(0)
    fireEvent.click(screen.getByRole('button', { name: '进行中' }))
    expect(
      screen.getByText('当前没有等待中或正在运行的活动。')
    ).toBeInTheDocument()
  })

  it('keeps persisted completed message statuses static', async () => {
    vi.mocked(api.conversations.list).mockResolvedValueOnce([
      {
        id: '00000000-0000-4000-8000-000000000210',
        projectId,
        title: '已完成会话',
        updatedAt: 1_775_000_000_000,
        messages: [
          {
            id: '00000000-0000-4000-8000-000000000211',
            role: 'assistant',
            content: '任务结果',
            createdAt: 1_775_000_000_000,
            state: 'complete',
            status: '任务已完成'
          }
        ]
      }
    ])

    render(<App />)

    const completedStatus = await screen.findByText('任务已完成')
    expect(
      completedStatus.querySelector('.message__status-dot')
    ).toHaveClass('message__status-dot')
    expect(
      completedStatus.querySelector('.message__status-dot')
    ).not.toHaveClass('message__status-dot--active')
  })

  it('switches runtime profiles from the composer dropdown', async () => {
    render(<App />)

    const runtimeButton = await screen.findByRole('button', {
      name: /sonnet-5/u
    })
    fireEvent.click(runtimeButton)
    expect(
      await screen.findByRole('menu', { name: 'Runtime 和模型' })
    ).toBeInTheDocument()
    expect(
      screen.queryByText('自动选择')
    ).not.toBeInTheDocument()
    expect(
      screen.getByRole('menuitemradio', {
        name: /^默认模型.*sonnet-5$/u
      })
    ).toBeInTheDocument()
    expect(
      screen.getByRole('menuitemradio', {
        name: /^OpenCode · 默认模型.*sonnet-5$/u
      })
    ).toBeInTheDocument()
    expect(
      screen.getByRole('menuitemradio', {
        name: /^Continue · 默认模型.*sonnet-5$/u
      })
    ).toBeInTheDocument()
    expect(
      screen.getByRole('menuitemradio', {
        name: /^DeepSeek Harness · 自身配置/u
      })
    ).toBeInTheDocument()
    fireEvent.click(
      screen.getByRole('menuitemradio', {
        name: /^默认模型.*sonnet-5$/u
      })
    )

    await waitFor(() =>
      expect(api.agent.getStatus).toHaveBeenLastCalledWith({
        provider: 'model',
        profileId: modelProfileId
      })
    )
    expect(api.settings.updateRuntime).not.toHaveBeenCalled()
    expect(
      screen.queryByRole('heading', { name: '设置中心' })
    ).not.toBeInTheDocument()
  })

  it('shows Runtime switches globally without replacing composer guidance', async () => {
    render(<App />)
    const runtimeButton = await screen.findByRole('button', {
      name: /sonnet-5/u
    })
    vi.useFakeTimers()
    try {
      fireEvent.click(runtimeButton)
      fireEvent.click(
        screen.getByRole('menuitemradio', {
          name: /^OpenCode · 默认模型.*sonnet-5$/u
        })
      )
      await act(async () => {
        await Promise.resolve()
      })

      const notification = screen.getByRole('status')
      expect(notification).toHaveTextContent(
        '当前对话已切换到 OpenCode · 默认模型'
      )
      expect(
        screen.getByRole('button', {
          name: '工作模式：Ask · 只读问答'
        })
      ).toBeInTheDocument()

      fireEvent.click(
        screen.getByRole('button', {
          name: /OpenCode · 默认模型/u
        })
      )
      fireEvent.click(
        screen.getByRole('menuitemradio', {
          name: /^Continue · 默认模型.*sonnet-5$/u
        })
      )
      await act(async () => {
        await Promise.resolve()
      })
      expect(screen.getAllByRole('status')).toHaveLength(1)
      expect(screen.getByRole('status')).toHaveTextContent(
        '当前对话已切换到 Continue · 默认模型'
      )

      act(() => vi.advanceTimersByTime(4_500))
      expect(
        screen.queryByText(
          '当前对话已切换到 Continue · 默认模型'
        )
      ).not.toBeInTheDocument()
      expect(
        screen.getByRole('button', {
          name: '工作模式：Ask · 只读问答'
        })
      ).toBeInTheDocument()
    } finally {
      vi.useRealTimers()
    }
  })

  it('shows one configured choice per Agent Runtime in a flat keyboard menu', async () => {
    const settings = await api.settings.getRuntime()
    const secondProfileId =
      '00000000-0000-4000-8000-000000000002'
    vi.mocked(api.settings.getRuntime).mockResolvedValueOnce({
      ...settings,
      provider: 'model',
      modelProfiles: [
        ...settings.modelProfiles,
        {
          id: secondProfileId,
          name: '第二模型',
          baseUrl: 'http://127.0.0.1:11434/v1',
          modelName: 'qwen3',
          protocol: 'openai-chat-completions',
          authentication: 'none',
          imageGenerationQuality: 'auto',
          apiKeyConfigured: false,
          credentialSource: 'none'
        }
      ]
    })
    render(<App />)

    const runtimeButton = await screen.findByRole('button', {
      name: /sonnet-5/u
    })
    fireEvent.click(runtimeButton)
    const runtimeMenu = screen.getByRole('menu', {
      name: 'Runtime 和模型'
    })
    const directModel = screen.getByRole('menuitemradio', {
      name: /^默认模型.*sonnet-5$/u
    })
    const secondDirectModel = screen.getByRole('menuitemradio', {
      name: /^第二模型.*qwen3$/u
    })
    const openCodeModel = screen.getByRole('menuitemradio', {
      name: /^OpenCode · 默认模型.*sonnet-5$/u
    })
    const continueModel = screen.getByRole('menuitemradio', {
      name: /^Continue · 默认模型.*sonnet-5$/u
    })
    const deepseekHarness = screen.getByRole('menuitemradio', {
      name: /^DeepSeek Harness · 自身配置/u
    })
    expect(directModel).toBeEnabled()
    expect(secondDirectModel).toBeEnabled()
    expect(openCodeModel).toBeEnabled()
    expect(continueModel).toBeEnabled()
    expect(deepseekHarness).toBeEnabled()
    expect(screen.getAllByRole('menuitemradio')).toHaveLength(5)
    expect(within(runtimeMenu).getAllByRole('separator')).toHaveLength(4)
    expect(within(runtimeMenu).queryByRole('menu')).not.toBeInTheDocument()
    expect(
      screen.queryByRole('menuitemradio', {
        name: /^OpenCode · 第二模型/u
      })
    ).not.toBeInTheDocument()
    expect(
      screen.queryByRole('menuitemradio', {
        name: /^Continue · 第二模型/u
      })
    ).not.toBeInTheDocument()
    expect(
      screen.queryByRole('menuitem', { name: /Agent Runtime/u })
    ).not.toBeInTheDocument()

    await waitFor(() => expect(directModel).toHaveFocus())
    expect(directModel).toHaveAttribute('tabindex', '0')
    expect(secondDirectModel).toHaveAttribute('tabindex', '-1')
    fireEvent.keyDown(directModel, { key: 'ArrowDown' })
    expect(secondDirectModel).toHaveFocus()
    expect(directModel).toHaveAttribute('tabindex', '-1')
    expect(secondDirectModel).toHaveAttribute('tabindex', '0')
    fireEvent.keyDown(secondDirectModel, { key: 'ArrowDown' })
    expect(openCodeModel).toHaveFocus()
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' })
    expect(runtimeButton).toHaveFocus()
    expect(
      screen.queryByRole('menu', { name: 'Runtime 和模型' })
    ).not.toBeInTheDocument()

    fireEvent.click(runtimeButton)
    fireEvent.click(
      screen.getByRole('menuitemradio', {
        name: /^OpenCode · 默认模型.*sonnet-5$/u
      })
    )
    expect(runtimeButton).toHaveFocus()
    await waitFor(() =>
      expect(api.agent.getStatus).toHaveBeenLastCalledWith({
        provider: 'opencode',
        profileId: modelProfileId
      })
    )

    const selectedRuntimeButton = await screen.findByRole('button', {
      name: /OpenCode · 默认模型/u
    })
    fireEvent.click(selectedRuntimeButton)
    const selectedOpenCodeModel = screen.getByRole('menuitemradio', {
      name: /^OpenCode · 默认模型.*sonnet-5$/u
    })
    await waitFor(() => expect(selectedOpenCodeModel).toHaveFocus())
    expect(selectedOpenCodeModel).toHaveAttribute('aria-checked', 'true')
    expect(selectedOpenCodeModel).toHaveAttribute('tabindex', '0')
    fireEvent.click(
      screen.getByRole('menuitemradio', {
        name: /^Continue · 默认模型.*sonnet-5$/u
      })
    )
    await waitFor(() =>
      expect(api.agent.getStatus).toHaveBeenLastCalledWith({
        provider: 'continue',
        profileId: modelProfileId
      })
    )
  })

  it('dismisses the Runtime menu on outside pointer and focus changes', async () => {
    render(<App />)

    const runtimeButton = await screen.findByRole('button', {
      name: /sonnet-5/u
    })
    const composer = screen.getByLabelText('向 GoodBuddy 提问')

    fireEvent.click(runtimeButton)
    expect(
      screen.getByRole('menu', { name: 'Runtime 和模型' })
    ).toBeInTheDocument()
    fireEvent.pointerDown(composer)
    expect(
      screen.queryByRole('menu', { name: 'Runtime 和模型' })
    ).not.toBeInTheDocument()

    fireEvent.click(runtimeButton)
    const selectedModel = screen.getByRole('menuitemradio', {
      name: /^默认模型.*sonnet-5$/u
    })
    await waitFor(() => expect(selectedModel).toHaveFocus())
    fireEvent.keyDown(selectedModel, { key: 'Tab' })
    composer.focus()
    expect(composer).toHaveFocus()
    await waitFor(() =>
      expect(
        screen.queryByRole('menu', { name: 'Runtime 和模型' })
      ).not.toBeInTheDocument()
    )
  })

  it('labels explicitly configured Runtime-owned model sources', async () => {
    const settings = await api.settings.getRuntime()
    vi.mocked(api.settings.getRuntime).mockResolvedValueOnce({
      ...settings,
      provider: 'model',
      opencodeModelSource: { kind: 'platform' },
      continueModelSource: { kind: 'platform' }
    })
    render(<App />)

    fireEvent.click(
      await screen.findByRole('button', { name: /sonnet-5/u })
    )
    expect(
      screen.getByRole('menuitemradio', {
        name: /^OpenCode · 自身配置.*使用 OpenCode 自身配置$/u
      })
    ).toBeInTheDocument()
    const continueChoice = screen.getByRole('menuitemradio', {
      name: /^Continue · 自身配置.*使用 Continue 自身配置$/u
    })
    fireEvent.click(continueChoice)
    await waitFor(() =>
      expect(api.agent.getStatus).toHaveBeenLastCalledWith({
        provider: 'continue'
      })
    )
  })

  it('persists metadata-only retrieval and Runtime changes without rewriting messages', async () => {
    const conversationId =
      '00000000-0000-4000-8000-000000000451'
    const existingMessageId =
      '00000000-0000-4000-8000-000000000452'
    const libraryId = '11111111-1111-4111-8111-111111111111'
    const secondProfileId =
      '00000000-0000-4000-8000-000000000453'
    const settings = await api.settings.getRuntime()
    vi.mocked(api.settings.getRuntime).mockResolvedValueOnce({
      ...settings,
      modelProfiles: [
        ...settings.modelProfiles,
        {
          id: secondProfileId,
          name: '仅元数据模型',
          baseUrl: 'http://127.0.0.1:11434/v1',
          modelName: 'qwen3',
          protocol: 'openai-chat-completions',
          authentication: 'none',
          imageGenerationQuality: 'auto',
          apiKeyConfigured: false,
          credentialSource: 'none'
        }
      ]
    })
    vi.mocked(api.knowledge.getSnapshot).mockResolvedValueOnce({
      libraries: [
        {
          id: libraryId,
          name: '产品知识',
          description: '',
          storageMode: 'managed',
          graphEnabled: false,
          graphStrategy: 'rules',
          sourceCount: 1,
          documentCount: 1,
          indexedDocumentCount: 1
        }
      ],
      sources: [],
      documents: [],
      graphNodes: [],
      graphRelations: [],
      evidence: []
    })
    vi.mocked(api.conversations.list).mockResolvedValueOnce([
      {
        id: conversationId,
        projectId,
        runtimeSelection: {
          provider: 'model',
          profileId: modelProfileId
        },
        knowledgeRetrievalMode: 'auto',
        title: '元数据会话',
        updatedAt: 1_775_000_000_000,
        messages: [
          {
            id: existingMessageId,
            role: 'assistant',
            content: '现有消息不应重写',
            createdAt: 1_775_000_000_000,
            state: 'complete'
          }
        ]
      }
    ])
    vi.mocked(api.agent.getStatus).mockImplementation(
      async (selection) => ({
        id: 'model',
        label:
          selection?.provider === 'model' &&
          selection.profileId === secondProfileId
            ? 'qwen3'
            : 'sonnet-5',
        available: true,
        supportsToolExecution: true,
        detail: 'Ready'
      })
    )
    render(<App />)

    const knowledgeScope = await screen.findByRole('button', {
      name: '选择知识库，本次已启用 1 个'
    })
    fireEvent.click(knowledgeScope)
    fireEvent.click(
      within(
        screen.getByRole('group', { name: '知识检索方式' })
      ).getByRole('button', { name: '每次先检索' })
    )
    await waitFor(
      () =>
        expect(api.conversations.saveLocal).toHaveBeenCalledWith([
          {
            header: expect.objectContaining({
              id: conversationId,
              knowledgeRetrievalMode: 'always'
            }),
            messages: []
          }
        ]),
      { timeout: 2_000 }
    )

    vi.mocked(api.conversations.saveLocal).mockClear()
    fireEvent.click(
      screen.getByRole('button', { name: /sonnet-5/u })
    )
    fireEvent.click(
      screen.getByRole('menuitemradio', {
        name: /^仅元数据模型.*qwen3$/u
      })
    )
    await waitFor(
      () =>
        expect(api.conversations.saveLocal).toHaveBeenCalledWith([
          {
            header: expect.objectContaining({
              id: conversationId,
              runtimeSelection: {
                provider: 'model',
                profileId: secondProfileId
              },
              knowledgeRetrievalMode: 'always'
            }),
            messages: []
          }
        ]),
      { timeout: 2_000 }
    )
    const savedMessages = vi
      .mocked(api.conversations.saveLocal)
      .mock.calls.flatMap(([batch]) =>
        batch.flatMap((entry) => entry.messages)
      )
    expect(
      savedMessages.some((message) => message.id === existingMessageId)
    ).toBe(false)
  })

  it('migrates legacy startup conversations with replace when SQLite has no local conversation', async () => {
    const settings = await api.settings.getRuntime()
    vi.mocked(api.settings.getRuntime).mockResolvedValueOnce({
      ...settings,
      modelProfiles: settings.modelProfiles.map((profile) => ({
        ...profile,
        contextWindowTokens: undefined
      })),
      contextCompression: {
        enabled: true,
        triggerTokens: 12_000,
        recentRawTokens: 4_000,
        modelSource: { kind: 'current' },
        summaryPrompt: 'Preserve important facts.'
      }
    })
    const normalizedContextMetrics = {
      runtimeSelectionKey: `model:${settings.defaultModelProfileId}`,
      contextTokens: 9_000,
      source: 'provider' as const,
      basis: 'model-call' as const
    }
    const legacyConversation = {
      id: '00000000-0000-4000-8000-000000000461',
      runtimeSelection: {
        provider: 'model' as const,
        profileId: settings.defaultModelProfileId
      },
      contextMetrics: {
        ...normalizedContextMetrics,
        effectiveTriggerTokens: 20_000,
        contextWindowTokens: 32_000,
        compressionEnabled: true
      },
      title: '待迁移旧会话',
      updatedAt: 1_775_000_000_000,
      messages: [
        {
          id: '00000000-0000-4000-8000-000000000462',
          role: 'assistant' as const,
          content: '旧版浏览器存储消息',
          createdAt: 1_775_000_000_000,
          state: 'complete' as const
        }
      ]
    }
    localStorage.setItem(
      'goodbuddy.conversations.v1',
      JSON.stringify([legacyConversation])
    )
    render(<App />)

    expect(
      await screen.findByText('旧版浏览器存储消息')
    ).toBeInTheDocument()
    expect(
      screen.getByText('本次调用 9.0K · 压缩线 12.0K')
    ).toBeInTheDocument()
    await waitFor(() =>
      expect(api.conversations.replace).toHaveBeenCalledWith([
        expect.objectContaining({
          ...legacyConversation,
          contextMetrics: normalizedContextMetrics,
          projectId
        })
      ])
    )
    expect(api.conversations.saveLocal).not.toHaveBeenCalled()
  })

  it('does not let remote rows displace legacy local conversations during migration', async () => {
    const legacyConversations = [0, 1].map((index) => ({
      id: `00000000-0000-4000-8000-${String(470 + index).padStart(12, '0')}`,
      title: `待迁移本地会话 ${index}`,
      updatedAt: 1_775_000_000_000 + index,
      messages: [
        {
          id: `00000000-0000-4000-8001-${String(470 + index).padStart(12, '0')}`,
          role: 'assistant' as const,
          content: `待迁移消息 ${index}`,
          createdAt: 1_775_000_000_000 + index,
          state: 'complete' as const
        }
      ]
    }))
    localStorage.setItem(
      'goodbuddy.conversations.v1',
      JSON.stringify(legacyConversations)
    )
    const remoteProjectId =
      '00000000-0000-4000-8000-000000000499'
    vi.mocked(api.conversations.list).mockResolvedValueOnce(
      Array.from({ length: 100 }, (_, index) => ({
        id: `00000000-0000-4000-8002-${String(index).padStart(12, '0')}`,
        projectId: remoteProjectId,
        remote: {
          channel: 'weixin' as const,
          accountDisplay: `远程联系人 ${index}`,
          conversationType: 'direct' as const
        },
        title: `远程会话 ${index}`,
        updatedAt: 1_775_000_100_000 + index,
        messages: []
      }))
    )
    render(<App />)

    await waitFor(() =>
      expect(api.conversations.saveLocal).toHaveBeenCalled()
    )
    expect(api.conversations.replace).not.toHaveBeenCalled()
    const migrated =
      vi.mocked(api.conversations.saveLocal).mock.calls[0]?.[0] ?? []
    expect(migrated.map((conversation) => conversation.header.id)).toEqual(
      expect.arrayContaining(
        legacyConversations.map((conversation) => conversation.id)
      )
    )
  })

  it('preserves a legacy Auto conversation without silently persisting a replacement', async () => {
    const settings = await api.settings.getRuntime()
    vi.mocked(api.settings.getRuntime).mockResolvedValueOnce({
      ...settings,
      provider: 'auto',
      opencodeBaseUrl: '',
      opencodeEmbedded: false,
      modelProfiles: settings.modelProfiles.map((profile) => ({
        ...profile,
        contextWindowTokens: 32_000
      })),
      contextCompression: {
        enabled: true,
        triggerTokens: 20_000,
        recentRawTokens: 4_000,
        modelSource: { kind: 'current' },
        summaryPrompt: 'Preserve important facts.'
      }
    })
    vi.mocked(api.conversations.list).mockResolvedValueOnce([
      {
        id: '00000000-0000-4000-8000-000000000020',
        projectId,
        runtimeSelection: { provider: 'auto' },
        contextMetrics: {
          runtimeSelectionKey: 'auto:default',
          contextTokens: 9_000,
          source: 'provider',
          basis: 'model-call'
        },
        title: '旧自动对话',
        updatedAt: 1,
        messages: [
          {
            id: '00000000-0000-4000-8000-000000000021',
            role: 'assistant',
            content: '旧消息',
            createdAt: 1,
            state: 'complete'
          }
        ]
      }
    ])
    render(<App />)

    expect(
      await screen.findByRole('button', { name: /自动.*sonnet-5/u })
    ).toBeInTheDocument()
    expect(
      screen.queryByText(/本次调用 9\.0K/u)
    ).not.toBeInTheDocument()
    expect(screen.queryByText(/压缩线/u)).not.toBeInTheDocument()
    expect(api.conversations.replace).not.toHaveBeenCalled()
    expect(api.conversations.saveLocal).not.toHaveBeenCalled()

    fireEvent.change(screen.getByLabelText('向 GoodBuddy 提问'), {
      target: { value: '刷新自动 Runtime 用量' }
    })
    fireEvent.click(screen.getByLabelText('发送'))
    await waitFor(() => expect(run).toHaveBeenCalledOnce())
    const request = run.mock.calls[0]?.[0]
    if (!request) {
      throw new Error('Missing request')
    }
    act(() => {
      agentListener?.({
        requestId: request.requestId,
        type: 'context-metrics',
        contextTokens: 9_000,
        effectiveTriggerTokens: 20_000,
        compressionEnabled: false,
        source: 'provider'
      })
    })
    expect(screen.getByText(/本次调用 9\.0K/u)).toBeInTheDocument()
    expect(screen.queryByText(/压缩线/u)).not.toBeInTheDocument()
    const currentRuntimeSelectionKey =
      settings.opencodeModelSource.kind === 'profile'
        ? `opencode:${settings.opencodeModelSource.profileId}`
        : 'opencode:platform'
    await waitFor(() =>
      expect(api.conversations.saveLocal).toHaveBeenCalledWith([
        expect.objectContaining({
          header: expect.objectContaining({
            contextMetrics: expect.objectContaining({
              runtimeSelectionKey: currentRuntimeSelectionKey
            })
          })
        })
      ])
    )
  })

  it('keeps a removed model selection visible until the user replaces it', async () => {
    const removedProfileId =
      '00000000-0000-4000-8000-000000000099'
    vi.mocked(api.conversations.list).mockResolvedValueOnce([
      {
        id: '00000000-0000-4000-8000-000000000022',
        projectId,
        runtimeSelection: {
          provider: 'model',
          profileId: removedProfileId
        },
        title: '旧模型对话',
        updatedAt: 1,
        messages: [
          {
            id: '00000000-0000-4000-8000-000000000023',
            role: 'assistant',
            content: '旧消息',
            createdAt: 1,
            state: 'complete'
          }
        ]
      }
    ])
    render(<App />)

    expect(
      await screen.findByText('旧消息')
    ).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: /模型配置不可用/u })
    ).toBeInTheDocument()
    expect(api.conversations.replace).not.toHaveBeenCalled()
    expect(api.conversations.saveLocal).not.toHaveBeenCalled()
  })

  it('keeps model Runtime selection scoped to its conversation', async () => {
    const secondProfileId =
      '00000000-0000-4000-8000-000000000002'
    const settings = await api.settings.getRuntime()
    vi.mocked(api.settings.getRuntime).mockResolvedValueOnce({
      ...settings,
      modelProfiles: [
        ...settings.modelProfiles,
        {
          id: secondProfileId,
          name: '第二模型',
          baseUrl: 'http://127.0.0.1:11434/v1',
          modelName: 'qwen3',
          protocol: 'openai-chat-completions',
          authentication: 'none',
          imageGenerationQuality: 'auto',
          apiKeyConfigured: false,
          credentialSource: 'none'
        }
      ]
    })
    vi.mocked(api.agent.getStatus).mockImplementation(
      async (selection) => ({
        id: 'model',
        label:
          selection?.provider === 'model' &&
          selection.profileId === secondProfileId
            ? 'qwen3'
            : 'sonnet-5',
        available: true,
        supportsToolExecution: true,
        detail: 'Ready'
      })
    )
    render(<App />)

    fireEvent.click(
      await screen.findByRole('button', { name: /sonnet-5/u })
    )
    fireEvent.click(
      screen.getByRole('menuitemradio', {
        name: /^第二模型.*qwen3$/u
      })
    )
    expect(
      await screen.findByRole('button', { name: /第二模型/u })
    ).toBeInTheDocument()

    fireEvent.change(screen.getByLabelText('向 GoodBuddy 提问'), {
      target: { value: '第二模型对话' }
    })
    fireEvent.click(screen.getByLabelText('发送'))
    await waitFor(() => expect(run).toHaveBeenCalledOnce())
    const request = run.mock.calls[0]?.[0]
    expect(request?.runtimeSelection).toEqual({
      provider: 'model',
      profileId: secondProfileId
    })
    if (!request) {
      throw new Error('Missing request')
    }
    act(() => {
      agentListener?.({
        requestId: request.requestId,
        type: 'done'
      })
    })

    fireEvent.click(
      screen.getByRole('button', { name: /新建对话/u })
    )
    expect(
      await screen.findByRole('button', { name: /默认模型/u })
    ).toBeInTheDocument()
    const previousConversation = screen
      .getAllByText('第二模型对话')
      .map((element) => element.closest('button'))
      .find((button) => button?.classList.contains('conversation-item'))
    if (!previousConversation) {
      throw new Error('Missing previous conversation')
    }
    fireEvent.click(previousConversation)
    await waitFor(() =>
      expect(
        screen
          .getAllByRole('button', { name: /第二模型/u })
          .find((button) => button.classList.contains('model-button'))
      ).toBeInTheDocument()
    )

    await waitFor(
      () =>
        expect(api.conversations.saveLocal).toHaveBeenLastCalledWith(
          expect.arrayContaining([
            expect.objectContaining({
              header: expect.objectContaining({
                title: '第二模型对话',
                runtimeSelection: {
                  provider: 'model',
                  profileId: secondProfileId
                }
              }),
              messages: expect.any(Array)
            })
          ])
        ),
      { timeout: 2_000 }
    )
  })

  it('ignores a stale picker status after rapidly changing conversations', async () => {
    const secondProfileId =
      '00000000-0000-4000-8000-000000000002'
    const thirdProfileId =
      '00000000-0000-4000-8000-000000000003'
    const settings = await api.settings.getRuntime()
    vi.mocked(api.settings.getRuntime).mockResolvedValueOnce({
      ...settings,
      modelProfiles: [
        ...settings.modelProfiles,
        {
          id: secondProfileId,
          name: '第二模型',
          baseUrl: 'http://127.0.0.1:11434/v1',
          modelName: 'qwen3',
          protocol: 'openai-chat-completions',
          authentication: 'none',
          imageGenerationQuality: 'auto',
          apiKeyConfigured: false,
          credentialSource: 'none'
        },
        {
          id: thirdProfileId,
          name: '第三模型',
          baseUrl: 'http://127.0.0.1:11435/v1',
          modelName: 'llama3',
          protocol: 'openai-chat-completions',
          authentication: 'none',
          imageGenerationQuality: 'auto',
          apiKeyConfigured: false,
          credentialSource: 'none'
        }
      ]
    })
    let resolveThird!: (status: {
      id: 'model'
      label: string
      available: boolean
      supportsToolExecution: boolean
      detail: string
    }) => void
    const thirdStatus = new Promise<{
      id: 'model'
      label: string
      available: boolean
      supportsToolExecution: boolean
      detail: string
    }>((resolve) => {
      resolveThird = resolve
    })
    vi.mocked(api.agent.getStatus).mockImplementation(async (selection) => {
      if (
        selection?.provider === 'model' &&
        selection.profileId === thirdProfileId
      ) {
        return thirdStatus
      }
      return {
        id: 'model',
        label:
          selection?.provider === 'model' &&
          selection.profileId === secondProfileId
            ? 'qwen3'
            : 'sonnet-5',
        available: true,
        supportsToolExecution: true,
        detail: 'Ready'
      }
    })
    render(<App />)

    fireEvent.click(
      await screen.findByRole('button', { name: /sonnet-5/u })
    )
    fireEvent.click(
      screen.getByRole('menuitemradio', {
        name: /^第二模型.*qwen3$/u
      })
    )
    await screen.findByRole('button', { name: /第二模型/u })
    fireEvent.change(screen.getByLabelText('向 GoodBuddy 提问'), {
      target: { value: '保留第二模型会话' }
    })
    fireEvent.click(screen.getByLabelText('发送'))
    await waitFor(() => expect(run).toHaveBeenCalledOnce())
    const request = run.mock.calls[0]?.[0]
    if (!request) {
      throw new Error('Missing request')
    }
    act(() => {
      agentListener?.({ requestId: request.requestId, type: 'done' })
    })

    const secondModelButton = screen
      .getAllByRole('button', { name: /第二模型/u })
      .find((button) => button.classList.contains('model-button'))
    if (!secondModelButton) {
      throw new Error('Missing second model picker')
    }
    fireEvent.click(secondModelButton)
    fireEvent.click(
      screen.getByRole('menuitemradio', {
        name: /^第三模型.*llama3$/u
      })
    )
    await waitFor(() =>
      expect(api.agent.getStatus).toHaveBeenCalledWith({
        provider: 'model',
        profileId: thirdProfileId
      })
    )
    fireEvent.change(screen.getByLabelText('向 GoodBuddy 提问'), {
      target: { value: '状态未完成时不能发送' }
    })
    expect(screen.getByLabelText('发送')).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: /新建对话/u }))
    await screen.findByRole('button', { name: /默认模型/u })

    await act(async () => {
      resolveThird({
        id: 'model',
        label: 'llama3',
        available: true,
        supportsToolExecution: true,
        detail: 'Ready'
      })
      await thirdStatus
    })
    expect(
      screen.getByRole('button', { name: /默认模型/u })
    ).toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: /第三模型/u })
    ).not.toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('向 GoodBuddy 提问'), {
      target: { value: '新对话仍可发送' }
    })
    await waitFor(() => expect(screen.getByLabelText('发送')).toBeEnabled())
  })

  it('opens project creation as an unobscured dialog', async () => {
    render(<App />)

    const newProjectButton = await screen.findByLabelText('新建项目')
    fireEvent.click(newProjectButton)
    let dialog = screen.getByRole('dialog', { name: '新建项目' })
    expect(dialog).toHaveClass('project-create-card')
    expect(within(dialog).getByRole('button', { name: '创建' }))
      .toBeDisabled()
    expect(within(dialog).getByLabelText('名称')).toHaveFocus()

    fireEvent.keyDown(document, { key: 'Escape' })
    expect(
      screen.queryByRole('dialog', { name: '新建项目' })
    ).not.toBeInTheDocument()
    expect(newProjectButton).toHaveFocus()

    fireEvent.click(newProjectButton)
    dialog = screen.getByRole('dialog', { name: '新建项目' })

    fireEvent.change(within(dialog).getByLabelText('名称'), {
      target: { value: '新项目' }
    })
    fireEvent.click(within(dialog).getByRole('button', { name: '创建' }))

    await waitFor(() =>
      expect(api.projects.create).toHaveBeenCalledWith(
        expect.objectContaining({
          name: '新项目',
          rootPath: ''
        })
      )
    )
  })

  it('keeps project input when creation fails', async () => {
    vi.mocked(api.projects.create).mockRejectedValueOnce(
      new Error('项目目录不可用')
    )
    render(<App />)

    fireEvent.click(await screen.findByLabelText('新建项目'))
    const dialog = screen.getByRole('dialog', { name: '新建项目' })
    const nameInput = within(dialog).getByLabelText('名称')
    fireEvent.change(nameInput, {
      target: { value: '保留的项目名称' }
    })
    fireEvent.click(
      within(dialog).getByRole('button', { name: '创建' })
    )

    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      '项目目录不可用'
    )
    expect(nameInput).toHaveValue('保留的项目名称')
    expect(
      screen.getByRole('dialog', { name: '新建项目' })
    ).toBeInTheDocument()
  })

  it('edits and safely deletes the current project from project settings', async () => {
    const secondProject = {
      ...project,
      id: '00000000-0000-4000-8000-000000000102',
      name: '第二项目',
      rootPath: 'C:\\Second'
    }
    vi.mocked(api.projects.list).mockResolvedValueOnce([
      project,
      secondProject
    ])
    render(<App />)

    fireEvent.click(await screen.findByLabelText('项目设置'))
    let dialog = screen.getByRole('dialog', { name: '项目设置' })
    expect(within(dialog).getByLabelText('名称')).toHaveValue(
      project.name
    )
    expect(within(dialog).getByLabelText('根目录')).toHaveValue(
      project.rootPath
    )
    expect(
      within(dialog).getByLabelText('新对话默认 Runtime')
    ).toHaveValue('model')
    fireEvent.change(within(dialog).getByLabelText('说明'), {
      target: { value: '更新后的说明' }
    })
    fireEvent.change(
      within(dialog).getByLabelText('新对话默认 Runtime'),
      { target: { value: 'continue' } }
    )
    fireEvent.click(
      within(dialog).getByRole('button', { name: '保存项目' })
    )
    await waitFor(() =>
      expect(api.projects.update).toHaveBeenCalledWith(
        project.id,
        expect.objectContaining({
          description: '更新后的说明',
          rootPath: project.rootPath,
          runtimeSelection: {
            provider: 'continue',
            profileId: modelProfileId
          }
        })
      )
    )

    fireEvent.click(screen.getByLabelText('项目设置'))
    dialog = screen.getByRole('dialog', { name: '项目设置' })
    expect(dialog).toHaveTextContent('不会删除磁盘上的项目目录或文件')
    fireEvent.click(
      within(dialog).getByRole('button', { name: '删除项目' })
    )
    const confirmation = within(dialog).getByLabelText(
      `输入“${project.name}”确认删除`
    )
    const deleteButton = within(dialog).getByRole('button', {
      name: '永久删除项目'
    })
    expect(deleteButton).toBeDisabled()
    fireEvent.change(confirmation, {
      target: { value: project.name }
    })
    expect(deleteButton).toBeEnabled()
    fireEvent.click(deleteButton)

    await waitFor(() =>
      expect(api.projects.delete).toHaveBeenCalledWith(
        project.id,
        project.name
      )
    )
    expect(screen.getByRole('button', { name: '当前项目' })).toHaveTextContent(
      secondProject.name
    )
  })

  it('uses the project default Runtime for new conversations', async () => {
    vi.mocked(api.projects.list).mockResolvedValueOnce([
      {
        ...project,
        runtimeSelection: {
          provider: 'opencode',
          profileId: modelProfileId
        }
      }
    ])
    vi.mocked(api.conversations.list).mockResolvedValueOnce([
      {
        id: '00000000-0000-4000-8000-000000000220',
        projectId,
        runtimeSelection: {
          provider: 'model',
          profileId: modelProfileId
        },
        title: '已有对话',
        updatedAt: 1,
        messages: []
      }
    ])
    render(<App />)

    await screen.findAllByText('已有对话')
    fireEvent.click(
      screen.getByRole('button', { name: /新建对话/u })
    )

    await waitFor(() =>
      expect(api.agent.getStatus).toHaveBeenLastCalledWith({
        provider: 'opencode',
        profileId: modelProfileId
      })
    )
    expect(
      screen.getByRole('button', {
        name: /OpenCode · 默认模型/u
      })
    ).toBeInTheDocument()
  })

  it('uses a message icon for conversation navigation', async () => {
    render(<App />)

    const conversationNavigation = await screen.findByRole('button', {
      name: '对话'
    })
    expect(
      conversationNavigation.querySelector('.lucide-message-square')
    ).not.toBeNull()
    expect(
      conversationNavigation.querySelector('.lucide-history')
    ).toBeNull()
  })

  it('marks an image model and renders its generated artifact', async () => {
    const anchorClick = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(() => {})
    vi.mocked(api.agent.getStatus).mockResolvedValueOnce({
      id: 'model',
      label: 'gpt-image-2',
      available: true,
      supportsToolExecution: false,
      detail: 'OpenAI Images Generations',
      capability: 'image-generation'
    })
    render(<App />)

    expect((await screen.findAllByText('生图')).length).toBeGreaterThan(0)
    expect(screen.getByLabelText('向 GoodBuddy 提问')).toHaveAttribute(
      'placeholder',
      '描述你想生成的图片…\nEnter 发送 · Shift+Enter 换行 · Ctrl+V 粘贴图片或文本'
    )
    await waitFor(() =>
      expect(api.artifacts.list).toHaveBeenCalled()
    )

    fireEvent.change(screen.getByLabelText('向 GoodBuddy 提问'), {
      target: { value: '生成一只蓝色的猫' }
    })
    fireEvent.click(await screen.findByLabelText('发送'))
    await waitFor(() => expect(run).toHaveBeenCalledOnce())
    const request = run.mock.calls[0]?.[0]
    if (!request) {
      throw new Error('Missing request')
    }
    const artifactId = '00000000-0000-4000-8000-000000000301'
    vi.mocked(api.artifacts.get).mockResolvedValueOnce(
      {
        id: artifactId,
        projectId,
        taskId: request.requestId,
        kind: 'image',
        title: '生成一只蓝色的猫',
        mimeType: 'image/png',
        content:
          'data:image/png;base64,iVBORw0KGgoAAAAAAAAAAAAA',
        byteSize: 42,
        createdAt: '2026-08-01T00:00:00.000Z',
        updatedAt: '2026-08-01T00:00:00.000Z'
      }
    )

    act(() => {
      agentListener?.({
        requestId: request.requestId,
        type: 'artifact',
        artifactId,
        kind: 'image',
        title: '生成一只蓝色的猫'
      })
    })

    expect(
      await screen.findByRole('img', { name: '生成一只蓝色的猫' })
    ).toHaveAttribute('src', expect.stringMatching(/^data:image\/png/u))
    fireEvent.click(
      screen.getByRole('button', {
        name: '下载图片 生成一只蓝色的猫'
      })
    )
    expect(anchorClick).toHaveBeenCalledOnce()

    fireEvent.click(
      screen.getByRole('button', {
        name: '查看图片 生成一只蓝色的猫'
      })
    )
    const imageDialog = await screen.findByRole('dialog', {
      name: '生成一只蓝色的猫'
    })
    expect(
      within(imageDialog).getByRole('img', {
        name: '生成一只蓝色的猫'
      })
    ).toHaveAttribute('src', expect.stringMatching(/^data:image\/png/u))
    fireEvent.click(
      within(imageDialog).getByRole('button', { name: '下载图片' })
    )
    expect(anchorClick).toHaveBeenCalledTimes(2)
    fireEvent.keyDown(imageDialog, { key: 'Escape' })
    expect(
      screen.queryByRole('dialog', { name: '生成一只蓝色的猫' })
    ).not.toBeInTheDocument()
    anchorClick.mockRestore()
  })

  it('can dispatch a request to the parallel expert team', async () => {
    render(<App />)

    selectComposerOption('专家角色', '专家团队（并行）')
    fireEvent.change(screen.getByLabelText('向 GoodBuddy 提问'), {
      target: { value: '制定发布计划' }
    })
    fireEvent.click(await screen.findByLabelText('发送'))

    await waitFor(() =>
      expect(run).toHaveBeenCalledWith(
        expect.objectContaining({
          teamMode: true,
          expertId: undefined,
          prompt: '制定发布计划'
        })
      )
    )
  })

  it('requests smart routing only when enabled without an explicit expert', async () => {
    const settings = await api.settings.getRuntime()
    vi.mocked(api.settings.getRuntime).mockResolvedValueOnce({
      ...settings,
      subagentSmartRoutingEnabled: true
    })
    render(<App />)

    fireEvent.change(await screen.findByLabelText('向 GoodBuddy 提问'), {
      target: { value: '分析发布风险' }
    })
    fireEvent.click(screen.getByLabelText('发送'))

    await waitFor(() =>
      expect(run).toHaveBeenCalledWith(
        expect.objectContaining({
          smartRouting: true,
          expertId: undefined,
          teamMode: false,
          workMode: 'ask'
        })
      )
    )
  })

  it('gives an explicitly selected expert priority over smart routing', async () => {
    const expertId = '00000000-0000-4000-8000-000000000501'
    const settings = await api.settings.getRuntime()
    vi.mocked(api.settings.getRuntime).mockResolvedValueOnce({
      ...settings,
      subagentSmartRoutingEnabled: true
    })
    vi.mocked(api.experts.list).mockResolvedValueOnce([
      {
        id: expertId,
        name: '发布专家',
        description: '检查发布风险',
        systemInstructions: 'Review release risks.',
        routingKeywords: ['发布', '风险'],
        enabled: true,
        createdAt: '2026-08-01T00:00:00.000Z',
        updatedAt: '2026-08-01T00:00:00.000Z'
      }
    ])
    render(<App />)

    await waitFor(() => expect(api.experts.list).toHaveBeenCalled())
    const expertMenu = openComposerMenu('专家角色')
    fireEvent.click(
      (await within(expertMenu).findByText('发布专家', {
        selector: 'span'
      }))
        .closest<HTMLButtonElement>('button')!
    )
    fireEvent.change(screen.getByLabelText('向 GoodBuddy 提问'), {
      target: { value: '检查发布方案' }
    })
    fireEvent.click(screen.getByLabelText('发送'))

    await waitFor(() =>
      expect(run).toHaveBeenCalledWith(
        expect.objectContaining({
          expertId,
          smartRouting: undefined,
          teamMode: false
        })
      )
    )
  })

  it('shows bounded Subagent states and records child expert activity', async () => {
    render(<App />)
    fireEvent.change(await screen.findByLabelText('向 GoodBuddy 提问'), {
      target: { value: '分析复杂问题' }
    })
    fireEvent.click(screen.getByLabelText('发送'))
    await waitFor(() => expect(run).toHaveBeenCalledOnce())
    const request = run.mock.calls[0]?.[0]
    if (!request) {
      throw new Error('Missing request')
    }

    const events = [
      {
        childTaskId: '00000000-0000-4000-8000-000000000601',
        expertId: '00000000-0000-4000-8000-000000000701',
        expertName: '研究专家',
        routingMode: 'smart' as const,
        state: 'queued' as const
      },
      {
        childTaskId: '00000000-0000-4000-8000-000000000602',
        expertId: '00000000-0000-4000-8000-000000000702',
        expertName: '代码专家',
        routingMode: 'manual' as const,
        state: 'running' as const
      },
      {
        childTaskId: '00000000-0000-4000-8000-000000000603',
        expertId: '00000000-0000-4000-8000-000000000703',
        expertName: '安全专家',
        routingMode: 'smart' as const,
        state: 'failed' as const,
        error: '无法读取必要上下文'
      },
      {
        childTaskId: '00000000-0000-4000-8000-000000000604',
        expertId: '00000000-0000-4000-8000-000000000704',
        expertName: '第四位专家',
        routingMode: 'smart' as const,
        state: 'completed' as const
      }
    ]
    act(() => {
      for (const event of events) {
        agentListener?.({
          requestId: request.requestId,
          type: 'subagent',
          ...event
        })
      }
    })

    const statusRegion = await screen.findByLabelText('子专家状态')
    expect(within(statusRegion).getByText('研究专家')).toBeInTheDocument()
    expect(within(statusRegion).getByText('等待中')).toBeInTheDocument()
    expect(within(statusRegion).getByText('代码专家')).toBeInTheDocument()
    expect(within(statusRegion).getByText('进行中')).toBeInTheDocument()
    expect(within(statusRegion).getByText('安全专家')).toBeInTheDocument()
    expect(within(statusRegion).getByText('失败')).toBeInTheDocument()
    expect(
      within(statusRegion).getByText('无法读取必要上下文')
    ).toBeInTheDocument()
    expect(
      within(statusRegion).queryByText('第四位专家')
    ).not.toBeInTheDocument()

    act(() => {
      agentListener?.({
        requestId: request.requestId,
        type: 'subagent',
        ...events[0]!,
        state: 'completed',
        output: '研究专家的独立结论'
      })
      agentListener?.({
        requestId: request.requestId,
        type: 'subagent',
        ...events[1]!,
        state: 'cancelled',
        reason: '父任务已停止',
        output: '代码专家的部分结论'
      })
    })
    expect(within(statusRegion).getByText('已完成')).toBeInTheDocument()
    expect(within(statusRegion).getByText('已取消')).toBeInTheDocument()
    expect(within(statusRegion).getByText('父任务已停止')).toBeInTheDocument()
    expect(
      within(statusRegion).getByText('研究专家的独立结论')
    ).toBeInTheDocument()
    expect(
      within(statusRegion).getByText('代码专家的部分结论')
    ).toBeInTheDocument()
    await waitFor(() => {
      const persistedMessages = vi
        .mocked(api.conversations.saveLocal)
        .mock.calls.flatMap(([batch]) =>
          batch.flatMap((conversation) => conversation.messages)
        )
      expect(
        persistedMessages.some(
          (message) =>
            message.subagents?.[0]?.output ===
              '研究专家的独立结论' &&
            message.subagents?.[1]?.output === '代码专家的部分结论'
        )
      ).toBe(true)
    })

    fireEvent.click(screen.getByText('运行记录'))
    expect(await screen.findAllByText('子专家')).toHaveLength(4)
    expect(screen.getAllByText(/智能路由/u).length).toBeGreaterThan(0)
    expect(screen.getAllByText(/手动指定/u).length).toBeGreaterThan(0)
    expect(
      screen.getByText(/研究专家的独立结论/u)
    ).toBeInTheDocument()
    expect(
      screen.getByText(/代码专家的部分结论/u)
    ).toBeInTheDocument()
  })

  it('offers once, session, permanent, and deny for a tool call', async () => {
    render(<App />)

    fireEvent.change(screen.getByLabelText('向 GoodBuddy 提问'), {
      target: { value: '运行工具' }
    })
    fireEvent.click(await screen.findByLabelText('发送'))
    await waitFor(() => expect(run).toHaveBeenCalledOnce())
    const request = run.mock.calls[0]?.[0]
    if (!request) {
      throw new Error('Missing request')
    }

    act(() => {
      agentListener?.({
        requestId: request.requestId,
        type: 'approval',
        approvalId: crypto.randomUUID(),
        title: 'Continue 请求调用 Bash',
        description: '确认工具调用',
        toolName: 'Bash',
        argumentSummary: 'echo safe',
        allowPermanent: true
      })
    })

    expect(await screen.findByText('仅此次')).toBeInTheDocument()
    expect(screen.getByText('此会话')).toBeInTheDocument()
    expect(screen.getByText('永久允许')).toBeInTheDocument()
    expect(screen.getAllByText('拒绝')).toHaveLength(2)
    fireEvent.click(screen.getByText('此会话'))
    await waitFor(() =>
      expect(api.agent.respondApproval).toHaveBeenCalledWith(
        expect.any(String),
        'session'
      )
    )
  })

  it('renders and answers an OpenCode question request', async () => {
    render(<App />)
    fireEvent.change(screen.getByLabelText('向 GoodBuddy 提问'), {
      target: { value: '需要确认的任务' }
    })
    fireEvent.click(await screen.findByLabelText('发送'))
    await waitFor(() => expect(run).toHaveBeenCalledOnce())
    const request = run.mock.calls[0]?.[0]
    if (!request) {
      throw new Error('Missing request')
    }

    act(() => {
      agentListener?.({
        requestId: request.requestId,
        type: 'question',
        questionId: 'question-1',
        questions: [
          {
            header: '实现方式',
            question: '请选择实现方式',
            options: [
              {
                label: '直接修改',
                description: '立即更新现有实现'
              },
              {
                label: '先写测试',
                description: '先增加回归测试'
              }
            ],
            multiple: false,
            custom: true
          }
        ]
      })
    })

    expect(
      await screen.findByText('OpenCode 需要补充信息')
    ).toBeInTheDocument()
    fireEvent.click(screen.getByLabelText(/先写测试/u))
    fireEvent.click(screen.getByRole('button', { name: '提交回答' }))
    await waitFor(() =>
      expect(api.agent.respondQuestion).toHaveBeenCalledWith(
        'question-1',
        [['先写测试']]
      )
    )
    expect(
      screen.queryByText('OpenCode 需要补充信息')
    ).not.toBeInTheDocument()
  })

  it('configures a runtime without reading an existing API key', async () => {
    render(<App />)

    fireEvent.click(await screen.findByText('本地工作区'))
    expect(
      await screen.findByRole('heading', {
        name: '设置中心'
      })
    ).toBeInTheDocument()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(screen.getByRole('region', { name: '设置中心' }))
      .toBeInTheDocument()
    expect(
      screen.getByRole('tab', { name: 'Agent Runtime' })
    ).toBeInTheDocument()
    expect(
      screen.getByRole('tab', { name: '安全与数据' })
    ).toBeInTheDocument()
    fireEvent.click(screen.getByRole('tab', { name: '模型连接' }))

    const apiKeyInput = screen.getByLabelText('API Key')
    expect(apiKeyInput).toHaveValue('')
    fireEvent.change(apiKeyInput, {
      target: { value: 'test-api-key' }
    })
    fireEvent.click(screen.getByRole('button', { name: '保存设置' }))

    await waitFor(() =>
      expect(api.settings.updateRuntime).toHaveBeenCalledWith(
        expect.objectContaining({
          apiKey: {
            action: 'replace',
            value: 'test-api-key'
          }
        })
      )
    )
    await waitFor(() => expect(apiKeyInput).toHaveValue(''))
  })

  it('opens the global assistant sidebar and switches work tabs', async () => {
    const { container } = render(<App />)

    const sidebar = screen.getByLabelText('助手工作栏')
    expect(sidebar).not.toHaveClass('assistant-sidebar--open')
    const assistantTrigger =
      screen.getByLabelText('切换助手工作栏')
    expect(assistantTrigger.parentElement).toBe(
      container.querySelector('.app-content')
    )
    expect(container.querySelector('.sidebar')?.parentElement).toBe(
      container.querySelector('.app-shell')
    )
    expect(container.querySelector('.app-frame')?.parentElement).toBe(
      container.querySelector('.app-shell')
    )
    expect(container.querySelector('.topbar')?.parentElement).toBe(
      container.querySelector('.app-frame')
    )
    expect(assistantTrigger).toHaveClass('assistant-sidebar-toggle')
    expect(assistantTrigger).not.toHaveClass('icon-button--active')
    expect(assistantTrigger).toHaveAttribute('aria-expanded', 'false')
    expect(assistantTrigger).toHaveAttribute(
      'aria-controls',
      'assistant-sidebar'
    )
    expect(
      assistantTrigger.querySelector('.lucide-panel-right-open')
    ).toBeInTheDocument()
    expect(
      assistantTrigger.querySelector('.lucide-panel-right-close')
    ).not.toBeInTheDocument()
    expect(
      container.querySelector('.topbar')
    ).toContainElement(screen.getByLabelText('关闭窗口'))
    expect(container.querySelector('.topbar')).toContainElement(
      container.querySelector('.conversation-title')
    )
    expect(
      container.querySelector('.topbar')
    ).not.toContainElement(assistantTrigger)
    expect(
      screen.queryByLabelText('关闭助手工作栏')
    ).not.toBeInTheDocument()
    fireEvent.click(assistantTrigger)
    expect(sidebar).toHaveClass('assistant-sidebar--open')
    expect(sidebar).toHaveAttribute('id', 'assistant-sidebar')
    expect(sidebar).toHaveAttribute('role', 'complementary')
    expect(sidebar).not.toHaveAttribute('aria-modal')
    expect(assistantTrigger).toHaveAttribute('aria-expanded', 'true')
    expect(assistantTrigger).not.toHaveClass('icon-button--active')
    expect(
      assistantTrigger.querySelector('.lucide-panel-right-close')
    ).toBeInTheDocument()
    expect(
      assistantTrigger.querySelector('.lucide-panel-right-open')
    ).not.toBeInTheDocument()
    const main = document.querySelector('main')
    expect(main).not.toHaveAttribute('inert')
    expect(
      container.querySelector('.assistant-sidebar-backdrop')
    ).not.toBeInTheDocument()

    expect(
      screen.getByRole('tab', { name: '任务中心' })
    ).toHaveAttribute('aria-selected', 'true')
    const taskIndexHeading = screen.getByRole('heading', {
      name: '任务索引'
    })
    const newTaskButton = screen.getByRole('button', {
      name: '新建任务'
    })
    expect(taskIndexHeading.parentElement).toContainElement(
      newTaskButton
    )
    expect(
      screen.queryByRole('region', { name: '当前会话的任务' })
    ).not.toBeInTheDocument()
    expect(screen.queryByText('最近任务')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('tab', { name: '上下文' }))
    expect(
      screen.getByText('尚未添加文件、截图或剪贴板内容。')
    ).toBeInTheDocument()
    fireEvent.click(screen.getByRole('tab', { name: '工作区' }))
    expect(
      screen.getByText(/选择文件后在当前工作区内预览/)
    ).toBeInTheDocument()
    fireEvent.click(screen.getByRole('tab', { name: '浏览器' }))
    expect(
      screen.getByText(/Agent 打开网页后/)
    ).toBeInTheDocument()
    fireEvent.click(screen.getByRole('tab', { name: '成果' }))
    expect(screen.getByText('生成与导入成果')).toBeInTheDocument()
    expect(
      screen.getByText(/查看并预览由任务、自动化生成或手动导入/)
    ).toBeInTheDocument()
    expect(
      screen.queryByRole('tab', { name: '预览' })
    ).not.toBeInTheDocument()
    fireEvent.click(assistantTrigger)
    expect(sidebar).not.toHaveClass('assistant-sidebar--open')
    expect(assistantTrigger).toHaveAttribute('aria-expanded', 'false')
    expect(
      assistantTrigger.querySelector('.lucide-panel-right-open')
    ).toBeInTheDocument()
    expect(main).not.toHaveAttribute('inert')
    await waitFor(() => expect(assistantTrigger).toHaveFocus())
  })

  it('keeps completed chat replies out of the results sidebar', async () => {
    render(<App />)

    fireEvent.change(screen.getByLabelText('向 GoodBuddy 提问'), {
      target: { value: '普通聊天问题' }
    })
    fireEvent.click(await screen.findByLabelText('发送'))
    await waitFor(() => expect(run).toHaveBeenCalledOnce())
    const request = run.mock.calls[0]?.[0]
    if (!request) {
      throw new Error('Missing request')
    }
    act(() => {
      agentListener?.({
        requestId: request.requestId,
        type: 'text',
        delta: '这是一条普通聊天回复'
      })
      agentListener?.({
        requestId: request.requestId,
        type: 'done'
      })
    })
    expect(
      await screen.findByText('这是一条普通聊天回复')
    ).toBeInTheDocument()

    fireEvent.click(screen.getByLabelText('切换助手工作栏'))
    fireEvent.click(screen.getByRole('tab', { name: '成果' }))
    const sidebar = screen.getByLabelText('助手工作栏')
    expect(
      within(sidebar).queryByText('这是一条普通聊天回复')
    ).not.toBeInTheDocument()
    expect(
      within(sidebar).getByText(
        '生成的文件、图片、报告和手动导入内容会显示在这里。'
      )
    ).toBeInTheDocument()
  })

  it('opens the live browser tab for the active conversation and can stop it', async () => {
    render(<App />)

    fireEvent.change(screen.getByLabelText('向 GoodBuddy 提问'), {
      target: { value: '打开示例网页' }
    })
    fireEvent.click(await screen.findByLabelText('发送'))
    await waitFor(() => expect(run).toHaveBeenCalledOnce())
    const conversationId = run.mock.calls[0]?.[0].conversationId
    expect(conversationId).toBeTruthy()

    act(() => {
      browserListener?.({
        conversationId: conversationId ?? '',
        status: 'ready',
        url: 'https://example.com/',
        frameDataUrl: 'data:image/jpeg;base64,/9j/2Q==',
        updatedAt: Date.now()
      })
    })

    expect(screen.getByLabelText('助手工作栏')).toHaveClass(
      'assistant-sidebar--open'
    )
    expect(
      screen.getByRole('tab', { name: '浏览器' })
    ).toHaveAttribute('aria-selected', 'true')
    expect(
      screen.getByAltText('Agent 实时浏览器画面')
    ).toHaveAttribute(
      'src',
      'data:image/jpeg;base64,/9j/2Q=='
    )
    fireEvent.click(
      screen.getByRole('button', { name: '交互' })
    )
    await waitFor(() =>
      expect(api.browser.interact).toHaveBeenCalledWith(conversationId)
    )
    fireEvent.click(
      screen.getByRole('button', { name: '停止浏览器' })
    )
    await waitFor(() =>
      expect(api.browser.stop).toHaveBeenCalledWith(conversationId)
    )
  })

  it('opens Smart Heartbeat as a first-class workspace', async () => {
    render(<App />)

    fireEvent.click(
      screen.getByRole('button', { name: '智能心跳' })
    )

    expect(
      await screen.findByRole('heading', { name: '智能心跳' })
    ).toBeInTheDocument()
    expect(
      await screen.findByRole('tab', { name: '成长概览' })
    ).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: '配置智能心跳' })
    ).toBeInTheDocument()
    expect(
      screen.queryByLabelText('切换助手工作栏')
    ).not.toBeInTheDocument()
  })

  it('excludes ignored heartbeat suggestions from the navigation badge', async () => {
    const heartbeatId = '00000000-0000-4000-8000-000000000701'
    const cancelledTaskId = '00000000-0000-4000-8000-000000000801'
    const pendingTaskId = '00000000-0000-4000-8000-000000000802'
    vi.mocked(api.heartbeats.list).mockResolvedValue([
      {
        id: heartbeatId,
        scope: { kind: 'projects', projectIds: [projectId] },
        name: '每日回顾',
        timezone: 'Asia/Shanghai',
        recurrence: { type: 'daily', localTime: '09:00' },
        enabled: true,
        lookbackHours: 24,
        retentionDays: 30,
        nextRunAt: '2026-08-05T01:00:00.000Z',
        createdAt: '2026-08-01T00:00:00.000Z',
        updatedAt: '2026-08-01T00:00:00.000Z'
      }
    ])
    vi.mocked(api.heartbeats.history).mockResolvedValue({
      runs: [],
      entries: [
        {
          id: '00000000-0000-4000-8000-000000000901',
          configId: heartbeatId,
          runId: '00000000-0000-4000-8000-000000000902',
          scheduledFor: '2026-08-04T01:00:00.000Z',
          summary: '建议处理两个后续行动。',
          highlights: [],
          proposedMemoryIds: [],
          followUpTaskIds: [cancelledTaskId, pendingTaskId],
          createdAt: '2026-08-04T01:00:00.000Z'
        }
      ]
    })
    vi.mocked(api.tasks.list).mockResolvedValue([
      {
        id: cancelledTaskId,
        projectId,
        title: '已忽略建议',
        instructions: '无需继续处理。',
        origin: 'assistant',
        status: 'cancelled',
        createdAt: '2026-08-04T01:00:00.000Z'
      },
      {
        id: pendingTaskId,
        projectId,
        title: '待处理建议',
        instructions: '继续处理此建议。',
        origin: 'assistant',
        status: 'paused',
        createdAt: '2026-08-04T01:00:00.000Z'
      }
    ])

    try {
      render(<App />)

      expect(
        await screen.findByLabelText('1 条待处理建议')
      ).toBeInTheDocument()
      expect(
        screen.queryByLabelText('2 条待处理建议')
      ).not.toBeInTheDocument()
    } finally {
      cleanup()
      vi.mocked(api.heartbeats.list).mockResolvedValue([])
      vi.mocked(api.heartbeats.history).mockResolvedValue({
        runs: [],
        entries: []
      })
      vi.mocked(api.tasks.list).mockResolvedValue([])
    }
  })

  it('shows retryable page-local knowledge errors without an empty-state flash', async () => {
    vi.mocked(api.knowledge.getSnapshot).mockRejectedValueOnce(
      new Error('知识数据库暂时不可用')
    )
    render(<App />)

    fireEvent.click(screen.getByRole('button', { name: '知识库' }))
    expect(
      await screen.findByText('知识库加载失败')
    ).toBeInTheDocument()
    expect(screen.getAllByText('知识数据库暂时不可用')).toHaveLength(1)
    expect(screen.queryByText('建立第一个知识库')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '重试' }))
    expect(
      await screen.findByText('建立第一个知识库')
    ).toBeInTheDocument()
  })

  it('retries the knowledge library whose selection failed', async () => {
    const firstLibraryId = '11111111-1111-4111-8111-111111111111'
    const secondLibraryId = '22222222-2222-4222-8222-222222222222'
    const libraries = [
      {
        id: firstLibraryId,
        name: '产品知识',
        description: '',
        storageMode: 'managed' as const,
        graphEnabled: false,
        graphStrategy: 'rules' as const,
        sourceCount: 0,
        documentCount: 0,
        indexedDocumentCount: 0
      },
      {
        id: secondLibraryId,
        name: '工程知识',
        description: '',
        storageMode: 'managed' as const,
        graphEnabled: false,
        graphStrategy: 'rules' as const,
        sourceCount: 0,
        documentCount: 0,
        indexedDocumentCount: 0
      }
    ]
    const snapshot = {
      libraries,
      sources: [],
      documents: [],
      graphNodes: [],
      graphRelations: [],
      evidence: []
    }
    vi.mocked(api.knowledge.getSnapshot)
      .mockResolvedValueOnce({
        ...snapshot,
        selectedLibraryId: firstLibraryId
      })
      .mockRejectedValueOnce(new Error('工程知识暂时不可用'))
      .mockResolvedValueOnce({
        ...snapshot,
        selectedLibraryId: secondLibraryId
      })
    render(<App />)

    fireEvent.click(screen.getByRole('button', { name: '知识库' }))
    fireEvent.click(
      await screen.findByRole('button', {
        name: /^工程知识 0 个文档/u
      })
    )
    expect(
      await screen.findByText('知识库刷新失败')
    ).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '重试' }))
    await waitFor(() =>
      expect(api.knowledge.getSnapshot).toHaveBeenLastCalledWith(
        secondLibraryId
      )
    )
    expect(
      screen.getByRole('button', {
        name: /^工程知识 0 个文档/u
      })
    ).toHaveAttribute('aria-current', 'page')
  })

  it('shows retryable page-local heartbeat errors without first-time guidance', async () => {
    vi.mocked(api.heartbeats.list).mockRejectedValue(
      new Error('心跳数据库暂时不可用')
    )
    render(<App />)

    fireEvent.click(
      screen.getByRole('button', { name: '智能心跳' })
    )
    expect(
      await screen.findByText('智能心跳加载失败')
    ).toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: '配置智能心跳' })
    ).not.toBeInTheDocument()

    const retry = await screen.findByRole('button', { name: '重试' })
    vi.mocked(api.heartbeats.list).mockResolvedValue([])
    fireEvent.click(retry)
    expect(
      await screen.findByRole('button', { name: '配置智能心跳' })
    ).toBeInTheDocument()
  })

  it('keeps heartbeat plans independent of the active project', async () => {
    const secondProject = {
      ...project,
      id: '00000000-0000-4000-8000-000000000102',
      name: '第二项目',
      rootPath: 'C:\\Second'
    }
    vi.mocked(api.projects.list).mockResolvedValueOnce([
      project,
      secondProject
    ])
    vi.mocked(api.heartbeats.list).mockResolvedValue([
      {
        id: '00000000-0000-4000-8000-000000000701',
        scope: { kind: 'projects', projectIds: [projectId] },
        name: '旧项目心跳',
        timezone: 'Asia/Shanghai',
        recurrence: { type: 'daily', localTime: '09:00' },
        enabled: true,
        lookbackHours: 24,
        retentionDays: 30,
        nextRunAt: '2026-08-05T01:00:00.000Z',
        createdAt: '2026-08-01T00:00:00.000Z',
        updatedAt: '2026-08-01T00:00:00.000Z'
      }
    ])
    render(<App />)

    fireEvent.click(
      screen.getByRole('button', { name: '智能心跳' })
    )
    fireEvent.click(
      await screen.findByRole('tab', { name: '心跳计划' })
    )
    expect(await screen.findAllByText('旧项目心跳')).not.toHaveLength(0)
    selectProjectOption(secondProject.name)
    fireEvent.click(
      screen.getByRole('button', { name: '智能心跳' })
    )

    expect(await screen.findAllByText('旧项目心跳')).not.toHaveLength(0)
  })

  it('automatically snapshots the conversation project on new activity', async () => {
    render(<App />)
    await screen.findByText('项目：默认项目')

    fireEvent.change(screen.getByLabelText('向 GoodBuddy 提问'), {
      target: { value: '记录项目范围' }
    })
    fireEvent.click(screen.getByLabelText('发送'))
    await waitFor(() =>
      expect(
        loadActivityRecords().find(
          (record) =>
            record.kind === 'request' &&
            record.title === '记录项目范围'
        )?.scope
      ).toEqual({
        kind: 'project',
        projectId,
        projectName: project.name
      })
    )
  })

  it('marks the current primary navigation page and hides decorative icons', async () => {
    render(<App />)

    const navigation = screen.getByRole('navigation', {
      name: '主导航'
    })
    const chat = within(navigation).getByRole('button', { name: '对话' })
    const knowledge = within(navigation).getByRole('button', {
      name: '知识库'
    })

    expect(chat).toHaveAttribute('aria-current', 'page')
    expect(knowledge).not.toHaveAttribute('aria-current')
    for (const button of within(navigation).getAllByRole('button')) {
      expect(button.querySelector('svg')).toHaveAttribute(
        'aria-hidden',
        'true'
      )
    }

    fireEvent.click(knowledge)
    expect(knowledge).toHaveAttribute('aria-current', 'page')
    expect(chat).not.toHaveAttribute('aria-current')
  })

  it('collapses the primary sidebar into an inert narrow-window overlay', async () => {
    const originalWidth = window.innerWidth
    const { container } = render(<App />)
    const sidebar = container.querySelector<HTMLElement>('.sidebar')
    const workspace = container.querySelector<HTMLElement>('.workspace')
    expect(sidebar).not.toBeNull()
    expect(workspace).not.toBeNull()
    if (!sidebar || !workspace) {
      return
    }

    try {
      Object.defineProperty(window, 'innerWidth', {
        configurable: true,
        value: 680
      })
      window.dispatchEvent(new Event('resize'))

      await waitFor(() =>
        expect(sidebar).toHaveClass('sidebar--closed')
      )
      expect(sidebar).toHaveAttribute('aria-hidden', 'true')
      expect(sidebar).toHaveAttribute('inert')

      const toggle = screen.getByRole('button', { name: '切换侧栏' })
      fireEvent.click(toggle)
      expect(sidebar).not.toHaveClass('sidebar--closed')
      expect(sidebar).toHaveAttribute('aria-hidden', 'false')
      expect(sidebar).toHaveAttribute('aria-modal', 'true')
      expect(sidebar).not.toHaveAttribute('inert')
      expect(workspace).toHaveAttribute('aria-hidden', 'true')
      expect(workspace).toHaveAttribute('inert')
      await waitFor(() =>
        expect(
          within(sidebar).getByRole('button', { name: '对话' })
        ).toHaveFocus()
      )

      fireEvent.click(
        within(sidebar).getByRole('button', { name: '知识库' })
      )
      await waitFor(() => expect(toggle).toHaveFocus())
      expect(sidebar).toHaveClass('sidebar--closed')
      expect(workspace).not.toHaveAttribute('aria-hidden')
      expect(workspace).not.toHaveAttribute('inert')
    } finally {
      Object.defineProperty(window, 'innerWidth', {
        configurable: true,
        value: originalWidth
      })
    }
  })

  it('docks the assistant workbar without obscuring a narrow workspace', async () => {
    const originalWidth = window.innerWidth
    const { container } = render(<App />)

    try {
      Object.defineProperty(window, 'innerWidth', {
        configurable: true,
        value: 680
      })
      window.dispatchEvent(new Event('resize'))

      await waitFor(() =>
        expect(container.querySelector('.sidebar'))
          .toHaveClass('sidebar--closed')
      )
      fireEvent.click(screen.getByLabelText('切换助手工作栏'))

      const workbar = screen.getByRole('complementary', {
        name: '助手工作栏'
      })
      expect(workbar).toHaveClass('assistant-sidebar--open')
      expect(workbar.parentElement).toHaveClass('app-content')
      expect(
        workbar.parentElement?.querySelector('main.workspace')
      ).toBeInTheDocument()
      expect(workbar).not.toHaveAttribute('aria-modal')
      expect(container.querySelector('main')).not.toHaveAttribute(
        'inert'
      )
      expect(
        container.querySelector('.assistant-sidebar-backdrop')
      ).not.toBeInTheDocument()
    } finally {
      Object.defineProperty(window, 'innerWidth', {
        configurable: true,
        value: originalWidth
      })
    }
  })

  it('opens Magic Notes as a global first-class workspace', async () => {
    api.updates = {
      getSettings: vi.fn(async () => ({
        checkUpdatesOnStartup: false,
        updateSource: 'github' as const,
        modelDownloadSource: 'modelscope' as const,
        magicNotesEnabled: true,
        magicNotesShowIncompleteTodoCount: true,
        magicNoteCommentMode: 'immediate' as const,
        magicNoteCommentFormat: 'combined' as const
      })),
      updateSettings: vi.fn(async () => ({
        checkUpdatesOnStartup: false,
        updateSource: 'github' as const,
        modelDownloadSource: 'modelscope' as const,
        magicNotesEnabled: true,
        magicNotesShowIncompleteTodoCount: true,
        magicNoteCommentMode: 'immediate' as const,
        magicNoteCommentFormat: 'combined' as const
      })),
      check: vi.fn(),
      openReleasePage: vi.fn(async () => {}),
      onResult: vi.fn(() => () => {})
    }
    try {
      render(<App />)
      await screen.findByText('项目：默认项目')
      const magicNotesEntry = await screen.findByRole('button', {
        name: '魔法笔记'
      })

      fireEvent.click(magicNotesEntry)

      expect(
        await screen.findByRole('heading', { name: '魔法笔记' })
      ).toBeInTheDocument()
      expect(screen.getByText('全局')).toBeInTheDocument()
      expect(
        screen.getByRole('button', { name: '新建笔记' })
      ).toBeInTheDocument()
      await waitFor(() =>
        expect(api.magicNotes.list).toHaveBeenCalled()
      )
      expect(
        screen.queryByLabelText('切换助手工作栏')
      ).not.toBeInTheDocument()
    } finally {
      delete api.updates
    }
  })

  it('shows and refreshes the incomplete Magic Notes todo count', async () => {
    vi.mocked(api.magicNotes.getTodoStatus).mockResolvedValueOnce({
      incompleteCount: 4
    })
    api.updates = {
      getSettings: vi.fn(async () => ({
        checkUpdatesOnStartup: false,
        updateSource: 'github' as const,
        modelDownloadSource: 'modelscope' as const,
        magicNotesEnabled: true,
        magicNotesShowIncompleteTodoCount: true,
        magicNoteCommentMode: 'immediate' as const,
        magicNoteCommentFormat: 'combined' as const
      })),
      updateSettings: vi.fn(),
      check: vi.fn(),
      openReleasePage: vi.fn(async () => {}),
      onResult: vi.fn(() => () => {})
    }
    try {
      render(<App />)

      expect(
        await screen.findByLabelText('4 个未完成待办')
      ).toHaveTextContent('4')

      vi.mocked(api.magicNotes.getTodoStatus).mockResolvedValueOnce({
        incompleteCount: 0
      })
      await act(async () => {
        magicTodoStatusChangedListener?.()
      })
      await waitFor(() =>
        expect(
          screen.queryByLabelText('4 个未完成待办')
        ).not.toBeInTheDocument()
      )

      vi.mocked(api.magicNotes.getTodoStatus).mockResolvedValueOnce({
        incompleteCount: 125
      })
      await act(async () => {
        magicTodoStatusChangedListener?.()
      })
      expect(
        await screen.findByLabelText('125 个未完成待办')
      ).toHaveTextContent('99+')
    } finally {
      delete api.updates
    }
  })

  it('hides the todo count when its Magic Notes setting is off', async () => {
    vi.mocked(api.magicNotes.getTodoStatus).mockResolvedValue({
      incompleteCount: 4
    })
    api.updates = {
      getSettings: vi.fn(async () => ({
        checkUpdatesOnStartup: false,
        updateSource: 'github' as const,
        modelDownloadSource: 'modelscope' as const,
        magicNotesEnabled: true,
        magicNotesShowIncompleteTodoCount: false,
        magicNoteCommentMode: 'immediate' as const,
        magicNoteCommentFormat: 'combined' as const
      })),
      updateSettings: vi.fn(),
      check: vi.fn(),
      openReleasePage: vi.fn(async () => {}),
      onResult: vi.fn(() => () => {})
    }
    try {
      render(<App />)

      expect(
        await screen.findByRole('button', { name: '魔法笔记' })
      ).toBeInTheDocument()
      expect(
        screen.queryByLabelText('4 个未完成待办')
      ).not.toBeInTheDocument()
      expect(api.magicNotes.getTodoStatus).not.toHaveBeenCalled()
    } finally {
      delete api.updates
    }
  })
  it('hides Magic Notes when the platform feature is disabled', async () => {
    api.updates = {
      getSettings: vi.fn(async () => ({
        checkUpdatesOnStartup: false,
        updateSource: 'github' as const,
        modelDownloadSource: 'modelscope' as const,
        magicNotesEnabled: false,
        magicNotesShowIncompleteTodoCount: true,
        magicNoteCommentMode: 'immediate' as const,
        magicNoteCommentFormat: 'combined' as const
      })),
      updateSettings: vi.fn(async () => ({
        checkUpdatesOnStartup: false,
        updateSource: 'github' as const,
        modelDownloadSource: 'modelscope' as const,
        magicNotesEnabled: false,
        magicNotesShowIncompleteTodoCount: true,
        magicNoteCommentMode: 'immediate' as const,
        magicNoteCommentFormat: 'combined' as const
      })),
      check: vi.fn(),
      openReleasePage: vi.fn(async () => {}),
      onResult: vi.fn(() => () => {})
    }
    try {
      render(<App />)
      await waitFor(() =>
        expect(
          screen.queryByRole('button', { name: '魔法笔记' })
        ).not.toBeInTheDocument()
      )
    } finally {
      delete api.updates
    }
  })

  it('hides Magic Notes by default without an explicit setting', () => {
    render(<App />)

    expect(
      screen.queryByRole('button', { name: '魔法笔记' })
    ).not.toBeInTheDocument()
  })

  it('keeps platform-feature switches in Settings without navigating', async () => {
    let applicationSettings: ApplicationSettings = {
      checkUpdatesOnStartup: false,
      updateSource: 'github',
      modelDownloadSource: 'modelscope',
      magicNotesEnabled: false,
      magicNotesShowIncompleteTodoCount: true,
      magicNoteCommentMode: 'immediate',
      magicNoteCommentFormat: 'combined'
    }
    api.updates = {
      getSettings: vi.fn(async () => ({ ...applicationSettings })),
      updateSettings: vi.fn(async (input) => {
        applicationSettings = {
          ...applicationSettings,
          ...input
        }
        return { ...applicationSettings }
      }),
      check: vi.fn(),
      openReleasePage: vi.fn(async () => {}),
      onResult: vi.fn(() => () => {})
    }
    try {
      const { container } = render(<App />)
      fireEvent.click(await screen.findByText('本地工作区'))
      fireEvent.click(
        screen.getByRole('tab', { name: '平台功能' })
      )
      fireEvent.click(
        await screen.findByRole('tab', { name: '魔法笔记' })
      )
      const toggle = await screen.findByRole('switch', {
        name: '显示魔法笔记入口'
      })

      fireEvent.click(toggle)
      await waitFor(() => expect(toggle).toBeChecked())
      expect(
        screen.getByRole('heading', { name: '设置中心' })
      ).toBeInTheDocument()
      expect(
        screen.getByRole('button', { name: '魔法笔记' })
      ).toBeInTheDocument()
      expect(
        container.querySelector('.magic-notes-page')
      ).not.toBeInTheDocument()

      fireEvent.click(toggle)
      await waitFor(() => expect(toggle).not.toBeChecked())
      expect(
        screen.getByRole('heading', { name: '设置中心' })
      ).toBeInTheDocument()
      expect(
        screen.queryByRole('button', { name: '魔法笔记' })
      ).not.toBeInTheDocument()
    } finally {
      delete api.updates
    }
  })

  it('gives the knowledge workspace the full content width', async () => {
    render(<App />)

    fireEvent.click(screen.getByRole('button', { name: '知识库' }))

    expect(
      await screen.findByLabelText('知识工作区')
    ).toBeInTheDocument()
    expect(
      screen.queryByLabelText('切换助手工作栏')
    ).not.toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: /^专家角色：/u })
    ).not.toBeInTheDocument()
  })

  it('keeps Smart Heartbeat available when the runtime is not configured', async () => {
    vi.mocked(api.agent.getStatus).mockResolvedValue({
      id: 'setup',
      label: '需要配置模型',
      available: false,
      supportsToolExecution: false,
      detail: '请配置模型'
    })
    render(<App />)

    expect(
      await screen.findByRole('heading', { name: '设置中心' })
    ).toBeInTheDocument()
    await waitFor(() =>
      expect(api.agent.getStatus).toHaveBeenCalledOnce()
    )
    fireEvent.click(
      screen.getByRole('button', { name: '智能心跳' })
    )

    expect(
      await screen.findByRole('heading', { name: '智能心跳' })
    ).toBeInTheDocument()
    expect(api.agent.getStatus).toHaveBeenCalledOnce()
  })
})

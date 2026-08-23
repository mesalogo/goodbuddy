import {
  app,
  BrowserWindow,
  dialog,
  globalShortcut,
  Menu,
  safeStorage,
  session,
  shell,
  Tray,
  utilityProcess
} from 'electron'
import { homedir } from 'node:os'
import { mkdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import spawn from 'cross-spawn'
import { ipcChannels } from '../shared/ipc-channels'
import {
  createAgentRuntime,
  createDefaultModelRuntime,
  createModelProfileRuntime
} from './agent/create-runtime'
import { AgentRuntimeController } from './agent/runtime-controller'
import type { AgentRuntime } from './agent/runtime'
import { SelectedRuntimeManager } from './agent/selected-runtime-manager'
import { KnowledgeMcpGateway } from './agent/knowledge-mcp-gateway'
import {
  applyRuntimeSelection,
  getConfiguredRuntimeTarget,
  type SelectedRuntimeTarget
} from './agent/runtime-selection'
import { CapabilityService } from './capabilities/capability-service'
import { ContextManager } from './context-manager'
import { registerIpcHandlers } from './ipc'
import { KnowledgeService } from './knowledge/knowledge-service'
import { AssistantDatabase } from './assistant/assistant-database'
import { createModelGraphExtractor } from './knowledge/model-extractor'
import { OpenAIEmbeddingClient } from './knowledge/openai-embedding-client'
import { embeddingProviderFingerprint } from './knowledge/embedding-provider-key'
import type { EmbeddingProvider } from './knowledge/types'
import { EmbeddingModelManager } from './knowledge/embedding-model-manager'
import {
  EmbeddingInferenceBroker,
  type EmbeddingInferenceTransport
} from './knowledge/embedding-inference-broker'
import { CohereRerankClient } from './knowledge/cohere-rerank-client'
import { RuntimeSettingsStore } from './runtime-settings-store'
import type { ResolvedRuntimeSettings } from './runtime-settings-store'
import { ToolApprovalBroker } from './tool-approval-broker'
import {
  createMainWindow,
  loadMainWindow,
  showWindow,
  toggleWindow
} from './window'
import { createTrayIcon } from './tray-icon'
import { resolveBundledRuntimePaths } from './agent/bundled-runtimes'
import type { ContinueHostLauncher } from './agent/continue-host-adapter'
import { resolvePortableUserDataPath } from './portable-user-data'
import { BrowserService } from './browser/browser-service'
import { SubagentService } from './assistant/subagent-service'
import { ChannelSettingsStore } from './channels/channel-settings-store'
import type {
  WechatSidecarChild,
  WechatSidecarLauncher
} from './channels/wechat-sidecar-client'
import { buildWechatSidecarEnvironment } from './channels/wechat-sidecar-environment'
import { ApplicationSettingsStore } from './application-settings-store'
import { VersionChecker } from './version-checker'
import { SpeechModelManager } from './speech/speech-model-manager'
import { SpeechTranscriptionService } from './speech/speech-transcription-service'
import { GlobalTlsPolicy } from './global-tls-policy'
import type { AgentRuntimeSelection } from '../shared/runtime-selection-contracts'
import {
  runCleanupBeforeDeadline,
  settleCleanupPhases
} from './shutdown'
import { DocumentParsingSettingsStore } from './document-parsing-settings-store'
import { DocumentOcrModelManager } from './document-ocr-model-manager'
import { DocumentOcrBroker } from './document-ocr-broker'
import { DocumentParsingService } from './document-parsing-service'
import { ReleaseNotesService } from './release-notes-service'
import { GoodBuddyConfigService } from './goodbuddy-config-service'
import {
  createDeepSeekHarnessUtilityLauncher,
  type DeepSeekHarnessFork
} from './agent/deepseek-harness-utility-launcher'
import { buildControlledHarnessEnvironment } from './agent/process-environment'
import {
  createStartupFailureDiagnostic,
  formatStartupFailureMessage,
  runStartupPrerequisites
} from './startup-prerequisites'
import { RuntimeExtensionStore } from './agent/runtime-extension-store'
import {
  DshNpmExtensionInstaller,
  DshNpmMarketplaceCatalog
} from './agent/dsh-extension-marketplace'
import { registerDesktopNotificationActivation } from './desktop-notification'
import {
  isInstalledWindowsBuild,
  repairStaleWindowsNotificationShortcuts,
  resolveWindowsAppUserModelId
} from './windows-notification-identity'
import { ShortcutSettingsStore } from './shortcut-settings-store'
import { ShortcutSettingsService } from './shortcut-settings-service'
import { defaultGlobalShortcutSettings } from '../shared/shortcut'
import { requestProcessTreeTermination } from './agent/child-process-termination'
import { createContinueUtilityProcessChild } from './agent/continue-utility-process-adapter'
import type { RuntimeSettings, RuntimeSettingsInput } from '../shared/contracts'

const legacyDefaultShortcut =
  defaultGlobalShortcutSettings.accelerator
const mainModuleDirectory = dirname(fileURLToPath(import.meta.url))
const portableUserDataPath = resolvePortableUserDataPath({
  packaged: app.isPackaged,
  platform: process.platform,
  executablePath: process.execPath
})
if (portableUserDataPath) {
  app.setPath('userData', portableUserDataPath)
}
const installedWindowsBuild = isInstalledWindowsBuild({
  packaged: app.isPackaged,
  platform: process.platform,
  executablePath: process.execPath
})
if (process.platform === 'win32') {
  app.setAppUserModelId(
    resolveWindowsAppUserModelId({
      installed: installedWindowsBuild,
      executablePath: process.execPath
    })
  )
}
const hasSingleInstanceLock = app.requestSingleInstanceLock()

if (!hasSingleInstanceLock) {
  app.quit()
}

let mainWindow: BrowserWindow | undefined
let tray: Tray | undefined
let isQuitting = false
let removeIpcHandlers: (() => Promise<void>) | undefined
let runtime: AgentRuntimeController | undefined
let selectedRuntimeManager: SelectedRuntimeManager | undefined
let knowledgeService: KnowledgeService | undefined
let knowledgeGateway: KnowledgeMcpGateway | undefined
let assistantDatabase: AssistantDatabase | undefined
let browserService: BrowserService | undefined
let globalTlsPolicy: GlobalTlsPolicy | undefined
let documentOcrBroker: DocumentOcrBroker | undefined
let documentOcrModelManager: DocumentOcrModelManager | undefined
let embeddingModelManager: EmbeddingModelManager | undefined
const embeddingBrokers = new Set<EmbeddingInferenceBroker>()
let stopRuntimeReconfiguration: (() => Promise<void>) | undefined
let dshExtensionInstaller: DshNpmExtensionInstaller | undefined

type ManagedEmbeddingProvider = EmbeddingProvider & {
  dispose?: () => void | Promise<void>
}

function createEmbeddingUtilityTransport(
  modulePath: string,
  modelDirectory: string
): EmbeddingInferenceTransport {
  const child = utilityProcess.fork(
    modulePath,
    [modelDirectory],
    {
      serviceName: 'GoodBuddy Embedding Inference',
      stdio: 'pipe',
      allowLoadingUnsignedLibraries: false
    }
  )
  return {
    postMessage: (message) => child.postMessage(message),
    onMessage: (listener) => {
      child.on('message', listener)
      return () => child.removeListener('message', listener)
    },
    onClose: (listener) => {
      let closed = false
      const notify = (): void => {
        if (closed) {
          return
        }
        closed = true
        listener()
      }
      child.on('exit', notify)
      child.on('error', notify)
      return () => {
        child.removeListener('exit', notify)
        child.removeListener('error', notify)
      }
    },
    close: () => {
      child.kill()
    }
  }
}

async function createEmbeddingProvider(
  settings: ResolvedRuntimeSettings,
  manager: EmbeddingModelManager,
  connectionId = settings.activeEmbeddingConnectionId
): Promise<ManagedEmbeddingProvider | undefined> {
  if (!settings.knowledgeEmbeddingEnabled) {
    return undefined
  }
  const connection = settings.embeddingConnections?.find(
    (candidate) => candidate.id === connectionId
  )
  if (!connection) {
    throw new Error('当前向量连接不存在')
  }
  if (connection.kind !== 'builtin') {
    return new OpenAIEmbeddingClient({
      endpoint: connection.baseUrl,
      model: connection.modelName,
      apiKey: connection.apiKey
    })
  }
  const snapshot = await manager.getSnapshot()
  const model =
    snapshot.catalog.find((candidate) => candidate.recommended) ??
    snapshot.catalog[0]
  if (!model) {
    throw new Error('内置向量模型目录为空')
  }
  const modelDirectory =
    await manager.getVerifiedModelDirectory(model.id)
  const installed = snapshot.installed.find(
    (candidate) => candidate.id === model.id
  )
  if (!installed) {
    throw new Error('内置向量模型尚未安装')
  }
  const tokenizerDigest = installed.files.find(
    (file) => file.role === 'tokenizer'
  )?.sha256
  const modelDigest = installed.files.find(
    (file) => file.role === 'model'
  )?.sha256
  if (!tokenizerDigest || !modelDigest) {
    throw new Error('内置向量模型安装清单不完整')
  }
  const broker = new EmbeddingInferenceBroker({
    createTransport: () =>
      createEmbeddingUtilityTransport(
        join(mainModuleDirectory, 'embedding-inference-bootstrap.js'),
        modelDirectory
      )
  })
  embeddingBrokers.add(broker)
  return {
    provider: 'builtin',
    model: model.id,
    fingerprint: embeddingProviderFingerprint({
      provider: 'builtin',
      dataPath: { kind: 'device' },
      model: model.id,
      dimensions: model.dimensions,
      encodingRecipe: {
        recipeId: 'granite-embedding-97m-r2',
        artifactDigest: modelDigest,
        tokenizerDigest,
        pooling: 'cls',
        normalization: 'l2',
        queryTemplate: '{text}',
        documentTemplate: '{text}',
        maximumSequenceTokens: model.contextTokens
      }
    }),
    embed: (texts, signal) =>
      broker.embed(texts, 'document', signal),
    embedQuery: (texts, signal) =>
      broker.embed(texts, 'query', signal),
    embedDocuments: (texts, signal) =>
      broker.embed(texts, 'document', signal),
    dispose: async () => {
      try {
        await broker.shutdown()
      } finally {
        embeddingBrokers.delete(broker)
      }
    }
  }
}

function runtimeSettingsInputWithEmbeddingSelection(
  settings: RuntimeSettings,
  activeEmbeddingConnectionId: string
): RuntimeSettingsInput {
  const configured = settings.configured ?? settings
  const defaultProfile =
    settings.modelProfiles.find(
      (profile) => profile.id === settings.defaultModelProfileId
    ) ?? settings.modelProfiles[0]
  if (!defaultProfile || !settings.embeddingConnections) {
    throw new Error('模型连接设置不完整')
  }
  return {
    provider: settings.provider,
    modelBaseUrl: defaultProfile.baseUrl,
    modelName: defaultProfile.modelName,
    modelProtocol: defaultProfile.protocol,
    modelAuthentication: defaultProfile.authentication,
    imageGenerationQuality: defaultProfile.imageGenerationQuality,
    opencodeBaseUrl: configured.opencodeBaseUrl,
    opencodeEmbedded: settings.opencodeEmbedded,
    opencodeBinaryPath: configured.opencodeBinaryPath,
    opencodeConfigPath: configured.opencodeConfigPath,
    continueBinaryPath: configured.continueBinaryPath,
    continueConfigPath: configured.continueConfigPath,
    continueMode: settings.continueMode,
    subagentSmartRoutingEnabled: settings.subagentSmartRoutingEnabled,
    knowledgeEmbeddingEnabled: settings.knowledgeEmbeddingEnabled,
    knowledgeEmbeddingBaseUrl: settings.knowledgeEmbeddingBaseUrl,
    knowledgeEmbeddingModel: settings.knowledgeEmbeddingModel,
    knowledgeEmbeddingApiKey: { action: 'keep' },
    embeddingConnections: settings.embeddingConnections.map(
      (connection) =>
        connection.kind === 'builtin'
          ? {
              id: connection.id,
              name: connection.name,
              kind: connection.kind
            }
          : {
              id: connection.id,
              name: connection.name,
              kind: connection.kind,
              baseUrl: connection.baseUrl,
              modelName: connection.modelName,
              authentication: connection.authentication,
              apiKey: { action: 'keep' as const }
            }
    ),
    activeEmbeddingConnectionId,
    knowledgeRerankEnabled: settings.knowledgeRerankEnabled ?? false,
    knowledgeRerankEndpoint: settings.knowledgeRerankEndpoint ?? '',
    knowledgeRerankModel: settings.knowledgeRerankModel ?? '',
    knowledgeRerankApiKey: { action: 'keep' },
    contextCompression: settings.contextCompression,
    workspacePath: configured.workspacePath,
    apiKey: { action: 'keep' },
    modelProfiles: settings.modelProfiles.map((profile) => ({
      id: profile.id,
      name: profile.name,
      baseUrl: profile.baseUrl,
      modelName: profile.modelName,
      protocol: profile.protocol,
      authentication: profile.authentication,
      supportsImageInput: profile.supportsImageInput,
      contextWindowTokens: profile.contextWindowTokens,
      imageGenerationQuality: profile.imageGenerationQuality,
      apiKey: { action: 'keep' as const }
    })),
    defaultModelProfileId: settings.defaultModelProfileId,
    opencodeModelSource: configured.opencodeModelSource,
    continueModelSource: configured.continueModelSource,
    deepseekHarnessModelSource:
      configured.deepseekHarnessModelSource ?? { kind: 'platform' },
    toolApproval: settings.toolApproval
  }
}

function createRerankProvider(
  settings: ResolvedRuntimeSettings
): CohereRerankClient | undefined {
  return settings.knowledgeRerankEnabled
    ? new CohereRerankClient({
        endpoint: settings.knowledgeRerankEndpoint,
        model: settings.knowledgeRerankModel,
        apiKey: settings.knowledgeRerankApiKey
      })
    : undefined
}

function createSubagentProfileRuntimes(
  defaultWorkspace: string,
  settings: ResolvedRuntimeSettings
): ReadonlyMap<string, AgentRuntime> {
  return new Map(
    settings.modelProfiles
      .filter(
        (profile) =>
          profile.id !== settings.defaultModelProfileId &&
          profile.protocol !== 'openai-images-generations'
      )
      .map(
        (profile) =>
          [
            profile.id,
            createModelProfileRuntime(
              defaultWorkspace,
              settings,
              profile
            )
          ] as const
      )
  )
}

const launchContinueHost: ContinueHostLauncher = (
  entryPath,
  args,
  options
) => {
  const utilityChild = utilityProcess.fork(
    join(dirname(entryPath), 'utility-bootstrap.mjs'),
    [entryPath, ...args],
    {
      cwd: options.cwd,
      env: options.env,
      serviceName: 'GoodBuddy Continue Host',
      stdio: 'pipe'
    }
  )
  return createContinueUtilityProcessChild({
    get pid() {
      return utilityChild.pid
    },
    stderr: utilityChild.stderr,
    kill: () => utilityChild.kill(),
    onExit: (listener) => {
      utilityChild.on('exit', listener)
    },
    onceExit: (listener) => {
      utilityChild.once('exit', listener)
    },
    onceError: (listener) => {
      utilityChild.once('error', listener)
    },
    removeExitListener: (listener) => {
      utilityChild.removeListener('exit', listener)
    },
    removeErrorListener: (listener) => {
      utilityChild.removeListener('error', listener)
    }
  })
}

const forkDeepSeekHarness: DeepSeekHarnessFork = (
  modulePath,
  args,
  options
) =>
  utilityProcess.fork(modulePath, args, {
    ...options,
    allowLoadingUnsignedLibraries: false,
    disclaim: false
  })

function terminateHarnessUtilityProcess(
  child: ReturnType<DeepSeekHarnessFork>
): void {
  requestProcessTreeTermination(child, { spawn })
}

const launchWechatSidecar: WechatSidecarLauncher = () => {
  const utilityChild = utilityProcess.fork(
    join(mainModuleDirectory, 'wechat-sidecar.js'),
    [],
    {
      env: buildWechatSidecarEnvironment(),
      serviceName: 'GoodBuddy Weixin Transport',
      stdio: 'ignore'
    }
  )
  const child: WechatSidecarChild = {
    postMessage: (message) => utilityChild.postMessage(message),
    kill: () => utilityChild.kill(),
    on: (_event, listener) => {
      utilityChild.on('message', listener)
      return child
    },
    once: (
      event: 'exit' | 'error',
      listener: ((code: number | null) => void) | ((error: Error) => void)
    ) => {
      if (event === 'exit') {
        utilityChild.once('exit', (code) => {
          ;(listener as (code: number | null) => void)(code)
        })
      } else {
        utilityChild.once('error', (_type, location, report) => {
          ;(listener as (error: Error) => void)(
            new Error(
              `微信 Sidecar 异常（${location}）：${report.slice(0, 300)}`
            )
          )
        })
      }
      return child
    }
  }
  return child
}

function buildTray(): Tray {
  const nextTray = new Tray(createTrayIcon())
  nextTray.setToolTip('GoodBuddy')
  nextTray.setContextMenu(
    Menu.buildFromTemplate([
      {
        label: '打开 GoodBuddy',
        click: () => mainWindow && showWindow(mainWindow)
      },
      {
        label: '新建对话',
        click: () => {
          if (mainWindow) {
            showWindow(mainWindow)
            mainWindow.webContents.send(ipcChannels.conversationNew)
          }
        }
      },
      {
        label: '设置',
        click: () => {
          if (mainWindow) {
            showWindow(mainWindow)
            mainWindow.webContents.send(ipcChannels.settingsOpen)
          }
        }
      },
      { type: 'separator' },
      {
        label: '退出',
        click: () => {
          isQuitting = true
          app.quit()
        }
      }
    ])
  )
  nextTray.on('click', () => {
    if (mainWindow) {
      toggleWindow(mainWindow)
    }
  })
  return nextTray
}

if (hasSingleInstanceLock) {
  app.on('second-instance', () => {
    if (mainWindow) {
      showWindow(mainWindow)
    }
  })

  void app.whenReady().then(async () => {
    session.defaultSession.setPermissionRequestHandler(
      (webContents, permission, callback, details) => {
        const mediaTypes =
          'mediaTypes' in details && Array.isArray(details.mediaTypes)
            ? details.mediaTypes
            : []
        callback(
          permission === 'media' &&
            webContents === mainWindow?.webContents &&
            mediaTypes.includes('audio') &&
            !mediaTypes.includes('video')
        )
      }
    )
    session.defaultSession.setPermissionCheckHandler(
      (webContents, permission, _origin, details) =>
        permission === 'media' &&
        webContents === mainWindow?.webContents &&
        details.mediaType === 'audio'
    )

    mainWindow = createMainWindow(() => isQuitting)
    registerDesktopNotificationActivation(mainWindow)
    tray = buildTray()
    const defaultWorkspace = process.env.GOODBUDDY_WORKSPACE ?? homedir()
    const secureCipher = {
      isAvailable: () =>
        safeStorage.isEncryptionAvailable() &&
        (process.platform !== 'linux' ||
          [
            'gnome_libsecret',
            'kwallet',
            'kwallet5',
            'kwallet6'
          ].includes(safeStorage.getSelectedStorageBackend())),
      encrypt: (value: string) => safeStorage.encryptString(value),
      decrypt: (value: Buffer) => safeStorage.decryptString(value)
    }
    const settingsStore = new RuntimeSettingsStore(
      join(app.getPath('userData'), 'runtime-settings.json'),
      secureCipher
    )
    const [initialRuntimeSettings, initialResolvedSettings] =
      await Promise.all([
        settingsStore.getPublicSettings(),
        settingsStore.getResolvedSettings()
      ])
    globalTlsPolicy = new GlobalTlsPolicy(app)
    globalTlsPolicy.install()
    const capabilityService = new CapabilityService(
      join(app.getPath('userData'), 'capabilities.json'),
      app.isPackaged
        ? join(process.resourcesPath, 'skills')
        : join(app.getAppPath(), 'resources', 'skills'),
      join(app.getPath('userData'), 'skills', 'imported'),
      secureCipher
    )
    const channelSettingsStore = new ChannelSettingsStore(
      join(app.getPath('userData'), 'channel-settings.json'),
      secureCipher
    )
    const applicationSettingsStore = new ApplicationSettingsStore(
      join(app.getPath('userData'), 'application-settings.json')
    )
    const startupEmbeddingModelManager = new EmbeddingModelManager({
      userDataDirectory: app.getPath('userData'),
      fetch: globalThis.fetch,
      getDownloadSource: async () =>
        (await applicationSettingsStore.get()).modelDownloadSource
    })
    embeddingModelManager = startupEmbeddingModelManager
    const releaseNotesService = new ReleaseNotesService({
      currentVersion: app.getVersion(),
      filePath: app.isPackaged
        ? join(process.resourcesPath, 'release-notes.json')
        : join(app.getAppPath(), 'resources', 'release-notes.json'),
      settingsStore: applicationSettingsStore
    })
    const documentParsingSettingsStore =
      new DocumentParsingSettingsStore(
        join(app.getPath('userData'), 'document-parsing-settings.json')
      )
    documentOcrModelManager = new DocumentOcrModelManager({
      userDataDirectory: app.getPath('userData'),
      fetch: globalThis.fetch,
      getDownloadSource: async () =>
        (await applicationSettingsStore.get()).modelDownloadSource
    })
    documentOcrBroker = new DocumentOcrBroker(mainWindow)
    const documentParsingService = new DocumentParsingService(
      documentParsingSettingsStore,
      documentOcrModelManager,
      documentOcrBroker
    )
    const versionChecker = new VersionChecker({
      fetch: globalThis.fetch,
      currentVersion: app.getVersion(),
      platform: process.platform,
      arch: process.arch
    })
    const speechModelManager = new SpeechModelManager({
      userDataDirectory: app.getPath('userData'),
      fetch: globalThis.fetch,
      getDownloadSource: async () =>
        (await applicationSettingsStore.get()).modelDownloadSource
    })
    const speechTranscriptionService = new SpeechTranscriptionService(
      speechModelManager
    )
    browserService = new BrowserService({ parentWindow: mainWindow })
    const bundledRuntimePaths = resolveBundledRuntimePaths({
      appPath: app.getAppPath(),
      resourcesPath: process.resourcesPath,
      packaged: app.isPackaged
    })
    const deepSeekHarnessHome = join(
      app.getPath('userData'),
      'deepseek-harness'
    )
    const startupDshExtensionInstaller = new DshNpmExtensionInstaller({
      dshHome: deepSeekHarnessHome,
      npmCliPath: app.isPackaged
        ? join(
            process.resourcesPath,
            'runtimes',
            'npm',
            'bin',
            'npm-cli.js'
          )
        : join(
            app.getAppPath(),
            'node_modules',
            'npm',
            'bin',
            'npm-cli.js'
          )
    })
    dshExtensionInstaller = startupDshExtensionInstaller
    const runtimeExtensionStore = new RuntimeExtensionStore(
      app.getPath('userData'),
      {
        catalog: new DshNpmMarketplaceCatalog(),
        install: (input) =>
          startupDshExtensionInstaller.install(input)
      }
    )
    const launchDeepSeekHarness =
      createDeepSeekHarnessUtilityLauncher({
        bundledHostPath: bundledRuntimePaths.deepseekHarness,
        dshHome: deepSeekHarnessHome,
        environment: buildControlledHarnessEnvironment(
          deepSeekHarnessHome
        ),
        fork: forkDeepSeekHarness,
        terminateProcess: terminateHarnessUtilityProcess,
        onExtensionStartupFailures: (extensionIds) =>
          runtimeExtensionStore.markStartupFailed(extensionIds)
      })
    const startupKnowledgeService = new KnowledgeService({
      databasePath: join(app.getPath('userData'), 'knowledge.sqlite'),
      managedRoot: join(app.getPath('userData'), 'knowledge'),
      extractStructured: createModelGraphExtractor(settingsStore),
      parseDocument: documentParsingService.parse
    })
    knowledgeService = startupKnowledgeService
    let activeEmbeddingProvider:
      | Awaited<ReturnType<typeof createEmbeddingProvider>>
      | undefined
    let activeRerankProvider:
      | ReturnType<typeof createRerankProvider>
      | undefined
    const startupAssistantDatabase = new AssistantDatabase(
      join(app.getPath('userData'), 'assistant.sqlite'),
      {
        onMagicTodosChanged: () => {
          queueMicrotask(() => {
            if (
              mainWindow &&
              !mainWindow.isDestroyed() &&
              !mainWindow.webContents.isDestroyed()
            ) {
              mainWindow.webContents.send(
                ipcChannels.magicTodosStatusChanged
              )
            }
          })
        }
      }
    )
    assistantDatabase = startupAssistantDatabase
    const goodbuddyConfigService = new GoodBuddyConfigService(
      applicationSettingsStore,
      capabilityService
    )
    const startupKnowledgeGateway = new KnowledgeMcpGateway(
      startupKnowledgeService,
      {
        magicNotesDatabase: startupAssistantDatabase,
        configService: goodbuddyConfigService
      }
    )
    knowledgeGateway = startupKnowledgeGateway
    const createRuntimeWithCapabilities = async (
      settings: ResolvedRuntimeSettings,
      target: SelectedRuntimeTarget
    ): Promise<AgentRuntime> => {
      const [
        skillContext,
        mcpServers,
        browserCapability,
        webSearchCapability,
        deepseekHarnessExtensions
      ] =
        await Promise.all([
          capabilityService.getRuntimeSkillContext(target),
          capabilityService.getResolvedMcpServers(target),
          target === 'model'
            ? capabilityService.getComputerCapabilityStatus(
                'host-browser-control'
              )
            : Promise.resolve(undefined),
          target === 'model' || target === 'deepseek-harness'
            ? capabilityService.getWebSearchCapabilityStatus()
            : Promise.resolve(undefined),
          target === 'deepseek-harness'
            ? runtimeExtensionStore.getEnabledExtensions()
            : Promise.resolve([])
        ])
      return createAgentRuntime(defaultWorkspace, settings, {
        skillInstructions: skillContext.instructions,
        skillPackages: skillContext.packages,
        mcpServers,
        continueHostCacheRoot: join(
          app.getPath('userData'),
          'continue-host'
        ),
        bundledRuntimePaths,
        continueHostLauncher: launchContinueHost,
        deepseekHarnessLauncher: launchDeepSeekHarness,
        deepseekHarnessExtensions,
        browserService:
          browserCapability?.enabled && browserCapability.supported
            ? browserService
            : undefined,
        knowledgeGateway: startupKnowledgeGateway,
        webSearchEnabled: webSearchCapability?.enabled
      })
    }
    const createConfiguredRuntime = async (
      resolvedSettings?: ResolvedRuntimeSettings
    ): Promise<AgentRuntime> => {
      const settings =
        resolvedSettings ?? await settingsStore.getResolvedSettings()
      return createRuntimeWithCapabilities(
        settings,
        getConfiguredRuntimeTarget(settings)
      )
    }
    const createSelectedRuntime = async (
      selection: AgentRuntimeSelection,
      workspacePath?: string
    ): Promise<AgentRuntime> => {
      const resolved = applyRuntimeSelection(
        await settingsStore.getResolvedSettings(),
        selection
      )
      return createRuntimeWithCapabilities(
        workspacePath
          ? { ...resolved.settings, workspacePath }
          : resolved.settings,
        resolved.target
      )
    }
    const configuredRuntime = await runStartupPrerequisites({
      prepareDeepSeekHome: async () => {
        await mkdir(deepSeekHarnessHome, {
          recursive: true,
          mode: 0o700
        })
      },
      initializeKnowledgeAndGateway: async () => {
        await startupKnowledgeService.initialize()
        const embeddingProvider = await createEmbeddingProvider(
          initialResolvedSettings,
          startupEmbeddingModelManager
        )
        const rerankProvider = createRerankProvider(
          initialResolvedSettings
        )
        await Promise.all([
          startupKnowledgeService.setEmbeddingProvider(
            embeddingProvider
          ).then(
            () => {
              activeEmbeddingProvider = embeddingProvider
            },
            () => undefined
          ),
          startupKnowledgeService.setRerankProvider(
            rerankProvider
          ).then(
            () => {
              activeRerankProvider = rerankProvider
            },
            () => undefined
          )
        ])
        await startupKnowledgeGateway.start()
      },
      hydrateConfiguredRuntime: () =>
        createConfiguredRuntime(initialResolvedSettings),
      initializeAssistant: () => {
        startupAssistantDatabase.initialize(defaultWorkspace)
        startupAssistantDatabase.ensureChannelProjects(
          defaultWorkspace,
          initialRuntimeSettings.defaultModelProfileId
        )
        channelSettingsStore.reportRuntimeSelectionRepairs(
          startupAssistantDatabase.repairConversationRuntimeSelections(
            initialRuntimeSettings
          )
        )
      }
    })
    const subagentService = new SubagentService(
      createDefaultModelRuntime(
        defaultWorkspace,
        initialResolvedSettings
      ),
      startupAssistantDatabase,
      undefined,
      createSubagentProfileRuntimes(
        defaultWorkspace,
        initialResolvedSettings
      )
    )
    runtime = new AgentRuntimeController(configuredRuntime)
    selectedRuntimeManager = new SelectedRuntimeManager(
      createSelectedRuntime
    )
    const contextManager = new ContextManager({
      parseDocument: documentParsingService.parse
    })
    const approvalBroker = new ToolApprovalBroker()

    const shortcutSettingsService = new ShortcutSettingsService(
      new ShortcutSettingsStore(
        join(app.getPath('userData'), 'shortcut-settings.json')
      ),
      globalShortcut,
      () => {
        if (mainWindow) {
          toggleWindow(mainWindow)
        }
      },
      process.platform
    )
    await shortcutSettingsService.initialize()

    let runtimeReconfigurationQueue: Promise<void> = Promise.resolve()
    let runtimeReconfigurationClosing = false
    const reconfigureRuntimes = (): Promise<void> => {
      const operation = runtimeReconfigurationQueue.then(async () => {
        if (runtimeReconfigurationClosing) {
          throw new Error('Runtime 配置正在关闭')
        }
        const settings = await settingsStore.getResolvedSettings()
        const nextEmbeddingProvider =
          await createEmbeddingProvider(
            settings,
            startupEmbeddingModelManager
          )
        const nextRerankProvider = createRerankProvider(settings)
        let nextRuntime: AgentRuntime | undefined
        let nextSubagentRuntime: AgentRuntime | undefined
        let nextSubagentProfileRuntimes:
          | ReadonlyMap<string, AgentRuntime>
          | undefined
        try {
          nextSubagentRuntime = createDefaultModelRuntime(
            defaultWorkspace,
            settings
          )
          nextSubagentProfileRuntimes =
            createSubagentProfileRuntimes(
              defaultWorkspace,
              settings
            )
          if (runtime) {
            nextRuntime = await createConfiguredRuntime(settings)
          }
        } catch (error) {
          await Promise.allSettled([
            nextRuntime?.dispose(),
            nextSubagentRuntime?.dispose(),
            ...[
              ...(nextSubagentProfileRuntimes?.values() ?? [])
            ].map((candidate) => candidate.dispose())
          ])
          throw error
        }

        let runtimeConsumed = false
        let subagentRuntimesConsumed = false
        try {
          if (knowledgeService) {
            await Promise.all([
              knowledgeService.setEmbeddingProvider(
                nextEmbeddingProvider
              ),
              knowledgeService.setRerankProvider(
                nextRerankProvider
              )
            ])
          }
          if (runtime && nextRuntime) {
            runtimeConsumed = true
            await runtime.replace(nextRuntime)
          }
          subagentRuntimesConsumed = true
          await subagentService.replaceRuntimes(
            nextSubagentRuntime,
            nextSubagentProfileRuntimes
          )
          await selectedRuntimeManager?.reset()
          const previousEmbeddingProvider = activeEmbeddingProvider
          activeEmbeddingProvider = nextEmbeddingProvider
          activeRerankProvider = nextRerankProvider
          await previousEmbeddingProvider?.dispose?.()
        } catch (activationError) {
          const rollbackResults = knowledgeService
            ? await Promise.allSettled([
                knowledgeService.setEmbeddingProvider(
                  activeEmbeddingProvider
                ),
                knowledgeService.setRerankProvider(
                  activeRerankProvider
                )
              ])
            : []
          await Promise.allSettled([
            nextEmbeddingProvider?.dispose?.(),
            runtimeConsumed ? undefined : nextRuntime?.dispose(),
            subagentRuntimesConsumed
              ? undefined
              : nextSubagentRuntime.dispose(),
            ...(subagentRuntimesConsumed
              ? []
              : [...nextSubagentProfileRuntimes.values()].map(
                  (candidate) => candidate.dispose()
                ))
          ])
          const rollbackErrors = rollbackResults.flatMap((result) =>
            result.status === 'rejected' ? [result.reason] : []
          )
          if (rollbackErrors.length > 0) {
            throw new AggregateError(
              [activationError, ...rollbackErrors],
              'Runtime 激活失败，且模型服务回滚未能完成',
              { cause: activationError }
            )
          }
          throw activationError
        }
      })
      runtimeReconfigurationQueue = operation.catch(() => undefined)
      return operation
    }
    stopRuntimeReconfiguration = async () => {
      runtimeReconfigurationClosing = true
      await runtimeReconfigurationQueue
    }
    const setCurrentEmbeddingConnection = async (
      connectionId: string
    ): Promise<void> => {
      const previous = await settingsStore.getPublicSettings()
      if (previous.activeEmbeddingConnectionId === connectionId) {
        return
      }
      await settingsStore.update(
        runtimeSettingsInputWithEmbeddingSelection(
          previous,
          connectionId
        )
      )
      try {
        await reconfigureRuntimes()
      } catch (activationError) {
        try {
          await settingsStore.update(
            runtimeSettingsInputWithEmbeddingSelection(
              previous,
              previous.activeEmbeddingConnectionId ??
                connectionId
            )
          )
          await reconfigureRuntimes()
        } catch (rollbackError) {
          throw new AggregateError(
            [activationError, rollbackError],
            '向量模型连接激活失败，且回滚未能完成',
            { cause: rollbackError }
          )
        }
        throw activationError
      }
    }

    removeIpcHandlers = registerIpcHandlers(
      mainWindow,
      runtime,
      legacyDefaultShortcut,
      settingsStore,
      capabilityService,
      contextManager,
      knowledgeService,
      assistantDatabase,
      approvalBroker,
      bundledRuntimePaths,
      reconfigureRuntimes,
      async () => {
        await browserService?.clearSessions()
      },
      browserService,
      subagentService,
      channelSettingsStore,
      applicationSettingsStore,
      versionChecker,
      speechModelManager,
      undefined,
      selectedRuntimeManager,
      speechTranscriptionService,
      knowledgeGateway,
      launchWechatSidecar,
      documentParsingService,
      documentOcrModelManager,
      documentOcrBroker,
      releaseNotesService,
      goodbuddyConfigService,
      runtimeExtensionStore,
      shortcutSettingsService,
      startupEmbeddingModelManager,
      async (connectionId) => {
        const settings = await settingsStore.getResolvedSettings()
        const provider = await createEmbeddingProvider(
          settings,
          startupEmbeddingModelManager,
          connectionId
        )
        if (!provider) {
          throw new Error('请先启用并保存向量模型设置')
        }
        return provider
      },
      setCurrentEmbeddingConnection
    )
    loadMainWindow(mainWindow)
    setImmediate(() => {
      void repairStaleWindowsNotificationShortcuts({
        platform: process.platform,
        installed: installedWindowsBuild,
        executablePath: process.execPath,
        programsDirectory: join(
          app.getPath('appData'),
          'Microsoft',
          'Windows',
          'Start Menu',
          'Programs'
        ),
        shortcutAccess: {
          readShortcutLink: (shortcutPath) =>
            shell.readShortcutLink(shortcutPath),
          writeShortcutLink: (
            shortcutPath,
            operation,
            options
          ) =>
            shell.writeShortcutLink(
              shortcutPath,
              operation,
              options
            )
        }
      }).then(
        ({ failed }) => {
          if (failed > 0) {
            console.warn(
              `Failed to repair ${failed} stale notification shortcut(s)`
            )
          }
        },
        (error: unknown) => {
          console.warn(
            'Failed to inspect stale notification shortcuts',
            error
          )
        }
      )
    })

    app.on('activate', () => {
      if (mainWindow) {
        showWindow(mainWindow)
      }
    })
  }).catch((error: unknown) => {
    console.error(
      'GoodBuddy startup failed',
      createStartupFailureDiagnostic(error)
    )
    dialog.showErrorBox(
      'GoodBuddy 启动失败',
      formatStartupFailureMessage(error)
    )
    app.quit()
  })
}

let cleanupStarted = false
let cleanupComplete = false

app.on('before-quit', (event) => {
  isQuitting = true
  if (cleanupComplete) {
    return
  }
  event.preventDefault()
  if (cleanupStarted) {
    return
  }
  cleanupStarted = true
  void (async () => {
    try {
      const cleanup = settleCleanupPhases([
        [
          () => dshExtensionInstaller?.dispose(),
          () => removeIpcHandlers?.()
        ],
        [() => stopRuntimeReconfiguration?.()],
        [
          () => runtime?.dispose(),
          () => selectedRuntimeManager?.dispose(),
          () => browserService?.dispose(),
          () => globalTlsPolicy?.dispose(),
          () =>
            Promise.allSettled(
              [...embeddingBrokers].map((broker) => broker.shutdown())
            ).then(() => undefined),
          () => embeddingModelManager?.dispose(),
          () => documentOcrModelManager?.dispose(),
          () => documentOcrBroker?.dispose()
        ],
        [() => knowledgeGateway?.dispose()],
        [() => knowledgeService?.dispose()]
      ])
      globalShortcut.unregisterAll()
      tray?.destroy()
      await runCleanupBeforeDeadline(cleanup, 8_000, () => {
        assistantDatabase?.close()
      })
    } finally {
      cleanupComplete = true
      app.exit(0)
    }
  })()
})

app.on('will-quit', () => {
  cleanupComplete = true
})

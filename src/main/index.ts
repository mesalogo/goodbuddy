import { startupMark, startupSpan } from './startup-marks'
import { localInferenceService } from './local-inference-service'
import { NativeClientCoordinator } from './agent/native-client-coordinator'
import { createEmbeddingUtilityTransport } from './knowledge/embedding-utility-transport'
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
import { mkdir, readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import spawn from 'cross-spawn'
import { ipcChannels } from '../shared/ipc-channels'
import {
  createAgentRuntime
} from './agent/create-runtime'
import { AgentRuntimeController } from './agent/runtime-controller'
import type { AgentRuntime } from './agent/runtime'
import { SelectedRuntimeManager } from './agent/selected-runtime-manager'
import { LocalRuntimeRegistry } from './agent/local-runtime-registry'
import { KnowledgeMcpGateway } from './agent/knowledge-mcp-gateway'
import { ObsidianService } from './obsidian'
import {
  applyRuntimeSelection,
  getConfiguredRuntimeTarget,
  resolveConfiguredAgentRuntimeSelection,
  resolveLayeredRuntimeSelection,
  type SelectedRuntimeTarget
} from './agent/runtime-selection'
import { CapabilityService } from './capabilities/capability-service'
import { ImageGenerationService } from './agent/image-generation-service'
import { ContextManager } from './context-manager'
import {
  registerIpcHandlers,
  sendRemoteProjectSaveProgress
} from './ipc'
import { KnowledgeService } from './knowledge/knowledge-service'
import { DesktopStorageClient } from './desktop-storage-client'
import type { AssistantStorageProgress } from '../shared/assistant-storage-contracts'
import { createAssistantStoragePort, createAssistantStorageOnChanged, type AsyncAssistantStoragePort } from './assistant-storage-port'
import { createDesktopStorageFiles, type DesktopFilesCaller } from './desktop-storage-files'
import { createKnowledgeStoragePort } from './knowledge/knowledge-storage-port'
import { createSupervisionDomainPorts } from './assistant/supervision-domain-ports'
import { createDesktopRuntimeStorageAdapters, type DesktopRuntimeStorageCall } from './desktop-storage-runtime-operations'
import { prepareAssistantStorage } from './assistant-storage-startup'
import { createModelGraphExtractor } from './knowledge/model-extractor'
import { OpenAIEmbeddingClient } from './knowledge/openai-embedding-client'
import { embeddingProviderFingerprint } from './knowledge/embedding-provider-key'
import type { EmbeddingProvider } from './knowledge/types'
import { EmbeddingModelManager } from './knowledge/embedding-model-manager'
import { EmbeddingInferenceBroker } from './knowledge/embedding-inference-broker'
import { CohereRerankClient } from './knowledge/cohere-rerank-client'
import { RuntimeSettingsStore } from './runtime-settings-store'
import type { ResolvedRuntimeSettings } from './runtime-settings-store'
import {
  createMainWindow,
  loadMainWindow,
  showWindow,
  toggleWindow
} from './window'
import { createTrayIcon } from './tray-icon'
import { resolveBundledRuntimePaths } from './agent/bundled-runtimes'
import type { ContinueHostLauncher } from './agent/continue-host-adapter'
import { cleanupRuntimeTemporaryDirectories, runtimeTemporaryRoot } from './runtime-temporary-directory'
import { resolvePortableUserDataPath } from './portable-user-data'
import { BrowserService } from './browser/browser-service'
import { SubagentService, createSubagentRuntime } from './assistant/subagent-service'
import { SubagentScheduler } from './assistant/subagent-scheduler'
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
import { FeedbackIdentityStore } from './feedback/feedback-identity-store'
import {
  createStrictFeedbackDispatcher,
  StrictFeedbackHttpClient
} from './feedback/feedback-http-client'
import { FeedbackService } from './feedback/feedback-service'
import { registerFeedbackIpcHandler } from './feedback/feedback-ipc'
import { registerDeviceSharingIpc } from './device-sharing-ipc'
import { DeviceSharingService } from './device-sharing-service'
import type { AgentRuntimeSelection } from '../shared/runtime-selection-contracts'
import type { SystemModelUsageInput } from '../shared/assistant-contracts'
import {
  runCleanupBeforeDeadline,
  settleCleanupPhases
} from './shutdown'
import { DocumentParsingSettingsStore } from './document-parsing-settings-store'
import { DocumentOcrModelManager } from './document-ocr-model-manager'
import { DocumentOcrBroker } from './document-ocr-broker'
import { DocumentParsingService } from './document-parsing-service'
import { configureDocumentParseWorker } from './document-parse-client'
import { ReleaseNotesService } from './release-notes-service'
import { GoodBuddyConfigService } from './goodbuddy-config-service'
import {
  createDeepSeekHarnessUtilityLauncher,
  type DeepSeekHarnessFork
} from './agent/deepseek-harness-utility-launcher'
import {
  buildControlledHarnessEnvironment,
  buildCredentialFilteredUserEnvironment
} from './agent/process-environment'
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
import { SshHostStore } from './ssh/ssh-host-store'
import { Ssh2Transport } from './ssh/ssh-transport'
import { SshHostService } from './ssh/ssh-host-service'
import { SshHostDirectoryBrowser } from './ssh/ssh-host-directory-browser'
import {
  SshHostRemoteEnvironmentInspector
} from './ssh/ssh-host-remote-environment'
import { defaultGlobalShortcutSettings } from '../shared/shortcut'
import { requestProcessTreeTermination } from './agent/child-process-termination'
import { createContinueUtilityProcessChild } from './agent/continue-utility-process-adapter'
import {
  ExecutionSpaceResolver,
  type ExecutionSpaceDescriptor
} from './execution-space'
import { RemoteAgentServices } from './remote-agent/remote-agent-services'
import {
  resolveBundledAgentResourcePaths,
  resolveControlPlanePackageInstallerPath
} from './remote-agent/bundled-agent-resources'
import {
  AgentPackageManager
} from './remote-agent/agent-package-manager'
import { ManagedRemoteExecutionServices } from './remote-agent/managed-remote-execution-services'
import {
  RemoteEnvironmentUpdateService
} from './remote-agent/remote-environment-update-service'
import {
  RemoteEnvironmentPreparer
} from './remote-agent/remote-environment-preparer'
import {
  RemoteEnvironmentOperationStore
} from './remote-agent/remote-environment-operation-store'
import {
  DesktopDiagnostics,
  type DesktopDiagnosticFailureObserver
} from './desktop-diagnostics'
import { TerminalSessionManager } from './terminal/terminal-session-manager'
import {
  LocalToolEnvironmentService,
  resolveNpmCliPaths
} from './local-tool-environment'

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
const desktopDiagnostics = new DesktopDiagnostics(
  join(app.getPath('userData'), 'diagnostics')
)
const observeDesktopFailure: DesktopDiagnosticFailureObserver = (
  failure
) => {
  void desktopDiagnostics.recordFailure(failure).catch(() => undefined)
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
let removeFeedbackIpcHandler: (() => void) | undefined
let removeDeviceSharingIpc: (() => void) | undefined
let runtime: AgentRuntimeController | undefined
let selectedRuntimeManager: SelectedRuntimeManager | undefined
const localRuntimeRegistry = new LocalRuntimeRegistry()
let knowledgeService: KnowledgeService | undefined
let knowledgeGateway: KnowledgeMcpGateway | undefined
let desktopStorage: DesktopStorageClient | undefined
let assistantDatabase: AsyncAssistantStoragePort | undefined
let imageGenerationService: ImageGenerationService | undefined
let browserService: BrowserService | undefined
let globalTlsPolicy: GlobalTlsPolicy | undefined
let feedbackService: FeedbackService | undefined
let documentOcrBroker: DocumentOcrBroker | undefined
let documentParsingService: DocumentParsingService | undefined
let startupContextManager: ContextManager | undefined
let startupSubagentService: SubagentService | undefined
let documentOcrModelManager: DocumentOcrModelManager | undefined
let embeddingModelManager: EmbeddingModelManager | undefined
const embeddingBrokers = new Set<EmbeddingInferenceBroker>()
const sharedEmbeddingBrokers = new Map<string, { broker: EmbeddingInferenceBroker; users: number; unregister: () => void }>()
let stopRuntimeReconfiguration: (() => Promise<void>) | undefined
let dshExtensionInstaller: DshNpmExtensionInstaller | undefined
let remoteAgentServices: RemoteAgentServices | undefined
let terminalSessionManager: TerminalSessionManager | undefined
let nativeClientCoordinator: NativeClientCoordinator | undefined
let managedRemoteExecutionServices:
  | ManagedRemoteExecutionServices
  | undefined
let directModelSubagentScheduler: SubagentScheduler | undefined
let localToolEnvironmentService: LocalToolEnvironmentService | undefined
const knowledgeUsageWrites = new Set<Promise<void>>()
let knowledgeUsageFailure: unknown

function recordKnowledgeUsage(
  bucket: SystemModelUsageInput['bucket'],
  usage: Omit<SystemModelUsageInput, 'source' | 'bucket'>
): Promise<void> {
  const operation = assistantDatabase!.recordSystemModelUsage({
      ...usage,
      source: 'knowledge',
      bucket
    }).then(() => undefined)
  knowledgeUsageWrites.add(operation)
  // Some provider observers return void; still observe and drain their writes.
  void operation.then(() => knowledgeUsageWrites.delete(operation), error => {
    knowledgeUsageWrites.delete(operation)
    knowledgeUsageFailure = error
    observeDesktopFailure({
      component: 'desktop', stage: 'knowledge', code: 'knowledge.usage.persist-failed', error
    })
  })
  return operation
}

type ManagedEmbeddingProvider = EmbeddingProvider & {
  dispose?: () => void | Promise<void>
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
      apiKey: connection.apiKey,
      onUsage: ({ model, inputTokens }) =>
        recordKnowledgeUsage('embedding', {
          runtime: 'embedding',
          provider: 'openai-compatible',
          model,
          input: inputTokens,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0
        })
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
  let shared = sharedEmbeddingBrokers.get(modelDirectory)
  if (!shared) {
    const broker = new EmbeddingInferenceBroker({
      createTransport: () =>
        createEmbeddingUtilityTransport(
          join(mainModuleDirectory, 'embedding-inference-bootstrap.js'),
          modelDirectory
        )
    })
    embeddingBrokers.add(broker)
    const unregister = localInferenceService.register('embedding', {
      snapshot: () => ({
        id: 'embedding', name: '向量生成', engine: 'Granite / ONNX',
        ownership: 'managed-process', state: broker.getManagementState(), model: model.id,
        error: broker.getManagementError(),
        resources: broker.getResources(),
        detail: 'GoodBuddy 托管进程，由知识检索与索引共享。进程启动后模型在首个请求时加载；资源指标为整个向量服务进程占用。停止会中断使用方任务，启动不重放任务。',
        actions: broker.getManagementState() === 'stopped' || broker.getManagementState() === 'idle' || broker.getManagementState() === 'error'
          ? ['start'] : broker.getManagementState() === 'running' ? ['stop', 'restart'] : []
      }),
      act: async (action) => {
        if (action !== 'start') await broker.stop()
        if (action !== 'stop') await broker.start()
      }
    })
    shared = { broker, users: 0, unregister }
    sharedEmbeddingBrokers.set(modelDirectory, shared)
  }
  shared.users += 1
  const sharedBroker = shared
  const broker = shared.broker
  let disposed = false
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
      if (disposed) return
      disposed = true
      sharedBroker.users -= 1
      if (sharedBroker.users > 0) return
      sharedEmbeddingBrokers.delete(modelDirectory)
      sharedBroker.unregister()
      try {
        await broker.shutdown()
      } finally {
        embeddingBrokers.delete(broker)
      }
    }
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
    stdout: utilityChild.stdout,
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

const storageUpgradeController = new AbortController()
let storageUpgrade: Promise<void> | undefined
let applicationStartup: Promise<void> | undefined
const runtimeTemporaryCleanupController = new AbortController()
let runtimeTemporaryCleanupTimer: ReturnType<typeof setTimeout> | undefined
let runtimeTemporaryCleanup: Promise<unknown> | undefined

startupMark('main:module-evaluated')
if (hasSingleInstanceLock) {
  app.on('second-instance', () => {
    if (mainWindow) {
      showWindow(mainWindow)
    }
  })

  applicationStartup = app.whenReady().then(async () => {
    startupMark('main:when-ready')
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

    const defaultWorkspace = process.env.GOODBUDDY_WORKSPACE ?? homedir()
    const notifyStorageChange = (channel: string): void => {
      if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed()) {
        mainWindow.webContents.send(channel)
      }
    }
    // Start the storage process before creating the window so their startup
    // overlaps. Progress before the window attaches keeps only the latest value.
    let publishStorageProgress: ((progress: AssistantStorageProgress) => void) | undefined
    let earlyStorageProgress: AssistantStorageProgress | undefined
    const storageClient = desktopStorage = new DesktopStorageClient({
      userDataPath: app.getPath('userData'),
      assistantPath: join(app.getPath('userData'), 'assistant.sqlite'),
      knowledgePath: join(app.getPath('userData'), 'knowledge.sqlite'),
      defaultRootPath: defaultWorkspace,
      onProgress: progress => publishStorageProgress ? publishStorageProgress(progress) : (earlyStorageProgress = progress),
      onChanged: createAssistantStorageOnChanged({
        onMagicNotesChanged: () => notifyStorageChange(ipcChannels.magicNotesChanged),
        onMagicTodosChanged: () => notifyStorageChange(ipcChannels.magicTodosStatusChanged),
        onModelUsageChanged: () => notifyStorageChange(ipcChannels.tokenUsageChanged),
        onExecutionStatsChanged: () => notifyStorageChange(ipcChannels.tasksExecutionStatsChanged)
      }),
      onFailure: error => observeDesktopFailure({
        component: 'desktop', stage: 'storage', code: 'desktop.storage.failed', error
      })
    })
    startupMark('main:create-window:start')
    mainWindow = createMainWindow(() => isQuitting, observeDesktopFailure)
    startupMark('main:create-window:end')
    registerDesktopNotificationActivation(mainWindow)
    tray = buildTray()
    startupMark('main:tray-built')
    storageUpgrade = prepareAssistantStorage(
      mainWindow,
      publish => {
        publishStorageProgress = publish
        if (earlyStorageProgress) publish(earlyStorageProgress)
        return storageClient
      },
      storageUpgradeController.signal
    )
    await startupSpan('main:storage-upgrade-check', () => storageUpgrade!)
    if (storageUpgradeController.signal.aborted) return
    const storage = desktopStorage!
    // The path is shared by all local runtimes; their existing owners create it lazily.
    const runtimeLaunchRoot = runtimeTemporaryRoot(app.getPath('userData'), app.getVersion())
    const startupAssistantDatabase = createAssistantStoragePort(storage)
    assistantDatabase = startupAssistantDatabase
    const storageFiles = createDesktopStorageFiles({ call: storage.call.bind(storage) as DesktopFilesCaller['call'] })
    const supervisionPorts = createSupervisionDomainPorts(storage)
    const runtimeStorage = createDesktopRuntimeStorageAdapters(
      storage.call.bind(storage) as DesktopRuntimeStorageCall
    )
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
    const applicationSettingsStore = new ApplicationSettingsStore(
      join(app.getPath('userData'), 'application-settings.json')
    )
    const toolEnvironmentRoot = join(
      app.getPath('userData'),
      'tool-environment'
    )
    const npmCliPaths = resolveNpmCliPaths({
      appPath: app.getAppPath(),
      resourcesPath: process.resourcesPath,
      packaged: app.isPackaged
    })
    const startupLocalToolEnvironmentService =
      new LocalToolEnvironmentService({
        settingsStore: applicationSettingsStore,
        binDirectory: join(toolEnvironmentRoot, 'bin'),
        managedPythonRoot: join(
          toolEnvironmentRoot,
          'managed-python'
        ),
        pythonArtifactCatalogPath: app.isPackaged
          ? join(
              process.resourcesPath,
              'tool-environment',
              'managed-python-artifacts.json'
            )
          : join(
              app.getAppPath(),
              'resources',
              'tool-environment',
              'managed-python-artifacts.json'
            ),
        packagedNpmCliPath: npmCliPaths.npmCliPath,
        packagedNpxCliPath: npmCliPaths.npxCliPath,
        electronExecutablePath: process.execPath,
        selectExecutable: async (kind) => {
          const result = await dialog.showOpenDialog(mainWindow!, {
            title:
              kind === 'python'
                ? '选择 Python 可执行文件'
                : '选择 Node.js 可执行文件',
            properties: ['openFile'],
            filters:
              process.platform === 'win32'
                ? [
                    {
                      name:
                        kind === 'python'
                          ? 'Python 可执行文件'
                          : 'Node.js 可执行文件',
                      extensions: ['exe', 'cmd', 'bat']
                    },
                    { name: '所有文件', extensions: ['*'] }
                  ]
                : [{ name: '所有文件', extensions: ['*'] }]
          })
          return result.canceled ? undefined : result.filePaths[0]
        },
        baseEnvironment: buildCredentialFilteredUserEnvironment()
      })
    // Built in the background (P6): only runtime launches read the launch
    // environment, and each of them awaits this first. A failure still fails
    // startup with the same diagnostic once the prerequisites have settled.
    let localToolEnvironmentFailed = false
    let localToolEnvironmentError: unknown
    const localToolEnvironmentReady = startupSpan(
      'main:local-tool-environment',
      () => startupLocalToolEnvironmentService.initialize()
    ).catch((error: unknown) => {
      localToolEnvironmentFailed = true
      localToolEnvironmentError = error
    })
    localToolEnvironmentService =
      startupLocalToolEnvironmentService
    const sshHostStore = new SshHostStore(
      join(app.getPath('userData'), 'ssh-hosts.json'),
      secureCipher
    )
    const agentMetadataPaths = resolveBundledAgentResourcePaths({
      appPath: app.getAppPath(),
      resourcesPath: process.resourcesPath,
      packaged: app.isPackaged
    })
    const controlPlanePackageInstaller = await startupSpan('main:read-control-plane-installer', () => readFile(
      resolveControlPlanePackageInstallerPath({
        appPath: app.getAppPath()
      })
    ))
    const agentPackageManager = new AgentPackageManager({
      userDataPath: app.getPath('userData'),
      desktopVersion: app.getVersion(),
      keyRegistryPath: agentMetadataPaths.keyRegistryPath,
      getUpdateSource: async () =>
        (await applicationSettingsStore.get()).updateSource
    })
    const startupRemoteAgentServices = new RemoteAgentServices({
      sshHostStore,
      goodBuddyVersion: app.getVersion(),
      userDataPath: app.getPath('userData'),
      appPath: app.getAppPath(),
      resourcesPath: process.resourcesPath,
      packaged: app.isPackaged,
      controlPlanePackageInstaller,
      observeFailure: observeDesktopFailure
    })
    remoteAgentServices = startupRemoteAgentServices
    const startupManagedRemoteExecutionServices =
      new ManagedRemoteExecutionServices({
        sshHostStore,
        agentServices: startupRemoteAgentServices,
        bindingStore: runtimeStorage.bindingStore,
        appPath: app.getAppPath(),
        resourcesPath: process.resourcesPath,
        packaged: app.isPackaged,
        resolveRuntimeSelection: async (layer) => {
          const settings = await settingsStore.getResolvedSettings()
          return resolveConfiguredAgentRuntimeSelection(
            settings,
            resolveLayeredRuntimeSelection(settings, { project: layer }, { remote: true }).selection
          )
        },
        resolveModelProfile: async (selection) => {
          const resolved = applyRuntimeSelection(
            await settingsStore.getResolvedSettings(),
            selection
          ).settings
          return selection.provider === 'continue' ? resolved.continueModelProfile : resolved.opencodeModelProfile
        }
      })
    managedRemoteExecutionServices =
      startupManagedRemoteExecutionServices
    await startupSpan('main:managed-remote-init', () => startupManagedRemoteExecutionServices.initialize())
    const beginRemoteHostInvalidation = (hostId: string): void => {
      const invalidations = [
        startupRemoteAgentServices.invalidateHost(hostId)
      ]
      startupManagedRemoteExecutionServices.invalidateHost(hostId)
      if (selectedRuntimeManager) {
        invalidations.push(
          selectedRuntimeManager.invalidateHost(hostId)
        )
      }
      void Promise.allSettled(invalidations).then((results) => {
        if (results.some((result) => result.status === 'rejected')) {
          console.warn(
            'Failed to invalidate complete remote Host state'
          )
        }
      })
    }
    const sshHostService = new SshHostService(
      sshHostStore,
      new Ssh2Transport(),
      {
        onHostEdited: beginRemoteHostInvalidation,
        onHostRemoved: beginRemoteHostInvalidation
      }
    )
    const sshHostDirectoryBrowser = new SshHostDirectoryBrowser({
      sshHosts: sshHostStore,
      sshPool: startupRemoteAgentServices.sshPool
    })
    const sshHostRemoteEnvironmentInspector =
      new SshHostRemoteEnvironmentInspector({
        sshHosts: sshHostStore,
        sshPool: startupRemoteAgentServices.sshPool,
        agentRuntimeLockPath:
          startupRemoteAgentServices.resourcePaths.runtimeLockPath,
        remoteRuntimeLockPath:
          startupManagedRemoteExecutionServices.runtimeResourcePaths
            .runtimeLockPath,
        loadRemoteEnvironmentCatalog: (architecture, options) =>
          agentPackageManager.getRemoteEnvironmentCatalog(
            architecture,
            options
          )
      })
    const [initialRuntimeSettings, initialResolvedSettings] =
      await startupSpan('main:runtime-settings-load', () => Promise.all([
        settingsStore.getPublicSettings(),
        settingsStore.getResolvedSettings()
      ]))
    globalTlsPolicy = new GlobalTlsPolicy(app)
    globalTlsPolicy.install()
    const capabilityService = new CapabilityService(
      join(app.getPath('userData'), 'capabilities.json'),
      app.isPackaged
        ? join(process.resourcesPath, 'skills')
        : join(app.getAppPath(), 'resources', 'skills'),
      join(app.getPath('userData'), 'skills', 'imported'),
      secureCipher,
      { getSavedModelProfiles: () => settingsStore.getSavedModelProfiles() }
    )
    const channelSettingsStore = new ChannelSettingsStore(
      join(app.getPath('userData'), 'channel-settings.json'),
      secureCipher
    )
    const startupFeedbackService = new FeedbackService({
      appVersion: app.getVersion(),
      platform: process.platform,
      architecture: process.arch,
      identityStore: new FeedbackIdentityStore(
        join(app.getPath('userData'), 'feedback-identity.json')
      ),
      client: new StrictFeedbackHttpClient({
        appVersion: app.getVersion(),
        dispatcher: createStrictFeedbackDispatcher()
      }),
      diagnosticsProvider: desktopDiagnostics
    })
    feedbackService = startupFeedbackService
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
        join(app.getPath('userData'), 'document-parsing-settings.json'),
        secureCipher
      )
    documentOcrModelManager = new DocumentOcrModelManager({
      userDataDirectory: app.getPath('userData'),
      fetch: globalThis.fetch,
      getDownloadSource: async () =>
        (await applicationSettingsStore.get()).modelDownloadSource
    })
    documentOcrBroker = new DocumentOcrBroker(mainWindow)
    configureDocumentParseWorker(join(app.getAppPath(), 'out/main/document-parse-worker.js'))
    documentParsingService = new DocumentParsingService(
      documentParsingSettingsStore,
      documentOcrModelManager,
      documentOcrBroker,
      storageFiles.results
    )
    localInferenceService.register('ocr', {
      snapshot: async () => {
        const snapshot = await documentParsingService!.snapshot()
        const model = snapshot.status.localOcr
        return {
          id: 'ocr', name: '文字识别', engine: 'PaddleOCR / ONNX Web', ownership: 'renderer-worker',
          resources: { scope: 'unavailable', reason: 'Web Worker 与界面共享渲染进程，无法独立统计 CPU / 内存' },
          state: model.available ? 'unknown' : 'unavailable', model: model.id,
          detail: `${model.detail}。模型由 Renderer Worker 持有，文档解析按需加载，空闲 60 秒自动释放；仅允许无活动任务时手动释放。`,
          actions: []
        }
      }
    })
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
    localInferenceService.register('asr', {
      snapshot: async () => {
        const model = await speechModelManager.getSelectedRuntimeModel()
        return {
          id: 'asr', name: '语音识别', engine: 'sherpa-onnx', ownership: 'request-worker',
          resources: { scope: 'unavailable', reason: '识别线程与主进程共享资源，无法独立统计 CPU / 内存' },
          state: model ? 'unknown' : 'unavailable', model: model?.id,
          detail: model ? '每个识别请求独立加载模型，完成后释放；支持取消单次识别，没有常驻服务可启停。' : '请在设置中安装并选择本地语音模型。',
          actions: []
        }
      }
    })
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
        launchEnvironmentProvider:
          startupLocalToolEnvironmentService.launchEnvironmentProvider,
        fork: forkDeepSeekHarness,
        terminateProcess: terminateHarnessUtilityProcess,
        onExtensionStartupFailures: (extensionIds) =>
          runtimeExtensionStore.markStartupFailed(extensionIds)
      })
    const startupKnowledgeService = new KnowledgeService({
      documentResults: storageFiles.results,
      credentialCipher: secureCipher,
      database: createKnowledgeStoragePort(storage),
      managedRoot: join(app.getPath('userData'), 'knowledge'),
      extractStructured: createModelGraphExtractor(
        settingsStore,
        fetch,
        undefined,
        (usage) =>
          recordKnowledgeUsage('graph-extraction', {
            runtime: 'model',
            ...usage
          })
      ),
      parseDocument: documentParsingService.parse
    })
    knowledgeService = startupKnowledgeService
    let activeEmbeddingProvider:
      | Awaited<ReturnType<typeof createEmbeddingProvider>>
      | undefined
    let activeRerankProvider:
      | ReturnType<typeof createRerankProvider>
      | undefined
    imageGenerationService = new ImageGenerationService({
      database: startupAssistantDatabase,
      getSettings: () => settingsStore.getResolvedSettings(),
      onError: (error) => {
        void desktopDiagnostics.recordFailure({ component: 'desktop', stage: 'image-generation', code: 'image-generation.observer.failed', error }).catch(() => undefined)
      },
      onOperation: (operation) => {
        if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed()) {
          mainWindow.webContents.send(ipcChannels.imageOperationChanged, operation)
        }
      },
      onUsage: (event) => startupAssistantDatabase.upsertModelUsageCall({
        requestId: event.requestId, callId: event.callId, runtime: event.runtime,
        provider: event.provider, model: event.model, input: event.inputTokens,
        output: event.outputTokens, cacheRead: event.cacheReadTokens, cacheWrite: event.cacheWriteTokens
      })
    })
    directModelSubagentScheduler = new SubagentScheduler({
      concurrency: 3,
      queueLimit: 20,
      timeoutMs: 10 * 60_000
    })
    const executionSpaceResolver = new ExecutionSpaceResolver(
      startupManagedRemoteExecutionServices.workspaceAccessFactory
    )
    const goodbuddyConfigService = new GoodBuddyConfigService(
      applicationSettingsStore,
      capabilityService
    )
    const obsidianService = new ObsidianService({
      appPath: app.getAppPath(),
      launchEnvironmentProvider:
        startupLocalToolEnvironmentService.launchEnvironmentProvider,
      launchEnvironmentReady: () => localToolEnvironmentReady
    })
    const startupKnowledgeGateway = new KnowledgeMcpGateway(
      startupKnowledgeService,
      {
        observeFailure: observeDesktopFailure,
        storyGraphService: {
          available: async ({ runtimeTarget, conversationId }) => (await applicationSettingsStore.get()).heartbeatEnabled === true &&
            (!conversationId || await startupAssistantDatabase.isConversationStoryGraphEnabled(conversationId)) &&
            (await capabilityService.getEnabledBuiltinMcpServerIds(runtimeTarget)).includes('story-graph'),
          read: (name, input, projectId, signal) => storage.call('assistant', 'readStoryGraph', [name, input, projectId], { signal })
        },
        magicNotesDatabase: startupAssistantDatabase,
        configService: goodbuddyConfigService,
        obsidianService,
        browserService,
        launchEnvironmentProvider:
          startupLocalToolEnvironmentService.launchEnvironmentProvider,
        launchEnvironmentReady: () => localToolEnvironmentReady
      }
    )
    knowledgeGateway = startupKnowledgeGateway
    const createRuntimeWithCapabilities = async (
      settings: ResolvedRuntimeSettings,
      target: SelectedRuntimeTarget,
      executionSpace?: ExecutionSpaceDescriptor
    ): Promise<AgentRuntime> => {
      await localToolEnvironmentReady
      if (localToolEnvironmentFailed) throw localToolEnvironmentError
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
            ? capabilityService
                .getEnabledBuiltinMcpServerIds(target)
                .then((enabledServers) =>
                  enabledServers.includes('builtin-browser')
                    ? capabilityService.getComputerCapabilityStatus(
                        'host-browser-control'
                      )
                    : undefined
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
        outputStore: { backingStore: storageFiles.backingStore },
        outputAdopt: storageFiles.attachments.outputAdopt,
        observeFailure: observeDesktopFailure,
        localRuntimeRegistry,
        skillInstructions: skillContext.instructions,
        skillPackages: skillContext.packages,
        mcpServers,
        continueHostCacheRoot: runtimeLaunchRoot,
        opencodeSharedCacheRoot: runtimeLaunchRoot,
        bundledRuntimePaths,
        continueHostLauncher: launchContinueHost,
        deepseekHarnessLauncher: launchDeepSeekHarness,
        deepseekHarnessExtensions,
        browserService:
          browserCapability?.enabled && browserCapability.supported
            ? browserService
            : undefined,
        knowledgeGateway: startupKnowledgeGateway,
        webSearchEnabled: webSearchCapability?.enabled,
        executionSpace,
        workspaceAccess: executionSpace?.workspaceAccess,
        directModelSubagentScheduler,
        launchEnvironmentProvider:
          startupLocalToolEnvironmentService.launchEnvironmentProvider
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
      executionSpace?: ExecutionSpaceDescriptor
    ): Promise<AgentRuntime> => {
      const resolved = applyRuntimeSelection(
        await settingsStore.getResolvedSettings(),
        selection
      )
      if (executionSpace?.kind === 'ssh') {
        const profile = selection.provider === 'continue' ? resolved.settings.continueModelProfile : resolved.settings.opencodeModelProfile
        if (profile === undefined) {
          throw new Error(
            '托管远程 Runtime 需要选择一个可用的文本模型配置'
          )
        }
        return await startupManagedRemoteExecutionServices.createRuntime({
          executionSpace,
          selection,
          modelProfile: profile,
          usage: {
            provider: profile.protocol,
            model: profile.modelName
          }
        })
      }
      return createRuntimeWithCapabilities(
        executionSpace?.kind === 'local'
          ? {
              ...resolved.settings,
              workspacePath: executionSpace.rootPath
            }
          : resolved.settings,
        resolved.target,
        executionSpace
      )
    }
    const createSelectedStatusRuntime = async (
      selection: AgentRuntimeSelection
    ): Promise<AgentRuntime> => {
      const resolved = applyRuntimeSelection(
        await settingsStore.getResolvedSettings(),
        selection
      )
      return resolved.target === 'opencode'
        ? createAgentRuntime(defaultWorkspace, resolved.settings, {
            bundledRuntimePaths,
            continueHostCacheRoot: runtimeLaunchRoot,
            opencodeSharedCacheRoot: runtimeLaunchRoot
          })
        : createRuntimeWithCapabilities(
            resolved.settings,
            resolved.target
          )
    }
    startupMark('main:services-constructed')
    await startupSpan('main:prerequisites', () => runStartupPrerequisites({
      prepareDeepSeekHome: async () => {
        await mkdir(deepSeekHarnessHome, {
          recursive: true,
          mode: 0o700
        })
      },
      initializeKnowledgeAndGateway: async () => {
        await startupSpan('main:knowledge-init', () => startupKnowledgeService.initialize())
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
        await startupSpan('main:knowledge-gateway-start', () => startupKnowledgeGateway.start())
      },
      hydrateConfiguredRuntime: async () => {
        const configured = await startupSpan('main:runtime-hydrate', () => createConfiguredRuntime(initialResolvedSettings))
        // Retain ownership even if another prerequisite fails after hydration.
        runtime = new AgentRuntimeController(configured, undefined, observeDesktopFailure)
        return configured
      },
      initializeAssistant: async () => {
        startupMark('main:assistant-db-init:start')
        await imageGenerationService!.initialize()
        await startupAssistantDatabase.ensureChannelProjects(
          defaultWorkspace,
          initialRuntimeSettings.defaultModelProfileId
        )
        channelSettingsStore.reportRuntimeSelectionRepairs(
          await startupAssistantDatabase.repairConversationRuntimeSelections(
            initialRuntimeSettings
          )
        )
        startupMark('main:assistant-db-init:end')
      }
    })).catch(async (error: unknown) => {
      await localToolEnvironmentReady
      throw localToolEnvironmentFailed ? localToolEnvironmentError : error
    })
    // Runtime hydration awaited the environment, so it has settled here. Keep
    // the previous failure behaviour: an environment error fails startup.
    await localToolEnvironmentReady
    if (localToolEnvironmentFailed) throw localToolEnvironmentError
    const subagentService = new SubagentService(
      async input => createSubagentRuntime(input, await settingsStore.getResolvedSettings(),
        (settings, space) => createRuntimeWithCapabilities(settings, 'model', space), createSelectedRuntime),
      startupAssistantDatabase
    )
    startupSubagentService = subagentService
    if (storageUpgradeController.signal.aborted) return
    selectedRuntimeManager = new SelectedRuntimeManager(
      createSelectedRuntime,
      undefined,
      undefined,
      observeDesktopFailure,
      createSelectedStatusRuntime,
      (conversationId) => localRuntimeRegistry.releaseConversation(conversationId)
    )
    const contextManager = new ContextManager({
      parseDocument: documentParsingService.parse,
      assets: storageFiles.attachments,
      validateConversation: async (id) => {
        if (!await startupAssistantDatabase.hasAttachmentOwner(id, 'draft', id)) throw new Error('目标会话已删除')
      }
    })
    startupContextManager = contextManager

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
    await startupSpan('main:shortcuts-init', () => shortcutSettingsService.initialize())

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
        try {
          if (runtime) {
            nextRuntime = await createConfiguredRuntime(settings)
          }
        } catch (error) {
          await Promise.allSettled([
            nextRuntime?.dispose()
          ])
          throw error
        }

        let runtimeConsumed = false
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
          await subagentService.cancelAll('默认模型设置已更改')
          await selectedRuntimeManager?.reset()
          localRuntimeRegistry.reset(nextRuntime)
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
            runtimeConsumed ? undefined : nextRuntime?.dispose()
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
      const selection =
        await settingsStore.setActiveEmbeddingConnection(connectionId)
      if (!selection.changed) {
        return
      }
      try {
        await reconfigureRuntimes()
      } catch (activationError) {
        try {
          await selection.restore()
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

    const remoteProjectSaveService =
      startupManagedRemoteExecutionServices.createProjectSaveService({
        database: startupAssistantDatabase,
        notify: sendRemoteProjectSaveProgress
      })
    const remoteEnvironmentPreparer =
      new RemoteEnvironmentPreparer({
        resolver: startupRemoteAgentServices.targetResolver,
        sshPool: startupRemoteAgentServices.sshPool,
        agentPackageManager,
        operationStore:
          new RemoteEnvironmentOperationStore(
            app.getPath('userData')
          )
      })
    const remoteEnvironmentUpdateService =
      new RemoteEnvironmentUpdateService(
        remoteEnvironmentPreparer,
        async (hostId) => {
          startupManagedRemoteExecutionServices.invalidateHost(hostId)
          const invalidations = [
            startupRemoteAgentServices.invalidateHost(hostId)
          ]
          if (selectedRuntimeManager) {
            invalidations.push(
              selectedRuntimeManager.invalidateHost(hostId)
            )
          }
          await Promise.all(invalidations)
        }
      )
    terminalSessionManager = new TerminalSessionManager({
      database: startupAssistantDatabase,
      executionSpaceResolver,
      targetResolver: startupRemoteAgentServices.targetResolver,
      sshPool: startupRemoteAgentServices.sshPool,
      remoteEnabled: async () =>
        (await applicationSettingsStore.get()).remoteProjectsEnabled,
      deliverEvent: (ownerWebContentsId, event) => {
        const targetWindow = mainWindow
        if (
          targetWindow &&
          !targetWindow.isDestroyed() &&
          targetWindow.webContents.id === ownerWebContentsId &&
          !targetWindow.webContents.isDestroyed()
        ) {
          targetWindow.webContents.send(ipcChannels.terminalEvent, event)
        }
      }
    })
    nativeClientCoordinator = new NativeClientCoordinator({
      openModelCallLedger: runtimeStorage.openModelCallLedger,
      database: startupAssistantDatabase, settingsStore, applicationSettingsStore,
      capabilities: capabilityService, executionSpaceResolver, terminalManager: terminalSessionManager,
      localEnvironment: startupLocalToolEnvironmentService, bundledRuntimePaths,
      rootDirectory: join(app.getPath('userData'), 'native-clients'),
      temporaryRoot: runtimeLaunchRoot,
      managedNodeDirectory: join(toolEnvironmentRoot, 'native-node-22.22.0'),
      npmCliPath: npmCliPaths.npmCliPath,
      resourcesPath: app.isPackaged ? process.resourcesPath : undefined,
      openExternal: (url) => shell.openExternal(url),
      createGateway: () => new KnowledgeMcpGateway(startupKnowledgeService, {
        observeFailure: observeDesktopFailure,
        storyGraphService: {
          available: async ({ runtimeTarget, conversationId }) => (await applicationSettingsStore.get()).heartbeatEnabled === true &&
            (!conversationId || await startupAssistantDatabase.isConversationStoryGraphEnabled(conversationId)) &&
            (await capabilityService.getEnabledBuiltinMcpServerIds(runtimeTarget)).includes('story-graph'),
          read: (name, input, projectId, signal) => storage.call('assistant', 'readStoryGraph', [name, input, projectId], { signal })
        },
        magicNotesDatabase: startupAssistantDatabase, configService: goodbuddyConfigService,
        obsidianService, launchEnvironmentProvider: startupLocalToolEnvironmentService.launchEnvironmentProvider,
        launchEnvironmentReady: () => localToolEnvironmentReady
      })
    })
    startupMark('main:ipc-register:start')
    removeIpcHandlers = await registerIpcHandlers(
      mainWindow,
      runtime!,
      legacyDefaultShortcut,
      settingsStore,
      capabilityService,
      contextManager,
      knowledgeService,
      startupAssistantDatabase,
      bundledRuntimePaths,
      reconfigureRuntimes,
      async () => {
        await Promise.all([
          browserService?.clearSessions(),
          startupFeedbackService.clear()
        ])
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
      sshHostService,
      executionSpaceResolver,
      remoteProjectSaveService,
      sshHostDirectoryBrowser,
      sshHostRemoteEnvironmentInspector,
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
      setCurrentEmbeddingConnection,
      remoteEnvironmentUpdateService,
      agentPackageManager,
      startupRemoteAgentServices.connectionManager,
      terminalSessionManager,
      startupLocalToolEnvironmentService,
      imageGenerationService,
      obsidianService,
      nativeClientCoordinator,
      supervisionPorts
    )
    if (storageUpgradeController.signal.aborted) return
    removeFeedbackIpcHandler = registerFeedbackIpcHandler(
      mainWindow,
      startupFeedbackService
    )
    startupMark('main:ipc-register:end')
    loadMainWindow(mainWindow)
    startupMark('main:load-main-window')
    removeDeviceSharingIpc = registerDeviceSharingIpc(mainWindow,
      new DeviceSharingService(join(app.getPath('userData'), 'device-sharing-settings.json'), app.getVersion()))
    // Reclaim confirmed inactive runs, including their shared immutable caches.
    runtimeTemporaryCleanupTimer = setTimeout(() => {
      runtimeTemporaryCleanupTimer = undefined
      if (runtimeTemporaryCleanupController.signal.aborted) return
      runtimeTemporaryCleanup = cleanupRuntimeTemporaryDirectories({
        userDataPath: app.getPath('userData'),
        signal: runtimeTemporaryCleanupController.signal
      }).catch(error => {
        observeDesktopFailure({
          component: 'desktop', stage: 'runtime-cleanup', code: 'desktop.runtime-cleanup.failed', error
        })
      })
    }, 30_000).unref()
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
    if (storageUpgradeController.signal.aborted) return
    void desktopDiagnostics.recordFailure({
      component: 'desktop',
      stage: 'startup',
      code: 'desktop.startup.failed',
      error
    }).catch(() => undefined)
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
  storageUpgradeController.abort()
  runtimeTemporaryCleanupController.abort()
  clearTimeout(runtimeTemporaryCleanupTimer)
  if (cleanupComplete) {
    return
  }
  event.preventDefault()
  if (cleanupStarted) {
    return
  }
  cleanupStarted = true
  void (async () => {
    let cleanupFailed = false
    try {
      const cleanup = settleCleanupPhases([
        [() => applicationStartup],
        [
          () => runtimeTemporaryCleanup,
          () => feedbackService?.dispose(),
          () => removeFeedbackIpcHandler?.(),
          () => removeDeviceSharingIpc?.(),
          () => dshExtensionInstaller?.dispose(),
          () => knowledgeService?.beginShutdown(),
          () => removeIpcHandlers?.()
        ],
        [() => stopRuntimeReconfiguration?.()],
        [
          () => startupSubagentService?.dispose(),
          () => imageGenerationService?.dispose(),
          () => nativeClientCoordinator?.dispose(),
          () => startupContextManager?.dispose()
        ],
        [
          () => runtime?.detachForApplicationExit(),
          () => selectedRuntimeManager?.detachForApplicationExit()
        ],
        [
          () => runtime?.dispose(),
          () => selectedRuntimeManager?.dispose(),
          () => {
            directModelSubagentScheduler?.dispose()
            return directModelSubagentScheduler?.waitForIdle()
          }
        ],
        [() => localRuntimeRegistry.dispose()],
        [() => terminalSessionManager?.dispose()],
        [() => knowledgeGateway?.dispose()],
        [() => knowledgeService?.dispose()],
        [async () => {
          await Promise.allSettled(knowledgeUsageWrites)
          if (knowledgeUsageFailure) throw knowledgeUsageFailure
        }],
        [() => documentParsingService?.dispose()],
        [
          () => browserService?.dispose(),
          () => globalTlsPolicy?.dispose(),
          async () => {
            const results = await Promise.allSettled(
              [...embeddingBrokers].map((broker) => broker.shutdown())
            )
            const failures = results.flatMap(result => result.status === 'rejected' ? [result.reason] : [])
            if (failures.length) throw new AggregateError(failures, 'Embedding brokers failed to shut down')
          },
          () => embeddingModelManager?.dispose(),
          () => documentOcrModelManager?.dispose(),
          () => documentOcrBroker?.dispose()
        ],
        [() => localToolEnvironmentService?.dispose()],
        [() => managedRemoteExecutionServices?.dispose()],
        [() => remoteAgentServices?.dispose()],
        [() => desktopStorage?.close()],
        [() => desktopDiagnostics.dispose()]
      ].map((phase, phaseIndex) => phase.map(operation => async () => {
        try {
          await operation()
        } catch (error) {
          cleanupFailed = true
          console.error(`Desktop shutdown phase ${phaseIndex} failed`, error)
          await desktopDiagnostics.recordFailure({
            component: 'desktop', stage: 'shutdown', code: 'desktop.shutdown.drain-failed', error
          }).catch(() => undefined)
        }
      })))
      globalShortcut.unregisterAll()
      tray?.destroy()
      const completed = await runCleanupBeforeDeadline(cleanup, 8_000, () => undefined)
      if (!completed) {
        cleanupFailed = true
        console.error('Desktop shutdown deadline expired before storage drain was confirmed')
      }
    } finally {
      cleanupComplete = true
      app.exit(cleanupFailed ? 1 : 0)
    }
  })()
})

app.on('will-quit', () => {
  cleanupComplete = true
})

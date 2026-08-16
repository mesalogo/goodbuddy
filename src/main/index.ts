import {
  app,
  BrowserWindow,
  dialog,
  globalShortcut,
  Menu,
  safeStorage,
  session,
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
import type {
  ContinueHostChild,
  ContinueHostLauncher
} from './agent/continue-host-adapter'
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
import { runStartupPrerequisites } from './startup-prerequisites'
import { RuntimeExtensionStore } from './agent/runtime-extension-store'
import {
  DshNpmExtensionInstaller,
  DshNpmMarketplaceCatalog
} from './agent/dsh-extension-marketplace'

const shortcut = 'CommandOrControl+Shift+Space'
const mainModuleDirectory = dirname(fileURLToPath(import.meta.url))
const portableUserDataPath = resolvePortableUserDataPath({
  packaged: app.isPackaged,
  platform: process.platform,
  executablePath: process.execPath
})
if (portableUserDataPath) {
  app.setPath('userData', portableUserDataPath)
}
if (process.platform === 'win32') {
  app.setAppUserModelId('live.digiman.goodbuddy')
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
let stopRuntimeReconfiguration: (() => Promise<void>) | undefined

function createEmbeddingProvider(
  settings: ResolvedRuntimeSettings
): OpenAIEmbeddingClient | undefined {
  return settings.knowledgeEmbeddingEnabled
    ? new OpenAIEmbeddingClient({
        endpoint: settings.knowledgeEmbeddingBaseUrl,
        model: settings.knowledgeEmbeddingModel,
        apiKey: settings.knowledgeEmbeddingApiKey
      })
    : undefined
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
  let exitCode: number | null = null
  let killed = false
  utilityChild.on('exit', (code) => {
    exitCode = code
  })

  const child: ContinueHostChild = {
    get exitCode() {
      return exitCode
    },
    get killed() {
      return killed
    },
    get pid() {
      return utilityChild.pid
    },
    stderr: utilityChild.stderr,
    once: (_event, listener) => {
      utilityChild.once('error', (_type, location, report) => {
        listener(
          new Error(
            `Continue 宿主进程异常（${location}）：${report.slice(0, 500)}`
          )
        )
      })
      return child
    },
    kill: () => {
      killed = true
      return utilityChild.kill()
    }
  }
  return child
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
  if (process.platform === 'win32' && child.pid) {
    const killer = spawn(
      'taskkill.exe',
      ['/PID', String(child.pid), '/T', '/F'],
      {
        shell: false,
        stdio: 'ignore',
        windowsHide: true
      }
    )
    killer.unref()
    return
  }
  child.kill()
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
      fetch: globalThis.fetch
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
      fetch: globalThis.fetch
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
    const dshExtensionInstaller = new DshNpmExtensionInstaller({
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
    const runtimeExtensionStore = new RuntimeExtensionStore(
      app.getPath('userData'),
      {
        catalog: new DshNpmMarketplaceCatalog(),
        install: (input) => dshExtensionInstaller.install(input)
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
    const startupAssistantDatabase = new AssistantDatabase(
      join(app.getPath('userData'), 'assistant.sqlite')
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
        await Promise.all([
          startupKnowledgeService.setEmbeddingProvider(
            createEmbeddingProvider(initialResolvedSettings)
          ).catch(() => undefined),
          startupKnowledgeService.setRerankProvider(
            createRerankProvider(initialResolvedSettings)
          ).catch(() => undefined)
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

    const shortcutRegistered = globalShortcut.register(shortcut, () => {
      if (mainWindow) {
        toggleWindow(mainWindow)
      }
    })

    let runtimeReconfigurationQueue: Promise<void> = Promise.resolve()
    let runtimeReconfigurationClosing = false
    const reconfigureRuntimes = (): Promise<void> => {
      const operation = runtimeReconfigurationQueue.then(async () => {
        if (runtimeReconfigurationClosing) {
          throw new Error('Runtime 配置正在关闭')
        }
        const settings = await settingsStore.getResolvedSettings()
        if (knowledgeService) {
          await knowledgeService.setEmbeddingProvider(
            createEmbeddingProvider(settings)
          )
          await knowledgeService.setRerankProvider(
            createRerankProvider(settings)
          )
        }
        if (runtime) {
          await runtime.replace(
            await createConfiguredRuntime(settings)
          )
        }
        await selectedRuntimeManager?.reset()
        await subagentService.replaceRuntimes(
          createDefaultModelRuntime(defaultWorkspace, settings),
          createSubagentProfileRuntimes(defaultWorkspace, settings)
        )
      })
      runtimeReconfigurationQueue = operation.catch(() => undefined)
      return operation
    }
    stopRuntimeReconfiguration = async () => {
      runtimeReconfigurationClosing = true
      await runtimeReconfigurationQueue
    }

    removeIpcHandlers = registerIpcHandlers(
      mainWindow,
      runtime,
      shortcutRegistered ? shortcut : '未注册',
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
      runtimeExtensionStore
    )
    loadMainWindow(mainWindow)

    app.on('activate', () => {
      if (mainWindow) {
        showWindow(mainWindow)
      }
    })
  }).catch(() => {
    dialog.showErrorBox(
      'GoodBuddy 启动失败',
      '本地数据或 Runtime 服务初始化失败。请重启应用；若问题持续，请备份后清理应用数据。'
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
        [() => removeIpcHandlers?.()],
        [() => stopRuntimeReconfiguration?.()],
        [
          () => runtime?.dispose(),
          () => selectedRuntimeManager?.dispose(),
          () => browserService?.dispose(),
          () => globalTlsPolicy?.dispose(),
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

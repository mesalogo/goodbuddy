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
import { dirname, join } from 'node:path'
import { ipcChannels } from '../shared/ipc-channels'
import {
  createAgentRuntime,
  createDefaultModelRuntime
} from './agent/create-runtime'
import { AgentRuntimeController } from './agent/runtime-controller'
import { CapabilityService } from './capabilities/capability-service'
import { ContextManager } from './context-manager'
import { registerIpcHandlers } from './ipc'
import { KnowledgeService } from './knowledge/knowledge-service'
import { AssistantDatabase } from './assistant/assistant-database'
import { createModelGraphExtractor } from './knowledge/model-extractor'
import { OpenAIEmbeddingClient } from './knowledge/openai-embedding-client'
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

const shortcut = 'CommandOrControl+Shift+Space'
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
let knowledgeService: KnowledgeService | undefined
let assistantDatabase: AssistantDatabase | undefined
let browserService: BrowserService | undefined

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
    const capabilityService = new CapabilityService(
      join(app.getPath('userData'), 'capabilities.json'),
      app.isPackaged
        ? join(process.resourcesPath, 'skills')
        : join(app.getAppPath(), 'resources', 'skills'),
      join(app.getPath('userData'), 'skills', 'imported'),
      secureCipher
    )
    browserService = new BrowserService()
    const bundledRuntimePaths = resolveBundledRuntimePaths({
      appPath: app.getAppPath(),
      resourcesPath: process.resourcesPath,
      packaged: app.isPackaged
    })
    knowledgeService = new KnowledgeService({
      databasePath: join(app.getPath('userData'), 'knowledge.sqlite'),
      managedRoot: join(app.getPath('userData'), 'knowledge'),
      extractStructured: createModelGraphExtractor(settingsStore)
    })
    await knowledgeService.initialize()
    void knowledgeService
      .setEmbeddingProvider(
        createEmbeddingProvider(await settingsStore.getResolvedSettings())
      )
      .catch(() => undefined)
    assistantDatabase = new AssistantDatabase(
      join(app.getPath('userData'), 'assistant.sqlite')
    )
    assistantDatabase.initialize(defaultWorkspace)
    const subagentService = new SubagentService(
      createDefaultModelRuntime(
        defaultWorkspace,
        await settingsStore.getResolvedSettings()
      ),
      assistantDatabase
    )
    const createConfiguredRuntime = async () => {
      const settings = await settingsStore.getResolvedSettings()
      const useOpenCode =
        settings.provider === 'opencode' ||
        (settings.provider === 'auto' &&
          Boolean(
            settings.opencodeBaseUrl || settings.opencodeEmbedded
          ))
      const target =
        settings.provider === 'continue'
          ? ('continue' as const)
          : useOpenCode
            ? ('opencode' as const)
            : ('model' as const)
      const [skillInstructions, mcpServers, browserCapability] =
        await Promise.all([
          capabilityService.getSkillInstructions(
            target,
            target === 'continue' ? 12_000 : 48_000
          ),
          target === 'model'
            ? capabilityService.getResolvedMcpServers('model')
            : Promise.resolve([]),
          target === 'model'
            ? capabilityService.getComputerCapabilityStatus(
                'host-browser-control'
              )
            : Promise.resolve(undefined)
        ])
      return createAgentRuntime(defaultWorkspace, settings, {
        skillInstructions,
        mcpServers,
        continueHostCacheRoot: join(
          app.getPath('userData'),
          'continue-host'
        ),
        bundledRuntimePaths,
        continueHostLauncher: launchContinueHost,
        browserService:
          browserCapability?.enabled && browserCapability.supported
            ? browserService
            : undefined
      })
    }
    runtime = new AgentRuntimeController(
      await createConfiguredRuntime()
    )
    const contextManager = new ContextManager()
    const approvalBroker = new ToolApprovalBroker()

    const shortcutRegistered = globalShortcut.register(shortcut, () => {
      if (mainWindow) {
        toggleWindow(mainWindow)
      }
    })

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
      async () => {
        const settings = await settingsStore.getResolvedSettings()
        if (knowledgeService) {
          void knowledgeService
            .setEmbeddingProvider(createEmbeddingProvider(settings))
            .catch(() => undefined)
        }
        if (runtime) {
          await runtime.replace(
            await createConfiguredRuntime()
          )
        }
        await subagentService.replaceRuntime(
          createDefaultModelRuntime(defaultWorkspace, settings)
        )
      },
      async () => {
        await browserService?.clearSessions()
      },
      browserService,
      subagentService
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
      await Promise.allSettled([removeIpcHandlers?.()])
      globalShortcut.unregisterAll()
      tray?.destroy()
      await Promise.allSettled([
        runtime?.dispose(),
        knowledgeService?.dispose(),
        browserService?.dispose()
      ])
    } finally {
      assistantDatabase?.close()
      cleanupComplete = true
      app.quit()
    }
  })()
})

app.on('will-quit', () => {
  cleanupComplete = true
})

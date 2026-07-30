import {
  app,
  BrowserWindow,
  globalShortcut,
  Menu,
  nativeImage,
  safeStorage,
  session,
  Tray
} from 'electron'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createAgentRuntime } from './agent/create-runtime'
import { AgentRuntimeController } from './agent/runtime-controller'
import { ContextManager } from './context-manager'
import { registerIpcHandlers } from './ipc'
import { RuntimeSettingsStore } from './runtime-settings-store'
import { ToolApprovalBroker } from './tool-approval-broker'
import {
  createMainWindow,
  loadMainWindow,
  showWindow,
  toggleWindow
} from './window'

const shortcut = 'CommandOrControl+Shift+Space'
const hasSingleInstanceLock = app.requestSingleInstanceLock()

if (!hasSingleInstanceLock) {
  app.quit()
}

let mainWindow: BrowserWindow | undefined
let tray: Tray | undefined
let isQuitting = false
let removeIpcHandlers: (() => void) | undefined
let runtime: AgentRuntimeController | undefined

function createTrayIcon(): Electron.NativeImage {
  const svg = [
    '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32">',
    '<rect width="32" height="32" rx="10" fill="#18392b"/>',
    '<path d="M9 10.5h14v9a5 5 0 0 1-5 5h-4a5 5 0 0 1-5-5z" fill="#f3bb60"/>',
    '<circle cx="13" cy="16" r="1.5" fill="#18392b"/>',
    '<circle cx="19" cy="16" r="1.5" fill="#18392b"/>',
    '<path d="M13 20h6" stroke="#18392b" stroke-width="1.8" stroke-linecap="round"/>',
    '</svg>'
  ].join('')
  const dataUrl = `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`
  return nativeImage.createFromDataURL(dataUrl)
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
            mainWindow.webContents.send('conversation:new')
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
    app.setAppUserModelId('live.digiman.goodbuddy')

    session.defaultSession.setPermissionRequestHandler(
      (_webContents, _permission, callback) => callback(false)
    )
    session.defaultSession.setPermissionCheckHandler(() => false)

    mainWindow = createMainWindow(() => isQuitting)
    tray = buildTray()
    const defaultWorkspace = process.env.GOODBUDDY_WORKSPACE ?? homedir()
    const settingsStore = new RuntimeSettingsStore(
      join(app.getPath('userData'), 'runtime-settings.json'),
      {
        isAvailable: () =>
          safeStorage.isEncryptionAvailable() &&
          (process.platform !== 'linux' ||
            [
              'gnome_libsecret',
              'kwallet',
              'kwallet5',
              'kwallet6'
            ].includes(safeStorage.getSelectedStorageBackend())),
        encrypt: (value) => safeStorage.encryptString(value),
        decrypt: (value) => safeStorage.decryptString(value)
      }
    )
    runtime = new AgentRuntimeController(
      createAgentRuntime(
        defaultWorkspace,
        await settingsStore.getResolvedSettings()
      )
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
      contextManager,
      approvalBroker,
      defaultWorkspace,
      async () => {
        if (runtime) {
          await runtime.replace(
            createAgentRuntime(
              defaultWorkspace,
              await settingsStore.getResolvedSettings()
            )
          )
        }
      }
    )
    loadMainWindow(mainWindow)

    app.on('activate', () => {
      if (mainWindow) {
        showWindow(mainWindow)
      }
    })
  })
}

app.on('before-quit', () => {
  isQuitting = true
})

app.on('will-quit', () => {
  removeIpcHandlers?.()
  globalShortcut.unregisterAll()
  tray?.destroy()
  void runtime?.dispose()
})

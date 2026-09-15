import { app, BrowserWindow, dialog, nativeImage, shell } from 'electron'
import { dirname, join, posix, win32 } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { DesktopDiagnosticFailureObserver } from './desktop-diagnostics'

const currentDirectory = dirname(fileURLToPath(import.meta.url))

type WindowIconEnvironment = {
  platform: NodeJS.Platform
  isPackaged: boolean
  appPath: string
  resourcesPath: string
}

export function resolveWindowIcon(
  environment: WindowIconEnvironment = {
    platform: process.platform,
    isPackaged: app.isPackaged,
    appPath: app.getAppPath(),
    resourcesPath: process.resourcesPath
  }
): string | undefined {
  if (environment.platform === 'darwin') {
    return undefined
  }
  const fileName =
    environment.platform === 'win32'
      ? environment.isPackaged
        ? 'icon.ico'
        : 'icon-taskbar.ico'
      : 'icon.png'
  const joinPath =
    environment.platform === 'win32' ? win32.join : posix.join
  return environment.isPackaged
    ? joinPath(environment.resourcesPath, fileName)
    : joinPath(environment.appPath, 'build', fileName)
}

function isAllowedExternalUrl(url: string): boolean {
  try {
    return ['http:', 'https:'].includes(new URL(url).protocol)
  } catch {
    return false
  }
}

function hasSameOrigin(url: string, allowedUrl: string): boolean {
  try {
    return new URL(url).origin === new URL(allowedUrl).origin
  } catch {
    return false
  }
}

export function createMainWindow(
  shouldQuit: () => boolean,
  observeFailure?: DesktopDiagnosticFailureObserver
): BrowserWindow {
  const iconPath = resolveWindowIcon()
  const icon = iconPath
    ? nativeImage.createFromPath(iconPath)
    : undefined
  const usableIcon = icon && !icon.isEmpty() ? icon : undefined
  const window = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 680,
    minHeight: 560,
    show: false,
    frame: false,
    ...(usableIcon ? { icon: usableIcon } : {}),
    backgroundColor: '#f4f1ea',
    webPreferences: {
      preload: join(currentDirectory, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })
  if (usableIcon) {
    window.setIcon(usableIcon)
  }

  window.once('ready-to-show', () => {
    window.show()
  })

  window.on('close', (event) => {
    if (!shouldQuit()) {
      event.preventDefault()
      window.hide()
    }
  })

  window.webContents.setWindowOpenHandler(({ url }) => {
    if (isAllowedExternalUrl(url)) {
      void shell.openExternal(url)
    }
    return { action: 'deny' }
  })

  window.webContents.on('will-navigate', (event, url) => {
    const developmentUrl = process.env.ELECTRON_RENDERER_URL
    if (!developmentUrl || !hasSameOrigin(url, developmentUrl)) {
      event.preventDefault()
    }
  })

  let recoveryPending = false
  window.webContents.on('render-process-gone', (_event, details) => {
    if (details.reason === 'clean-exit' || shouldQuit() || window.isDestroyed()) return
    console.error('GoodBuddy renderer exited', details.reason, details.exitCode)
    observeFailure?.({
      component: 'desktop',
      stage: 'renderer',
      code: 'desktop.renderer.gone',
      error: new Error(`Renderer exited: ${details.reason} (${details.exitCode})`)
    })
    if (recoveryPending) return
    recoveryPending = true
    // No automatic retries: a persistent crash requires a fresh user action.
    const en = !app.getLocale().toLowerCase().startsWith('zh')
    void dialog.showMessageBox(window, {
      type: 'error',
      title: 'GoodBuddy',
      message: en ? 'The GoodBuddy window stopped working' : 'GoodBuddy 窗口已停止工作',
      detail: en
        ? 'Reload to try again. Unsaved input may be lost. If this happens again, quit and reopen GoodBuddy.'
        : '请重新加载后重试。尚未保存的输入可能丢失。如果再次出现，请退出并重新打开 GoodBuddy。',
      buttons: en ? ['Reload', 'Cancel'] : ['重新加载', '取消'],
      defaultId: 0,
      cancelId: 1,
      noLink: true
    }).then(({ response }) => {
      if (response === 0 && !shouldQuit() && !window.isDestroyed() && !window.webContents.isDestroyed()) {
        window.webContents.reload()
      }
    }).catch((error: unknown) => {
      console.error('GoodBuddy renderer recovery failed', error)
    }).finally(() => {
      recoveryPending = false
    })
  })

  window.webContents.on('did-fail-load', (_event, code, description, _url, isMainFrame) => {
    if (!isMainFrame || code === -3 || shouldQuit() || window.isDestroyed()) return
    console.error('GoodBuddy window load failed', code, description)
    observeFailure?.({
      component: 'desktop', stage: 'renderer', code: 'desktop.renderer.load-failed',
      error: new Error(`Window load failed: ${code}`)
    })
  })

  return window
}

export function loadMainWindow(
  window: BrowserWindow,
  storageUpgrade = false
): void {
  if (process.env.ELECTRON_RENDERER_URL) {
    const url = new URL(process.env.ELECTRON_RENDERER_URL)
    if (storageUpgrade) url.searchParams.set('storageUpgrade', '1')
    void window.loadURL(url.href).catch((error: unknown) => {
      console.error('GoodBuddy window load rejected', error)
    })
  } else {
    void window.loadFile(
      join(currentDirectory, '../renderer/index.html'),
      storageUpgrade ? { query: { storageUpgrade: '1' } } : undefined
    ).catch((error: unknown) => {
      console.error('GoodBuddy window load rejected', error)
    })
  }
}

export function showWindow(window: BrowserWindow): void {
  if (window.isMinimized()) {
    window.restore()
  }
  window.show()
  window.focus()
}

export function toggleWindow(window: BrowserWindow): void {
  if (window.isVisible() && window.isFocused()) {
    window.hide()
    return
  }
  showWindow(window)
}

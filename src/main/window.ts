import { app, BrowserWindow, nativeImage, shell } from 'electron'
import { dirname, join, posix, win32 } from 'node:path'
import { fileURLToPath } from 'node:url'

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
    return new URL(url).protocol === 'https:'
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

export function createMainWindow(shouldQuit: () => boolean): BrowserWindow {
  const iconPath = resolveWindowIcon()
  const icon = iconPath
    ? nativeImage.createFromPath(iconPath)
    : undefined
  const usableIcon = icon && !icon.isEmpty() ? icon : undefined
  const window = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 920,
    minHeight: 620,
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

  return window
}

export function loadMainWindow(window: BrowserWindow): void {
  if (process.env.ELECTRON_RENDERER_URL) {
    void window.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void window.loadFile(join(currentDirectory, '../renderer/index.html'))
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

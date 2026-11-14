import { app, nativeImage, nativeTheme, type NativeImage, type Tray } from 'electron'
import { posix, win32 } from 'node:path'

type TrayIconEnvironment = {
  platform: NodeJS.Platform
  isPackaged: boolean
  appPath: string
  resourcesPath: string
  darkSystemTheme?: boolean
}

export function resolveTrayIconPath(
  environment: TrayIconEnvironment = {
    platform: process.platform,
    isPackaged: app.isPackaged,
    appPath: app.getAppPath(),
    resourcesPath: process.resourcesPath,
    darkSystemTheme: nativeTheme.shouldUseDarkColorsForSystemIntegratedUI
  }
): string {
  const joinPath =
    environment.platform === 'win32' ? win32.join : posix.join
  const suffix = environment.platform === 'win32' && environment.darkSystemTheme ? '-dark' : ''
  return environment.isPackaged
    ? joinPath(environment.resourcesPath, `tray-icon${suffix}.png`)
    : joinPath(environment.appPath, 'build', `icon-tray${suffix}.png`)
}

export function followTraySystemTheme(tray: Tray): () => void {
  if (process.platform !== 'win32') return () => undefined
  const updateIcon = () => {
    if (!tray.isDestroyed()) tray.setImage(createTrayIcon())
  }
  nativeTheme.on('updated', updateIcon)
  return () => nativeTheme.removeListener('updated', updateIcon)
}

export function createTrayIcon(): NativeImage {
  const icon = nativeImage.createFromPath(resolveTrayIconPath())
  if (icon.isEmpty()) {
    throw new Error('通知栏图标资源无效')
  }
  const size = process.platform === 'win32' ? 16 : 22
  const resized = icon.resize({
    width: size,
    height: size,
    quality: 'best'
  })
  if (resized.isEmpty()) {
    throw new Error('通知栏图标缩放失败')
  }
  return resized
}

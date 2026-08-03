import { app, nativeImage, type NativeImage } from 'electron'
import { posix, win32 } from 'node:path'

type TrayIconEnvironment = {
  platform: NodeJS.Platform
  isPackaged: boolean
  appPath: string
  resourcesPath: string
}

export function resolveTrayIconPath(
  environment: TrayIconEnvironment = {
    platform: process.platform,
    isPackaged: app.isPackaged,
    appPath: app.getAppPath(),
    resourcesPath: process.resourcesPath
  }
): string {
  const joinPath =
    environment.platform === 'win32' ? win32.join : posix.join
  return environment.isPackaged
    ? joinPath(environment.resourcesPath, 'tray-icon.png')
    : joinPath(environment.appPath, 'build', 'icon-tray.png')
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

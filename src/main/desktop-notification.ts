import {
  Notification,
  type BrowserWindow,
  type NotificationConstructorOptions
} from 'electron'
import { showWindow } from './window'

const MAX_RETAINED_NOTIFICATIONS = 64
const NOTIFICATION_RETENTION_MS = 15 * 60_000
const activeNotifications = new Map<Notification, () => void>()
const pendingWindowActivations = new WeakSet<BrowserWindow>()

function activateWindow(window: BrowserWindow): void {
  try {
    if (window.isDestroyed()) {
      return
    }
    const webContents = window.webContents
    if (
      webContents &&
      (!webContents.getURL() ||
        webContents.isLoadingMainFrame())
    ) {
      if (!pendingWindowActivations.has(window)) {
        pendingWindowActivations.add(window)
        webContents.once('did-finish-load', () => {
          pendingWindowActivations.delete(window)
          activateWindow(window)
        })
      }
      return
    }
    showWindow(window)
  } catch {
    // The window can be destroyed between checks while a native callback runs.
  }
}

export function registerDesktopNotificationActivation(
  window: BrowserWindow,
  platform: NodeJS.Platform = process.platform
): void {
  if (platform !== 'win32') {
    return
  }
  Notification.handleActivation(() => {
    activateWindow(window)
  })
}

export function showDesktopNotificationWhenUnfocused(
  window: BrowserWindow,
  options: NotificationConstructorOptions
): boolean {
  if (
    window.isDestroyed() ||
    window.isFocused() ||
    !Notification.isSupported()
  ) {
    return false
  }

  const notification = new Notification(options)
  let retentionTimer: ReturnType<typeof setTimeout> | undefined

  const release = (): void => {
    if (retentionTimer) {
      clearTimeout(retentionTimer)
      retentionTimer = undefined
    }
    activeNotifications.delete(notification)
    notification.removeListener('click', handleClick)
    notification.removeListener('close', release)
    notification.removeListener('failed', release)
  }
  const dismiss = (): void => {
    try {
      notification.close()
    } catch {
      // The native notification may already have been dismissed.
    } finally {
      release()
    }
  }
  const handleClick = (): void => {
    try {
      activateWindow(window)
    } finally {
      release()
    }
  }

  if (activeNotifications.size >= MAX_RETAINED_NOTIFICATIONS) {
    activeNotifications.values().next().value?.()
  }
  activeNotifications.set(notification, dismiss)
  retentionTimer = setTimeout(dismiss, NOTIFICATION_RETENTION_MS)
  retentionTimer.unref?.()

  notification.once('click', handleClick)
  notification.once('close', release)
  notification.once('failed', release)

  try {
    notification.show()
  } catch (error) {
    release()
    throw error
  }
  return true
}

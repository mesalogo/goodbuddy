import {
  Notification,
  type BrowserWindow,
  type NotificationConstructorOptions
} from 'electron'

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
  new Notification(options).show()
  return true
}

import { clipboard, type BrowserWindow, type ipcMain } from 'electron'
import { clipboardTextSchema } from '../shared/contracts'
import { ipcChannels } from '../shared/ipc-channels'
import { assertTrustedSender } from './trusted-ipc-sender'
import { showWindow } from './window'

export function registerClipboardIpcHandlers(
  registerHandler: typeof ipcMain.handle,
  window: BrowserWindow
): void {
  registerHandler(ipcChannels.clipboardReadText, (event) => {
    assertTrustedSender(event, window)
    return clipboard.readText().then((text) => clipboardTextSchema.parse(text))
  })

  registerHandler(ipcChannels.clipboardWriteText, (event, input) => {
    assertTrustedSender(event, window)
    return clipboard.writeText(clipboardTextSchema.parse(input))
  })
}

export function registerWindowIpcHandlers(
  registerHandler: typeof ipcMain.handle,
  window: BrowserWindow
): () => void {
  const contents = window.webContents
  // Sandboxed srcdoc keyboard events cannot bubble to the renderer's modal.
  const previewEscape = (_event: Electron.Event, input: Electron.Input): void => {
    const frame = contents.focusedFrame
    if (input.type === 'keyDown' && input.key === 'Escape' &&
      frame?.parent === contents.mainFrame && frame.url.startsWith('about:srcdoc')) {
      contents.send(ipcChannels.windowPreviewEscape)
    }
  }
  contents.on('before-input-event', previewEscape)
  registerHandler(ipcChannels.appShow, (event) => {
    assertTrustedSender(event, window)
    showWindow(window)
  })

  registerHandler(ipcChannels.appHide, (event) => {
    assertTrustedSender(event, window)
    window.hide()
  })

  registerHandler(ipcChannels.windowMinimize, (event) => {
    assertTrustedSender(event, window)
    window.minimize()
  })

  registerHandler(ipcChannels.windowToggleMaximize, (event) => {
    assertTrustedSender(event, window)
    if (window.isMaximized()) {
      window.unmaximize()
    } else {
      window.maximize()
    }
  })

  registerHandler(ipcChannels.windowClose, (event) => {
    assertTrustedSender(event, window)
    window.close()
  })

  registerHandler(ipcChannels.windowIsMaximized, (event): boolean => {
    assertTrustedSender(event, window)
    return window.isMaximized()
  })
  return () => contents.removeListener('before-input-event', previewEscape)
}

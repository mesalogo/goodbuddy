import { ipcMain, type BrowserWindow } from 'electron'
import { z } from 'zod'
import { ipcChannels } from '../shared/ipc-channels'
import { desktopUpdateDownloadSchema } from '../shared/desktop-update-contracts'
import { assertTrustedSender } from './trusted-ipc-sender'
import type { DesktopUpdateService } from './desktop-update-service'

export function registerDesktopUpdateIpc(window: BrowserWindow, service: DesktopUpdateService): () => void {
  const empty = z.undefined()
  const handlers: Record<string, (input: unknown) => unknown> = {
    [ipcChannels.desktopUpdateGet]: input => { empty.parse(input); return service.getSnapshot() },
    [ipcChannels.desktopUpdateDownload]: input => service.download(desktopUpdateDownloadSchema.parse(input).fileName),
    [ipcChannels.desktopUpdateCancel]: input => { empty.parse(input); return service.cancel() },
    [ipcChannels.desktopUpdateOpen]: input => { empty.parse(input); return service.openPackage() },
    [ipcChannels.desktopUpdateRestart]: input => { empty.parse(input); return service.restart() },
    [ipcChannels.desktopUpdateClearCache]: input => { empty.parse(input); return service.clearCache() }
  }
  for (const [channel, handler] of Object.entries(handlers)) {
    ipcMain.handle(channel, (event, input: unknown) => {
      assertTrustedSender(event, window)
      return handler(input)
    })
  }
  const unsubscribe = service.onChanged(snapshot => {
    if (!window.isDestroyed()) window.webContents.send(ipcChannels.desktopUpdateChanged, snapshot)
  })
  return () => {
    unsubscribe()
    for (const channel of Object.keys(handlers)) ipcMain.removeHandler(channel)
  }
}

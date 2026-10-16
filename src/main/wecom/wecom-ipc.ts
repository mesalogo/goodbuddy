import { ipcMain, type BrowserWindow } from 'electron'
import { ipcChannels } from '../../shared/ipc-channels'
import {
  wecomDocSearchInputSchema,
  wecomManualCredentialsSchema,
  wecomToolSettingsUpdateSchema
} from '../../shared/wecom-contracts'
import { assertTrustedSender } from '../trusted-ipc-sender'
import type { WecomCliService } from './wecom-cli-service'

export function registerWecomIpc(window: BrowserWindow, service: WecomCliService): () => void {
  const handlers: Record<string, (input: unknown) => unknown> = {
    [ipcChannels.wecomSnapshot]: () => service.getSnapshot(),
    [ipcChannels.wecomUpdateSettings]: (input) => service.updateSettings(wecomToolSettingsUpdateSchema.parse(input)),
    [ipcChannels.wecomStartQr]: () => service.startQrAuthorization(),
    [ipcChannels.wecomCancelQr]: () => service.cancelQrAuthorization(),
    [ipcChannels.wecomAuthorizeManual]: (input) => service.authorizeManually(wecomManualCredentialsSchema.parse(input)),
    [ipcChannels.wecomAuthorizeChannelBot]: () => service.authorizeWithChannelBot(),
    [ipcChannels.wecomDisconnect]: () => service.disconnect(),
    [ipcChannels.wecomSearchDocuments]: (input) => service.searchDocuments(wecomDocSearchInputSchema.parse(input).query)
  }
  for (const [channel, handler] of Object.entries(handlers)) {
    ipcMain.removeHandler(channel)
    ipcMain.handle(channel, (event, input: unknown) => {
      assertTrustedSender(event, window)
      return handler(input)
    })
  }
  const removeListener = service.onChanged((snapshot) => {
    if (!window.isDestroyed() && !window.webContents.isDestroyed()) {
      window.webContents.send(ipcChannels.wecomChanged, snapshot)
    }
  })
  return () => {
    removeListener()
    for (const channel of Object.keys(handlers)) ipcMain.removeHandler(channel)
  }
}

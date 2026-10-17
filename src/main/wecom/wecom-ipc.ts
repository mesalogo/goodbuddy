import { dialog, ipcMain, type BrowserWindow } from 'electron'
import { ipcChannels } from '../../shared/ipc-channels'
import {
  wecomCreateDocumentInputSchema,
  wecomDocSearchInputSchema,
  wecomPanelViewSchema,
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
    [ipcChannels.wecomSearchDocuments]: (input) => service.searchDocuments(wecomDocSearchInputSchema.parse(input).query),
    [ipcChannels.wecomListView]: (input) => service.listView(wecomPanelViewSchema.parse(input).view),
    [ipcChannels.wecomCreateDocument]: (input) => service.createDocument(wecomCreateDocumentInputSchema.parse(input).title),
    // The file is picked in a main-process dialog, never a renderer-supplied path.
    [ipcChannels.wecomUploadFile]: async () => {
      const picked = await dialog.showOpenDialog(window, { properties: ['openFile'] })
      return picked.canceled || !picked.filePaths[0] ? undefined : service.uploadFile(picked.filePaths[0])
    }
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

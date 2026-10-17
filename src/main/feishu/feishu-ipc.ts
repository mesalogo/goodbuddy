import { dialog, ipcMain, type BrowserWindow } from 'electron'
import { feishuDomainSchema } from '../../shared/channel-settings-contracts'
import {
  feishuBrowseInputSchema,
  feishuCreateDocumentInputSchema,
  feishuSearchInputSchema,
  feishuToolSettingsUpdateSchema,
  feishuUploadFileInputSchema
} from '../../shared/feishu-contracts'
import { ipcChannels } from '../../shared/ipc-channels'
import { assertTrustedSender } from '../trusted-ipc-sender'
import type { FeishuToolService } from './feishu-tool-service'

export function registerFeishuIpc(window: BrowserWindow, service: FeishuToolService): () => void {
  const handlers: Record<string, (input: unknown) => unknown> = {
    [ipcChannels.feishuSnapshot]: () => service.getSnapshot(),
    [ipcChannels.feishuUpdateSettings]: (input) => service.updateSettings(feishuToolSettingsUpdateSchema.parse(input)),
    [ipcChannels.feishuStartRegistration]: (input) => service.startRegistration(feishuDomainSchema.parse(input)),
    [ipcChannels.feishuCancelRegistration]: () => service.cancelRegistration(),
    [ipcChannels.feishuBrowse]: (input) => service.browse(feishuBrowseInputSchema.parse(input)),
    [ipcChannels.feishuSearchDocuments]: (input) => service.searchDocuments(feishuSearchInputSchema.parse(input)),
    [ipcChannels.feishuCreateDocument]: (input) => service.createDocument(feishuCreateDocumentInputSchema.parse(input)),
    // The file is picked in a main-process dialog, never a renderer-supplied path.
    [ipcChannels.feishuUploadFile]: async (input) => {
      const { folderToken } = feishuUploadFileInputSchema.parse(input ?? {})
      const picked = await dialog.showOpenDialog(window, { properties: ['openFile'] })
      return picked.canceled || !picked.filePaths[0] ? undefined : service.uploadFile(picked.filePaths[0], folderToken)
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
      window.webContents.send(ipcChannels.feishuChanged, snapshot)
    }
  })
  return () => {
    removeListener()
    for (const channel of Object.keys(handlers)) ipcMain.removeHandler(channel)
  }
}

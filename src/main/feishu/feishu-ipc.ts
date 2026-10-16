import { ipcMain, type BrowserWindow } from 'electron'
import { feishuDomainSchema } from '../../shared/channel-settings-contracts'
import { feishuBrowseInputSchema, feishuSearchInputSchema, feishuToolSettingsUpdateSchema } from '../../shared/feishu-contracts'
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
    [ipcChannels.feishuSearchDocuments]: (input) => service.searchDocuments(feishuSearchInputSchema.parse(input))
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

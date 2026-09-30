import { ipcMain, type BrowserWindow } from 'electron'
import { ipcChannels } from '../shared/ipc-channels'
import { sharingIdSchema, sharingPublicationDraftSchema, sharingSettingsInputSchema } from '../shared/device-sharing-contracts'
import { assertTrustedSender } from './trusted-ipc-sender'
import type { DeviceSharingService } from './device-sharing-service'

export function registerDeviceSharingIpc(window: BrowserWindow, service: DeviceSharingService): () => void {
  const handlers = {
    [ipcChannels.sharingSettingsGet]: () => service.getSettings(),
    [ipcChannels.sharingSettingsSave]: (input: unknown) => service.saveSettings(sharingSettingsInputSchema.parse(input)),
    [ipcChannels.sharingRegister]: () => service.registerDevice(),
    [ipcChannels.sharingCatalog]: () => service.getCatalog(),
    [ipcChannels.sharingPublish]: (input: unknown) => service.publish(sharingPublicationDraftSchema.parse(input)),
    [ipcChannels.sharingRevoke]: (input: unknown) => service.revoke(sharingIdSchema.parse(input))
  }
  for (const [channel, handler] of Object.entries(handlers)) {
    ipcMain.removeHandler(channel)
    ipcMain.handle(channel, (event, input: unknown) => {
      assertTrustedSender(event, window)
      return handler(input)
    })
  }
  return () => { for (const channel of Object.keys(handlers)) ipcMain.removeHandler(channel) }
}

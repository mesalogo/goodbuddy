import { ipcMain, type BrowserWindow } from 'electron'
import { ipcChannels } from '../shared/ipc-channels'
import { sharingIdSchema, sharingPublicationDraftSchema, sharingSettingsInputSchema, sharingModelImportSchema, sharingRegistrationInputSchema } from '../shared/device-sharing-contracts'
import { assertTrustedSender } from './trusted-ipc-sender'
import type { DeviceSharingService } from './device-sharing-service'
import { personaChatSchema, personaDraftSchema, personaTransitionSchema } from '../shared/sharing-personas'

export function registerDeviceSharingIpc(window: BrowserWindow, service: DeviceSharingService): () => void {
  const handlers = {
    [ipcChannels.sharingPersonas]: () => service.getPersonas(),
    [ipcChannels.sharingPersonaSave]: (input: unknown) => service.savePersona(personaDraftSchema.parse(input)),
    [ipcChannels.sharingPersonaTransition]: (input: unknown) => service.transitionPersona(personaTransitionSchema.parse(input)),
    [ipcChannels.sharingPersonaChat]: (input: unknown) => service.chatPersona(personaChatSchema.parse(input)),
    [ipcChannels.sharingPersonaCancel]: (input: unknown) => service.cancelPersonaChat(sharingIdSchema.parse(input)),
    [ipcChannels.sharingModelConfigs]: () => service.getModelConfigs(),
    [ipcChannels.sharingModelImport]: (input: unknown) => service.importModelConfig(sharingModelImportSchema.parse(input)),
    [ipcChannels.sharingSettingsGet]: () => service.getSettings(),
    [ipcChannels.sharingSettingsSave]: (input: unknown) => service.saveSettings(sharingSettingsInputSchema.parse(input)),
    [ipcChannels.sharingRegister]: (input: unknown) => service.registerDevice(sharingRegistrationInputSchema.parse(input)),
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
  return () => { service.disposePersonaRequests(); for (const channel of Object.keys(handlers)) ipcMain.removeHandler(channel) }
}

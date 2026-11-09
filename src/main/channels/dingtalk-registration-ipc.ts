import type { BrowserWindow, IpcMainInvokeEvent } from 'electron'
import { ipcChannels } from '../../shared/ipc-channels'
import { assertTrustedSender } from '../trusted-ipc-sender'
import type { DingTalkRegistrationController } from './dingtalk-registration'

export function registerDingTalkRegistrationIpc(
  register: (channel: string, handler: (event: IpcMainInvokeEvent) => unknown) => void,
  window: BrowserWindow,
  controller?: DingTalkRegistrationController
): void {
  const actions = {
    [ipcChannels.dingtalkRegistrationGet]: () => controller!.snapshot(),
    [ipcChannels.dingtalkRegistrationStart]: () => controller!.start(),
    [ipcChannels.dingtalkRegistrationCancel]: () => controller!.cancel()
  }
  for (const [channel, action] of Object.entries(actions)) register(channel, event => {
    assertTrustedSender(event, window)
    if (!controller) throw new Error('钉钉扫码服务不可用')
    return action()
  })
}

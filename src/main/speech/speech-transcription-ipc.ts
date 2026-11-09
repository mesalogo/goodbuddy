import type { BrowserWindow, ipcMain } from 'electron'
import { ipcChannels } from '../../shared/ipc-channels'
import { speechTranscriptionInputSchema } from '../../shared/speech-model-contracts'
import { assertTrustedSender } from '../trusted-ipc-sender'
import type { SpeechTranscriptionService } from './speech-transcription-service'

export function registerSpeechTranscriptionIpc(
  register: typeof ipcMain.handle,
  window: BrowserWindow,
  service: SpeechTranscriptionService | undefined,
  track: <T>(work: Promise<T>) => Promise<T>
): void {
  register(ipcChannels.speechSettingsGet, async event => {
    assertTrustedSender(event, window)
    if (!service?.settings) throw new Error('语音识别设置不可用')
    return service.settings.get()
  })
  register(ipcChannels.speechSettingsUpdate, async (event, input: unknown) => {
    assertTrustedSender(event, window)
    if (!service?.settings) throw new Error('语音识别设置不可用')
    return service.settings.update(input)
  })
  register(ipcChannels.speechTranscribe, (event, input: unknown) => {
    assertTrustedSender(event, window)
    if (!service) throw new Error('语音识别服务不可用')
    return track(service.transcribe(input, progress => {
      if (!event.sender.isDestroyed()) event.sender.send(ipcChannels.speechTranscriptionProgress, progress)
    }))
  })
  register(ipcChannels.speechTranscriptionCancel, (event, input: unknown) => {
    assertTrustedSender(event, window)
    if (!service) return false
    return service.cancel(speechTranscriptionInputSchema.shape.requestId.parse(input))
  })
}

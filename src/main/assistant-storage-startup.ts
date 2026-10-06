import { app, ipcMain, type BrowserWindow } from 'electron'
import {
  assistantStorageActionSchema,
  assistantStorageProgressSchema,
  type AssistantStorageProgress
} from '../shared/assistant-storage-contracts'
import { ipcChannels } from '../shared/ipc-channels'
import type { DesktopStorageClient } from './desktop-storage-client'
import { assertTrustedSender } from './trusted-ipc-sender'
import { loadMainWindow } from './window'

export async function prepareAssistantStorage(
  window: BrowserWindow,
  createStorage: (publish: (progress: AssistantStorageProgress) => void) => Pick<DesktopStorageClient, 'ready' | 'retry' | 'close'>,
  signal: AbortSignal
): Promise<void> {
  if (signal.aborted) return
  let progress: AssistantStorageProgress = {
    stage: 'upgrading', processed: 0, total: 0, bytesBefore: 0
  }
  let shown = false
  let retry: (() => void) | undefined
  let abort!: () => void
  const aborted = new Promise<void>(resolve => { abort = resolve })
  signal.addEventListener('abort', abort, { once: true })
  ipcMain.handle(ipcChannels.storageUpgradeProgress, (event) => {
    assertTrustedSender(event, window)
    return progress
  })
  ipcMain.handle(ipcChannels.storageUpgradeAction, (event, input: unknown) => {
    assertTrustedSender(event, window)
    const action = assistantStorageActionSchema.parse(input)
    if (action === 'quit') app.quit()
    else if (progress.stage === 'failed') retry?.()
  })
  const publish = (next: AssistantStorageProgress): void => {
    progress = assistantStorageProgressSchema.parse(next)
    if (window.isDestroyed()) return
    if (!shown) {
      shown = true
      loadMainWindow(window, true)
    }
    window.setProgressBar(next.stage === 'failed' ? -1 :
      next.total > 0 && next.stage === 'converting'
        ? next.processed / next.total : 2)
  }
  try {
    const storage = createStorage(publish)
    let readiness = storage.ready
    while (!signal.aborted) {
      try {
        await Promise.race([readiness, aborted])
        if (signal.aborted) break
        return
      } catch (error) {
        if (signal.aborted) break
        publish({
          ...progress, stage: 'failed',
          error: error instanceof Error ? error.message : '本地数据升级失败'
        })
        await Promise.race([new Promise<void>(resolve => { retry = resolve }), aborted])
        retry = undefined
        if (!signal.aborted) readiness = storage.retry()
      }
    }
    await storage.close()
  } finally {
    signal.removeEventListener('abort', abort)
    ipcMain.removeHandler(ipcChannels.storageUpgradeProgress)
    ipcMain.removeHandler(ipcChannels.storageUpgradeAction)
    if (!window.isDestroyed()) window.setProgressBar(-1)
  }
}

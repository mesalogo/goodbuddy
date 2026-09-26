import { app, ipcMain, type BrowserWindow } from 'electron'
import { stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Worker } from 'node:worker_threads'
import {
  assistantStorageActionSchema,
  assistantStorageProgressSchema,
  type AssistantStorageProgress
} from '../shared/assistant-storage-contracts'
import { ipcChannels } from '../shared/ipc-channels'
import { assertTrustedSender } from './trusted-ipc-sender'
import { getPendingAssistantStorageUpgrade, type AssistantStorageUpgrade } from './assistant/assistant-storage-upgrade'
import { loadMainWindow } from './window'

export async function prepareAssistantStorage(
  window: BrowserWindow,
  databasePath: string,
  signal: AbortSignal
): Promise<void> {
  const file = await stat(databasePath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return undefined
    throw error
  })
  if (!file) return
  const upgrade = getPendingAssistantStorageUpgrade(databasePath)
  if (!upgrade) return
  let progress: AssistantStorageProgress = {
    stage: 'upgrading', processed: 0, total: 0, bytesBefore: file.size
  }
  let shown = false
  let retry: (() => void) | undefined
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
    while (!signal.aborted) {
      try {
        await runStorageWorker(databasePath, upgrade, signal, publish)
        return
      } catch (error) {
        if (signal.aborted) return
        publish({
          ...progress, stage: 'failed',
          error: error instanceof Error ? error.message : '本地数据升级失败'
        })
        await new Promise<void>((resolve) => {
          const finish = (): void => {
            signal.removeEventListener('abort', finish)
            retry = undefined
            resolve()
          }
          retry = finish
          signal.addEventListener('abort', finish, { once: true })
        })
      }
    }
  } finally {
    ipcMain.removeHandler(ipcChannels.storageUpgradeProgress)
    ipcMain.removeHandler(ipcChannels.storageUpgradeAction)
    if (!window.isDestroyed()) window.setProgressBar(-1)
  }
}

function runStorageWorker(
  databasePath: string,
  upgrade: AssistantStorageUpgrade,
  signal: AbortSignal,
  publish: (progress: AssistantStorageProgress) => void
): Promise<void> {
  const cancellation = new SharedArrayBuffer(4)
  const cancel = (): void => {
    Atomics.store(new Int32Array(cancellation), 0, 1)
  }
  if (signal.aborted) return Promise.resolve()
  signal.addEventListener('abort', cancel, { once: true })
  return new Promise<void>((resolve, reject) => {
    const worker = new Worker(join(
      dirname(fileURLToPath(import.meta.url)), 'assistant-storage-worker.js'
    ), { workerData: { databasePath, cancellation, upgrade } })
    let failure: Error | undefined
    let done = false
    worker.on('message', (message: {
      progress?: AssistantStorageProgress
      error?: string
      cancelled?: boolean
      done?: boolean
    }) => {
      if (message.progress) publish(message.progress)
      if (message.error && !message.cancelled) failure = new Error(message.error)
      if (message.done || message.cancelled) done = true
    })
    worker.once('error', () => {
      failure = new Error('无法启动本地数据升级，请重启 GoodBuddy 后重试。')
    })
    worker.once('exit', (code) => {
      signal.removeEventListener('abort', cancel)
      if (failure) reject(failure)
      else if (done && code === 0) resolve()
      else reject(new Error('本地数据升级意外结束，请重试。'))
    })
  })
}

import type { EventEmitter } from 'node:events'
import type { BrowserWindow, IpcMainInvokeEvent } from 'electron'
import { beforeEach, expect, it, vi } from 'vitest'
import { ipcChannels } from '../shared/ipc-channels'
import { prepareAssistantStorage } from './assistant-storage-startup'
import { getPendingAssistantStorageUpgrade } from './assistant/assistant-storage-upgrade'
import { loadMainWindow } from './window'

const mocks = vi.hoisted(() => ({
  workers: [] as Array<EventEmitter & { options: { workerData: { upgrade: unknown } } }>,
  handlers: new Map<string, (event: unknown, input?: unknown) => unknown>(),
  quit: vi.fn()
}))
vi.mock('electron', () => ({
  app: { quit: mocks.quit },
  ipcMain: {
    handle: (channel: string, handler: (event: unknown, input?: unknown) => unknown) => mocks.handlers.set(channel, handler),
    removeHandler: (channel: string) => mocks.handlers.delete(channel)
  }
}))
vi.mock('node:fs/promises', () => {
  const stat = vi.fn(async () => ({ size: 1024 }))
  return { stat, default: { stat } }
})
vi.mock('./window', () => ({ loadMainWindow: vi.fn() }))
vi.mock('./assistant/assistant-storage-upgrade', () => ({ getPendingAssistantStorageUpgrade: vi.fn() }))
vi.mock('node:worker_threads', async () => {
  const { EventEmitter } = await import('node:events')
  class Worker extends EventEmitter {
    constructor(_path: string, readonly options: { workerData: { upgrade: unknown } }) {
      super()
      mocks.workers.push(this)
    }
  }
  return { Worker, default: { Worker } }
})
beforeEach(() => {
  mocks.workers.length = 0
  mocks.handlers.clear()
  vi.clearAllMocks()
})

it.each([false, true])('retains the original reclaimSpace=%s decision across startup retries', async (reclaimSpace) => {
  const upgrade = { migrateNotes: reclaimSpace, reclaimSpace }
  vi.mocked(getPendingAssistantStorageUpgrade).mockReturnValueOnce(upgrade).mockReturnValue(undefined)
  const webContents = { mainFrame: { url: 'app://main' }, getURL: () => 'app://main' }
  const window = { webContents, isDestroyed: () => false, setProgressBar: vi.fn() } as unknown as BrowserWindow
  const event = { sender: webContents, senderFrame: webContents.mainFrame } as unknown as IpcMainInvokeEvent
  const preparation = prepareAssistantStorage(window, '/test/assistant.sqlite', new AbortController().signal)
  await vi.waitFor(() => expect(mocks.workers).toHaveLength(1))
  mocks.workers[0]!.emit('message', {
    progress: { stage: 'upgrading', processed: 0, total: 0, bytesBefore: 1024 }
  })
  expect(loadMainWindow).toHaveBeenCalledOnce()
  expect(mocks.handlers.get(ipcChannels.storageUpgradeProgress)!(event)).toMatchObject({ stage: 'upgrading' })
  mocks.workers[0]!.emit('message', { error: 'Retry this startup' })
  mocks.workers[0]!.emit('exit', 0)
  await vi.waitFor(() =>
    expect(mocks.handlers.get(ipcChannels.storageUpgradeProgress)!(event)).toMatchObject({ stage: 'failed' })
  )
  mocks.handlers.get(ipcChannels.storageUpgradeAction)!(event, 'retry')
  await vi.waitFor(() => expect(mocks.workers).toHaveLength(2))
  expect(getPendingAssistantStorageUpgrade).toHaveBeenCalledOnce()
  expect(mocks.workers.map(worker => worker.options.workerData.upgrade)).toEqual([upgrade, upgrade])
  mocks.workers[1]!.emit('message', { done: true })
  mocks.workers[1]!.emit('exit', 0)
  await preparation
  expect(mocks.handlers.size).toBe(0)
  expect(window.setProgressBar).toHaveBeenLastCalledWith(-1)
})

it('does not open an upgrade page or worker for an already-current database', async () => {
  vi.mocked(getPendingAssistantStorageUpgrade).mockReturnValue(undefined)
  await prepareAssistantStorage({} as BrowserWindow, '/test/assistant.sqlite', new AbortController().signal)
  expect(mocks.workers).toHaveLength(0)
  expect(loadMainWindow).not.toHaveBeenCalled()
})

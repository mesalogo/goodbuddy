import type { BrowserWindow, IpcMainInvokeEvent } from 'electron'
import { beforeEach, expect, it, vi } from 'vitest'
import { ipcChannels } from '../shared/ipc-channels'
import type { AssistantStorageProgress } from '../shared/assistant-storage-contracts'
import { prepareAssistantStorage } from './assistant-storage-startup'
import { loadMainWindow } from './window'

const mocks = vi.hoisted(() => ({
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
vi.mock('./window', () => ({ loadMainWindow: vi.fn() }))
beforeEach(() => {
  mocks.handlers.clear()
  vi.clearAllMocks()
})

function deferred() {
  let resolve!: () => void
  let reject!: (error: Error) => void
  const promise = new Promise<void>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}

function fixture() {
  const webContents = { mainFrame: { url: 'app://main' }, getURL: () => 'app://main' }
  const window = { webContents, isDestroyed: () => false, setProgressBar: vi.fn() } as unknown as BrowserWindow
  const event = { sender: webContents, senderFrame: webContents.mainFrame } as unknown as IpcMainInvokeEvent
  const controller = new AbortController()
  const opening = deferred(), retrying = deferred(), closing = deferred()
  const storage = { ready: opening.promise, retry: vi.fn(() => retrying.promise), close: vi.fn(() => closing.promise) }
  let publish!: (progress: AssistantStorageProgress) => void
  const create = vi.fn((listener: typeof publish) => { publish = listener; return storage })
  const preparation = prepareAssistantStorage(window, create, controller.signal)
  return { window, event, controller, opening, retrying, closing, storage, create, publish, preparation }
}

it('publishes utility progress and retries the same client before allowing startup', async () => {
  const f = fixture()
  f.publish({ stage: 'converting', processed: 1, total: 2, bytesBefore: 1024 })
  expect(loadMainWindow).toHaveBeenCalledOnce()
  expect(f.window.setProgressBar).toHaveBeenLastCalledWith(0.5)
  f.opening.reject(new Error('Retry this startup'))
  await vi.waitFor(() => expect(mocks.handlers.get(ipcChannels.storageUpgradeProgress)!(f.event)).toMatchObject({ stage: 'failed' }))
  mocks.handlers.get(ipcChannels.storageUpgradeAction)!(f.event, 'retry')
  await vi.waitFor(() => expect(f.storage.retry).toHaveBeenCalledOnce())
  const completed = vi.fn()
  void f.preparation.then(completed)
  await Promise.resolve()
  expect(completed).not.toHaveBeenCalled()
  expect(f.create).toHaveBeenCalledOnce()
  f.retrying.resolve()
  await f.preparation
  expect(mocks.handlers.size).toBe(0)
  expect(f.window.setProgressBar).toHaveBeenLastCalledWith(-1)
  expect(f.storage.close).not.toHaveBeenCalled()
})

it('keeps the client identity and waits for replacement readiness across repeated process failures', async () => {
  const f = fixture()
  f.opening.reject(new Error('Initial utility exited'))
  await vi.waitFor(() => expect(mocks.handlers.get(ipcChannels.storageUpgradeProgress)!(f.event)).toMatchObject({ stage: 'failed' }))
  mocks.handlers.get(ipcChannels.storageUpgradeAction)!(f.event, 'retry')
  await vi.waitFor(() => expect(f.storage.retry).toHaveBeenCalledTimes(1))
  f.retrying.reject(new Error('Replacement utility exited'))
  await vi.waitFor(() => expect(mocks.handlers.get(ipcChannels.storageUpgradeProgress)!(f.event)).toMatchObject({ error: 'Replacement utility exited' }))
  const replacement = deferred()
  f.storage.retry.mockReturnValue(replacement.promise)
  mocks.handlers.get(ipcChannels.storageUpgradeAction)!(f.event, 'retry')
  await vi.waitFor(() => expect(f.storage.retry).toHaveBeenCalledTimes(2))
  expect(f.create).toHaveBeenCalledTimes(1)
  replacement.resolve()
  await f.preparation
  expect(f.storage.close).not.toHaveBeenCalled()
})

it('does not open an upgrade page when storage becomes ready without an upgrade', async () => {
  const f = fixture()
  f.opening.resolve()
  await f.preparation
  expect(loadMainWindow).not.toHaveBeenCalled()
  expect(mocks.handlers.size).toBe(0)
})

it.each([false, true])('awaits utility close on quit while failed=%s', async failed => {
  const f = fixture()
  if (failed) {
    f.opening.reject(new Error('Startup failed'))
    await vi.waitFor(() => expect(loadMainWindow).toHaveBeenCalledOnce())
  }
  f.controller.abort()
  await vi.waitFor(() => expect(f.storage.close).toHaveBeenCalledOnce())
  const settled = vi.fn()
  void f.preparation.then(settled)
  await Promise.resolve()
  expect(settled).not.toHaveBeenCalled()
  f.closing.resolve()
  await f.preparation
  expect(f.storage.retry).not.toHaveBeenCalled()
  expect(mocks.handlers.size).toBe(0)
})

it('rejects upgrade actions from an unrelated sender', async () => {
  const f = fixture()
  expect(() => mocks.handlers.get(ipcChannels.storageUpgradeAction)!({ sender: {} }, 'retry')).toThrow()
  f.opening.resolve()
  await f.preparation
})

it('closes the owner when readiness fails at the same time as quit and reports an unconfirmed close', async () => {
  const f = fixture()
  f.opening.reject(new Error('Storage exited'))
  f.controller.abort()
  await vi.waitFor(() => expect(f.storage.close).toHaveBeenCalledOnce())
  const result = expect(f.preparation).rejects.toThrow('Drain unconfirmed')
  f.closing.reject(new Error('Drain unconfirmed'))
  await result
  expect(mocks.handlers.size).toBe(0)
})

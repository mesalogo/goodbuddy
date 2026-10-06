import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DesktopStorageOwner, storageError } from './desktop-storage-owner'
import type { StorageRequest, StorageResponse } from './desktop-storage-contracts'

const port = process.parentPort
if (!port) throw new Error('Desktop storage requires an Electron utility process')
const directory = dirname(fileURLToPath(import.meta.url))
const post = (message: StorageResponse): void => {
  port.postMessage(message)
  if (message.type === 'closed') process.exit(0)
  if (message.type === 'failed' && message.error.code === 'STORAGE_CLOSE_FAILED') process.exit(1)
}
const owner = new DesktopStorageOwner(post)
let stopping = false
const shutdown = (): void => {
  if (stopping) return
  stopping = true
  void owner.close().catch(error => {
    try { port.postMessage({ type: 'failed', error: storageError(error) } satisfies StorageResponse) } finally { process.exit(1) }
  })
}
port.on('message', ({ data }: { data: StorageRequest }) => {
  if (data.type === 'close') { shutdown(); return }
  if (data.type === 'open') data.options = {
    ...data.options,
    readerWorkerPath: data.options.readerWorkerPath ?? join(directory, 'readonly-query-worker.js'),
    upgradeWorkerPath: data.options.upgradeWorkerPath ?? join(directory, 'assistant-storage-worker.js')
  }
  owner.receive(data)
})
process.once('disconnect', shutdown)
process.once('SIGTERM', shutdown)

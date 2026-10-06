import type { StorageRequest, StorageResponse } from './desktop-storage-contracts'

const post = (message: StorageResponse): void => process.parentPort.postMessage(message)
process.parentPort.on('message', ({ data }: { data: StorageRequest }) => {
  if (data.type === 'close') { post({ type: 'closed' }); process.exit(0) }
  if (data.type === 'call') post({ type: 'result', id: data.id, result: data.args })
})

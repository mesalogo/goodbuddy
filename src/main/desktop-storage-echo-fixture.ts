import type { StorageRequest, StorageResponse } from './desktop-storage-contracts'

const post = (message: StorageResponse): void => process.parentPort.postMessage(message)
process.parentPort.on('message', ({ data }: { data: StorageRequest }) => {
  if (data.type === 'call') post({ type: 'result', id: data.id, result: data.args })
})

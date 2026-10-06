import assert from 'node:assert/strict'
import { DesktopStorageRuntimeOwner, runtimeStorageMethods } from './desktop-storage-runtime-operations'
import type { StorageRequest, StorageResponse } from './desktop-storage-contracts'

const parent = (process as unknown as { parentPort: {
  on(event: 'message', listener: (event: { data: StorageRequest }) => void): void
  postMessage(message: StorageResponse): void
} }).parentPort
let owner: DesktopStorageRuntimeOwner
const active = new Set<Promise<void>>()
parent.on('message', ({ data: message }) => {
  const operation = (async () => {
    if (message.type === 'open') {
      owner = await DesktopStorageRuntimeOwner.open(process.env.GB_RUNTIME_STORAGE_TEST_ROOT!)
      parent.postMessage({ type: 'ready' })
    } else if (message.type === 'close') {
      await Promise.all([...active])
      owner.close()
      parent.postMessage({ type: 'closed' })
      process.exit(0)
    } else if (message.type === 'call') {
      try {
        assert.equal(message.domain, 'runtime')
        assert.ok((runtimeStorageMethods as readonly string[]).includes(message.method))
        const method = owner[message.method as keyof typeof owner] as (...args: unknown[]) => unknown
        const result = await method.apply(owner, message.args)
        parent.postMessage({ type: 'result', id: message.id, result })
      } catch (error) {
        const failure = error as Error & { code?: string }
        parent.postMessage({ type: 'error', id: message.id, error: { name: failure.name, message: failure.message, code: failure.code } })
      }
    }
  })()
  active.add(operation)
  void operation.finally(() => active.delete(operation))
})

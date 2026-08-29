import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  RemoteEnvironmentOperationStore,
  type PendingRemoteEnvironmentOperation
} from './remote-environment-operation-store'

const temporaryDirectories: string[] = []
const operation: PendingRemoteEnvironmentOperation = {
  version: 1,
  hostId: 'host-1',
  targetIdentity: 'a'.repeat(64),
  operationId: '00000000-0000-4000-8000-000000000777'
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) =>
      rm(path, { recursive: true, force: true })
    )
  )
})

describe('RemoteEnvironmentOperationStore', () => {
  it('persists one bounded operation per Host and removes it', async () => {
    const root = await mkdtemp(
      join(tmpdir(), 'goodbuddy-environment-operation-')
    )
    temporaryDirectories.push(root)
    const store = new RemoteEnvironmentOperationStore(root)

    await store.save(operation)
    await expect(store.load(operation.hostId)).resolves.toEqual(
      operation
    )
    await store.remove(operation.hostId)
    await expect(store.load(operation.hostId)).resolves.toBeUndefined()
  })

  it('rejects a mismatched or oversized recovery record', async () => {
    const root = await mkdtemp(
      join(tmpdir(), 'goodbuddy-environment-operation-')
    )
    temporaryDirectories.push(root)
    const store = new RemoteEnvironmentOperationStore(root)
    await store.save(operation)
    const files = join(
      root,
      'remote-components',
      'pending-environment-operations'
    )
    const { readdir } = await import('node:fs/promises')
    const [record] = await readdir(files)
    await writeFile(
      join(files, record!),
      Buffer.alloc(4 * 1024 + 1)
    )

    await expect(store.load(operation.hostId)).rejects.toThrow(
      '超过大小限制'
    )
  })
})

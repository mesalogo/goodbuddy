import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import type { RuntimeSessionBinding } from '../../shared/remote-agent-contracts'
import {
  MemoryRuntimeSessionBindingStore,
  RuntimeSessionBindingCorruptionError,
  RuntimeSessionBindingConflictError,
  RuntimeSessionClaimConflictError,
  SqliteRuntimeSessionBindingStore
} from './runtime-session-binding-store'

const digest = `sha256:${'a'.repeat(64)}`

function binding(
  bindingId: string,
  conversationId: string
): RuntimeSessionBinding {
  return {
    bindingId,
    controllerId: 'controller-1',
    controllerGeneration: 1,
    conversationId,
    hostId: 'host-1',
    hostRevision: 1,
    hostKeyGeneration: 1,
    workspaceIdentity: 'workspace-1',
    agentInstallationId: 'installation-1',
    daemonBootIdAtOpen: 'boot-1',
    runtimeId: 'runtime-1',
    runtimeBundleDigest: digest,
    runtimeAdapterDigest: digest,
    acpSessionId: `opening-${bindingId}`,
    acpCapabilitiesDigest: digest,
    state: 'opening',
    promptSequence: 0,
    channelEpoch: '1',
    lastOutboundJournaledSequence: '0',
    lastOutboundDeliveredSequence: '0',
    lastInboundJournaledSequence: '0',
    lastMainAckSequence: '0'
  }
}

describe('MemoryRuntimeSessionBindingStore', () => {
  it('atomically rejects concurrent claims for one live ACP session', async () => {
    const store = new MemoryRuntimeSessionBindingStore()
    await store.put(binding('binding-1', 'conversation-1'))
    await store.put(binding('binding-2', 'conversation-2'))

    const claims = await Promise.allSettled([
      store.claimAcpSession('binding-1', 'shared-session'),
      store.claimAcpSession('binding-2', 'shared-session')
    ])

    expect(claims.filter((claim) => claim.status === 'fulfilled')).toHaveLength(1)
    const rejected = claims.find(
      (claim): claim is PromiseRejectedResult =>
        claim.status === 'rejected'
    )
    expect(rejected?.reason).toBeInstanceOf(
      RuntimeSessionClaimConflictError
    )
  })

  it('allows a closed owner session identity to be claimed again', async () => {
    const store = new MemoryRuntimeSessionBindingStore()
    const first = binding('binding-1', 'conversation-1')
    await store.put(first)
    const claimed = await store.claimAcpSession(
      first.bindingId,
      'session-1'
    )
    await store.put({ ...claimed, state: 'closed' })

    const second = binding('binding-2', 'conversation-2')
    await store.put(second)
    await expect(
      store.claimAcpSession(second.bindingId, 'session-1')
    ).resolves.toMatchObject({
      bindingId: 'binding-2',
      acpSessionId: 'session-1'
    })
  })

  it('keeps binding and channel ownership immutable', async () => {
    const store = new MemoryRuntimeSessionBindingStore()
    const original = binding('binding-1', 'conversation-1')
    await store.put(original)

    await expect(
      store.put({ ...original, channelEpoch: '2' })
    ).rejects.toBeInstanceOf(RuntimeSessionBindingConflictError)
    await expect(
      store.put({
        ...original,
        controllerGeneration: 2
      })
    ).rejects.toBeInstanceOf(RuntimeSessionBindingConflictError)
    await expect(
      store.put({ ...original, hostRevision: 2 })
    ).rejects.toBeInstanceOf(RuntimeSessionBindingConflictError)
    await expect(
      store.put(
        binding('binding-2', original.conversationId)
      )
    ).rejects.toBeInstanceOf(RuntimeSessionBindingConflictError)
  })

  it('keeps the persisted model bridge version and policy immutable', async () => {
    const store = new MemoryRuntimeSessionBindingStore()
    const original = {
      ...binding('binding-model', 'conversation-model'),
      modelBridgeVersion:
        'goodbuddy-model-bridge-v1' as const,
      modelBridgePolicy: {
        protocol: 'openai-responses' as const,
        model: 'gpt-test',
        modelProfileDigest: digest,
        supportsImageInput: false
      }
    }
    await store.put(original)
    await expect(
      store.put({
        ...original,
        modelBridgePolicy: {
          ...original.modelBridgePolicy,
          model: 'different-model'
        }
      })
    ).rejects.toThrow('model bridge policy is immutable')
    await expect(
      store.put({
        ...original,
        modelBridgeVersion: undefined,
        modelBridgePolicy: undefined
      })
    ).rejects.toThrow('modelBridgeVersion is immutable')
  })

  it('atomically rotates only an idle ready transport and resets its cursors', async () => {
    const store = new MemoryRuntimeSessionBindingStore()
    const ready = {
      ...binding('binding-1', 'conversation-1'),
      state: 'ready' as const,
      acpSessionId: 'session-1',
      lastOutboundJournaledSequence: '4',
      lastOutboundDeliveredSequence: '3',
      lastInboundJournaledSequence: '6',
      lastMainAckSequence: '5'
    }
    await store.put(ready)

    await expect(
      store.rotateReadyTransport(
        ready.bindingId,
        {
          controllerGeneration: 1,
          daemonBootIdAtOpen: 'boot-1',
          channelEpoch: '1'
        },
        {
          controllerGeneration: 2,
          daemonBootIdAtOpen: 'boot-2',
          channelEpoch: '2'
        }
      )
    ).resolves.toMatchObject({
      acpSessionId: 'session-1',
      controllerGeneration: 2,
      daemonBootIdAtOpen: 'boot-2',
      channelEpoch: '2',
      lastOutboundJournaledSequence: '0',
      lastOutboundDeliveredSequence: '0',
      lastInboundJournaledSequence: '0',
      lastMainAckSequence: '0'
    })
    await expect(
      store.rotateReadyTransport(
        ready.bindingId,
        {
          controllerGeneration: 1,
          daemonBootIdAtOpen: 'boot-1',
          channelEpoch: '1'
        },
        {
          controllerGeneration: 3,
          daemonBootIdAtOpen: 'boot-3',
          channelEpoch: '3'
        }
      )
    ).rejects.toBeInstanceOf(RuntimeSessionBindingConflictError)
  })
})

describe('SqliteRuntimeSessionBindingStore', () => {
  const temporaryDirectories: string[] = []

  afterEach(async () => {
    await Promise.all(
      temporaryDirectories.splice(0).map((directory) =>
        rm(directory, { recursive: true, force: true })
      )
    )
  })

  async function databasePath(): Promise<string> {
    const directory = await mkdtemp(
      join(tmpdir(), 'goodbuddy-runtime-bindings-')
    )
    temporaryDirectories.push(directory)
    return join(directory, 'bindings.sqlite')
  }

  it.runIf(process.platform !== 'win32')(
    'creates the database as a private regular file',
    async () => {
      const path = await databasePath()
      const store = new SqliteRuntimeSessionBindingStore(path)
      const file = await stat(path)

      expect(file.isFile()).toBe(true)
      expect(file.mode & 0o777).toBe(0o600)
      store.close()
    }
  )

  it('rejects in-memory and file URI database paths', () => {
    expect(
      () => new SqliteRuntimeSessionBindingStore(':memory:')
    ).toThrow('filesystem path')
    expect(
      () =>
        new SqliteRuntimeSessionBindingStore(
          'file:runtime-bindings.sqlite'
        )
    ).toThrow('filesystem path')
  })

  it('persists bindings and cursors across reopen', async () => {
    const path = await databasePath()
    const first = new SqliteRuntimeSessionBindingStore(path)
    const persisted = {
      ...binding('binding-1', 'conversation-1'),
      state: 'ready' as const,
      modelBridgeVersion:
        'goodbuddy-model-bridge-v1' as const,
      modelBridgePolicy: {
        protocol: 'openai-responses' as const,
        model: 'gpt-test',
        modelProfileDigest: digest,
        supportsImageInput: false
      },
      lastOutboundJournaledSequence: '4',
      lastOutboundDeliveredSequence: '3',
      lastInboundJournaledSequence: '6',
      lastMainAckSequence: '5'
    }
    await first.put(persisted)
    first.close()

    const reopened = new SqliteRuntimeSessionBindingStore(path)
    await expect(reopened.getById(persisted.bindingId)).resolves.toEqual(
      persisted
    )
    const returned = await reopened.getById(persisted.bindingId)
    if (!returned) {
      throw new Error('Expected persisted binding')
    }
    returned.lastMainAckSequence = '0'
    await expect(reopened.getById(persisted.bindingId)).resolves.toEqual(
      persisted
    )
    reopened.dispose()
  })

  it('persists an atomic ready transport rotation', async () => {
    const path = await databasePath()
    const store = new SqliteRuntimeSessionBindingStore(path)
    const ready = {
      ...binding('binding-1', 'conversation-1'),
      state: 'ready' as const,
      acpSessionId: 'session-1',
      lastOutboundJournaledSequence: '4',
      lastOutboundDeliveredSequence: '3',
      lastInboundJournaledSequence: '6',
      lastMainAckSequence: '5'
    }
    await store.put(ready)
    await store.rotateReadyTransport(
      ready.bindingId,
      {
        controllerGeneration: 1,
        daemonBootIdAtOpen: 'boot-1',
        channelEpoch: '1'
      },
      {
        controllerGeneration: 2,
        daemonBootIdAtOpen: 'boot-2',
        channelEpoch: '2'
      }
    )
    store.close()

    const reopened = new SqliteRuntimeSessionBindingStore(path)
    await expect(reopened.getById(ready.bindingId)).resolves.toMatchObject({
      acpSessionId: 'session-1',
      state: 'ready',
      controllerGeneration: 2,
      daemonBootIdAtOpen: 'boot-2',
      channelEpoch: '2',
      lastOutboundJournaledSequence: '0',
      lastOutboundDeliveredSequence: '0',
      lastInboundJournaledSequence: '0',
      lastMainAckSequence: '0'
    })
    reopened.close()
  })

  it('rejects live conversation conflicts and permits idempotent writes', async () => {
    const store = new SqliteRuntimeSessionBindingStore(await databasePath())
    const original = binding('binding-1', 'conversation-1')
    await store.put(original)
    await expect(store.put(original)).resolves.toBeUndefined()
    await expect(
      store.put(binding('binding-2', original.conversationId))
    ).rejects.toBeInstanceOf(RuntimeSessionBindingConflictError)
    store.close()
  })

  it('enforces a lower row cap when reopening by pruning only closed rows', async () => {
    const path = await databasePath()
    const original = new SqliteRuntimeSessionBindingStore(path, {
      maximumRows: 3
    })
    await original.put(binding('binding-live-1', 'conversation-live-1'))
    await original.put(binding('binding-live-2', 'conversation-live-2'))
    await original.put({
      ...binding('binding-closed', 'conversation-closed'),
      state: 'closed'
    })
    original.close()

    const capped = new SqliteRuntimeSessionBindingStore(path, {
      maximumRows: 2
    })
    await expect(
      capped.getById('binding-closed')
    ).resolves.toBeUndefined()
    await expect(
      capped.getById('binding-live-1')
    ).resolves.toBeDefined()
    await expect(
      capped.getById('binding-live-2')
    ).resolves.toBeDefined()
    capped.close()

    expect(
      () =>
        new SqliteRuntimeSessionBindingStore(path, {
          maximumRows: 1
        })
    ).toThrow(RuntimeSessionBindingConflictError)
  })

  it('atomically resolves competing claims from separate connections', async () => {
    const path = await databasePath()
    const first = new SqliteRuntimeSessionBindingStore(path)
    const second = new SqliteRuntimeSessionBindingStore(path)
    await first.put(binding('binding-1', 'conversation-1'))
    await second.put(binding('binding-2', 'conversation-2'))

    const claims = await Promise.allSettled([
      first.claimAcpSession('binding-1', 'shared-session'),
      second.claimAcpSession('binding-2', 'shared-session')
    ])

    expect(claims.filter((claim) => claim.status === 'fulfilled')).toHaveLength(
      1
    )
    const failure = claims.find(
      (claim): claim is PromiseRejectedResult => claim.status === 'rejected'
    )
    expect(failure?.reason).toBeInstanceOf(RuntimeSessionClaimConflictError)
    first.close()
    second.close()
  })

  it('releases conversation and ACP ownership when a binding closes', async () => {
    const store = new SqliteRuntimeSessionBindingStore(await databasePath())
    const first = binding('binding-1', 'conversation-1')
    await store.put(first)
    const claimed = await store.claimAcpSession(first.bindingId, 'session-1')
    await store.put({ ...claimed, state: 'closed' })

    const replacement = {
      ...binding('binding-2', first.conversationId),
      acpSessionId: 'session-1'
    }
    await expect(store.put(replacement)).resolves.toBeUndefined()
    await expect(
      store.getByConversation(first.conversationId)
    ).resolves.toMatchObject({ bindingId: replacement.bindingId })
    store.close()
  })

  it('rejects immutable mutation and direct ACP identity mutation', async () => {
    const store = new SqliteRuntimeSessionBindingStore(await databasePath())
    const original = binding('binding-1', 'conversation-1')
    await store.put(original)
    await expect(
      store.put({ ...original, channelEpoch: '2' })
    ).rejects.toBeInstanceOf(RuntimeSessionBindingConflictError)
    await expect(
      store.put({ ...original, workspaceIdentity: 'workspace-2' })
    ).rejects.toBeInstanceOf(RuntimeSessionBindingConflictError)
    await expect(
      store.put({ ...original, hostRevision: 2 })
    ).rejects.toBeInstanceOf(RuntimeSessionBindingConflictError)
    await expect(
      store.put({ ...original, acpSessionId: 'other-session' })
    ).rejects.toBeInstanceOf(RuntimeSessionBindingConflictError)
    store.close()
  })

  it('rejects reopening a closed binding and preserves the closed row', async () => {
    const store = new SqliteRuntimeSessionBindingStore(await databasePath())
    const original = binding('binding-1', 'conversation-1')
    await store.put(original)
    const closed = { ...original, state: 'closed' as const }
    await store.put(closed)

    await expect(
      store.put({ ...closed, state: 'ready' })
    ).rejects.toBeInstanceOf(RuntimeSessionBindingConflictError)
    await expect(store.getById(original.bindingId)).resolves.toEqual(closed)
    store.close()
  })

  it('rejects interrupted bindings becoming ready', async () => {
    const store = new SqliteRuntimeSessionBindingStore(await databasePath())
    const original = binding('binding-1', 'conversation-1')
    const interrupted = { ...original, state: 'interrupted' as const }
    await store.put(original)
    await store.put(interrupted)

    await expect(
      store.put({ ...interrupted, state: 'ready' })
    ).rejects.toBeInstanceOf(RuntimeSessionBindingConflictError)
    await expect(store.getById(original.bindingId)).resolves.toEqual(
      interrupted
    )
    store.close()
  })

  it('fails closed when persisted JSON is malformed', async () => {
    const path = await databasePath()
    const store = new SqliteRuntimeSessionBindingStore(path)
    const original = binding('binding-1', 'conversation-1')
    await store.put(original)
    store.close()

    const raw = new DatabaseSync(path)
    raw
      .prepare(`
        UPDATE runtime_session_bindings
        SET binding_json = ?
        WHERE binding_id = ?
      `)
      .run('{}', original.bindingId)
    raw.close()

    const reopened = new SqliteRuntimeSessionBindingStore(path)
    await expect(reopened.put(original)).rejects.toBeInstanceOf(
      RuntimeSessionBindingCorruptionError
    )
    await expect(reopened.getById(original.bindingId)).rejects.toBeInstanceOf(
      RuntimeSessionBindingCorruptionError
    )
    await expect(
      reopened.listByController(original.controllerId)
    ).rejects.toBeInstanceOf(RuntimeSessionBindingCorruptionError)
    reopened.close()
  })

  it('fails closed when indexed identity disagrees with valid JSON', async () => {
    const path = await databasePath()
    const store = new SqliteRuntimeSessionBindingStore(path)
    const original = binding('binding-1', 'conversation-1')
    await store.put(original)
    store.close()

    const raw = new DatabaseSync(path)
    raw
      .prepare(`
        UPDATE runtime_session_bindings
        SET controller_id = ?
        WHERE binding_id = ?
      `)
      .run('controller-corrupt', original.bindingId)
    raw.close()

    const reopened = new SqliteRuntimeSessionBindingStore(path)
    await expect(reopened.getById(original.bindingId)).rejects.toBeInstanceOf(
      RuntimeSessionBindingCorruptionError
    )
    reopened.close()
  })
})

describe('RuntimeSessionBindingStore lifecycle parity', () => {
  const temporaryDirectories: string[] = []

  afterEach(async () => {
    await Promise.all(
      temporaryDirectories.splice(0).map((directory) =>
        rm(directory, { recursive: true, force: true })
      )
    )
  })

  it('enforces the same legal and terminal transitions in both stores', async () => {
    const directory = await mkdtemp(
      join(tmpdir(), 'goodbuddy-runtime-bindings-parity-')
    )
    temporaryDirectories.push(directory)
    const sqliteStore = new SqliteRuntimeSessionBindingStore(
      join(directory, 'bindings.sqlite')
    )
    const stores: Array<{
      store:
        | MemoryRuntimeSessionBindingStore
        | SqliteRuntimeSessionBindingStore
      close(): void
    }> = [
      {
        store: new MemoryRuntimeSessionBindingStore(),
        close() {}
      },
      {
        store: sqliteStore,
        close() {
          sqliteStore.close()
        }
      }
    ]

    for (const entry of stores) {
      const original = binding('binding-1', 'conversation-1')
      const running = {
        ...original,
        state: 'prompt-running' as const,
        activePromptOperationId: 'operation-1'
      }
      await entry.store.put(original)
      await entry.store.put(running)
      const advancedRunning = {
        ...running,
        lastOutboundJournaledSequence: '1'
      }
      await entry.store.put(advancedRunning)
      await expect(
        entry.store.put(running)
      ).rejects.toBeInstanceOf(RuntimeSessionBindingConflictError)
      await expect(
        entry.store.put({
          ...advancedRunning,
          activePromptOperationId: 'operation-2'
        })
      ).rejects.toBeInstanceOf(RuntimeSessionBindingConflictError)
      const ready = {
        ...advancedRunning,
        state: 'ready' as const,
        activePromptOperationId: undefined
      }
      await entry.store.put(ready)
      await entry.store.put({
        ...ready,
        state: 'interrupted'
      })
      await expect(
        entry.store.put(ready)
      ).rejects.toBeInstanceOf(RuntimeSessionBindingConflictError)
      const interrupted = {
        ...ready,
        state: 'interrupted' as const,
        lastOutboundJournaledSequence: '2'
      }
      await entry.store.put(interrupted)
      await entry.store.put({
        ...interrupted,
        state: 'closed'
      })
      await expect(
        entry.store.put(ready)
      ).rejects.toBeInstanceOf(RuntimeSessionBindingConflictError)

      const directReady = binding('binding-2', 'conversation-2')
      await entry.store.put(directReady)
      await entry.store.put({
        ...directReady,
        state: 'ready'
      })
      entry.close()
    }
  })

  it('caps rows by pruning only closed bindings in both stores', async () => {
    const directory = await mkdtemp(
      join(tmpdir(), 'goodbuddy-runtime-bindings-cap-')
    )
    temporaryDirectories.push(directory)
    const sqliteStore = new SqliteRuntimeSessionBindingStore(
      join(directory, 'bindings.sqlite'),
      { maximumRows: 3 }
    )
    const stores = [
      {
        store: new MemoryRuntimeSessionBindingStore({ maximumRows: 3 }),
        close() {}
      },
      {
        store: sqliteStore,
        close() {
          sqliteStore.close()
        }
      }
    ]

    for (const entry of stores) {
      const authority = {
        ...binding('binding-live', 'conversation-live'),
        state: 'interrupted' as const
      }
      const closed = {
        ...binding('binding-closed', 'conversation-closed'),
        state: 'closed' as const
      }
      const unknown = {
        ...binding('binding-unknown', 'conversation-unknown'),
        state: 'outcome-unknown' as const,
        activePromptOperationId: 'operation-unknown'
      }
      await entry.store.put(authority)
      await entry.store.put(unknown)
      await entry.store.put(closed)
      await entry.store.put(binding('binding-new', 'conversation-new'))

      await expect(
        entry.store.getById(closed.bindingId)
      ).resolves.toBeUndefined()
      await expect(
        entry.store.getById(authority.bindingId)
      ).resolves.toEqual(authority)
      await expect(
        entry.store.getById(unknown.bindingId)
      ).resolves.toEqual(unknown)
      await expect(
        entry.store.put(binding('binding-over', 'conversation-over'))
      ).rejects.toBeInstanceOf(RuntimeSessionBindingConflictError)
      await expect(
        entry.store.getById(authority.bindingId)
      ).resolves.toEqual(authority)
      entry.close()
    }
  })

  it('prunes closed rows deterministically and paginates both stores', async () => {
    const directory = await mkdtemp(
      join(tmpdir(), 'goodbuddy-runtime-bindings-page-')
    )
    temporaryDirectories.push(directory)
    const sqliteStore = new SqliteRuntimeSessionBindingStore(
      join(directory, 'bindings.sqlite'),
      { maximumRows: 10 }
    )
    const stores = [
      {
        store: new MemoryRuntimeSessionBindingStore({ maximumRows: 10 }),
        close() {}
      },
      {
        store: sqliteStore,
        close() {
          sqliteStore.close()
        }
      }
    ]

    for (const entry of stores) {
      for (const id of ['binding-3', 'binding-1', 'binding-2']) {
        await entry.store.put(binding(id, `conversation-${id}`))
      }
      const firstPage = await entry.store.listByController('controller-1', {
        limit: 2
      })
      expect(firstPage.map((item) => item.bindingId)).toEqual([
        'binding-1',
        'binding-2'
      ])
      await expect(
        entry.store.listByController('controller-1', {
          limit: 2,
          afterBindingId: 'binding-2'
        })
      ).resolves.toMatchObject([{ bindingId: 'binding-3' }])
      await expect(
        entry.store.listByController('controller-1', { limit: 1_001 })
      ).rejects.toBeInstanceOf(RangeError)

      await entry.store.put({
        ...(await entry.store.getById('binding-1'))!,
        state: 'closed'
      })
      await entry.store.put({
        ...(await entry.store.getById('binding-2'))!,
        state: 'closed'
      })
      await expect(entry.store.pruneClosed(1)).resolves.toBe(1)
      await expect(entry.store.pruneClosed(1_001)).rejects.toBeInstanceOf(
        RangeError
      )
      await expect(
        entry.store.getById('binding-1')
      ).resolves.toBeUndefined()
      await expect(
        entry.store.getById('binding-2')
      ).resolves.toBeDefined()
      await expect(
        entry.store.getById('binding-3')
      ).resolves.toBeDefined()
      entry.close()
    }
  })
})

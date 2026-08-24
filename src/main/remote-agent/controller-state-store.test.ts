import { describe, expect, it } from 'vitest'
import {
  ControllerStateStore,
  type ControllerConnectionState,
  type ControllerStateFile,
  type PersistedControllerState
} from './controller-state-store'

class MemoryStateFile implements ControllerStateFile {
  value?: unknown
  writes = 0

  async read(): Promise<unknown | undefined> {
    return structuredClone(this.value)
  }

  async write(value: PersistedControllerState): Promise<void> {
    this.value = structuredClone(value)
    this.writes += 1
  }
}

const connection: ControllerConnectionState = {
  cacheKey: 'a'.repeat(64),
  hostId: 'host-1',
  installationId: 'agent-v1',
  protocolMajor: 1,
  previousConnectionId: 'connection-1',
  previousGeneration: 2,
  daemonBootId: 'boot-1',
  capabilityGeneration: 3,
  acpBindings: [
    {
      bindingId: 'binding-1',
      channelId: 'binding-1',
      channelEpoch: '7',
      cursors: {
        lastOutboundJournaledSequence: '4',
        lastOutboundDeliveredSequence: '4',
        lastInboundJournaledSequence: '6',
        lastMainAckSequence: '5'
      }
    }
  ]
}

describe('ControllerStateStore', () => {
  it('creates one stable controller ID and persists only active recovery state', async () => {
    const file = new MemoryStateFile()
    const first = new ControllerStateStore(file)
    const controllerId = await first.getControllerId()
    await first.updateConnection(connection)
    first.dispose()

    const second = new ControllerStateStore(file)
    expect(await second.getControllerId()).toBe(controllerId)
    expect(await second.getConnection(connection.cacheKey)).toEqual(
      connection
    )
    const serialized = JSON.stringify(file.value)
    expect(serialized).not.toMatch(
      /password|secret|token|payload|result|hostname/iu
    )
  })

  it('isolates host invalidation from other cached identities', async () => {
    const file = new MemoryStateFile()
    const store = new ControllerStateStore(file)
    await store.updateConnection(connection)
    await store.updateConnection({
      ...connection,
      cacheKey: 'b'.repeat(64),
      hostId: 'host-2',
      previousConnectionId: 'connection-2'
    })
    await store.invalidateHost('host-1')
    expect(await store.getConnection('a'.repeat(64))).toBeUndefined()
    expect(await store.getConnection('b'.repeat(64))).toMatchObject({
      hostId: 'host-2'
    })
  })

  it('reads legacy synchronization fields but omits them from new writes', async () => {
    const file = new MemoryStateFile()
    file.value = {
      version: 1,
      controllerId: 'controller-1',
      connections: [
        {
          ...connection,
          eventCursors: [
            {
              streamId: 'run-1',
              streamEpoch: '1',
              acknowledgedSequence: '8'
            }
          ],
          nonterminalOperationIds: ['operation-1'],
          acpBindingIds: ['binding-1']
        }
      ]
    }
    const store = new ControllerStateStore(file)
    await expect(store.getConnection(connection.cacheKey)).resolves.toEqual(
      connection
    )
    await store.updateConnection(connection)
    expect(file.value).toEqual({
      version: 1,
      controllerId: 'controller-1',
      connections: [connection]
    })
  })

  it('rejects duplicate ACP bindings and unknown persisted fields', async () => {
    const file = new MemoryStateFile()
    const store = new ControllerStateStore(file)
    expect(() =>
      store.updateConnection({
        ...connection,
        acpBindings: [
          connection.acpBindings[0]!,
          connection.acpBindings[0]!
        ]
      })
    ).toThrow(/unique/iu)
    file.value = {
      version: 1,
      controllerId: 'controller-1',
      connections: [],
      password: 'must-not-load'
    }
    const malformed = new ControllerStateStore(file)
    await expect(malformed.getControllerId()).rejects.toThrow()
  })

  it('atomically advances and removes one ACP recovery binding', async () => {
    const file = new MemoryStateFile()
    const store = new ControllerStateStore(file)
    await store.updateConnection(connection)
    await store.updateAcpBinding(
      connection.cacheKey,
      'binding-1',
      {
        ...connection.acpBindings[0]!,
        cursors: {
          lastOutboundJournaledSequence: '8',
          lastOutboundDeliveredSequence: '8',
          lastInboundJournaledSequence: '9',
          lastMainAckSequence: '9'
        }
      }
    )
    await expect(
      store.getConnection(connection.cacheKey)
    ).resolves.toMatchObject({
      acpBindings: [
        {
          bindingId: 'binding-1',
          cursors: {
            lastOutboundJournaledSequence: '8',
            lastMainAckSequence: '9'
          }
        }
      ]
    })

    await store.updateAcpBinding(
      connection.cacheKey,
      'binding-1',
      undefined
    )
    await expect(
      store.getConnection(connection.cacheKey)
    ).resolves.toMatchObject({
      acpBindings: []
    })
  })

  it('coalesces many ACP cursor advances into one bounded write', async () => {
    const file = new MemoryStateFile()
    const store = new ControllerStateStore(file)
    await store.updateConnection(connection)
    const writesBeforeCursors = file.writes

    for (let sequence = 10; sequence <= 100; sequence += 1) {
      const value = String(sequence)
      await store.updateAcpBinding(connection.cacheKey, 'binding-1', {
        ...connection.acpBindings[0]!,
        cursors: {
          lastOutboundJournaledSequence: value,
          lastOutboundDeliveredSequence: value,
          lastInboundJournaledSequence: value,
          lastMainAckSequence: value
        }
      })
    }

    expect(file.writes).toBe(writesBeforeCursors)
    await store.flush()
    expect(file.writes).toBe(writesBeforeCursors + 1)
    expect(
      (
        await store.getConnection(connection.cacheKey)
      )?.acpBindings[0]?.cursors.lastMainAckSequence
    ).toBe('100')
  })

  it('enforces cursor monotonicity against pending in-memory state', async () => {
    const file = new MemoryStateFile()
    const store = new ControllerStateStore(file)
    await store.updateConnection(connection)
    await store.updateAcpBinding(connection.cacheKey, 'binding-1', {
      ...connection.acpBindings[0]!,
      cursors: {
        lastOutboundJournaledSequence: '12',
        lastOutboundDeliveredSequence: '12',
        lastInboundJournaledSequence: '12',
        lastMainAckSequence: '12'
      }
    })

    await expect(
      store.updateAcpBinding(connection.cacheKey, 'binding-1', {
        ...connection.acpBindings[0]!,
        cursors: {
          lastOutboundJournaledSequence: '11',
          lastOutboundDeliveredSequence: '11',
          lastInboundJournaledSequence: '12',
          lastMainAckSequence: '12'
        }
      })
    ).rejects.toThrow(/cannot regress/iu)
    await store.flush()
    expect(
      (
        await store.getConnection(connection.cacheKey)
      )?.acpBindings[0]?.cursors.lastOutboundJournaledSequence
    ).toBe('12')
  })
})

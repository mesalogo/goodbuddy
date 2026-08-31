import { describe, expect, it, vi } from 'vitest'
import {
  AGENT_PROTOCOL_VERSION,
  type AttachWelcome,
  type DaemonCapabilities
} from '../../shared/agent-protocol'
import type {
  SshConnectionLease,
  SshConnectionPoolTarget
} from '../ssh/ssh-connection-pool'
import { verifyAgentInstallationId } from '../ssh/ssh-agent-command'
import {
  AgentAttachTransportError,
  type AgentAttachTransport
} from './agent-attach-transport'
import type {
  AgentProtocolClient,
  AgentProtocolMethod
} from './agent-protocol-client'
import {
  ControllerStateStore,
  type ControllerStateFile,
  type PersistedControllerState
} from './controller-state-store'
import {
  RemoteAgentConnectionManager,
  type RemoteAgentSshPool
} from './remote-agent-connection-manager'
import type {
  DesktopDiagnosticFailureObserver
} from '../desktop-diagnostics'

class MemoryStateFile implements ControllerStateFile {
  value?: unknown
  writes = 0

  async read(): Promise<unknown | undefined> {
    return structuredClone(this.value)
  }

  async write(value: PersistedControllerState): Promise<void> {
    this.writes += 1
    this.value = structuredClone(value)
  }
}

class FakeProtocolClient {
  readonly connectionId: string
  readonly generation: number
  capabilitiesGate?: Promise<void>
  resumeGate?: Promise<void>
  capabilities: DaemonCapabilities = {
    generation: 1,
    capabilities: [
      { name: 'workspace/read', version: 1, critical: true }
    ],
    runtimes: []
  }
  disposed = false
  readonly requests: Array<{ method: AgentProtocolMethod; params: unknown }> =
    []
  #closeListeners = new Set<(error: Error) => void>()

  constructor(index = 0) {
    this.connectionId = `connection-${index + 1}`
    this.generation = index + 2
  }

  async request(
    method: AgentProtocolMethod,
    params: unknown
  ): Promise<unknown> {
    this.requests.push({ method, params })
    if (method === 'agent/status') {
      return {
        state: 'ready',
        installationId: 'agent-v1',
        binaryDigest: `sha256:${'a'.repeat(64)}`,
        daemonBootId: 'boot-1',
        agentVersion: '1.0.0',
        protocol: AGENT_PROTOCOL_VERSION,
        platform: 'linux',
        architecture: 'x64',
        supervisor: 'detached-on-demand',
        remoteUserIdentity: 'user-1',
        draining: false
      }
    }
    if (method === 'agent/capabilities') {
      await this.capabilitiesGate
      return structuredClone(this.capabilities)
    }
    if (method === 'controller/resume') {
      await this.resumeGate
      const request = params as {
        daemonBootId: string
        capabilityGeneration: number
      }
      return {
        resumed: true,
        generation: this.generation,
        daemonBootId: request.daemonBootId,
        capabilityGeneration: request.capabilityGeneration,
        leaseDeadlineAt: '2030-01-01T00:00:00.000Z'
      }
    }
    throw new Error(`Unexpected method ${method}`)
  }

  onClose(listener: (error: Error) => void): () => void {
    this.#closeListeners.add(listener)
    return () => this.#closeListeners.delete(listener)
  }

  transportClose(): void {
    for (const listener of this.#closeListeners) {
      listener(new Error('transport closed'))
    }
  }

  dispose(): void {
    this.disposed = true
  }
}

function target(revision = 1): SshConnectionPoolTarget {
  return {
    host: {
      id: 'host-1',
      name: 'Builder',
      hostname: 'builder.example',
      port: 22,
      username: 'goodbuddy',
      authentication: 'password',
      password: 'not-persisted',
      hostKey: {
        algorithm: 'ssh-ed25519',
        publicKeyBase64: 'a2V5',
        fingerprintSha256: `SHA256:${'a'.repeat(43)}`,
        generation: revision
      }
    },
    hostRevision: revision,
    hostKeyGeneration: revision
  }
}

const installation = {
  installationId: verifyAgentInstallationId('agent-v1'),
  binaryDigest: `sha256:${'a'.repeat(64)}`,
  agentVersion: '1.0.0',
  protocol: AGENT_PROTOCOL_VERSION,
  platform: 'linux' as const,
  architecture: 'x64' as const,
  supervisor: 'detached-on-demand' as const,
  requiredCapabilities: [
    { name: 'workspace/read', minimumVersion: 1, critical: true }
  ]
}

function harness(
  connectGate?: Promise<void>,
  reconnectResumeGate?: Promise<void>,
  idleTimeoutMs = 0,
  observeFailure?: DesktopDiagnosticFailureObserver
) {
  let currentTarget = target()
  const release = vi.fn()
  const sshLease = {
    identity: {
      hostId: 'host-1',
      hostRevision: 1,
      hostKeyGeneration: 1,
      authenticationIdentity: 'b'.repeat(64)
    },
    isUsable: () => true,
    release
  } as unknown as SshConnectionLease
  const sshPool: RemoteAgentSshPool = {
    acquire: vi.fn(async () => sshLease),
    disposeHost: vi.fn()
  }
  const resolver = {
    resolve: vi.fn(async () => currentTarget)
  }
  const clients: FakeProtocolClient[] = []
  const stateFile = new MemoryStateFile()
  const connectTransport = vi.fn<
    typeof AgentAttachTransport.connect
  >(async () => {
    await connectGate
    const welcome: AttachWelcome = {
      type: 'goodbuddy-agent-welcome',
      protocol: AGENT_PROTOCOL_VERSION,
      connectionId: `connection-${connectTransport.mock.calls.length}`,
      generation: connectTransport.mock.calls.length + 1,
      installationId: 'agent-v1',
      binaryDigest: `sha256:${'a'.repeat(64)}`,
      daemonBootId: 'boot-1',
      serverNonce: 'server-1'
    }
    return {
      welcome,
      dispose: vi.fn()
    } as unknown as AgentAttachTransport
  })
  const manager = new RemoteAgentConnectionManager({
    resolver,
    sshPool,
    controllerState: new ControllerStateStore(stateFile),
    goodBuddyVersion: '0.11.0',
    idleTimeoutMs,
    observeFailure,
    connectTransport,
    createProtocolClient: () => {
      const client = new FakeProtocolClient(clients.length)
      if (clients.length > 0) {
        client.resumeGate = reconnectResumeGate
      }
      clients.push(client)
      return client as unknown as AgentProtocolClient
    }
  })
  return {
    manager,
    resolver,
    sshPool,
    release,
    connectTransport,
    clients,
    stateFile,
    changeRevision: (revision: number) => {
      currentTarget = target(revision)
    }
  }
}

describe('RemoteAgentConnectionManager', () => {
  it('publishes the aggregate live connection state for each Host', async () => {
    let finishTransport!: () => void
    const gate = new Promise<void>((resolve) => {
      finishTransport = resolve
    })
    const test = harness(gate, undefined, 1_000)
    const states: string[] = []
    const unsubscribe =
      test.manager.onHostConnectionStateChange(({ state }) => {
        states.push(state)
      })

    expect(
      test.manager.getHostConnectionState('host-1')
    ).toBe('disconnected')
    const acquiring = test.manager.acquire('host-1', installation)
    await vi.waitFor(() =>
      expect(states).toEqual(['connecting'])
    )
    finishTransport()
    const lease = await acquiring
    expect(
      test.manager.getHostConnectionState('host-1')
    ).toBe('ready')

    test.clients[0]!.transportClose()
    expect(
      test.manager.getHostConnectionState('host-1')
    ).toBe('error')
    lease.release()
    await test.manager.dispose()

    expect(states).toEqual([
      'connecting',
      'ready',
      'error',
      'disconnected'
    ])
    unsubscribe()
  })

  it('clears a retained connection error when its Host is invalidated', async () => {
    const test = harness()
    const states: string[] = []
    test.manager.onHostConnectionStateChange(({ state }) => {
      states.push(state)
    })
    test.connectTransport.mockRejectedValueOnce(
      new Error('attach failed')
    )

    await expect(
      test.manager.acquire('host-1', installation)
    ).rejects.toThrow()
    expect(
      test.manager.getHostConnectionState('host-1')
    ).toBe('error')

    await test.manager.invalidateHost('host-1')
    expect(
      test.manager.getHostConnectionState('host-1')
    ).toBe('disconnected')
    expect(states).toEqual([
      'connecting',
      'error',
      'disconnected'
    ])
    await test.manager.dispose()
  })

  it('deduplicates concurrent connects and ref-counts the shared connection', async () => {
    const test = harness()
    const [first, second] = await Promise.all([
      test.manager.acquire('host-1', installation),
      test.manager.acquire('host-1', installation)
    ])
    expect(first.client).toBe(second.client)
    expect(test.connectTransport).toHaveBeenCalledTimes(1)
    expect(
      test.connectTransport.mock.calls[0]![0].preface.clientNonce
    ).toMatch(/^[a-f0-9]{48}$/u)
    expect(test.sshPool.acquire).toHaveBeenCalledTimes(1)
    first.release()
    expect(test.release).not.toHaveBeenCalled()
    second.release()
    expect(test.release).toHaveBeenCalledTimes(1)
    await test.manager.dispose()
  })

  it('shares one Host connection across caller capability requirements', async () => {
    const test = harness()
    const workspace = await test.manager.acquire(
      'host-1',
      installation
    )
    test.clients[0]!.capabilities = {
      generation: 2,
      capabilities: [
        { name: 'workspace/read', version: 1, critical: true },
        { name: 'runtime/acp', version: 3, critical: true }
      ],
      runtimes: []
    }
    await workspace.refreshCapabilities()

    const runtime = await test.manager.acquire('host-1', {
      ...installation,
      requiredCapabilities: [
        {
          name: 'runtime/acp',
          exactVersion: 3,
          critical: true
        }
      ]
    })

    expect(runtime.client).toBe(workspace.client)
    expect(test.connectTransport).toHaveBeenCalledOnce()
    runtime.release()
    workspace.release()
    await test.manager.dispose()
  })

  it('rejects only the caller when a shared connection lacks its capability', async () => {
    const test = harness()
    const workspace = await test.manager.acquire(
      'host-1',
      installation
    )

    await expect(
      test.manager.acquire('host-1', {
        ...installation,
        requiredCapabilities: [
          {
            name: 'runtime/acp',
            exactVersion: 3,
            critical: true
          }
        ]
      })
    ).rejects.toMatchObject({
      disposition: 'terminal',
      reason: 'capability'
    })
    expect(workspace.status.state).toBe('ready')
    expect(test.connectTransport).toHaveBeenCalledOnce()

    workspace.release()
    await test.manager.dispose()
  })

  it('does not bind shared connection viability to the first caller requirements', async () => {
    const test = harness(undefined, undefined, 1_000)
    await expect(
      test.manager.acquire('host-1', {
        ...installation,
        requiredCapabilities: [
          {
            name: 'runtime/acp',
            exactVersion: 3,
            critical: true
          }
        ]
      })
    ).rejects.toMatchObject({
      disposition: 'terminal',
      reason: 'capability'
    })

    const workspace = await test.manager.acquire(
      'host-1',
      installation
    )
    expect(test.connectTransport).toHaveBeenCalledOnce()

    workspace.release()
    await test.manager.dispose()
  })

  it('does not persist an unchanged capability refresh', async () => {
    const test = harness()
    const lease = await test.manager.acquire('host-1', installation)
    const writes = test.stateFile.writes

    await lease.refreshCapabilities()

    expect(test.stateFile.writes).toBe(writes)
    lease.release()
    await test.manager.dispose()
  })

  it('isolates cache entries across Host revisions', async () => {
    const test = harness()
    const first = await test.manager.acquire('host-1', installation)
    test.changeRevision(2)
    const second = await test.manager.acquire('host-1', installation)
    expect(first.identity.cacheKey).not.toBe(second.identity.cacheKey)
    expect(test.connectTransport).toHaveBeenCalledTimes(2)
    first.release()
    second.release()
    await test.manager.dispose()
  })

  it('directs registered installation integrity failures to Host repair', async () => {
    const test = harness()
    test.connectTransport.mockRejectedValueOnce(
      new AgentAttachTransportError(
        'Agent attach closed during handshake with diagnostic output',
        'closed',
        undefined,
        'installation-repair-required'
      )
    )

    await expect(
      test.manager.acquire('host-1', installation)
    ).rejects.toMatchObject({
      message: 'GoodBuddy Agent installation needs repair',
      disposition: 'terminal',
      reason: 'protocol'
    })
    expect(test.release).toHaveBeenCalledOnce()
    await test.manager.dispose()
  })

  it('cancels one waiter without canceling a shared connect', async () => {
    let openTransport!: () => void
    const gate = new Promise<void>((resolve) => {
      openTransport = resolve
    })
    const test = harness(gate)
    const controller = new AbortController()
    const canceled = test.manager.acquire(
      'host-1',
      installation,
      controller.signal
    )
    const retained = test.manager.acquire('host-1', installation)
    await vi.waitFor(() =>
      expect(test.connectTransport).toHaveBeenCalledTimes(1)
    )
    controller.abort(new Error('waiter canceled'))
    await expect(canceled).rejects.toThrow('waiter canceled')
    openTransport()
    const lease = await retained
    expect(lease.state).toBe('ready')
    lease.release()
    await test.manager.dispose()
  })

  it('does not report acquisition canceled by its caller', async () => {
    const observeFailure = vi.fn()
    const test = harness(undefined, undefined, 0, observeFailure)
    const controller = new AbortController()
    const cancellation = new Error('caller canceled')
    test.resolver.resolve.mockImplementationOnce(async () => {
      controller.abort(cancellation)
      throw cancellation
    })

    await expect(
      test.manager.acquire(
        'host-1',
        installation,
        controller.signal
      )
    ).rejects.toBe(cancellation)
    expect(observeFailure).not.toHaveBeenCalled()
    await test.manager.dispose()
  })

  it('invalidates every connection for a Host without stopping its daemon', async () => {
    const test = harness()
    const lease = await test.manager.acquire('host-1', installation)
    await test.manager.invalidateHost('host-1')
    expect(test.sshPool.disposeHost).toHaveBeenCalledWith('host-1')
    expect(() => lease.client).toThrow()
    lease.release()
    await test.manager.dispose()
  })

  it('does not publish a connection that finishes after Host invalidation', async () => {
    let finishTransport!: () => void
    const gate = new Promise<void>((resolve) => {
      finishTransport = resolve
    })
    const observeFailure = vi.fn()
    const test = harness(gate, undefined, 0, observeFailure)
    const acquiring = test.manager.acquire('host-1', installation)
    await vi.waitFor(() =>
      expect(test.connectTransport).toHaveBeenCalledOnce()
    )

    await test.manager.invalidateHost('host-1')
    finishTransport()

    await expect(acquiring).rejects.toMatchObject({
      disposition: 'transient',
      reason: 'network'
    })
    expect(test.clients[0]?.disposed).toBe(true)
    expect(test.release).toHaveBeenCalledOnce()
    expect(observeFailure).not.toHaveBeenCalled()
    await test.manager.dispose()
  })

  it('refreshes and validates capabilities on the current client generation', async () => {
    const test = harness()
    const lease = await test.manager.acquire('host-1', installation)
    const refreshed: DaemonCapabilities = {
      generation: 2,
      capabilities: [
        { name: 'workspace/read', version: 1, critical: true },
        { name: 'runtime/acp', version: 3, critical: true }
      ],
      runtimes: [
        {
          runtimeId: 'opencode',
          version: '1.0.0',
          bundleDigest: `sha256:${'b'.repeat(64)}`,
          acpCapabilitiesDigest: `sha256:${'c'.repeat(64)}`,
          sessionLoad: true,
          sessionResume: true
        }
      ]
    }
    test.clients[0]!.capabilities = refreshed

    await expect(lease.refreshCapabilities()).resolves.toEqual(
      refreshed
    )
    expect(lease.capabilities).toEqual(refreshed)

    test.clients[0]!.capabilities = {
      generation: 3,
      capabilities: [
        { name: 'runtime/acp', version: 3, critical: true }
      ],
      runtimes: refreshed.runtimes
    }
    await expect(lease.refreshCapabilities()).rejects.toMatchObject({
      reason: 'capability',
      disposition: 'terminal'
    })
    expect(lease.capabilities).toEqual(
      test.clients[0]!.capabilities
    )
    lease.release()
    await test.manager.dispose()
  })

  it('deduplicates concurrent capability refreshes for shared leases', async () => {
    const test = harness()
    const [first, second] = await Promise.all([
      test.manager.acquire('host-1', installation),
      test.manager.acquire('host-1', installation)
    ])
    let finishRefresh!: () => void
    test.clients[0]!.capabilitiesGate = new Promise<void>((resolve) => {
      finishRefresh = resolve
    })
    test.clients[0]!.capabilities = {
      generation: 2,
      capabilities: [
        { name: 'workspace/read', version: 1, critical: true }
      ],
      runtimes: []
    }
    const requestsBefore = test.clients[0]!.requests.filter(
      (request) => request.method === 'agent/capabilities'
    ).length

    const refreshes = [
      first.refreshCapabilities(),
      second.refreshCapabilities()
    ]
    finishRefresh()

    await expect(Promise.all(refreshes)).resolves.toEqual([
      test.clients[0]!.capabilities,
      test.clients[0]!.capabilities
    ])
    expect(
      test.clients[0]!.requests.filter(
        (request) => request.method === 'agent/capabilities'
      )
    ).toHaveLength(requestsBefore + 1)
    first.release()
    second.release()
    await test.manager.dispose()
  })

  it('rejects versions above an exact capability requirement', async () => {
    const test = harness()
    const lease = await test.manager.acquire('host-1', {
      ...installation,
      requiredCapabilities: [
        {
          name: 'workspace/read',
          exactVersion: 1,
          critical: true
        }
      ]
    })
    test.clients[0]!.capabilities = {
      generation: 2,
      capabilities: [
        { name: 'workspace/read', version: 2, critical: true }
      ],
      runtimes: []
    }

    await expect(lease.refreshCapabilities()).rejects.toMatchObject({
      reason: 'capability',
      disposition: 'terminal'
    })
    lease.release()
    await test.manager.dispose()
  })

  it('refuses capability refresh after its lease is released', async () => {
    const test = harness()
    const lease = await test.manager.acquire('host-1', installation)
    lease.release()
    await expect(lease.refreshCapabilities()).rejects.toThrow(
      'lease is released'
    )
    await test.manager.dispose()
  })

  it('publishes a shared capability refresh for a retained lease', async () => {
    const test = harness()
    const [refreshing, retained] = await Promise.all([
      test.manager.acquire('host-1', installation),
      test.manager.acquire('host-1', installation)
    ])
    let finishRefresh!: () => void
    test.clients[0]!.capabilitiesGate = new Promise<void>((resolve) => {
      finishRefresh = resolve
    })
    test.clients[0]!.capabilities = {
      generation: 2,
      capabilities: [
        { name: 'workspace/read', version: 1, critical: true }
      ],
      runtimes: []
    }

    const refresh = refreshing.refreshCapabilities()
    refreshing.release()
    finishRefresh()

    await expect(refresh).rejects.toThrow('lease is released')
    expect(retained.capabilities.generation).toBe(2)
    retained.release()
    await test.manager.dispose()
  })

  it('proves the exact predecessor tuple and notifies retained leases after a client swap', async () => {
    const test = harness()
    const lease = await test.manager.acquire('host-1', installation)
    const originalClient = lease.client
    await lease.updateAcpBinding('binding-1', {
      bindingId: 'binding-1',
      channelId: 'binding-1',
      channelEpoch: '9',
      cursors: {
        lastOutboundJournaledSequence: '2',
        lastOutboundDeliveredSequence: '2',
        lastInboundJournaledSequence: '4',
        lastMainAckSequence: '3'
      }
    })
    const changed = vi.fn()
    lease.onClientChange?.(changed)

    test.clients[0]!.transportClose()
    expect(lease.state).toBe('offline')
    await lease.reconnect()

    expect(lease.client).not.toBe(originalClient)
    expect(lease.client.generation).toBe(3)
    expect(changed).toHaveBeenCalledOnce()
    expect(
      test.clients[1]!.requests.find(
        (request) => request.method === 'controller/resume'
      )
    ).toEqual({
      method: 'controller/resume',
      params: {
        previousGeneration: 2,
        previousConnectionId: 'connection-1',
        daemonBootId: 'boot-1',
        capabilityGeneration: 1
      }
    })
    lease.release()
    await test.manager.dispose()
  })

  it('persists ACP recovery cursors while the retained transport is offline', async () => {
    const test = harness()
    const lease = await test.manager.acquire('host-1', installation)
    await lease.updateAcpBinding('binding-1', {
      bindingId: 'binding-1',
      channelId: 'binding-1',
      channelEpoch: '9',
      cursors: {
        lastOutboundJournaledSequence: '2',
        lastOutboundDeliveredSequence: '2',
        lastInboundJournaledSequence: '3',
        lastMainAckSequence: '1'
      }
    })
    test.clients[0]!.transportClose()
    expect(lease.state).toBe('offline')

    await expect(
      lease.updateAcpBinding('binding-1', {
        bindingId: 'binding-1',
        channelId: 'binding-1',
        channelEpoch: '9',
        cursors: {
          lastOutboundJournaledSequence: '2',
          lastOutboundDeliveredSequence: '2',
          lastInboundJournaledSequence: '3',
          lastMainAckSequence: '2'
        }
      })
    ).resolves.toBeUndefined()
    await expect(lease.flushAcpBindings()).resolves.toBeUndefined()
    expect(test.stateFile.value).toMatchObject({
      connections: [
        {
          acpBindings: [
            {
              bindingId: 'binding-1',
              cursors: {
                lastMainAckSequence: '2'
              }
            }
          ]
        }
      ]
    })

    lease.release()
    await expect(
      lease.flushAcpBindings()
    ).rejects.toThrow(/released/iu)
    await test.manager.dispose()
  })

  it('preserves ACP cursors persisted while reconnect resume is in flight', async () => {
    let finishResume!: () => void
    const resumeGate = new Promise<void>((resolve) => {
      finishResume = resolve
    })
    const test = harness(undefined, resumeGate)
    const lease = await test.manager.acquire('host-1', installation)
    await lease.updateAcpBinding('binding-1', {
      bindingId: 'binding-1',
      channelId: 'binding-1',
      channelEpoch: '9',
      cursors: {
        lastOutboundJournaledSequence: '2',
        lastOutboundDeliveredSequence: '2',
        lastInboundJournaledSequence: '3',
        lastMainAckSequence: '1'
      }
    })
    await lease.flushAcpBindings()
    test.clients[0]!.transportClose()
    const reconnect = lease.reconnect()
    await vi.waitFor(() =>
      expect(
        test.clients[1]?.requests.some(
          (request) => request.method === 'controller/resume'
        )
      ).toBe(true)
    )

    await lease.updateAcpBinding('binding-1', {
      bindingId: 'binding-1',
      channelId: 'binding-1',
      channelEpoch: '9',
      cursors: {
        lastOutboundJournaledSequence: '2',
        lastOutboundDeliveredSequence: '2',
        lastInboundJournaledSequence: '3',
        lastMainAckSequence: '2'
      }
    })
    await lease.flushAcpBindings()
    finishResume()
    await reconnect

    expect(test.stateFile.value).toMatchObject({
      connections: [
        {
          acpBindings: [
            {
              bindingId: 'binding-1',
              cursors: {
                lastMainAckSequence: '2'
              }
            }
          ]
        }
      ]
    })
    lease.release()
    await test.manager.dispose()
  })

  it('shuts down channels and refuses later acquisition', async () => {
    const test = harness()
    const lease = await test.manager.acquire('host-1', installation)
    await test.manager.dispose()
    expect(test.clients[0]!.disposed).toBe(true)
    expect(() => lease.client).toThrow()
    await expect(
      test.manager.acquire('host-1', installation)
    ).rejects.toMatchObject({ reason: 'shutdown' })
  })

  it('reports classified connect and disconnect failures once', async () => {
    const observeFailure = vi.fn()
    const failed = harness(undefined, undefined, 0, observeFailure)
    failed.connectTransport.mockRejectedValueOnce(
      new Error('provider unavailable')
    )

    await expect(
      failed.manager.acquire('host-1', installation)
    ).rejects.toThrow()
    expect(observeFailure).toHaveBeenCalledWith(
      expect.objectContaining({
        component: 'remote-agent',
        stage: 'connect',
        code: 'remote.connection.network'
      })
    )
    await failed.manager.dispose()

    observeFailure.mockClear()
    const connected = harness(
      undefined,
      undefined,
      0,
      observeFailure
    )
    const lease = await connected.manager.acquire(
      'host-1',
      installation
    )
    connected.clients[0]!.transportClose()
    expect(observeFailure).toHaveBeenCalledWith(
      expect.objectContaining({
        component: 'remote-agent',
        stage: 'disconnect',
        code: 'remote.connection.lost'
      })
    )
    lease.release()
    await connected.manager.dispose()
  })
})

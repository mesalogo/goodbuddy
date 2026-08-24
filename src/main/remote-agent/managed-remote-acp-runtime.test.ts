import { describe, expect, it, vi } from 'vitest'

const remoteHarness = vi.hoisted(() => ({
  instances: [] as Array<{
    options: {
      identity: {
        controllerGeneration: number
        daemonBootIdAtOpen: string
      }
      channelFactory: (bindingId: string) => Promise<unknown>
    }
    dispose: ReturnType<typeof vi.fn>
    runCalls: number
  }>,
  runGate: undefined as Promise<void> | undefined
}))

vi.mock('../agent/acp-remote-runtime', () => ({
  AcpRemoteRuntime: class {
    readonly requiresToolApproval = false
    readonly supportsScopedDataTools = false
    readonly capability = 'chat'
    readonly runtimeId = 'opencode'
    readonly supportsToolExecution = true
    readonly dispose = vi.fn(async () => undefined)
    runCalls = 0

    constructor(
      readonly options: {
        identity: {
          controllerGeneration: number
          daemonBootIdAtOpen: string
        }
        channelFactory: (bindingId: string) => Promise<unknown>
      }
    ) {
      remoteHarness.instances.push(this)
    }

    async getStatus() {
      return {
        id: 'opencode',
        label: 'OpenCode（远程托管）',
        available: true
      }
    }

    async *run(request: { requestId: string }) {
      this.runCalls += 1
      yield {
        requestId: request.requestId,
        type: 'status',
        message: 'running'
      }
      await remoteHarness.runGate
      yield {
        requestId: request.requestId,
        type: 'done',
        sessionId: 'session-1'
      }
    }

    async releaseConversation() {}
    async beginDrain() {}
    async waitForDrain() {}
    async forceShutdown() {
      await this.dispose()
    }
  }
}))

import {
  MemoryRuntimeSessionBindingStore
} from '../agent/runtime-session-binding-store'
import type { SshExecutionSpaceDescriptor } from '../execution-space'
import {
  createManagedRemoteAcpRuntime,
  type ManagedRemoteAcpRuntimeOptions
} from './managed-remote-acp-runtime'

const digest = (value: string): string =>
  `sha256:${value.repeat(64)}`

function descriptor(): SshExecutionSpaceDescriptor {
  return {
    kind: 'ssh',
    hostId: 'host-1',
    remoteRootPath: '/srv/project',
    validation: {
      hostRevision: 2,
      hostKeyGeneration: 3,
      remoteUsername: 'alice',
      workspaceIdentity: 'workspace-1',
      agentProtocolMajor: 1,
      agentInstallationIdAtValidation: 'agent-1',
      agentBinaryDigestAtValidation: digest('a'),
      agentVersionAtValidation: '1.0.0',
      agentArchitectureAtValidation: 'x64',
      validatedAt: '2030-01-01T00:00:00.000Z'
    },
    runtimeValidation: {
      runtimeSelectionKey: 'opencode:default',
      runtimeBundleDigest: digest('b'),
      runtimeAdapterDigest: digest('c'),
      agentInstallationIdAtValidation: 'agent-1',
      validatedAt: '2030-01-01T00:00:00.000Z',
      workMode: 'ask'
    },
    cacheIdentity: 'cache-1',
    routeIdentity: 'route-1',
    workspaceAccess: {
      getIdentity: vi.fn(),
      listDirectory: vi.fn(),
      stat: vi.fn(),
      readText: vi.fn(),
      writeTextAtomic: vi.fn(),
      search: vi.fn(),
      getChanges: vi.fn(),
      dispose: vi.fn()
    }
  }
}

function harness(
  overrides: Partial<ManagedRemoteAcpRuntimeOptions> = {}
) {
  remoteHarness.instances.length = 0
  remoteHarness.runGate = undefined
  const releaseConnection = vi.fn()
  const workspaceAccesses: Array<{
    getIdentity: ReturnType<typeof vi.fn>
    dispose: ReturnType<typeof vi.fn>
  }> = []
  const connection = {
    identity: {
      cacheKey: 'connection-cache',
      hostId: 'host-1',
      hostRevision: 2,
      hostKeyGeneration: 3,
      remoteUsername: 'alice',
      installationId: 'agent-1',
      binaryDigest: digest('a'),
      protocolMajor: 1,
      protocolMinor: 0
    },
    status: {
      state: 'ready',
      draining: false,
      installationId: 'agent-1',
      binaryDigest: digest('a'),
      agentVersion: '1.0.0',
      protocol: { major: 1, minor: 0 },
      daemonBootId: 'boot-1',
      platform: 'linux',
      architecture: 'x64',
      supervisor: 'detached-on-demand'
    },
    capabilities: capabilities(),
    client: { generation: 5 },
    state: 'ready',
    refreshCapabilities: vi.fn(async () => capabilities()),
    reconnect: vi.fn(async () => undefined),
    release: releaseConnection
  }
  const options = {
    executionSpace: descriptor(),
    selection: { provider: 'opencode' as const },
    agentServices: {
      installationManager: {
        ensureInstalled: vi.fn(async () => ({
          installationId: 'agent-1',
          binaryDigest: digest('a'),
          agentVersion: '1.0.0',
          protocol: { major: 1, minor: 0 },
          platform: 'linux' as const,
          architecture: 'x64' as const,
          supervisor: 'detached-on-demand' as const
        }))
      },
      connectionManager: {
        acquire: vi.fn(async () => connection)
      },
      controllerState: {
        getControllerId: vi.fn(async () => 'controller-1')
      }
    },
    runtimeInstallationManager: {
      ensureInstalled: vi.fn(async () => ({
        runtimeId: 'opencode',
        runtimeVersion: '1.18.9',
        bundleDigest: digest('b'),
        manifestDigest: digest('e'),
        runtimeAdapterDigest: digest('c'),
        acpCapabilitiesDigest: digest('f'),
        platform: 'linux' as const,
        architecture: 'x64' as const
      }))
    },
    workspaceAccessFactory: {
      create: vi.fn(() => {
        const access = {
          getIdentity: vi.fn(async () => ({
            kind: 'remote' as const,
            id: 'host-1:workspace-1',
            canonicalDisplayPath: '/srv/project',
            capabilities: {
              read: true,
              write: true,
              search: true,
              changes: true
            }
          })),
          listDirectory: vi.fn(),
          stat: vi.fn(),
          readText: vi.fn(),
          writeTextAtomic: vi.fn(),
          search: vi.fn(),
          getChanges: vi.fn(),
          dispose: vi.fn(async () => undefined)
        }
        workspaceAccesses.push(access)
        return access
      })
    },
    bindingStore: new MemoryRuntimeSessionBindingStore(),
    modelBridge: {
      policy: {
        protocol: 'openai-responses' as const,
        model: 'private-model',
        modelProfileDigest: digest('9'),
        supportsImageInput: false
      },
      channel: {
        dispatch: vi.fn(),
        onDelivered: vi.fn(),
        finalizePrompt: vi.fn(),
        poison: vi.fn()
      }
    },
    ...overrides
  } as unknown as ManagedRemoteAcpRuntimeOptions
  return {
    options,
    connection,
    releaseConnection,
    workspaceAccesses
  }
}

describe('createManagedRemoteAcpRuntime', () => {
  it('binds exact persisted evidence and owns its trust and connection leases', async () => {
    const fixture = harness()
    const runtime = await createManagedRemoteAcpRuntime(
      fixture.options
    )

    await expect(runtime.getStatus()).resolves.toMatchObject({
      id: 'opencode',
      available: true
    })
    expect(
      fixture.options.workspaceAccessFactory.create
    ).not.toHaveBeenCalled()
    expect(
      fixture.options.agentServices.connectionManager.acquire
    ).toHaveBeenCalledWith('host-1', expect.objectContaining({
      requiredCapabilities: [
        { name: 'runtime/acp', exactVersion: 3, critical: true },
        {
          name: 'runtime/model-bridge',
          exactVersion: 1,
          critical: true
        }
      ]
    }))

    await runtime.dispose()
    await runtime.dispose()
    expect(fixture.releaseConnection).toHaveBeenCalledOnce()
  })

  it('recreates the Runtime and reopens the Workspace after reconnect identity changes', async () => {
    const fixture = harness()
    const runtime = await createManagedRemoteAcpRuntime(
      fixture.options
    )

    await collect(runtime.run(request('request-1'), new AbortController().signal))
    expect(remoteHarness.instances).toHaveLength(1)
    expect(remoteHarness.instances[0]!.options.identity).toMatchObject({
      controllerGeneration: 5,
      daemonBootIdAtOpen: 'boot-1'
    })
    expect(fixture.workspaceAccesses).toHaveLength(1)

    fixture.connection.state = 'offline'
    vi.mocked(fixture.connection.reconnect).mockImplementationOnce(async () => {
      fixture.connection.client.generation = 6
      fixture.connection.status.daemonBootId = 'boot-2'
      fixture.connection.state = 'ready'
    })

    await collect(runtime.run(request('request-2'), new AbortController().signal))

    expect(fixture.connection.reconnect).toHaveBeenCalledOnce()
    expect(remoteHarness.instances).toHaveLength(2)
    expect(remoteHarness.instances[0]!.dispose).toHaveBeenCalledOnce()
    expect(remoteHarness.instances[1]!.options.identity).toMatchObject({
      controllerGeneration: 6,
      daemonBootIdAtOpen: 'boot-2'
    })
    expect(fixture.workspaceAccesses).toHaveLength(2)
    expect(
      fixture.workspaceAccesses[0]!.dispose
    ).toHaveBeenCalledOnce()

    await runtime.dispose()
    expect(fixture.workspaceAccesses[1]!.dispose).toHaveBeenCalledOnce()
    expect(fixture.releaseConnection).toHaveBeenCalledOnce()
  })

  it('rejects a stale channel factory lease after a transport change', async () => {
    const fixture = harness()
    const runtime = await createManagedRemoteAcpRuntime(
      fixture.options
    )
    const staleFactory =
      remoteHarness.instances[0]!.options.channelFactory

    fixture.connection.client.generation = 6
    fixture.connection.status.daemonBootId = 'boot-2'

    await expect(staleFactory('binding-1')).rejects.toThrow(
      /transport lease is stale/iu
    )
    expect(fixture.workspaceAccesses).toHaveLength(1)
    await runtime.dispose()
  })

  it('recreates the Runtime when only the daemon boot identity changes', async () => {
    const fixture = harness()
    const runtime = await createManagedRemoteAcpRuntime(
      fixture.options
    )

    await collect(runtime.run(request('request-1'), new AbortController().signal))
    fixture.connection.status.daemonBootId = 'boot-2'
    await collect(runtime.run(request('request-2'), new AbortController().signal))

    expect(remoteHarness.instances).toHaveLength(2)
    expect(remoteHarness.instances[1]!.options.identity).toMatchObject({
      controllerGeneration: 5,
      daemonBootIdAtOpen: 'boot-2'
    })
    expect(fixture.workspaceAccesses).toHaveLength(2)
    await runtime.dispose()
  })

  it('fails closed on reconnect during an active request without replaying it', async () => {
    const fixture = harness()
    const runtime = await createManagedRemoteAcpRuntime(
      fixture.options
    )
    let releaseGate = (): void => undefined
    remoteHarness.runGate = new Promise<void>((resolve) => {
      releaseGate = resolve
    })
    const first = runtime.run(
      request('request-1'),
      new AbortController().signal
    )

    await expect(first.next()).resolves.toMatchObject({
      value: { type: 'status' },
      done: false
    })
    fixture.connection.client.generation = 6
    fixture.connection.status.daemonBootId = 'boot-2'

    await expect(
      runtime
        .run(request('request-2'), new AbortController().signal)
        .next()
    ).rejects.toThrow(/another Runtime request was active/iu)
    expect(remoteHarness.instances).toHaveLength(1)
    expect(remoteHarness.instances[0]!.runCalls).toBe(1)

    releaseGate()
    await collect(first)
    await runtime.dispose()
  })

  it('releases exact trust without connecting when Runtime evidence changed', async () => {
    const fixture = harness()
    vi.mocked(
      fixture.options.runtimeInstallationManager.ensureInstalled
    ).mockResolvedValueOnce({
      runtimeId: 'opencode',
      runtimeVersion: '1.18.9',
      bundleDigest: digest('9'),
      manifestDigest: digest('e'),
      runtimeAdapterDigest: digest('c'),
      acpCapabilitiesDigest: digest('f'),
      platform: 'linux',
      architecture: 'x64'
    })

    await expect(
      createManagedRemoteAcpRuntime(fixture.options)
    ).rejects.toThrow(/does not match project validation/iu)
    expect(
      fixture.options.agentServices.connectionManager.acquire
    ).not.toHaveBeenCalled()
  })

  it('releases both leases when the live Agent identity is stale', async () => {
    const fixture = harness()
    fixture.connection.status.agentVersion = '2.0.0'

    await expect(
      createManagedRemoteAcpRuntime(fixture.options)
    ).rejects.toThrow(/connection does not match/iu)
    expect(fixture.releaseConnection).toHaveBeenCalledOnce()
  })

  it('rejects the obsolete Runtime ACP v1 capability', async () => {
    const fixture = harness()
    vi.mocked(
      fixture.connection.refreshCapabilities
    ).mockResolvedValueOnce({
      ...capabilities(),
      capabilities: [
        { name: 'runtime/acp', version: 1, critical: true }
      ]
    })

    await expect(
      createManagedRemoteAcpRuntime(fixture.options)
    ).rejects.toThrow(/does not advertise/iu)
    expect(fixture.releaseConnection).toHaveBeenCalledOnce()
  })
})

function capabilities() {
  return {
    generation: 7,
    capabilities: [
      { name: 'runtime/acp', version: 3, critical: true },
      {
        name: 'runtime/model-bridge',
        version: 1,
        critical: true
      }
    ],
    runtimes: [
      {
        runtimeId: 'opencode',
        version: '1.18.9',
        bundleDigest: digest('b'),
        acpCapabilitiesDigest: digest('f'),
        sessionLoad: true,
        sessionResume: true
      }
    ]
  }
}

function request(requestId: string) {
  return {
    requestId,
    conversationId: 'conversation-1',
    prompt: 'hello',
    workMode: 'ask' as const
  }
}

async function collect<T>(
  values: AsyncGenerator<T, void, void>
): Promise<T[]> {
  const collected: T[] = []
  for await (const value of values) {
    collected.push(value)
  }
  return collected
}

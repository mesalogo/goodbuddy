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
    beginDrain: ReturnType<typeof vi.fn>
    forceShutdown: ReturnType<typeof vi.fn>
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
    readonly beginDrain = vi.fn(async () => undefined)
    readonly forceShutdown = vi.fn(async () => undefined)
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
    async waitForDrain() {}
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
  const workspaceValidate = vi.fn(async () => ({
    handle: {
      workspaceId: 'workspace-id',
      workspaceIdentity: 'workspace-1',
      canonicalDisplayPath: '/srv/project',
      access: 'read-only' as const,
      git: 'available' as const,
      capabilities: ['list', 'stat', 'read-text', 'search'],
      generation: 1
    },
    validatedAt: '2030-01-01T00:00:00.000Z'
  }))
  const workspaceClose = vi.fn(async (params: {
    workspaceId: string
    generation: number
  }) => ({
    ...params,
    closed: true as const
  }))
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
    client: {
      generation: 5,
      request: vi.fn(async (method: string, params: unknown) => {
        if (method === 'workspace/validate') {
          return await workspaceValidate()
        }
        if (method === 'workspace/close') {
          return await workspaceClose(
            params as {
              workspaceId: string
              generation: number
            }
          )
        }
        throw new Error(`Unexpected method: ${method}`)
      })
    },
    state: 'ready',
    refreshCapabilities: vi.fn(async () => capabilities()),
    reconnect: vi.fn(async () => undefined),
    release: releaseConnection
  }
  const options = {
    executionSpace: descriptor(),
    selection: { provider: 'opencode' as const },
    agentServices: {
      connectionManager: {
        acquire: vi.fn(async () => connection)
      },
      controllerState: {
        getControllerId: vi.fn(async () => 'controller-1')
      },
      installationManager: {
        activateInstalled: vi.fn(async () => ({
          installationId: 'agent-1',
          binaryDigest: digest('a'),
          agentVersion: '1.0.0',
          protocol: { major: 1, minor: 0 },
          platform: 'linux',
          architecture: 'x64',
          supervisor: 'detached-on-demand'
        }))
      }
    },
    runtimeInstallationManager: {
      activateInstalled: vi.fn(async () => ({
        runtimeId: 'opencode',
        runtimeVersion: '1.18.9',
        bundleDigest: digest('b'),
        manifestDigest: digest('d'),
        runtimeAdapterDigest: digest('c'),
        acpCapabilitiesDigest: digest('f'),
        platform: 'linux',
        architecture: 'x64'
      }))
    },
    bindingStore: new MemoryRuntimeSessionBindingStore(),
    modelBridge: {
      policy: {
        protocol: 'openai-responses' as const,
        model: 'private-model',
        modelProfileDigest: digest('9'),
        supportsImageInput: false
      },
      profile: {
        profileId: 'profile-1',
        modelProfileDigest: digest('9'),
        provider: 'openai',
        baseUrl: 'https://provider.example/v1',
        model: 'private-model',
        protocol: 'openai-responses',
        authentication: 'none',
        capabilities: { imageInput: false },
        limits: {
          maximumOutputTokens: 4_096,
          requestTimeoutMilliseconds: 60_000
        }
      }
    },
    ...overrides
  } as unknown as ManagedRemoteAcpRuntimeOptions
  return {
    options,
    connection,
    releaseConnection,
    workspaceValidate,
    workspaceClose
  }
}

describe('createManagedRemoteAcpRuntime', () => {
  it('accepts the current OpenCode model profile independently of persisted validation', async () => {
    const fixture = harness({
      selection: {
        provider: 'opencode',
        profileId: '00000000-0000-4000-8000-000000000099'
      }
    })

    const runtime = await createManagedRemoteAcpRuntime(
      fixture.options
    )

    await expect(runtime.getStatus()).resolves.toMatchObject({
      id: 'opencode',
      available: true
    })
    await runtime.dispose()
  })

  it('rejects non-OpenCode providers before acquiring remote resources', async () => {
    const fixture = harness({
      selection: { provider: 'continue' }
    })

    await expect(
      createManagedRemoteAcpRuntime(fixture.options)
    ).rejects.toThrow(/OpenCode Runtime/iu)
    expect(
      fixture.options.agentServices.connectionManager.acquire
    ).not.toHaveBeenCalled()
  })

  it('binds the current Agent and Runtime and owns its connection lease', async () => {
    const fixture = harness()
    const runtime = await createManagedRemoteAcpRuntime(
      fixture.options
    )

    await expect(runtime.getStatus()).resolves.toMatchObject({
      id: 'opencode',
      available: true
    })
    expect(fixture.workspaceValidate).toHaveBeenCalledOnce()
    expect(
      fixture.connection.refreshCapabilities
    ).toHaveBeenCalledOnce()
    expect(
      fixture.options.runtimeInstallationManager.activateInstalled
    ).toHaveBeenCalledWith('host-1', {
      agentInstallationId: 'agent-1'
    })
    expect(
      fixture.options.agentServices.connectionManager.acquire
    ).toHaveBeenCalledWith('host-1', expect.objectContaining({
      requiredCapabilities: [
        { name: 'runtime/acp', exactVersion: 4, critical: true }
      ]
    }))

    await runtime.dispose()
    await runtime.dispose()
    expect(fixture.releaseConnection).toHaveBeenCalledOnce()
  })

  it('uses the current Host-management transport identity after Host edits', async () => {
    const fixture = harness()
    fixture.connection.identity.hostRevision = 9
    fixture.connection.identity.hostKeyGeneration = 10
    fixture.connection.identity.remoteUsername = 'current-user'

    const runtime = await createManagedRemoteAcpRuntime(
      fixture.options
    )

    expect(remoteHarness.instances[0]!.options.identity).toMatchObject({
      hostRevision: 9,
      hostKeyGeneration: 10
    })
    await runtime.dispose()
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
    expect(fixture.workspaceValidate).toHaveBeenCalledTimes(1)

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
    expect(fixture.workspaceValidate).toHaveBeenCalledTimes(2)
    expect(fixture.workspaceClose).toHaveBeenCalledTimes(1)

    await runtime.dispose()
    expect(fixture.workspaceClose).toHaveBeenCalledTimes(2)
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
    expect(fixture.workspaceValidate).toHaveBeenCalledTimes(2)
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
    expect(fixture.workspaceValidate).toHaveBeenCalledTimes(2)
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

  it('abandons connected runtime ownership on application exit without remote cleanup', async () => {
    const fixture = harness()
    const runtime = await createManagedRemoteAcpRuntime(
      fixture.options
    )
    let finishRun = (): void => undefined
    remoteHarness.runGate = new Promise<void>((resolve) => {
      finishRun = resolve
    })
    const stream = runtime.run(
      request('request-detach'),
      new AbortController().signal
    )

    await expect(stream.next()).resolves.toMatchObject({
      value: { type: 'status' }
    })
    await runtime.detachForApplicationExit?.()
    await runtime.dispose()

    expect(remoteHarness.instances[0]!.beginDrain).not.toHaveBeenCalled()
    expect(remoteHarness.instances[0]!.forceShutdown).not.toHaveBeenCalled()
    expect(remoteHarness.instances[0]!.dispose).not.toHaveBeenCalled()
    expect(fixture.workspaceClose).not.toHaveBeenCalled()
    expect(fixture.releaseConnection).not.toHaveBeenCalled()

    finishRun()
    await collect(stream)
  })

  it('rejects capabilities that differ from the current Runtime', async () => {
    const fixture = harness()
    vi.mocked(
      fixture.connection.refreshCapabilities
    ).mockResolvedValueOnce({
      ...capabilities(),
      runtimes: [
        {
          ...capabilities().runtimes[0]!,
          bundleDigest: digest('9')
        }
      ]
    })

    await expect(
      createManagedRemoteAcpRuntime(fixture.options)
    ).rejects.toThrow(/current OpenCode Runtime/iu)
    expect(fixture.releaseConnection).toHaveBeenCalledOnce()
  })

  it('releases both leases when the live Agent identity is stale', async () => {
    const fixture = harness()
    fixture.connection.status.agentVersion = '2.0.0'

    await expect(
      createManagedRemoteAcpRuntime(fixture.options)
    ).rejects.toThrow(/connection is not current/iu)
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
      { name: 'runtime/acp', version: 4, critical: true }
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

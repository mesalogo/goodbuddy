import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  AGENT_PROTOCOL_VERSION,
  type AgentFrame,
  type AttachWelcome,
  type DaemonCapabilities
} from '../../shared/agent-protocol'
import {
  decodeAgentFrame,
  encodeAgentFrame
} from '../../shared/agent-protocol/frame'
import type {
  RemoteWorkspaceHandle
} from '../../shared/remote-agent-contracts'
import { verifyAgentInstallationId } from '../ssh/ssh-agent-command'
import type { AgentAttachTransport } from './agent-attach-transport'
import { AgentProtocolClient } from './agent-protocol-client'
import type {
  RemoteAgentConnection,
  RemoteAgentConnectionManager,
  RemoteAgentInstallationIdentity
} from './remote-agent-connection-manager'
import {
  ProtocolRemoteWorkspaceTransport,
  ProtocolRemoteWorkspaceTransportError,
  type RemoteWorkspaceInstallationIdentityResolver
} from './protocol-remote-workspace-transport'
import type {
  RemoteWorkspaceProjectBinding,
  RemoteWorkspaceTransportBinding
} from '../workspace/remote-workspace-access'

type ControllerLease = {
  controllerId: string
  connectionId: string
  generation: number
  capabilityGeneration: number
}

type ControllerRegistryLike = {
  attach(controllerId: string): ControllerLease
  assertCurrent(
    controllerId: string,
    generation: number
  ): ControllerLease
  revokeCapabilities(controllerId: string): number
}

type ProtocolMethodHandler = (
  params: unknown,
  context: {
    controller: ControllerLease
    channelId: string
    signal?: AbortSignal
  }
) => unknown | Promise<unknown>

const controllerRegistryModule =
  '../../agent-daemon/controller-registry'
const eventJournalModule = '../../agent-daemon/event-journal'
const protocolServerModule = '../../agent-daemon/protocol-server'
const { ControllerRegistry } = (await import(
  controllerRegistryModule
)) as {
  ControllerRegistry: new () => ControllerRegistryLike
}
const { EventJournal } = (await import(eventJournalModule)) as {
  EventJournal: new (path: string) => { close(): void }
}
const { AgentProtocolServer } = (await import(
  protocolServerModule
)) as {
  AgentProtocolServer: new (options: {
    controllers: ControllerRegistryLike
    events: unknown
    status: () => unknown
    methods: Record<string, ProtocolMethodHandler>
  }) => {
    accept(socket: unknown, controller: ControllerLease): void
  }
}

const temporaryPaths: string[] = []
const digest = `sha256:${'a'.repeat(64)}`
const timestamp = '2026-08-21T00:00:00.000Z'
const binding: RemoteWorkspaceProjectBinding = {
  hostId: 'host-1',
  remoteRootPath: '/srv/project'
}
const installation: RemoteAgentInstallationIdentity = {
  installationId: verifyAgentInstallationId('installation-test'),
  binaryDigest: digest,
  agentVersion: '0.11.0',
  protocol: AGENT_PROTOCOL_VERSION,
  platform: 'linux',
  architecture: 'x64',
  supervisor: 'detached-on-demand'
}
const handle: RemoteWorkspaceHandle = {
  workspaceId: 'workspace-1',
  workspaceIdentity: 'workspace-identity',
  canonicalDisplayPath: binding.remoteRootPath,
  access: 'read-only',
  git: 'available',
  capabilities: [
    'list',
    'stat',
    'read-text',
    'search',
    'git-status',
    'git-diff'
  ],
  generation: 5
}

afterEach(() => {
  for (const path of temporaryPaths.splice(0)) {
    rmSync(path, { recursive: true, force: true })
  }
})

describe('ProtocolRemoteWorkspaceTransport', () => {
  it('bridges fixed validate/read/Git methods through a real protocol client and server', async () => {
    const calls: string[] = []
    const test = createHarness({
      methods: workspaceMethods(calls)
    })
    const durableBinding = transportBinding(test, 1)
    const lease = await test.transport.acquireLease(binding)

    expect(lease.binding).toEqual(durableBinding)
    await expect(
      lease.validateWorkspace({
        remoteRootPath: binding.remoteRootPath,
        requestedAccess: 'read-only',
        requiredCapabilities: [...handle.capabilities]
      })
    ).resolves.toEqual({ handle, validatedAt: timestamp })
    await expect(
      lease.listWorkspace({
        workspaceId: handle.workspaceId,
        generation: handle.generation,
        relativePath: '',
        limit: 10
      })
    ).resolves.toMatchObject({
      entries: [{ relativePath: 'README.md', name: 'README.md' }]
    })
    await expect(
      lease.statWorkspace({
        workspaceId: handle.workspaceId,
        generation: handle.generation,
        relativePath: 'README.md'
      })
    ).resolves.toMatchObject({
      relativePath: 'README.md',
      byteLength: 5
    })
    await expect(
      lease.readWorkspaceText({
        workspaceId: handle.workspaceId,
        generation: handle.generation,
        relativePath: 'README.md',
        offsetBytes: 0,
        maximumBytes: 10
      })
    ).resolves.toMatchObject({ content: 'hello', bytesRead: 5 })
    await expect(
      lease.searchWorkspace({
        workspaceId: handle.workspaceId,
        generation: handle.generation,
        query: 'hello',
        caseSensitive: true,
        limit: 10
      })
    ).resolves.toMatchObject({
      matches: [{ relativePath: 'README.md', line: 1 }]
    })
    await expect(
      lease.getGitStatus({
        workspaceId: handle.workspaceId,
        generation: handle.generation,
        includeIgnored: false,
        maximumEntries: 10
      })
    ).resolves.toMatchObject({
      repositoryIdentity: 'repository-1',
      branch: 'main'
    })
    await expect(
      lease.getGitDiff({
        workspaceId: handle.workspaceId,
        generation: handle.generation,
        staged: false,
        maximumBytes: 100
      })
    ).resolves.toMatchObject({
      repositoryIdentity: 'repository-1',
      patch: '+hello\n'
    })
    await expect(
      lease.closeWorkspace({
        workspaceId: handle.workspaceId,
        generation: handle.generation
      })
    ).resolves.toEqual({
      workspaceId: handle.workspaceId,
      generation: handle.generation,
      closed: true
    })

    expect(calls).toEqual([
      'workspace/validate',
      'workspace/list',
      'workspace/stat',
      'workspace/readText',
      'workspace/search',
      'git/status',
      'git/diff',
      'workspace/close'
    ])
    lease.release()
    expect(test.release).toHaveBeenCalledOnce()
    test.close()
  })

  it('uses the current Host-management transport identity for workspace access', async () => {
    const test = createHarness({
      identity: {
        hostRevision: 99,
        hostKeyGeneration: 100,
        remoteUsername: 'current-user'
      }
    })

    const lease = await test.transport.acquireLease(binding)
    expect(test.release).not.toHaveBeenCalled()
    lease.release()
    expect(test.release).toHaveBeenCalledOnce()
    test.close()
  })

  it('accepts an older compatible Agent protocol minor', async () => {
    const test = createHarness({
      installation: {
        ...installation,
        protocol: {
          major: AGENT_PROTOCOL_VERSION.major,
          minor: AGENT_PROTOCOL_VERSION.minor + 1
        }
      },
      identity: {
        protocolMinor: AGENT_PROTOCOL_VERSION.minor
      },
      connectionStatus: {
        protocol: {
          major: AGENT_PROTOCOL_VERSION.major,
          minor: AGENT_PROTOCOL_VERSION.minor
        }
      }
    })

    const lease = await test.transport.acquireLease(binding)
    lease.release()
    expect(test.release).toHaveBeenCalledOnce()
    test.close()
  })

  it('fails closed for project, installation, status, and capability mismatches', async () => {
    const installationMismatch = createHarness({
      installation: {
        ...installation,
        installationId:
          verifyAgentInstallationId('installation-other')
      }
    })
    await expect(
      installationMismatch.transport.acquireLease(binding)
    ).rejects.toMatchObject({ reason: 'binding-mismatch' })
    expect(installationMismatch.acquire).toHaveBeenCalledOnce()
    expect(installationMismatch.release).toHaveBeenCalledOnce()
    installationMismatch.close()

    const statusMismatch = createHarness({
      connectionStatus: { draining: true }
    })
    await expect(
      statusMismatch.transport.acquireLease(binding)
    ).rejects.toMatchObject({ reason: 'binding-mismatch' })
    expect(statusMismatch.release).toHaveBeenCalledOnce()
    statusMismatch.close()

    const connectionDigestMismatch = createHarness({
      identity: { binaryDigest: `sha256:${'b'.repeat(64)}` }
    })
    await expect(
      connectionDigestMismatch.transport.acquireLease(binding)
    ).rejects.toMatchObject({ reason: 'binding-mismatch' })
    expect(connectionDigestMismatch.release).toHaveBeenCalledOnce()
    connectionDigestMismatch.close()

    for (const changedInstallation of [
      { ...installation, binaryDigest: `sha256:${'b'.repeat(64)}` },
      { ...installation, agentVersion: '0.11.1' },
      { ...installation, architecture: 'arm64' as const }
    ]) {
      const identityMismatch = createHarness({
        installation: changedInstallation
      })
      await expect(
        identityMismatch.transport.acquireLease(binding)
      ).rejects.toMatchObject({ reason: 'binding-mismatch' })
      expect(identityMismatch.acquire).toHaveBeenCalledOnce()
      expect(identityMismatch.release).toHaveBeenCalledOnce()
      identityMismatch.close()
    }

    for (const changedStatus of [
      { binaryDigest: `sha256:${'b'.repeat(64)}` },
      { agentVersion: '0.11.1' },
      { architecture: 'arm64' as const }
    ]) {
      const liveStatusMismatch = createHarness({
        connectionStatus: changedStatus
      })
      await expect(
        liveStatusMismatch.transport.acquireLease(binding)
      ).rejects.toMatchObject({ reason: 'binding-mismatch' })
      expect(liveStatusMismatch.release).toHaveBeenCalledOnce()
      liveStatusMismatch.close()
    }

    const methods = workspaceMethods()
    delete methods['git/diff']
    const capabilityMismatch = createHarness({ methods })
    await expect(
      capabilityMismatch.transport.acquireLease(binding)
    ).rejects.toMatchObject({ reason: 'capability-missing' })
    expect(capabilityMismatch.release).toHaveBeenCalledOnce()
    capabilityMismatch.close()
  })

  it('rejects stale capability generations before dispatching a workspace call', async () => {
    const calls: string[] = []
    const test = createHarness({
      methods: workspaceMethods(calls)
    })
    const lease = await test.transport.acquireLease(binding)
    test.controllers.revokeCapabilities(test.controller.controllerId)

    await expect(
      lease.listWorkspace({
        workspaceId: handle.workspaceId,
        generation: handle.generation,
        relativePath: '',
        limit: 10
      })
    ).rejects.toEqual(
      expect.objectContaining({
        reason: 'stale-generation'
      })
    )
    expect(calls).not.toContain('workspace/list')
    lease.release()
    test.close()
  })

  it('preserves cancellation through AgentProtocolClient requests', async () => {
    let finish!: () => void
    const gate = new Promise<void>((resolveGate) => {
      finish = resolveGate
    })
    const methods = workspaceMethods()
    methods['workspace/readText'] = vi.fn(async () => {
      await gate
      return readResult()
    })
    const test = createHarness({ methods })
    const lease = await test.transport.acquireLease(binding)
    const controller = new AbortController()
    const operation = lease.readWorkspaceText(
      {
        workspaceId: handle.workspaceId,
        generation: handle.generation,
        relativePath: 'README.md',
        offsetBytes: 0,
        maximumBytes: 10
      },
      controller.signal
    )
    await vi.waitFor(() => {
      expect(methods['workspace/readText']).toHaveBeenCalled()
    })
    controller.abort(new Error('read canceled'))

    await expect(operation).rejects.toThrow('read canceled')
    finish()
    lease.release()
    test.close()
  })

  it('keeps one connection reference per lease and makes close and release idempotent', async () => {
    const closeHandler = vi.fn(
      workspaceMethods()['workspace/close']
    )
    const methods = workspaceMethods()
    methods['workspace/close'] = closeHandler
    const test = createHarness({ methods })
    const [first, second] = await Promise.all([
      test.transport.acquireLease(binding),
      test.transport.acquireLease(binding)
    ])
    expect(test.acquire).toHaveBeenCalledTimes(2)
    const request = {
      workspaceId: handle.workspaceId,
      generation: handle.generation
    }

    const [firstClose, duplicateClose] = await Promise.all([
      first.closeWorkspace(request),
      first.closeWorkspace(request)
    ])
    expect(firstClose).toEqual(duplicateClose)
    expect(closeHandler).toHaveBeenCalledOnce()

    first.release()
    first.release()
    expect(test.release).toHaveBeenCalledTimes(1)
    second.release()
    second.release()
    expect(test.release).toHaveBeenCalledTimes(2)
    expect(() => first.binding).toThrow(
      ProtocolRemoteWorkspaceTransportError
    )
    test.close()
  })
})

type HarnessOptions = {
  methods?: Record<string, ProtocolMethodHandler>
  identity?: Partial<RemoteAgentConnection['identity']>
  installation?: RemoteAgentInstallationIdentity
  connectionStatus?: Partial<RemoteAgentConnection['status']>
}

function createHarness(options: HarnessOptions = {}) {
  const root = mkdtempSync(join(tmpdir(), 'goodbuddy-workspace-transport-'))
  temporaryPaths.push(root)
  const controllers = new ControllerRegistry()
  const controller = controllers.attach('controller-test')
  const events = new EventJournal(resolve(root, 'events.sqlite'))
  const status = {
    state: 'ready' as const,
    installationId: installation.installationId,
    binaryDigest: digest,
    daemonBootId: 'boot-test',
    agentVersion: '0.11.0',
    protocol: AGENT_PROTOCOL_VERSION,
    platform: 'linux' as const,
    architecture: 'x64' as const,
    supervisor: 'detached-on-demand' as const,
    remoteUserIdentity: 'uid:1000',
    draining: false,
    ...options.connectionStatus
  }
  const server = new AgentProtocolServer({
    controllers,
    events,
    status: () => status,
    methods: options.methods ?? workspaceMethods()
  })
  const socket = new MemorySocket()
  const transport = new MemoryAgentTransport(socket, controller)
  socket.onWrite = (data) => transport.accept(data)
  server.accept(socket, controller)
  const client = new AgentProtocolClient(
    transport as unknown as AgentAttachTransport
  )
  const release = vi.fn()
  const currentCapabilities = (): DaemonCapabilities => {
    const current = controllers.assertCurrent(
      controller.controllerId,
      controller.generation
    )
    const advertised =
      Object.keys(options.methods ?? workspaceMethods()).length >= 10
    return {
      generation: current.capabilityGeneration,
      capabilities: advertised
        ? [
            {
              name: 'workspace/read',
              version: 1,
              critical: true
            }
          ]
        : [],
      runtimes: []
    }
  }
  const acquire = vi.fn(async () => {
    let released = false
    return {
      identity: {
        cacheKey: 'connection-cache',
        hostId: binding.hostId,
        hostRevision: 2,
        hostKeyGeneration: 3,
        remoteUsername: 'builder',
        installationId: installation.installationId,
        binaryDigest: digest,
        protocolMajor: AGENT_PROTOCOL_VERSION.major,
        protocolMinor: AGENT_PROTOCOL_VERSION.minor,
        ...options.identity
      },
      status,
      get capabilities(): DaemonCapabilities {
        return currentCapabilities()
      },
      client,
      state: 'ready' as const,
      reconnect: async () => undefined,
      refreshCapabilities: async () => currentCapabilities(),
      updateAcpBinding: async () => undefined,
      flushAcpBindings: async () => undefined,
      release: () => {
        if (!released) {
          released = true
          release()
        }
      }
    } satisfies RemoteAgentConnection
  })
  const resolution = {
    installation: options.installation ?? installation
  }
  const resolver: RemoteWorkspaceInstallationIdentityResolver = {
    resolve: vi.fn(async () => resolution)
  }
  const workspaceTransport = new ProtocolRemoteWorkspaceTransport(
    { acquire } as unknown as Pick<
      RemoteAgentConnectionManager,
      'acquire'
    >,
    resolver
  )
  return {
    transport: workspaceTransport,
    controllers,
    controller,
    resolution,
    acquire,
    release,
    close: () => {
      client.dispose()
      socket.destroy()
      events.close()
    }
  }
}

function workspaceMethods(
  calls: string[] = []
): Record<string, ProtocolMethodHandler> {
  const method = (
    name: string,
    result: unknown
  ): ProtocolMethodHandler =>
    vi.fn(async () => {
      calls.push(name)
      return result
    })
  return {
    'workspace/validate': method('workspace/validate', {
      handle,
      validatedAt: timestamp
    }),
    'workspace/open': method('workspace/open', handle),
    'workspace/resume': method('workspace/resume', {
      resumed: true,
      handle
    }),
    'workspace/close': method('workspace/close', {
      workspaceId: handle.workspaceId,
      generation: handle.generation,
      closed: true
    }),
    'workspace/list': method('workspace/list', {
      entries: [
        {
          relativePath: 'README.md',
          name: 'README.md',
          kind: 'file',
          byteLength: 5,
          modifiedAt: timestamp,
          digest,
          executable: false
        }
      ]
    }),
    'workspace/stat': method('workspace/stat', {
      relativePath: 'README.md',
      name: 'README.md',
      kind: 'file',
      byteLength: 5,
      modifiedAt: timestamp,
      digest,
      executable: false
    }),
    'workspace/readText': method('workspace/readText', readResult()),
    'workspace/search': method('workspace/search', {
      matches: [
        {
          relativePath: 'README.md',
          line: 1,
          column: 1,
          snippet: 'hello'
        }
      ],
      truncated: false
    }),
    'git/status': method('git/status', {
      repositoryIdentity: 'repository-1',
      branch: 'main',
      entries: [],
      truncated: false
    }),
    'git/diff': method('git/diff', {
      repositoryIdentity: 'repository-1',
      patch: '+hello\n',
      byteLength: 7,
      truncated: false
    })
  }
}

function readResult() {
  return {
    relativePath: 'README.md',
    content: 'hello',
    offsetBytes: 0,
    bytesRead: 5,
    totalBytes: 5,
    digest,
    truncated: false
  }
}

function transportBinding(
  _test: ReturnType<typeof createHarness>,
  capabilityGeneration: number
): RemoteWorkspaceTransportBinding {
  return {
    hostId: binding.hostId,
    hostRevision: 2,
    hostKeyGeneration: 3,
    remoteUsername: 'builder',
    agentInstallationId: installation.installationId,
    agentBinaryDigest: installation.binaryDigest,
    agentVersion: '0.11.0',
    agentArchitecture: installation.architecture,
    agentProtocolMajor: AGENT_PROTOCOL_VERSION.major,
    capabilityGeneration
  }
}

class MemorySocket extends EventEmitter {
  onWrite?: (data: Uint8Array) => void
  destroyed = false

  pause(): this {
    return this
  }

  resume(): this {
    return this
  }

  write(
    data: Uint8Array,
    callback?: (error?: Error | null) => void
  ): boolean {
    this.onWrite?.(data)
    queueMicrotask(() => callback?.())
    return true
  }

  receive(data: Uint8Array): void {
    this.emit('data', Buffer.from(data))
  }

  destroy(): this {
    if (!this.destroyed) {
      this.destroyed = true
      queueMicrotask(() => this.emit('close'))
    }
    return this
  }
}

class MemoryAgentTransport {
  readonly welcome: AttachWelcome
  #frames: AgentFrame[] = []
  #readers: Array<{
    resolve: (frame: AgentFrame) => void
    reject: (error: unknown) => void
  }> = []
  #closeListeners = new Set<(error: Error) => void>()
  #disposed = false

  constructor(
    private readonly socket: MemorySocket,
    controller: ControllerLease
  ) {
    this.welcome = {
      type: 'goodbuddy-agent-welcome',
      protocol: AGENT_PROTOCOL_VERSION,
      connectionId: controller.connectionId,
      generation: controller.generation,
      installationId: installation.installationId,
      binaryDigest: digest,
      daemonBootId: 'boot-test',
      serverNonce: 'server-test'
    }
  }

  async send(frame: AgentFrame): Promise<void> {
    if (this.#disposed) {
      throw new Error('transport disposed')
    }
    this.socket.receive(encodeAgentFrame(frame))
  }

  receive(): Promise<AgentFrame> {
    const frame = this.#frames.shift()
    if (frame !== undefined) {
      return Promise.resolve(frame)
    }
    return new Promise((resolveFrame, reject) => {
      this.#readers.push({ resolve: resolveFrame, reject })
    })
  }

  accept(data: Uint8Array): void {
    const frame = decodeAgentFrame(data, {
      protocolMajor: AGENT_PROTOCOL_VERSION.major,
      maximumProtocolMinor: AGENT_PROTOCOL_VERSION.minor,
      connectionId: this.welcome.connectionId,
      generation: this.welcome.generation
    })
    const reader = this.#readers.shift()
    if (reader === undefined) {
      this.#frames.push(frame)
    } else {
      reader.resolve(frame)
    }
  }

  onClose(listener: (error: Error) => void): () => void {
    this.#closeListeners.add(listener)
    return () => this.#closeListeners.delete(listener)
  }

  dispose(): void {
    if (this.#disposed) {
      return
    }
    this.#disposed = true
    const error = new Error('transport disposed')
    for (const reader of this.#readers.splice(0)) {
      reader.reject(error)
    }
    for (const listener of this.#closeListeners) {
      listener(error)
    }
    this.#closeListeners.clear()
  }
}

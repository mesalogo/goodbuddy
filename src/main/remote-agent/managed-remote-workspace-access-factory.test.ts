import { describe, expect, it, vi } from 'vitest'
import {
  AGENT_PROTOCOL_VERSION,
  type DaemonCapabilities
} from '../../shared/agent-protocol'
import type { RemoteWorkspaceHandle } from '../../shared/remote-agent-contracts'
import type { RemoteWorkspaceProjectBinding } from '../workspace/remote-workspace-access'
import type { AgentProtocolClient } from './agent-protocol-client'
import {
  ManagedRemoteWorkspaceAccessFactory,
  type ManagedRemoteWorkspaceAccessFactoryOptions
} from './managed-remote-workspace-access-factory'
import type {
  RemoteAgentConnection,
  RemoteAgentConnectionManager
} from './remote-agent-connection-manager'
import type { AgentInstallationIdentity } from './agent-installation-manager'
import { verifyAgentInstallationId } from '../ssh/ssh-agent-command'

const digest = `sha256:${'a'.repeat(64)}`
const binding: RemoteWorkspaceProjectBinding = {
  hostId: '00000000-0000-4000-8000-000000000201',
  remoteRootPath: '/srv/project'
}
const installation: AgentInstallationIdentity = {
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
  generation: 1
}

describe('ManagedRemoteWorkspaceAccessFactory', () => {
  it('opens with the Host current Agent and owns the connection lease', async () => {
    const test = createHarness()
    const access = test.factory.create(binding)

    await expect(access.getIdentity()).resolves.toEqual({
      kind: 'remote',
      id: `${binding.hostId}:${handle.workspaceIdentity}`,
      canonicalDisplayPath: binding.remoteRootPath,
      access: 'read-only'
    })

    expect(test.events.slice(0, 2)).toEqual([
      'installation:activate',
      'connection:acquire'
    ])
    expect(test.activateInstalled).toHaveBeenCalledWith(
      binding.hostId,
      {}
    )
    expect(test.acquire).toHaveBeenCalledWith(
      binding.hostId,
      expect.objectContaining({
        installationId: installation.installationId,
        binaryDigest: installation.binaryDigest,
        agentVersion: installation.agentVersion,
        architecture: installation.architecture,
        protocol: expect.objectContaining({
          major: installation.protocol.major
        })
      }),
      undefined
    )
    expect(test.protocolMethods).toContain('workspace/validate')
    expect(test.protocolMethods).not.toContain('workspace/open')
    expect(test.protocolMethods).not.toContain('workspace/resume')

    await access.dispose()
    await access.dispose()
    expect(test.connectionRelease).toHaveBeenCalledOnce()
    expect(
      test.protocolMethods.filter(
        (method) => method === 'workspace/close'
      )
    ).toHaveLength(1)
  })

  it('propagates connection acquisition failures', async () => {
    const test = createHarness({
      acquireError: new Error('network unavailable')
    })
    const access = test.factory.create(binding)

    await expect(access.getIdentity()).rejects.toThrow(
      'network unavailable'
    )
    expect(test.connectionRelease).not.toHaveBeenCalled()
  })
})

type HarnessOptions = {
  acquireError?: Error
}

function createHarness(options: HarnessOptions = {}): {
  factory: ManagedRemoteWorkspaceAccessFactory
  events: string[]
  protocolMethods: string[]
  acquire: ReturnType<typeof vi.fn>
  activateInstalled: ReturnType<typeof vi.fn>
  connectionRelease: ReturnType<typeof vi.fn>
} {
  const events: string[] = []
  const protocolMethods: string[] = []
  const client = {
    request: vi.fn(async (method: string) => {
      protocolMethods.push(method)
      if (method === 'agent/capabilities') {
        return capabilities
      }
      if (method === 'workspace/validate') {
        return {
          handle,
          validatedAt: '2026-08-21T00:00:00.000Z'
        }
      }
      if (method === 'workspace/close') {
        return {
          workspaceId: handle.workspaceId,
          generation: handle.generation,
          closed: true
        }
      }
      throw new Error(`Unexpected protocol method: ${method}`)
    })
  } as unknown as AgentProtocolClient
  const connectionRelease = vi.fn(() => {
    events.push('connection:release')
  })
  const connection: RemoteAgentConnection = {
    identity: {
      cacheKey: 'connection-cache',
      hostId: binding.hostId,
      hostRevision: 2,
      hostKeyGeneration: 3,
      remoteUsername: 'builder',
      installationId: installation.installationId,
      binaryDigest: installation.binaryDigest,
      protocolMajor: installation.protocol.major,
      protocolMinor: AGENT_PROTOCOL_VERSION.minor
    },
    status: {
      state: 'ready',
      installationId: installation.installationId,
      binaryDigest: installation.binaryDigest,
      daemonBootId: 'boot-1',
      agentVersion: installation.agentVersion,
      protocol: { ...AGENT_PROTOCOL_VERSION },
      platform: 'linux',
      architecture: installation.architecture,
      supervisor: 'detached-on-demand',
      remoteUserIdentity: 'uid:1000',
      draining: false
    },
    capabilities,
    client,
    state: 'ready',
    reconnect: async () => undefined,
    refreshCapabilities: async () => capabilities,
    updateAcpBinding: async () => undefined,
    flushAcpBindings: async () => undefined,
    release: connectionRelease
  }
  const acquire = vi.fn(async () => {
    events.push('connection:acquire')
    if (options.acquireError) {
      throw options.acquireError
    }
    return connection
  })
  const activateInstalled = vi.fn(async () => {
    events.push('installation:activate')
    return installation
  })
  const factoryOptions = {
    connectionManager: {
      acquire
    } as unknown as Pick<RemoteAgentConnectionManager, 'acquire'>,
    installationManager: {
      activateInstalled
    }
  } satisfies ManagedRemoteWorkspaceAccessFactoryOptions
  return {
    factory: new ManagedRemoteWorkspaceAccessFactory(factoryOptions),
    events,
    protocolMethods,
    acquire,
    activateInstalled,
    connectionRelease
  }
}

const capabilities: DaemonCapabilities = {
  generation: 1,
  capabilities: [
    {
      name: 'workspace/read',
      version: 1,
      critical: true
    }
  ],
  runtimes: []
}

import { describe, expect, it, vi } from 'vitest'
import {
  AGENT_PROTOCOL_VERSION,
  type DaemonCapabilities
} from '../../shared/agent-protocol'
import type { RemoteWorkspaceHandle } from '../../shared/remote-agent-contracts'
import type { RemoteWorkspaceProjectBinding } from '../workspace/remote-workspace-access'
import { verifyAgentInstallationId } from '../ssh/ssh-agent-command'
import type {
  AgentInstallationIdentity,
  AgentInstallationManager
} from './agent-installation-manager'
import type { AgentProtocolClient } from './agent-protocol-client'
import {
  ManagedRemoteWorkspaceAccessFactory,
  type ManagedRemoteWorkspaceAccessFactoryOptions
} from './managed-remote-workspace-access-factory'
import type {
  RemoteAgentConnection,
  RemoteAgentConnectionManager
} from './remote-agent-connection-manager'

const digest = `sha256:${'a'.repeat(64)}`
const binding: RemoteWorkspaceProjectBinding = {
  hostId: '00000000-0000-4000-8000-000000000201',
  hostRevision: 2,
  hostKeyGeneration: 3,
  remoteUsername: 'builder',
  remoteRootPath: '/srv/project',
  workspaceIdentity: 'workspace-identity',
  agentInstallationId: 'installation-test',
  agentBinaryDigest: digest,
  agentVersion: '0.11.0',
  agentArchitecture: 'x64',
  agentProtocolMajor: AGENT_PROTOCOL_VERSION.major
}
const installation: AgentInstallationIdentity = {
  installationId: verifyAgentInstallationId(
    binding.agentInstallationId
  ),
  binaryDigest: binding.agentBinaryDigest,
  agentVersion: binding.agentVersion,
  protocol: { ...AGENT_PROTOCOL_VERSION },
  platform: 'linux',
  architecture: binding.agentArchitecture,
  supervisor: 'detached-on-demand'
}
const handle: RemoteWorkspaceHandle = {
  workspaceId: 'workspace-1',
  workspaceIdentity: binding.workspaceIdentity,
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
  it('verifies installation before network work and owns the connection lease', async () => {
    const test = createHarness()
    const access = test.factory.create(binding)

    await expect(access.getIdentity()).resolves.toEqual({
      kind: 'remote',
      id: `${binding.hostId}:${binding.workspaceIdentity}`,
      canonicalDisplayPath: binding.remoteRootPath,
      access: 'read-only'
    })

    expect(test.events.slice(0, 2)).toEqual([
      'agent:ensure',
      'connection:acquire'
    ])
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

  it.each([
    [
      'installation id',
      {
        ...installation,
        installationId:
          verifyAgentInstallationId('installation-other')
      }
    ],
    [
      'binary digest',
      {
        ...installation,
        binaryDigest: `sha256:${'b'.repeat(64)}`
      }
    ],
    ['version', { ...installation, agentVersion: '0.11.1' }],
    ['architecture', { ...installation, architecture: 'arm64' as const }],
    [
      'protocol major',
      {
        ...installation,
        protocol: {
          ...installation.protocol,
          major: installation.protocol.major + 1
        }
      }
    ]
  ])(
    'rejects an installed Agent with a different persisted %s',
    async (_field, changedInstallation) => {
      const test = createHarness({
        ensureInstalled: async () => changedInstallation
      })
      const access = test.factory.create(binding)

      await expect(access.getIdentity()).rejects.toThrow(
        'does not match the persisted project binding'
      )
      expect(test.acquire).not.toHaveBeenCalled()
    }
  )

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
  ensureInstalled?: () => Promise<AgentInstallationIdentity>
}

function createHarness(options: HarnessOptions = {}): {
  factory: ManagedRemoteWorkspaceAccessFactory
  events: string[]
  protocolMethods: string[]
  ensureInstalled: ReturnType<typeof vi.fn>
  acquire: ReturnType<typeof vi.fn>
  connectionRelease: ReturnType<typeof vi.fn>
} {
  const events: string[] = []
  const protocolMethods: string[] = []
  const ensureInstalled = vi.fn(async () => {
    events.push('agent:ensure')
    return options.ensureInstalled
      ? await options.ensureInstalled()
      : installation
  })
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
      hostRevision: binding.hostRevision,
      hostKeyGeneration: binding.hostKeyGeneration,
      remoteUsername: binding.remoteUsername,
      installationId: binding.agentInstallationId,
      binaryDigest: binding.agentBinaryDigest,
      protocolMajor: binding.agentProtocolMajor,
      protocolMinor: installation.protocol.minor
    },
    status: {
      state: 'ready',
      installationId: binding.agentInstallationId,
      binaryDigest: binding.agentBinaryDigest,
      daemonBootId: 'boot-1',
      agentVersion: binding.agentVersion,
      protocol: { ...installation.protocol },
      platform: 'linux',
      architecture: binding.agentArchitecture,
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
  const factoryOptions = {
    installationManager: {
      ensureInstalled
    } as unknown as Pick<AgentInstallationManager, 'ensureInstalled'>,
    connectionManager: {
      acquire
    } as unknown as Pick<RemoteAgentConnectionManager, 'acquire'>
  } satisfies ManagedRemoteWorkspaceAccessFactoryOptions
  return {
    factory: new ManagedRemoteWorkspaceAccessFactory(factoryOptions),
    events,
    protocolMethods,
    ensureInstalled,
    acquire,
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

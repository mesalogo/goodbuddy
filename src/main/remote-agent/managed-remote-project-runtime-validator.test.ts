import { describe, expect, it, vi } from 'vitest'
import type {
  DaemonCapabilities,
  DaemonStatus
} from '../../shared/agent-protocol'
import type { RemoteAgentConnection } from './remote-agent-connection-manager'
import { ManagedRemoteProjectRuntimeValidator } from './managed-remote-project-runtime-validator'
import type { RemoteProjectRuntimeValidationInput } from './remote-project-save-service'
import type { RemoteRuntimeInstallationIdentity } from './remote-runtime-installation-manager'
import type { ResolvedModelProfile } from '../runtime-settings-store'

const digest = (character: string): string =>
  `sha256:${character.repeat(64)}`

const installation: RemoteRuntimeInstallationIdentity = {
  runtimeId: 'opencode',
  runtimeVersion: '1.2.3',
  bundleDigest: digest('b'),
  manifestDigest: digest('c'),
  runtimeAdapterDigest: digest('d'),
  acpCapabilitiesDigest: digest('f'),
  platform: 'linux',
  architecture: 'x64'
}
const modelProfile: ResolvedModelProfile = {
  id: '00000000-0000-4000-8000-000000000001',
  name: 'Private model',
  baseUrl: 'https://provider.example/v1',
  modelName: 'private-model',
  protocol: 'openai-responses',
  authentication: 'api-key',
  apiKey: 'main-only-secret'
}

function advertisedCapabilities(): DaemonCapabilities {
  return {
    generation: 2,
    capabilities: [
      { name: 'workspace/read', version: 1, critical: true },
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
        version: installation.runtimeVersion,
        bundleDigest: installation.bundleDigest,
        acpCapabilitiesDigest:
          installation.acpCapabilitiesDigest,
        sessionLoad: true,
        sessionResume: true
      }
    ]
  }
}

function harness(options: {
  selection?: RemoteProjectRuntimeValidationInput['selection']
  workMode?: 'ask' | 'execute'
  architecture?: 'x64' | 'arm64'
  installed?: RemoteRuntimeInstallationIdentity
  refreshed?: DaemonCapabilities
  modelProfile?: ResolvedModelProfile | null
} = {}) {
  const calls: string[] = []
  const selection =
    options.selection ??
    ({
      provider: 'opencode'
    } as const)
  const workMode = options.workMode ?? 'ask'
  const architecture = options.architecture ?? 'x64'
  const installed = options.installed ?? installation
  let state: RemoteAgentConnection['state'] = 'ready'
  let capabilities: DaemonCapabilities = {
    generation: 1,
    capabilities: [
      { name: 'workspace/read', version: 1, critical: true }
    ],
    runtimes: []
  }
  const status: DaemonStatus = {
    state: 'ready',
    installationId: 'agent-installation',
    binaryDigest: digest('a'),
    daemonBootId: 'daemon-boot',
    agentVersion: '2.0.0',
    protocol: { major: 1, minor: 0 },
    platform: 'linux',
    architecture,
    supervisor: 'detached-on-demand',
    remoteUserIdentity: 'remote-user',
    draining: false
  }
  const refreshCapabilities = vi.fn(async () => {
    calls.push('refresh')
    capabilities = structuredClone(
      options.refreshed ?? advertisedCapabilities()
    )
    return structuredClone(capabilities)
  })
  const connection = {
    identity: {
      cacheKey: 'cache-key',
      hostId: 'host-1',
      hostRevision: 3,
      hostKeyGeneration: 2,
      remoteUsername: 'builder',
      installationId: status.installationId,
      binaryDigest: status.binaryDigest,
      protocolMajor: 1,
      protocolMinor: 0
    },
    status,
    get capabilities() {
      return capabilities
    },
    client: {},
    get state() {
      return state
    },
    refreshCapabilities,
    reconnect: vi.fn(),
    release: vi.fn()
  } as unknown as RemoteAgentConnection
  const ensureInstalled = vi.fn(async () => {
    calls.push('install')
    return installed
  })
  const resolveModelProfile = vi.fn(async () => {
    calls.push('model')
    return options.modelProfile === null
      ? undefined
      : options.modelProfile ?? modelProfile
  })
  const validator = new ManagedRemoteProjectRuntimeValidator({
    installationManager: { ensureInstalled },
    resolveModelProfile,
    now: () => new Date('2030-01-01T00:00:00.000Z')
  })
  const signal = new AbortController().signal
  const input: RemoteProjectRuntimeValidationInput = {
    selection,
    runtimeSelectionKey: `${selection.provider}:${
      'profileId' in selection
        ? selection.profileId ?? 'platform'
        : 'default'
    }`,
    workMode,
    host: {
      hostId: 'host-1',
      hostRevision: 3,
      hostKeyGeneration: 2,
      remoteUsername: 'builder'
    },
    agent: {
      installationId: status.installationId,
      binaryDigest: status.binaryDigest,
      version: status.agentVersion,
      architecture,
      protocolMajor: 1
    },
    workspace: {
      canonicalRemoteRoot: '/srv/project',
      workspaceIdentity: 'workspace-identity',
      workspaceId: 'workspace-id',
      generation: 1,
      access: 'read-only',
      capabilities: ['read-text']
    },
    connection,
    signal
  }
  return {
    validator,
    input,
    connection,
    calls,
    ensureInstalled,
    refreshCapabilities,
    resolveModelProfile,
    setCapabilities: (value: DaemonCapabilities) => {
      capabilities = value
    },
    setState: (value: RemoteAgentConnection['state']) => {
      state = value
    }
  }
}

describe('ManagedRemoteProjectRuntimeValidator', () => {
  it('installs, refreshes, and leases exact Ask Runtime evidence', async () => {
    const test = harness()
    const lease = await test.validator.validate(test.input)

    expect(test.calls).toEqual(['model', 'install', 'refresh'])
    expect(test.ensureInstalled).toHaveBeenCalledWith('host-1', {
      signal: test.input.signal
    })
    expect(lease.evidence).toEqual({
      runtimeSelectionKey: 'opencode:default',
      runtimeBundleDigest: installation.bundleDigest,
      runtimeAdapterDigest: installation.runtimeAdapterDigest,
      agentInstallationIdAtValidation: 'agent-installation',
      validatedAt: '2030-01-01T00:00:00.000Z',
      workMode: 'ask'
    })
    expect(() => lease.assertCurrent()).not.toThrow()

    test.setCapabilities({
      ...advertisedCapabilities(),
      generation: 3
    })
    expect(() => lease.assertCurrent()).toThrow(/stale/iu)
    lease.release()
    lease.release()
    expect(() => lease.assertCurrent()).toThrow(/released/iu)
  })

  it('validates Execute without a second authorization tier', async () => {
    const test = harness({ workMode: 'execute' })
    const lease = await test.validator.validate(test.input)

    expect(lease.evidence).toMatchObject({
      workMode: 'execute'
    })
    test.setState('offline')
    expect(() => lease.assertCurrent()).toThrow(/not ready/iu)
  })

  it('rejects non-OpenCode selections before installation', async () => {
    const test = harness({
      selection: {
        provider: 'model',
        profileId: '00000000-0000-4000-8000-000000000001'
      }
    })

    await expect(test.validator.validate(test.input)).rejects.toThrow(
      /OpenCode Runtime/iu
    )
    expect(test.ensureInstalled).not.toHaveBeenCalled()
    expect(test.refreshCapabilities).not.toHaveBeenCalled()
  })

  it('requires the installed Runtime architecture to exactly match the Agent', async () => {
    const test = harness({ architecture: 'arm64' })

    await expect(test.validator.validate(test.input)).rejects.toThrow(
      /architecture/iu
    )
    expect(test.refreshCapabilities).not.toHaveBeenCalled()
  })

  it('rejects an unavailable model profile before remote installation', async () => {
    const test = harness({ modelProfile: null })

    await expect(test.validator.validate(test.input)).rejects.toThrow(
      /model profile/iu
    )
    expect(test.resolveModelProfile).toHaveBeenCalledOnce()
    expect(test.ensureInstalled).not.toHaveBeenCalled()
    expect(test.refreshCapabilities).not.toHaveBeenCalled()
  })

  it.each([
    [
      'missing model bridge',
      {
        ...advertisedCapabilities(),
        capabilities: [
          { name: 'workspace/read', version: 1, critical: true },
          { name: 'runtime/acp', version: 3, critical: true }
        ]
      }
    ],
    [
      'wrong model bridge version',
      {
        ...advertisedCapabilities(),
        capabilities: [
          { name: 'workspace/read', version: 1, critical: true },
          { name: 'runtime/acp', version: 3, critical: true },
          {
            name: 'runtime/model-bridge',
            version: 3,
            critical: true
          }
        ]
      }
    ],
    [
      'non-critical ACP',
      {
        ...advertisedCapabilities(),
        capabilities: [
          {
            name: 'runtime/acp',
            version: 3,
            critical: false
          }
        ]
      }
    ],
    [
      'wrong ACP version',
      {
        ...advertisedCapabilities(),
        capabilities: [
          {
            name: 'runtime/acp',
            version: 1,
            critical: true
          }
        ]
      }
    ],
    [
      'duplicate OpenCode Runtime',
      {
        ...advertisedCapabilities(),
        runtimes: [
          ...advertisedCapabilities().runtimes,
          ...advertisedCapabilities().runtimes
        ]
      }
    ],
    [
      'wrong Runtime version',
      {
        ...advertisedCapabilities(),
        runtimes: [
          {
            ...advertisedCapabilities().runtimes[0]!,
            version: '9.9.9'
          }
        ]
      }
    ],
    [
      'wrong bundle digest',
      {
        ...advertisedCapabilities(),
        runtimes: [
          {
            ...advertisedCapabilities().runtimes[0]!,
            bundleDigest: digest('9')
          }
        ]
      }
    ],
    [
      'wrong ACP digest',
      {
        ...advertisedCapabilities(),
        runtimes: [
          {
            ...advertisedCapabilities().runtimes[0]!,
            acpCapabilitiesDigest: digest('8')
          }
        ]
      }
    ],
    [
      'missing session load',
      {
        ...advertisedCapabilities(),
        runtimes: [
          {
            ...advertisedCapabilities().runtimes[0]!,
            sessionLoad: false
          }
        ]
      }
    ],
    [
      'missing session resume',
      {
        ...advertisedCapabilities(),
        runtimes: [
          {
            ...advertisedCapabilities().runtimes[0]!,
            sessionResume: false
          }
        ]
      }
    ]
  ])('fails closed for %s advertisement', async (_name, refreshed) => {
    const test = harness({
      refreshed: refreshed as DaemonCapabilities
    })

    await expect(test.validator.validate(test.input)).rejects.toThrow(
      /Runtime|ACP/iu
    )
  })
})

import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { SshConnectionPoolTarget } from '../ssh/ssh-connection-pool'
import type { SshHostStore } from '../ssh/ssh-host-store'
import type { AgentInstallationManager } from './agent-installation-manager'
import type { ControllerStateStore } from './controller-state-store'
import type { RemoteAgentConnectionManager } from './remote-agent-connection-manager'
import {
  RemoteAgentServices,
  type RemoteAgentServicesOptions
} from './remote-agent-services'

type Factories = NonNullable<RemoteAgentServicesOptions['factories']>
type InstallationManagerOptions = Parameters<
  NonNullable<Factories['createAgentInstallationManager']>
>[0]
type ConnectionManagerOptions = Parameters<
  NonNullable<Factories['createConnectionManager']>
>[0]

const target: SshConnectionPoolTarget = {
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
      generation: 1
    }
  },
  hostRevision: 1,
  hostKeyGeneration: 1
}

function harness(overrides: {
  installationDispose?: () => Promise<void>
  connectionDispose?: () => Promise<void>
  controllerFlush?: () => Promise<void>
  controllerDispose?: () => void
  poolDispose?: () => void
  invalidateHost?: (hostId: string) => Promise<void>
} = {}) {
  const resolveConnectionTarget = vi.fn(async () => target)
  const sshHostStore = {
    resolveConnectionTarget
  } as unknown as SshHostStore
  const sshPool = {
    acquire: vi.fn(),
    disposeHost: vi.fn(),
    dispose: vi.fn(overrides.poolDispose ?? (() => undefined))
  }
  const controllerState = {
    flush: vi.fn(overrides.controllerFlush ?? (async () => undefined)),
    dispose: vi.fn(overrides.controllerDispose ?? (() => undefined))
  }
  const installationManager = {
    ensureInstalled: vi.fn(),
    dispose: vi.fn(
      overrides.installationDispose ?? (async () => undefined)
    )
  }
  const connectionManager = {
    acquire: vi.fn(),
    invalidateHost: vi.fn(
      overrides.invalidateHost ?? (async () => undefined)
    ),
    dispose: vi.fn(
      overrides.connectionDispose ?? (async () => undefined)
    )
  }
  const createSshConnectionPool = vi.fn(() => sshPool)
  const createControllerStateStore = vi.fn(
    (filePath: string) => {
      void filePath
      return controllerState as unknown as ControllerStateStore
    }
  )
  const createAgentInstallationManager = vi.fn(
    (options: InstallationManagerOptions) => {
      void options
      return installationManager as unknown as AgentInstallationManager
    }
  )
  const createConnectionManager = vi.fn(
    (options: ConnectionManagerOptions) => {
      void options
      return connectionManager as unknown as RemoteAgentConnectionManager
    }
  )
  const loadAgentBundle = vi.fn()
  const services = new RemoteAgentServices({
    sshHostStore,
    goodBuddyVersion: '0.11.0',
    userDataPath: join('profile', 'GoodBuddy'),
    appPath: join('workspace', 'goodbuddy'),
    resourcesPath: join('installed', 'resources'),
    packaged: false,
    agentPackageManager: {
      loadAgentBundle
    } as never,
    factories: {
      createSshConnectionPool:
        createSshConnectionPool as never,
      createControllerStateStore,
      createAgentInstallationManager,
      createConnectionManager
    }
  })

  return {
    services,
    resolveConnectionTarget,
    sshPool,
    controllerState,
    installationManager,
    connectionManager,
    createSshConnectionPool,
    createControllerStateStore,
    createAgentInstallationManager,
    createConnectionManager,
    loadAgentBundle
  }
}

describe('RemoteAgentServices', () => {
  it('shares one atomic host resolver and SSH pool across services', async () => {
    const instance = harness()
    const installerOptions =
      instance.createAgentInstallationManager.mock.calls[0]?.[0]
    const connectionOptions =
      instance.createConnectionManager.mock.calls[0]?.[0]

    expect(instance.createSshConnectionPool).toHaveBeenCalledOnce()
    expect(installerOptions?.resolver).toBe(
      connectionOptions?.resolver
    )
    expect(installerOptions?.resolver).toBe(
      instance.services.targetResolver
    )
    expect(installerOptions?.sshPool).toBe(connectionOptions?.sshPool)
    expect(installerOptions?.sshPool).toBe(instance.services.sshPool)
    expect(installerOptions?.packageBundleLoader).toBe(
      instance.loadAgentBundle
    )

    await expect(
      instance.services.targetResolver.resolve('host-1')
    ).resolves.toBe(target)
    expect(instance.resolveConnectionTarget).toHaveBeenCalledWith(
      'host-1'
    )
  })

  it('constructs lazily with bundled paths and no host or network work', () => {
    const instance = harness()

    expect(instance.resolveConnectionTarget).not.toHaveBeenCalled()
    expect(instance.sshPool.acquire).not.toHaveBeenCalled()
    expect(instance.installationManager.ensureInstalled).not.toHaveBeenCalled()
    expect(instance.connectionManager.acquire).not.toHaveBeenCalled()
    expect(instance.services.resourcePaths).toEqual({
      keyRegistryPath: join(
        'workspace',
        'goodbuddy',
        'resources',
        'agent-release-keys.json'
      ),
      runtimeLockPath: join(
        'workspace',
        'goodbuddy',
        'agent-runtime-lock.json'
      ),
      bundleDirectories: {
        x64: join(
          'workspace',
          'goodbuddy',
          '.agent-resources',
          'linux-x64'
        ),
        arm64: join(
          'workspace',
          'goodbuddy',
          '.agent-resources',
          'linux-arm64'
        )
      }
    })
    expect(
      instance.createControllerStateStore
    ).toHaveBeenCalledWith(
      join(
        'profile',
        'GoodBuddy',
        'remote-agent-controller-state.json'
      )
    )
  })

  it('keeps default service construction and shutdown lazy', async () => {
    const resolveConnectionTarget = vi.fn(async () => target)
    const services = new RemoteAgentServices({
      sshHostStore: {
        resolveConnectionTarget
      } as unknown as SshHostStore,
      goodBuddyVersion: '0.11.0',
      userDataPath: join('profile', 'GoodBuddy'),
      appPath: join('workspace', 'goodbuddy'),
      resourcesPath: join('installed', 'resources'),
      packaged: false,
      agentPackageManager: {
        loadAgentBundle: vi.fn()
      } as never
    })

    expect(resolveConnectionTarget).not.toHaveBeenCalled()
    await services.dispose()
    expect(resolveConnectionTarget).not.toHaveBeenCalled()
  })

  it('delegates credential-free host invalidation immediately', async () => {
    let finishPersistence: (() => void) | undefined
    const persistence = new Promise<void>((resolve) => {
      finishPersistence = resolve
    })
    const invalidateHost = vi.fn(() => persistence)
    const instance = harness({ invalidateHost })

    const invalidation = instance.services.invalidateHost('host-1')

    expect(invalidateHost).toHaveBeenCalledWith('host-1')
    expect(invalidation).toBe(persistence)
    finishPersistence?.()
    await invalidation
  })

  it('disposes in dependency order once and aggregates failures', async () => {
    const order: string[] = []
    const installerError = new Error('installer failed')
    const connectionError = new Error('connections failed')
    const controllerError = new Error('controller failed')
    const poolError = new Error('pool failed')
    const instance = harness({
      installationDispose: async () => {
        order.push('installer')
        throw installerError
      },
      connectionDispose: async () => {
        order.push('connections')
        throw connectionError
      },
      controllerFlush: async () => {
        order.push('controller-flush')
        throw controllerError
      },
      controllerDispose: () => {
        order.push('controller-dispose')
      },
      poolDispose: () => {
        order.push('ssh-pool')
        throw poolError
      }
    })

    const first = instance.services.dispose()
    const second = instance.services.dispose()

    expect(second).toBe(first)
    const result = await first.catch((error: unknown) => error)

    expect(result).toBeInstanceOf(AggregateError)
    expect((result as AggregateError).errors).toEqual([
      installerError,
      connectionError,
      controllerError,
      poolError
    ])
    expect(order).toEqual([
      'installer',
      'connections',
      'controller-flush',
      'controller-dispose',
      'ssh-pool'
    ])
    expect(instance.installationManager.dispose).toHaveBeenCalledOnce()
    expect(instance.connectionManager.dispose).toHaveBeenCalledOnce()
    expect(instance.controllerState.flush).toHaveBeenCalledOnce()
    expect(instance.controllerState.dispose).toHaveBeenCalledOnce()
    expect(instance.sshPool.dispose).toHaveBeenCalledOnce()
  })
})

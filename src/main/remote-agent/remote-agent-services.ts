import { join } from 'node:path'
import { SshConnectionPool } from '../ssh/ssh-connection-pool'
import type { SshHostStore } from '../ssh/ssh-host-store'
import { AgentInstallationManager } from './agent-installation-manager'
import {
  resolveBundledAgentResourcePaths,
  type BundledAgentResourcePaths
} from './bundled-agent-resources'
import {
  ControllerStateStore,
  JsonControllerStateFile
} from './controller-state-store'
import {
  RemoteAgentConnectionManager,
  type RemoteAgentTargetResolver
} from './remote-agent-connection-manager'

const CONTROLLER_STATE_FILE_NAME = 'remote-agent-controller-state.json'

type RemoteAgentServiceFactories = {
  createSshConnectionPool: () => SshConnectionPool
  createControllerStateStore: (
    filePath: string
  ) => ControllerStateStore
  createAgentInstallationManager: (options: {
    resolver: RemoteAgentTargetResolver
    sshPool: SshConnectionPool
    resourcePaths: BundledAgentResourcePaths
  }) => AgentInstallationManager
  createConnectionManager: (options: {
    resolver: RemoteAgentTargetResolver
    sshPool: SshConnectionPool
    controllerState: ControllerStateStore
    goodBuddyVersion: string
  }) => RemoteAgentConnectionManager
}

export type RemoteAgentServicesOptions = {
  sshHostStore: SshHostStore
  goodBuddyVersion: string
  userDataPath: string
  appPath: string
  resourcesPath: string
  packaged: boolean
  factories?: Partial<RemoteAgentServiceFactories>
}

/**
 * Main-process lifecycle owner for the dormant remote Agent control plane.
 * Construction only composes local objects and paths; network, disk, bundle
 * verification, and installation work remain lazy until an explicit caller
 * uses the corresponding service.
 */
export class RemoteAgentServices {
  readonly targetResolver: RemoteAgentTargetResolver
  readonly resourcePaths: BundledAgentResourcePaths
  readonly sshPool: SshConnectionPool
  readonly controllerState: ControllerStateStore
  readonly installationManager: AgentInstallationManager
  readonly connectionManager: RemoteAgentConnectionManager

  #disposePromise: Promise<void> | undefined

  constructor(options: RemoteAgentServicesOptions) {
    const factories: RemoteAgentServiceFactories = {
      createSshConnectionPool: () => new SshConnectionPool(),
      createControllerStateStore: (filePath) =>
        new ControllerStateStore(new JsonControllerStateFile(filePath)),
      createAgentInstallationManager: (managerOptions) =>
        new AgentInstallationManager(managerOptions),
      createConnectionManager: (managerOptions) =>
        new RemoteAgentConnectionManager(managerOptions),
      ...options.factories
    }

    this.targetResolver = {
      resolve: (hostId) =>
        options.sshHostStore.resolveConnectionTarget(hostId)
    }
    this.resourcePaths = resolveBundledAgentResourcePaths({
      appPath: options.appPath,
      resourcesPath: options.resourcesPath,
      packaged: options.packaged
    })
    this.sshPool = factories.createSshConnectionPool()
    this.controllerState = factories.createControllerStateStore(
      join(options.userDataPath, CONTROLLER_STATE_FILE_NAME)
    )
    this.installationManager =
      factories.createAgentInstallationManager({
        resolver: this.targetResolver,
        sshPool: this.sshPool,
        resourcePaths: this.resourcePaths
      })
    this.connectionManager = factories.createConnectionManager({
      resolver: this.targetResolver,
      sshPool: this.sshPool,
      controllerState: this.controllerState,
      goodBuddyVersion: options.goodBuddyVersion
    })
  }

  /**
   * Invalidates live and persisted controller state. The connection manager
   * closes matching connections and pool entries before its first await, so a
   * credential-free SSH host lifecycle hook starts fail-closed synchronously.
   */
  invalidateHost(hostId: string): Promise<void> {
    return this.connectionManager.invalidateHost(hostId)
  }

  dispose(): Promise<void> {
    this.#disposePromise ??= this.#dispose()
    return this.#disposePromise
  }

  async #dispose(): Promise<void> {
    const errors: unknown[] = []
    const settle = async (
      operation: () => void | Promise<void>
    ): Promise<void> => {
      try {
        await operation()
      } catch (error) {
        errors.push(error)
      }
    }

    await settle(() => this.installationManager.dispose())
    await settle(() => this.connectionManager.dispose())
    await settle(() => this.controllerState.flush())
    await settle(() => this.controllerState.dispose())
    await settle(() => this.sshPool.dispose())

    if (errors.length > 0) {
      throw new AggregateError(
        errors,
        'Remote Agent services failed to dispose completely'
      )
    }
  }
}

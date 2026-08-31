import { join } from 'node:path'
import { SqliteRuntimeSessionBindingStore } from '../agent/runtime-session-binding-store'
import type { ResolvedModelProfile } from '../runtime-settings-store'
import type { AgentRuntimeSelection } from '../../shared/runtime-selection-contracts'
import type { SshHostStore } from '../ssh/ssh-host-store'
import {
  resolveBundledRemoteRuntimeResourcePaths,
  type BundledRemoteRuntimeResourcePaths
} from './bundled-remote-runtime-resources'
import { ManagedRemoteProjectRuntimeValidator } from './managed-remote-project-runtime-validator'
import {
  createManagedRemoteAcpRuntime,
  type ManagedRemoteAcpRuntimeOptions
} from './managed-remote-acp-runtime'
import { ManagedRemoteWorkspaceAccessFactory } from './managed-remote-workspace-access-factory'
import type { RemoteAgentServices } from './remote-agent-services'
import { RemoteProjectSaveService } from './remote-project-save-service'
import {
  RemoteRuntimeInstallationManager,
  type RemoteRuntimeActivator
} from './remote-runtime-installation-manager'
import {
  createManagedModelBridge
} from './managed-model-bridge'
import { boundedDiagnostic } from './bounded-diagnostic'

const RUNTIME_BINDING_DATABASE_NAME = 'remote-runtime-bindings.sqlite'

export type ManagedRemoteExecutionServicesOptions = {
  sshHostStore: SshHostStore
  agentServices: Pick<
    RemoteAgentServices,
    | 'targetResolver'
    | 'sshPool'
    | 'installationManager'
    | 'connectionManager'
    | 'controllerState'
  >
  userDataPath: string
  appPath: string
  resourcesPath: string
  packaged: boolean
  resolveModelProfile(
    selection: AgentRuntimeSelection
  ): Promise<ResolvedModelProfile | undefined>
  resolveRuntimeSelection(
    selection: AgentRuntimeSelection
  ): Promise<AgentRuntimeSelection>
}

/**
 * Main-only lifecycle owner for verified remote execution primitives.
 * Construction performs no SSH or provider work.
 */
export class ManagedRemoteExecutionServices {
  readonly runtimeResourcePaths: BundledRemoteRuntimeResourcePaths
  readonly runtimeInstallationManager: RemoteRuntimeInstallationManager
  readonly runtimeValidator: ManagedRemoteProjectRuntimeValidator
  readonly workspaceAccessFactory: ManagedRemoteWorkspaceAccessFactory
  readonly bindingStore: SqliteRuntimeSessionBindingStore

  #disposePromise?: Promise<void>
  readonly #readiness: Promise<void>
  readonly #resolveRuntimeSelection: ManagedRemoteExecutionServicesOptions['resolveRuntimeSelection']
  readonly #sshHosts: SshHostStore
  readonly #agentServices:
    ManagedRemoteExecutionServicesOptions['agentServices']

  constructor(options: ManagedRemoteExecutionServicesOptions) {
    this.#agentServices = options.agentServices
    this.#resolveRuntimeSelection = options.resolveRuntimeSelection
    this.#sshHosts = options.sshHostStore
    this.runtimeResourcePaths =
      resolveBundledRemoteRuntimeResourcePaths({
        appPath: options.appPath,
        resourcesPath: options.resourcesPath,
        packaged: options.packaged
      })
    const activate: RemoteRuntimeActivator = async (
      lease,
      runtimeId,
      bundleDigest,
      architecture,
      currentAgentInstallationId,
      signal
    ) => {
      const agentInstallationId =
        currentAgentInstallationId ??
        (
          await options.agentServices.installationManager.activateInstalled(
            lease.identity.hostId,
            { signal }
          )
        ).installationId
      signal.throwIfAborted()
      if (runtimeId !== 'opencode') {
        throw new Error(
          'Remote Runtime identity is unsupported'
        )
      }
      const result = await lease.runAgentRuntimeAction(
        agentInstallationId,
        {
          kind: 'runtime-activate',
          runtimeId,
          bundleDigest,
          architecture
        },
        signal
      )
      if (result.exitCode !== 0) {
        const detail = boundedDiagnostic(
          `${result.stderr}\n${result.stdout}`
        )
        throw new Error(
          detail.length > 0
            ? `Remote Runtime activation failed: ${detail}`
            : `Remote Runtime activation failed (exit ${String(result.exitCode)})`
        )
      }
    }
    this.runtimeInstallationManager =
      new RemoteRuntimeInstallationManager({
        resolver: options.agentServices.targetResolver,
        sshPool: options.agentServices.sshPool,
        activate
      })
    this.runtimeValidator = new ManagedRemoteProjectRuntimeValidator({
      installationManager: this.runtimeInstallationManager,
      resolveModelProfile: options.resolveModelProfile
    })
    this.workspaceAccessFactory =
      new ManagedRemoteWorkspaceAccessFactory({
        connectionManager: options.agentServices.connectionManager,
        installationManager:
          options.agentServices.installationManager
      })
    this.bindingStore = new SqliteRuntimeSessionBindingStore(
      join(options.userDataPath, RUNTIME_BINDING_DATABASE_NAME)
    )
    this.#readiness = Promise.resolve()
  }

  createProjectSaveService(
    options: Pick<
      ConstructorParameters<typeof RemoteProjectSaveService>[0],
      'database' | 'notify'
    >
  ): RemoteProjectSaveService {
    return new RemoteProjectSaveService({
      database: options.database,
      sshHosts: this.#sshHosts,
      installationManager:
        this.#agentServices.installationManager,
      connectionManager: this.#agentServices.connectionManager,
      resolveRuntimeSelection: this.#resolveRuntimeSelection,
      runtimeValidator: this.runtimeValidator,
      ...(options.notify ? { notify: options.notify } : {})
    })
  }

  async initialize(): Promise<void> {
    await this.#readiness
  }

  invalidateHost(hostId: string): void {
    this.runtimeInstallationManager.invalidateHost(hostId)
  }

  async createRuntime(
    options: Pick<
      ManagedRemoteAcpRuntimeOptions,
      'executionSpace' | 'selection' | 'usage'
    > & {
      modelProfile: ResolvedModelProfile
    }
  ) {
    await this.#readiness
    const modelBridge = createManagedModelBridge({
      profile: options.modelProfile
    })
    return createManagedRemoteAcpRuntime({
      ...options,
      modelBridge,
      agentServices: {
        connectionManager: this.#agentServices.connectionManager,
        controllerState: this.#agentServices.controllerState,
        installationManager:
          this.#agentServices.installationManager
      },
      runtimeInstallationManager: this.runtimeInstallationManager,
      bindingStore: this.bindingStore
    })
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
    await settle(() => this.runtimeInstallationManager.dispose())
    await settle(() => this.bindingStore.dispose())
    if (errors.length > 0) {
      throw new AggregateError(
        errors,
        'Managed remote execution services failed to dispose completely'
      )
    }
  }
}

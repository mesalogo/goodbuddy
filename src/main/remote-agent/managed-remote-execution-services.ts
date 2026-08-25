import { join } from 'node:path'
import { SqliteRuntimeSessionBindingStore } from '../agent/runtime-session-binding-store'
import { ModelCallOperationStore } from '../agent/model-call-operation-store'
import { RemoteModelGateway } from '../agent/remote-model-gateway'
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
  createManagedModelBridge,
  reconcileStartupModelCalls
} from './managed-model-bridge'
import type {
  AgentPackageManager
} from './agent-package-manager'

const RUNTIME_BINDING_DATABASE_NAME = 'remote-runtime-bindings.sqlite'
const MODEL_CALL_DATABASE_NAME = 'remote-model-calls-v2.sqlite'

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
  agentPackageManager: Pick<
    AgentPackageManager,
    'loadRuntimeBundle' | 'loadRuntimeMetadata'
  >
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
  readonly modelCallStore: ModelCallOperationStore
  readonly modelGateway: RemoteModelGateway

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
      signal
    ) => {
      const agent =
        await options.agentServices.installationManager.ensureInstalled(
          lease.identity.hostId,
          { signal }
        )
      signal.throwIfAborted()
      const current = await options.agentServices.targetResolver.resolve(
        lease.identity.hostId
      )
      signal.throwIfAborted()
      if (
        runtimeId !== 'opencode' ||
        current.host.id !== lease.identity.hostId ||
        current.hostRevision !== lease.identity.hostRevision ||
        current.hostKeyGeneration !==
          lease.identity.hostKeyGeneration ||
        agent.architecture !== architecture
      ) {
        throw new Error(
          'Remote Agent or SSH host identity changed before Runtime activation'
        )
      }
      const result = await lease.runAgentRuntimeAction(
        agent.installationId,
        {
          kind: 'runtime-activate',
          runtimeId,
          bundleDigest,
          architecture
        },
        signal
      )
      if (result.exitCode !== 0) {
        throw new Error('Remote Runtime activation failed')
      }
    }
    this.runtimeInstallationManager =
      new RemoteRuntimeInstallationManager({
        resolver: options.agentServices.targetResolver,
        sshPool: options.agentServices.sshPool,
        loadVerifiedBundle:
          options.agentPackageManager.loadRuntimeBundle,
        loadVerificationMetadata:
          options.agentPackageManager.loadRuntimeMetadata,
        activate
      })
    this.runtimeValidator = new ManagedRemoteProjectRuntimeValidator({
      installationManager: this.runtimeInstallationManager,
      resolveModelProfile: options.resolveModelProfile
    })
    this.workspaceAccessFactory =
      new ManagedRemoteWorkspaceAccessFactory({
        installationManager:
          options.agentServices.installationManager,
        connectionManager: options.agentServices.connectionManager
      })
    this.bindingStore = new SqliteRuntimeSessionBindingStore(
      join(options.userDataPath, RUNTIME_BINDING_DATABASE_NAME)
    )
    this.modelCallStore = new ModelCallOperationStore(
      join(options.userDataPath, MODEL_CALL_DATABASE_NAME)
    )
    this.modelGateway = new RemoteModelGateway({
      store: this.modelCallStore
    })
    this.#readiness = reconcileStartupModelCalls({
      gatewayStore: this.modelCallStore,
      bindingStore: this.bindingStore
    })
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
      profile: options.modelProfile,
      gateway: this.modelGateway,
      bindingStore: this.bindingStore
    })
    return createManagedRemoteAcpRuntime({
      ...options,
      modelBridge,
      agentServices: {
        installationManager:
          this.#agentServices.installationManager,
        connectionManager: this.#agentServices.connectionManager,
        controllerState: this.#agentServices.controllerState
      },
      runtimeInstallationManager:
        this.runtimeInstallationManager,
      workspaceAccessFactory: this.workspaceAccessFactory,
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
    await settle(() => this.modelCallStore.dispose())
    if (errors.length > 0) {
      throw new AggregateError(
        errors,
        'Managed remote execution services failed to dispose completely'
      )
    }
  }
}

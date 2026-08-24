import type { AgentRuntimeSelection } from '../../shared/runtime-selection-contracts'
import {
  AcpRemoteRuntime,
  type AcpRemoteRuntimeOptions
} from '../agent/acp-remote-runtime'
import type {
  AgentExecutionRequest,
  AgentRuntime,
  RuntimeAuthorizer,
  RuntimeEvent
} from '../agent/runtime'
import type { RuntimeSessionBindingStore } from '../agent/runtime-session-binding-store'
import type { SshExecutionSpaceDescriptor } from '../execution-space'
import type { RemoteWorkspaceProjectBinding } from '../workspace'
import { createProtocolRemoteRuntimeChannel } from './protocol-remote-runtime-channel'
import type { RemoteAgentServices } from './remote-agent-services'
import type { ManagedRemoteWorkspaceAccessFactory } from './managed-remote-workspace-access-factory'
import type { ManagedModelBridge } from './managed-model-bridge'
import type { RemoteRuntimeInstallationManager } from './remote-runtime-installation-manager'

const RUNTIME_ACP_CAPABILITY = {
  name: 'runtime/acp',
  exactVersion: 3,
  critical: true
} as const
const RUNTIME_MODEL_BRIDGE_CAPABILITY = {
  name: 'runtime/model-bridge',
  exactVersion: 1,
  critical: true
} as const

type ManagedRemoteTransportIdentity = {
  controllerGeneration: number
  daemonBootId: string
}

export type ManagedRemoteAcpRuntimeOptions = {
  executionSpace: SshExecutionSpaceDescriptor
  selection: AgentRuntimeSelection
  agentServices: Pick<
    RemoteAgentServices,
    'installationManager' | 'connectionManager' | 'controllerState'
  >
  runtimeInstallationManager: Pick<
    RemoteRuntimeInstallationManager,
    'ensureInstalled'
  >
  workspaceAccessFactory: Pick<
    ManagedRemoteWorkspaceAccessFactory,
    'create'
  >
  bindingStore: RuntimeSessionBindingStore
  modelBridge: ManagedModelBridge
  usage?: {
    provider: string
    model: string
  }
}

/**
 * Acquires every production lease needed by one validated remote Runtime.
 * The returned Runtime owns those leases and releases them only after all ACP
 * conversation channels have been closed.
 */
export async function createManagedRemoteAcpRuntime(
  options: ManagedRemoteAcpRuntimeOptions
): Promise<AgentRuntime> {
  const descriptor = options.executionSpace
  const validation = descriptor.validation
  const runtimeValidation = descriptor.runtimeValidation
  if (
    options.selection.provider !== 'opencode' ||
    validation === undefined ||
    runtimeValidation === undefined
  ) {
    throw new Error(
      'Managed remote execution requires validated OpenCode project evidence'
    )
  }
  const workspaceBinding = workspaceProjectBinding(descriptor)
  let connection:
    | Awaited<
        ReturnType<
          RemoteAgentServices['connectionManager']['acquire']
        >
      >
    | undefined
  let retained = false
  try {
    const agent =
      await options.agentServices.installationManager.ensureInstalled(
        descriptor.hostId
      )
    assertAgentMatches(workspaceBinding, agent)

    const runtime =
      await options.runtimeInstallationManager.ensureInstalled(
        descriptor.hostId
      )
    assertRuntimeMatches(runtimeValidation, agent.architecture, runtime)

    const activeConnection =
      await options.agentServices.connectionManager.acquire(
      descriptor.hostId,
      {
        ...agent,
        requiredCapabilities: [
          RUNTIME_ACP_CAPABILITY,
          RUNTIME_MODEL_BRIDGE_CAPABILITY
        ]
      }
    )
    connection = activeConnection
    assertConnectionMatches(workspaceBinding, activeConnection)
    const initialTransport = {
      controllerGeneration: activeConnection.client.generation,
      daemonBootId: activeConnection.status.daemonBootId
    }
    const capabilities = await activeConnection.refreshCapabilities()
    assertConnectionMatches(workspaceBinding, activeConnection)
    assertSameTransport(
      initialTransport,
      {
        controllerGeneration: activeConnection.client.generation,
        daemonBootId: activeConnection.status.daemonBootId
      },
      'Remote Agent transport changed while creating the Runtime'
    )
    assertRuntimeAdvertised(runtime, capabilities)
    const controllerId =
      await options.agentServices.controllerState.getControllerId()
    assertSameTransport(
      initialTransport,
      {
        controllerGeneration: activeConnection.client.generation,
        daemonBootId: activeConnection.status.daemonBootId
      },
      'Remote Agent transport changed while creating the Runtime'
    )
    const resources = new ManagedRemoteRuntimeResources(
      options.workspaceAccessFactory,
      workspaceBinding,
      activeConnection,
      runtime,
      options.modelBridge
    )

    const createRemote = (
      transport: ManagedRemoteTransportIdentity
    ): AcpRemoteRuntime => {
      const remoteOptions: AcpRemoteRuntimeOptions = {
        runtimeId: 'opencode',
        label: 'OpenCode（远程托管）',
        workspacePath: descriptor.remoteRootPath,
        identity: {
          controllerId,
          controllerGeneration: transport.controllerGeneration,
          hostId: workspaceBinding.hostId,
          hostRevision: workspaceBinding.hostRevision,
          hostKeyGeneration: workspaceBinding.hostKeyGeneration,
          workspaceIdentity: workspaceBinding.workspaceIdentity,
          agentInstallationId: workspaceBinding.agentInstallationId,
          daemonBootIdAtOpen: transport.daemonBootId,
          runtimeBundleDigest:
            runtimeValidation.runtimeBundleDigest,
          runtimeAdapterDigest:
            runtimeValidation.runtimeAdapterDigest,
        },
        channelFactory: async (bindingId) =>
          resources.openChannel(transport, bindingId),
        bindingStore: options.bindingStore,
        modelBridgePolicy: options.modelBridge.policy,
        assertHostCurrent: (identity) => {
          if (
            identity.controllerId !== controllerId ||
            identity.hostId !== workspaceBinding.hostId ||
            identity.hostRevision !== workspaceBinding.hostRevision ||
            identity.hostKeyGeneration !==
              workspaceBinding.hostKeyGeneration ||
            identity.agentInstallationId !==
              workspaceBinding.agentInstallationId
          ) {
            throw new Error(
              'Remote Runtime Host identity no longer matches its project'
            )
          }
        },
        ...(options.usage
          ? {
              usage: {
                runtime: 'opencode',
                provider: options.usage.provider,
                model: options.usage.model
              }
            }
          : {})
      }
      return new AcpRemoteRuntime(remoteOptions)
    }
    const transport = initialTransport
    const remote = createRemote(transport)
    retained = true
    return new ManagedRemoteAcpRuntime(
      remote,
      transport,
      createRemote,
      resources
    )
  } finally {
    if (!retained) {
      connection?.release()
    }
  }
}

class ManagedRemoteRuntimeResources {
  #workspace:
    | {
        transport: ManagedRemoteTransportIdentity
        access: ReturnType<ManagedRemoteWorkspaceAccessFactory['create']>
      }
    | undefined
  #workspaceTail: Promise<void> = Promise.resolve()
  #disposePromise?: Promise<void>

  constructor(
    private readonly workspaceFactory:
      Pick<ManagedRemoteWorkspaceAccessFactory, 'create'>,
    private readonly workspaceBinding: RemoteWorkspaceProjectBinding,
    private readonly connection: NonNullable<
      Awaited<
        ReturnType<
          RemoteAgentServices['connectionManager']['acquire']
        >
      >
    >,
    private readonly runtime: Awaited<
      ReturnType<RemoteRuntimeInstallationManager['ensureInstalled']>
    >,
    private readonly modelBridge: ManagedModelBridge
  ) {}

  currentTransportIdentity(): ManagedRemoteTransportIdentity {
    return {
      controllerGeneration: this.connection.client.generation,
      daemonBootId: this.connection.status.daemonBootId
    }
  }

  async prepareTransport(): Promise<ManagedRemoteTransportIdentity> {
    if (this.connection.state !== 'ready') {
      await this.connection.reconnect()
    }
    assertConnectionMatches(this.workspaceBinding, this.connection)
    const beforeRefresh = this.currentTransportIdentity()
    const capabilities = await this.connection.refreshCapabilities()
    assertConnectionMatches(this.workspaceBinding, this.connection)
    assertSameTransport(
      beforeRefresh,
      this.currentTransportIdentity(),
      'Remote Agent transport changed while refreshing capabilities'
    )
    assertRuntimeAdvertised(this.runtime, capabilities)
    await this.ensureWorkspace(beforeRefresh)
    assertSameTransport(
      beforeRefresh,
      this.currentTransportIdentity(),
      'Remote Agent transport changed while opening the Workspace'
    )
    return beforeRefresh
  }

  async openChannel(
    expected: ManagedRemoteTransportIdentity,
    bindingId: string
  ) {
    const transport = await this.prepareTransport()
    assertSameTransport(
      expected,
      transport,
      'Remote Runtime transport lease is stale'
    )
    const channel = await createProtocolRemoteRuntimeChannel({
      connection: this.connection,
      openIdentity: {
        bindingId,
        runtimeId: 'opencode',
        runtimeBundleDigest: this.runtime.bundleDigest,
        workspaceIdentity: this.workspaceBinding.workspaceIdentity
      },
      modelBridge: this.modelBridge.channel
    })
    try {
      assertSameTransport(
        expected,
        this.currentTransportIdentity(),
        'Remote Agent transport changed while opening an ACP channel'
      )
      return channel
    } catch (error) {
      await channel.close().catch(() => undefined)
      throw error
    }
  }

  ensureWorkspace(
    transport: ManagedRemoteTransportIdentity
  ): Promise<void> {
    const operation = this.#workspaceTail.then(async () => {
      if (
        this.#workspace !== undefined &&
        sameTransport(this.#workspace.transport, transport)
      ) {
        await this.#workspace.access.getIdentity()
        assertSameTransport(
          transport,
          this.currentTransportIdentity(),
          'Remote Agent transport changed while checking the Workspace'
        )
        return
      }
      const previous = this.#workspace
      this.#workspace = undefined
      if (previous !== undefined) {
        await previous.access.dispose().catch(() => undefined)
      }
      const access = this.workspaceFactory.create(
        this.workspaceBinding
      )
      try {
        const identity = await access.getIdentity()
        if (
          identity.kind !== 'remote' ||
          identity.canonicalDisplayPath !==
            this.workspaceBinding.remoteRootPath ||
          identity.id !==
            `${this.workspaceBinding.hostId}:${this.workspaceBinding.workspaceIdentity}`
        ) {
          throw new Error(
            'Live remote Workspace does not match persisted validation'
          )
        }
        assertSameTransport(
          transport,
          this.currentTransportIdentity(),
          'Remote Agent transport changed while opening the Workspace'
        )
        this.#workspace = { transport, access }
      } catch (error) {
        await access.dispose().catch(() => undefined)
        throw error
      }
    })
    this.#workspaceTail = operation.catch(() => undefined)
    return operation
  }

  dispose(): Promise<void> {
    this.#disposePromise ??= this.#dispose()
    return this.#disposePromise
  }

  async #dispose(): Promise<void> {
    await this.#workspaceTail
    const errors: unknown[] = []
    try {
      await this.#workspace?.access.dispose()
    } catch (error) {
      errors.push(error)
    }
    try {
      this.connection.release()
    } catch (error) {
      errors.push(error)
    }
    if (errors.length > 0) {
      throw new AggregateError(
        errors,
        'Remote Runtime resources failed to release'
      )
    }
  }
}

class ManagedRemoteAcpRuntime implements AgentRuntime {
  readonly requiresToolApproval = false
  readonly supportsScopedDataTools = false
  readonly capability = 'chat' as const
  readonly runtimeId = 'opencode' as const
  #disposePromise?: Promise<void>
  #transitionTail: Promise<void> = Promise.resolve()
  #activeRuns = 0
  #draining = false
  #disposed = false

  constructor(
    private remote: AcpRemoteRuntime,
    private transport: ManagedRemoteTransportIdentity,
    private readonly createRemote: (
      transport: ManagedRemoteTransportIdentity
    ) => AcpRemoteRuntime,
    private readonly resources: ManagedRemoteRuntimeResources
  ) {}

  get supportsToolExecution(): boolean {
    return this.remote.supportsToolExecution
  }

  getStatus() {
    return this.remote.getStatus()
  }

  run(
    request: AgentExecutionRequest,
    signal: AbortSignal,
    authorize?: RuntimeAuthorizer
  ): AsyncGenerator<RuntimeEvent, void, void> {
    return this.#run(request, signal, authorize)
  }

  async *#run(
    request: AgentExecutionRequest,
    signal: AbortSignal,
    authorize?: RuntimeAuthorizer
  ): AsyncGenerator<RuntimeEvent, void, void> {
    const remote = await this.#acquireRun()
    let completed = false
    try {
      yield* remote.run(request, signal, authorize)
      completed = true
    } finally {
      this.#activeRuns -= 1
      if (completed) {
        try {
          const current = this.resources.currentTransportIdentity()
          if (
            current.daemonBootId === this.transport.daemonBootId &&
            current.controllerGeneration >
              this.transport.controllerGeneration
          ) {
            this.transport = current
          }
        } catch {
          // A later run will perform the authoritative transport transition.
        }
      }
    }
  }

  async #acquireRun(): Promise<AcpRemoteRuntime> {
    let acquired: AcpRemoteRuntime | undefined
    const operation = this.#transitionTail.then(async () => {
      if (this.#disposed) {
        throw new Error('远端 Runtime 已关闭')
      }
      if (this.#draining) {
        throw new Error('远端 Runtime 正在退役')
      }
      const currentTransport = await this.resources.prepareTransport()
      if (this.#disposed) {
        throw new Error('远端 Runtime 已关闭')
      }
      if (this.#draining) {
        throw new Error('远端 Runtime 正在退役')
      }
      if (!sameTransport(this.transport, currentTransport)) {
        if (this.#activeRuns > 0) {
          throw new Error(
            'Remote Agent transport changed while another Runtime request was active'
          )
        }
        await this.remote.dispose()
        if (this.#disposed) {
          throw new Error('远端 Runtime 已关闭')
        }
        if (this.#draining) {
          throw new Error('远端 Runtime 正在退役')
        }
        this.remote = this.createRemote(currentTransport)
        this.transport = currentTransport
      }
      this.#activeRuns += 1
      acquired = this.remote
    })
    this.#transitionTail = operation.catch(() => undefined)
    await operation
    return acquired!
  }

  releaseConversation(conversationId: string): Promise<void> {
    const operation = this.#transitionTail.then(() =>
      this.remote.releaseConversation(conversationId)
    )
    this.#transitionTail = operation.catch(() => undefined)
    return operation
  }

  beginDrain(): Promise<void> {
    this.#draining = true
    const operation = this.#transitionTail.then(() =>
      this.remote.beginDrain()
    )
    this.#transitionTail = operation.catch(() => undefined)
    return operation
  }

  waitForDrain(): Promise<void> {
    return this.#transitionTail.then(() => this.remote.waitForDrain())
  }

  forceShutdown(): Promise<void> {
    this.#disposed = true
    return this.#transitionTail
      .then(() => this.remote.forceShutdown())
      .finally(() => this.resources.dispose())
  }

  dispose(): Promise<void> {
    this.#disposed = true
    this.#disposePromise ??= this.#dispose()
    return this.#disposePromise
  }

  async #dispose(): Promise<void> {
    await this.#transitionTail
    const results = await Promise.allSettled([
      this.remote.dispose(),
      this.resources.dispose()
    ])
    const errors = results.flatMap((result) =>
      result.status === 'rejected' ? [result.reason] : []
    )
    if (errors.length > 0) {
      throw new AggregateError(
        errors,
        'Managed remote Runtime failed to dispose'
      )
    }
  }
}

function sameTransport(
  expected: ManagedRemoteTransportIdentity,
  actual: ManagedRemoteTransportIdentity
): boolean {
  return (
    expected.controllerGeneration === actual.controllerGeneration &&
    expected.daemonBootId === actual.daemonBootId
  )
}

function assertSameTransport(
  expected: ManagedRemoteTransportIdentity,
  actual: ManagedRemoteTransportIdentity,
  message: string
): void {
  if (!sameTransport(expected, actual)) {
    throw new Error(message)
  }
}

function workspaceProjectBinding(
  descriptor: SshExecutionSpaceDescriptor
): RemoteWorkspaceProjectBinding {
  const validation = descriptor.validation
  const runtime = descriptor.runtimeValidation
  if (
    validation === undefined ||
    runtime === undefined ||
    validation.agentInstallationIdAtValidation !==
      runtime.agentInstallationIdAtValidation
  ) {
    throw new Error('Remote project validation evidence is inconsistent')
  }
  return {
    hostId: descriptor.hostId,
    hostRevision: validation.hostRevision,
    hostKeyGeneration: validation.hostKeyGeneration,
    remoteUsername: validation.remoteUsername,
    remoteRootPath: descriptor.remoteRootPath,
    workspaceIdentity: validation.workspaceIdentity,
    agentInstallationId:
      validation.agentInstallationIdAtValidation,
    agentBinaryDigest:
      validation.agentBinaryDigestAtValidation,
    agentVersion: validation.agentVersionAtValidation,
    agentArchitecture:
      validation.agentArchitectureAtValidation,
    agentProtocolMajor: validation.agentProtocolMajor
  }
}

function assertAgentMatches(
  binding: RemoteWorkspaceProjectBinding,
  agent: Awaited<
    ReturnType<RemoteAgentServices['installationManager']['ensureInstalled']>
  >
): void {
  if (
    agent.installationId !== binding.agentInstallationId ||
    agent.binaryDigest !== binding.agentBinaryDigest ||
    agent.agentVersion !== binding.agentVersion ||
    agent.architecture !== binding.agentArchitecture ||
    agent.protocol.major !== binding.agentProtocolMajor
  ) {
    throw new Error(
      'Installed remote Agent does not match project validation'
    )
  }
}

function assertRuntimeMatches(
  validation: NonNullable<
    SshExecutionSpaceDescriptor['runtimeValidation']
  >,
  architecture: 'x64' | 'arm64',
  runtime: Awaited<
    ReturnType<RemoteRuntimeInstallationManager['ensureInstalled']>
  >
): void {
  if (
    runtime.runtimeId !== 'opencode' ||
    runtime.architecture !== architecture ||
    runtime.bundleDigest !== validation.runtimeBundleDigest ||
    runtime.runtimeAdapterDigest !==
      validation.runtimeAdapterDigest
  ) {
    throw new Error(
      'Installed OpenCode Runtime does not match project validation'
    )
  }
}

function assertConnectionMatches(
  binding: RemoteWorkspaceProjectBinding,
  connection: Awaited<
    ReturnType<RemoteAgentServices['connectionManager']['acquire']>
  >
): void {
  if (
    connection.state !== 'ready' ||
    connection.identity.hostId !== binding.hostId ||
    connection.identity.hostRevision !== binding.hostRevision ||
    connection.identity.hostKeyGeneration !==
      binding.hostKeyGeneration ||
    connection.identity.remoteUsername !== binding.remoteUsername ||
    connection.identity.installationId !==
      binding.agentInstallationId ||
    connection.identity.binaryDigest !== binding.agentBinaryDigest ||
    connection.identity.protocolMajor !== binding.agentProtocolMajor ||
    connection.status.state !== 'ready' ||
    connection.status.draining ||
    connection.status.installationId !== binding.agentInstallationId ||
    connection.status.binaryDigest !== binding.agentBinaryDigest ||
    connection.status.agentVersion !== binding.agentVersion ||
    connection.status.architecture !== binding.agentArchitecture
  ) {
    throw new Error(
      'Remote Agent connection does not match project validation'
    )
  }
}

function assertRuntimeAdvertised(
  runtime: Awaited<
    ReturnType<RemoteRuntimeInstallationManager['ensureInstalled']>
  >,
  capabilities: Awaited<
    ReturnType<
      RemoteAgentServices['connectionManager']['acquire']
    >
  >['capabilities']
): void {
  const capability = capabilities.capabilities.find(
    (entry) => entry.name === RUNTIME_ACP_CAPABILITY.name
  )
  const modelBridgeCapability = capabilities.capabilities.find(
    (entry) => entry.name === RUNTIME_MODEL_BRIDGE_CAPABILITY.name
  )
  const advertised = capabilities.runtimes.filter(
    (entry) => entry.runtimeId === 'opencode'
  )
  if (
    capability === undefined ||
    capability.version !==
      RUNTIME_ACP_CAPABILITY.exactVersion ||
    !capability.critical ||
    modelBridgeCapability === undefined ||
    modelBridgeCapability.version !==
      RUNTIME_MODEL_BRIDGE_CAPABILITY.exactVersion ||
    !modelBridgeCapability.critical ||
    advertised.length !== 1 ||
    advertised[0]!.version !== runtime.runtimeVersion ||
    advertised[0]!.bundleDigest !== runtime.bundleDigest ||
    advertised[0]!.acpCapabilitiesDigest !==
      runtime.acpCapabilitiesDigest ||
    !advertised[0]!.sessionLoad ||
    !advertised[0]!.sessionResume
  ) {
    throw new Error(
      'Remote Agent does not advertise the validated OpenCode Runtime'
    )
  }
}

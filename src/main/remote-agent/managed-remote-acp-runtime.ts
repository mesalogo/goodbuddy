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
import {
  REMOTE_WORKSPACE_READ_CAPABILITIES,
  remoteWorkspaceCloseResultSchema,
  remoteWorkspaceValidateResultSchema,
  type RemoteWorkspaceHandle
} from '../../shared/remote-agent-contracts'
import { createProtocolRemoteRuntimeChannel } from './protocol-remote-runtime-channel'
import type { RemoteAgentServices } from './remote-agent-services'
import type { ManagedModelBridge } from './managed-model-bridge'
import type { AgentInstallationIdentity } from './agent-installation-manager'
import type {
  RemoteRuntimeInstallationIdentity,
  RemoteRuntimeInstallationManager
} from './remote-runtime-installation-manager'

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

type ManagedRemoteRuntimeIdentity = {
  runtimeId: 'opencode'
  runtimeVersion: string
  bundleDigest: string
  runtimeAdapterDigest: string
  acpCapabilitiesDigest: string
  platform: 'linux'
  architecture: 'x64' | 'arm64'
}

export type ManagedRemoteAcpRuntimeOptions = {
  executionSpace: SshExecutionSpaceDescriptor
  selection: AgentRuntimeSelection
  agentServices: Pick<
    RemoteAgentServices,
    'connectionManager' | 'controllerState' | 'installationManager'
  >
  runtimeInstallationManager: Pick<
    RemoteRuntimeInstallationManager,
    'activateInstalled'
  >
  bindingStore: RuntimeSessionBindingStore
  modelBridge: ManagedModelBridge
  usage?: {
    provider: string
    model: string
  }
}

/**
 * Acquires every production lease needed by the Host's current Runtime.
 * The returned Runtime owns those leases and releases them only after all ACP
 * conversation channels have been closed.
 */
export async function createManagedRemoteAcpRuntime(
  options: ManagedRemoteAcpRuntimeOptions
): Promise<AgentRuntime> {
  const descriptor = options.executionSpace
  if (options.selection.provider !== 'opencode') {
    throw new Error(
      'Managed remote execution requires the OpenCode Runtime'
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
      await options.agentServices.installationManager.activateInstalled(
        descriptor.hostId
      )
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
    assertConnectionMatches(workspaceBinding, agent, activeConnection)
    const runtimeInstallation =
      await options.runtimeInstallationManager.activateInstalled(
        descriptor.hostId,
        { agentInstallationId: agent.installationId }
      )
    const capabilities = await activeConnection.refreshCapabilities()
    assertConnectionMatches(workspaceBinding, agent, activeConnection)
    const runtime = runtimeIdentityFromCapabilities(
      runtimeInstallation,
      capabilities
    )
    const controllerId =
      await options.agentServices.controllerState.getControllerId()
    const resources = new ManagedRemoteRuntimeResources(
      workspaceBinding,
      agent,
      activeConnection,
      runtime,
      options.modelBridge
    )
    const initialTransport =
      await resources.prepareTransport(capabilities)

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
          hostRevision: activeConnection.identity.hostRevision,
          hostKeyGeneration:
            activeConnection.identity.hostKeyGeneration,
          workspaceIdentity: resources.workspaceIdentity,
          agentInstallationId: agent.installationId,
          daemonBootIdAtOpen: transport.daemonBootId,
          runtimeBundleDigest: runtime.bundleDigest,
          runtimeAdapterDigest: runtime.runtimeAdapterDigest
        },
        channelFactory: async (bindingId) =>
          resources.openChannel(transport, bindingId),
        bindingStore: options.bindingStore,
        modelBridgePolicy: options.modelBridge.policy,
        assertHostCurrent: (identity) => {
          if (
            identity.controllerId !== controllerId ||
            identity.hostId !== workspaceBinding.hostId ||
            identity.hostRevision !==
              activeConnection.identity.hostRevision ||
            identity.hostKeyGeneration !==
              activeConnection.identity.hostKeyGeneration ||
            identity.agentInstallationId !==
              agent.installationId
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
        handle: RemoteWorkspaceHandle
      }
    | undefined
  #workspaceTail: Promise<void> = Promise.resolve()
  #disposePromise?: Promise<void>
  constructor(
    private readonly workspaceBinding: RemoteWorkspaceProjectBinding,
    private readonly agent: AgentInstallationIdentity,
    private readonly connection: NonNullable<
      Awaited<
        ReturnType<
          RemoteAgentServices['connectionManager']['acquire']
        >
      >
    >,
    private readonly runtime: ManagedRemoteRuntimeIdentity,
    private readonly modelBridge: ManagedModelBridge
  ) {}

  get workspaceIdentity(): string {
    if (this.#workspace === undefined) {
      throw new Error('Remote Workspace is not open')
    }
    return this.#workspace.handle.workspaceIdentity
  }

  currentTransportIdentity(): ManagedRemoteTransportIdentity {
    return {
      controllerGeneration: this.connection.client.generation,
      daemonBootId: this.connection.status.daemonBootId
    }
  }

  async prepareTransport(
    preparedCapabilities?: Awaited<
      ReturnType<
        RemoteAgentServices['connectionManager']['acquire']
      >
    >['capabilities']
  ): Promise<ManagedRemoteTransportIdentity> {
    if (this.connection.state !== 'ready') {
      await this.connection.reconnect()
    }
    assertConnectionMatches(
      this.workspaceBinding,
      this.agent,
      this.connection
    )
    const beforeRefresh = this.currentTransportIdentity()
    const capabilities =
      preparedCapabilities ??
      await this.connection.refreshCapabilities()
    assertConnectionMatches(
      this.workspaceBinding,
      this.agent,
      this.connection
    )
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
        workspaceIdentity: this.workspaceIdentity
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
        await this.#closeWorkspace(previous.handle).catch(
          () => undefined
        )
      }
      const validated = remoteWorkspaceValidateResultSchema.parse(
        await this.connection.client.request(
          'workspace/validate',
          {
            remoteRootPath: this.workspaceBinding.remoteRootPath,
            requestedAccess: 'read-only',
            requiredCapabilities: [
              ...REMOTE_WORKSPACE_READ_CAPABILITIES
            ]
          }
        )
      )
      try {
        assertWorkspace(
          this.workspaceBinding,
          validated.handle
        )
        assertSameTransport(
          transport,
          this.currentTransportIdentity(),
          'Remote Agent transport changed while opening the Workspace'
        )
        this.#workspace = {
          transport,
          handle: validated.handle
        }
      } catch (error) {
        await this.#closeWorkspace(validated.handle).catch(
          () => undefined
        )
        throw error
      }
    })
    this.#workspaceTail = operation.catch(() => undefined)
    return operation
  }

  async #closeWorkspace(handle: RemoteWorkspaceHandle): Promise<void> {
    const result = remoteWorkspaceCloseResultSchema.parse(
      await this.connection.client.request('workspace/close', {
        workspaceId: handle.workspaceId,
        generation: handle.generation
      })
    )
    if (
      result.workspaceId !== handle.workspaceId ||
      result.generation !== handle.generation
    ) {
      throw new Error('Remote Workspace close confirmation is invalid')
    }
  }

  dispose(): Promise<void> {
    this.#disposePromise ??= this.#dispose()
    return this.#disposePromise
  }

  async #dispose(): Promise<void> {
    await this.#workspaceTail
    const errors: unknown[] = []
    try {
      if (this.#workspace !== undefined) {
        await this.#closeWorkspace(this.#workspace.handle)
      }
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
  return {
    hostId: descriptor.hostId,
    remoteRootPath: descriptor.remoteRootPath
  }
}

function assertWorkspace(
  binding: RemoteWorkspaceProjectBinding,
  handle: RemoteWorkspaceHandle
): void {
  if (
    handle.canonicalDisplayPath !== binding.remoteRootPath ||
    handle.access !== 'read-only' ||
    REMOTE_WORKSPACE_READ_CAPABILITIES.some(
      (capability) => !handle.capabilities.includes(capability)
    )
  ) {
    throw new Error(
      'Live remote Workspace does not match the project path'
    )
  }
}

function runtimeIdentityFromCapabilities(
  installation: RemoteRuntimeInstallationIdentity,
  capabilities: Awaited<
    ReturnType<
      RemoteAgentServices['connectionManager']['acquire']
    >
  >['capabilities']
): ManagedRemoteRuntimeIdentity {
  if (
    installation.runtimeId !== 'opencode' ||
    installation.platform !== 'linux'
  ) {
    throw new Error(
      'Remote Agent does not advertise the current Runtime'
    )
  }
  const runtime: ManagedRemoteRuntimeIdentity = {
    runtimeId: 'opencode',
    runtimeVersion: installation.runtimeVersion,
    bundleDigest: installation.bundleDigest,
    runtimeAdapterDigest: installation.runtimeAdapterDigest,
    acpCapabilitiesDigest: installation.acpCapabilitiesDigest,
    platform: 'linux',
    architecture: installation.architecture
  }
  assertRuntimeAdvertised(runtime, capabilities)
  return runtime
}

function assertConnectionMatches(
  binding: RemoteWorkspaceProjectBinding,
  agent: AgentInstallationIdentity,
  connection: Awaited<
    ReturnType<RemoteAgentServices['connectionManager']['acquire']>
  >
): void {
  if (
    connection.state !== 'ready' ||
    connection.identity.hostId !== binding.hostId ||
    connection.identity.installationId !== agent.installationId ||
    connection.identity.binaryDigest !== agent.binaryDigest ||
    connection.identity.protocolMajor !== agent.protocol.major ||
    connection.status.state !== 'ready' ||
    connection.status.draining ||
    connection.status.installationId !== agent.installationId ||
    connection.status.binaryDigest !== agent.binaryDigest ||
    connection.status.agentVersion !== agent.agentVersion ||
    connection.status.architecture !== agent.architecture
  ) {
    throw new Error(
      'Remote Agent connection is not current'
    )
  }
}

function assertRuntimeAdvertised(
  runtime: ManagedRemoteRuntimeIdentity,
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
      'Remote Agent does not advertise the current OpenCode Runtime'
    )
  }
}

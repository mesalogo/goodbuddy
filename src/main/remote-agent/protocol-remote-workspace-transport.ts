import {
  REMOTE_WORKSPACE_READ_CAPABILITIES,
  remoteWorkspaceHandleSchema,
  type RemoteWorkspaceCloseResult,
  type RemoteWorkspaceHandle
} from '../../shared/remote-agent-contracts'
import type {
  RemoteWorkspaceProjectBinding,
  RemoteWorkspaceTransport,
  RemoteWorkspaceTransportBinding,
  RemoteWorkspaceTransportLease
} from '../workspace/remote-workspace-access'
import type {
  AgentProtocolClient,
  AgentProtocolParams,
  AgentProtocolResult
} from './agent-protocol-client'
import type {
  RemoteAgentConnection,
  RemoteAgentConnectionManager,
  RemoteAgentInstallationIdentity
} from './remote-agent-connection-manager'

const WORKSPACE_READ_CAPABILITY = 'workspace/read'
const WORKSPACE_READ_CAPABILITY_VERSION = 1
export type DurableRemoteWorkspaceValidation = {
  binding: RemoteWorkspaceTransportBinding
  workspaceIdentity: string
  handle: RemoteWorkspaceHandle
  validatedAt: string
}

export type RemoteWorkspaceInstallationResolution = {
  installation: RemoteAgentInstallationIdentity
  /**
   * This value must come from durable validation storage. The transport never
   * promotes an in-memory handle or an incomplete record into resume state.
   */
  durableWorkspaceValidation?: DurableRemoteWorkspaceValidation
}

export interface RemoteWorkspaceInstallationIdentityResolver {
  resolve(
    hostId: string,
    installationId: string,
    signal?: AbortSignal
  ): Promise<RemoteWorkspaceInstallationResolution>
}

export class ProtocolRemoteWorkspaceTransportError extends Error {
  constructor(
    message: string,
    readonly reason:
      | 'binding-mismatch'
      | 'capability-missing'
      | 'stale-generation'
      | 'closed'
  ) {
    super(message)
    this.name = 'ProtocolRemoteWorkspaceTransportError'
  }
}

/**
 * The closed, read-only Workspace/Git bridge over AgentProtocolClient.
 * Deliberately no generic protocol request method is exposed.
 */
export class ProtocolRemoteWorkspaceTransport
  implements RemoteWorkspaceTransport
{
  constructor(
    private readonly connections: Pick<
      RemoteAgentConnectionManager,
      'acquire'
    >,
    private readonly installations:
      RemoteWorkspaceInstallationIdentityResolver
  ) {}

  async acquireLease(
    binding: RemoteWorkspaceProjectBinding,
    signal?: AbortSignal
  ): Promise<RemoteWorkspaceTransportLease> {
    signal?.throwIfAborted()
    const projectBinding = { ...binding }
    const resolved = await this.installations.resolve(
      projectBinding.hostId,
      projectBinding.agentInstallationId,
      signal
    )
    let resolution: RemoteWorkspaceInstallationResolution | undefined
    let connection: RemoteAgentConnection | undefined
    let retained = false
    try {
      resolution = snapshotResolution(resolved)
      signal?.throwIfAborted()
      assertResolution(projectBinding, resolution)
      connection = await this.connections.acquire(
        projectBinding.hostId,
        requireWorkspaceReadCapability(resolution.installation),
        signal
      )
      const status = connection.status
      assertConnectionIdentity(projectBinding, resolution, connection)
      assertConnectionStatus(projectBinding, resolution, status)
      const capabilities = await connection.client.request(
        'agent/capabilities',
        {},
        { signal }
      )
      signal?.throwIfAborted()
      assertWorkspaceReadCapability(capabilities)
      if (
        capabilities.generation !==
        connection.capabilities.generation
      ) {
        throw staleGenerationError()
      }
      const transportBinding = liveBinding(
        projectBinding,
        resolution,
        connection,
        capabilities.generation
      )
      const resumableHandle = validatedResumableHandle(
        projectBinding,
        transportBinding,
        resolution.durableWorkspaceValidation
      )
      const lease = createLease({
        binding: projectBinding,
        resolution,
        connection,
        acquiredCapabilityGeneration: capabilities.generation,
        resumableHandle
      })
      retained = true
      return lease
    } finally {
      if (!retained) {
        releaseLeaseResources(connection)
      }
    }
  }
}

function snapshotResolution(
  resolution: RemoteWorkspaceInstallationResolution
): RemoteWorkspaceInstallationResolution {
  const installation = resolution.installation
  const durable = resolution.durableWorkspaceValidation
  return {
    installation: {
      ...installation,
      ...(installation.protocol === undefined
        ? {}
        : { protocol: { ...installation.protocol } }),
      ...(installation.requiredCapabilities === undefined
        ? {}
        : {
            requiredCapabilities:
              installation.requiredCapabilities.map((entry) => ({
                ...entry
              }))
          })
    },
    ...(durable === undefined
      ? {}
      : {
          durableWorkspaceValidation: {
            binding: { ...durable.binding },
            workspaceIdentity: durable.workspaceIdentity,
            handle: {
              ...durable.handle,
              capabilities: [...durable.handle.capabilities]
            },
            validatedAt: durable.validatedAt
          }
        })
  }
}

type LeaseState = {
  binding: RemoteWorkspaceProjectBinding
  resolution: RemoteWorkspaceInstallationResolution
  connection: RemoteAgentConnection
  acquiredCapabilityGeneration: number
  resumableHandle?: RemoteWorkspaceHandle
}

function createLease(state: LeaseState): RemoteWorkspaceTransportLease {
  let released = false
  let closing:
    | {
        workspaceId: string
        generation: number
        promise: Promise<RemoteWorkspaceCloseResult>
      }
    | undefined

  const assertOpen = (): void => {
    if (released) {
      throw new ProtocolRemoteWorkspaceTransportError(
        'Remote workspace transport lease is closed',
        'closed'
      )
    }
  }

  const currentClient = (): AgentProtocolClient => {
    assertOpen()
    if (state.connection.state !== 'ready') {
      throw staleGenerationError()
    }
    assertConnectionIdentity(
      state.binding,
      state.resolution,
      state.connection
    )
    assertConnectionStatus(
      state.binding,
      state.resolution,
      state.connection.status
    )
    if (
      state.connection.capabilities.generation !==
      state.acquiredCapabilityGeneration
    ) {
      throw staleGenerationError()
    }
    return state.connection.client
  }

  const request = async <
    M extends WorkspaceReadProtocolMethod
  >(
    method: M,
    params: AgentProtocolParams<M>,
    signal?: AbortSignal
  ): Promise<AgentProtocolResult<M>> => {
    signal?.throwIfAborted()
    const client = currentClient()
    const capabilities = state.connection.capabilities
    assertWorkspaceReadCapability(capabilities)
    if (
      capabilities.generation !==
      state.acquiredCapabilityGeneration
    ) {
      throw staleGenerationError()
    }
    if (currentClient() !== client) {
      throw staleGenerationError()
    }
    return await client.request(method, params, { signal })
  }

  return {
    get binding() {
      currentClient()
      return liveBinding(
        state.binding,
        state.resolution,
        state.connection,
        state.acquiredCapabilityGeneration
      )
    },
    ...(state.resumableHandle === undefined
      ? {}
      : { resumableHandle: state.resumableHandle }),
    validateWorkspace: async (value, signal) =>
      await request('workspace/validate', value, signal),
    openWorkspace: async (value, signal) =>
      await request('workspace/open', value, signal),
    resumeWorkspace: async (value, signal) =>
      await request('workspace/resume', value, signal),
    closeWorkspace: (value) => {
      currentClient()
      if (
        closing?.workspaceId === value.workspaceId &&
        closing.generation === value.generation
      ) {
        return closing.promise
      }
      const promise = request('workspace/close', value)
      closing = {
        workspaceId: value.workspaceId,
        generation: value.generation,
        promise
      }
      return promise
    },
    listWorkspace: async (value, signal) =>
      await request('workspace/list', value, signal),
    statWorkspace: async (value, signal) =>
      await request('workspace/stat', value, signal),
    readWorkspaceText: async (value, signal) =>
      await request('workspace/readText', value, signal),
    searchWorkspace: async (value, signal) =>
      await request('workspace/search', value, signal),
    getGitStatus: async (value, signal) =>
      await request('git/status', value, signal),
    getGitDiff: async (value, signal) =>
      await request('git/diff', value, signal),
    release: () => {
      if (released) {
        return
      }
      released = true
      releaseLeaseResources(
        state.connection
      )
    }
  }
}

function releaseLeaseResources(
  connection: RemoteAgentConnection | undefined
): void {
  const errors: unknown[] = []
  if (connection !== undefined) {
    try {
      connection.release()
    } catch (error) {
      errors.push(error)
    }
  }
  if (errors.length === 1) {
    throw errors[0]
  }
  if (errors.length > 1) {
    throw new AggregateError(
      errors,
      'Failed to release remote workspace transport resources'
    )
  }
}

type WorkspaceReadProtocolMethod =
  | 'workspace/validate'
  | 'workspace/open'
  | 'workspace/resume'
  | 'workspace/close'
  | 'workspace/list'
  | 'workspace/stat'
  | 'workspace/readText'
  | 'workspace/search'
  | 'git/status'
  | 'git/diff'

function requireWorkspaceReadCapability(
  installation: RemoteAgentInstallationIdentity
): RemoteAgentInstallationIdentity {
  const requirements = [...(installation.requiredCapabilities ?? [])]
  const index = requirements.findIndex(
    (requirement) => requirement.name === WORKSPACE_READ_CAPABILITY
  )
  const required = {
    name: WORKSPACE_READ_CAPABILITY,
    minimumVersion: WORKSPACE_READ_CAPABILITY_VERSION,
    critical: true
  }
  if (index < 0) {
    requirements.push(required)
  } else {
    const current = requirements[index]!
    requirements[index] = {
      name: current.name,
      ...(current.exactVersion === undefined
        ? {
            minimumVersion: Math.max(
              current.minimumVersion!,
              WORKSPACE_READ_CAPABILITY_VERSION
            )
          }
        : { exactVersion: current.exactVersion }),
      critical: true
    }
  }
  return {
    ...installation,
    requiredCapabilities: requirements
  }
}

function assertResolution(
  binding: RemoteWorkspaceProjectBinding,
  resolution: RemoteWorkspaceInstallationResolution
): void {
  const protocol = resolution.installation.protocol
  if (
    resolution.installation.installationId !==
      binding.agentInstallationId ||
    resolution.installation.binaryDigest !==
      binding.agentBinaryDigest ||
    resolution.installation.agentVersion !== binding.agentVersion ||
    resolution.installation.architecture !==
      binding.agentArchitecture ||
    protocol === undefined ||
    protocol.major !== binding.agentProtocolMajor
  ) {
    throw bindingMismatchError()
  }
}

function assertConnectionIdentity(
  binding: RemoteWorkspaceProjectBinding,
  resolution: RemoteWorkspaceInstallationResolution,
  connection: RemoteAgentConnection
): void {
  const identity = connection.identity
  const protocol = resolution.installation.protocol
  if (
    identity.hostId !== binding.hostId ||
    identity.hostRevision !== binding.hostRevision ||
    identity.hostKeyGeneration !== binding.hostKeyGeneration ||
    identity.remoteUsername !== binding.remoteUsername ||
    identity.installationId !== binding.agentInstallationId ||
    identity.binaryDigest !== binding.agentBinaryDigest ||
    identity.binaryDigest !== resolution.installation.binaryDigest ||
    identity.protocolMajor !== binding.agentProtocolMajor ||
    protocol === undefined ||
    identity.protocolMinor !== protocol.minor
  ) {
    throw bindingMismatchError()
  }
}

function assertConnectionStatus(
  binding: RemoteWorkspaceProjectBinding,
  resolution: RemoteWorkspaceInstallationResolution,
  status: RemoteAgentConnection['status']
): void {
  const installation = resolution.installation
  if (
    status.state !== 'ready' ||
    status.draining ||
    status.installationId !== binding.agentInstallationId ||
    status.binaryDigest !== binding.agentBinaryDigest ||
    status.binaryDigest !== installation.binaryDigest ||
    status.agentVersion !== binding.agentVersion ||
    status.agentVersion !== installation.agentVersion ||
    status.architecture !== binding.agentArchitecture ||
    status.architecture !== installation.architecture ||
    status.protocol.major !== binding.agentProtocolMajor ||
    installation.protocol === undefined ||
    status.protocol.minor !== installation.protocol.minor ||
    status.platform !== installation.platform ||
    status.supervisor !== installation.supervisor ||
    installation.agentVersion === undefined
  ) {
    throw bindingMismatchError()
  }
}

function assertWorkspaceReadCapability(
  capabilities: RemoteAgentConnection['capabilities']
): void {
  const capability = capabilities.capabilities.find(
    (entry) => entry.name === WORKSPACE_READ_CAPABILITY
  )
  if (
    !Number.isSafeInteger(capabilities.generation) ||
    capabilities.generation < 1 ||
    capability === undefined ||
    capability.version < WORKSPACE_READ_CAPABILITY_VERSION ||
    !capability.critical
  ) {
    throw new ProtocolRemoteWorkspaceTransportError(
      'Remote Agent does not advertise the critical workspace/read capability',
      'capability-missing'
    )
  }
}

function liveBinding(
  binding: RemoteWorkspaceProjectBinding,
  resolution: RemoteWorkspaceInstallationResolution,
  connection: RemoteAgentConnection,
  capabilityGeneration: number
): RemoteWorkspaceTransportBinding {
  assertConnectionIdentity(binding, resolution, connection)
  assertConnectionStatus(binding, resolution, connection.status)
  if (
    connection.capabilities.generation !== capabilityGeneration
  ) {
    throw staleGenerationError()
  }
  return {
    hostId: connection.identity.hostId,
    hostRevision: connection.identity.hostRevision,
    hostKeyGeneration: connection.identity.hostKeyGeneration,
    remoteUsername: connection.identity.remoteUsername,
    agentInstallationId: connection.identity.installationId,
    agentBinaryDigest: connection.identity.binaryDigest,
    agentVersion: connection.status.agentVersion,
    agentArchitecture: connection.status.architecture,
    agentProtocolMajor: connection.identity.protocolMajor,
    capabilityGeneration
  }
}

function validatedResumableHandle(
  binding: RemoteWorkspaceProjectBinding,
  transportBinding: RemoteWorkspaceTransportBinding,
  validation: DurableRemoteWorkspaceValidation | undefined
): RemoteWorkspaceHandle | undefined {
  if (validation === undefined) {
    return undefined
  }
  const timestamp = Date.parse(validation.validatedAt)
  if (
    !Number.isFinite(timestamp) ||
    validation.workspaceIdentity !== binding.workspaceIdentity ||
    !sameTransportBinding(validation.binding, transportBinding)
  ) {
    return undefined
  }
  const parsed = remoteWorkspaceHandleSchema.safeParse(validation.handle)
  if (
    !parsed.success ||
    parsed.data.workspaceIdentity !== binding.workspaceIdentity ||
    parsed.data.access !== 'read-only' ||
    REMOTE_WORKSPACE_READ_CAPABILITIES.some(
      (capability) => !parsed.data.capabilities.includes(capability)
    )
  ) {
    return undefined
  }
  return parsed.data
}

function sameTransportBinding(
  left: RemoteWorkspaceTransportBinding,
  right: RemoteWorkspaceTransportBinding
): boolean {
  return (
    left.hostId === right.hostId &&
    left.hostRevision === right.hostRevision &&
    left.hostKeyGeneration === right.hostKeyGeneration &&
    left.remoteUsername === right.remoteUsername &&
    left.agentInstallationId === right.agentInstallationId &&
    left.agentBinaryDigest === right.agentBinaryDigest &&
    left.agentVersion === right.agentVersion &&
    left.agentArchitecture === right.agentArchitecture &&
    left.agentProtocolMajor === right.agentProtocolMajor &&
    left.capabilityGeneration === right.capabilityGeneration
  )
}

function bindingMismatchError(): ProtocolRemoteWorkspaceTransportError {
  return new ProtocolRemoteWorkspaceTransportError(
    'Remote workspace project binding does not match the live Agent connection',
    'binding-mismatch'
  )
}

function staleGenerationError(): ProtocolRemoteWorkspaceTransportError {
  return new ProtocolRemoteWorkspaceTransportError(
    'Remote workspace capability generation is stale',
    'stale-generation'
  )
}

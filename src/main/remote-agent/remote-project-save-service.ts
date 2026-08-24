import { isDeepStrictEqual } from 'node:util'
import type {
  AssistantProject,
  ProjectRuntimeValidation,
  SshExecutionValidation
} from '../../shared/assistant-contracts'
import { projectRuntimeValidationSchema } from '../../shared/assistant-contracts'
import {
  remoteProjectSaveRequestSchema,
  type RemoteProjectSavePhase,
  type RemoteProjectSaveProgress,
  type RemoteProjectSaveRequest
} from '../../shared/remote-project-candidate-contracts'
import { sha256DigestSchema } from '../../shared/agent-protocol/contracts'
import {
  REMOTE_WORKSPACE_READ_CAPABILITIES,
  remoteWorkspaceValidateResultSchema,
  type RemoteWorkspaceHandle
} from '../../shared/remote-agent-contracts'
import {
  agentRuntimeSelectionKey,
  type AgentRuntimeSelection
} from '../../shared/runtime-selection-contracts'
import type {
  AssistantDatabase,
  ValidatedSshHostPrecondition,
  ValidatedSshProjectWrite
} from '../assistant/assistant-database'
import type {
  CurrentSshConnectionTarget,
  SshConnectionTarget,
  SshHostStore
} from '../ssh/ssh-host-store'
import type {
  AgentInstallationIdentity,
  AgentInstallationManager
} from './agent-installation-manager'
import type {
  RemoteAgentConnection,
  RemoteAgentConnectionManager
} from './remote-agent-connection-manager'

const CLEANUP_TIMEOUT_MS = 5_000
const WORKSPACE_READ_CAPABILITY = {
  name: 'workspace/read',
  minimumVersion: 1,
  critical: true
} as const

export interface RemoteProjectSaveOwner {
  readonly id: number
  isDestroyed(): boolean
  on(event: 'destroyed', listener: () => void): unknown
  removeListener(event: 'destroyed', listener: () => void): unknown
}

export type RemoteProjectRuntimeValidationInput = Readonly<{
  selection: AgentRuntimeSelection
  runtimeSelectionKey: string
  workMode: 'ask' | 'execute'
  host: Readonly<{
    hostId: string
    hostRevision: number
    hostKeyGeneration: number
    remoteUsername: string
  }>
  agent: Readonly<{
    installationId: string
    binaryDigest: string
    version: string
    architecture: 'x64' | 'arm64'
    protocolMajor: number
  }>
  workspace: Readonly<{
    canonicalRemoteRoot: string
    workspaceIdentity: string
    workspaceId: string
    generation: number
    access: 'read-only'
    capabilities: readonly string[]
  }>
  connection: RemoteAgentConnection
  signal: AbortSignal
}>

export type RemoteProjectRuntimeValidationEvidence =
  ProjectRuntimeValidation

export interface RemoteProjectRuntimeValidationLease {
  readonly evidence: RemoteProjectRuntimeValidationEvidence
  assertCurrent(): void
  release(): void
}

export interface RemoteProjectRuntimeValidator {
  validate(
    input: RemoteProjectRuntimeValidationInput
  ): Promise<RemoteProjectRuntimeValidationLease>
}

export class UnavailableRemoteProjectRuntimeValidator
  implements RemoteProjectRuntimeValidator
{
  async validate(): Promise<never> {
    throw new Error('Remote Runtime validation is unavailable')
  }
}

type ActiveSave = {
  controller: AbortController
  done: Promise<void>
  resolveDone: () => void
  destroyedListener: () => void
  installation?: AgentInstallationIdentity
  connection?: RemoteAgentConnection
  workspace?: RemoteWorkspaceHandle
  runtimeLease?: RemoteProjectRuntimeValidationLease
}

export type RemoteProjectSaveServiceOptions = {
  database: Pick<
    AssistantDatabase,
    | 'getProject'
    | 'createValidatedSshProject'
    | 'updateValidatedSshProject'
  >
  sshHosts: Pick<
    SshHostStore,
    'resolveConnectionTarget' | 'assertConnectionTargetCurrent'
  >
  installationManager: Pick<AgentInstallationManager, 'ensureInstalled'>
  connectionManager: Pick<RemoteAgentConnectionManager, 'acquire'>
  resolveRuntimeSelection(
    selection: AgentRuntimeSelection
  ): Promise<AgentRuntimeSelection>
  runtimeValidator?: RemoteProjectRuntimeValidator
  notify?: (
    owner: RemoteProjectSaveOwner,
    progress: RemoteProjectSaveProgress
  ) => void
  cleanupTimeoutMs?: number
}

export class RemoteProjectSaveService {
  readonly #database: RemoteProjectSaveServiceOptions['database']
  readonly #sshHosts: RemoteProjectSaveServiceOptions['sshHosts']
  readonly #installationManager: RemoteProjectSaveServiceOptions['installationManager']
  readonly #connectionManager: RemoteProjectSaveServiceOptions['connectionManager']
  readonly #resolveRuntimeSelection: RemoteProjectSaveServiceOptions['resolveRuntimeSelection']
  readonly #runtimeValidator: RemoteProjectRuntimeValidator
  readonly #notify?: RemoteProjectSaveServiceOptions['notify']
  readonly #cleanupTimeoutMs: number
  readonly #active = new Map<RemoteProjectSaveOwner, ActiveSave>()
  readonly #activations = new Map<
    RemoteProjectSaveOwner,
    { projectId: string; promise: Promise<AssistantProject> }
  >()
  #disposed = false

  constructor(options: RemoteProjectSaveServiceOptions) {
    this.#database = options.database
    this.#sshHosts = options.sshHosts
    this.#installationManager = options.installationManager
    this.#connectionManager = options.connectionManager
    this.#resolveRuntimeSelection = options.resolveRuntimeSelection
    this.#runtimeValidator =
      options.runtimeValidator ??
      new UnavailableRemoteProjectRuntimeValidator()
    this.#notify = options.notify
    this.#cleanupTimeoutMs =
      options.cleanupTimeoutMs ?? CLEANUP_TIMEOUT_MS
    if (
      !Number.isSafeInteger(this.#cleanupTimeoutMs) ||
      this.#cleanupTimeoutMs < 1
    ) {
      throw new RangeError('Invalid remote project cleanup timeout')
    }
  }

  async save(
    owner: RemoteProjectSaveOwner,
    input: unknown
  ): Promise<AssistantProject> {
    this.#assertOwnerAvailable(owner)
    if (this.#active.has(owner)) {
      throw new Error('A remote project save is already in progress')
    }
    const request = remoteProjectSaveRequestSchema.parse(input)
    let resolveDone!: () => void
    const active: ActiveSave = {
      controller: new AbortController(),
      done: new Promise<void>((resolve) => {
        resolveDone = resolve
      }),
      resolveDone,
      destroyedListener: () => {
        active.controller.abort(
          new DOMException('Remote project owner was destroyed', 'AbortError')
        )
      }
    }
    this.#active.set(owner, active)
    owner.on('destroyed', active.destroyedListener)

    try {
      return await this.#performSave(owner, active, request)
    } finally {
      await this.#cleanup(active)
      owner.removeListener('destroyed', active.destroyedListener)
      if (this.#active.get(owner) === active) {
        this.#active.delete(owner)
      }
      active.resolveDone()
    }
  }

  async activate(
    owner: RemoteProjectSaveOwner,
    projectId: string
  ): Promise<AssistantProject> {
    this.#assertOwnerAvailable(owner)
    const existing = this.#activations.get(owner)
    if (existing) {
      if (existing.projectId === projectId) {
        return await existing.promise
      }
      throw new Error('A remote project save is already in progress')
    }
    const project = this.#database.getProject(projectId)
    if (
      project.kind !== 'user' ||
      project.channel !== undefined ||
      project.status !== 'active' ||
      project.executionSpace.kind !== 'ssh' ||
      project.runtimeSelection === undefined
    ) {
      throw new Error('Only active managed SSH projects can be activated')
    }
    const promise = this.save(owner, {
      intent: 'update',
      draft: {
        projectId: project.id,
        name: project.name,
        description: project.description,
        defaultWorkMode: project.defaultWorkMode,
        runtimeSelection: project.runtimeSelection,
        hostId: project.executionSpace.hostId,
        remoteRootPath: project.executionSpace.remoteRootPath
      }
    })
    this.#activations.set(owner, { projectId, promise })
    try {
      return await promise
    } finally {
      if (this.#activations.get(owner)?.promise === promise) {
        this.#activations.delete(owner)
      }
    }
  }

  cancelCurrent(owner: RemoteProjectSaveOwner): void {
    this.#active.get(owner)?.controller.abort(
      new DOMException('Remote project save cancelled', 'AbortError')
    )
  }

  async dispose(): Promise<void> {
    if (this.#disposed) return
    this.#disposed = true
    const saves = [...this.#active.entries()]
    for (const [, active] of saves) {
      active.controller.abort(
        new DOMException('Remote project service disposed', 'AbortError')
      )
    }
    await Promise.allSettled(saves.map(([, active]) => active.done))
  }

  async #performSave(
    owner: RemoteProjectSaveOwner,
    active: ActiveSave,
    request: RemoteProjectSaveRequest
  ): Promise<AssistantProject> {
    const { signal } = active.controller
    const expectedUpdatedAt =
      request.intent === 'update'
        ? this.#readUpdateRevision(request)
        : undefined
    const runtimeSelection = await this.#resolveRuntimeSelection(
      request.draft.runtimeSelection
    )
    signal.throwIfAborted()

    this.#progress(owner, 'host')
    const target = await this.#sshHosts.resolveConnectionTarget(
      request.draft.hostId
    )
    signal.throwIfAborted()
    assertTarget(request.draft.hostId, target)

    this.#progress(owner, 'agent')
    const installation = await this.#installationManager.ensureInstalled(
      request.draft.hostId,
      { signal }
    )
    signal.throwIfAborted()
    assertInstallation(installation)
    active.installation = installation
    const connection = await this.#connectionManager.acquire(
      request.draft.hostId,
      {
        ...installation,
        requiredCapabilities: [WORKSPACE_READ_CAPABILITY]
      },
      signal
    )
    active.connection = connection
    signal.throwIfAborted()
    assertConnectionIdentity(target, installation, connection)

    this.#progress(owner, 'workspace')
    const validated = remoteWorkspaceValidateResultSchema.parse(
      await connection.client.request(
        'workspace/validate',
        {
          remoteRootPath: request.draft.remoteRootPath,
          requestedAccess: 'read-only',
          requiredCapabilities: [...REMOTE_WORKSPACE_READ_CAPABILITIES]
        },
        { signal }
      )
    )
    active.workspace = validated.handle
    signal.throwIfAborted()
    assertWorkspace(validated.handle)
    if (
      validated.handle.canonicalDisplayPath !==
      request.draft.remoteRootPath
    ) {
      throw new Error('Remote workspace path changed during validation')
    }
    assertCriticalWorkspaceRead(connection)

    this.#progress(owner, 'runtime')
    const selectionKey = agentRuntimeSelectionKey(
      runtimeSelection
    )
    const runtimeLease = await this.#runtimeValidator.validate({
      selection: runtimeSelection,
      runtimeSelectionKey: selectionKey,
      workMode: request.draft.defaultWorkMode,
      host: {
        hostId: target.host.id,
        hostRevision: target.hostRevision,
        hostKeyGeneration: target.hostKeyGeneration,
        remoteUsername: target.host.username
      },
      agent: {
        installationId: installation.installationId,
        binaryDigest: installation.binaryDigest,
        version: installation.agentVersion,
        architecture: installation.architecture,
        protocolMajor: installation.protocol.major
      },
      workspace: {
        canonicalRemoteRoot: validated.handle.canonicalDisplayPath,
        workspaceIdentity: validated.handle.workspaceIdentity,
        workspaceId: validated.handle.workspaceId,
        generation: validated.handle.generation,
        access: 'read-only',
        capabilities: validated.handle.capabilities
      },
      connection,
      signal
    })
    active.runtimeLease = runtimeLease
    signal.throwIfAborted()
    const runtimeEvidence = projectRuntimeValidationSchema.parse(
      runtimeLease.evidence
    )
    assertRuntimeEvidence(
      runtimeEvidence,
      selectionKey,
      installation.installationId,
      request.draft.defaultWorkMode
    )

    this.#progress(owner, 'saving')
    signal.throwIfAborted()
    const write = this.#validatedWrite(
      request,
      runtimeSelection,
      target,
      installation,
      connection,
      validated.handle,
      runtimeLease,
      runtimeEvidence,
      validated.validatedAt
    )
    return request.intent === 'create'
      ? this.#database.createValidatedSshProject(write)
      : this.#database.updateValidatedSshProject(
          request.draft.projectId,
          expectedUpdatedAt!,
          write
        )
  }

  #readUpdateRevision(
    request: Extract<RemoteProjectSaveRequest, { intent: 'update' }>
  ): string {
    const project = this.#database.getProject(request.draft.projectId)
    if (
      project.kind !== 'user' ||
      project.channel !== undefined ||
      project.executionSpace.kind !== 'ssh' ||
      project.executionSpace.hostId !== request.draft.hostId ||
      project.executionSpace.remoteRootPath !==
        request.draft.remoteRootPath
    ) {
      throw new Error(
        'Only an existing user SSH project with the same Host and root can be updated'
      )
    }
    return project.updatedAt
  }

  #validatedWrite(
    request: RemoteProjectSaveRequest,
    runtimeSelection: AgentRuntimeSelection,
    target: SshConnectionTarget,
    installation: AgentInstallationIdentity,
    connection: RemoteAgentConnection,
    workspace: RemoteWorkspaceHandle,
    runtimeLease: RemoteProjectRuntimeValidationLease,
    runtime: ProjectRuntimeValidation,
    validatedAt: string
  ): ValidatedSshProjectWrite {
    const executionValidation: SshExecutionValidation = {
      hostRevision: target.hostRevision,
      hostKeyGeneration: target.hostKeyGeneration,
      remoteUsername: target.host.username,
      workspaceIdentity: workspace.workspaceIdentity,
      agentProtocolMajor: installation.protocol.major,
      agentInstallationIdAtValidation: installation.installationId,
      agentBinaryDigestAtValidation: installation.binaryDigest,
      agentVersionAtValidation: installation.agentVersion,
      agentArchitectureAtValidation: installation.architecture,
      validatedAt
    }
    return {
      project: {
        name: request.draft.name,
        description: request.draft.description,
        rootPath: workspace.canonicalDisplayPath,
        defaultWorkMode: request.draft.defaultWorkMode,
        runtimeSelection
      },
      executionSpace: {
        kind: 'ssh',
        hostId: target.host.id,
        remoteRootPath: workspace.canonicalDisplayPath,
        validation: executionValidation
      },
      runtimeValidation: structuredClone(runtime),
      assertSshHostCurrent: (expected) => {
        assertPrecondition(
          expected,
          target,
          installation,
          workspace
        )
        this.#sshHosts.assertConnectionTargetCurrent(
          currentTargetEvidence(target)
        )
        assertConnectionIdentity(target, installation, connection)
        assertCriticalWorkspaceRead(connection)
        runtimeLease.assertCurrent()
        if (
          !isDeepStrictEqual(
            projectRuntimeValidationSchema.parse(runtimeLease.evidence),
            runtime
          )
        ) {
          throw new Error('Remote Runtime validation changed before save')
        }
      }
    }
  }

  async #cleanup(active: ActiveSave): Promise<void> {
    try {
      active.runtimeLease?.release()
    } catch {
      // Continue releasing independently owned resources.
    }
    const workspace = active.workspace
    const connection = active.connection
    if (workspace && connection) {
      try {
        await connection.client.request(
          'workspace/close',
          {
            workspaceId: workspace.workspaceId,
            generation: workspace.generation
          },
          { signal: AbortSignal.timeout(this.#cleanupTimeoutMs) }
        )
      } catch {
        // The connection may already be offline after cancellation.
      }
    }
    try {
      connection?.release()
    } catch {
      // A concurrently closed connection is already released.
    }
  }

  #progress(
    owner: RemoteProjectSaveOwner,
    phase: RemoteProjectSavePhase
  ): void {
    if (!this.#notify || owner.isDestroyed()) return
    try {
      this.#notify(owner, { phase })
    } catch {
      // Renderer progress observers cannot affect the save.
    }
  }

  #assertOwnerAvailable(owner: RemoteProjectSaveOwner): void {
    if (this.#disposed) {
      throw new Error('Remote project save service is disposed')
    }
    if (
      !owner ||
      !Number.isSafeInteger(owner.id) ||
      owner.id < 0 ||
      owner.isDestroyed()
    ) {
      throw new Error('Remote project owner is unavailable')
    }
  }
}

function assertTarget(hostId: string, target: SshConnectionTarget): void {
  if (
    target.host.id !== hostId ||
    !target.host.hostKey ||
    target.host.hostKey.generation !== target.hostKeyGeneration ||
    target.hostRevision < 1 ||
    target.hostKeyGeneration < 1
  ) {
    throw new Error('SSH Host binding is unavailable')
  }
}

function assertInstallation(
  installation: AgentInstallationIdentity
): void {
  if (
    !/^[A-Za-z0-9](?:[A-Za-z0-9._:-]{0,127})$/u.test(
      installation.installationId
    ) ||
    !sha256DigestSchema.safeParse(installation.binaryDigest).success ||
    installation.platform !== 'linux' ||
    !['x64', 'arm64'].includes(installation.architecture) ||
    installation.supervisor !== 'detached-on-demand'
  ) {
    throw new Error('Remote Agent installation is incompatible')
  }
}

function assertConnectionIdentity(
  target: SshConnectionTarget,
  installation: AgentInstallationIdentity,
  connection: RemoteAgentConnection
): void {
  if (
    connection.state !== 'ready' ||
    connection.identity.hostId !== target.host.id ||
    connection.identity.hostRevision !== target.hostRevision ||
    connection.identity.hostKeyGeneration !== target.hostKeyGeneration ||
    connection.identity.remoteUsername !== target.host.username ||
    connection.identity.installationId !== installation.installationId ||
    connection.identity.binaryDigest !== installation.binaryDigest ||
    connection.status.state !== 'ready' ||
    connection.status.draining ||
    connection.status.installationId !== installation.installationId ||
    connection.status.binaryDigest !== installation.binaryDigest
  ) {
    throw new Error('Remote Agent identity is incompatible')
  }
}

function assertCriticalWorkspaceRead(
  connection: RemoteAgentConnection
): void {
  const capability = connection.capabilities.capabilities.find(
    (entry) => entry.name === WORKSPACE_READ_CAPABILITY.name
  )
  if (
    !capability ||
    capability.version < WORKSPACE_READ_CAPABILITY.minimumVersion ||
    !capability.critical
  ) {
    throw new Error('Remote Agent lacks workspace read capability')
  }
}

function assertWorkspace(handle: RemoteWorkspaceHandle): void {
  if (
    handle.access !== 'read-only' ||
    REMOTE_WORKSPACE_READ_CAPABILITIES.some(
      (capability) => !handle.capabilities.includes(capability)
    ) ||
    handle.capabilities.includes('write-text-atomic') ||
    handle.capabilities.includes('apply-change-set')
  ) {
    throw new Error('Remote workspace validation is incompatible')
  }
}

function assertRuntimeEvidence(
  evidence: ProjectRuntimeValidation,
  selectionKey: string,
  installationId: string,
  workMode: 'ask' | 'execute'
): void {
  if (
    evidence.runtimeSelectionKey !== selectionKey ||
    evidence.agentInstallationIdAtValidation !== installationId ||
    evidence.workMode !== workMode
  ) {
    throw new Error('Remote Runtime validation does not match the project')
  }
}

function assertPrecondition(
  expected: ValidatedSshHostPrecondition,
  target: SshConnectionTarget,
  installation: AgentInstallationIdentity,
  workspace: RemoteWorkspaceHandle
): void {
  if (
    expected.hostId !== target.host.id ||
    expected.hostRevision !== target.hostRevision ||
    expected.hostKeyGeneration !== target.hostKeyGeneration ||
    expected.remoteUsername !== target.host.username ||
    expected.remoteRootPath !== workspace.canonicalDisplayPath ||
    expected.workspaceIdentity !== workspace.workspaceIdentity ||
    expected.agentProtocolMajor !== installation.protocol.major ||
    expected.agentInstallationId !== installation.installationId ||
    expected.agentBinaryDigest !== installation.binaryDigest ||
    expected.agentVersion !== installation.agentVersion ||
    expected.agentArchitecture !== installation.architecture
  ) {
    throw new Error('Validated SSH project precondition changed')
  }
}

function currentTargetEvidence(
  target: SshConnectionTarget
): CurrentSshConnectionTarget {
  return {
    hostId: target.host.id,
    hostRevision: target.hostRevision,
    hostKeyGeneration: target.hostKeyGeneration,
    username: target.host.username
  }
}

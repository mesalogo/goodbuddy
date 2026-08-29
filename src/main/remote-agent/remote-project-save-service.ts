import type { AssistantProject } from '../../shared/assistant-contracts'
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
import type { AgentRuntimeSelection } from '../../shared/runtime-selection-contracts'
import type {
  AssistantDatabase,
  SshProjectWrite
} from '../assistant/assistant-database'
import type {
  SshConnectionTarget,
  SshHostStore
} from '../ssh/ssh-host-store'
import {
  assertValidSshConnectionTarget,
  toCurrentSshConnectionTarget
} from '../ssh/ssh-connection-target'
import type {
  AgentInstallationIdentity,
  AgentInstallationManager
} from './agent-installation-manager'
import {
  type RemoteAgentConnection,
  type RemoteAgentConnectionManager
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
  host: Readonly<{
    hostId: string
    hostRevision: number
    hostKeyGeneration: number
    remoteUsername: string
  }>
  agent: Readonly<{
    installationId: AgentInstallationIdentity['installationId']
    binaryDigest: string
    version: string
    architecture: 'x64' | 'arm64'
    protocolMajor: number
  }>
  connection: RemoteAgentConnection
  signal: AbortSignal
}>

export interface RemoteProjectRuntimeValidationLease {
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
  connection?: RemoteAgentConnection
  workspace?: RemoteWorkspaceHandle
  runtimeLease?: RemoteProjectRuntimeValidationLease
}

type RemoteProjectPreparationDraft = Readonly<{
  hostId: string
  remoteRootPath: string
  runtimeSelection: AgentRuntimeSelection
}>

type PreparedRemoteProject = Readonly<{
  runtimeSelection: AgentRuntimeSelection
  target: SshConnectionTarget
  installation: AgentInstallationIdentity
  connection: RemoteAgentConnection
  workspace: RemoteWorkspaceHandle
  runtimeLease: RemoteProjectRuntimeValidationLease
}>

export type RemoteProjectSaveServiceOptions = {
  database: Pick<
    AssistantDatabase,
    | 'getProject'
    | 'createSshProject'
    | 'updateSshProject'
  >
  sshHosts: Pick<
    SshHostStore,
    'resolveConnectionTarget' | 'assertConnectionTargetCurrent'
  >
  installationManager: Pick<AgentInstallationManager, 'activateInstalled'>
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
    const active = this.#start(owner)

    try {
      return await this.#performSave(owner, active, request)
    } finally {
      await this.#finish(owner, active)
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
    const expectedUpdatedAt =
      request.intent === 'update'
        ? this.#readUpdateRevision(request)
        : undefined
    const prepared = await this.#prepare(
      owner,
      active,
      request.draft
    )

    this.#progress(owner, 'saving')
    active.controller.signal.throwIfAborted()
    const write = this.#projectWrite(request, prepared)
    return request.intent === 'create'
      ? this.#database.createSshProject(write)
      : this.#database.updateSshProject(
          request.draft.projectId,
          expectedUpdatedAt!,
          write
        )
  }

  async #prepare(
    owner: RemoteProjectSaveOwner,
    active: ActiveSave,
    draft: RemoteProjectPreparationDraft
  ): Promise<PreparedRemoteProject> {
    const { signal } = active.controller
    const runtimeSelection = await this.#resolveRuntimeSelection(
      draft.runtimeSelection
    )
    signal.throwIfAborted()

    this.#progress(owner, 'host')
    const target = await this.#sshHosts.resolveConnectionTarget(
      draft.hostId
    )
    signal.throwIfAborted()
    assertValidSshConnectionTarget(
      draft.hostId,
      target,
      'SSH Host binding is unavailable'
    )

    this.#progress(owner, 'agent')
    const installation =
      await this.#installationManager.activateInstalled(
        draft.hostId,
        { signal }
      )
    signal.throwIfAborted()
    assertInstallation(installation)
    const connection = await this.#connectionManager.acquire(
      draft.hostId,
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
          remoteRootPath: draft.remoteRootPath,
          requestedAccess: 'read-only',
          requiredCapabilities: [
            ...REMOTE_WORKSPACE_READ_CAPABILITIES
          ]
        },
        { signal }
      )
    )
    active.workspace = validated.handle
    signal.throwIfAborted()
    assertWorkspace(validated.handle)
    if (
      validated.handle.canonicalDisplayPath !== draft.remoteRootPath
    ) {
      throw new Error('Remote workspace path changed during validation')
    }
    assertCriticalWorkspaceRead(connection)

    this.#progress(owner, 'runtime')
    const runtimeLease = await this.#runtimeValidator.validate({
      selection: runtimeSelection,
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
      connection,
      signal
    })
    active.runtimeLease = runtimeLease
    signal.throwIfAborted()
    runtimeLease.assertCurrent()
    return {
      runtimeSelection,
      target,
      installation,
      connection,
      workspace: validated.handle,
      runtimeLease
    }
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

  #projectWrite(
    request: RemoteProjectSaveRequest,
    prepared: PreparedRemoteProject
  ): SshProjectWrite {
    const {
      runtimeSelection,
      target,
      installation,
      connection,
      workspace,
      runtimeLease
    } = prepared
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
        remoteRootPath: workspace.canonicalDisplayPath
      },
      assertCurrent: () => {
        this.#sshHosts.assertConnectionTargetCurrent(
          toCurrentSshConnectionTarget(target)
        )
        assertConnectionIdentity(target, installation, connection)
        assertCriticalWorkspaceRead(connection)
        runtimeLease.assertCurrent()
      }
    }
  }

  #start(owner: RemoteProjectSaveOwner): ActiveSave {
    const controller = new AbortController()
    let resolveDone!: () => void
    const active: ActiveSave = {
      controller,
      done: new Promise<void>((resolve) => {
        resolveDone = resolve
      }),
      resolveDone,
      destroyedListener: () => {
        controller.abort(
          new DOMException(
            'Remote project owner was destroyed',
            'AbortError'
          )
        )
      }
    }
    this.#active.set(owner, active)
    owner.on('destroyed', active.destroyedListener)
    return active
  }

  async #finish(
    owner: RemoteProjectSaveOwner,
    active: ActiveSave
  ): Promise<void> {
    try {
      await this.#cleanup(active)
    } finally {
      owner.removeListener('destroyed', active.destroyedListener)
      if (this.#active.get(owner) === active) {
        this.#active.delete(owner)
      }
      active.resolveDone()
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
  installation: Pick<
    AgentInstallationIdentity,
    'installationId' | 'binaryDigest'
  >,
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

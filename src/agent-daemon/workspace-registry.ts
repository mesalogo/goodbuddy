import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import {
  REMOTE_WORKSPACE_READ_CAPABILITIES,
  type RemoteWorkspaceCloseResult,
  type RemoteWorkspaceHandle,
  type RemoteWorkspaceOpenRequest,
  type RemoteWorkspaceResumeRequest,
  type RemoteWorkspaceResumeResult,
  type RemoteWorkspaceValidateRequest,
  type RemoteWorkspaceValidateResult
} from '../shared/remote-agent-contracts'
import {
  type ControllerLease,
  type ControllerRegistry
} from './controller-registry'
import {
  inspectWorkspaceRoot,
  WorkspacePathAccess,
  WorkspaceServiceError,
  type WorkspaceIoOptions
} from './workspace-path-access'
import {
  assertPrivateRegularFile,
  writePrivateFileAtomic
} from './managed-paths'

const DEFAULT_MAXIMUM_CONTROLLER_HANDLES = 32
const DEFAULT_MAXIMUM_DAEMON_HANDLES = 256
const DEFAULT_MAXIMUM_VALIDATED_ROOTS = 256
const EPHEMERAL_REGISTRY_MARKER = Object.freeze({
  version: 2,
  authorization: 'ephemeral'
})

type GitAvailability =
  | 'available'
  | 'not-a-repository'
  | 'unavailable'

type ValidatedRoot = {
  access: WorkspacePathAccess
  git: GitAvailability
}

export type WorkspaceLease = {
  handle: RemoteWorkspaceHandle
  controllerId: string
  controllerGeneration: number
  access: WorkspacePathAccess
}

type MutableWorkspaceLease = WorkspaceLease & {
  closed: boolean
  authorizesOpen: boolean
  grantWorkspaceId: string
}

export type WorkspaceRegistryOptions = {
  controllers: ControllerRegistry
  maximumControllerHandles?: number
  maximumDaemonHandles?: number
  maximumValidatedRoots?: number
  inspectGit?: (
    access: WorkspacePathAccess,
    options?: WorkspaceIoOptions
  ) => Promise<GitAvailability>
  now?: () => number
  storagePath?: string
}

export class WorkspaceRegistry {
  readonly #controllers: ControllerRegistry
  readonly #maximumControllerHandles: number
  readonly #maximumDaemonHandles: number
  readonly #maximumValidatedRoots: number
  readonly #inspectGit: NonNullable<WorkspaceRegistryOptions['inspectGit']>
  readonly #now: () => number
  readonly #storagePath?: string
  readonly #validatedRoots = new Map<string, ValidatedRoot>()
  readonly #leases = new Map<string, MutableWorkspaceLease>()
  readonly #nextGenerationByIdentity = new Map<string, number>()

  constructor(options: WorkspaceRegistryOptions) {
    this.#controllers = options.controllers
    this.#maximumControllerHandles = boundedCap(
      options.maximumControllerHandles ??
        DEFAULT_MAXIMUM_CONTROLLER_HANDLES,
      'per-controller workspace handle'
    )
    this.#maximumDaemonHandles = boundedCap(
      options.maximumDaemonHandles ?? DEFAULT_MAXIMUM_DAEMON_HANDLES,
      'daemon workspace handle'
    )
    this.#maximumValidatedRoots = boundedCap(
      options.maximumValidatedRoots ?? DEFAULT_MAXIMUM_VALIDATED_ROOTS,
      'validated workspace root'
    )
    this.#inspectGit =
      options.inspectGit ??
      (async () => 'unavailable')
    this.#now = options.now ?? Date.now
    this.#storagePath = options.storagePath
    this.#load()
  }

  async validate(
    request: RemoteWorkspaceValidateRequest,
    controller: ControllerLease,
    options: WorkspaceIoOptions = {}
  ): Promise<RemoteWorkspaceValidateResult> {
    this.#assertController(controller)
    this.#assertReadOnly(
      request.requestedAccess,
      request.requiredCapabilities
    )
    const rootIdentity = await inspectWorkspaceRoot(
      request.remoteRootPath,
      options
    )
    const access = new WorkspacePathAccess(rootIdentity)
    const existing = this.#validatedRoots.get(
      rootIdentity.workspaceIdentity
    )
    if (
      existing !== undefined &&
      existing.access.root.canonicalPath !== rootIdentity.canonicalPath
    ) {
      throw new WorkspaceServiceError(
        'Workspace file identity is already bound to another canonical root',
        'stale-workspace'
      )
    }
    const git = await this.#inspectGit(access, options)
    const capabilities = capabilitiesFor(git)
    for (const capability of request.requiredCapabilities) {
      if (!capabilities.includes(capability)) {
        throw new WorkspaceServiceError(
          `Required workspace capability is unavailable: ${capability}`,
          'unavailable'
        )
      }
    }
    if (
      existing === undefined &&
      this.#validatedRoots.size >= this.#maximumValidatedRoots
    ) {
      throw new WorkspaceServiceError(
        'Validated workspace root capacity reached',
        'capacity-exceeded'
      )
    }
    this.#validatedRoots.set(rootIdentity.workspaceIdentity, {
      access,
      git
    })
    let lease: WorkspaceLease
    try {
      lease = await this.#createLease(
        this.#validatedRoots.get(rootIdentity.workspaceIdentity)!,
        controller,
        true,
        undefined,
        options
      )
    } catch (error) {
      if (existing === undefined) {
        this.#validatedRoots.delete(rootIdentity.workspaceIdentity)
      } else {
        this.#validatedRoots.set(rootIdentity.workspaceIdentity, existing)
      }
      throw error
    }
    return {
      handle: lease.handle,
      validatedAt: new Date(this.#now()).toISOString()
    }
  }

  async open(
    request: RemoteWorkspaceOpenRequest,
    controller: ControllerLease,
    options: WorkspaceIoOptions = {}
  ): Promise<RemoteWorkspaceHandle> {
    this.#assertController(controller)
    this.#assertReadOnly(request.requestedAccess, [])
    const root = this.#validatedRoots.get(request.workspaceIdentity)
    if (root === undefined) {
      throw new WorkspaceServiceError(
        'Workspace identity has no live validation grant',
        'workspace-not-found'
      )
    }
    const liveGrants = [...this.#leases.values()].filter(
      (lease) =>
        !lease.closed &&
        lease.authorizesOpen &&
        lease.handle.workspaceIdentity === request.workspaceIdentity
    )
    if (
      !liveGrants.some(
        (lease) =>
          lease.controllerId === controller.controllerId &&
          lease.controllerGeneration === controller.generation
      )
    ) {
      if (
        liveGrants.some(
          (lease) => lease.controllerId !== controller.controllerId
        )
      ) {
        throw new WorkspaceServiceError(
          'Workspace identity belongs to another controller',
          'not-owner'
        )
      }
      throw new WorkspaceServiceError(
        'Workspace identity has no live validation grant',
        'workspace-not-found'
      )
    }
    return (
      await this.#createLease(
        root,
        controller,
        false,
        liveGrants.find(
          (lease) =>
            lease.controllerId === controller.controllerId &&
            lease.controllerGeneration === controller.generation
        )?.grantWorkspaceId,
        options
      )
    ).handle
  }

  async resume(
    request: RemoteWorkspaceResumeRequest,
    controller: ControllerLease,
    options: WorkspaceIoOptions = {}
  ): Promise<RemoteWorkspaceResumeResult> {
    this.#assertController(controller)
    const lease = this.#leases.get(request.workspaceId)
    if (
      lease === undefined ||
      lease.closed ||
      lease.handle.workspaceIdentity !== request.workspaceIdentity
    ) {
      throw new WorkspaceServiceError(
        'Workspace handle is unavailable',
        'workspace-not-found'
      )
    }
    if (lease.controllerId !== controller.controllerId) {
      throw new WorkspaceServiceError(
        'Workspace handle belongs to another controller',
        'not-owner'
      )
    }
    if (lease.controllerGeneration !== controller.generation) {
      throw new WorkspaceServiceError(
        'Workspace handle is unavailable after reconnect',
        'workspace-not-found'
      )
    }
    if (lease.handle.generation !== request.generation) {
      throw new WorkspaceServiceError(
        'Workspace handle generation is stale',
        'stale-generation'
      )
    }
    await lease.access.assertCurrent(options)
    return { resumed: true, handle: { ...lease.handle } }
  }

  async close(
    workspaceId: string,
    generation: number,
    controller: ControllerLease
  ): Promise<RemoteWorkspaceCloseResult> {
    const lease = this.#assertLease(
      workspaceId,
      generation,
      controller
    )
    if (lease.authorizesOpen) {
      this.#revokeGrant(lease.grantWorkspaceId)
    } else {
      lease.closed = true
      this.#leases.delete(workspaceId)
      this.#removeUnusedRoot(lease.handle.workspaceIdentity)
    }
    return { workspaceId, generation, closed: true }
  }

  async get(
    workspaceId: string,
    generation: number,
    controller: ControllerLease,
    options: WorkspaceIoOptions = {}
  ): Promise<WorkspaceLease> {
    const lease = this.#assertLease(
      workspaceId,
      generation,
      controller
    )
    await lease.access.assertCurrent(options)
    return snapshotLease(lease)
  }

  async getCurrentByIdentity(
    workspaceIdentity: string,
    controller: ControllerLease,
    options: WorkspaceIoOptions = {}
  ): Promise<WorkspaceLease> {
    this.#assertController(controller)
    const leases = [...this.#leases.values()].filter(
      (lease) =>
        !lease.closed &&
        lease.handle.workspaceIdentity === workspaceIdentity &&
        lease.controllerId === controller.controllerId &&
        lease.controllerGeneration === controller.generation
    )
    if (leases.length === 0) {
      const ownedByAnotherController = [...this.#leases.values()].some(
        (lease) =>
          !lease.closed &&
          lease.handle.workspaceIdentity === workspaceIdentity &&
          lease.controllerId !== controller.controllerId
      )
      throw new WorkspaceServiceError(
        ownedByAnotherController
          ? 'Workspace identity belongs to another controller'
          : 'Workspace identity has no current controller lease',
        ownedByAnotherController ? 'not-owner' : 'workspace-not-found'
      )
    }
    const lease =
      leases.find((candidate) => candidate.authorizesOpen) ??
      leases[0]!
    await lease.access.assertCurrent(options)
    return snapshotLease(lease)
  }

  closeAll(): void {
    for (const lease of this.#leases.values()) {
      lease.closed = true
    }
    this.#leases.clear()
    this.#validatedRoots.clear()
  }

  closeController(
    controller: Pick<ControllerLease, 'controllerId' | 'generation'>
  ): void {
    const affectedIdentities = new Set<string>()
    for (const [workspaceId, lease] of this.#leases) {
      if (
        lease.controllerId !== controller.controllerId ||
        lease.controllerGeneration !== controller.generation
      ) {
        continue
      }
      lease.closed = true
      this.#leases.delete(workspaceId)
      affectedIdentities.add(lease.handle.workspaceIdentity)
    }
    for (const workspaceIdentity of affectedIdentities) {
      this.#removeUnusedRoot(workspaceIdentity)
    }
  }

  activeHandleCount(): number {
    return this.#leases.size
  }

  #assertLease(
    workspaceId: string,
    generation: number,
    controller: ControllerLease
  ): MutableWorkspaceLease {
    this.#assertController(controller)
    const lease = this.#leases.get(workspaceId)
    if (lease === undefined || lease.closed) {
      throw new WorkspaceServiceError(
        'Workspace handle is unavailable',
        'workspace-not-found'
      )
    }
    if (lease.controllerId !== controller.controllerId) {
      throw new WorkspaceServiceError(
        'Workspace handle belongs to another controller',
        'not-owner'
      )
    }
    if (lease.controllerGeneration !== controller.generation) {
      throw new WorkspaceServiceError(
        'Workspace handle is unavailable after reconnect',
        'workspace-not-found'
      )
    }
    if (lease.handle.generation !== generation) {
      throw new WorkspaceServiceError(
        'Workspace handle generation is stale',
        'stale-generation'
      )
    }
    return lease
  }

  async #createLease(
    root: ValidatedRoot,
    controller: ControllerLease,
    authorizesOpen: boolean,
    grantWorkspaceId: string | undefined,
    options: WorkspaceIoOptions
  ): Promise<WorkspaceLease> {
    this.#assertCapacity(controller.controllerId)
    await root.access.assertCurrent(options)
    throwIfAborted(options.signal)
    const workspaceIdentity = root.access.root.workspaceIdentity
    const generation =
      (this.#nextGenerationByIdentity.get(workspaceIdentity) ?? 0) + 1
    if (generation > 0xffff_ffff) {
      throw new WorkspaceServiceError(
        'Workspace generation is exhausted',
        'capacity-exceeded'
      )
    }
    this.#nextGenerationByIdentity.set(workspaceIdentity, generation)
    const workspaceId = `workspace-${randomBytes(18).toString('base64url')}`
    if (!authorizesOpen && grantWorkspaceId === undefined) {
      throw new WorkspaceServiceError(
        'Workspace identity has no live validation grant',
        'workspace-not-found'
      )
    }
    const handle: RemoteWorkspaceHandle = {
      workspaceId,
      workspaceIdentity,
      canonicalDisplayPath: root.access.root.canonicalPath,
      access: 'read-only',
      git: root.git,
      capabilities: capabilitiesFor(root.git),
      generation
    }
    const lease: MutableWorkspaceLease = {
      handle,
      controllerId: controller.controllerId,
      controllerGeneration: controller.generation,
      access: root.access,
      closed: false,
      authorizesOpen,
      grantWorkspaceId: grantWorkspaceId ?? workspaceId
    }
    this.#leases.set(workspaceId, lease)
    return snapshotLease(lease)
  }

  #assertCapacity(controllerId: string): void {
    if (this.#leases.size >= this.#maximumDaemonHandles) {
      throw new WorkspaceServiceError(
        'Daemon workspace handle capacity reached',
        'capacity-exceeded'
      )
    }
    let owned = 0
    for (const lease of this.#leases.values()) {
      if (!lease.closed && lease.controllerId === controllerId) {
        owned += 1
      }
    }
    if (owned >= this.#maximumControllerHandles) {
      throw new WorkspaceServiceError(
        'Controller workspace handle capacity reached',
        'capacity-exceeded'
      )
    }
  }

  #assertController(controller: ControllerLease): void {
    this.#controllers.assertCurrent(
      controller.controllerId,
      controller.generation
    )
  }

  #assertReadOnly(
    requestedAccess: 'read-only' | 'read-write',
    capabilities: readonly string[]
  ): void {
    if (
      requestedAccess !== 'read-only' ||
      capabilities.includes('write-text-atomic') ||
      capabilities.includes('apply-change-set')
    ) {
      throw new WorkspaceServiceError(
        'Remote workspace writes are not available',
        'read-only'
      )
    }
  }

  #load(): void {
    if (this.#storagePath === undefined) {
      return
    }
    let parsed: unknown
    try {
      assertPrivateRegularFile(this.#storagePath)
      parsed = JSON.parse(readFileSync(this.#storagePath, 'utf8'))
    } catch (error) {
      if (isErrno(error, 'ENOENT')) {
        return
      }
      throw error
    }
    if (
      parsed === null ||
      typeof parsed !== 'object' ||
      Array.isArray(parsed)
    ) {
      throw new Error('Workspace registry is corrupt')
    }
    const value = parsed as Record<string, unknown>
    if (
      value.version === EPHEMERAL_REGISTRY_MARKER.version &&
      value.authorization === EPHEMERAL_REGISTRY_MARKER.authorization &&
      Object.keys(value).length === 2
    ) {
      return
    }
    if (
      value.version === 1 &&
      Array.isArray(value.roots) &&
      Array.isArray(value.leases)
    ) {
      this.#persistMarker()
      return
    }
    throw new Error('Workspace registry is corrupt')
  }

  #persistMarker(): void {
    if (this.#storagePath === undefined) {
      return
    }
    writePrivateFileAtomic(
      this.#storagePath,
      JSON.stringify(EPHEMERAL_REGISTRY_MARKER)
    )
  }

  #removeUnusedRoot(workspaceIdentity: string): void {
    for (const lease of this.#leases.values()) {
      if (
        !lease.closed &&
        lease.handle.workspaceIdentity === workspaceIdentity
      ) {
        return
      }
    }
    this.#validatedRoots.delete(workspaceIdentity)
  }

  #revokeGrant(grantWorkspaceId: string): void {
    const affectedIdentities = new Set<string>()
    for (const [workspaceId, lease] of this.#leases) {
      if (lease.grantWorkspaceId !== grantWorkspaceId) {
        continue
      }
      lease.closed = true
      this.#leases.delete(workspaceId)
      affectedIdentities.add(lease.handle.workspaceIdentity)
    }
    for (const workspaceIdentity of affectedIdentities) {
      this.#removeUnusedRoot(workspaceIdentity)
    }
  }
}

function capabilitiesFor(
  git: GitAvailability
): RemoteWorkspaceHandle['capabilities'] {
  return [
    ...REMOTE_WORKSPACE_READ_CAPABILITIES,
    ...(git === 'available'
      ? (['git-status', 'git-diff'] as const)
      : [])
  ]
}

function isErrno(error: unknown, code: string): boolean {
  return (
    error !== null &&
    typeof error === 'object' &&
    'code' in error &&
    error.code === code
  )
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted === true) {
    throw signal.reason
  }
}

function boundedCap(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 100_000) {
    throw new RangeError(`Invalid ${label} capacity`)
  }
  return value
}

function snapshotLease(lease: MutableWorkspaceLease): WorkspaceLease {
  return {
    handle: { ...lease.handle, capabilities: [...lease.handle.capabilities] },
    controllerId: lease.controllerId,
    controllerGeneration: lease.controllerGeneration,
    access: lease.access
  }
}

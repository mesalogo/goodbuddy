import { createHash, randomUUID } from 'node:crypto'
import {
  agentReleaseKeyRegistrySchema,
  type AgentArchitecture,
  type AgentReleaseKeyRegistry
} from '../../shared/agent-installation-contracts'
import type { AgentBootstrapIncompatibleReason } from '../../shared/ssh-host-contracts'
import {
  assertRuntimeManifestMatchesLock,
  verifyRuntimeManifestSignature
} from '../../shared/node/runtime-bundle-verifier'
import {
  parseRuntimeRegistryState
} from '../../shared/remote-environment-registry-contracts'
import {
  digestRemoteRuntimeBundleManifest,
  remoteRuntimeLockSchema,
  type RemoteRuntimeBundleManifest,
  type RemoteRuntimeLock
} from '../../shared/remote-runtime-launch-contracts'
import { sha256DigestSchema } from '../../shared/agent-protocol/contracts'
import type {
  BoundedSftpLimits,
  SftpEntryMetadata,
  StagedSftp
} from '../ssh/bounded-sftp'
import type {
  SshConnectionLease,
  SshConnectionPool,
  SshConnectionPoolTarget
} from '../ssh/ssh-connection-pool'
import type {
  SshRemotePackageRuntimeIdentity
} from '../ssh/ssh-remote-package-bootstrap'
import type { VerifiedAgentInstallationId } from '../ssh/ssh-agent-command'
import { settleBoundedly } from './bounded-settlement'
import {
  parseAgentReleaseKeyRegistryBytes
} from './agent-bundle-verifier'
import { isMissingPathError } from './path-errors'
import { remoteHostTargetIdentityKey } from './remote-host-target-identity'

const MAXIMUM_INSTALLATION_FILES = 200
const MAXIMUM_INSTALLATION_BYTES = 512 * 1024 * 1024
const MAXIMUM_RUNTIME_FILE_BYTES = 256 * 1024 * 1024
const MAXIMUM_METADATA_BYTES = 1024 * 1024
const MAXIMUM_CLEANUP_ENTRIES = 512
const METADATA_MODE = 0o644
const PRIVATE_FILE_MODE = 0o600
const PRIVATE_DIRECTORY_MODE = 0o700
const DISPOSE_WAIT_TIMEOUT_MS = 5_000

const RUNTIME_ROOT = '.goodbuddy/runtimes'
const OPENCODE_ROOT = `${RUNTIME_ROOT}/opencode`
const RELEASE_KEYS_PATH = `${RUNTIME_ROOT}/release-keys.json`
const RUNTIME_LOCK_PATH = `${RUNTIME_ROOT}/remote-runtime-lock.json`
const RUNTIME_REGISTRY_PATH = `${RUNTIME_ROOT}/registry.json`

export type RemoteRuntimeInstallationPhase =
  | 'inspecting-host'
  | 'verifying-bundle'
  | 'activating-runtime'
  | 'complete'

export type RemoteRuntimeInstallationIdentity = {
  runtimeId: string
  runtimeVersion: string
  bundleDigest: string
  manifestDigest: string
  runtimeAdapterDigest: string
  acpCapabilitiesDigest: string
  platform: 'linux'
  architecture: AgentArchitecture
}

export interface RemoteRuntimeInstallationTargetResolver {
  resolve(hostId: string): Promise<SshConnectionPoolTarget>
}

export type RemoteRuntimeActivationRequestOptions = {
  signal?: AbortSignal
  onProgress?: (phase: RemoteRuntimeInstallationPhase) => void
  agentInstallationId?: VerifiedAgentInstallationId
}

export type PublishedRemoteRuntimeInstallationIdentity =
  SshRemotePackageRuntimeIdentity

export class RemoteRuntimeInstallationError extends Error {
  constructor(
    message: string,
    readonly reason:
      | 'incompatible'
      | 'corrupt'
      | 'host-identity-changed'
      | 'capacity'
      | 'activation',
    readonly detail?: AgentBootstrapIncompatibleReason | unknown
  ) {
    super(message)
    this.name = 'RemoteRuntimeInstallationError'
  }
}

type RuntimeBundleBase = {
  bundleDirectory: string
  manifest: RemoteRuntimeBundleManifest
  manifestDigest: string
}

export type RemoteRuntimeInstallationVerificationMetadata = {
  releaseKeyRegistry: AgentReleaseKeyRegistry
  runtimeLock: RemoteRuntimeLock
  canonicalReleaseKeyRegistryBytes: Uint8Array
  canonicalRemoteRuntimeLockBytes: Uint8Array
}

export type RemoteRuntimeInstallationVerificationMetadataLoader =
  (
    architecture: AgentArchitecture
  ) => Promise<RemoteRuntimeInstallationVerificationMetadata>

export type RemoteRuntimeActivator = (
  lease: SshConnectionLease,
  runtimeId: string,
  bundleDigest: string,
  architecture: AgentArchitecture,
  agentInstallationId: VerifiedAgentInstallationId | undefined,
  signal: AbortSignal
) => Promise<void>

type ActiveInstallation = {
  promise: Promise<RemoteRuntimeInstallationIdentity>
  controller: AbortController
  progressCallbacks: Set<
    (phase: RemoteRuntimeInstallationPhase) => void
  >
  waiters: number
  settled: boolean
}

type CleanupEntry = {
  path: string
  type: 'file' | 'directory'
}

type ManagedFileSnapshot = {
  path: string
  contents: Buffer | undefined
  uid: number
}

type LoadedBundle = RuntimeBundleBase & {
  releaseKeyRegistryBytes: Buffer
  remoteRuntimeLockBytes: Buffer
}

export class RemoteRuntimeInstallationManager {
  readonly #resolver: RemoteRuntimeInstallationTargetResolver
  readonly #sshPool: Pick<SshConnectionPool, 'acquire'>
  readonly #loadVerificationMetadata?:
    RemoteRuntimeInstallationVerificationMetadataLoader
  readonly #activate: RemoteRuntimeActivator
  readonly #sftpLimits?: BoundedSftpLimits
  readonly #maximumConcurrentHosts: number
  readonly #active = new Map<string, ActiveInstallation>()
  readonly #current = new Map<
    string,
    {
      targetKey: string
      agentKey: string
      identity: RemoteRuntimeInstallationIdentity
    }
  >()
  readonly #cacheGenerations = new Map<string, number>()
  #closed = false
  #disposePromise: Promise<void> | undefined

  constructor(options: {
    resolver: RemoteRuntimeInstallationTargetResolver
    sshPool: Pick<SshConnectionPool, 'acquire'>
    loadVerificationMetadata?:
      RemoteRuntimeInstallationVerificationMetadataLoader
    activate: RemoteRuntimeActivator
    sftpLimits?: BoundedSftpLimits
    maximumConcurrentHosts?: number
  }) {
    this.#resolver = options.resolver
    this.#sshPool = options.sshPool
    this.#loadVerificationMetadata =
      options.loadVerificationMetadata
    this.#activate = options.activate
    this.#sftpLimits = options.sftpLimits
    this.#maximumConcurrentHosts =
      options.maximumConcurrentHosts ?? 8
    if (
      !Number.isSafeInteger(this.#maximumConcurrentHosts) ||
      this.#maximumConcurrentHosts <= 0 ||
      this.#maximumConcurrentHosts > 32
    ) {
      throw new Error(
        'Remote Runtime installation concurrency limit is invalid'
      )
    }
  }

  /**
   * Verifies and activates the installed Runtime selected by packaged trust
   * metadata without loading or publishing installable Runtime payloads.
   */
  async activateInstalled(
    hostId: string,
    options: RemoteRuntimeActivationRequestOptions = {}
  ): Promise<RemoteRuntimeInstallationIdentity> {
    return this.#request(hostId, 'activate', options)
  }

  /**
   * Verifies and activates the exact Runtime directory already published by
   * the authenticated package installer, installing canonical metadata but
   * never loading or staging payloads.
   */
  async activatePublished(
    hostId: string,
    expectedIdentity: PublishedRemoteRuntimeInstallationIdentity,
    options: RemoteRuntimeActivationRequestOptions = {}
  ): Promise<RemoteRuntimeInstallationIdentity> {
    assertPublishedRuntimeIdentity(expectedIdentity)
    return this.#request(
      hostId,
      'adopt',
      options,
      expectedIdentity
    )
  }

  invalidateHost(hostId: string): void {
    this.#current.delete(hostId)
    this.#cacheGenerations.set(
      hostId,
      (this.#cacheGenerations.get(hostId) ?? 0) + 1
    )
  }

  async #request(
    hostId: string,
    mode: 'activate' | 'adopt',
    options: RemoteRuntimeActivationRequestOptions,
    expectedIdentity?: PublishedRemoteRuntimeInstallationIdentity
  ): Promise<RemoteRuntimeInstallationIdentity> {
    this.#throwIfClosed()
    options.signal?.throwIfAborted()
    emitOne(options.onProgress, 'inspecting-host')
    const target = await this.#resolver.resolve(hostId)
    this.#throwIfClosed()
    options.signal?.throwIfAborted()
    if (target.host.id !== hostId) {
      throw new RemoteRuntimeInstallationError(
        'Resolved SSH host does not match the Runtime installation request',
        'host-identity-changed'
      )
    }

    const targetKey = remoteHostTargetIdentityKey(target)
    const agentKey = options.agentInstallationId ?? ''
    const cacheGeneration =
      this.#cacheGenerations.get(hostId) ?? 0
    if (mode === 'activate') {
      const current = this.#current.get(hostId)
      if (
        current?.targetKey === targetKey &&
        current.agentKey === agentKey
      ) {
        emitOne(options.onProgress, 'complete')
        return current.identity
      }
    }
    const operationKey = mode === 'adopt'
      ? `${mode}:${targetKey}:${publishedRuntimeIdentityKey(
          expectedIdentity!
        )}:${agentKey}`
      : `${mode}:${targetKey}:${agentKey}`
    const existing = this.#active.get(operationKey)
    if (existing) {
      return this.#waitForActive(existing, options)
    }
    if (this.#active.size >= this.#maximumConcurrentHosts) {
      throw new RemoteRuntimeInstallationError(
        'Too many remote Runtime installations are already running',
        'capacity'
      )
    }

    const progressCallbacks = new Set<
      (phase: RemoteRuntimeInstallationPhase) => void
    >()
    const controller = new AbortController()
    const progress = (
      phase: RemoteRuntimeInstallationPhase
    ): void => {
      for (const callback of progressCallbacks) {
        emitOne(callback, phase)
      }
    }
    const promise = (mode === 'activate'
      ? this.#activateInstalled(
          target,
          options.agentInstallationId,
          controller.signal,
          progress
        )
      : this.#activatePublished(
          target,
          expectedIdentity!,
          options.agentInstallationId,
          controller.signal,
          progress
        )).then((identity) => {
          if (
            mode === 'activate' &&
            (this.#cacheGenerations.get(hostId) ?? 0) ===
              cacheGeneration
          ) {
            this.#current.set(hostId, {
              targetKey,
              agentKey,
              identity
            })
          }
          return identity
        })
    const active: ActiveInstallation = {
      promise,
      controller,
      progressCallbacks,
      waiters: 0,
      settled: false
    }
    this.#active.set(operationKey, active)
    void active.promise.finally(() => {
      active.settled = true
      if (this.#active.get(operationKey) === active) {
        this.#active.delete(operationKey)
      }
    }).catch(() => undefined)
    return this.#waitForActive(active, options)
  }

  dispose(): Promise<void> {
    if (this.#disposePromise) {
      return this.#disposePromise
    }
    this.#closed = true
    this.#current.clear()
    this.#cacheGenerations.clear()
    const operations = [...this.#active.values()]
    const reason = new DOMException(
      'Remote Runtime installation manager was disposed',
      'AbortError'
    )
    for (const operation of operations) {
      operation.controller.abort(reason)
    }
    this.#disposePromise = settleBoundedly(
      operations.map((operation) => operation.promise),
      DISPOSE_WAIT_TIMEOUT_MS
    )
    return this.#disposePromise
  }

  #throwIfClosed(): void {
    if (this.#closed) {
      throw new Error(
        'Remote Runtime installation manager is disposed'
      )
    }
  }

  async #waitForActive(
    active: ActiveInstallation,
    options: RemoteRuntimeActivationRequestOptions
  ): Promise<RemoteRuntimeInstallationIdentity> {
    active.waiters += 1
    if (options.onProgress) {
      active.progressCallbacks.add(options.onProgress)
    }
    try {
      return await waitForOperation(active.promise, options.signal)
    } finally {
      if (options.onProgress) {
        active.progressCallbacks.delete(options.onProgress)
      }
      active.waiters -= 1
      if (
        active.waiters === 0 &&
        !active.settled &&
        !active.controller.signal.aborted
      ) {
        active.controller.abort(
          new DOMException(
            'Remote Runtime installation has no remaining waiters',
            'AbortError'
          )
        )
      }
    }
  }

  async #activateInstalled(
    target: SshConnectionPoolTarget,
    agentInstallationId: VerifiedAgentInstallationId | undefined,
    signal: AbortSignal,
    progress: (phase: RemoteRuntimeInstallationPhase) => void
  ): Promise<RemoteRuntimeInstallationIdentity> {
    let lease: SshConnectionLease | undefined
    try {
      lease = await this.#sshPool.acquire(target, signal)
      assertLeaseMatchesTarget(lease, target)
      const probe = await lease.runAgentBootstrapProbe(signal)
      if (!probe.ready) {
        throw new RemoteRuntimeInstallationError(
          `Remote host cannot activate the OpenCode Runtime: ${probe.reason}`,
          'incompatible',
          probe.reason
        )
      }
      if (
        probe.platform !== 'linux' ||
        (probe.architecture !== 'x64' &&
          probe.architecture !== 'arm64')
      ) {
        throw new RemoteRuntimeInstallationError(
          'Remote host platform or architecture is unsupported',
          'incompatible'
        )
      }
      progress('verifying-bundle')
      return await this.#reuseInstalledBundle(
        target,
        lease,
        probe,
        agentInstallationId,
        signal,
        progress
      )
    } catch (error) {
      if (
        error instanceof RemoteRuntimeInstallationError ||
        isAbortError(error)
      ) {
        throw error
      }
      throw new RemoteRuntimeInstallationError(
        'Remote Runtime activation data is corrupt or unsafe',
        'corrupt',
        safeErrorDetail(error)
      )
    } finally {
      lease?.release()
    }
  }

  async #activatePublished(
    target: SshConnectionPoolTarget,
    expected: PublishedRemoteRuntimeInstallationIdentity,
    agentInstallationId: VerifiedAgentInstallationId | undefined,
    signal: AbortSignal,
    progress: (phase: RemoteRuntimeInstallationPhase) => void
  ): Promise<RemoteRuntimeInstallationIdentity> {
    let lease: SshConnectionLease | undefined
    let sftp: StagedSftp | undefined
    let metadataSnapshots: readonly ManagedFileSnapshot[] | undefined
    const cleanup: CleanupEntry[] = []
    try {
      lease = await this.#sshPool.acquire(target, signal)
      assertLeaseMatchesTarget(lease, target)
      const probe = await lease.runAgentBootstrapProbe(signal)
      if (!probe.ready) {
        throw new RemoteRuntimeInstallationError(
          `Remote host cannot activate the published OpenCode Runtime: ${probe.reason}`,
          'incompatible',
          probe.reason
        )
      }
      if (
        probe.platform !== expected.platform ||
        probe.architecture !== expected.architecture
      ) {
        throw new RemoteRuntimeInstallationError(
          'Published Runtime does not match the Host platform or architecture',
          'incompatible'
        )
      }

      progress('verifying-bundle')
      const metadata = await this.#loadPublishedVerificationMetadata(
        probe.architecture
      )
      sftp = await lease.openStagedSftp(
        probe.canonicalHomeDirectory,
        {
          maximumFileBytes: Math.max(
            MAXIMUM_RUNTIME_FILE_BYTES,
            this.#sftpLimits?.maximumFileBytes ?? 0
          ),
          maximumTotalBytes: Math.max(
            MAXIMUM_INSTALLATION_BYTES +
              MAXIMUM_METADATA_BYTES * 6,
            this.#sftpLimits?.maximumTotalBytes ?? 0
          ),
          maximumOperations:
            this.#sftpLimits?.maximumOperations ?? 2_048,
          operationTimeoutMs:
            this.#sftpLimits?.operationTimeoutMs
        },
        signal
      )
      const destination =
        `${OPENCODE_ROOT}/${digestDirectoryName(
          expected.bundleDigest
        )}`
      const manifestBytes = await sftp.readFile(
        `${destination}/manifest.json`,
        signal
      )
      const signatureFile = await sftp.readFile(
        `${destination}/manifest.sig`,
        signal
      )
      const signature = decodeDetachedSignature(
        signatureFile,
        'Runtime detached signature'
      )
      const manifest = await verifyRuntimeManifestSignature(
        manifestBytes,
        signature,
        metadata.releaseKeyRegistry
      )
      assertRuntimeManifestMatchesLock(
        manifest,
        metadata.runtimeLock,
        probe.architecture
      )
      const manifestDigest =
        await digestRemoteRuntimeBundleManifest(manifest)
      const bundle: LoadedBundle = {
        bundleDirectory: destination,
        manifest,
        manifestDigest,
        releaseKeyRegistryBytes:
          metadata.releaseKeyRegistryBytes,
        remoteRuntimeLockBytes:
          metadata.remoteRuntimeLockBytes
      }
      assertPublishedRuntimeMatches(expected, bundle)
      assertBundleCapacity(bundle)
      // The fixed SSH installer has already verified the complete published
      // tree against this signed manifest. Adoption rechecks its immutable
      // identity and metadata without transferring the payload back to Main.
      await verifyRemoteBundleFromMetadata(
        sftp,
        destination,
        bundle,
        manifestBytes,
        signatureFile,
        probe.uid,
        signal
      )
      metadataSnapshots = []
      for (const path of [
        RELEASE_KEYS_PATH,
        RUNTIME_LOCK_PATH,
        RUNTIME_REGISTRY_PATH
      ]) {
        metadataSnapshots = [
          ...metadataSnapshots,
          await snapshotManagedFile(
            sftp,
            path,
            probe.uid,
            signal
          )
        ]
      }
      await installPrivateMetadata(
        sftp,
        RELEASE_KEYS_PATH,
        '.release-keys',
        metadata.releaseKeyRegistryBytes,
        probe.uid,
        cleanup,
        signal
      )
      await installPrivateMetadata(
        sftp,
        RUNTIME_LOCK_PATH,
        '.remote-runtime-lock',
        metadata.remoteRuntimeLockBytes,
        probe.uid,
        cleanup,
        signal
      )
      await assertCurrentTarget(
        this.#resolver,
        lease,
        target,
        signal
      )
      progress('activating-runtime')
      await activateRuntime(
        this.#activate,
        lease,
        bundle,
        agentInstallationId,
        signal
      )
      progress('complete')
      return publicIdentity(bundle)
    } catch (error) {
      if (metadataSnapshots && sftp) {
        await restoreManagedFiles(sftp, metadataSnapshots).catch(
          (rollbackError: unknown) => {
            throw new AggregateError(
              [error, rollbackError],
              'Published Runtime activation failed and its previous metadata state could not be restored'
            )
          }
        )
      }
      if (
        error instanceof RemoteRuntimeInstallationError ||
        isAbortError(error)
      ) {
        throw error
      }
      throw new RemoteRuntimeInstallationError(
        'The published Host OpenCode Runtime could not be verified',
        'corrupt',
        safeErrorDetail(error)
      )
    } finally {
      if (sftp) {
        await cleanupOwnedStaging(sftp, cleanup)
      }
      sftp?.close()
      lease?.release()
    }
  }

  async #loadPublishedVerificationMetadata(
    architecture: AgentArchitecture
  ): Promise<{
    releaseKeyRegistry: AgentReleaseKeyRegistry
    runtimeLock: RemoteRuntimeLock
    releaseKeyRegistryBytes: Buffer
    remoteRuntimeLockBytes: Buffer
  }> {
    const loadMetadata = this.#loadVerificationMetadata
    if (loadMetadata === undefined) {
      throw new RemoteRuntimeInstallationError(
        'This package cannot verify a Host Runtime',
        'incompatible'
      )
    }
    const metadata = await loadMetadata(architecture)
    const releaseKeyRegistryBytes = canonicalJsonBytes(
      metadata.canonicalReleaseKeyRegistryBytes,
      agentReleaseKeyRegistrySchema,
      'Runtime release-key registry'
    )
    const remoteRuntimeLockBytes = canonicalJsonBytes(
      metadata.canonicalRemoteRuntimeLockBytes,
      remoteRuntimeLockSchema,
      'Remote Runtime lock'
    )
    const releaseKeyRegistry =
      agentReleaseKeyRegistrySchema.parse(
        metadata.releaseKeyRegistry
      )
    const runtimeLock = remoteRuntimeLockSchema.parse(
      metadata.runtimeLock
    )
    if (
      !canonicalJsonValueBytes(releaseKeyRegistry).equals(
        releaseKeyRegistryBytes
      ) ||
      !canonicalJsonValueBytes(runtimeLock).equals(
        remoteRuntimeLockBytes
      )
    ) {
      throw new Error(
        'Runtime verification metadata values do not match their canonical bytes'
      )
    }
    return {
      releaseKeyRegistry,
      runtimeLock,
      releaseKeyRegistryBytes,
      remoteRuntimeLockBytes
    }
  }

  async #reuseInstalledBundle(
    target: SshConnectionPoolTarget,
    lease: SshConnectionLease,
    probe: {
      architecture: AgentArchitecture
      canonicalHomeDirectory: string
      uid: number
    },
    agentInstallationId: VerifiedAgentInstallationId | undefined,
    signal: AbortSignal,
    progress: (phase: RemoteRuntimeInstallationPhase) => void
  ): Promise<RemoteRuntimeInstallationIdentity> {
    let metadataSftp: StagedSftp | undefined
    try {
      const {
        releaseKeyRegistry,
        runtimeLock,
        releaseKeyRegistryBytes,
        remoteRuntimeLockBytes
      } = await this.#loadPublishedVerificationMetadata(
        probe.architecture
      )

      metadataSftp = await lease.openStagedSftp(
        probe.canonicalHomeDirectory,
        {
          maximumFileBytes: MAXIMUM_METADATA_BYTES,
          maximumTotalBytes: MAXIMUM_METADATA_BYTES * 6,
          maximumOperations: 48,
          operationTimeoutMs: 15_000
        },
        signal
      )
      const [
        remoteRegistryBytes,
        remoteReleaseKeyBytes,
        remoteRuntimeLockFileBytes
      ] = await Promise.all([
        metadataSftp.readFile(RUNTIME_REGISTRY_PATH, signal),
        metadataSftp.readFile(RELEASE_KEYS_PATH, signal),
        metadataSftp.readFile(RUNTIME_LOCK_PATH, signal)
      ])
      const remoteReleaseKeyRegistryBytes =
        Buffer.from(remoteReleaseKeyBytes)
      const remoteReleaseKeyRegistry =
        parseAgentReleaseKeyRegistryBytes(
          remoteReleaseKeyRegistryBytes,
        'Installed Runtime release-key registry'
      )
      if (!remoteRuntimeLockFileBytes.equals(remoteRuntimeLockBytes)) {
        throw new Error(
          'Installed Runtime lock does not match this GoodBuddy build'
        )
      }
      const remoteRegistry = parseRuntimeRegistryState(
        parseJsonBytes(
          remoteRegistryBytes,
          'Installed Runtime registry'
        )
      )
      const current = remoteRegistry.current.find(
        (entry) =>
          entry.runtimeId === 'opencode' &&
          entry.architecture === probe.architecture
      )
      if (
        current === undefined ||
        current.runtimeVersion !==
          runtimeLock.runtimes.opencode.version
      ) {
        throw new RemoteRuntimeInstallationError(
          'This package does not include Runtime installation resources and the Host has no matching current OpenCode Runtime',
          'incompatible'
        )
      }
      const destination =
        `${OPENCODE_ROOT}/${digestDirectoryName(current.bundleDigest)}`
      const manifestBytes = await metadataSftp.readFile(
        `${destination}/manifest.json`,
        signal
      )
      const signatureFile = await metadataSftp.readFile(
        `${destination}/manifest.sig`,
        signal
      )
      const signature = decodeDetachedSignature(
        signatureFile,
        'Runtime detached signature'
      )
      const manifest = await verifyRuntimeManifestSignature(
        manifestBytes,
        signature,
        releaseKeyRegistry
      )
      await verifyRuntimeManifestSignature(
        manifestBytes,
        signature,
        remoteReleaseKeyRegistry
      )
      assertRuntimeManifestMatchesLock(
        manifest,
        runtimeLock,
        probe.architecture
      )
      const manifestDigest =
        await digestRemoteRuntimeBundleManifest(manifest)
      if (
        manifest.bundleDigest !== current.bundleDigest ||
        manifestDigest !== current.manifestDigest ||
        manifest.acpCapabilitiesDigest !==
          current.acpCapabilitiesDigest
      ) {
        throw new Error(
          'Installed Runtime manifest identity does not match its registry'
        )
      }
      const bundle: LoadedBundle = {
        bundleDirectory: destination,
        manifest,
        manifestDigest,
        releaseKeyRegistryBytes,
        remoteRuntimeLockBytes
      }
      assertBundleCapacity(bundle)
      await verifyRemoteFile(
        metadataSftp,
        RUNTIME_REGISTRY_PATH,
        remoteRegistryBytes.byteLength,
        sha256(remoteRegistryBytes),
        probe.uid,
        PRIVATE_FILE_MODE,
        signal
      )
      await verifyRemoteFile(
        metadataSftp,
        RELEASE_KEYS_PATH,
        remoteReleaseKeyRegistryBytes.byteLength,
        sha256(remoteReleaseKeyRegistryBytes),
        probe.uid,
        PRIVATE_FILE_MODE,
        signal
      )
      await verifyRemoteFile(
        metadataSftp,
        RUNTIME_LOCK_PATH,
        remoteRuntimeLockBytes.byteLength,
        sha256(remoteRuntimeLockBytes),
        probe.uid,
        PRIVATE_FILE_MODE,
        signal
      )
      await verifyRemoteBundleFromMetadata(
        metadataSftp,
        destination,
        bundle,
        manifestBytes,
        signatureFile,
        probe.uid,
        signal
      )
      metadataSftp.close()
      metadataSftp = undefined
      await assertCurrentTarget(
        this.#resolver,
        lease,
        target,
        signal
      )
      progress('activating-runtime')
      await activateRuntime(
        this.#activate,
        lease,
        bundle,
        agentInstallationId,
        signal
      )
      progress('complete')
      return publicIdentity(bundle)
    } catch (error) {
      rethrowAbort(error)
      if (error instanceof RemoteRuntimeInstallationError) {
        throw error
      }
      if (isMissingPathError(error)) {
        throw new RemoteRuntimeInstallationError(
          'This package does not include Runtime installation resources and the Host has no matching current OpenCode Runtime',
          'incompatible',
          safeErrorDetail(error)
        )
      }
      throw new RemoteRuntimeInstallationError(
        'The existing Host OpenCode Runtime could not be verified',
        'corrupt',
        safeErrorDetail(error)
      )
    } finally {
      metadataSftp?.close()
    }
  }
}

function assertLeaseMatchesTarget(
  lease: SshConnectionLease,
  target: SshConnectionPoolTarget
): void {
  if (
    lease.identity.hostId !== target.host.id ||
    lease.identity.hostRevision !== target.hostRevision ||
    lease.identity.hostKeyGeneration !==
      target.hostKeyGeneration ||
    !/^[a-f0-9]{64}$/u.test(
      lease.identity.authenticationIdentity
    )
  ) {
    throw new RemoteRuntimeInstallationError(
      'SSH lease identity changed during Runtime installation',
      'host-identity-changed'
    )
  }
}

async function assertCurrentTarget(
  resolver: RemoteRuntimeInstallationTargetResolver,
  lease: SshConnectionLease,
  originalTarget: SshConnectionPoolTarget,
  signal: AbortSignal
): Promise<void> {
  signal.throwIfAborted()
  const currentTarget = await resolver.resolve(
    originalTarget.host.id
  )
  signal.throwIfAborted()
  if (
    remoteHostTargetIdentityKey(currentTarget) !==
    remoteHostTargetIdentityKey(originalTarget)
  ) {
    throw new RemoteRuntimeInstallationError(
      'SSH host identity changed before Runtime publication or activation',
      'host-identity-changed'
    )
  }
  assertLeaseMatchesTarget(lease, currentTarget)
}

function publicIdentity(
  bundle: LoadedBundle
): RemoteRuntimeInstallationIdentity {
  return {
    runtimeId: bundle.manifest.runtimeId,
    runtimeVersion: bundle.manifest.runtimeVersion,
    bundleDigest: bundle.manifest.bundleDigest,
    manifestDigest: bundle.manifestDigest,
    runtimeAdapterDigest: bundle.manifest.adapterDigest,
    acpCapabilitiesDigest:
      bundle.manifest.acpCapabilitiesDigest,
    platform: bundle.manifest.platform,
    architecture: bundle.manifest.architecture
  }
}

function assertPublishedRuntimeIdentity(
  identity: PublishedRemoteRuntimeInstallationIdentity
): void {
  if (
    identity.runtimeId !== 'opencode' ||
    identity.runtimeVersion.length < 1 ||
    !sha256DigestSchema.safeParse(identity.bundleDigest).success ||
    !sha256DigestSchema.safeParse(identity.manifestDigest).success ||
    !sha256DigestSchema.safeParse(
      identity.runtimeAdapterDigest
    ).success ||
    !sha256DigestSchema.safeParse(
      identity.acpCapabilitiesDigest
    ).success ||
    identity.platform !== 'linux' ||
    (identity.architecture !== 'x64' &&
      identity.architecture !== 'arm64') ||
    !Number.isSafeInteger(identity.protocol.major) ||
    identity.protocol.major < 0 ||
    !Number.isSafeInteger(identity.protocol.minor) ||
    identity.protocol.minor < 0
  ) {
    throw new RemoteRuntimeInstallationError(
      'Published Runtime identity is invalid',
      'corrupt'
    )
  }
}

function assertPublishedRuntimeMatches(
  expected: PublishedRemoteRuntimeInstallationIdentity,
  bundle: LoadedBundle
): void {
  if (
    expected.runtimeId !== bundle.manifest.runtimeId ||
    expected.runtimeVersion !== bundle.manifest.runtimeVersion ||
    expected.bundleDigest !== bundle.manifest.bundleDigest ||
    expected.manifestDigest !== bundle.manifestDigest ||
    expected.runtimeAdapterDigest !== bundle.manifest.adapterDigest ||
    expected.acpCapabilitiesDigest !==
      bundle.manifest.acpCapabilitiesDigest ||
    expected.platform !== bundle.manifest.platform ||
    expected.architecture !== bundle.manifest.architecture ||
    expected.protocol.major !== bundle.manifest.protocol.major ||
    expected.protocol.minor !== bundle.manifest.protocol.minor
  ) {
    throw new RemoteRuntimeInstallationError(
      'Published Runtime does not match the authenticated package result',
      'corrupt'
    )
  }
}

function publishedRuntimeIdentityKey(
  identity: PublishedRemoteRuntimeInstallationIdentity
): string {
  return createHash('sha256')
    .update(JSON.stringify(identity))
    .digest('hex')
}

function digestDirectoryName(bundleDigest: string): string {
  if (!sha256DigestSchema.safeParse(bundleDigest).success) {
    throw new Error('Runtime bundle digest is invalid')
  }
  return bundleDigest.slice('sha256:'.length)
}

function assertBundleCapacity(bundle: LoadedBundle): void {
  const metadataBytes =
    bundle.releaseKeyRegistryBytes.byteLength +
    bundle.remoteRuntimeLockBytes.byteLength
  const payloadBytes = bundle.manifest.files.reduce(
    (sum, file) => sum + file.size,
    0
  )
  const total = payloadBytes + metadataBytes
  if (
    bundle.manifest.files.length > MAXIMUM_INSTALLATION_FILES ||
    bundle.manifest.files.some(
      (file) => file.size > MAXIMUM_RUNTIME_FILE_BYTES
    ) ||
    bundle.releaseKeyRegistryBytes.byteLength >
      MAXIMUM_METADATA_BYTES ||
    bundle.remoteRuntimeLockBytes.byteLength >
      MAXIMUM_METADATA_BYTES ||
    !Number.isSafeInteger(total) ||
    total > MAXIMUM_INSTALLATION_BYTES
  ) {
    throw new RemoteRuntimeInstallationError(
      'OpenCode Runtime bundle exceeds installation safety limits',
      'capacity'
    )
  }
}

async function installPrivateMetadata(
  sftp: StagedSftp,
  destination: string,
  temporaryPrefix: string,
  contents: Buffer,
  uid: number,
  cleanup: CleanupEntry[],
  signal: AbortSignal
): Promise<void> {
  const existing = await pathMetadata(sftp, destination, signal)
  if (existing !== undefined) {
    assertMetadata(
      existing,
      destination,
      'file',
      uid,
      PRIVATE_FILE_MODE,
      undefined
    )
    if (
      existing.size === contents.byteLength &&
      (await sftp.readFile(destination, signal)).equals(contents)
    ) {
      return
    }
  }
  const temporary =
    `${RUNTIME_ROOT}/${temporaryPrefix}-${randomUUID()}.tmp`
  trackCleanup(cleanup, { path: temporary, type: 'file' })
  await sftp.writeFile(temporary, contents, signal)
  await sftp.chmod(temporary, PRIVATE_FILE_MODE, signal)
  await verifyRemoteFile(
    sftp,
    temporary,
    contents.byteLength,
    sha256(contents),
    uid,
    PRIVATE_FILE_MODE,
    signal
  )
  await sftp.replaceFile(temporary, destination, signal)
  removeCleanup(cleanup, temporary)
  await verifyRemoteFile(
    sftp,
    destination,
    contents.byteLength,
    sha256(contents),
    uid,
    PRIVATE_FILE_MODE,
    signal
  )
}

async function snapshotManagedFile(
  sftp: StagedSftp,
  path: string,
  uid: number,
  signal: AbortSignal
): Promise<ManagedFileSnapshot> {
  const metadata = await pathMetadata(sftp, path, signal)
  if (metadata === undefined) {
    return { path, contents: undefined, uid }
  }
  assertMetadata(
    metadata,
    path,
    'file',
    uid,
    PRIVATE_FILE_MODE,
    undefined
  )
  return {
    path,
    contents: await sftp.readFile(path, signal),
    uid
  }
}

async function restoreManagedFile(
  sftp: StagedSftp,
  snapshot: ManagedFileSnapshot
): Promise<void> {
  const existing = await pathMetadata(sftp, snapshot.path)
  if (snapshot.contents === undefined) {
    if (existing !== undefined) {
      assertMetadata(
        existing,
        snapshot.path,
        'file',
        snapshot.uid,
        PRIVATE_FILE_MODE,
        undefined
      )
      await sftp.unlink(snapshot.path)
    }
    return
  }
  if (
    existing !== undefined &&
    existing.type === 'file' &&
    existing.uid === snapshot.uid &&
    existing.mode === PRIVATE_FILE_MODE &&
    existing.size === snapshot.contents.byteLength &&
    (await sftp.readFile(snapshot.path)).equals(snapshot.contents)
  ) {
    return
  }
  if (existing !== undefined) {
    assertMetadata(
      existing,
      snapshot.path,
      'file',
      snapshot.uid,
      undefined,
      undefined
    )
  }
  const temporary =
    `${RUNTIME_ROOT}/.registry-rollback-${randomUUID()}.tmp`
  try {
    await sftp.writeFile(temporary, snapshot.contents)
    await sftp.chmod(temporary, PRIVATE_FILE_MODE)
    await sftp.replaceFile(temporary, snapshot.path)
    await verifyRemoteFile(
      sftp,
      snapshot.path,
      snapshot.contents.byteLength,
      sha256(snapshot.contents),
      snapshot.uid,
      PRIVATE_FILE_MODE,
      new AbortController().signal
    )
  } catch (error) {
    await sftp.unlink(temporary).catch(() => undefined)
    throw error
  }
}

async function restoreManagedFiles(
  sftp: StagedSftp,
  snapshots: readonly ManagedFileSnapshot[]
): Promise<void> {
  const errors: unknown[] = []
  for (const snapshot of snapshots) {
    try {
      await restoreManagedFile(sftp, snapshot)
    } catch (error) {
      errors.push(error)
    }
  }
  if (errors.length > 0) {
    throw new AggregateError(
      errors,
      'Remote Runtime metadata rollback was incomplete'
    )
  }
}

async function verifyRemoteBundleFromMetadata(
  sftp: StagedSftp,
  destination: string,
  bundle: LoadedBundle,
  manifestBytes: Buffer,
  signatureBytes: Buffer,
  uid: number,
  signal: AbortSignal
): Promise<void> {
  await assertRemoteMetadata(
    sftp,
    destination,
    'directory',
    uid,
    PRIVATE_DIRECTORY_MODE,
    undefined,
    signal
  )
  const checkedDirectories = new Set<string>()
  for (const file of bundle.manifest.files) {
    const parts = file.path.split('/')
    let directory = destination
    for (const part of parts.slice(0, -1)) {
      directory = `${directory}/${part}`
      if (!checkedDirectories.has(directory)) {
        checkedDirectories.add(directory)
        await assertRemoteMetadata(
          sftp,
          directory,
          'directory',
          uid,
          PRIVATE_DIRECTORY_MODE,
          undefined,
          signal
        )
      }
    }
    const path = `${destination}/${file.path}`
    const mode = file.mode === '0755' ? 0o755 : 0o644
    await assertRemoteMetadata(
      sftp,
      path,
      'file',
      uid,
      mode,
      file.size,
      signal
    )
  }
  for (const [metadataName, contents] of [
    ['manifest.json', manifestBytes],
    ['manifest.sig', signatureBytes]
  ] as const) {
    if (contents.byteLength > MAXIMUM_METADATA_BYTES) {
      throw new Error('Runtime metadata exceeds its safety limit')
    }
    const path = `${destination}/${metadataName}`
    await assertRemoteMetadata(
      sftp,
      path,
      'file',
      uid,
      METADATA_MODE,
      contents.byteLength,
      signal
    )
  }
}

async function verifyRemoteFile(
  sftp: StagedSftp,
  path: string,
  size: number,
  digest: string,
  uid: number,
  mode: number,
  signal: AbortSignal
): Promise<void> {
  await assertRemoteMetadata(
    sftp,
    path,
    'file',
    uid,
    mode,
    size,
    signal
  )
  const contents = await sftp.readFile(path, signal)
  if (contents.byteLength !== size || sha256(contents) !== digest) {
    throw new Error(`Remote Runtime file readback mismatch: ${path}`)
  }
  await assertRemoteMetadata(
    sftp,
    path,
    'file',
    uid,
    mode,
    size,
    signal
  )
}

async function assertRemoteMetadata(
  sftp: StagedSftp,
  path: string,
  type: 'file' | 'directory',
  uid: number,
  mode: number,
  size: number | undefined,
  signal: AbortSignal
): Promise<void> {
  assertMetadata(
    await sftp.stat(path, signal),
    path,
    type,
    uid,
    mode,
    size
  )
}

function assertMetadata(
  metadata: SftpEntryMetadata,
  path: string,
  type: 'file' | 'directory',
  uid: number,
  mode: number | undefined,
  size: number | undefined
): void {
  if (
    metadata.type !== type ||
    metadata.uid !== uid ||
    (mode !== undefined && metadata.mode !== mode) ||
    (size !== undefined && metadata.size !== size)
  ) {
    throw new Error(`Remote Runtime metadata mismatch: ${path}`)
  }
}

async function pathMetadata(
  sftp: StagedSftp,
  path: string,
  signal?: AbortSignal
): Promise<SftpEntryMetadata | undefined> {
  try {
    return await sftp.lstat(path, signal)
  } catch (error) {
    if (isMissingPathError(error)) {
      return undefined
    }
    throw error
  }
}

async function activateRuntime(
  activate: RemoteRuntimeActivator,
  lease: SshConnectionLease,
  bundle: LoadedBundle,
  agentInstallationId: VerifiedAgentInstallationId | undefined,
  signal: AbortSignal
): Promise<void> {
  signal.throwIfAborted()
  try {
    await activate(
      lease,
      bundle.manifest.runtimeId,
      bundle.manifest.bundleDigest,
      bundle.manifest.architecture,
      agentInstallationId,
      signal
    )
  } catch (error) {
    rethrowAbort(error)
    throw new RemoteRuntimeInstallationError(
      'OpenCode Runtime activation failed',
      'activation',
      safeErrorDetail(error)
    )
  }
}

function canonicalJsonBytes<T>(
  input: Uint8Array | undefined,
  schema: { parse(value: unknown): T },
  label: string
): Buffer {
  if (input === undefined) {
    throw new Error(`${label} bytes are missing`)
  }
  const bytes = Buffer.from(input)
  if (
    bytes.byteLength === 0 ||
    bytes.byteLength > MAXIMUM_METADATA_BYTES
  ) {
    throw new Error(`${label} exceeds its safety limit`)
  }
  let parsedJson: unknown
  try {
    parsedJson = JSON.parse(bytes.toString('utf8'))
  } catch (error) {
    throw new Error(`${label} is invalid JSON`, { cause: error })
  }
  const parsed = schema.parse(parsedJson)
  const canonical = Buffer.from(
    `${JSON.stringify(parsed, null, 2)}\n`,
    'utf8'
  )
  if (!canonical.equals(bytes)) {
    throw new Error(`${label} bytes are not canonical`)
  }
  return canonical
}

function canonicalJsonValueBytes(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

function parseJsonBytes(
  value: Buffer,
  description: string
): unknown {
  try {
    return JSON.parse(value.toString('utf8')) as unknown
  } catch (error) {
    throw new Error(`${description} is not valid JSON`, {
      cause: error
    })
  }
}

function decodeDetachedSignature(
  value: Buffer,
  description: string
): Buffer {
  const text = value.toString('ascii')
  if (!/^[A-Za-z0-9+/]{86}==\n$/u.test(text)) {
    throw new Error(`${description} is not canonical Base64`)
  }
  const signature = Buffer.from(text.slice(0, -1), 'base64')
  if (signature.byteLength !== 64) {
    throw new Error(`${description} is not an Ed25519 signature`)
  }
  return signature
}

function trackCleanup(
  cleanup: CleanupEntry[],
  entry: CleanupEntry
): void {
  if (cleanup.length >= MAXIMUM_CLEANUP_ENTRIES) {
    throw new RemoteRuntimeInstallationError(
      'Runtime cleanup inventory exceeds its safety limit',
      'capacity'
    )
  }
  cleanup.push(entry)
}

function removeCleanup(
  cleanup: CleanupEntry[],
  path: string
): void {
  const index = cleanup.findIndex((entry) => entry.path === path)
  if (index >= 0) {
    cleanup.splice(index, 1)
  }
}

async function cleanupOwnedStaging(
  sftp: StagedSftp,
  entries: readonly CleanupEntry[]
): Promise<boolean> {
  let complete = true
  for (const entry of [...entries]
    .slice(0, MAXIMUM_CLEANUP_ENTRIES)
    .reverse()) {
    try {
      if (entry.type === 'file') {
        await sftp.unlink(entry.path)
      } else {
        await sftp.rmdir(entry.path)
      }
    } catch (error) {
      if (!isMissingPathError(error)) {
        complete = false
        // Cleanup never widens beyond operation-owned temporary paths.
      }
    }
  }
  return complete
}

function waitForOperation<T>(
  promise: Promise<T>,
  signal?: AbortSignal
): Promise<T> {
  if (!signal) {
    return promise
  }
  if (signal.aborted) {
    return Promise.reject(
      signal.reason ??
      new DOMException('The operation was aborted', 'AbortError')
    )
  }
  return new Promise((resolve, reject) => {
    const abort = (): void => {
      reject(
        signal.reason ??
        new DOMException('The operation was aborted', 'AbortError')
      )
    }
    signal.addEventListener('abort', abort, { once: true })
    promise.then(
      (value) => {
        signal.removeEventListener('abort', abort)
        resolve(value)
      },
      (error: unknown) => {
        signal.removeEventListener('abort', abort)
        reject(error)
      }
    )
  })
}

function emitOne(
  callback:
    | ((phase: RemoteRuntimeInstallationPhase) => void)
    | undefined,
  phase: RemoteRuntimeInstallationPhase
): void {
  try {
    callback?.(phase)
  } catch {
    // Progress observers cannot alter installation outcomes.
  }
}

function isAbortError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'name' in error &&
    (error as { name?: unknown }).name === 'AbortError'
  )
}

function rethrowAbort(error: unknown): void {
  if (isAbortError(error)) {
    throw error
  }
}

function safeErrorDetail(error: unknown): unknown {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message
    }
  }
  return undefined
}

function sha256(contents: Uint8Array): string {
  return createHash('sha256').update(contents).digest('hex')
}

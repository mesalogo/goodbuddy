import { createHash, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  agentReleaseKeyRegistrySchema,
  type AgentArchitecture,
  type AgentReleaseKeyRegistry
} from '../../shared/agent-installation-contracts'
import type { AgentBootstrapIncompatibleReason } from '../../shared/ssh-host-contracts'
import {
  assertRuntimeManifestMatchesLock,
  canonicalRuntimeManifestBytes,
  verifyRuntimeManifestSignature
} from '../../shared/node/runtime-bundle-verifier'
import {
  parseRuntimeRegistryState
} from '../../shared/remote-environment-registry-contracts'
import {
  digestRemoteRuntimeBundleIdentity,
  digestRemoteRuntimeBundleManifest,
  remoteRuntimeBundleManifestSchema,
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
const RUNTIME_STAGING_ROOT = `${RUNTIME_ROOT}/staging`
const OPENCODE_ROOT = `${RUNTIME_ROOT}/opencode`
const RELEASE_KEYS_PATH = `${RUNTIME_ROOT}/release-keys.json`
const RUNTIME_LOCK_PATH = `${RUNTIME_ROOT}/remote-runtime-lock.json`
const RUNTIME_REGISTRY_PATH = `${RUNTIME_ROOT}/registry.json`

export class RemoteRuntimeBundleResourcesUnavailableError
  extends Error {
  constructor(cause?: unknown) {
    super(
      'OpenCode Runtime installation resources are not included in this package',
      { cause }
    )
    this.name = 'RemoteRuntimeBundleResourcesUnavailableError'
  }
}

export type RemoteRuntimeInstallationPhase =
  | 'inspecting-host'
  | 'verifying-bundle'
  | 'preparing-installation'
  | 'uploading-bundle'
  | 'publishing-bundle'
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

export type RemoteRuntimeInstallationRequestOptions = {
  signal?: AbortSignal
  onProgress?: (phase: RemoteRuntimeInstallationPhase) => void
}

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

export type VerifiedRemoteRuntimeInstallationBundle =
  RuntimeBundleBase & {
    canonicalReleaseKeyRegistryBytes: Uint8Array
    canonicalRemoteRuntimeLockBytes: Uint8Array
  }

export type RemoteRuntimeInstallationBundleLoader = (
  architecture: AgentArchitecture
) => Promise<VerifiedRemoteRuntimeInstallationBundle>

export type RemoteRuntimeInstallationVerificationMetadata = {
  releaseKeyRegistry: AgentReleaseKeyRegistry
  runtimeLock: RemoteRuntimeLock
  canonicalReleaseKeyRegistryBytes: Uint8Array
  canonicalRemoteRuntimeLockBytes: Uint8Array
}

export type RemoteRuntimeInstallationVerificationMetadataLoader =
  () => Promise<RemoteRuntimeInstallationVerificationMetadata>

export type RemoteRuntimeActivator = (
  lease: SshConnectionLease,
  runtimeId: string,
  bundleDigest: string,
  architecture: AgentArchitecture,
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

type LoadedBundle = RuntimeBundleBase & {
  releaseKeyRegistryBytes: Buffer
  remoteRuntimeLockBytes: Buffer
}

export class RemoteRuntimeInstallationManager {
  readonly #resolver: RemoteRuntimeInstallationTargetResolver
  readonly #sshPool: Pick<SshConnectionPool, 'acquire'>
  readonly #loadVerifiedBundle: RemoteRuntimeInstallationBundleLoader
  readonly #loadVerificationMetadata?:
    RemoteRuntimeInstallationVerificationMetadataLoader
  readonly #activate: RemoteRuntimeActivator
  readonly #sftpLimits?: BoundedSftpLimits
  readonly #maximumConcurrentHosts: number
  readonly #active = new Map<string, ActiveInstallation>()
  readonly #installed = new Map<
    string,
    RemoteRuntimeInstallationIdentity
  >()
  #closed = false
  #disposePromise: Promise<void> | undefined

  constructor(options: {
    resolver: RemoteRuntimeInstallationTargetResolver
    sshPool: Pick<SshConnectionPool, 'acquire'>
    loadVerifiedBundle: RemoteRuntimeInstallationBundleLoader
    loadVerificationMetadata?:
      RemoteRuntimeInstallationVerificationMetadataLoader
    activate: RemoteRuntimeActivator
    sftpLimits?: BoundedSftpLimits
    maximumConcurrentHosts?: number
  }) {
    this.#resolver = options.resolver
    this.#sshPool = options.sshPool
    this.#loadVerifiedBundle = options.loadVerifiedBundle
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

  async ensureInstalled(
    hostId: string,
    options: RemoteRuntimeInstallationRequestOptions = {}
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

    const operationKey = targetIdentityKey(target)
    const installed = this.#installed.get(operationKey)
    if (installed !== undefined) {
      emitOne(options.onProgress, 'complete')
      return installed
    }
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
    const promise = this.#run(target, controller.signal, progress)
      .then((identity) => {
        this.#installed.set(operationKey, identity)
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
    this.#installed.clear()
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
    options: RemoteRuntimeInstallationRequestOptions
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

  async #run(
    target: SshConnectionPoolTarget,
    signal: AbortSignal,
    progress: (phase: RemoteRuntimeInstallationPhase) => void
  ): Promise<RemoteRuntimeInstallationIdentity> {
    let lease: SshConnectionLease | undefined
    let sftp: StagedSftp | undefined
    let cleanupHomeDirectory: string | undefined
    const cleanup: CleanupEntry[] = []
    let stagingPublished = false
    try {
      lease = await this.#sshPool.acquire(target, signal)
      assertLeaseMatchesTarget(lease, target)
      const probe = await lease.runAgentBootstrapProbe(signal)
      if (!probe.ready) {
        throw new RemoteRuntimeInstallationError(
          `Remote host cannot install the OpenCode Runtime: ${probe.reason}`,
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
      let bundle: LoadedBundle
      try {
        bundle = await this.#loadAndValidateBundle(
          probe.architecture
        )
      } catch (error) {
        if (
          error instanceof RemoteRuntimeBundleResourcesUnavailableError
        ) {
          if (this.#loadVerificationMetadata === undefined) {
            throw new RemoteRuntimeInstallationError(
              'This package does not include Runtime installation resources',
              'incompatible',
              safeErrorDetail(error)
            )
          }
          return await this.#reuseInstalledBundle(
            target,
            lease,
            probe,
            signal,
            progress
          )
        }
        throw error
      }
      assertBundleCapacity(bundle)
      const identity = publicIdentity(bundle)
      const destination =
        `${OPENCODE_ROOT}/${digestDirectoryName(bundle.manifest.bundleDigest)}`

      progress('preparing-installation')
      sftp = await lease.openStagedSftp(
        probe.canonicalHomeDirectory,
        installationSftpLimits(bundle, this.#sftpLimits),
        signal
      )
      cleanupHomeDirectory = probe.canonicalHomeDirectory
      await ensureManagedHierarchy(sftp, probe.uid, signal)
      await installPrivateMetadata(
        sftp,
        RELEASE_KEYS_PATH,
        '.release-keys',
        bundle.releaseKeyRegistryBytes,
        probe.uid,
        cleanup,
        signal
      )
      await installPrivateMetadata(
        sftp,
        RUNTIME_LOCK_PATH,
        '.remote-runtime-lock',
        bundle.remoteRuntimeLockBytes,
        probe.uid,
        cleanup,
        signal
      )

      const existingDestination = await pathMetadata(
        sftp,
        destination,
        signal
      )
      if (existingDestination !== undefined) {
        await verifyRemoteBundle(
          sftp,
          destination,
          bundle,
          probe.uid,
          signal
        ).catch((error: unknown) => {
          rethrowAbort(error)
          throw new RemoteRuntimeInstallationError(
            'Existing OpenCode Runtime installation is corrupt',
            'corrupt',
            safeErrorDetail(error)
          )
        })
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
          signal
        )
        progress('complete')
        return identity
      }

      progress('uploading-bundle')
      const staging = `${RUNTIME_STAGING_ROOT}/op-${randomUUID()}`
      await sftp.mkdir(staging, signal)
      trackCleanup(cleanup, { path: staging, type: 'directory' })
      await assertRemoteMetadata(
        sftp,
        staging,
        'directory',
        probe.uid,
        PRIVATE_DIRECTORY_MODE,
        undefined,
        signal
      )
      await uploadAndVerifyBundle(
        sftp,
        staging,
        bundle,
        probe.uid,
        cleanup,
        signal
      ).catch((error: unknown) => {
        rethrowAbort(error)
        throw new RemoteRuntimeInstallationError(
          'OpenCode Runtime bundle upload verification failed',
          'corrupt',
          safeErrorDetail(error)
        )
      })

      await assertCurrentTarget(
        this.#resolver,
        lease,
        target,
        signal
      )
      progress('publishing-bundle')
      await sftp.rename(staging, destination, signal)
      stagingPublished = true
      await verifyRemoteBundle(
        sftp,
        destination,
        bundle,
        probe.uid,
        signal
      ).catch((error: unknown) => {
        rethrowAbort(error)
        throw new RemoteRuntimeInstallationError(
          'Published OpenCode Runtime bundle verification failed',
          'corrupt',
          safeErrorDetail(error)
        )
      })

      progress('activating-runtime')
      await activateRuntime(
        this.#activate,
        lease,
        bundle,
        signal
      )
      progress('complete')
      return identity
    } catch (error) {
      if (
        error instanceof RemoteRuntimeInstallationError ||
        isAbortError(error)
      ) {
        throw error
      }
      throw new RemoteRuntimeInstallationError(
        'Remote Runtime installation data is corrupt or unsafe',
        'corrupt',
        safeErrorDetail(error)
      )
    } finally {
      let cleanupIncomplete = false
      if (sftp && !stagingPublished) {
        cleanupIncomplete = !(await cleanupOwnedStaging(sftp, cleanup))
      }
      sftp?.close()
      if (
        cleanupIncomplete &&
        lease?.isUsable() &&
        cleanupHomeDirectory
      ) {
        let cleanupSftp: StagedSftp | undefined
        try {
          cleanupSftp = await lease.openStagedSftp(
            cleanupHomeDirectory,
            this.#sftpLimits
          )
          await cleanupOwnedStaging(cleanupSftp, cleanup)
        } catch {
          // Cancellation can make the lease unavailable. Cleanup remains
          // bounded to this operation's temporary files and staging tree.
        } finally {
          cleanupSftp?.close()
        }
      }
      lease?.release()
    }
  }

  async #loadAndValidateBundle(
    architecture: AgentArchitecture
  ): Promise<LoadedBundle> {
    let loaded: VerifiedRemoteRuntimeInstallationBundle
    try {
      loaded = await this.#loadVerifiedBundle(architecture)
      const manifest = remoteRuntimeBundleManifestSchema.parse(
        loaded.manifest
      )
      if (
        manifest.runtimeId !== 'opencode' ||
        manifest.provider !== 'opencode' ||
        manifest.platform !== 'linux' ||
        manifest.architecture !== architecture
      ) {
        throw new Error(
          'Verified Runtime bundle does not match the OpenCode host target'
        )
      }
      if (
        loaded.manifestDigest !==
        await digestRemoteRuntimeBundleManifest(manifest)
      ) {
        throw new Error('Verified Runtime manifest digest is invalid')
      }
      if (
        manifest.bundleDigest !==
        await digestRemoteRuntimeBundleIdentity(manifest)
      ) {
        throw new Error('Verified Runtime bundle digest is invalid')
      }
      const releaseKeyRegistryBytes = canonicalJsonBytes(
        loaded.canonicalReleaseKeyRegistryBytes,
        agentReleaseKeyRegistrySchema,
        'Runtime release-key registry'
      )
      const remoteRuntimeLockBytes = canonicalJsonBytes(
        loaded.canonicalRemoteRuntimeLockBytes,
        remoteRuntimeLockSchema,
        'Remote Runtime lock'
      )
      return {
        bundleDirectory: loaded.bundleDirectory,
        manifest,
        manifestDigest: loaded.manifestDigest,
        releaseKeyRegistryBytes,
        remoteRuntimeLockBytes
      }
    } catch (error) {
      rethrowAbort(error)
      if (
        error instanceof RemoteRuntimeBundleResourcesUnavailableError
      ) {
        throw error
      }
      throw new RemoteRuntimeInstallationError(
        'Verified OpenCode Runtime bundle is corrupt',
        'corrupt',
        safeErrorDetail(error)
      )
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
    signal: AbortSignal,
    progress: (phase: RemoteRuntimeInstallationPhase) => void
  ): Promise<RemoteRuntimeInstallationIdentity> {
    const loadMetadata = this.#loadVerificationMetadata
    if (loadMetadata === undefined) {
      throw new RemoteRuntimeInstallationError(
        'This package cannot verify an existing Host Runtime',
        'incompatible'
      )
    }
    let metadataSftp: StagedSftp | undefined
    try {
      const metadata = await loadMetadata()
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
      const remoteReleaseKeyRegistryBytes = canonicalJsonBytes(
        remoteReleaseKeyBytes,
        agentReleaseKeyRegistrySchema,
        'Installed Runtime release-key registry'
      )
      const remoteReleaseKeyRegistry =
        agentReleaseKeyRegistrySchema.parse(
          parseJsonBytes(
            remoteReleaseKeyRegistryBytes,
            'Installed Runtime release-key registry'
          )
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
      progress('preparing-installation')
      await verifyRemoteBundleFromMetadata(
        metadataSftp,
        destination,
        bundle,
        manifestBytes,
        signatureFile,
        probe.uid,
        'metadata',
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

function targetIdentityKey(target: SshConnectionPoolTarget): string {
  const hostKey = target.host.hostKey
  return createHash('sha256')
    .update(JSON.stringify([
      'goodbuddy-remote-runtime-installation-target-v1',
      target.host.id,
      target.host.name,
      target.host.hostname,
      target.host.port,
      target.host.username,
      target.host.authentication,
      target.hostRevision,
      target.hostKeyGeneration,
      hostKey?.algorithm ?? null,
      hostKey?.publicKeyBase64 ?? null,
      hostKey?.fingerprintSha256 ?? null,
      hostKey?.generation ?? null
    ]))
    .digest('hex')
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
    targetIdentityKey(currentTarget) !==
    targetIdentityKey(originalTarget)
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

function installationSftpLimits(
  bundle: LoadedBundle,
  configured?: BoundedSftpLimits
): BoundedSftpLimits {
  const largest = Math.max(
    bundle.releaseKeyRegistryBytes.byteLength,
    bundle.remoteRuntimeLockBytes.byteLength,
    ...bundle.manifest.files.map((file) => file.size),
    MAXIMUM_METADATA_BYTES
  )
  const payload =
    bundle.manifest.files.reduce(
      (sum, file) => sum + file.size,
      0
    ) +
    bundle.releaseKeyRegistryBytes.byteLength +
    bundle.remoteRuntimeLockBytes.byteLength +
    2 * MAXIMUM_METADATA_BYTES
  return {
    maximumFileBytes: Math.max(
      largest,
      configured?.maximumFileBytes ?? 0
    ),
    maximumTotalBytes: Math.max(
      payload * 4,
      configured?.maximumTotalBytes ?? 0
    ),
    maximumOperations:
      configured?.maximumOperations ?? 2_048,
    operationTimeoutMs: configured?.operationTimeoutMs
  }
}

async function ensureManagedHierarchy(
  sftp: StagedSftp,
  uid: number,
  signal: AbortSignal
): Promise<void> {
  for (const path of [
    '.goodbuddy',
    RUNTIME_ROOT,
    RUNTIME_STAGING_ROOT,
    OPENCODE_ROOT
  ]) {
    const existing = await pathMetadata(sftp, path, signal)
    if (existing === undefined) {
      await sftp.mkdir(path, signal)
    } else {
      assertMetadata(
        existing,
        path,
        'directory',
        uid,
        undefined,
        undefined
      )
      if (existing.mode !== PRIVATE_DIRECTORY_MODE) {
        await sftp.chmod(path, PRIVATE_DIRECTORY_MODE, signal)
      }
    }
    await assertRemoteMetadata(
      sftp,
      path,
      'directory',
      uid,
      PRIVATE_DIRECTORY_MODE,
      undefined,
      signal
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

async function uploadAndVerifyBundle(
  sftp: StagedSftp,
  staging: string,
  bundle: LoadedBundle,
  uid: number,
  cleanup: CleanupEntry[],
  signal: AbortSignal
): Promise<void> {
  const createdDirectories = new Set<string>()
  for (const file of bundle.manifest.files) {
    const parts = file.path.split('/')
    let relativeDirectory = ''
    for (const part of parts.slice(0, -1)) {
      relativeDirectory = relativeDirectory
        ? `${relativeDirectory}/${part}`
        : part
      if (!createdDirectories.has(relativeDirectory)) {
        const directory = `${staging}/${relativeDirectory}`
        await sftp.mkdir(directory, signal)
        trackCleanup(cleanup, {
          path: directory,
          type: 'directory'
        })
        createdDirectories.add(relativeDirectory)
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

    const contents = await readFile(
      join(bundle.bundleDirectory, ...file.path.split('/'))
    )
    if (
      contents.byteLength !== file.size ||
      sha256(contents) !== file.sha256
    ) {
      throw new Error(
        `Runtime bundle changed after local verification: ${file.path}`
      )
    }
    const destination = `${staging}/${file.path}`
    trackCleanup(cleanup, { path: destination, type: 'file' })
    await sftp.writeFile(destination, contents, signal)
    const mode = file.mode === '0755' ? 0o755 : 0o644
    await sftp.chmod(destination, mode, signal)
    await verifyRemoteFile(
      sftp,
      destination,
      file.size,
      file.sha256,
      uid,
      mode,
      signal
    )
  }

  const expectedManifestBytes =
    canonicalRuntimeManifestBytes(bundle.manifest)
  for (const metadataName of ['manifest.json', 'manifest.sig']) {
    const contents = await readFile(
      join(bundle.bundleDirectory, metadataName)
    )
    if (
      contents.byteLength > MAXIMUM_METADATA_BYTES ||
      (
        metadataName === 'manifest.json' &&
        !contents.equals(expectedManifestBytes)
      )
    ) {
      throw new Error(
        `Runtime bundle metadata changed after verification: ${metadataName}`
      )
    }
    const destination = `${staging}/${metadataName}`
    trackCleanup(cleanup, { path: destination, type: 'file' })
    await sftp.writeFile(destination, contents, signal)
    await sftp.chmod(destination, METADATA_MODE, signal)
    await verifyRemoteFile(
      sftp,
      destination,
      contents.byteLength,
      sha256(contents),
      uid,
      METADATA_MODE,
      signal
    )
  }
}

async function verifyRemoteBundle(
  sftp: StagedSftp,
  destination: string,
  bundle: LoadedBundle,
  uid: number,
  signal: AbortSignal
): Promise<void> {
  const [manifestBytes, signatureBytes] = await Promise.all([
    readFile(join(bundle.bundleDirectory, 'manifest.json')),
    readFile(join(bundle.bundleDirectory, 'manifest.sig'))
  ])
  await verifyRemoteBundleFromMetadata(
    sftp,
    destination,
    bundle,
    manifestBytes,
    signatureBytes,
    uid,
    'contents',
    signal
  )
}

async function verifyRemoteBundleFromMetadata(
  sftp: StagedSftp,
  destination: string,
  bundle: LoadedBundle,
  manifestBytes: Buffer,
  signatureBytes: Buffer,
  uid: number,
  verification: 'metadata' | 'contents',
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
    if (verification === 'contents') {
      await verifyRemoteFile(
        sftp,
        path,
        file.size,
        file.sha256,
        uid,
        mode,
        signal
      )
    } else {
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
  }
  for (const [metadataName, contents] of [
    ['manifest.json', manifestBytes],
    ['manifest.sig', signatureBytes]
  ] as const) {
    if (contents.byteLength > MAXIMUM_METADATA_BYTES) {
      throw new Error('Runtime metadata exceeds its safety limit')
    }
    const path = `${destination}/${metadataName}`
    if (verification === 'contents') {
      await verifyRemoteFile(
        sftp,
        path,
        contents.byteLength,
        sha256(contents),
        uid,
        METADATA_MODE,
        signal
      )
    } else {
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
  signal: AbortSignal
): Promise<void> {
  signal.throwIfAborted()
  try {
    await activate(
      lease,
      bundle.manifest.runtimeId,
      bundle.manifest.bundleDigest,
      bundle.manifest.architecture,
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

async function settleBoundedly(
  promises: readonly Promise<unknown>[],
  timeoutMs: number
): Promise<void> {
  if (promises.length === 0) {
    return
  }
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      Promise.allSettled(promises),
      new Promise<void>((resolve) => {
        timeout = setTimeout(resolve, timeoutMs)
      })
    ])
  } finally {
    if (timeout) {
      clearTimeout(timeout)
    }
  }
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

function isMissingPathError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (
      (error as { code?: unknown }).code === 2 ||
      (error as { code?: unknown }).code === 'ENOENT'
    )
  )
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

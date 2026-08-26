import { createHash, randomUUID } from 'node:crypto'
import { lstat, readFile } from 'node:fs/promises'
import {
  type AgentArchitecture,
  type AgentBundleManifest,
  type AgentReleaseKeyRegistry
} from '../../shared/agent-installation-contracts'
import type { AgentBootstrapIncompatibleReason } from '../../shared/ssh-host-contracts'
import type {
  BoundedSftpLimits,
  SftpEntryMetadata,
  StagedSftp
} from '../ssh/bounded-sftp'
import {
  verifyAgentInstallationId,
  type VerifiedAgentInstallationId
} from '../ssh/ssh-agent-command'
import type {
  SshConnectionLease,
  SshConnectionPool,
  SshConnectionPoolTarget
} from '../ssh/ssh-connection-pool'
import {
  parseInstallationRegistryState
} from '../../shared/remote-environment-registry-contracts'
import {
  getBundledAgentDirectory,
  type BundledAgentResourcePaths
} from './bundled-agent-resources'
import {
  assertAgentManifestMatchesRuntimeLock,
  canonicalAgentReleaseKeyRegistryBytes,
  parseAgentReleaseKeyRegistry,
  parseAgentReleaseKeyRegistryBytes,
  readAgentReleaseKeyRegistry,
  readAgentRuntimeLock,
  verifyAgentManifestSignature,
  verifyAgentBundleDirectory,
  type AgentVerificationEnvironment,
  type VerifiedAgentBundle
} from './agent-bundle-verifier'
import { settleBoundedly } from './bounded-settlement'
import { isMissingPathError } from './path-errors'

const MAXIMUM_INSTALLATION_FILES = 300
const MAXIMUM_INSTALLATION_BYTES = 512 * 1024 * 1024
const MAXIMUM_AGENT_FILE_BYTES = 256 * 1024 * 1024
const METADATA_MODE = 0o644
const PRIVATE_FILE_MODE = 0o600
const PRIVATE_DIRECTORY_MODE = 0o700
const DISPOSE_WAIT_TIMEOUT_MS = 5_000
const AGENT_REGISTRY_PATH = '.goodbuddy/agent/registry.json'
const RELEASE_KEYS_PATH = '.goodbuddy/agent/release-keys.json'
const MAXIMUM_METADATA_BYTES = 1024 * 1024

export type AgentInstallationPhase =
  | 'inspecting-host'
  | 'verifying-bundle'
  | 'preparing-installation'
  | 'uploading-bundle'
  | 'starting-agent'
  | 'checking-health'
  | 'complete'

export type AgentInstallationIdentity = {
  installationId: VerifiedAgentInstallationId
  binaryDigest: string
  agentVersion: string
  protocol: {
    major: number
    minor: number
  }
  platform: 'linux'
  architecture: AgentArchitecture
  supervisor: 'detached-on-demand'
}

export interface AgentInstallationTargetResolver {
  resolve(hostId: string): Promise<SshConnectionPoolTarget>
}

export type AgentInstallationRequestOptions = {
  signal?: AbortSignal
  onProgress?: (phase: AgentInstallationPhase) => void
  force?: boolean
}

export class AgentInstallationError extends Error {
  constructor(
    message: string,
    readonly reason:
      | 'incompatible'
      | 'corrupt'
      | 'host-identity-changed'
      | 'lifecycle'
      | 'capacity',
    readonly detail?: AgentBootstrapIncompatibleReason | unknown
  ) {
    super(message)
    this.name = 'AgentInstallationError'
  }
}

type ActiveInstallation = {
  promise: Promise<AgentInstallationIdentity>
  controller: AbortController
  progressCallbacks: Set<(phase: AgentInstallationPhase) => void>
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

export type AgentInstallationBundleLoader = (
  architecture: AgentArchitecture
) => Promise<{
  bundle: VerifiedAgentBundle
  registry: AgentReleaseKeyRegistry
  release?: () => void
}>

export class AgentInstallationManager {
  readonly #resolver: AgentInstallationTargetResolver
  readonly #sshPool: Pick<SshConnectionPool, 'acquire'>
  readonly #resourcePaths: BundledAgentResourcePaths
  readonly #verificationEnvironment: AgentVerificationEnvironment
  readonly #sftpLimits?: BoundedSftpLimits
  readonly #maximumConcurrentHosts: number
  readonly #loadBundle?: AgentInstallationBundleLoader
  readonly #active = new Map<string, ActiveInstallation>()
  readonly #installed = new Map<string, AgentInstallationIdentity>()
  #closed = false
  #disposePromise: Promise<void> | undefined

  constructor(options: {
    resolver: AgentInstallationTargetResolver
    sshPool: Pick<SshConnectionPool, 'acquire'>
    resourcePaths: BundledAgentResourcePaths
    verificationEnvironment?: AgentVerificationEnvironment
    sftpLimits?: BoundedSftpLimits
    maximumConcurrentHosts?: number
    loadVerifiedBundle?: AgentInstallationBundleLoader
    packageBundleLoader?: AgentInstallationBundleLoader
  }) {
    this.#resolver = options.resolver
    this.#sshPool = options.sshPool
    this.#resourcePaths = options.resourcePaths
    this.#verificationEnvironment =
      options.verificationEnvironment ?? 'production'
    this.#sftpLimits = options.sftpLimits
    this.#maximumConcurrentHosts =
      options.maximumConcurrentHosts ?? 8
    if (
      options.loadVerifiedBundle &&
      options.packageBundleLoader
    ) {
      throw new Error(
        'Agent installation accepts only one bundle loader'
      )
    }
    this.#loadBundle =
      options.packageBundleLoader ?? options.loadVerifiedBundle
    if (
      options.loadVerifiedBundle &&
      this.#verificationEnvironment !== 'test'
    ) {
      throw new Error(
        'Injected Agent bundles are allowed only in test verification'
      )
    }
    if (
      this.#verificationEnvironment === 'production' &&
      options.packageBundleLoader === undefined
    ) {
      throw new Error(
        'Production Agent installation requires a verified package loader'
      )
    }
    if (
      !Number.isSafeInteger(this.#maximumConcurrentHosts) ||
      this.#maximumConcurrentHosts <= 0 ||
      this.#maximumConcurrentHosts > 32
    ) {
      throw new Error('Agent installation concurrency limit is invalid')
    }
  }

  async ensureInstalled(
    hostId: string,
    options: AgentInstallationRequestOptions = {}
  ): Promise<AgentInstallationIdentity> {
    this.#throwIfClosed()
    options.signal?.throwIfAborted()
    if (options.onProgress) {
      try {
        options.onProgress('inspecting-host')
      } catch {
        // Progress observers cannot alter the installation outcome.
      }
    }
    const target = await this.#resolver.resolve(hostId)
    this.#throwIfClosed()
    options.signal?.throwIfAborted()
    if (target.host.id !== hostId) {
      throw new Error('Resolved SSH host does not match the request')
    }
    const operationKey = targetIdentityKey(target)
    const existing = this.#active.get(operationKey)
    if (existing) {
      return this.#waitForActive(existing, options)
    }
    const installed = this.#installed.get(operationKey)
    if (!options.force && installed !== undefined) {
      try {
        options.onProgress?.('complete')
      } catch {
        // Progress observers cannot alter the installation outcome.
      }
      return installed
    }
    if (this.#active.size >= this.#maximumConcurrentHosts) {
      throw new AgentInstallationError(
        'Too many Agent installations are already running',
        'capacity'
      )
    }
    const progressCallbacks = new Set<
      (phase: AgentInstallationPhase) => void
    >()
    if (options.onProgress) {
      progressCallbacks.add(options.onProgress)
    }
    const emitProgress = (phase: AgentInstallationPhase): void => {
      for (const callback of progressCallbacks) {
        try {
          callback(phase)
        } catch {
          // Progress observers cannot alter the installation outcome.
        }
      }
    }
    const controller = new AbortController()
    const promise = this.#run(
      target,
      controller.signal,
      emitProgress
    ).then((identity) => {
      this.#installed.set(operationKey, identity)
      return identity
    })
    const active = {
      promise,
      controller,
      progressCallbacks,
      waiters: 0,
      settled: false
    }
    this.#active.set(operationKey, active)
    void promise.finally(() => {
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
      'Agent installation manager was disposed',
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
      throw new Error('Agent installation manager is disposed')
    }
  }

  async #waitForActive(
    active: ActiveInstallation,
    options: AgentInstallationRequestOptions
  ): Promise<AgentInstallationIdentity> {
    active.waiters += 1
    if (options.onProgress) {
      active.progressCallbacks.add(options.onProgress)
    }
    try {
      return await waitForOperation(
        active.promise,
        options.signal
      )
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
            'Agent installation has no remaining waiters',
            'AbortError'
          )
        )
      }
    }
  }

  async #run(
    target: SshConnectionPoolTarget,
    signal: AbortSignal,
    progress: (phase: AgentInstallationPhase) => void
  ): Promise<AgentInstallationIdentity> {
    let lease: SshConnectionLease | undefined
    let sftp: StagedSftp | undefined
    let cleanupHomeDirectory: string | undefined
    const cleanup: CleanupEntry[] = []
    let stagingPublished = false
    let activationStarted = false
    let installationId: VerifiedAgentInstallationId | undefined
    let registrySnapshots: readonly ManagedFileSnapshot[] | undefined
    let releaseBundle: (() => void) | undefined
    try {
      lease = await this.#sshPool.acquire(target, signal)
      assertLeaseMatchesTarget(lease, target)
      const probe = await lease.runAgentBootstrapProbe(signal)
      if (!probe.ready) {
        throw new AgentInstallationError(
          `Remote host cannot run the GoodBuddy Agent: ${probe.reason}`,
          'incompatible',
          probe.reason
        )
      }

      progress('verifying-bundle')
      if (
        this.#loadBundle === undefined &&
        !(await bundledAgentDirectoryAvailable(
          getBundledAgentDirectory(
            this.#resourcePaths,
            probe.architecture
          )
        ))
      ) {
        const reused = await this.#reuseInstalledBundle(
          target,
          lease,
          probe,
          signal
        )
        progress('complete')
        return reused
      }
      const loaded =
        await this.#loadVerifiedBundle(probe.architecture)
      const { bundle, registry, registryBytes } = loaded
      releaseBundle = loaded.release
      assertBundleCapacity(bundle.manifest, registryBytes.byteLength)
      const candidateInstallationId = installationIdFor(bundle)
      installationId = candidateInstallationId
      const identity = publicIdentity(
        candidateInstallationId,
        bundle
      )

      progress('preparing-installation')
      sftp = await lease.openStagedSftp(
        probe.canonicalHomeDirectory,
        installationSftpLimits(
          bundle.manifest,
          registryBytes.byteLength,
          this.#sftpLimits
        ),
        signal
      )
      cleanupHomeDirectory = probe.canonicalHomeDirectory
      await ensureManagedHierarchy(sftp, probe.uid, signal)
      registrySnapshots = await snapshotManagedRegistries(
        sftp,
        probe.uid,
        signal
      )
      await installReleaseKeyRegistry(
        sftp,
        registryBytes,
        probe.uid,
        cleanup,
        signal
      )

      const destination =
        `.goodbuddy/agent/installations/${candidateInstallationId}`
      const existingDestination = await pathMetadata(sftp, destination)
      if (existingDestination !== undefined) {
        await verifyRemoteInstallation(
          sftp,
          destination,
          bundle,
          probe.uid,
          signal
        ).catch((error: unknown) => {
          rethrowAbort(error)
          throw corruptInstallationError(
            candidateInstallationId,
            error
          )
        })
        progress('checking-health')
        activationStarted = true
        await expectLifecycleSuccess(
          lease,
          candidateInstallationId,
          'bootstrap',
          signal
        ).catch((error: unknown) => {
          rethrowAbort(error)
          throw new AgentInstallationError(
            'Existing Agent installation could not be bootstrapped',
            'lifecycle'
          )
        })
        await expectLifecycleSuccess(
          lease,
          candidateInstallationId,
          'health',
          signal
        ).catch((error: unknown) => {
          rethrowAbort(error)
          throw new AgentInstallationError(
            'Existing Agent installation is not healthy',
            'lifecycle'
          )
        })
        progress('complete')
        return identity
      }

      progress('uploading-bundle')
      const staging =
        `.goodbuddy/agent/staging/op-${randomUUID()}`
      await sftp.mkdir(staging, signal)
      cleanup.push({ path: staging, type: 'directory' })
      await assertRemoteMetadata(
        sftp,
        staging,
        'directory',
        probe.uid,
        PRIVATE_DIRECTORY_MODE,
        undefined,
        signal
      )
      const reusedFiles = new Set<string>()
      if (
        await tryReuseVerifiedCurrentNode(
          sftp,
          staging,
          bundle,
          registry,
          this.#verificationEnvironment,
          probe.uid,
          signal
        )
      ) {
        reusedFiles.add(bundle.manifest.entrypoint.runtimePath)
        cleanup.push({
          path:
            `${staging}/${bundle.manifest.entrypoint.runtimePath}`,
          type: 'file'
        })
      }
      await uploadAndVerifyBundle(
        sftp,
        staging,
        bundle,
        probe.uid,
        cleanup,
        reusedFiles,
        signal
      )

      const currentTarget = await this.#resolver.resolve(
        target.host.id
      )
      if (
        targetIdentityKey(currentTarget) !== targetIdentityKey(target)
      ) {
        throw new AgentInstallationError(
          'SSH host identity changed before Agent activation',
          'host-identity-changed'
        )
      }
      signal?.throwIfAborted()
      await sftp.rename(staging, destination, signal)
      stagingPublished = true

      progress('starting-agent')
      activationStarted = true
      await expectLifecycleSuccess(
        lease,
        candidateInstallationId,
        'bootstrap',
        signal
      )
      progress('checking-health')
      await expectLifecycleSuccess(
        lease,
        candidateInstallationId,
        'health',
        signal
      )
      progress('complete')
      return identity
    } catch (error) {
      if (sftp && registrySnapshots) {
        if (activationStarted && lease && installationId) {
          await stopFailedCandidate(lease, installationId)
        }
        await restoreManagedRegistries(
          sftp,
          registrySnapshots
        ).catch((rollbackError: unknown) => {
          throw new AggregateError(
            [error, rollbackError],
            'Agent installation failed and its previous registry state could not be restored'
          )
        })
      }
      throw error
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
          // The lease may already be unavailable after cancellation.
        } finally {
          cleanupSftp?.close()
        }
      }
      lease?.release()
      releaseBundle?.()
    }
  }

  async #loadVerifiedBundle(
    architecture: AgentArchitecture
  ): Promise<{
    bundle: VerifiedAgentBundle
    registry: AgentReleaseKeyRegistry
    registryBytes: Buffer
    release?: () => void
  }> {
    if (this.#loadBundle) {
      const loaded = await this.#loadBundle(architecture)
      try {
        if (loaded.bundle.manifest.arch !== architecture) {
          throw new Error(
            'Verified Agent bundle architecture does not match the host'
          )
        }
        const canonicalRegistry =
          parseAgentReleaseKeyRegistry(loaded.registry)
        return {
          bundle: loaded.bundle,
          registry: canonicalRegistry,
          registryBytes:
            canonicalAgentReleaseKeyRegistryBytes(canonicalRegistry),
          ...(loaded.release ? { release: loaded.release } : {})
        }
      } catch (error) {
        loaded.release?.()
        throw error
      }
    }
    const [registry, runtimeLock] = await Promise.all([
      readAgentReleaseKeyRegistry(
        this.#resourcePaths.keyRegistryPath
      ),
      readAgentRuntimeLock(this.#resourcePaths.runtimeLockPath)
    ])
    const bundle = await verifyAgentBundleDirectory(
      getBundledAgentDirectory(this.#resourcePaths, architecture),
      {
        architecture,
        registry,
        runtimeLock,
        verificationEnvironment: this.#verificationEnvironment
      }
    )
    const canonicalRegistry = parseAgentReleaseKeyRegistry(
      registry
    )
    return {
      bundle,
      registry: canonicalRegistry,
      registryBytes:
        canonicalAgentReleaseKeyRegistryBytes(canonicalRegistry)
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
    signal: AbortSignal
  ): Promise<AgentInstallationIdentity> {
    const [registry, runtimeLock] = await Promise.all([
      readAgentReleaseKeyRegistry(
        this.#resourcePaths.keyRegistryPath
      ),
      readAgentRuntimeLock(this.#resourcePaths.runtimeLockPath)
    ])
    const canonicalRegistryBytes =
      canonicalAgentReleaseKeyRegistryBytes(registry)

    let metadataSftp: StagedSftp | undefined
    let installationSftp: StagedSftp | undefined
    let currentMatchesLock = false
    try {
      metadataSftp = await lease.openStagedSftp(
        probe.canonicalHomeDirectory,
        {
          maximumFileBytes: MAXIMUM_METADATA_BYTES,
          maximumTotalBytes: MAXIMUM_METADATA_BYTES * 4,
          maximumOperations: 32,
          operationTimeoutMs: 15_000
        },
        signal
      )
      const remoteRegistryBytes = await readVerifiedRemoteFile(
        metadataSftp,
        AGENT_REGISTRY_PATH,
        probe.uid,
        PRIVATE_FILE_MODE,
        signal
      )
      const remoteRegistry = parseInstallationRegistryState(
        parseJsonBytes(
          remoteRegistryBytes,
          'Installed Agent registry'
        )
      )
      const current = remoteRegistry.current
      if (
        current === undefined ||
        current.agentVersion !== runtimeLock.agentVersion ||
        current.arch !== probe.architecture ||
        current.installationId !==
          `agent-${current.manifestSha256}`
      ) {
        throw new AgentInstallationError(
          'This GoodBuddy package lacks matching Agent installation resources, and the Host has no matching current Agent',
          'incompatible'
        )
      }
      currentMatchesLock = true
      const remoteReleaseKeyBytes = await readVerifiedRemoteFile(
        metadataSftp,
        RELEASE_KEYS_PATH,
        probe.uid,
        PRIVATE_FILE_MODE,
        signal
      )
      const remoteReleaseKeyRegistry =
        parseAgentReleaseKeyRegistryBytes(
          remoteReleaseKeyBytes,
          'Installed Agent release-key registry'
        )
      const destination =
        `.goodbuddy/agent/installations/${current.installationId}`
      const manifestBytes = await metadataSftp.readFile(
        `${destination}/manifest.json`,
        signal
      )
      const signatureFile = await metadataSftp.readFile(
        `${destination}/manifest.sig`,
        signal
      )
      const signatureBytes = decodeDetachedSignature(
        signatureFile,
        'Agent detached signature'
      )
      const manifest = verifyAgentManifestSignature(
        manifestBytes,
        signatureBytes,
        registry,
        this.#verificationEnvironment
      )
      verifyAgentManifestSignature(
        manifestBytes,
        signatureBytes,
        remoteReleaseKeyRegistry,
        this.#verificationEnvironment
      )
      assertAgentManifestMatchesRuntimeLock(
        manifest,
        runtimeLock,
        probe.architecture
      )
      const manifestSha256 = sha256(manifestBytes)
      if (
        manifestSha256 !== current.manifestSha256 ||
        manifest.signingKeyId.length < 1
      ) {
        throw new Error(
          'Installed Agent manifest identity does not match its registry'
        )
      }
      const installationId = verifyAgentInstallationId(
        current.installationId
      )
      const bundle = {
        bundleDirectory: destination,
        manifest,
        manifestSha256
      }
      assertBundleCapacity(
        manifest,
        canonicalRegistryBytes.byteLength
      )
      metadataSftp.close()
      metadataSftp = undefined

      installationSftp = await lease.openStagedSftp(
        probe.canonicalHomeDirectory,
        installationSftpLimits(
          manifest,
          canonicalRegistryBytes.byteLength,
          this.#sftpLimits
        ),
        signal
      )
      await verifyRemoteInstallationFromMetadata(
        installationSftp,
        destination,
        bundle,
        manifestBytes,
        signatureFile,
        probe.uid,
        'critical-contents',
        signal
      )
      const currentTarget = await this.#resolver.resolve(
        target.host.id
      )
      if (
        targetIdentityKey(currentTarget) !==
        targetIdentityKey(target)
      ) {
        throw new AgentInstallationError(
          'SSH host identity changed before Agent activation',
          'host-identity-changed'
        )
      }
      await ensureCurrentAgentHealthy(
        lease,
        installationId,
        signal
      )
      return publicIdentity(installationId, bundle)
    } catch (error) {
      if (error instanceof AgentInstallationError) {
        throw error
      }
      if (isMissingPathError(error) && !currentMatchesLock) {
        throw new AgentInstallationError(
          'This GoodBuddy package lacks matching Agent installation resources, and the Host has no matching current Agent',
          'incompatible',
          error
        )
      }
      throw new AgentInstallationError(
        'The existing Host Agent could not be verified',
        'corrupt',
        error
      )
    } finally {
      metadataSftp?.close()
      installationSftp?.close()
    }
  }
}

async function bundledAgentDirectoryAvailable(
  directory: string
): Promise<boolean> {
  try {
    return (await lstat(directory)).isDirectory()
  } catch (error) {
    if (isMissingPathError(error)) {
      return false
    }
    throw error
  }
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

function targetIdentityKey(target: SshConnectionPoolTarget): string {
  const hostKey = target.host.hostKey
  return createHash('sha256')
    .update(JSON.stringify([
      'goodbuddy-agent-installation-target-v1',
      target.host.id,
      target.host.name,
      target.host.hostname,
      target.host.port,
      target.host.username,
      target.host.authentication,
      target.host.password ?? null,
      target.hostRevision,
      target.hostKeyGeneration,
      hostKey?.algorithm ?? null,
      hostKey?.publicKeyBase64 ?? null,
      hostKey?.fingerprintSha256 ?? null,
      hostKey?.acceptedAt ?? null,
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
    lease.identity.hostKeyGeneration !== target.hostKeyGeneration ||
    !/^[a-f0-9]{64}$/u.test(
      lease.identity.authenticationIdentity
    )
  ) {
    throw new Error('SSH lease identity does not match the resolved host')
  }
}

function installationIdFor(
  bundle: VerifiedAgentBundle
): VerifiedAgentInstallationId {
  return verifyAgentInstallationId(
    `agent-${bundle.manifestSha256}`
  )
}

function publicIdentity(
  installationId: VerifiedAgentInstallationId,
  bundle: VerifiedAgentBundle
): AgentInstallationIdentity {
  return {
    installationId,
    binaryDigest: `sha256:${bundle.manifestSha256}`,
    agentVersion: bundle.manifest.agentVersion,
    protocol: { ...bundle.manifest.protocol },
    platform: 'linux',
    architecture: bundle.manifest.arch,
    supervisor: 'detached-on-demand'
  }
}

function assertBundleCapacity(
  manifest: AgentBundleManifest,
  registryBytes: number
): void {
  const total =
    manifest.files.reduce((sum, file) => sum + file.size, 0) +
    registryBytes
  if (
    manifest.files.length > MAXIMUM_INSTALLATION_FILES ||
    manifest.files.some(
      (file) => file.size > MAXIMUM_AGENT_FILE_BYTES
    ) ||
    !Number.isSafeInteger(total) ||
    total > MAXIMUM_INSTALLATION_BYTES
  ) {
    throw new Error('Agent bundle exceeds installation safety limits')
  }
}

function installationSftpLimits(
  manifest: AgentBundleManifest,
  registryBytes: number,
  configured?: BoundedSftpLimits
): BoundedSftpLimits {
  const largest = Math.max(
    registryBytes,
    ...manifest.files.map((file) => file.size),
    1024 * 1024
  )
  const payload =
    manifest.files.reduce((sum, file) => sum + file.size, 0) +
    registryBytes +
    2 * 1024 * 1024
  const reusableNodeBytes =
    manifest.files.find(
      (file) =>
        file.path === manifest.entrypoint.runtimePath
    )?.size ?? 0
  return {
    maximumFileBytes: Math.max(
      largest,
      configured?.maximumFileBytes ?? 0
    ),
    maximumTotalBytes: Math.max(
      payload * 2 + reusableNodeBytes,
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
  signal?: AbortSignal
): Promise<void> {
  for (const path of [
    '.goodbuddy',
    '.goodbuddy/agent',
    '.goodbuddy/agent/staging',
    '.goodbuddy/agent/installations'
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

async function installReleaseKeyRegistry(
  sftp: StagedSftp,
  contents: Buffer,
  uid: number,
  cleanup: CleanupEntry[],
  signal?: AbortSignal
): Promise<void> {
  const destination = '.goodbuddy/agent/release-keys.json'
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
    `.goodbuddy/agent/.release-keys-${randomUUID()}.tmp`
  cleanup.push({ path: temporary, type: 'file' })
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
  cleanup.pop()
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

async function snapshotManagedRegistries(
  sftp: StagedSftp,
  uid: number,
  signal?: AbortSignal
): Promise<readonly ManagedFileSnapshot[]> {
  const snapshots: ManagedFileSnapshot[] = []
  for (const path of [
    '.goodbuddy/agent/release-keys.json',
    '.goodbuddy/agent/registry.json'
  ]) {
    const metadata = await pathMetadata(sftp, path, signal)
    if (metadata === undefined) {
      snapshots.push({ path, contents: undefined, uid })
      continue
    }
    assertMetadata(
      metadata,
      path,
      'file',
      uid,
      PRIVATE_FILE_MODE,
      undefined
    )
    snapshots.push({
      path,
      contents: await sftp.readFile(path, signal),
      uid
    })
  }
  return snapshots
}

async function restoreManagedRegistries(
  sftp: StagedSftp,
  snapshots: readonly ManagedFileSnapshot[]
): Promise<void> {
  for (const snapshot of snapshots) {
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
      continue
    }
    if (
      existing !== undefined &&
      existing.type === 'file' &&
      existing.mode === PRIVATE_FILE_MODE &&
      existing.size === snapshot.contents.byteLength &&
      (await sftp.readFile(snapshot.path)).equals(snapshot.contents)
    ) {
      continue
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
      `.goodbuddy/agent/.registry-rollback-${randomUUID()}.tmp`
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
        PRIVATE_FILE_MODE
      )
    } catch (error) {
      await sftp.unlink(temporary).catch(() => undefined)
      throw error
    }
  }
}

async function stopFailedCandidate(
  lease: SshConnectionLease,
  installationId: VerifiedAgentInstallationId
): Promise<void> {
  if (!lease.isUsable()) {
    return
  }
  try {
    await lease.runAgentLifecycleAction(
      installationId,
      'stop'
    )
  } catch {
    // The failed candidate is stopped best-effort before registry rollback.
  }
}

async function uploadAndVerifyBundle(
  sftp: StagedSftp,
  staging: string,
  bundle: VerifiedAgentBundle,
  uid: number,
  cleanup: CleanupEntry[],
  reusedFiles: ReadonlySet<string>,
  signal?: AbortSignal
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
        cleanup.push({ path: directory, type: 'directory' })
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
    if (reusedFiles.has(file.path)) {
      continue
    }
    const contents = await readFile(
      `${bundle.bundleDirectory}/${file.path}`
    )
    if (
      contents.byteLength !== file.size ||
      sha256(contents) !== file.sha256
    ) {
      throw new Error(
        `Agent bundle changed after local verification: ${file.path}`
      )
    }
    const destination = `${staging}/${file.path}`
    cleanup.push({ path: destination, type: 'file' })
    await sftp.writeFile(destination, contents, signal)
    await sftp.chmod(
      destination,
      file.mode === '0755' ? 0o755 : 0o644,
      signal
    )
    await verifyRemoteFile(
      sftp,
      destination,
      file.size,
      file.sha256,
      uid,
      file.mode === '0755' ? 0o755 : 0o644,
      signal
    )
  }

  for (const metadataName of ['manifest.json', 'manifest.sig']) {
    const contents = await readFile(
      `${bundle.bundleDirectory}/${metadataName}`
    )
    if (
      metadataName === 'manifest.json' &&
      sha256(contents) !== bundle.manifestSha256
    ) {
      throw new Error('Agent manifest changed after local verification')
    }
    const destination = `${staging}/${metadataName}`
    cleanup.push({ path: destination, type: 'file' })
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

async function tryReuseVerifiedCurrentNode(
  sftp: StagedSftp,
  staging: string,
  candidate: VerifiedAgentBundle,
  registry: AgentReleaseKeyRegistry,
  verificationEnvironment: AgentVerificationEnvironment,
  uid: number,
  signal?: AbortSignal
): Promise<boolean> {
  const runtimePath = candidate.manifest.entrypoint.runtimePath
  const candidateNode = candidate.manifest.files.find(
    (file) => file.path === runtimePath
  )
  if (
    candidateNode === undefined ||
    sftp.hardLink === undefined
  ) {
    return false
  }
  const destination = `${staging}/${runtimePath}`
  try {
    const registryBytes = await sftp.readFile(
      AGENT_REGISTRY_PATH,
      signal
    )
    const current = parseInstallationRegistryState(
      parseJsonBytes(registryBytes, 'Installed Agent registry')
    ).current
    if (
      current === undefined ||
      current.arch !== candidate.manifest.arch ||
      current.installationId !==
        `agent-${current.manifestSha256}`
    ) {
      return false
    }
    const installationId = verifyAgentInstallationId(
      current.installationId
    )
    const root =
      `.goodbuddy/agent/installations/${installationId}`
    await assertRemoteMetadata(
      sftp,
      root,
      'directory',
      uid,
      PRIVATE_DIRECTORY_MODE,
      undefined,
      signal
    )
    const manifestPath = `${root}/manifest.json`
    const signaturePath = `${root}/manifest.sig`
    const manifestBytes = await sftp.readFile(
      manifestPath,
      signal
    )
    const signatureFile = await sftp.readFile(
      signaturePath,
      signal
    )
    const manifest = verifyAgentManifestSignature(
      manifestBytes,
      decodeDetachedSignature(
        signatureFile,
        'Agent detached signature'
      ),
      registry,
      verificationEnvironment
    )
    if (
      sha256(manifestBytes) !== current.manifestSha256 ||
      manifest.agentVersion !== current.agentVersion ||
      manifest.arch !== current.arch
    ) {
      return false
    }
    await verifyRemoteFile(
      sftp,
      manifestPath,
      manifestBytes.byteLength,
      sha256(manifestBytes),
      uid,
      METADATA_MODE,
      signal
    )
    await verifyRemoteFile(
      sftp,
      signaturePath,
      signatureFile.byteLength,
      sha256(signatureFile),
      uid,
      METADATA_MODE,
      signal
    )
    const currentNode = manifest.files.find(
      (file) => file.path === manifest.entrypoint.runtimePath
    )
    if (
      currentNode === undefined ||
      currentNode.path !== candidateNode.path ||
      currentNode.size !== candidateNode.size ||
      currentNode.sha256 !== candidateNode.sha256 ||
      currentNode.mode !== candidateNode.mode
    ) {
      return false
    }
    const source = `${root}/${currentNode.path}`
    const mode = currentNode.mode === '0755' ? 0o755 : 0o644
    await verifyRemoteFile(
      sftp,
      source,
      currentNode.size,
      currentNode.sha256,
      uid,
      mode,
      signal
    )
    await sftp.hardLink(source, destination, signal)
    await assertRemoteMetadata(
      sftp,
      destination,
      'file',
      uid,
      mode,
      candidateNode.size,
      signal
    )
    return true
  } catch (error) {
    rethrowAbort(error)
    try {
      const linked = await pathMetadata(sftp, destination, signal)
      if (linked !== undefined) {
        assertMetadata(
          linked,
          destination,
          'file',
          uid,
          undefined,
          undefined
        )
        await sftp.unlink(destination, signal)
      }
    } catch (cleanupError) {
      rethrowAbort(cleanupError)
    }
    return false
  }
}

async function verifyRemoteInstallation(
  sftp: StagedSftp,
  destination: string,
  bundle: VerifiedAgentBundle,
  uid: number,
  signal?: AbortSignal
): Promise<void> {
  const [manifestBytes, signatureBytes] = await Promise.all([
    readFile(`${bundle.bundleDirectory}/manifest.json`),
    readFile(`${bundle.bundleDirectory}/manifest.sig`)
  ])
  await verifyRemoteInstallationFromMetadata(
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

async function verifyRemoteInstallationFromMetadata(
  sftp: StagedSftp,
  destination: string,
  bundle: VerifiedAgentBundle,
  manifestBytes: Buffer,
  signatureBytes: Buffer,
  uid: number,
  verification: 'contents' | 'critical-contents',
  signal?: AbortSignal
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
    if (
      verification === 'contents' ||
      file.path !== bundle.manifest.entrypoint.runtimePath
    ) {
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
    await verifyRemoteFile(
      sftp,
      `${destination}/${metadataName}`,
      contents.byteLength,
      sha256(contents),
      uid,
      METADATA_MODE,
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
  signal?: AbortSignal
): Promise<void> {
  const contents = await readVerifiedRemoteFile(
    sftp,
    path,
    uid,
    mode,
    signal,
    size
  )
  if (sha256(contents) !== digest) {
    throw new Error(`Remote Agent file readback mismatch: ${path}`)
  }
}

async function readVerifiedRemoteFile(
  sftp: StagedSftp,
  path: string,
  uid: number,
  mode: number,
  signal?: AbortSignal,
  expectedSize?: number
): Promise<Buffer> {
  const metadata = await sftp.stat(path, signal)
  assertMetadata(
    metadata,
    path,
    'file',
    uid,
    mode,
    expectedSize
  )
  const contents = await sftp.readFile(path, signal)
  if (contents.byteLength !== metadata.size) {
    throw new Error(`Remote Agent file readback mismatch: ${path}`)
  }
  await assertRemoteMetadata(
    sftp,
    path,
    'file',
    uid,
    mode,
    metadata.size,
    signal
  )
  return contents
}

async function assertRemoteMetadata(
  sftp: StagedSftp,
  path: string,
  type: 'file' | 'directory',
  uid: number,
  mode: number,
  size: number | undefined,
  signal?: AbortSignal
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
    throw new Error(`Remote Agent metadata mismatch: ${path}`)
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

async function expectLifecycleSuccess(
  lease: SshConnectionLease,
  installationId: VerifiedAgentInstallationId,
  action: 'bootstrap' | 'health',
  signal?: AbortSignal
): Promise<void> {
  const result = await lease.runAgentLifecycleAction(
    installationId,
    action,
    signal
  )
  if (result.exitCode !== 0) {
    throw new AgentInstallationError(
      `GoodBuddy Agent ${action} failed`,
      'lifecycle'
    )
  }
}

async function ensureCurrentAgentHealthy(
  lease: SshConnectionLease,
  installationId: VerifiedAgentInstallationId,
  signal?: AbortSignal
): Promise<void> {
  const initial = await lease.runAgentLifecycleAction(
    installationId,
    'health',
    signal
  )
  if (initial.exitCode === 0) {
    return
  }
  await expectLifecycleSuccess(
    lease,
    installationId,
    'bootstrap',
    signal
  )
  await expectLifecycleSuccess(
    lease,
    installationId,
    'health',
    signal
  )
}

function corruptInstallationError(
  installationId: VerifiedAgentInstallationId,
  cause: unknown
): AgentInstallationError {
  return new AgentInstallationError(
    `Existing Agent installation is corrupt: ${installationId}`,
    'corrupt',
    cause
  )
}

async function cleanupOwnedStaging(
  sftp: StagedSftp,
  entries: readonly CleanupEntry[]
): Promise<boolean> {
  let complete = true
  for (const entry of [...entries].reverse()) {
    try {
      if (entry.type === 'file') {
        await sftp.unlink(entry.path)
      } else {
        await sftp.rmdir(entry.path)
      }
    } catch (error) {
      if (!isMissingPathError(error)) {
        complete = false
        // Cleanup is best-effort and never widens beyond operation-owned paths.
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

function rethrowAbort(error: unknown): void {
  if (
    (
      error instanceof DOMException &&
      error.name === 'AbortError'
    ) ||
    (
      typeof error === 'object' &&
      error !== null &&
      'name' in error &&
      (error as { name?: unknown }).name === 'AbortError'
    )
  ) {
    throw error
  }
}

function sha256(contents: Uint8Array): string {
  return createHash('sha256').update(contents).digest('hex')
}

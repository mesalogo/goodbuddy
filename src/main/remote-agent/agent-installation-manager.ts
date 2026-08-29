import { createHash, randomUUID } from 'node:crypto'
import {
  type AgentArchitecture,
  type AgentBundleManifest
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
import type {
  SshRemotePackageAgentIdentity
} from '../ssh/ssh-remote-package-bootstrap'
import {
  parseInstallationRegistryState
} from '../../shared/remote-environment-registry-contracts'
import type { BundledAgentResourcePaths } from './bundled-agent-resources'
import {
  assertAgentManifestMatchesRuntimeLock,
  canonicalAgentReleaseKeyRegistryBytes,
  parseAgentReleaseKeyRegistryBytes,
  readAgentReleaseKeyRegistry,
  readAgentRuntimeLock,
  verifyAgentManifestSignature,
  type AgentVerificationEnvironment,
  type VerifiedAgentBundle
} from './agent-bundle-verifier'
import { settleBoundedly } from './bounded-settlement'
import { isMissingPathError } from './path-errors'
import { remoteHostTargetIdentityKey } from './remote-host-target-identity'

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

export type AgentActivationRequestOptions = {
  signal?: AbortSignal
  onProgress?: (phase: AgentInstallationPhase) => void
}

export type PublishedAgentInstallationIdentity =
  SshRemotePackageAgentIdentity

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

export class AgentInstallationManager {
  readonly #resolver: AgentInstallationTargetResolver
  readonly #sshPool: Pick<SshConnectionPool, 'acquire'>
  readonly #resourcePaths: BundledAgentResourcePaths
  readonly #verificationEnvironment: AgentVerificationEnvironment
  readonly #sftpLimits?: BoundedSftpLimits
  readonly #maximumConcurrentHosts: number
  readonly #active = new Map<string, ActiveInstallation>()
  readonly #current = new Map<
    string,
    { targetKey: string; identity: AgentInstallationIdentity }
  >()
  readonly #cacheGenerations = new Map<string, number>()
  #closed = false
  #disposePromise: Promise<void> | undefined

  constructor(options: {
    resolver: AgentInstallationTargetResolver
    sshPool: Pick<SshConnectionPool, 'acquire'>
    resourcePaths: BundledAgentResourcePaths
    verificationEnvironment?: AgentVerificationEnvironment
    sftpLimits?: BoundedSftpLimits
    maximumConcurrentHosts?: number
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
      !Number.isSafeInteger(this.#maximumConcurrentHosts) ||
      this.#maximumConcurrentHosts <= 0 ||
      this.#maximumConcurrentHosts > 32
    ) {
      throw new Error('Agent installation concurrency limit is invalid')
    }
  }

  /**
   * Verifies and starts the exact Agent selected by packaged trust metadata.
   * This path never loads an installable Agent bundle or mutates SFTP state.
   */
  async activateInstalled(
    hostId: string,
    options: AgentActivationRequestOptions = {}
  ): Promise<AgentInstallationIdentity> {
    return this.#request(hostId, 'activate', options)
  }

  /**
   * Adopts an exact Agent directory already published by the authenticated
   * package installer. Packaged trust verifies the remote contents before
   * canonical metadata and fixed lifecycle actions promote the candidate.
   */
  async activatePublished(
    hostId: string,
    expectedIdentity: PublishedAgentInstallationIdentity,
    options: AgentActivationRequestOptions = {}
  ): Promise<AgentInstallationIdentity> {
    assertPublishedAgentIdentity(expectedIdentity)
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
    options: AgentActivationRequestOptions,
    expectedIdentity?: PublishedAgentInstallationIdentity
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
    const targetKey = remoteHostTargetIdentityKey(target)
    const cacheGeneration =
      this.#cacheGenerations.get(hostId) ?? 0
    if (mode === 'activate') {
      const current = this.#current.get(hostId)
      if (current?.targetKey === targetKey) {
        try {
          options.onProgress?.('complete')
        } catch {
          // Progress observers cannot alter the cached result.
        }
        return current.identity
      }
    }
    const operationKey = mode === 'adopt'
      ? `${mode}:${targetKey}:${publishedAgentIdentityKey(
          expectedIdentity!
        )}`
      : `${mode}:${targetKey}`
    const existing = this.#active.get(operationKey)
    if (existing) {
      return this.#waitForActive(existing, options)
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
    const promise = (mode === 'activate'
      ? this.#activateInstalled(
          target,
          controller.signal,
          emitProgress
        )
      : this.#activatePublished(
          target,
          expectedIdentity!,
          controller.signal,
          emitProgress
        )).then((identity) => {
          if (
            mode === 'activate' &&
            (this.#cacheGenerations.get(hostId) ?? 0) ===
              cacheGeneration
          ) {
            this.#current.set(hostId, { targetKey, identity })
          }
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
    this.#current.clear()
    this.#cacheGenerations.clear()
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
    return this.#disposePromise
  }

  #throwIfClosed(): void {
    if (this.#closed) {
      throw new Error('Agent installation manager is disposed')
    }
  }

  async #waitForActive(
    active: ActiveInstallation,
    options: AgentActivationRequestOptions
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

  async #activateInstalled(
    target: SshConnectionPoolTarget,
    signal: AbortSignal,
    progress: (phase: AgentInstallationPhase) => void
  ): Promise<AgentInstallationIdentity> {
    let lease: SshConnectionLease | undefined
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
      const identity = await this.#reuseInstalledBundle(
        target,
        lease,
        probe,
        signal
      )
      progress('complete')
      return identity
    } finally {
      lease?.release()
    }
  }

  async #activatePublished(
    target: SshConnectionPoolTarget,
    expected: PublishedAgentInstallationIdentity,
    signal: AbortSignal,
    progress: (phase: AgentInstallationPhase) => void
  ): Promise<AgentInstallationIdentity> {
    let lease: SshConnectionLease | undefined
    let sftp: StagedSftp | undefined
    let registrySnapshots: readonly ManagedFileSnapshot[] | undefined
    const cleanup: CleanupEntry[] = []
    const installationId = verifyAgentInstallationId(
      expected.installationId
    )
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
      if (
        expected.platform !== 'linux' ||
        expected.architecture !== probe.architecture
      ) {
        throw new AgentInstallationError(
          'Published Agent does not match the Host platform or architecture',
          'incompatible'
        )
      }

      progress('verifying-bundle')
      const [registry, runtimeLock] = await Promise.all([
        readAgentReleaseKeyRegistry(
          this.#resourcePaths.keyRegistryPath
        ),
        readAgentRuntimeLock(this.#resourcePaths.runtimeLockPath)
      ])
      const canonicalRegistryBytes =
        canonicalAgentReleaseKeyRegistryBytes(registry)
      sftp = await lease.openStagedSftp(
        probe.canonicalHomeDirectory,
        {
          maximumFileBytes: Math.max(
            MAXIMUM_AGENT_FILE_BYTES,
            this.#sftpLimits?.maximumFileBytes ?? 0
          ),
          maximumTotalBytes: Math.max(
            MAXIMUM_INSTALLATION_BYTES +
              MAXIMUM_METADATA_BYTES * 4,
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
        `.goodbuddy/agent/installations/${installationId}`
      const manifestBytes = await sftp.readFile(
        `${destination}/manifest.json`,
        signal
      )
      const signatureFile = await sftp.readFile(
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
      assertAgentManifestMatchesRuntimeLock(
        manifest,
        runtimeLock,
        probe.architecture
      )
      const bundle: VerifiedAgentBundle = {
        bundleDirectory: destination,
        manifest,
        manifestSha256: sha256(manifestBytes)
      }
      assertPublishedAgentMatches(expected, bundle)
      assertBundleCapacity(
        manifest,
        canonicalRegistryBytes.byteLength
      )
      // The fixed SSH installer has already verified the complete published
      // tree against this signed manifest. Adoption rechecks its immutable
      // identity and metadata without transferring the payload back to Main.
      await verifyRemoteInstallationFromMetadata(
        sftp,
        destination,
        bundle,
        manifestBytes,
        signatureFile,
        probe.uid,
        false,
        signal
      )
      registrySnapshots = await snapshotManagedRegistries(
        sftp,
        probe.uid,
        signal
      )
      await installReleaseKeyRegistry(
        sftp,
        canonicalRegistryBytes,
        probe.uid,
        cleanup,
        signal
      )
      const currentTarget = await this.#resolver.resolve(
        target.host.id
      )
      if (
        remoteHostTargetIdentityKey(currentTarget) !==
        remoteHostTargetIdentityKey(target)
      ) {
        throw new AgentInstallationError(
          'SSH host identity changed before Agent adoption',
          'host-identity-changed'
        )
      }

      progress('starting-agent')
      await expectLifecycleSuccess(
        lease,
        installationId,
        'bootstrap',
        signal
      )
      progress('checking-health')
      await expectLifecycleSuccess(
        lease,
        installationId,
        'health',
        signal
      )
      progress('complete')
      return publicIdentity(installationId, bundle)
    } catch (error) {
      if (lease) {
        await stopFailedCandidate(lease, installationId)
      }
      if (registrySnapshots && sftp) {
        await restoreManagedRegistries(
          sftp,
          registrySnapshots
        ).catch((rollbackError: unknown) => {
          throw new AggregateError(
            [error, rollbackError],
            'Published Agent activation failed and its previous metadata state could not be restored'
          )
        })
      }
      if (
        error instanceof AgentInstallationError ||
        isAbortError(error)
      ) {
        throw error
      }
      throw new AgentInstallationError(
        'The published Host Agent could not be verified',
        'corrupt',
        error
      )
    } finally {
      if (sftp) {
        await cleanupOwnedStaging(sftp, cleanup)
      }
      sftp?.close()
      lease?.release()
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
        true,
        signal
      )
      const currentTarget = await this.#resolver.resolve(
        target.host.id
      )
      if (
        remoteHostTargetIdentityKey(currentTarget) !==
        remoteHostTargetIdentityKey(target)
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

function assertPublishedAgentIdentity(
  identity: PublishedAgentInstallationIdentity
): void {
  const installationId = verifyAgentInstallationId(
    identity.installationId
  )
  if (
    !/^[a-f0-9]{64}$/u.test(identity.manifestSha256) ||
    installationId !== `agent-${identity.manifestSha256}` ||
    identity.binaryDigest !==
      `sha256:${identity.manifestSha256}` ||
    identity.agentVersion.length < 1 ||
    identity.platform !== 'linux' ||
    (identity.architecture !== 'x64' &&
      identity.architecture !== 'arm64') ||
    !Number.isSafeInteger(identity.protocol.major) ||
    identity.protocol.major < 0 ||
    !Number.isSafeInteger(identity.protocol.minor) ||
    identity.protocol.minor < 0 ||
    identity.supervisor !== 'detached-on-demand'
  ) {
    throw new AgentInstallationError(
      'Published Agent identity is invalid',
      'corrupt'
    )
  }
}

function assertPublishedAgentMatches(
  expected: PublishedAgentInstallationIdentity,
  bundle: VerifiedAgentBundle
): void {
  if (
    expected.installationId !==
      `agent-${bundle.manifestSha256}` ||
    expected.agentVersion !== bundle.manifest.agentVersion ||
    expected.manifestSha256 !== bundle.manifestSha256 ||
    expected.binaryDigest !==
      `sha256:${bundle.manifestSha256}` ||
    expected.platform !== bundle.manifest.platform ||
    expected.architecture !== bundle.manifest.arch ||
    expected.protocol.major !== bundle.manifest.protocol.major ||
    expected.protocol.minor !== bundle.manifest.protocol.minor ||
    expected.supervisor !== 'detached-on-demand'
  ) {
    throw new AgentInstallationError(
      'Published Agent does not match the authenticated package result',
      'corrupt'
    )
  }
}

function publishedAgentIdentityKey(
  identity: PublishedAgentInstallationIdentity
): string {
  return createHash('sha256')
    .update(JSON.stringify(identity))
    .digest('hex')
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

async function verifyRemoteInstallationFromMetadata(
  sftp: StagedSftp,
  destination: string,
  bundle: VerifiedAgentBundle,
  manifestBytes: Buffer,
  signatureBytes: Buffer,
  uid: number,
  verifyCriticalContents: boolean,
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
      verifyCriticalContents &&
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
    const path = `${destination}/${metadataName}`
    if (!verifyCriticalContents) {
      await assertRemoteMetadata(
        sftp,
        path,
        'file',
        uid,
        METADATA_MODE,
        contents.byteLength,
        signal
      )
    } else {
      await verifyRemoteFile(
        sftp,
        path,
        contents.byteLength,
        sha256(contents),
        uid,
        METADATA_MODE,
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

function isAbortError(error: unknown): boolean {
  return (
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
  )
}

function sha256(contents: Uint8Array): string {
  return createHash('sha256').update(contents).digest('hex')
}

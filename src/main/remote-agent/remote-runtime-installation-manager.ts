import type { AgentArchitecture } from '../../shared/agent-installation-contracts'
import type { AgentBootstrapIncompatibleReason } from '../../shared/ssh-host-contracts'
import {
  parseRuntimeRegistryState
} from '../../shared/remote-environment-registry-contracts'
import {
  remoteRuntimeBundleManifestSchema
} from '../../shared/remote-runtime-launch-contracts'
import type { StagedSftp } from '../ssh/bounded-sftp'
import type { VerifiedAgentInstallationId } from '../ssh/ssh-agent-command'
import type {
  SshConnectionLease,
  SshConnectionPool,
  SshConnectionPoolTarget
} from '../ssh/ssh-connection-pool'
import { HostActivationCoordinator } from './host-activation-coordinator'
import { boundedDiagnostic } from './bounded-diagnostic'
import { isMissingPathError } from './path-errors'
import { remoteHostTargetIdentityKey } from './remote-host-target-identity'

const MAXIMUM_METADATA_BYTES = 1024 * 1024
const RUNTIME_REGISTRY_PATH =
  '.goodbuddy/runtimes/registry.json'
const OPENCODE_ROOT = '.goodbuddy/runtimes/opencode'

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

export type RemoteRuntimeActivator = (
  lease: SshConnectionLease,
  runtimeId: string,
  bundleDigest: string,
  architecture: AgentArchitecture,
  agentInstallationId: VerifiedAgentInstallationId | undefined,
  signal: AbortSignal
) => Promise<void>

export class RemoteRuntimeInstallationManager {
  readonly #resolver: RemoteRuntimeInstallationTargetResolver
  readonly #sshPool: Pick<SshConnectionPool, 'acquire'>
  readonly #activate: RemoteRuntimeActivator
  readonly #coordinator: HostActivationCoordinator<
    RemoteRuntimeInstallationIdentity,
    RemoteRuntimeInstallationPhase
  >

  constructor(options: {
    resolver: RemoteRuntimeInstallationTargetResolver
    sshPool: Pick<SshConnectionPool, 'acquire'>
    activate: RemoteRuntimeActivator
    maximumConcurrentHosts?: number
  }) {
    this.#resolver = options.resolver
    this.#sshPool = options.sshPool
    this.#activate = options.activate
    this.#coordinator = new HostActivationCoordinator({
      maximumConcurrentHosts:
        options.maximumConcurrentHosts,
      capacityError: () =>
        new RemoteRuntimeInstallationError(
          'Too many Runtime activations are already running',
          'capacity'
        ),
      disposeMessage:
        'Remote Runtime activation manager is disposed'
    })
  }

  /**
   * Loads the current Runtime registry entry and delegates bounded manifest
   * and entrypoint checks to the Agent. Main never traverses Runtime payloads.
   */
  async activateInstalled(
    hostId: string,
    options: RemoteRuntimeActivationRequestOptions = {}
  ): Promise<RemoteRuntimeInstallationIdentity> {
    this.#coordinator.assertAvailable()
    options.signal?.throwIfAborted()
    emitOne(options.onProgress, 'inspecting-host')
    const agentKey = options.agentInstallationId ?? ''
    const earlyCached =
      this.#coordinator.cachedForHost(hostId, agentKey)
    if (earlyCached !== undefined) {
      emitOne(options.onProgress, 'complete')
      return earlyCached
    }
    const target = await this.#resolver.resolve(hostId)
    this.#coordinator.assertAvailable()
    options.signal?.throwIfAborted()
    if (target.host.id !== hostId) {
      throw new RemoteRuntimeInstallationError(
        'Resolved SSH host does not match the Runtime activation request',
        'host-identity-changed'
      )
    }

    const targetKey = remoteHostTargetIdentityKey(target)
    const cached = this.#coordinator.cached(
      hostId,
      targetKey,
      agentKey
    )
    if (cached !== undefined) {
      emitOne(options.onProgress, 'complete')
      return cached
    }
    return this.#coordinator.run({
      hostId,
      targetKey,
      variantKey: agentKey,
      signal: options.signal,
      onProgress: options.onProgress,
      operation: (signal, progress) =>
        this.#activateRegistered(
          target,
          options.agentInstallationId,
          signal,
          progress
        )
    })
  }

  invalidateHost(hostId: string): void {
    this.#coordinator.invalidate(hostId)
  }

  dispose(): Promise<void> {
    return this.#coordinator.dispose()
  }

  async #activateRegistered(
    target: SshConnectionPoolTarget,
    agentInstallationId: VerifiedAgentInstallationId | undefined,
    signal: AbortSignal,
    progress: (phase: RemoteRuntimeInstallationPhase) => void
  ): Promise<RemoteRuntimeInstallationIdentity> {
    let lease: SshConnectionLease | undefined
    let sftp: StagedSftp | undefined
    try {
      lease = await this.#sshPool.acquire(target, signal)
      assertLeaseMatchesTarget(lease, target)
      const probe = await lease.runAgentBootstrapProbe(signal)
      if (!probe.ready) {
        throw new RemoteRuntimeInstallationError(
          `Remote host cannot activate OpenCode Runtime: ${probe.reason}`,
          'incompatible',
          probe.reason
        )
      }
      if (
        probe.platform !== 'linux' ||
        (
          probe.architecture !== 'x64' &&
          probe.architecture !== 'arm64'
        )
      ) {
        throw new RemoteRuntimeInstallationError(
          'Remote host platform or architecture is unsupported',
          'incompatible'
        )
      }

      progress('verifying-bundle')
      sftp = await lease.openStagedSftp(
        probe.canonicalHomeDirectory,
        {
          maximumFileBytes: MAXIMUM_METADATA_BYTES,
          maximumTotalBytes: MAXIMUM_METADATA_BYTES * 3,
          maximumOperations: 12,
          operationTimeoutMs: 15_000
        },
        signal
      )
      const registry = parseRuntimeRegistryState(
        parseJsonBytes(
          await sftp.readFile(
            RUNTIME_REGISTRY_PATH,
            signal
          ),
          'Installed Runtime registry'
        )
      )
      const current = registry.current.find(
        (entry) =>
          entry.runtimeId === 'opencode' &&
          entry.architecture === probe.architecture
      )
      if (current === undefined) {
        throw new RemoteRuntimeInstallationError(
          'The Host has no current OpenCode Runtime for this architecture',
          'incompatible'
        )
      }

      let runtimeAdapterDigest =
        current.runtimeAdapterDigest
      if (runtimeAdapterDigest === undefined) {
        const manifestPath =
          `${OPENCODE_ROOT}/${digestDirectoryName(
            current.bundleDigest
          )}/manifest.json`
        const manifest =
          remoteRuntimeBundleManifestSchema.parse(
            parseJsonBytes(
              await sftp.readFile(manifestPath, signal),
              'Installed Runtime manifest'
            )
          )
        if (
          manifest.runtimeId !== current.runtimeId ||
          manifest.runtimeVersion !==
            current.runtimeVersion ||
          manifest.bundleDigest !== current.bundleDigest
        ) {
          throw new Error(
            'Installed Runtime manifest identity does not match its registry'
          )
        }
        runtimeAdapterDigest = manifest.adapterDigest
      }
      sftp.close()
      sftp = undefined

      progress('activating-runtime')
      await this.#activate(
        lease,
        current.runtimeId,
        current.bundleDigest,
        current.architecture,
        agentInstallationId,
        signal
      )
      progress('complete')
      return {
        runtimeId: current.runtimeId,
        runtimeVersion: current.runtimeVersion,
        bundleDigest: current.bundleDigest,
        manifestDigest: current.manifestDigest,
        runtimeAdapterDigest,
        acpCapabilitiesDigest:
          current.acpCapabilitiesDigest,
        platform: 'linux',
        architecture: current.architecture
      }
    } catch (error) {
      if (error instanceof RemoteRuntimeInstallationError) {
        throw error
      }
      if (isMissingPathError(error)) {
        throw new RemoteRuntimeInstallationError(
          'The Host has no current OpenCode Runtime',
          'incompatible',
          error
        )
      }
      throw new RemoteRuntimeInstallationError(
        `The registered Host OpenCode Runtime could not be activated: ${safeErrorDetail(error)}`,
        'corrupt',
        error
      )
    } finally {
      sftp?.close()
      lease?.release()
    }
  }

}

function digestDirectoryName(bundleDigest: string): string {
  if (!/^sha256:[a-f0-9]{64}$/u.test(bundleDigest)) {
    throw new Error('Runtime bundle digest is invalid')
  }
  return bundleDigest.slice('sha256:'.length)
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
      'SSH lease identity changed during Runtime activation',
      'host-identity-changed'
    )
  }
}

function safeErrorDetail(error: unknown): string {
  const value = error instanceof Error
    ? error.message
    : String(error)
  return boundedDiagnostic(value)
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
    // Progress observers cannot alter activation state.
  }
}

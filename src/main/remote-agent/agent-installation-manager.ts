import type { AgentArchitecture } from '../../shared/agent-installation-contracts'
import type { AgentBootstrapIncompatibleReason } from '../../shared/ssh-host-contracts'
import {
  parseInstallationRegistryState
} from '../../shared/remote-environment-registry-contracts'
import type {
  StagedSftp
} from '../ssh/bounded-sftp'
import {
  verifyAgentInstallationId,
  type VerifiedAgentInstallationId
} from '../ssh/ssh-agent-command'
import type {
  AgentDiagnosticResult,
  SshConnectionLease,
  SshConnectionPool,
  SshConnectionPoolTarget
} from '../ssh/ssh-connection-pool'
import type { BundledAgentResourcePaths } from './bundled-agent-resources'
import {
  readAgentRuntimeLock
} from './agent-bundle-verifier'
import { boundedDiagnostic } from './bounded-diagnostic'
import { HostActivationCoordinator } from './host-activation-coordinator'
import { isMissingPathError } from './path-errors'
import { remoteHostTargetIdentityKey } from './remote-host-target-identity'

const MAXIMUM_METADATA_BYTES = 1024 * 1024
const AGENT_REGISTRY_PATH = '.goodbuddy/agent/registry.json'
const MAXIMUM_DIAGNOSTIC_CHARACTERS = 800

export type AgentInstallationPhase =
  | 'inspecting-host'
  | 'verifying-bundle'
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

export class AgentInstallationManager {
  readonly #resolver: AgentInstallationTargetResolver
  readonly #sshPool: Pick<SshConnectionPool, 'acquire'>
  readonly #resourcePaths: BundledAgentResourcePaths
  readonly #coordinator: HostActivationCoordinator<
    AgentInstallationIdentity,
    AgentInstallationPhase
  >

  constructor(options: {
    resolver: AgentInstallationTargetResolver
    sshPool: Pick<SshConnectionPool, 'acquire'>
    resourcePaths: BundledAgentResourcePaths
    maximumConcurrentHosts?: number
  }) {
    this.#resolver = options.resolver
    this.#sshPool = options.sshPool
    this.#resourcePaths = options.resourcePaths
    this.#coordinator = new HostActivationCoordinator({
      maximumConcurrentHosts:
        options.maximumConcurrentHosts,
      capacityError: () =>
        new AgentInstallationError(
          'Too many Agent activations are already running',
          'capacity'
        ),
      disposeMessage:
        'Agent installation manager is disposed'
    })
  }

  /**
   * Loads the current registered Agent identity and asks the Host Agent to
   * prove process health. Payload verification stays on the Host and is only
   * repeated when an unregistered installation is bootstrapped.
   */
  async activateInstalled(
    hostId: string,
    options: AgentActivationRequestOptions = {}
  ): Promise<AgentInstallationIdentity> {
    this.#coordinator.assertAvailable()
    options.signal?.throwIfAborted()
    emitProgress(options.onProgress, 'inspecting-host')
    const earlyCached =
      this.#coordinator.cachedForHost(hostId, '')
    if (earlyCached !== undefined) {
      emitProgress(options.onProgress, 'complete')
      return earlyCached
    }
    const target = await this.#resolver.resolve(hostId)
    this.#coordinator.assertAvailable()
    options.signal?.throwIfAborted()
    if (target.host.id !== hostId) {
      throw new Error(
        'Resolved SSH host does not match the request'
      )
    }
    const targetKey = remoteHostTargetIdentityKey(target)
    const cached = this.#coordinator.cached(
      hostId,
      targetKey,
      ''
    )
    if (cached !== undefined) {
      emitProgress(options.onProgress, 'complete')
      return cached
    }
    return this.#coordinator.run({
      hostId,
      targetKey,
      variantKey: '',
      signal: options.signal,
      onProgress: options.onProgress,
      operation: (signal, progress) =>
        this.#activate(target, signal, progress)
    })
  }

  invalidateHost(hostId: string): void {
    this.#coordinator.invalidate(hostId)
  }

  dispose(): Promise<void> {
    return this.#coordinator.dispose()
  }

  async #activate(
    target: SshConnectionPoolTarget,
    signal: AbortSignal,
    progress: (phase: AgentInstallationPhase) => void
  ): Promise<AgentInstallationIdentity> {
    let lease: SshConnectionLease | undefined
    let sftp: StagedSftp | undefined
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
      const runtimeLock = await readAgentRuntimeLock(
        this.#resourcePaths.runtimeLockPath
      )
      sftp = await lease.openStagedSftp(
        probe.canonicalHomeDirectory,
        {
          maximumFileBytes: MAXIMUM_METADATA_BYTES,
          maximumTotalBytes: MAXIMUM_METADATA_BYTES * 2,
          maximumOperations: 8,
          operationTimeoutMs: 15_000
        },
        signal
      )
      const registry = parseInstallationRegistryState(
        parseJsonBytes(
          await sftp.readFile(AGENT_REGISTRY_PATH, signal),
          'Installed Agent registry'
        )
      )
      const registered = registry.current
      const registeredProtocol =
        registered?.protocol
      if (
        registered === undefined ||
        (
          registeredProtocol === undefined
            ? registered.agentVersion !==
              runtimeLock.agentVersion
            : registeredProtocol.major !==
                runtimeLock.protocol.major ||
              registeredProtocol.minor >
                runtimeLock.protocol.minor
        ) ||
        registered.arch !== probe.architecture ||
        registered.installationId !==
          `agent-${registered.manifestSha256}`
      ) {
        throw new AgentInstallationError(
          'The Host has no compatible current GoodBuddy Agent',
          'incompatible'
        )
      }
      const installationId = verifyAgentInstallationId(
        registered.installationId
      )
      sftp.close()
      sftp = undefined
      progress('checking-health')
      await ensureCurrentAgentHealthy(
        lease,
        installationId,
        signal
      )
      progress('complete')
      return {
        installationId,
        binaryDigest: `sha256:${registered.manifestSha256}`,
        agentVersion: registered.agentVersion,
        protocol: {
          ...(registeredProtocol ?? runtimeLock.protocol)
        },
        platform: 'linux',
        architecture: registered.arch,
        supervisor: 'detached-on-demand'
      }
    } catch (error) {
      if (error instanceof AgentInstallationError) {
        throw error
      }
      if (isMissingPathError(error)) {
        throw new AgentInstallationError(
          'The Host has no compatible current GoodBuddy Agent',
          'incompatible',
          error
        )
      }
      throw new AgentInstallationError(
        'The registered Host Agent could not be activated',
        'corrupt',
        error
      )
    } finally {
      sftp?.close()
      lease?.release()
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
    throw new AgentInstallationError(
      'SSH lease identity changed during Agent activation',
      'host-identity-changed'
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
  const bootstrap = await lease.runAgentLifecycleAction(
    installationId,
    'bootstrap',
    signal
  )
  if (bootstrap.exitCode !== 0) {
    throw new AgentInstallationError(
      diagnosticMessage(
        bootstrap,
        'GoodBuddy Agent bootstrap failed'
      ),
      'lifecycle'
    )
  }
}

function diagnosticMessage(
  result: AgentDiagnosticResult,
  fallback: string
): string {
  const detail = `${result.stderr}\n${result.stdout}`
  const bounded = boundedDiagnostic(
    detail,
    MAXIMUM_DIAGNOSTIC_CHARACTERS
  )
  return bounded.length > 0
    ? `${fallback}: ${bounded}`
    : `${fallback} (exit ${String(result.exitCode)})`
}

function emitProgress(
  callback:
    | ((phase: AgentInstallationPhase) => void)
    | undefined,
  phase: AgentInstallationPhase
): void {
  try {
    callback?.(phase)
  } catch {
    // Progress observers cannot alter activation state.
  }
}

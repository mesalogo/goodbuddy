import { randomUUID } from 'node:crypto'
import { dirname } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import type {
  RemoteEnvironmentPreparationMethod,
  RemoteEnvironmentUpdateProgress
} from '../../shared/ssh-host-contracts'
import { verifyAgentInstallationId } from '../ssh/ssh-agent-command'
import type {
  AgentDiagnosticResult,
  SshConnectionLease,
  SshConnectionPool,
  SshRemotePackageBootstrapLease
} from '../ssh/ssh-connection-pool'
import type { SshConnectionTarget } from '../ssh/ssh-host-store'
import {
  assertSshLeaseMatchesTarget,
  assertValidSshConnectionTarget
} from '../ssh/ssh-connection-target'
import {
  SshRemotePackageCommitIndeterminateError,
  type SshRemotePackageBootstrapPrepareResult,
  type SshRemotePackageBootstrapProgress,
  type SshRemotePackageCandidate,
  type SshRemotePackageIdentity
} from '../ssh/ssh-remote-package-bootstrap'
import type {
  AgentInstallationTargetResolver
} from './agent-installation-manager'
import type {
  AgentPackageArchiveLease,
  AgentPackageManager,
  VerifiedRemoteAgentInstallCandidate
} from './agent-package-manager'
import type {
  PendingRemoteEnvironmentOperation,
  RemoteEnvironmentOperationStore
} from './remote-environment-operation-store'
import type {
  RemoteEnvironmentPreparer as Preparer,
  RemoteEnvironmentUpdateProgressObserver
} from './remote-environment-update-service'
import {
  remoteHostRecoveryIdentityKey
} from './remote-host-target-identity'
import { boundedDiagnostic } from './bounded-diagnostic'

const MAXIMUM_PACKAGE_BYTES = 512 * 1024 * 1024
const MAXIMUM_DIAGNOSTIC_CHARACTERS = 800

function assertAgentCommandSucceeded(
  result: AgentDiagnosticResult,
  label: string
): void {
  if (result.exitCode === 0) {
    return
  }
  const detail = `${result.stderr}\n${result.stdout}`
  const bounded = boundedDiagnostic(
    detail,
    MAXIMUM_DIAGNOSTIC_CHARACTERS
  )
  throw new Error(
    bounded.length > 0
      ? `${label}失败：${bounded}`
      : `${label}失败，退出码 ${String(result.exitCode)}`
  )
}

export type RemoteEnvironmentPreparerOptions = {
  resolver: AgentInstallationTargetResolver
  sshPool: Pick<
    SshConnectionPool,
    'acquire' | 'acquireRemotePackageBootstrap'
  >
  agentPackageManager: Pick<
    AgentPackageManager,
    | 'getRemoteInstallCandidate'
    | 'acquireInstallArchive'
    | 'acquireGoodBuddyInstallArchive'
  >
  operationStore: Pick<
    RemoteEnvironmentOperationStore,
    'load' | 'save' | 'remove'
  >
}

/**
 * Prepares one signed compound environment. The selected method controls only
 * how the archive reaches the Host; both paths share prepare, commit,
 * activation, health checks, and cleanup.
 */
export class RemoteEnvironmentPreparer implements Preparer {
  readonly #resolver: AgentInstallationTargetResolver
  readonly #sshPool: RemoteEnvironmentPreparerOptions['sshPool']
  readonly #agentPackageManager:
    RemoteEnvironmentPreparerOptions['agentPackageManager']
  readonly #operationStore:
    RemoteEnvironmentPreparerOptions['operationStore']

  constructor(options: RemoteEnvironmentPreparerOptions) {
    this.#resolver = options.resolver
    this.#sshPool = options.sshPool
    this.#agentPackageManager = options.agentPackageManager
    this.#operationStore = options.operationStore
  }

  async prepare(
    hostId: string,
    requestedMethod: RemoteEnvironmentPreparationMethod,
    observer: RemoteEnvironmentUpdateProgressObserver | undefined,
    signal: AbortSignal
  ): Promise<void> {
    const emit = (
      method: RemoteEnvironmentPreparationMethod,
      phase: RemoteEnvironmentUpdateProgress['phase']
    ): void => {
      try {
        observer?.({ hostId, method, phase })
      } catch {
        // Progress observers cannot alter installation state.
      }
    }

    signal.throwIfAborted()
    emit(requestedMethod, 'probing')
    const target = await this.#resolver.resolve(hostId)
    signal.throwIfAborted()
    assertValidSshConnectionTarget(hostId, target)
    await this.#cleanupPendingOperation(
      hostId,
      target,
      emit,
      signal
    )

    let probeLease: SshConnectionLease | undefined
    let bootstrapLease:
      | SshRemotePackageBootstrapLease
      | undefined
    let archiveLease: AgentPackageArchiveLease | undefined
    let operationId: string | undefined
    let operationCleaned = false
    let pendingOperationSaved = false
    try {
      probeLease = await this.#sshPool.acquire(target, signal)
      assertLeaseMatchesTarget(probeLease, target)
      const probe = await probeLease.runAgentBootstrapProbe(signal)
      signal.throwIfAborted()
      assertLeaseMatchesTarget(probeLease, target)
      if (!probe.ready) {
        throw new Error(
          `远端系统不能运行 GoodBuddy Agent：${probe.reason}`
        )
      }

      let candidate: VerifiedRemoteAgentInstallCandidate
      let method:
        | 'remote-download'
        | 'goodbuddy-transfer'
        | undefined
      if (requestedMethod === 'goodbuddy-transfer') {
        archiveLease =
          await this.#acquireGoodBuddyArchive(
            probe.architecture,
            emit,
            signal
          )
        candidate = archiveLease.candidate
        method = 'goodbuddy-transfer'
      } else {
        try {
          candidate =
            await this.#agentPackageManager.getRemoteInstallCandidate(
              probe.architecture,
              { signal }
            )
        } catch (error) {
          if (requestedMethod === 'remote-download') {
            throw error
          }
          archiveLease =
            await this.#acquireGoodBuddyArchive(
              probe.architecture,
              emit,
              signal
            )
          candidate = archiveLease.candidate
          method = 'goodbuddy-transfer'
        }
      }
      signal.throwIfAborted()
      assertCandidate(candidate, probe.architecture)
      await assertTargetCurrent(this.#resolver, target, signal)

      operationId = randomUUID()
      const remoteCandidate: SshRemotePackageCandidate = {
        operationId,
        urls: candidate.urls,
        size: candidate.size,
        sha256: candidate.sha256
      }
      bootstrapLease =
        await this.#sshPool.acquireRemotePackageBootstrap(
          target,
          signal
        )
      assertLeaseMatchesTarget(bootstrapLease, target)
      assertSameLeaseIdentity(probeLease, bootstrapLease)

      if (!method) {
        method = await resolvePreparationMethod(
          requestedMethod,
          bootstrapLease,
          remoteCandidate,
          signal
        )
      }
      if (
        method === 'goodbuddy-transfer' &&
        !archiveLease
      ) {
        archiveLease =
          await this.#agentPackageManager.acquireInstallArchive(
            candidate.architecture,
            candidate,
            {
              signal,
              onProgress: (progress) => {
                emit(
                  method!,
                  progress.phase === 'downloading'
                    ? 'downloading'
                    : progress.phase === 'catalog'
                      ? 'probing'
                      : 'verifying'
                )
              }
            }
          )
      }
      emit(method, 'probing')

      // Keep only the operation ID needed to clean stale staging before the
      // next fresh attempt. No remote environment state is copied locally.
      await this.#operationStore.save({
        version: 1,
        hostId,
        targetIdentity: remoteHostRecoveryIdentityKey(target),
        operationId
      })
      pendingOperationSaved = true

      const prepared =
        method === 'remote-download'
          ? await bootstrapLease.prepare(remoteCandidate, {
              signal,
              onProgress: (progress) => {
                emit(method, mapBootstrapPhase(progress))
              }
            })
          : await this.#prepareUploadedArchive({
              probeLease,
              bootstrapLease,
              archive: archiveLease!,
              remoteCandidate,
              method,
              emit,
              signal
            })
      assertPrepared(prepared, operationId)
      assertPackageIdentity(prepared.identity, candidate)

      // Keep the full target re-resolution immediately adjacent to commit.
      await assertTargetCurrent(this.#resolver, target, signal)
      assertLeaseMatchesTarget(bootstrapLease, target)
      signal.throwIfAborted()

      const committed = await bootstrapLease.commit(
        remoteCandidate,
        {
          signal,
          onProgress: (progress) => {
            emit(method, mapBootstrapPhase(progress))
          }
        }
      )
      if (!committed.committed) {
        if (
          committed.reason ===
          'installer-rollback-incomplete'
        ) {
          throw new SshRemotePackageCommitIndeterminateError(
            '远端环境发布失败且回滚结果不完整，请重新检查 Host 状态'
          )
        }
        throw new Error(
          `远端安装提交失败：${committed.detail ?? committed.reason}`
        )
      }
      if (
        committed.operationId !== operationId ||
        !isDeepStrictEqual(
          committed.identity,
          prepared.identity
        )
      ) {
        throw new Error('远端安装提交身份与准备身份不匹配')
      }
      assertPackageIdentity(committed.identity, candidate)
      signal.throwIfAborted()

      await this.#adoptCommittedEnvironment(
        probeLease,
        committed.identity,
        method,
        emit,
        signal
      )

      emit(method, 'finalizing')
      try {
        const cleanup = await bootstrapLease.cleanup(
          operationId,
          { signal }
        )
        if (
          cleanup.cleaned ||
          cleanup.reason === 'operation-unavailable'
        ) {
          operationCleaned = true
          try {
            await this.#operationStore.remove(hostId)
          } catch {
            // A stale local receipt is harmless after remote cleanup.
          }
        }
      } catch {
        // The environment is already healthy. The next update will retry
        // cleanup before starting a fresh operation.
      }
    } catch (error) {
      if (
        operationId &&
        bootstrapLease &&
        !operationCleaned &&
        !(error instanceof SshRemotePackageCommitIndeterminateError)
      ) {
        operationCleaned = await cleanupBestEffort(
          bootstrapLease,
          operationId
        )
        if (operationCleaned && pendingOperationSaved) {
          await this.#operationStore.remove(hostId).catch(() => undefined)
        }
      }
      throw error
    } finally {
      archiveLease?.release()
      bootstrapLease?.release()
      probeLease?.release()
    }
  }

  async #adoptCommittedEnvironment(
    lease: SshConnectionLease,
    identity: SshRemotePackageIdentity,
    method: RemoteEnvironmentPreparationMethod,
    emit: (
      method: RemoteEnvironmentPreparationMethod,
      phase: RemoteEnvironmentUpdateProgress['phase']
    ) => void,
    signal: AbortSignal
  ): Promise<void> {
    const installationId = verifyAgentInstallationId(
      identity.agent.installationId
    )
    emit(method, 'installing-agent')
    assertAgentCommandSucceeded(
      await lease.runAgentLifecycleAction(
        installationId,
        'adopt',
        signal
      ),
      'GoodBuddy Agent 启动与健康检查'
    )
    signal.throwIfAborted()

    emit(method, 'installing-runtime')
    assertAgentCommandSucceeded(
      await lease.runAgentRuntimeAction(
        installationId,
        {
          kind: 'runtime-activate',
          runtimeId: identity.runtime.runtimeId,
          bundleDigest: identity.runtime.bundleDigest,
          architecture: identity.runtime.architecture,
          forceVerification: true
        },
        signal
      ),
      'OpenCode Runtime 激活'
    )
    signal.throwIfAborted()
  }

  async #prepareUploadedArchive(options: {
    probeLease: SshConnectionLease
    bootstrapLease: SshRemotePackageBootstrapLease
    archive: AgentPackageArchiveLease
    remoteCandidate: SshRemotePackageCandidate
    method: 'goodbuddy-transfer'
    emit: (
      method: RemoteEnvironmentPreparationMethod,
      phase: RemoteEnvironmentUpdateProgress['phase']
    ) => void
    signal: AbortSignal
  }): Promise<SshRemotePackageBootstrapPrepareResult> {
    const {
      probeLease,
      bootstrapLease,
      archive,
      remoteCandidate,
      method,
      emit,
      signal
    } = options
    signal.throwIfAborted()

    const staging = await bootstrapLease.createUploadStaging(
      remoteCandidate,
      { signal }
    )
    if (!staging.created) {
      throw new Error(
        staging.unavailable
          ? `GoodBuddy 传输暂存不可用：${staging.reason}`
          : `GoodBuddy 传输暂存失败：${staging.reason}`
      )
    }
    if (staging.operationId !== remoteCandidate.operationId) {
      throw new Error('GoodBuddy 传输暂存操作身份不匹配')
    }
    const operationRoot = dirname(staging.archivePath)
    if (
      staging.archivePath !==
        `${operationRoot}/package.gbagent` ||
      staging.bootstrapNodePath !==
        `${operationRoot}/bootstrap/agent/node`
    ) {
      throw new Error('GoodBuddy 传输暂存路径无效')
    }

    const sftp = await probeLease.openStagedSftp(
      operationRoot,
      {
        maximumFileBytes: MAXIMUM_PACKAGE_BYTES,
        maximumTotalBytes:
          archive.size + archive.nodeSize,
        maximumOperations: 16
      },
      signal
    )
    try {
      emit(method, 'downloading')
      await sftp.uploadFile(
        'package.gbagent',
        archive.path,
        {
          size: archive.size,
          sha256: archive.sha256
        },
        signal
      )
      await sftp.uploadFile(
        'bootstrap/agent/node',
        archive.nodePath,
        {
          size: archive.nodeSize,
          sha256: archive.nodeSha256
        },
        signal
      )
      await sftp.setExecutable(
        'bootstrap/agent/node',
        signal
      )
    } finally {
      sftp.close()
    }

    return bootstrapLease.prepareUploaded(remoteCandidate, {
      signal,
      onProgress: (progress) => {
        emit(method, mapBootstrapPhase(progress))
      }
    })
  }

  #acquireGoodBuddyArchive(
    architecture: 'x64' | 'arm64',
    emit: (
      method: RemoteEnvironmentPreparationMethod,
      phase: RemoteEnvironmentUpdateProgress['phase']
    ) => void,
    signal: AbortSignal
  ): Promise<AgentPackageArchiveLease> {
    return this.#agentPackageManager.acquireGoodBuddyInstallArchive(
      architecture,
      {
        signal,
        onProgress: (progress) => {
          emit(
            'goodbuddy-transfer',
            progress.phase === 'downloading'
              ? 'downloading'
              : progress.phase === 'catalog'
                ? 'probing'
                : 'verifying'
          )
        }
      }
    )
  }

  async #cleanupPendingOperation(
    hostId: string,
    target: SshConnectionTarget,
    emit: (
      method: RemoteEnvironmentPreparationMethod,
      phase: RemoteEnvironmentUpdateProgress['phase']
    ) => void,
    signal: AbortSignal
  ): Promise<void> {
    let pending: PendingRemoteEnvironmentOperation | undefined
    try {
      pending = await this.#operationStore.load(hostId)
    } catch {
      await this.#operationStore.remove(hostId)
      return
    }
    if (!pending) {
      return
    }
    if (
      pending.targetIdentity !==
      remoteHostRecoveryIdentityKey(target)
    ) {
      await this.#operationStore.remove(hostId)
      return
    }
    emit('auto', 'applying')
    const bootstrapLease =
      await this.#sshPool.acquireRemotePackageBootstrap(
        target,
        signal
      ).catch(() => undefined)
    try {
      if (!bootstrapLease) {
        return
      }
      assertLeaseMatchesTarget(bootstrapLease, target)
      await bootstrapLease.cleanup(
        pending.operationId,
        { signal }
      ).catch(() => undefined)
    } finally {
      bootstrapLease?.release()
      await this.#operationStore.remove(hostId)
    }
  }
}

async function resolvePreparationMethod(
  requested: RemoteEnvironmentPreparationMethod,
  lease: SshRemotePackageBootstrapLease,
  candidate: SshRemotePackageCandidate,
  signal: AbortSignal
): Promise<'remote-download' | 'goodbuddy-transfer'> {
  if (requested !== 'auto') {
    return requested
  }
  const availability = await lease.probe(candidate, { signal })
  return availability.available
    ? 'remote-download'
    : 'goodbuddy-transfer'
}

function assertPrepared(
  prepared: SshRemotePackageBootstrapPrepareResult,
  operationId: string
): asserts prepared is Extract<
  SshRemotePackageBootstrapPrepareResult,
  { prepared: true }
> {
  if (!prepared.prepared) {
    throw new Error(
      prepared.unavailable
        ? `远端环境准备不可用：${prepared.reason}`
        : `远端环境准备失败：${prepared.detail ?? prepared.reason}`
    )
  }
  if (prepared.operationId !== operationId) {
    throw new Error('远端环境准备操作身份不匹配')
  }
}

async function cleanupBestEffort(
  lease: SshRemotePackageBootstrapLease,
  operationId: string
): Promise<boolean> {
  try {
    const result = await lease.cleanup(operationId)
    return (
      result.cleaned ||
      result.reason === 'operation-unavailable'
    )
  } catch {
    // Preserve the original deterministic preparation failure.
    return false
  }
}

async function assertTargetCurrent(
  resolver: AgentInstallationTargetResolver,
  expected: SshConnectionTarget,
  signal: AbortSignal
): Promise<void> {
  signal.throwIfAborted()
  const current = await resolver.resolve(expected.host.id)
  signal.throwIfAborted()
  assertValidSshConnectionTarget(expected.host.id, current)
  if (!isDeepStrictEqual(current, expected)) {
    throw new Error(
      'SSH 主机身份在远端环境安装期间发生变化'
    )
  }
}

function assertLeaseMatchesTarget(
  lease: Pick<SshConnectionLease, 'identity'>,
  target: SshConnectionTarget
): void {
  assertSshLeaseMatchesTarget(
    lease,
    target,
    'SSH 远端安装连接身份不匹配'
  )
  if (
    !/^[a-f0-9]{64}$/u.test(
      lease.identity.authenticationIdentity
    )
  ) {
    throw new Error('SSH 远端安装连接身份不匹配')
  }
}

function assertSameLeaseIdentity(
  probeLease: Pick<SshConnectionLease, 'identity'>,
  bootstrapLease: Pick<
    SshRemotePackageBootstrapLease,
    'identity'
  >
): void {
  if (
    !isDeepStrictEqual(
      probeLease.identity,
      bootstrapLease.identity
    )
  ) {
    throw new Error('SSH 远端安装认证身份发生变化')
  }
}

function assertCandidate(
  candidate: VerifiedRemoteAgentInstallCandidate,
  architecture: 'x64' | 'arm64'
): void {
  if (
    candidate.platform !== 'linux' ||
    candidate.architecture !== architecture
  ) {
    throw new Error('签名 Agent 安装候选与 Host 架构不匹配')
  }
}

function assertPackageIdentity(
  identity: SshRemotePackageIdentity,
  candidate: VerifiedRemoteAgentInstallCandidate
): void {
  if (
    identity.archiveSha256 !== candidate.sha256 ||
    identity.agent.agentVersion !== candidate.version ||
    identity.agent.platform !== candidate.platform ||
    identity.agent.architecture !== candidate.architecture ||
    !isDeepStrictEqual(
      identity.agent.protocol,
      candidate.agentProtocol
    ) ||
    identity.runtime.runtimeId !==
      candidate.remoteRuntime.runtimeId ||
    identity.runtime.runtimeVersion !==
      candidate.remoteRuntime.version ||
    identity.runtime.bundleDigest !==
      candidate.remoteRuntime.bundleDigest ||
    identity.runtime.platform !== candidate.platform ||
    identity.runtime.architecture !==
      candidate.architecture ||
    !isDeepStrictEqual(
      identity.runtime.protocol,
      candidate.remoteRuntime.protocol
    )
  ) {
    throw new Error('远端准备的安装身份与签名候选不匹配')
  }
}

function mapBootstrapPhase(
  progress: SshRemotePackageBootstrapProgress
): RemoteEnvironmentUpdateProgress['phase'] {
  switch (progress.phase) {
    case 'checking':
      return 'probing'
    case 'downloading':
      return 'downloading'
    case 'verifying':
    case 'validating':
    case 'hashing-archive':
    case 'verifying-zip':
    case 'verifying-payload':
    case 'validating-prepared-state':
      return 'verifying'
    case 'extracting':
    case 'preparing':
    case 'prepared':
    case 'committing':
    case 'committed':
    case 'persisting-prepared-state':
    case 'extracting-payload':
    case 'publishing-content':
    case 'publishing-metadata':
    case 'cleaning':
      return 'applying'
  }
}

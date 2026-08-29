import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import {
  agentRuntimeLockSchema,
  type AgentRuntimeLock
} from '../../shared/agent-installation-contracts'
import {
  remoteRuntimeLockSchema,
  type RemoteRuntimeLock
} from '../../shared/remote-runtime-launch-contracts'
import {
  sshHostRemoteEnvironmentSchema,
  type SshHostRemoteEnvironment
} from '../../shared/ssh-host-contracts'
import {
  parseInstallationRegistryState,
  parseRuntimeRegistryState,
  type InstallationRegistryEntry,
  type RuntimeRegistryEntry
} from '../../shared/remote-environment-registry-contracts'
import type { StagedSftp } from './bounded-sftp'
import type {
  CurrentSshConnectionTarget,
  SshConnectionTarget,
  SshHostStore
} from './ssh-host-store'
import {
  assertSshLeaseMatchesTarget,
  assertValidSshConnectionTarget,
  toCurrentSshConnectionTarget
} from './ssh-connection-target'
import type {
  SshConnectionLease,
  SshRemotePackageBootstrapLease,
  SshConnectionPool
} from './ssh-connection-pool'
import type {
  SshRemotePackageBootstrapUnavailableReason
} from './ssh-remote-package-bootstrap'

const AGENT_REGISTRY_PATH = '.goodbuddy/agent/registry.json'
const RUNTIME_REGISTRY_PATH = '.goodbuddy/runtimes/registry.json'
const MAXIMUM_REGISTRY_BYTES = 256 * 1024

type ExpectedCatalog = {
  agent: {
    version: string
  }
  runtimes: Array<{
    runtimeId: 'opencode'
    provider: 'opencode'
    version: string
  }>
}

type RemoteInstallCandidate = {
  source: 'github' | 'mirror'
  size: number
  sha256: string
  urls: readonly string[]
}

type RemoteEnvironmentCatalog = {
  expected: ExpectedCatalog
  candidate: RemoteInstallCandidate | null
  candidateFailure?: {
    reason: 'package-unavailable' | 'probe-failed'
    source: 'github' | 'mirror' | null
    packageSize: number | null
  }
}

export type SshHostRemoteEnvironmentInspectorOptions = {
  sshHosts: Pick<
    SshHostStore,
    'resolveConnectionTarget' | 'assertConnectionTargetCurrent'
  >
  sshPool: Pick<
    SshConnectionPool,
    'acquire' | 'acquireRemotePackageBootstrap'
  >
  agentRuntimeLockPath: string
  remoteRuntimeLockPath: string
  loadRemoteEnvironmentCatalog?: (
    architecture: 'x64' | 'arm64',
    options: { signal?: AbortSignal }
  ) => Promise<RemoteEnvironmentCatalog>
  now?: () => Date
}

export class SshHostRemoteEnvironmentInspector {
  readonly #sshHosts: SshHostRemoteEnvironmentInspectorOptions['sshHosts']
  readonly #sshPool: SshHostRemoteEnvironmentInspectorOptions['sshPool']
  readonly #loadRemoteEnvironmentCatalog: NonNullable<
    SshHostRemoteEnvironmentInspectorOptions[
      'loadRemoteEnvironmentCatalog'
    ]
  >
  readonly #now: () => Date

  constructor(options: SshHostRemoteEnvironmentInspectorOptions) {
    this.#sshHosts = options.sshHosts
    this.#sshPool = options.sshPool
    this.#loadRemoteEnvironmentCatalog =
      options.loadRemoteEnvironmentCatalog ??
      (async () => ({
        expected: await loadExpectedCatalog(
          options.agentRuntimeLockPath,
          options.remoteRuntimeLockPath
        ),
        candidate: null
      }))
    this.#now = options.now ?? (() => new Date())
  }

  async inspect(
    hostId: string,
    signal?: AbortSignal
  ): Promise<SshHostRemoteEnvironment> {
    signal?.throwIfAborted()
    const target =
      await this.#sshHosts.resolveConnectionTarget(hostId)
    signal?.throwIfAborted()
    assertValidSshConnectionTarget(hostId, target)
    const expectedTarget = toCurrentSshConnectionTarget(target)
    this.#sshHosts.assertConnectionTargetCurrent(expectedTarget)

    let lease: SshConnectionLease | undefined
    let sftp: StagedSftp | undefined
    try {
      lease = await this.#sshPool.acquire(target, signal)
      assertSshLeaseMatchesTarget(
        lease,
        target,
        'SSH 远端运行环境连接身份不匹配'
      )
      const probe = await lease.runAgentBootstrapProbe(signal)
      signal?.throwIfAborted()
      if (!probe.ready) {
        throw new Error(
          `远端系统不能运行 GoodBuddy Agent：${probe.reason}`
        )
      }
      sftp = await lease.openStagedSftp(
        probe.canonicalHomeDirectory,
        {
          maximumFileBytes: MAXIMUM_REGISTRY_BYTES,
          maximumTotalBytes: MAXIMUM_REGISTRY_BYTES * 2,
          maximumOperations: 8,
          operationTimeoutMs: 15_000
        },
        signal
      )
      const [catalog, agentRegistry, runtimeRegistry] =
        await Promise.all([
          this.#loadRemoteEnvironmentCatalog(
            probe.architecture,
            { signal }
          ),
          readOptionalRegistry(
            sftp,
            AGENT_REGISTRY_PATH,
            { parse: parseInstallationRegistryState },
            signal
          ),
          readOptionalRegistry(
            sftp,
            RUNTIME_REGISTRY_PATH,
            { parse: parseRuntimeRegistryState },
            signal
          )
        ])
      signal?.throwIfAborted()
      assertSshLeaseMatchesTarget(
        lease,
        target,
        'SSH 远端运行环境连接身份不匹配'
      )
      this.#sshHosts.assertConnectionTargetCurrent(expectedTarget)
      const remoteDownload = await this.#remoteDownload(
        target,
        expectedTarget,
        catalog.candidate,
        catalog.candidateFailure,
        signal
      )
      signal?.throwIfAborted()
      assertSshLeaseMatchesTarget(
        lease,
        target,
        'SSH 远端运行环境连接身份不匹配'
      )
      this.#sshHosts.assertConnectionTargetCurrent(expectedTarget)
      return sshHostRemoteEnvironmentSchema.parse({
        hostId,
        checkedAt: this.#now().toISOString(),
        architecture: probe.architecture,
        agent: agentStatus(
          catalog.expected.agent,
          agentRegistry?.current,
          probe.architecture
        ),
        runtimes: catalog.expected.runtimes.map((runtime) =>
          runtimeStatus(
            runtime,
            runtimeRegistry?.current.find(
              (installed) =>
                installed.runtimeId === runtime.runtimeId &&
                installed.architecture === probe.architecture
            ),
            probe.architecture
          )
        ),
        remoteDownload
      })
    } finally {
      sftp?.close()
      lease?.release()
    }
  }

  async #remoteDownload(
    target: SshConnectionTarget,
    expectedTarget: CurrentSshConnectionTarget,
    candidate: RemoteInstallCandidate | null,
    candidateFailure:
      | RemoteEnvironmentCatalog['candidateFailure']
      | undefined,
    signal?: AbortSignal
  ): Promise<SshHostRemoteEnvironment['remoteDownload']> {
    if (!candidate) {
      return unavailableRemoteDownload(
        candidateFailure?.reason ?? 'package-unavailable',
        candidateFailure
          ? {
              source: candidateFailure.source,
              packageSize: candidateFailure.packageSize
            }
          : null
      )
    }
    const exposure = {
      source: candidate.source,
      packageSize: candidate.size
    }
    let bootstrapLease:
      | SshRemotePackageBootstrapLease
      | undefined
    try {
      this.#sshHosts.assertConnectionTargetCurrent(expectedTarget)
      bootstrapLease =
        await this.#sshPool.acquireRemotePackageBootstrap(
          target,
          signal
        )
      assertSshLeaseMatchesTarget(
        bootstrapLease,
        target,
        'SSH 远端运行环境连接身份不匹配'
      )
      const result = await bootstrapLease.probe(
        {
          operationId: randomUUID(),
          urls: candidate.urls,
          size: candidate.size,
          sha256: candidate.sha256
        },
        { signal }
      )
      signal?.throwIfAborted()
      assertSshLeaseMatchesTarget(
        bootstrapLease,
        target,
        'SSH 远端运行环境连接身份不匹配'
      )
      this.#sshHosts.assertConnectionTargetCurrent(expectedTarget)
      return result.available
        ? {
            available: true,
            ...exposure
          }
        : unavailableRemoteDownload(
            mapRemoteUnavailableReason(result.reason),
            exposure
          )
    } catch {
      signal?.throwIfAborted()
      if (bootstrapLease) {
        assertSshLeaseMatchesTarget(
          bootstrapLease,
          target,
          'SSH 远端运行环境连接身份不匹配'
        )
        this.#sshHosts.assertConnectionTargetCurrent(
          expectedTarget
        )
      }
      return unavailableRemoteDownload(
        'probe-failed',
        exposure
      )
    } finally {
      bootstrapLease?.release()
    }
  }
}

type RemoteDownloadUnavailable = Extract<
  SshHostRemoteEnvironment['remoteDownload'],
  { available: false }
>

function unavailableRemoteDownload(
  reason: RemoteDownloadUnavailable['reason'],
  exposure: {
    source: 'github' | 'mirror' | null
    packageSize: number | null
  } | null
): SshHostRemoteEnvironment['remoteDownload'] {
  return {
    available: false,
    source: exposure?.source ?? null,
    packageSize: exposure?.packageSize ?? null,
    reason
  }
}

function mapRemoteUnavailableReason(
  reason: SshRemotePackageBootstrapUnavailableReason
): Extract<
  SshHostRemoteEnvironment['remoteDownload'],
  { available: false }
>['reason'] {
  switch (reason) {
    case 'missing-curl':
    case 'missing-sha256sum':
    case 'missing-unzip':
    case 'bootstrap-tools-unavailable':
      return 'missing-tools'
    case 'managed-path-unavailable':
      return 'home-unwritable'
    case 'insufficient-disk-space':
      return 'insufficient-disk-space'
    case 'download-unavailable':
      return 'source-unreachable'
    default:
      throw new Error(
        `未知的远端下载安装探测结果：${String(reason)}`
      )
  }
}

async function readOptionalRegistry<T>(
  sftp: StagedSftp,
  path: string,
  schema: { parse(value: unknown): T },
  signal?: AbortSignal
): Promise<T | undefined> {
  let bytes: Buffer
  try {
    bytes = await sftp.readFile(path, signal)
  } catch (error) {
    if (isMissingPathError(error)) {
      return undefined
    }
    throw error
  }
  let value: unknown
  try {
    value = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    )
  } catch (error) {
    throw new Error('远端 GoodBuddy 运行环境元数据无效', {
      cause: error
    })
  }
  try {
    return schema.parse(value)
  } catch (error) {
    throw new Error('远端 GoodBuddy 运行环境元数据已损坏', {
      cause: error
    })
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

function environmentState(
  installedVersion: string | undefined,
  expectedVersion: string
): 'current' | 'update-available' | 'not-installed' {
  if (!installedVersion) {
    return 'not-installed'
  }
  return installedVersion === expectedVersion
    ? 'current'
    : 'update-available'
}

function agentStatus(
  expected: ExpectedCatalog['agent'],
  installed: InstallationRegistryEntry | undefined,
  architecture: 'x64' | 'arm64'
) {
  if (installed && installed.arch !== architecture) {
    throw new Error('远端 Agent registry 架构与主机不匹配')
  }
  const installedVersion = installed
    ? {
        version: installed.agentVersion,
        architecture: installed.arch
      }
    : null
  return {
    state: environmentState(installed?.agentVersion, expected.version),
    expected: { ...expected, architecture },
    installed: installedVersion
  }
}

function runtimeStatus(
  expected: ExpectedCatalog['runtimes'][number],
  installed: RuntimeRegistryEntry | undefined,
  architecture: 'x64' | 'arm64'
) {
  const installedVersion = installed
    ? {
        version: installed.runtimeVersion,
        architecture: installed.architecture
      }
    : null
  return {
    runtimeId: expected.runtimeId,
    provider: expected.provider,
    state: environmentState(installed?.runtimeVersion, expected.version),
    expected: {
      version: expected.version,
      architecture
    },
    installed: installedVersion
  }
}

async function loadExpectedCatalog(
  agentRuntimeLockPath: string,
  remoteRuntimeLockPath: string
): Promise<ExpectedCatalog> {
  const [agentBytes, runtimeBytes] = await Promise.all([
    readFile(agentRuntimeLockPath),
    readFile(remoteRuntimeLockPath)
  ])
  let agentLock: AgentRuntimeLock
  let runtimeLock: RemoteRuntimeLock
  try {
    agentLock = agentRuntimeLockSchema.parse(
      JSON.parse(agentBytes.toString('utf8'))
    )
    runtimeLock = remoteRuntimeLockSchema.parse(
      JSON.parse(runtimeBytes.toString('utf8'))
    )
  } catch (error) {
    throw new Error('GoodBuddy 内置远端运行环境版本元数据无效', {
      cause: error
    })
  }
  return {
    agent: {
      version: agentLock.agentVersion
    },
    runtimes: Object.entries(runtimeLock.runtimes)
      .map(([runtimeId, runtime]) => ({
        runtimeId: runtimeId as 'opencode',
        provider: runtime.provider,
        version: runtime.version
      }))
      .sort((left, right) =>
        left.runtimeId.localeCompare(right.runtimeId, 'en')
      )
  }
}

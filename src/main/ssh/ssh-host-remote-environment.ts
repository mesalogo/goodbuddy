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
import type {
  SshConnectionLease,
  SshConnectionPool
} from './ssh-connection-pool'

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

export type SshHostRemoteEnvironmentInspectorOptions = {
  sshHosts: Pick<
    SshHostStore,
    'resolveConnectionTarget' | 'assertConnectionTargetCurrent'
  >
  sshPool: Pick<SshConnectionPool, 'acquire'>
  agentRuntimeLockPath: string
  remoteRuntimeLockPath: string
  loadExpectedCatalog?: () => Promise<ExpectedCatalog>
  now?: () => Date
}

export class SshHostRemoteEnvironmentInspector {
  readonly #sshHosts: SshHostRemoteEnvironmentInspectorOptions['sshHosts']
  readonly #sshPool: SshHostRemoteEnvironmentInspectorOptions['sshPool']
  readonly #loadExpectedCatalog: () => Promise<ExpectedCatalog>
  readonly #now: () => Date
  #expectedCatalog?: Promise<ExpectedCatalog>

  constructor(options: SshHostRemoteEnvironmentInspectorOptions) {
    this.#sshHosts = options.sshHosts
    this.#sshPool = options.sshPool
    this.#loadExpectedCatalog =
      options.loadExpectedCatalog ??
      (() =>
        loadExpectedCatalog(
          options.agentRuntimeLockPath,
          options.remoteRuntimeLockPath
        ))
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
    assertTarget(hostId, target)
    const expectedTarget = currentTarget(target)
    this.#sshHosts.assertConnectionTargetCurrent(expectedTarget)

    let lease: SshConnectionLease | undefined
    let sftp: StagedSftp | undefined
    try {
      lease = await this.#sshPool.acquire(target, signal)
      assertLeaseIdentity(target, lease)
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
          this.#expected(),
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
      assertLeaseIdentity(target, lease)
      this.#sshHosts.assertConnectionTargetCurrent(expectedTarget)
      return sshHostRemoteEnvironmentSchema.parse({
        hostId,
        checkedAt: this.#now().toISOString(),
        architecture: probe.architecture,
        agent: agentStatus(
          catalog.agent,
          agentRegistry?.current,
          probe.architecture
        ),
        runtimes: catalog.runtimes.map((runtime) =>
          runtimeStatus(
            runtime,
            runtimeRegistry?.current.find(
              (installed) =>
                installed.runtimeId === runtime.runtimeId &&
                installed.architecture === probe.architecture
            ),
            probe.architecture
          )
        )
      })
    } finally {
      sftp?.close()
      lease?.release()
    }
  }

  #expected(): Promise<ExpectedCatalog> {
    this.#expectedCatalog ??= this.#loadExpectedCatalog()
    return this.#expectedCatalog
  }
}

function currentTarget(
  target: SshConnectionTarget
): CurrentSshConnectionTarget {
  return {
    hostId: target.host.id,
    hostRevision: target.hostRevision,
    hostKeyGeneration: target.hostKeyGeneration,
    username: target.host.username
  }
}

function assertTarget(
  requestedHostId: string,
  target: SshConnectionTarget
): void {
  if (
    target.host.id !== requestedHostId ||
    target.hostRevision < 1 ||
    target.hostKeyGeneration < 1 ||
    !target.host.hostKey ||
    target.host.hostKey.generation !== target.hostKeyGeneration
  ) {
    throw new Error('SSH 主机连接目标无效')
  }
}

function assertLeaseIdentity(
  target: SshConnectionTarget,
  lease: SshConnectionLease
): void {
  if (
    lease.identity.hostId !== target.host.id ||
    lease.identity.hostRevision !== target.hostRevision ||
    lease.identity.hostKeyGeneration !== target.hostKeyGeneration
  ) {
    throw new Error('SSH 远端运行环境连接身份不匹配')
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

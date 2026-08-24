import type {
  SshHostDirectoryBrowseResult
} from '../../shared/ssh-host-contracts'
import type {
  CurrentSshConnectionTarget,
  SshConnectionTarget,
  SshHostStore
} from './ssh-host-store'
import type {
  SshConnectionLease,
  SshConnectionPool
} from './ssh-connection-pool'

export type SshHostDirectoryBrowserOptions = {
  sshHosts: Pick<
    SshHostStore,
    'resolveConnectionTarget' | 'assertConnectionTargetCurrent'
  >
  sshPool: Pick<SshConnectionPool, 'acquire'>
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
    target.host.hostKey.generation !==
      target.hostKeyGeneration
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
    lease.identity.hostKeyGeneration !==
      target.hostKeyGeneration
  ) {
    throw new Error('SSH 目录浏览连接身份不匹配')
  }
}

export class SshHostDirectoryBrowser {
  readonly #sshHosts: SshHostDirectoryBrowserOptions['sshHosts']
  readonly #sshPool: SshHostDirectoryBrowserOptions['sshPool']

  constructor(options: SshHostDirectoryBrowserOptions) {
    this.#sshHosts = options.sshHosts
    this.#sshPool = options.sshPool
  }

  async listDirectories(
    hostId: string,
    path?: string,
    signal?: AbortSignal
  ): Promise<SshHostDirectoryBrowseResult> {
    signal?.throwIfAborted()
    const target =
      await this.#sshHosts.resolveConnectionTarget(hostId)
    signal?.throwIfAborted()
    assertTarget(hostId, target)
    const expected = currentTarget(target)
    this.#sshHosts.assertConnectionTargetCurrent(expected)

    let lease: SshConnectionLease | undefined
    try {
      lease = await this.#sshPool.acquire(target, signal)
      signal?.throwIfAborted()
      assertLeaseIdentity(target, lease)
      const listing = await lease.listDirectories(path, signal)
      signal?.throwIfAborted()
      assertLeaseIdentity(target, lease)
      this.#sshHosts.assertConnectionTargetCurrent(expected)
      return listing
    } finally {
      lease?.release()
    }
  }
}

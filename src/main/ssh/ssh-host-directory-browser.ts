import type {
  SshHostDirectoryBrowseResult
} from '../../shared/ssh-host-contracts'
import type {
  SshHostStore
} from './ssh-host-store'
import type {
  SshConnectionLease,
  SshConnectionPool
} from './ssh-connection-pool'
import {
  assertSshLeaseMatchesTarget,
  assertValidSshConnectionTarget,
  toCurrentSshConnectionTarget
} from './ssh-connection-target'

export type SshHostDirectoryBrowserOptions = {
  sshHosts: Pick<
    SshHostStore,
    'resolveConnectionTarget' | 'assertConnectionTargetCurrent'
  >
  sshPool: Pick<SshConnectionPool, 'acquire'>
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
    assertValidSshConnectionTarget(hostId, target)
    const expected = toCurrentSshConnectionTarget(target)
    this.#sshHosts.assertConnectionTargetCurrent(expected)

    let lease: SshConnectionLease | undefined
    try {
      lease = await this.#sshPool.acquire(target, signal)
      signal?.throwIfAborted()
      assertSshLeaseMatchesTarget(
        lease,
        target,
        'SSH 目录浏览连接身份不匹配'
      )
      const listing = await lease.listDirectories(path, signal)
      signal?.throwIfAborted()
      assertSshLeaseMatchesTarget(
        lease,
        target,
        'SSH 目录浏览连接身份不匹配'
      )
      this.#sshHosts.assertConnectionTargetCurrent(expected)
      return listing
    } finally {
      lease?.release()
    }
  }
}

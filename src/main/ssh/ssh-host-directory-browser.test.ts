import { describe, expect, it, vi } from 'vitest'
import type { SshConnectionTarget } from './ssh-host-store'
import type {
  SshConnectionLease,
  SshPoolConnectionIdentity
} from './ssh-connection-pool'
import { SshHostDirectoryBrowser } from './ssh-host-directory-browser'

const hostId = '00000000-0000-4000-8000-000000000301'

function createTarget(
  overrides: Partial<SshConnectionTarget> = {}
): SshConnectionTarget {
  return {
    host: {
      id: hostId,
      name: 'Browse host',
      hostname: 'browse.example.com',
      port: 22,
      username: 'browser',
      authentication: 'password',
      password: 'secret',
      hostKey: {
        algorithm: 'ssh-ed25519',
        publicKeyBase64: 'key',
        fingerprintSha256: `SHA256:${'A'.repeat(43)}`,
        generation: 4
      }
    },
    hostRevision: 9,
    hostKeyGeneration: 4,
    ...overrides
  }
}

function createLease(
  identity: Partial<SshPoolConnectionIdentity> = {},
  listDirectories = vi.fn(async () => ({
    path: '/home/browser',
    homeDirectory: '/home/browser',
    parentPath: '/home',
    entries: [],
    truncated: false
  }))
): SshConnectionLease {
  return {
    identity: {
      hostId,
      hostRevision: 9,
      hostKeyGeneration: 4,
      authenticationIdentity: 'a'.repeat(64),
      ...identity
    },
    isUsable: vi.fn(() => true),
    openAgentAttach: vi.fn(),
    runAgentDoctor: vi.fn(),
    runAgentBootstrapProbe: vi.fn(),
    probeRemotePackageBootstrap: vi.fn(),
    prepareRemotePackageBootstrap: vi.fn(),
    commitRemotePackageBootstrap: vi.fn(),
    cleanupRemotePackageBootstrap: vi.fn(),
    runAgentLifecycleAction: vi.fn(),
    runAgentRuntimeAction: vi.fn(),
    openStagedSftp: vi.fn(),
    listDirectories,
    release: vi.fn()
  }
}

function createBrowser(options: {
  target?: SshConnectionTarget
  lease?: ReturnType<typeof createLease>
  events?: string[]
}) {
  const events = options.events ?? []
  const target = options.target ?? createTarget()
  const lease = options.lease ?? createLease()
  const resolveConnectionTarget = vi.fn(async () => {
    events.push('resolve')
    return target
  })
  const assertConnectionTargetCurrent = vi.fn(() => {
    events.push('current')
  })
  const acquire = vi.fn(async () => {
    events.push('acquire')
    return lease
  })
  const originalList = lease.listDirectories
  lease.listDirectories = vi.fn(async (path, signal) => {
    events.push('list')
    return originalList(path, signal)
  })
  const originalRelease = lease.release
  lease.release = vi.fn(() => {
    events.push('release')
    originalRelease()
  })
  const browser = new SshHostDirectoryBrowser({
    sshHosts: {
      resolveConnectionTarget,
      assertConnectionTargetCurrent
    },
    sshPool: { acquire }
  })
  return {
    browser,
    events,
    target,
    lease,
    resolveConnectionTarget,
    assertConnectionTargetCurrent,
    acquire
  }
}

describe('SSH host directory browser', () => {
  it('checks the current target before and after browsing and always releases', async () => {
    const test = createBrowser({})
    const signal = new AbortController().signal

    await expect(
      test.browser.listDirectories(
        hostId,
        '/srv/projects',
        signal
      )
    ).resolves.toMatchObject({
      path: '/home/browser',
      homeDirectory: '/home/browser'
    })

    expect(test.events).toEqual([
      'resolve',
      'current',
      'acquire',
      'list',
      'current',
      'release'
    ])
    expect(
      test.assertConnectionTargetCurrent
    ).toHaveBeenNthCalledWith(1, {
      hostId,
      hostRevision: 9,
      hostKeyGeneration: 4,
      username: 'browser'
    })
    expect(
      test.assertConnectionTargetCurrent
    ).toHaveBeenNthCalledWith(2, {
      hostId,
      hostRevision: 9,
      hostKeyGeneration: 4,
      username: 'browser'
    })
    expect(test.acquire).toHaveBeenCalledWith(test.target, signal)
    expect(test.lease.listDirectories).toHaveBeenCalledWith(
      '/srv/projects',
      signal
    )
    expect(test.lease.release).toHaveBeenCalledOnce()
  })

  it.each([
    ['host id', { hostId: 'other-host' }],
    ['host revision', { hostRevision: 10 }],
    ['host-key generation', { hostKeyGeneration: 5 }]
  ])(
    'rejects a lease with a mismatched %s and releases it',
    async (_label, identity) => {
      const test = createBrowser({
        lease: createLease(identity)
      })

      await expect(
        test.browser.listDirectories(hostId)
      ).rejects.toThrow('连接身份不匹配')
      expect(test.lease.listDirectories).not.toHaveBeenCalled()
      expect(test.lease.release).toHaveBeenCalledOnce()
      expect(
        test.assertConnectionTargetCurrent
      ).toHaveBeenCalledOnce()
    }
  )

  it('rejects a target resolved for another host before acquiring', async () => {
    const target = createTarget()
    target.host.id = '00000000-0000-4000-8000-000000000302'
    const test = createBrowser({ target })

    await expect(
      test.browser.listDirectories(hostId)
    ).rejects.toThrow('连接目标无效')
    expect(test.acquire).not.toHaveBeenCalled()
    expect(
      test.assertConnectionTargetCurrent
    ).not.toHaveBeenCalled()
  })

  it('rejects a host change after listing and releases the lease', async () => {
    const test = createBrowser({})
    test.assertConnectionTargetCurrent
      .mockImplementationOnce(() => {
        test.events.push('current')
      })
      .mockImplementationOnce(() => {
        test.events.push('current')
        throw new Error('SSH 主机配置已变化，请重新验证')
      })

    await expect(
      test.browser.listDirectories(hostId)
    ).rejects.toThrow('主机配置已变化')
    expect(test.events.at(-1)).toBe('release')
    expect(test.lease.release).toHaveBeenCalledOnce()
  })

  it('releases the lease when directory browsing fails', async () => {
    const test = createBrowser({
      lease: createLease(
        {},
        vi.fn(async () => {
          throw new Error('SFTP unavailable')
        })
      )
    })

    await expect(
      test.browser.listDirectories(hostId)
    ).rejects.toThrow('SFTP unavailable')
    expect(test.lease.release).toHaveBeenCalledOnce()
    expect(
      test.assertConnectionTargetCurrent
    ).toHaveBeenCalledOnce()
  })

  it('honors cancellation before target resolution and after acquisition', async () => {
    const alreadyCanceled = new AbortController()
    alreadyCanceled.abort()
    const early = createBrowser({})
    await expect(
      early.browser.listDirectories(
        hostId,
        undefined,
        alreadyCanceled.signal
      )
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect(early.resolveConnectionTarget).not.toHaveBeenCalled()

    const controller = new AbortController()
    const late = createBrowser({})
    late.acquire.mockImplementationOnce(async () => {
      late.events.push('acquire')
      controller.abort()
      return late.lease
    })
    await expect(
      late.browser.listDirectories(
        hostId,
        undefined,
        controller.signal
      )
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect(late.lease.listDirectories).not.toHaveBeenCalled()
    expect(late.lease.release).toHaveBeenCalledOnce()
  })
})

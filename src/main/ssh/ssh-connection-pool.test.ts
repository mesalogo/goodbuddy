import { EventEmitter } from 'node:events'
import type { ConnectConfig } from 'ssh2'
import { describe, expect, it, vi } from 'vitest'
import type { ResolvedSshHost } from './ssh-host-store'
import {
  AGENT_BOOTSTRAP_PROBE_COMMAND,
  verifyAgentInstallationId
} from './ssh-agent-command'
import {
  Ssh2AuthenticatedConnection,
  SshConnectionPool,
  type AuthenticatedSshConnection,
  type SshConnectionFactory,
  type SshConnectionPoolTarget,
  type SshPoolConnectionIdentity
} from './ssh-connection-pool'

const sshEd25519Algorithm = Buffer.from('ssh-ed25519')
const pinnedHostKey = Buffer.concat([
  Buffer.from([0, 0, 0, sshEd25519Algorithm.byteLength]),
  sshEd25519Algorithm,
  Buffer.from([0, 0, 0, 32]),
  Buffer.alloc(32, 7)
])

const hostKey = {
  algorithm: 'ssh-ed25519',
  publicKeyBase64: pinnedHostKey.toString('base64'),
  fingerprintSha256: `SHA256:${'A'.repeat(43)}`,
  generation: 3
}

function createTarget(
  overrides: Partial<ResolvedSshHost> = {},
  identityOverrides: Partial<
    Pick<
      SshConnectionPoolTarget,
      'hostRevision' | 'hostKeyGeneration'
    >
  > = {}
): SshConnectionPoolTarget {
  return {
    host: {
      id: '00000000-0000-4000-8000-000000000201',
      name: 'Build host',
      hostname: 'build.example.com',
      port: 22,
      username: 'builder',
      authentication: 'password',
      password: 'private password',
      hostKey,
      ...overrides
    },
    hostRevision: 7,
    hostKeyGeneration: 3,
    ...identityOverrides
  }
}

function createConnection(identity: SshPoolConnectionIdentity) {
  return {
    identity,
    isUsable: vi.fn(() => true),
    openAgentAttach: vi.fn(),
    runAgentDoctor: vi.fn(),
    runAgentBootstrapProbe: vi.fn(),
    runAgentLifecycleAction: vi.fn(),
    runAgentRuntimeAction: vi.fn(),
    openStagedSftp: vi.fn(),
    listDirectories: vi.fn(),
    dispose: vi.fn()
  } satisfies AuthenticatedSshConnection
}

describe('SSH connection pool', () => {
  it('reuses one authenticated connection for matching identities and refcounts leases', async () => {
    vi.useFakeTimers()
    try {
      const connections: ReturnType<typeof createConnection>[] = []
      const factory: SshConnectionFactory = vi.fn(
        async (_target, identity) => {
          const connection = createConnection(identity)
          connections.push(connection)
          return connection
        }
      )
      const pool = new SshConnectionPool(factory, {
        idleTimeoutMs: 100
      })

      const [first, second] = await Promise.all([
        pool.acquire(createTarget()),
        pool.acquire(createTarget())
      ])

      expect(factory).toHaveBeenCalledOnce()
      expect(first.identity).toEqual(second.identity)
      first.release()
      await vi.advanceTimersByTimeAsync(100)
      expect(connections[0]?.dispose).not.toHaveBeenCalled()
      second.release()
      await vi.advanceTimersByTimeAsync(99)
      expect(connections[0]?.dispose).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(1)
      expect(connections[0]?.dispose).toHaveBeenCalledOnce()
    } finally {
      vi.useRealTimers()
    }
  })

  it('isolates revision, host-key generation, credential, and host identities', async () => {
    const factory: SshConnectionFactory = vi.fn(
      async (_target, identity) => createConnection(identity)
    )
    const pool = new SshConnectionPool(factory)
    const targets = [
      createTarget(),
      createTarget({}, { hostRevision: 8 }),
      createTarget(
        { hostKey: { ...hostKey, generation: 4 } },
        { hostKeyGeneration: 4 }
      ),
      createTarget({ password: 'rotated password' }),
      createTarget({
        id: '00000000-0000-4000-8000-000000000202'
      })
    ]

    const leases = await Promise.all(
      targets.map((target) => pool.acquire(target))
    )

    expect(factory).toHaveBeenCalledTimes(5)
    expect(
      new Set(
        leases.map(
          (lease) =>
            `${lease.identity.hostId}:${lease.identity.hostRevision}:` +
            `${lease.identity.hostKeyGeneration}:` +
            lease.identity.authenticationIdentity
        )
      ).size
    ).toBe(5)
    for (const lease of leases) {
      lease.release()
    }
    pool.dispose()
  })

  it('lets one canceled waiter leave without canceling a shared connection', async () => {
    let resolveConnection:
      | ((connection: AuthenticatedSshConnection) => void)
      | undefined
    const factory: SshConnectionFactory = vi.fn(
      (_target, identity) =>
        new Promise<AuthenticatedSshConnection>((resolve) => {
          resolveConnection = resolve
          expect(identity.authenticationIdentity).toMatch(
            /^[a-f0-9]{64}$/u
          )
        })
    )
    const pool = new SshConnectionPool(factory)
    const controller = new AbortController()
    const canceled = pool.acquire(createTarget(), controller.signal)
    const surviving = pool.acquire(createTarget())
    controller.abort()

    await expect(canceled).rejects.toMatchObject({
      name: 'AbortError'
    })
    const identity = (
      factory as ReturnType<typeof vi.fn>
    ).mock.calls[0]?.[1] as SshPoolConnectionIdentity
    resolveConnection?.(createConnection(identity))
    const lease = await surviving
    expect(lease.isUsable()).toBe(true)
    lease.release()
    pool.dispose()
  })

  it('disposes all host entries and prevents use after release', async () => {
    const connection = createConnection({
      hostId: createTarget().host.id,
      hostRevision: 7,
      hostKeyGeneration: 3,
      authenticationIdentity: 'a'.repeat(64)
    })
    const pool = new SshConnectionPool(async () => connection)
    const lease = await pool.acquire(createTarget())
    const signal = new AbortController().signal
    void lease.runAgentBootstrapProbe(signal)
    expect(
      connection.runAgentBootstrapProbe
    ).toHaveBeenCalledWith(signal)
    void lease.listDirectories('/srv', signal)
    expect(connection.listDirectories).toHaveBeenCalledWith(
      '/srv',
      signal
    )
    void lease.runAgentRuntimeAction(
      verifyAgentInstallationId('agent-v1'),
      {
        kind: 'runtime-activate',
        runtimeId: 'opencode',
        bundleDigest: `sha256:${'a'.repeat(64)}`,
        architecture: 'x64'
      },
      signal
    )
    expect(connection.runAgentRuntimeAction).toHaveBeenCalledWith(
      'agent-v1',
      expect.objectContaining({ kind: 'runtime-activate' }),
      signal
    )
    lease.release()

    expect(() =>
      lease.openAgentAttach(
        verifyAgentInstallationId('agent-v1')
      )
    ).toThrow('租约已释放')
    expect(() =>
      lease.runAgentBootstrapProbe()
    ).toThrow('租约已释放')
    expect(() =>
      lease.listDirectories()
    ).toThrow('租约已释放')
    expect(lease).not.toHaveProperty('exec')
    expect(lease).not.toHaveProperty('sftp')
    pool.disposeHost(createTarget().host.id)
    expect(connection.dispose).toHaveBeenCalledOnce()
  })
})

describe('authenticated ssh2 connection', () => {
  it('uses pinned algorithms, keepalive, no forwarding, and only fixed Agent exec', async () => {
    let connectConfig: ConnectConfig | undefined
    const channel = Object.assign(new EventEmitter(), {
      stderr: new EventEmitter(),
      destroy: vi.fn()
    })
    const client = Object.assign(new EventEmitter(), {
      connect: vi.fn(function connect(
        this: EventEmitter,
        config: ConnectConfig
      ) {
        connectConfig = config
        expect(
          (
            config.hostVerifier as
              | ((key: Buffer) => boolean)
              | undefined
          )?.(pinnedHostKey)
        ).toBe(true)
        this.emit('ready')
      }),
      end: vi.fn(),
      destroy: vi.fn(),
      exec: vi.fn(
        (
          _command: string,
          _options: unknown,
          callback: (
            error: Error | undefined,
            stream: typeof channel
          ) => void
        ) => callback(undefined, channel)
      ),
      sftp: vi.fn()
    })
    const target = createTarget()
    const identity: SshPoolConnectionIdentity = {
      hostId: target.host.id,
      hostRevision: target.hostRevision,
      hostKeyGeneration: target.hostKeyGeneration,
      authenticationIdentity: 'a'.repeat(64)
    }
    const connection = await Ssh2AuthenticatedConnection.connect(
      target,
      identity,
      new AbortController().signal,
      {
        createClient: () => client as never,
        supportedOpenSslCiphers: () => ['aes-256-gcm']
      }
    )

    await connection.openAgentAttach(
      verifyAgentInstallationId('agent-v1')
    )

    expect(connectConfig).toMatchObject({
      host: 'build.example.com',
      port: 22,
      username: 'builder',
      password: 'private password',
      agentForward: false,
      keepaliveInterval: 5_000,
      keepaliveCountMax: 2,
      algorithms: {
        cipher: ['aes256-gcm@openssh.com']
      }
    })
    expect(client.exec).toHaveBeenCalledWith(
      'exec "$HOME/.goodbuddy/agent/installations/' +
        'agent-v1/goodbuddy-agent" attach-or-bootstrap ' +
        '--installation-id agent-v1',
      {
        env: {},
        pty: false,
        x11: false,
        allowHalfOpen: false
      },
      expect.any(Function)
    )
    expect(connection).not.toHaveProperty('exec')
  })

  it('hard-fails a host-key mismatch and aborts pending authentication', async () => {
    let authenticationAttempted = false
    const mismatchedClient = Object.assign(new EventEmitter(), {
      connect: vi.fn(function connect(
        this: EventEmitter,
        config: ConnectConfig
      ) {
        const accepted = (
          config.hostVerifier as
            | ((key: Buffer) => boolean)
            | undefined
        )?.(Buffer.from('different-key'))
        if (accepted) {
          authenticationAttempted = true
        }
        this.emit(
          'error',
          Object.assign(new Error('key rejected'), {
            level: 'handshake'
          })
        )
      }),
      end: vi.fn(),
      destroy: vi.fn(),
      exec: vi.fn(),
      sftp: vi.fn()
    })
    const target = createTarget()
    const identity = {
      hostId: target.host.id,
      hostRevision: target.hostRevision,
      hostKeyGeneration: target.hostKeyGeneration,
      authenticationIdentity: 'a'.repeat(64)
    }

    expect(() =>
      Ssh2AuthenticatedConnection.connect(
        target,
        { ...identity, hostRevision: identity.hostRevision + 1 },
        new AbortController().signal,
        { createClient: () => mismatchedClient as never }
      )
    ).toThrow('认证目标不匹配')
    await expect(
      Ssh2AuthenticatedConnection.connect(
        target,
        identity,
        new AbortController().signal,
        { createClient: () => mismatchedClient as never }
      )
    ).rejects.toThrow('主机密钥已变化')
    expect(authenticationAttempted).toBe(false)
    expect(mismatchedClient.destroy).toHaveBeenCalledOnce()

    const pendingClient = Object.assign(new EventEmitter(), {
      connect: vi.fn(),
      end: vi.fn(),
      destroy: vi.fn(),
      exec: vi.fn(),
      sftp: vi.fn()
    })
    const controller = new AbortController()
    const pending = Ssh2AuthenticatedConnection.connect(
      target,
      identity,
      controller.signal,
      { createClient: () => pendingClient as never }
    )
    controller.abort()
    await expect(pending).rejects.toMatchObject({
      name: 'AbortError'
    })
    expect(pendingClient.destroy).toHaveBeenCalledOnce()
  })

  it('bounds fixed diagnostic output and destroys an overflowing channel', async () => {
    const channel = Object.assign(new EventEmitter(), {
      stderr: new EventEmitter(),
      destroy: vi.fn()
    })
    const client = Object.assign(new EventEmitter(), {
      connect: vi.fn(function connect(this: EventEmitter) {
        this.emit('ready')
      }),
      end: vi.fn(),
      destroy: vi.fn(),
      exec: vi.fn(
        (
          _command: string,
          _options: unknown,
          callback: (
            error: Error | undefined,
            stream: typeof channel
          ) => void
        ) => {
          callback(undefined, channel)
          setTimeout(() => {
            channel.emit('data', Buffer.alloc(64 * 1024 + 1))
          }, 0)
        }
      ),
      sftp: vi.fn()
    })
    const target = createTarget()
    const connection = await Ssh2AuthenticatedConnection.connect(
      target,
      {
        hostId: target.host.id,
        hostRevision: target.hostRevision,
        hostKeyGeneration: target.hostKeyGeneration,
        authenticationIdentity: 'a'.repeat(64)
      },
      new AbortController().signal,
      { createClient: () => client as never }
    )

    await expect(
      connection.runAgentDoctor(
        verifyAgentInstallationId('agent-v1')
      )
    ).rejects.toThrow('输出超过安全限制')
    expect(client.exec.mock.calls[0]?.[0]).toContain(
      '/goodbuddy-agent" doctor'
    )
    expect(channel.destroy).toHaveBeenCalledOnce()
  })

  it('bounds bootstrap probe output and destroys an overflowing channel', async () => {
    const channel = Object.assign(new EventEmitter(), {
      stderr: new EventEmitter(),
      destroy: vi.fn()
    })
    const client = Object.assign(new EventEmitter(), {
      connect: vi.fn(function connect(this: EventEmitter) {
        this.emit('ready')
      }),
      end: vi.fn(),
      destroy: vi.fn(),
      exec: vi.fn(
        (
          _command: string,
          _options: unknown,
          callback: (
            error: Error | undefined,
            stream: typeof channel
          ) => void
        ) => {
          callback(undefined, channel)
          setTimeout(() => {
            channel.emit('data', Buffer.alloc(64 * 1024 + 1))
          }, 0)
        }
      ),
      sftp: vi.fn()
    })
    const target = createTarget()
    const connection = await Ssh2AuthenticatedConnection.connect(
      target,
      {
        hostId: target.host.id,
        hostRevision: target.hostRevision,
        hostKeyGeneration: target.hostKeyGeneration,
        authenticationIdentity: 'a'.repeat(64)
      },
      new AbortController().signal,
      { createClient: () => client as never }
    )

    await expect(
      connection.runAgentBootstrapProbe()
    ).rejects.toThrow('输出超过安全限制')
    expect(client.exec.mock.calls[0]?.[0]).toBe(
      AGENT_BOOTSTRAP_PROBE_COMMAND
    )
    expect(channel.destroy).toHaveBeenCalledOnce()
  })

  it('runs the fixed bootstrap probe and collects split output', async () => {
    const channel = Object.assign(new EventEmitter(), {
      stderr: new EventEmitter(),
      destroy: vi.fn()
    })
    const output = [
      'GOODBUDDY_AGENT_BOOTSTRAP_PROBE_V1',
      'home=/home/builder',
      'uid=1001',
      'os=Linux',
      'arch=aarch64',
      'shell=/bin/bash',
      'procfs=ready',
      ''
    ].join('\n')
    const client = Object.assign(new EventEmitter(), {
      connect: vi.fn(function connect(this: EventEmitter) {
        this.emit('ready')
      }),
      end: vi.fn(),
      destroy: vi.fn(),
      exec: vi.fn(
        (
          _command: string,
          _options: unknown,
          callback: (
            error: Error | undefined,
            stream: typeof channel
          ) => void
        ) => {
          callback(undefined, channel)
          setTimeout(() => {
            channel.emit('data', output.slice(0, 17))
            channel.emit('data', Buffer.from(output.slice(17)))
            channel.emit('close', 0)
          }, 0)
        }
      ),
      sftp: vi.fn()
    })
    const target = createTarget()
    const connection = await Ssh2AuthenticatedConnection.connect(
      target,
      {
        hostId: target.host.id,
        hostRevision: target.hostRevision,
        hostKeyGeneration: target.hostKeyGeneration,
        authenticationIdentity: 'a'.repeat(64)
      },
      new AbortController().signal,
      { createClient: () => client as never }
    )

    await expect(connection.runAgentBootstrapProbe()).resolves.toMatchObject({
      ready: true,
      architecture: 'arm64'
    })
    expect(client.exec).toHaveBeenCalledWith(
      AGENT_BOOTSTRAP_PROBE_COMMAND,
      {
        env: {},
        pty: false,
        x11: false,
        allowHalfOpen: false
      },
      expect.any(Function)
    )
  })

  it('cancels a running bootstrap probe and destroys its channel', async () => {
    const channel = Object.assign(new EventEmitter(), {
      stderr: new EventEmitter(),
      destroy: vi.fn()
    })
    const client = Object.assign(new EventEmitter(), {
      connect: vi.fn(function connect(this: EventEmitter) {
        this.emit('ready')
      }),
      end: vi.fn(),
      destroy: vi.fn(),
      exec: vi.fn(
        (
          _command: string,
          _options: unknown,
          callback: (
            error: Error | undefined,
            stream: typeof channel
          ) => void
        ) => callback(undefined, channel)
      ),
      sftp: vi.fn()
    })
    const target = createTarget()
    const connection = await Ssh2AuthenticatedConnection.connect(
      target,
      {
        hostId: target.host.id,
        hostRevision: target.hostRevision,
        hostKeyGeneration: target.hostKeyGeneration,
        authenticationIdentity: 'a'.repeat(64)
      },
      new AbortController().signal,
      { createClient: () => client as never }
    )
    const controller = new AbortController()
    const result = connection.runAgentBootstrapProbe(controller.signal)
    controller.abort()

    await expect(result).rejects.toMatchObject({
      name: 'AbortError'
    })
    expect(channel.destroy).toHaveBeenCalledOnce()
  })
})

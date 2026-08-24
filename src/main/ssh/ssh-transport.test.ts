import { generateKeyPairSync } from 'node:crypto'
import { EventEmitter } from 'node:events'
import type { AddressInfo } from 'node:net'
import {
  Server,
  type AuthContext,
  type Connection
} from 'ssh2'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ResolvedSshHost } from './ssh-host-store'
import {
  buildAuthenticatedSshConnectConfig,
  createStrongSshAlgorithms,
  describeSshHostKey,
  selectStrongSshCiphers,
  Ssh2Transport
} from './ssh-transport'

type ServerHarness = {
  server: Server
  port: number
  authenticationMethods: string[]
  passwords: string[]
  commands: string[]
}

const servers: Server[] = []
const { privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2_048,
  privateKeyEncoding: {
    type: 'pkcs1',
    format: 'pem'
  },
  publicKeyEncoding: {
    type: 'pkcs1',
    format: 'pem'
  }
})

function createHostKeyBlob(algorithm: string): Buffer {
  const name = Buffer.from(algorithm)
  const length = Buffer.alloc(4)
  length.writeUInt32BE(name.length)
  return Buffer.concat([length, name, Buffer.alloc(32, 7)])
}

function createResolvedHost(
  publicKey: Buffer,
  algorithm = 'metadata-is-not-trusted'
): ResolvedSshHost {
  return {
    id: '00000000-0000-4000-8000-000000000101',
    name: 'Pinned test host',
    hostname: '127.0.0.1',
    port: 22,
    username: 'builder',
    authentication: 'password',
    password: 'private password',
    hostKey: {
      algorithm,
      publicKeyBase64: publicKey.toString('base64'),
      fingerprintSha256: `SHA256:${'A'.repeat(43)}`,
      acceptedAt: '2026-08-01T00:00:00.000Z',
      generation: 1
    }
  }
}

const testAlgorithms = createStrongSshAlgorithms([
  'aes-256-gcm'
])

async function createServer(): Promise<ServerHarness> {
  const authenticationMethods: string[] = []
  const passwords: string[] = []
  const commands: string[] = []
  const server = new Server(
    { hostKeys: [privateKey] },
    (client: Connection) => {
      client.on('error', () => undefined)
      client.on('authentication', (context: AuthContext) => {
        authenticationMethods.push(context.method)
        if (context.method === 'password') {
          passwords.push(context.password)
          if (
            context.username === 'builder' &&
            context.password === 'private password'
          ) {
            context.accept()
            return
          }
        }
        context.reject(['password'])
      })
      client.on('ready', () => {
        client.on('session', (accept) => {
          const session = accept()
          session.on('exec', (acceptExec, _reject, info) => {
            commands.push(info.command)
            const stream = acceptExec()
            stream.write(
              [
                'GOODBUDDY_SSH_PROBE_V1',
                'Linux',
                'x86_64',
                '/bin/bash',
                '/home/builder',
                ''
              ].join('\n')
            )
            stream.exit(0)
            stream.end()
          })
        })
      })
    }
  )
  servers.push(server)
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  return {
    server,
    port: (server.address() as AddressInfo).port,
    authenticationMethods,
    passwords,
    commands
  }
}

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve())
        })
    )
  )
})

describe('SSH transport', () => {
  it('removes ChaCha20 when the current OpenSSL build cannot provide it', () => {
    expect(
      selectStrongSshCiphers([
        'aes-256-gcm',
        'aes-128-gcm',
        'aes-256-ctr',
        'aes-192-ctr',
        'aes-128-ctr'
      ])
    ).toEqual([
      'aes256-gcm@openssh.com',
      'aes128-gcm@openssh.com',
      'aes256-ctr',
      'aes192-ctr',
      'aes128-ctr'
    ])
  })

  it('fails closed when no approved cipher is available', () => {
    expect(() => selectStrongSshCiphers(['des-cbc'])).toThrow(
      '不支持 GoodBuddy 要求的安全 SSH 加密算法'
    )
  })

  it('describes complete SSH key blobs with SHA-256 fingerprints', () => {
    const blob = createHostKeyBlob('ssh-ed25519')

    expect(describeSshHostKey(blob)).toMatchObject({
      algorithm: 'ssh-ed25519',
      publicKeyBase64: blob.toString('base64'),
      fingerprintSha256: expect.stringMatching(
        /^SHA256:[A-Za-z0-9+/]{43}$/u
      )
    })
    expect(() => describeSshHostKey(Buffer.alloc(0))).toThrow(
      '大小无效'
    )
  })

  it('negotiates only the algorithm represented by a pinned ECDSA key blob', () => {
    const config = buildAuthenticatedSshConnectConfig(
      createResolvedHost(
        createHostKeyBlob('ecdsa-sha2-nistp384'),
        'ssh-ed25519'
      ),
      testAlgorithms,
      undefined,
      vi.fn()
    )

    expect(config.algorithms?.serverHostKey).toEqual([
      'ecdsa-sha2-nistp384'
    ])
    expect(testAlgorithms.serverHostKey).toContain('ssh-ed25519')
  })

  it('maps a pinned RSA key blob to RSA SHA-2 negotiation only', () => {
    const config = buildAuthenticatedSshConnectConfig(
      createResolvedHost(createHostKeyBlob('ssh-rsa')),
      testAlgorithms,
      undefined,
      vi.fn()
    )

    expect(config.algorithms?.serverHostKey).toEqual([
      'rsa-sha2-512',
      'rsa-sha2-256'
    ])
    expect(config.algorithms?.serverHostKey).not.toContain('ssh-rsa')
  })

  it('fails closed for malformed or unsupported pinned key algorithms', () => {
    const malformed = Buffer.alloc(4)
    malformed.writeUInt32BE(12)

    expect(() =>
      buildAuthenticatedSshConnectConfig(
        createResolvedHost(malformed),
        testAlgorithms,
        undefined,
        vi.fn()
      )
    ).toThrow('主机密钥格式无效')
    expect(() =>
      buildAuthenticatedSshConnectConfig(
        createResolvedHost(createHostKeyBlob('ssh-dss')),
        testAlgorithms,
        undefined,
        vi.fn()
      )
    ).toThrow('主机密钥算法不受支持')
  })

  it('keeps broad strong Host Key negotiation while inspecting draft hosts', async () => {
    const client = Object.assign(new EventEmitter(), {
      connect: vi.fn(),
      end: vi.fn(),
      destroy: vi.fn(),
      exec: vi.fn()
    })
    const transport = new Ssh2Transport({
      createClient: () => client as never,
      supportedOpenSslCiphers: () => ['aes-256-gcm']
    })

    const inspection = transport.inspectHostKey({
      hostname: '127.0.0.1',
      port: 22,
      username: 'builder'
    })

    expect(client.connect).toHaveBeenCalledWith(
      expect.objectContaining({
        algorithms: expect.objectContaining({
          serverHostKey: [
            'ssh-ed25519',
            'ecdsa-sha2-nistp256',
            'ecdsa-sha2-nistp384',
            'ecdsa-sha2-nistp521',
            'rsa-sha2-512',
            'rsa-sha2-256'
          ]
        })
      })
    )
    client.emit('error', new Error('stop inspection'))
    await expect(inspection).rejects.toThrow('无法连接 SSH 主机')
  })

  it('captures the host key and terminates before sending any authentication method', async () => {
    const harness = await createServer()
    const transport = new Ssh2Transport()

    const candidate = await transport.inspectHostKey({
      hostname: '127.0.0.1',
      port: harness.port,
      username: 'builder'
    })

    expect(candidate).toMatchObject({
      algorithm: 'ssh-rsa',
      fingerprintSha256: expect.stringMatching(
        /^SHA256:[A-Za-z0-9+/]{43}$/u
      )
    })
    await new Promise((resolve) => setTimeout(resolve, 25))
    expect(harness.authenticationMethods).toEqual([])
    expect(harness.passwords).toEqual([])
  })

  it('pins the full key blob, authenticates, and executes only the bounded probe', async () => {
    const harness = await createServer()
    let now = 1_000
    const transport = new Ssh2Transport({
      now: () => {
        now += 6
        return now
      }
    })
    const candidate = await transport.inspectHostKey({
      hostname: '127.0.0.1',
      port: harness.port,
      username: 'builder'
    })
    const host: ResolvedSshHost = {
      id: '00000000-0000-4000-8000-000000000102',
      name: 'Local test host',
      hostname: '127.0.0.1',
      port: harness.port,
      username: 'builder',
      authentication: 'password',
      password: 'private password',
      hostKey: {
        ...candidate,
        acceptedAt: '2026-08-01T00:00:00.000Z',
        generation: 1
      }
    }

    await expect(transport.testConnection(host)).resolves.toEqual({
      connected: true,
      latencyMs: 6,
      platform: 'linux',
      architecture: 'x64',
      shell: '/bin/bash',
      homeDirectory: '/home/builder',
      detail: 'SSH 已连接，远端系统为 linux/x64'
    })
    expect(harness.passwords).toEqual(['private password'])
    expect(harness.commands).toHaveLength(1)
    expect(harness.commands[0]).toContain(
      "printf 'GOODBUDDY_SSH_PROBE_V1\\n'"
    )
    expect(harness.commands[0]).not.toContain('private password')
  })

  it('rejects a changed host key before authentication', async () => {
    const harness = await createServer()
    const transport = new Ssh2Transport()
    const candidate = await transport.inspectHostKey({
      hostname: '127.0.0.1',
      port: harness.port,
      username: 'builder'
    })
    const wrongKey = Buffer.from(
      candidate.publicKeyBase64,
      'base64'
    )
    const finalByte = wrongKey.readUInt8(wrongKey.length - 1)
    wrongKey.writeUInt8(finalByte ^ 0xff, wrongKey.length - 1)

    await expect(
      transport.testConnection({
        id: '00000000-0000-4000-8000-000000000103',
        name: 'Local test host',
        hostname: '127.0.0.1',
        port: harness.port,
        username: 'builder',
        authentication: 'password',
        password: 'private password',
        hostKey: {
          ...candidate,
          publicKeyBase64: wrongKey.toString('base64'),
          acceptedAt: '2026-08-01T00:00:00.000Z',
          generation: 1
        }
      })
    ).rejects.toThrow('主机密钥已变化')
    await new Promise((resolve) => setTimeout(resolve, 25))
    expect(harness.passwords).toEqual([])
  })

  it('starts a separate bounded probe deadline after authentication', async () => {
    vi.useFakeTimers()
    try {
      const stream = Object.assign(new EventEmitter(), {
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
            callback: (
              error: Error | undefined,
              output: typeof stream
            ) => void
          ) => callback(undefined, stream)
        )
      })
      const transport = new Ssh2Transport({
        createClient: () => client as never,
        now: () => 0
      })
      const connection = transport.testConnection({
        id: '00000000-0000-4000-8000-000000000106',
        name: 'Timeout test host',
        hostname: '127.0.0.1',
        port: 22,
        username: 'builder',
        authentication: 'password',
        password: 'private password',
        hostKey: {
          algorithm: 'ssh-ed25519',
          publicKeyBase64:
            createHostKeyBlob('ssh-ed25519').toString('base64'),
          fingerprintSha256: `SHA256:${'A'.repeat(43)}`,
          acceptedAt: '2026-08-01T00:00:00.000Z',
          generation: 1
        }
      })
      const rejected = vi.fn()
      void connection.catch(rejected)

      await vi.advanceTimersByTimeAsync(9_999)
      expect(rejected).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(1)
      expect(rejected).toHaveBeenCalledOnce()
      await expect(connection).rejects.toThrow('远端系统探测超时')
      expect(client.end).toHaveBeenCalledOnce()
    } finally {
      vi.useRealTimers()
    }
  })
})

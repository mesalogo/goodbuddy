import { createHash, getCiphers } from 'node:crypto'
import {
  Client,
  type Algorithms,
  type CipherAlgorithm,
  type ConnectConfig,
  type ServerHostKeyAlgorithm
} from 'ssh2'
import type {
  SshHostConnectionTestResult
} from '../../shared/ssh-host-contracts'
import type { ResolvedSshHost } from './ssh-host-store'

export const SSH_CONNECTION_TIMEOUT_MS = 10_000
export const SSH_KEEPALIVE_INTERVAL_MS = 5_000
export const SSH_KEEPALIVE_COUNT_MAX = 2
const PROBE_TIMEOUT_MS = 10_000
const MAX_PROBE_OUTPUT_BYTES = 16 * 1024
const MAX_HOST_KEY_BYTES = 32 * 1024
const PROBE_MARKER = 'GOODBUDDY_SSH_PROBE_V1'
const PROBE_COMMAND = [
  `printf '${PROBE_MARKER}\\n'`,
  "uname -s 2>/dev/null || printf 'unknown\\n'",
  "uname -m 2>/dev/null || printf 'unknown\\n'",
  "printf '%s\\n' \"${SHELL:-unknown}\"",
  "printf '%s\\n' \"${HOME:-unknown}\""
].join('; ')

const strongAlgorithms: Omit<Algorithms, 'cipher'> = {
  kex: [
    'curve25519-sha256',
    'curve25519-sha256@libssh.org',
    'ecdh-sha2-nistp256',
    'ecdh-sha2-nistp384',
    'ecdh-sha2-nistp521',
    'diffie-hellman-group-exchange-sha256',
    'diffie-hellman-group14-sha256',
    'diffie-hellman-group15-sha512',
    'diffie-hellman-group16-sha512',
    'diffie-hellman-group17-sha512',
    'diffie-hellman-group18-sha512'
  ],
  serverHostKey: [
    'ssh-ed25519',
    'ecdsa-sha2-nistp256',
    'ecdsa-sha2-nistp384',
    'ecdsa-sha2-nistp521',
    'rsa-sha2-512',
    'rsa-sha2-256'
  ],
  hmac: [
    'hmac-sha2-512-etm@openssh.com',
    'hmac-sha2-256-etm@openssh.com',
    'hmac-sha2-512',
    'hmac-sha2-256'
  ]
}

const strongCipherCandidates = [
  {
    sshName: 'chacha20-poly1305@openssh.com',
    openSslName: 'chacha20'
  },
  {
    sshName: 'aes256-gcm@openssh.com',
    openSslName: 'aes-256-gcm'
  },
  {
    sshName: 'aes128-gcm@openssh.com',
    openSslName: 'aes-128-gcm'
  },
  { sshName: 'aes256-ctr', openSslName: 'aes-256-ctr' },
  { sshName: 'aes192-ctr', openSslName: 'aes-192-ctr' },
  { sshName: 'aes128-ctr', openSslName: 'aes-128-ctr' }
] as const

export function selectStrongSshCiphers(
  supportedOpenSslCiphers: readonly string[]
): CipherAlgorithm[] {
  const supported = new Set(supportedOpenSslCiphers)
  const selected = strongCipherCandidates
    .filter((candidate) => supported.has(candidate.openSslName))
    .map((candidate) => candidate.sshName)
  if (selected.length === 0) {
    throw new Error('当前运行环境不支持 GoodBuddy 要求的安全 SSH 加密算法')
  }
  return selected
}

export function createStrongSshAlgorithms(
  supportedOpenSslCiphers: readonly string[]
): Algorithms {
  return {
    ...strongAlgorithms,
    cipher: selectStrongSshCiphers(supportedOpenSslCiphers)
  }
}

export type SshConnectionTarget = {
  hostname: string
  port: number
  username: string
}

export type SshHostKeyCandidate = {
  algorithm: string
  publicKeyBase64: string
  fingerprintSha256: string
}

export interface SshTransport {
  inspectHostKey(
    target: SshConnectionTarget
  ): Promise<SshHostKeyCandidate>
  testConnection(
    host: ResolvedSshHost
  ): Promise<Omit<SshHostConnectionTestResult, 'hostId'>>
}

type ClientLike = Pick<Client, 'connect' | 'end' | 'destroy' | 'exec'> & {
  once: Client['once']
  on: Client['on']
}

type SshTransportDependencies = {
  createClient: () => ClientLike
  now: () => number
  supportedOpenSslCiphers: () => readonly string[]
  systemAgent: () => string | undefined
}

function readSshString(
  value: Buffer,
  offset: number
): { value: string; offset: number } {
  if (offset + 4 > value.length) {
    throw new Error('SSH 主机密钥格式无效')
  }
  const length = value.readUInt32BE(offset)
  const start = offset + 4
  const end = start + length
  if (length <= 0 || end > value.length) {
    throw new Error('SSH 主机密钥格式无效')
  }
  return {
    value: value.subarray(start, end).toString('ascii'),
    offset: end
  }
}

export function describeSshHostKey(
  publicKey: Buffer
): SshHostKeyCandidate {
  if (
    publicKey.byteLength === 0 ||
    publicKey.byteLength > MAX_HOST_KEY_BYTES
  ) {
    throw new Error('SSH 主机密钥大小无效')
  }
  const algorithm = readSshString(publicKey, 0).value
  if (
    ![
      'ssh-ed25519',
      'ecdsa-sha2-nistp256',
      'ecdsa-sha2-nistp384',
      'ecdsa-sha2-nistp521',
      'ssh-rsa'
    ].includes(algorithm)
  ) {
    throw new Error('SSH 主机密钥算法不受支持')
  }
  return {
    algorithm,
    publicKeyBase64: publicKey.toString('base64'),
    fingerprintSha256: `SHA256:${createHash('sha256')
      .update(publicKey)
      .digest('base64')
      .replace(/=+$/u, '')}`
  }
}

export function defaultSystemAgent(): string | undefined {
  const configured = process.env.SSH_AUTH_SOCK?.trim()
  if (configured) {
    return configured
  }
  return process.platform === 'win32'
    ? '\\\\.\\pipe\\openssh-ssh-agent'
    : undefined
}

export function safeSshError(error: unknown): Error {
  if (
    error !== null &&
    typeof error === 'object' &&
    'level' in error &&
    typeof error.level === 'string'
  ) {
    if (error.level.includes('client-authentication')) {
      return new Error('SSH 认证失败，请检查用户名和认证凭据')
    }
    if (error.level.includes('client-timeout')) {
      return new Error('SSH 连接超时')
    }
  }
  const code =
    error !== null &&
    typeof error === 'object' &&
    'code' in error &&
    typeof error.code === 'string'
      ? error.code
      : ''
  if (code === 'ENOTFOUND') {
    return new Error('无法解析 SSH 主机地址')
  }
  if (code === 'ECONNREFUSED') {
    return new Error('SSH 主机拒绝连接')
  }
  if (code === 'ETIMEDOUT') {
    return new Error('SSH 连接超时')
  }
  return new Error('无法连接 SSH 主机')
}

function selectPinnedServerHostKeyAlgorithms(
  algorithm: string
): ServerHostKeyAlgorithm[] {
  switch (algorithm) {
    case 'ssh-ed25519':
    case 'ecdsa-sha2-nistp256':
    case 'ecdsa-sha2-nistp384':
    case 'ecdsa-sha2-nistp521':
      return [algorithm]
    case 'ssh-rsa':
      return ['rsa-sha2-512', 'rsa-sha2-256']
    default:
      throw new Error('SSH 主机密钥算法不受支持')
  }
}

export function buildAuthenticatedSshConnectConfig(
  host: ResolvedSshHost,
  algorithms: Algorithms,
  systemAgent: string | undefined,
  onHostKeyMismatch: () => void
): ConnectConfig {
  if (!host.hostKey) {
    throw new Error('请先验证并接受 SSH 主机密钥')
  }
  const publicKey = Buffer.from(
    host.hostKey.publicKeyBase64,
    'base64'
  )
  if (publicKey.byteLength === 0) {
    throw new Error('SSH 主机密钥无效')
  }
  const pinnedAlgorithm = describeSshHostKey(publicKey).algorithm
  const pinnedServerHostKeyAlgorithms =
    selectPinnedServerHostKeyAlgorithms(pinnedAlgorithm)
  const config: ConnectConfig = {
    host: host.hostname,
    port: host.port,
    username: host.username,
    readyTimeout: SSH_CONNECTION_TIMEOUT_MS,
    keepaliveInterval: SSH_KEEPALIVE_INTERVAL_MS,
    keepaliveCountMax: SSH_KEEPALIVE_COUNT_MAX,
    algorithms: {
      ...algorithms,
      serverHostKey: [...pinnedServerHostKeyAlgorithms]
    },
    agentForward: false,
    hostVerifier: (key: Buffer) => {
      const matches = key.equals(publicKey)
      if (!matches) {
        onHostKeyMismatch()
      }
      return matches
    }
  }
  if (host.authentication === 'password') {
    if (!host.password) {
      throw new Error('SSH 主机尚未配置密码')
    }
    config.password = host.password
  } else {
    if (!systemAgent) {
      throw new Error('当前系统未检测到可用的 SSH Agent')
    }
    config.agent = systemAgent
  }
  return config
}

function parseProbeOutput(
  stdout: Buffer,
  latencyMs: number
): Omit<SshHostConnectionTestResult, 'hostId'> {
  const lines = stdout
    .toString('utf8')
    .replaceAll('\r\n', '\n')
    .trimEnd()
    .split('\n')
  if (lines[0] !== PROBE_MARKER || lines.length < 5) {
    throw new Error('SSH 远端系统探测返回了无效结果')
  }
  const platform =
    lines[1] === 'Linux'
      ? 'linux'
      : lines[1] === 'Darwin'
        ? 'darwin'
        : /^MINGW|^MSYS|^CYGWIN|^Windows_NT$/u.test(lines[1] ?? '')
          ? 'win32'
          : 'unknown'
  const architecture =
    /^(x86_64|amd64)$/iu.test(lines[2] ?? '')
      ? 'x64'
      : /^(aarch64|arm64)$/iu.test(lines[2] ?? '')
        ? 'arm64'
        : 'unknown'
  return {
    connected: true,
    latencyMs,
    platform,
    architecture,
    shell: (lines[3] ?? 'unknown').slice(0, 256),
    homeDirectory: (lines[4] ?? 'unknown').slice(0, 4_096),
    detail: `SSH 已连接，远端系统为 ${platform}/${architecture}`
  }
}

export class Ssh2Transport implements SshTransport {
  private readonly dependencies: SshTransportDependencies
  private readonly algorithms: Algorithms

  constructor(
    dependencies: Partial<SshTransportDependencies> = {}
  ) {
    this.dependencies = {
      createClient: () => new Client(),
      now: Date.now,
      supportedOpenSslCiphers: getCiphers,
      systemAgent: defaultSystemAgent,
      ...dependencies
    }
    this.algorithms = createStrongSshAlgorithms(
      this.dependencies.supportedOpenSslCiphers()
    )
  }

  inspectHostKey(
    target: SshConnectionTarget
  ): Promise<SshHostKeyCandidate> {
    return new Promise((resolve, reject) => {
      const client = this.dependencies.createClient()
      let settled = false
      const settle = (
        outcome:
          | { ok: true; value: SshHostKeyCandidate }
          | { ok: false; error: Error }
      ): void => {
        if (settled) {
          return
        }
        settled = true
        clearTimeout(timeout)
        client.destroy()
        if (outcome.ok) {
          resolve(outcome.value)
        } else {
          reject(outcome.error)
        }
      }
      const timeout = setTimeout(
        () =>
          settle({
            ok: false,
            error: new Error('SSH 主机身份检查超时')
          }),
        SSH_CONNECTION_TIMEOUT_MS
      )
      client.once('error', (error) => {
        settle({ ok: false, error: safeSshError(error) })
      })
      client.connect({
        host: target.hostname,
        port: target.port,
        username: target.username,
        readyTimeout: SSH_CONNECTION_TIMEOUT_MS,
        algorithms: this.algorithms,
        agentForward: false,
        hostVerifier: (key: Buffer) => {
          try {
            settle({
              ok: true,
              value: describeSshHostKey(key)
            })
          } catch (error) {
            settle({
              ok: false,
              error:
                error instanceof Error
                  ? error
                  : new Error('SSH 主机密钥无效')
            })
          }
          return false
        }
      })
    })
  }

  testConnection(
    host: ResolvedSshHost
  ): Promise<Omit<SshHostConnectionTestResult, 'hostId'>> {
    if (!host.hostKey) {
      return Promise.reject(
        new Error('请先验证并接受 SSH 主机密钥')
      )
    }
    return new Promise((resolve, reject) => {
      const client = this.dependencies.createClient()
      const startedAt = this.dependencies.now()
      let settled = false
      let hostKeyMismatch = false
      const settle = (
        outcome:
          | {
              ok: true
              value: Omit<SshHostConnectionTestResult, 'hostId'>
            }
          | { ok: false; error: Error }
      ): void => {
        if (settled) {
          return
        }
        settled = true
        clearTimeout(timeout)
        client.end()
        if (outcome.ok) {
          resolve(outcome.value)
        } else {
          reject(outcome.error)
        }
      }
      let timeout = setTimeout(
        () =>
          settle({
            ok: false,
            error: new Error('SSH 连接超时')
          }),
        SSH_CONNECTION_TIMEOUT_MS
      )
      client.once('error', (error) => {
        settle({
          ok: false,
          error: hostKeyMismatch
            ? new Error('SSH 主机密钥已变化，请重新验证主机身份')
            : safeSshError(error)
        })
      })
      client.once('ready', () => {
        clearTimeout(timeout)
        timeout = setTimeout(
          () =>
            settle({
              ok: false,
              error: new Error('SSH 远端系统探测超时')
            }),
          PROBE_TIMEOUT_MS
        )
        client.exec(PROBE_COMMAND, (error, stream) => {
          if (error) {
            settle({
              ok: false,
              error: new Error('无法启动 SSH 远端系统探测')
            })
            return
          }
          const chunks: Buffer[] = []
          let outputBytes = 0
          stream.on('data', (chunk: Buffer | string) => {
            const buffer = Buffer.from(chunk)
            outputBytes += buffer.byteLength
            if (outputBytes > MAX_PROBE_OUTPUT_BYTES) {
              stream.destroy()
              settle({
                ok: false,
                error: new Error('SSH 远端系统探测输出超过安全限制')
              })
              return
            }
            chunks.push(buffer)
          })
          stream.once('error', () => {
            settle({
              ok: false,
              error: new Error('SSH 远端系统探测失败')
            })
          })
          stream.once('close', (code: number | null) => {
            if (code !== 0) {
              settle({
                ok: false,
                error: new Error('SSH 远端系统探测失败')
              })
              return
            }
            try {
              settle({
                ok: true,
                value: parseProbeOutput(
                  Buffer.concat(chunks),
                  Math.max(0, this.dependencies.now() - startedAt)
                )
              })
            } catch (error) {
              settle({
                ok: false,
                error:
                  error instanceof Error
                    ? error
                    : new Error('SSH 远端系统探测失败')
              })
            }
          })
        })
      })
      let config: ConnectConfig
      try {
        config = buildAuthenticatedSshConnectConfig(
          host,
          this.algorithms,
          this.dependencies.systemAgent(),
          () => {
            hostKeyMismatch = true
          }
        )
      } catch (error) {
        settle({
          ok: false,
          error:
            error instanceof Error
              ? error
              : new Error('SSH 认证配置无效')
        })
        return
      }
      client.connect(config)
    })
  }
}

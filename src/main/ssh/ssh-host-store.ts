import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { z } from 'zod'
import {
  SSH_HOST_LIMITS,
  sshAuthenticationKindSchema,
  sshHostCreateInputSchema,
  sshHostUpdateInputSchema,
  type SshHost,
  type SshHostsSnapshot,
  type SshHostUpdateInput
} from '../../shared/ssh-host-contracts'
import {
  decryptSettingsCredential,
  encryptedSettingsCredentialSchema,
  encryptSettingsCredential,
  type SettingsCredentialCipher
} from '../settings-credential-cipher'
import {
  assertSupportedSettingsVersion,
  isolateCorruptSettingsFile,
  isMissingFileError,
  UnsupportedSettingsVersionError,
  writeJsonFileAtomically
} from '../settings-file-utils'

const CURRENT_SETTINGS_VERSION = 1

const storedHostKeySchema = z
  .object({
    algorithm: z.string().min(1).max(64),
    publicKeyBase64: z
      .string()
      .min(1)
      .max(SSH_HOST_LIMITS.maximumHostKeyLength * 2)
      .regex(/^[A-Za-z0-9+/]+={0,2}$/u),
    fingerprintSha256: z
      .string()
      .regex(/^SHA256:[A-Za-z0-9+/]{43}$/u),
    acceptedAt: z.string().datetime({ offset: true }),
    generation: z.number().int().positive()
  })
  .strict()

const encryptedCredentialSchema = encryptedSettingsCredentialSchema
  .extend({
    ciphertextBase64: z
      .string()
      .min(1)
      .max(SSH_HOST_LIMITS.maximumPasswordLength * 8)
      .regex(/^[A-Za-z0-9+/]+={0,2}$/u)
  })
  .strict()

const storedHostSchema = z
  .object({
    id: z.string().uuid(),
    name: sshHostCreateInputSchema.shape.name,
    hostname: sshHostCreateInputSchema.shape.hostname,
    port: sshHostCreateInputSchema.shape.port,
    username: sshHostCreateInputSchema.shape.username,
    authentication: sshAuthenticationKindSchema,
    credential: encryptedCredentialSchema.optional(),
    hostKey: storedHostKeySchema.optional(),
    hostKeyGeneration: z.number().int().nonnegative(),
    revision: z.number().int().nonnegative().default(0),
    lastValidatedAt: z
      .string()
      .datetime({ offset: true })
      .optional(),
    createdAt: z.string().datetime({ offset: true }),
    updatedAt: z.string().datetime({ offset: true })
  })
  .strict()
  .superRefine((host, context) => {
    if (
      host.hostKey &&
      host.hostKey.generation !== host.hostKeyGeneration
    ) {
      context.addIssue({
        code: 'custom',
        path: ['hostKeyGeneration'],
        message: 'SSH 主机密钥代际不一致'
      })
    }
  })

const storedSettingsSchema = z
  .object({
    version: z.literal(CURRENT_SETTINGS_VERSION),
    hosts: z.array(storedHostSchema).max(SSH_HOST_LIMITS.maximumHosts)
  })
  .strict()

const credentialPayloadSchema = z
  .object({
    version: z.literal(1),
    hostId: z.string().uuid(),
    authentication: z.literal('password'),
    hostname: sshHostCreateInputSchema.shape.hostname,
    port: sshHostCreateInputSchema.shape.port,
    username: sshHostCreateInputSchema.shape.username,
    password: z
      .string()
      .min(1)
      .max(SSH_HOST_LIMITS.maximumPasswordLength)
  })
  .strict()

type StoredSettings = z.infer<typeof storedSettingsSchema>
type StoredHost = z.infer<typeof storedHostSchema>
type StoredHostKey = z.infer<typeof storedHostKeySchema>
type CredentialPayload = z.infer<typeof credentialPayloadSchema>

export type ResolvedSshHost = {
  id: string
  name: string
  hostname: string
  port: number
  username: string
  authentication: SshHost['authentication']
  password?: string
  hostKey?: Pick<
    StoredHostKey,
    'algorithm' | 'publicKeyBase64' | 'fingerprintSha256'
  > &
    Partial<Pick<StoredHostKey, 'acceptedAt' | 'generation'>>
}

export type SshHostIdentity = {
  id: string
  hostname: string
  port: number
  username: string
  revision: number
  hostKey?: {
    algorithm: string
    publicKeyBase64: string
    fingerprintSha256: string
    generation: number
  }
}

export type SshConnectionTarget = {
  host: ResolvedSshHost
  hostRevision: number
  hostKeyGeneration: number
}

export type CurrentSshConnectionTarget = Readonly<{
  hostId: string
  hostRevision: number
  hostKeyGeneration: number
  username: string
}>

export type ValidatedSshHostCommit = {
  hostId?: string
  expectedRevision?: number
  input: SshHostUpdateInput
  hostKey: {
    algorithm: string
    publicKeyBase64: string
    fingerprintSha256: string
  }
}

const defaultSettings: StoredSettings = {
  version: CURRENT_SETTINGS_VERSION,
  hosts: []
}

function cloneSettings(settings: StoredSettings): StoredSettings {
  return structuredClone(settings)
}

function targetChanged(
  current: StoredHost,
  input: SshHostUpdateInput
): boolean {
  return (
    current.hostname !== input.hostname ||
    current.port !== input.port ||
    current.username !== input.username ||
    current.authentication !== input.authentication
  )
}

function credentialMatchesHost(
  payload: CredentialPayload,
  host: StoredHost
): boolean {
  return (
    payload.hostId === host.id &&
    payload.authentication === host.authentication &&
    payload.hostname === host.hostname &&
    payload.port === host.port &&
    payload.username === host.username
  )
}

export class SshHostStore {
  private settings?: StoredSettings
  private settingsLoad?: Promise<StoredSettings>
  private updateQueue: Promise<void> = Promise.resolve()
  private readonly credentialSourceCache = new Map<
    string,
    {
      credential: NonNullable<StoredHost['credential']>
      secureStorageAvailable: boolean
      hostname: string
      port: number
      username: string
      source: Extract<
        SshHost['credentialSource'],
        'encrypted' | 'unreadable'
      >
    }
  >()

  constructor(
    private readonly filePath: string,
    private readonly cipher: SettingsCredentialCipher,
    private readonly now: () => Date = () => new Date()
  ) {}

  async getSnapshot(): Promise<SshHostsSnapshot> {
    const settings = await this.load()
    return {
      hosts: settings.hosts.map((host) => this.toPublicHost(host)),
      secureStorageAvailable: this.cipher.isAvailable()
    }
  }

  isSecureStorageAvailable(): boolean {
    return this.cipher.isAvailable()
  }

  commitValidated(
    commit: ValidatedSshHostCommit
  ): Promise<SshHost> {
    const parsed = commit.hostId
      ? sshHostUpdateInputSchema.parse(commit.input)
      : sshHostCreateInputSchema.parse(commit.input)
    return this.queue(async () => {
      const settings = cloneSettings(await this.load())
      const timestamp = this.now().toISOString()

      if (!commit.hostId) {
        if (settings.hosts.length >= SSH_HOST_LIMITS.maximumHosts) {
          throw new Error(
            `SSH 主机数量不能超过 ${SSH_HOST_LIMITS.maximumHosts}`
          )
        }
        const id = randomUUID()
        const host: StoredHost = storedHostSchema.parse({
          id,
          name: parsed.name,
          hostname: parsed.hostname,
          port: parsed.port,
          username: parsed.username,
          authentication: parsed.authentication,
          ...(parsed.authentication === 'password' &&
          parsed.password.action === 'replace'
            ? {
                credential: this.encryptPassword(
                  id,
                  {
                    hostname: parsed.hostname,
                    port: parsed.port,
                    username: parsed.username
                  },
                  parsed.password.value
                )
              }
            : {}),
          hostKey: {
            ...commit.hostKey,
            acceptedAt: timestamp,
            generation: 1
          },
          hostKeyGeneration: 1,
          revision: 1,
          lastValidatedAt: timestamp,
          createdAt: timestamp,
          updatedAt: timestamp
        })
        settings.hosts.push(host)
        await this.persist(settings)
        this.settings = settings
        return this.toPublicHost(host)
      }

      const index = settings.hosts.findIndex(
        (host) => host.id === commit.hostId
      )
      const current = settings.hosts[index]
      if (!current) {
        throw new Error('SSH 主机不存在')
      }
      if (
        commit.expectedRevision === undefined ||
        current.revision !== commit.expectedRevision
      ) {
        throw new Error('SSH 主机配置已变化，请重新验证')
      }
      const changedTarget = targetChanged(current, parsed)
      if (
        current.credential &&
        changedTarget &&
        parsed.password.action === 'keep'
      ) {
        throw new Error(
          '主机地址、端口、用户名或认证方式已变化，请重新输入密码'
        )
      }
      let credential =
        parsed.password.action === 'keep'
          ? current.credential
          : undefined
      if (
        parsed.authentication === 'password' &&
        parsed.password.action === 'replace'
      ) {
        credential = this.encryptPassword(
          current.id,
          {
            hostname: parsed.hostname,
            port: parsed.port,
            username: parsed.username
          },
          parsed.password.value
        )
      }
      if (parsed.authentication === 'password' && !credential) {
        throw new Error('SSH 密码不能为空')
      }
      const generation =
        !changedTarget &&
        current.hostKey?.publicKeyBase64 ===
          commit.hostKey.publicKeyBase64
          ? current.hostKey.generation
          : current.hostKeyGeneration + 1
      const next: StoredHost = storedHostSchema.parse({
        ...current,
        name: parsed.name,
        hostname: parsed.hostname,
        port: parsed.port,
        username: parsed.username,
        authentication: parsed.authentication,
        ...(credential ? { credential } : { credential: undefined }),
        hostKey: {
          ...commit.hostKey,
          acceptedAt: timestamp,
          generation
        },
        hostKeyGeneration: generation,
        revision: current.revision + 1,
        lastValidatedAt: timestamp,
        updatedAt: timestamp
      })
      settings.hosts[index] = next
      await this.persist(settings)
      this.settings = settings
      return this.toPublicHost(next)
    })
  }

  remove(hostId: string): Promise<void> {
    return this.queue(async () => {
      const settings = cloneSettings(await this.load())
      const index = settings.hosts.findIndex(
        (host) => host.id === hostId
      )
      if (index === -1) {
        throw new Error('SSH 主机不存在')
      }
      settings.hosts.splice(index, 1)
      await this.persist(settings)
      this.settings = settings
      this.credentialSourceCache.delete(hostId)
    })
  }

  async resolveHost(hostId: string): Promise<ResolvedSshHost> {
    const host = await this.getStoredHost(hostId)
    return this.resolveStoredHost(host)
  }

  resolveConnectionTarget(
    hostId: string
  ): Promise<SshConnectionTarget> {
    return this.queue(async () => {
      const host = (await this.load()).hosts.find(
        (candidate) => candidate.id === hostId
      )
      if (!host) {
        throw new Error('SSH 主机不存在')
      }
      const snapshot = structuredClone(host)
      return {
        host: this.resolveStoredHost(snapshot),
        hostRevision: snapshot.revision,
        hostKeyGeneration: snapshot.hostKeyGeneration
      }
    })
  }

  /**
   * Synchronous transaction precondition for callers that already resolved a
   * target. It deliberately consults only loaded, credential-free metadata so
   * it is safe to call from inside a SQLite transaction.
   */
  assertConnectionTargetCurrent(
    expected: CurrentSshConnectionTarget
  ): void {
    const settings = this.settings
    if (!settings) {
      throw new Error('SSH 主机当前状态尚未加载')
    }
    const host = settings.hosts.find(
      (candidate) => candidate.id === expected.hostId
    )
    if (
      !host ||
      host.revision !== expected.hostRevision ||
      host.hostKeyGeneration !== expected.hostKeyGeneration ||
      host.username !== expected.username ||
      !host.hostKey ||
      host.hostKey.generation !== expected.hostKeyGeneration
    ) {
      throw new Error('SSH 主机配置已变化，请重新验证')
    }
  }

  private resolveStoredHost(host: StoredHost): ResolvedSshHost {
    if (host.authentication === 'system-agent') {
      return {
        id: host.id,
        name: host.name,
        hostname: host.hostname,
        port: host.port,
        username: host.username,
        authentication: host.authentication,
        hostKey: host.hostKey
      }
    }
    if (!host.credential) {
      throw new Error('SSH 主机尚未配置密码')
    }
    const payload = credentialPayloadSchema.parse(
      decryptSettingsCredential(this.cipher, host.credential)
    )
    if (!credentialMatchesHost(payload, host)) {
      throw new Error('SSH 主机凭据与当前主机不匹配')
    }
    return {
      id: host.id,
      name: host.name,
      hostname: host.hostname,
      port: host.port,
      username: host.username,
      authentication: host.authentication,
      password: payload.password,
      hostKey: host.hostKey
    }
  }

  private async getStoredHost(hostId: string): Promise<StoredHost> {
    const host = (await this.load()).hosts.find(
      (candidate) => candidate.id === hostId
    )
    if (!host) {
      throw new Error('SSH 主机不存在')
    }
    return structuredClone(host)
  }

  async getHostIdentity(hostId: string): Promise<SshHostIdentity> {
    const host = await this.getStoredHost(hostId)
    return {
      id: host.id,
      hostname: host.hostname,
      port: host.port,
      username: host.username,
      revision: host.revision,
      ...(host.hostKey
        ? {
            hostKey: {
              algorithm: host.hostKey.algorithm,
              publicKeyBase64: host.hostKey.publicKeyBase64,
              fingerprintSha256:
                host.hostKey.fingerprintSha256,
              generation: host.hostKeyGeneration
            }
          }
        : {})
    }
  }

  private encryptPassword(
    hostId: string,
    target: {
      hostname: string
      port: number
      username: string
    },
    password: string
  ): StoredHost['credential'] {
    if (!password) {
      throw new Error('SSH 密码不能为空')
    }
    if (!this.cipher.isAvailable()) {
      throw new Error('系统安全存储不可用，无法保存 SSH 密码')
    }
    return encryptSettingsCredential(this.cipher, {
      version: 1,
      hostId,
      authentication: 'password',
      ...target,
      password
    })
  }

  private toPublicHost(host: StoredHost): SshHost {
    let credentialSource: SshHost['credentialSource']
    if (host.authentication === 'system-agent') {
      this.credentialSourceCache.delete(host.id)
      credentialSource = 'system-agent'
    } else if (!host.credential) {
      this.credentialSourceCache.delete(host.id)
      credentialSource = 'none'
    } else {
      const secureStorageAvailable = this.cipher.isAvailable()
      const cached = this.credentialSourceCache.get(host.id)
      if (
        cached?.credential === host.credential &&
        cached.secureStorageAvailable === secureStorageAvailable &&
        cached.hostname === host.hostname &&
        cached.port === host.port &&
        cached.username === host.username
      ) {
        credentialSource = cached.source
      } else {
        try {
          const payload = credentialPayloadSchema.parse(
            decryptSettingsCredential(this.cipher, host.credential)
          )
          credentialSource =
            credentialMatchesHost(payload, host)
              ? 'encrypted'
              : 'unreadable'
        } catch {
          credentialSource = 'unreadable'
        }
        this.credentialSourceCache.set(host.id, {
          credential: host.credential,
          secureStorageAvailable,
          hostname: host.hostname,
          port: host.port,
          username: host.username,
          source: credentialSource
        })
      }
    }
    return {
      id: host.id,
      name: host.name,
      hostname: host.hostname,
      port: host.port,
      username: host.username,
      authentication: host.authentication,
      credentialConfigured:
        credentialSource === 'encrypted' ||
        credentialSource === 'system-agent',
      credentialSource,
      hostKey: host.hostKey
        ? {
            state: 'verified',
            algorithm: host.hostKey.algorithm,
            fingerprintSha256:
              host.hostKey.fingerprintSha256,
            generation: host.hostKeyGeneration
          }
        : {
            state: 'unverified',
            generation: host.hostKeyGeneration
          },
      ...(host.lastValidatedAt
        ? { lastValidatedAt: host.lastValidatedAt }
        : {}),
      createdAt: host.createdAt,
      updatedAt: host.updatedAt
    }
  }

  private queue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.updateQueue.then(operation, operation)
    this.updateQueue = result.then(
      () => undefined,
      () => undefined
    )
    return result
  }

  private async load(): Promise<StoredSettings> {
    if (this.settings) {
      return this.settings
    }
    if (!this.settingsLoad) {
      this.settingsLoad = this.readStored().finally(() => {
        this.settingsLoad = undefined
      })
    }
    return this.settingsLoad
  }

  private async readStored(): Promise<StoredSettings> {
    this.credentialSourceCache.clear()
    try {
      const contents = await readFile(this.filePath, 'utf8')
      let parsed: unknown
      try {
        parsed = JSON.parse(contents) as unknown
      } catch {
        await this.isolateCorruptFile()
        this.settings = cloneSettings(defaultSettings)
        return this.settings
      }
      assertSupportedSettingsVersion(
        parsed,
        CURRENT_SETTINGS_VERSION,
        (version) =>
          `当前 GoodBuddy 不支持 SSH 主机设置版本 ${version}，请升级应用后重试`
      )
      const result = storedSettingsSchema.safeParse(parsed)
      if (!result.success) {
        await this.isolateCorruptFile()
        this.settings = cloneSettings(defaultSettings)
        return this.settings
      }
      this.settings = result.data
      return this.settings
    } catch (error) {
      if (error instanceof UnsupportedSettingsVersionError) {
        throw error
      }
      if (!isMissingFileError(error)) {
        throw new Error('SSH 主机设置读取失败', { cause: error })
      }
      this.settings = cloneSettings(defaultSettings)
      return this.settings
    }
  }

  private async isolateCorruptFile(): Promise<void> {
    await isolateCorruptSettingsFile(
      this.filePath,
      'SSH 主机设置损坏且无法隔离'
    )
  }

  private async persist(settings: StoredSettings): Promise<void> {
    await writeJsonFileAtomically(
      this.filePath,
      storedSettingsSchema.parse(settings)
    )
  }
}

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { z } from 'zod'
import {
  defaultRuntimeSettings,
  runtimeProviderSchema,
  toolApprovalPolicySchema,
  RuntimeSettings,
  type RuntimeSettingsInput
} from '../shared/contracts'

const storedSettingsSchema = z.object({
  version: z.literal(1),
  provider: runtimeProviderSchema,
  bigtokenBaseUrl: z.string(),
  bigtokenModel: z.string(),
  credential: z
    .object({
      formatVersion: z.literal(1),
      scheme: z.literal('electron-safe-storage'),
      ciphertextBase64: z.string()
    })
    .optional(),
  toolApproval: toolApprovalPolicySchema
})

type StoredSettings = z.infer<typeof storedSettingsSchema>

const credentialPayloadSchema = z.object({
  version: z.literal(1),
  apiKey: z.string(),
  origin: z.string()
})

export type CredentialCipher = {
  isAvailable: () => boolean
  encrypt: (value: string) => Buffer
  decrypt: (value: Buffer) => string
}

export type ResolvedRuntimeSettings = {
  provider: RuntimeSettings['provider']
  bigtokenBaseUrl: string
  bigtokenModel: string
  apiKey?: string
  toolApproval: RuntimeSettings['toolApproval']
}

const defaultSettings: StoredSettings = {
  version: 1,
  ...defaultRuntimeSettings
}

export class RuntimeSettingsStore {
  private settings?: StoredSettings
  private updateQueue: Promise<void> = Promise.resolve()

  constructor(
    private readonly filePath: string,
    private readonly cipher: CredentialCipher,
    private readonly environment: NodeJS.ProcessEnv = process.env
  ) {}

  private async load(): Promise<StoredSettings> {
    if (this.settings) {
      return this.settings
    }

    try {
      const contents = await readFile(this.filePath, 'utf8')
      this.settings = storedSettingsSchema.parse(JSON.parse(contents))
    } catch {
      this.settings = { ...defaultSettings }
    }
    return this.settings
  }

  private getStoredApiKey(settings: StoredSettings): string | undefined {
    if (!settings.credential || !this.cipher.isAvailable()) {
      return undefined
    }
    try {
      const payload = credentialPayloadSchema.parse(
        JSON.parse(
          this.cipher.decrypt(
            Buffer.from(settings.credential.ciphertextBase64, 'base64')
          )
        )
      )
      return payload.origin === new URL(settings.bigtokenBaseUrl).origin
        ? payload.apiKey
        : undefined
    } catch {
      return undefined
    }
  }

  private getEnvironmentApiKey(): string | undefined {
    return this.environment.GOODBUDDY_BIGTOKEN_API_KEY?.trim() || undefined
  }

  private resolveEffectiveBigtokenSettings(settings: StoredSettings): {
    apiKey?: string
    baseUrl: string
    model: string
    credentialSource: RuntimeSettings['credentialSource']
  } {
    const environmentApiKey = this.getEnvironmentApiKey()
    const storedApiKey = this.getStoredApiKey(settings)
    const environmentBaseUrl =
      this.environment.GOODBUDDY_BIGTOKEN_BASE_URL?.trim()
    const environmentModel = this.environment.GOODBUDDY_BIGTOKEN_MODEL?.trim()
    return {
      apiKey: environmentApiKey ?? storedApiKey,
      baseUrl: environmentApiKey
        ? environmentBaseUrl || defaultSettings.bigtokenBaseUrl
        : settings.bigtokenBaseUrl,
      model: environmentApiKey
        ? environmentModel || defaultSettings.bigtokenModel
        : settings.bigtokenModel,
      credentialSource: environmentApiKey
        ? 'environment'
        : storedApiKey
          ? 'encrypted'
          : 'none'
    }
  }

  private toPublicSettings(settings: StoredSettings): RuntimeSettings {
    const effective = this.resolveEffectiveBigtokenSettings(settings)
    return {
      provider: settings.provider,
      bigtokenBaseUrl: effective.baseUrl,
      bigtokenModel: effective.model,
      apiKeyConfigured: Boolean(effective.apiKey),
      credentialSource: effective.credentialSource,
      secureStorageAvailable: this.cipher.isAvailable(),
      toolApproval: settings.toolApproval
    }
  }

  async getPublicSettings(): Promise<RuntimeSettings> {
    return this.toPublicSettings(await this.load())
  }

  async getResolvedSettings(): Promise<ResolvedRuntimeSettings> {
    const settings = await this.load()
    const effective = this.resolveEffectiveBigtokenSettings(settings)
    return {
      provider: settings.provider,
      bigtokenBaseUrl: effective.baseUrl,
      bigtokenModel: effective.model,
      apiKey: effective.apiKey,
      toolApproval: settings.toolApproval
    }
  }

  update(input: RuntimeSettingsInput): Promise<RuntimeSettings> {
    const operation = this.updateQueue.then(() => this.performUpdate(input))
    this.updateQueue = operation.then(
      () => undefined,
      () => undefined
    )
    return operation
  }

  private async performUpdate(
    input: RuntimeSettingsInput
  ): Promise<RuntimeSettings> {
    const current = await this.load()
    const normalizedOrigin = new URL(input.bigtokenBaseUrl).origin
    const previousOrigin = new URL(current.bigtokenBaseUrl).origin
    if (
      input.apiKey.action === 'keep' &&
      current.credential &&
      previousOrigin !== normalizedOrigin
    ) {
      throw new Error('服务地址已更改，请重新输入或清除已保存的 API Key')
    }

    const next: StoredSettings = {
      ...current,
      provider: input.provider,
      bigtokenBaseUrl: normalizedOrigin,
      bigtokenModel: input.bigtokenModel,
      toolApproval: input.toolApproval
    }

    if (input.apiKey.action === 'clear') {
      delete next.credential
    } else if (input.apiKey.action === 'replace') {
      if (!this.cipher.isAvailable()) {
        throw new Error(
          '当前系统安全存储不可用，API Key 未保存。请启用系统密钥服务或使用环境变量。'
        )
      }
      next.credential = {
        formatVersion: 1,
        scheme: 'electron-safe-storage',
        ciphertextBase64: this.cipher
          .encrypt(
            JSON.stringify({
              version: 1,
              apiKey: input.apiKey.value,
              origin: normalizedOrigin
            })
          )
          .toString('base64')
      }
    }

    await mkdir(dirname(this.filePath), { recursive: true })
    const temporaryPath = `${this.filePath}.${process.pid}.tmp`
    await writeFile(temporaryPath, `${JSON.stringify(next, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600
    })
    await rename(temporaryPath, this.filePath)
    this.settings = next
    return this.toPublicSettings(next)
  }
}

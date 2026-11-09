import { readFile } from 'node:fs/promises'
import { z } from 'zod'
import { speechSettingsSchema, speechSettingsUpdateSchema, type SpeechSettingsSnapshot } from '../../shared/speech-settings-contracts'
import { decryptSettingsCredential, encryptSettingsCredential, encryptedSettingsCredentialSchema, type SettingsCredentialCipher } from '../settings-credential-cipher'
import { isMissingFileError, writeJsonFileAtomically } from '../settings-file-utils'

const storedSchema = z.object({
  version: z.literal(1),
  settings: speechSettingsSchema,
  credential: encryptedSettingsCredentialSchema.optional()
}).strict()
type Stored = z.infer<typeof storedSchema>

export class SpeechSettingsStore {
  private loading?: Promise<Stored>
  private queue: Promise<unknown> = Promise.resolve()

  constructor(private readonly path: string, private readonly cipher: SettingsCredentialCipher) {}

  private load(): Promise<Stored> {
    this.loading ??= readFile(this.path, 'utf8').then(text => storedSchema.parse(JSON.parse(text))).catch(error => {
      this.loading = undefined
      if (!isMissingFileError(error)) throw new Error('无法读取语音识别设置', { cause: error })
      return { version: 1 as const, settings: speechSettingsSchema.parse({}) }
    })
    return this.loading
  }

  async get(): Promise<SpeechSettingsSnapshot> {
    const stored = await this.load()
    return { settings: { ...stored.settings }, apiKeyConfigured: Boolean(stored.credential), secureStorageAvailable: this.cipher.isAvailable() }
  }

  async resolve(): Promise<{ settings: Stored['settings']; apiKey?: string }> {
    const stored = await this.load()
    if (stored.settings.provider === 'local' || !stored.credential) return { settings: { ...stored.settings } }
    if (!this.cipher.isAvailable()) throw new Error('语音识别凭据加密存储不可用')
    return { settings: { ...stored.settings }, apiKey: z.string().min(1).parse(decryptSettingsCredential(this.cipher, stored.credential)) }
  }

  update(input: unknown): Promise<SpeechSettingsSnapshot> {
    const parsed = speechSettingsUpdateSchema.parse(input)
    const operation = this.queue.then(async () => {
      const previous = await this.load()
      let credential = previous.credential
      if (parsed.apiKey.action === 'clear') credential = undefined
      if (parsed.apiKey.action === 'replace') {
        if (!this.cipher.isAvailable()) throw new Error('语音识别凭据加密存储不可用')
        credential = encryptSettingsCredential(this.cipher, parsed.apiKey.value)
      }
      const next: Stored = { version: 1, settings: parsed.settings, credential }
      await writeJsonFileAtomically(this.path, next)
      this.loading = Promise.resolve(next)
      return this.get()
    })
    this.queue = operation.catch(() => undefined)
    return operation
  }
}

import { z } from 'zod'

export interface SettingsCredentialCipher {
  isAvailable(): boolean
  encrypt(value: string): Buffer
  decrypt(value: Buffer): string
}

export const encryptedSettingsCredentialSchema = z.object({
  formatVersion: z.literal(1),
  scheme: z.literal('electron-safe-storage'),
  ciphertextBase64: z.string()
})

export type EncryptedSettingsCredential = z.infer<
  typeof encryptedSettingsCredentialSchema
>

export function encryptSettingsCredential(
  cipher: SettingsCredentialCipher,
  payload: unknown
): EncryptedSettingsCredential {
  return {
    formatVersion: 1,
    scheme: 'electron-safe-storage',
    ciphertextBase64: cipher
      .encrypt(JSON.stringify(payload))
      .toString('base64')
  }
}

export function decryptSettingsCredential(
  cipher: SettingsCredentialCipher,
  credential: EncryptedSettingsCredential
): unknown {
  return JSON.parse(
    cipher.decrypt(
      Buffer.from(credential.ciphertextBase64, 'base64')
    )
  ) as unknown
}

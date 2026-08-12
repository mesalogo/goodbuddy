import { createHash } from 'node:crypto'

export interface EmbeddingProviderIdentity {
  readonly provider: string
  readonly fingerprint?: string
}

export function embeddingStorageProvider(
  provider: EmbeddingProviderIdentity
): string {
  const name = provider.provider.trim()
  const fingerprint = provider.fingerprint?.trim()
  if (!fingerprint) {
    return name
  }
  const digest = createHash('sha256')
    .update(fingerprint)
    .digest('hex')
    .slice(0, 32)
  return `${name.slice(0, 80)}@${digest}`
}

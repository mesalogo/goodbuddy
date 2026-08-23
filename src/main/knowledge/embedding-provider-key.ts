import { createHash } from 'node:crypto'

export interface EmbeddingProviderIdentity {
  readonly provider: string
  readonly fingerprint?: string
}

export interface EmbeddingProviderFingerprintFields {
  readonly provider: string
  readonly endpoint?: string
  readonly dataPath?: unknown
  readonly model: string
  readonly dimensions?: number
  readonly encodingRecipe?: unknown
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`
  }
  const record = value as Record<string, unknown>
  return `{${Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(',')}}`
}

export function embeddingProviderFingerprint(
  fields: EmbeddingProviderFingerprintFields
): string {
  return `embedding-v1:${createHash('sha256')
    .update(canonicalJson(fields))
    .digest('hex')}`
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

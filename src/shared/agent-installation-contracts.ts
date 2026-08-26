import { z } from 'zod'

const versionPattern =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+((?:[0-9a-zA-Z-]+)(?:\.[0-9a-zA-Z-]+)*))?$/u
const sha256Pattern = /^[a-f0-9]{64}$/u
const keyIdPattern = /^[a-z0-9][a-z0-9._-]{0,63}$/u
const canonicalBase64Pattern =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u
const canonicalDoublePaddingCharacterPattern = /[AQgw]==$/u
const canonicalSinglePaddingCharacterPattern =
  /[AEIMQUYcgkosw048]=$/u

function hasCanonicalBase64Padding(value: string): boolean {
  if (value.endsWith('==')) {
    return canonicalDoublePaddingCharacterPattern.test(value)
  }
  if (value.endsWith('=')) {
    return canonicalSinglePaddingCharacterPattern.test(value)
  }
  return true
}

export const agentArchitectureSchema = z.enum(['x64', 'arm64'])

export const componentVersionSchema = z
  .string()
  .max(128)
  .regex(versionPattern)

export type AgentArchitecture = z.infer<
  typeof agentArchitectureSchema
>

export const agentProtocolVersionSchema = z
  .object({
    major: z.number().int().min(0).max(65_535).safe(),
    minor: z.number().int().min(0).max(65_535).safe()
  })
  .strict()

export const agentManifestPathSchema = z
  .string()
  .min(1)
  .max(240)
  .refine(isSafeAgentManifestPath, 'Unsafe Agent manifest path')

export const agentManifestFileSchema = z
  .object({
    path: agentManifestPathSchema,
    size: z.number().int().min(0).safe(),
    sha256: z.string().regex(sha256Pattern),
    mode: z.enum(['0644', '0755'])
  })
  .strict()
  .superRefine((file, context) => {
    const expectedMode = expectedAgentManifestMode(file.path)
    if (file.mode !== expectedMode) {
      context.addIssue({
        code: 'custom',
        path: ['mode'],
        message: `Agent payload mode must be ${expectedMode}`
      })
    }
  })

export type AgentManifestFile = z.infer<
  typeof agentManifestFileSchema
>

export const agentManifestLicenseSchema = z
  .object({
    package: z.string().trim().min(1).max(200),
    version: z.string().trim().min(1).max(128),
    spdx: z.string().trim().min(1).max(128),
    path: agentManifestPathSchema
  })
  .strict()

export const agentBundleManifestSchema = z
  .object({
    formatVersion: z.literal(1),
    product: z.literal('GoodBuddy'),
    agentVersion: componentVersionSchema,
    platform: z.literal('linux'),
    arch: agentArchitectureSchema,
    protocol: agentProtocolVersionSchema,
    signingKeyId: z.string().regex(keyIdPattern),
    entrypoint: z
      .object({
        path: z.literal('goodbuddy-agent'),
        runtimePath: z.literal('node'),
        scriptPath: z.literal('lib/agent.cjs')
      })
      .strict(),
    files: z.array(agentManifestFileSchema).min(1).max(10_000),
    licenses: z.array(agentManifestLicenseSchema).min(1).max(1_000)
  })
  .strict()
  .superRefine((manifest, context) => {
    const declaredPaths = new Set<string>()
    manifest.files.forEach((file, index) => {
      if (
        file.path === 'manifest.json' ||
        file.path === 'manifest.sig'
      ) {
        context.addIssue({
          code: 'custom',
          path: ['files', index, 'path'],
          message: 'Agent payload cannot declare signature metadata'
        })
      }
      if (declaredPaths.has(file.path)) {
        context.addIssue({
          code: 'custom',
          path: ['files', index, 'path'],
          message: 'Agent manifest file paths must be unique'
        })
      }
      declaredPaths.add(file.path)
    })

    const licensedPaths = new Set<string>()
    manifest.licenses.forEach((license, index) => {
      if (licensedPaths.has(license.path)) {
        context.addIssue({
          code: 'custom',
          path: ['licenses', index, 'path'],
          message: 'Agent manifest license paths must be unique'
        })
      }
      if (!declaredPaths.has(license.path)) {
        context.addIssue({
          code: 'custom',
          path: ['licenses', index, 'path'],
          message: 'Agent manifest license must name a declared file'
        })
      }
      licensedPaths.add(license.path)
    })

    for (const path of [
      manifest.entrypoint.path,
      manifest.entrypoint.runtimePath,
      manifest.entrypoint.scriptPath
    ]) {
      if (!declaredPaths.has(path)) {
        context.addIssue({
          code: 'custom',
          path: ['entrypoint'],
          message: `Agent entrypoint payload is missing: ${path}`
        })
      }
    }
  })

export type AgentBundleManifest = z.infer<
  typeof agentBundleManifestSchema
>

export const agentReleaseKeySchema = z
  .object({
    keyId: z.string().regex(keyIdPattern),
    publicKeySpkiBase64: z
      .string()
      .min(4)
      .max(4_096)
      .regex(canonicalBase64Pattern)
      .refine(
        hasCanonicalBase64Padding,
        'Agent public key must use canonical Base64'
      ),
    environment: z.enum(['production', 'test'])
  })
  .strict()

export type AgentReleaseKey = z.infer<typeof agentReleaseKeySchema>

export const agentReleaseKeyRevocationSchema = z
  .object({
    keyId: z.string().regex(keyIdPattern)
  })
  .strict()

export const agentReleaseKeyRegistrySchema = z
  .object({
    formatVersion: z.literal(1),
    keys: z.array(agentReleaseKeySchema).max(1_000),
    revocations: z.array(agentReleaseKeyRevocationSchema).max(1_000)
  })
  .strict()
  .superRefine((registry, context) => {
    addDuplicateKeyIssues(
      registry.keys,
      'keys',
      context
    )
    addDuplicateKeyIssues(
      registry.revocations,
      'revocations',
      context
    )
  })

export type AgentReleaseKeyRegistry = z.infer<
  typeof agentReleaseKeyRegistrySchema
>

const lockedRuntimePathSchema = z
  .string()
  .min(1)
  .max(512)
  .refine(isSafeAgentManifestPath, 'Unsafe locked runtime path')

const lockedNodeTargetSchema = z
  .object({
    archive: z
      .string()
      .min(1)
      .max(240)
      .refine(
        (value) =>
          !value.includes('/') &&
          !value.includes('\\') &&
          value !== '.' &&
          value !== '..',
        'Locked Node archive name is invalid'
      ),
    sha256: z.string().regex(sha256Pattern),
    binaryPath: lockedRuntimePathSchema,
    licensePath: lockedRuntimePathSchema
  })
  .strict()

export const agentRuntimeLockSchema = z
  .object({
    formatVersion: z.literal(1),
    agentVersion: componentVersionSchema,
    protocol: agentProtocolVersionSchema,
    node: z
      .object({
        version: z.literal('24.19.0'),
        source: z
          .url()
          .refine(
            (value) => new URL(value).protocol === 'https:',
            'Locked Node source must use HTTPS'
          ),
        targets: z
          .object({
            'linux-x64': lockedNodeTargetSchema,
            'linux-arm64': lockedNodeTargetSchema
          })
          .strict()
      })
      .strict(),
    koffi: z
      .object({
        version: z.literal('3.1.4')
      })
      .strict()
  })
  .strict()

export type AgentRuntimeLock = z.infer<typeof agentRuntimeLockSchema>

export function isSafeAgentManifestPath(filePath: string): boolean {
  return (
    filePath.length > 0 &&
    filePath.length <= 512 &&
    !filePath.includes('\\') &&
    !filePath.includes('\0') &&
    !filePath.startsWith('/') &&
    !filePath
      .split('/')
      .some(
        (part) => part.length === 0 || part === '.' || part === '..'
      )
  )
}

export function expectedAgentManifestMode(
  filePath: string
): '0644' | '0755' {
  return filePath === 'node' ||
    filePath === 'goodbuddy-agent' ||
    filePath.startsWith('helpers/')
    ? '0755'
    : '0644'
}

function addDuplicateKeyIssues(
  entries: readonly { keyId: string }[],
  path: 'keys' | 'revocations',
  context: z.RefinementCtx
): void {
  const ids = new Set<string>()
  entries.forEach((entry, index) => {
    if (ids.has(entry.keyId)) {
      context.addIssue({
        code: 'custom',
        path: [path, index, 'keyId'],
        message: `Agent ${path} key IDs must be unique`
      })
    }
    ids.add(entry.keyId)
  })
}

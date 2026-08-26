import { z } from 'zod'
import {
  agentArchitectureSchema,
  agentProtocolVersionSchema
} from './agent-installation-contracts'

export const AGENT_PACKAGE_FORMAT = 'goodbuddy-agent-package'
export const AGENT_PACKAGE_FORMAT_VERSION = 1

export function agentPackageArchiveName(
  version: string,
  architecture: 'x64' | 'arm64'
): string {
  return `goodbuddy-agent-${version}-linux-${architecture}.gbagent`
}

const semanticVersionSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(
    /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:(?:0|[1-9]\d*)|(?:\d*[A-Za-z-][0-9A-Za-z-]*))(?:\.(?:(?:0|[1-9]\d*)|(?:\d*[A-Za-z-][0-9A-Za-z-]*)))*)?$/u
  )
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u)
const sha256DigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/u)
const signingKeyIdSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9._-]{0,63}$/u)
const safeArchiveNameSchema = z
  .string()
  .min(1)
  .max(255)
  .regex(
    /^goodbuddy-agent-(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?-linux-(?:x64|arm64)\.gbagent$/u
  )

const windowsReservedNamePattern =
  /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu

export function isSafeAgentPackagePath(path: string): boolean {
  return (
    path.length > 0 &&
    path.length <= 512 &&
    !path.startsWith('/') &&
    !path.endsWith('/') &&
    !path.includes('\\') &&
    path.split('/').every(
      (part) =>
        part.length > 0 &&
        part !== '.' &&
        part !== '..' &&
        !part.endsWith('.') &&
        !part.endsWith(' ') &&
        !part.includes(':') &&
        [...part].every(
          (character) => character.charCodeAt(0) > 0x1f
        ) &&
        !windowsReservedNamePattern.test(part)
    )
  )
}

const packageFilePathSchema = z
  .string()
  .min(1)
  .max(512)
  .refine(
    isSafeAgentPackagePath,
    'Agent package file path is unsafe'
  )

export const agentPackageFileSchema = z
  .object({
    path: packageFilePathSchema,
    size: z.number().int().nonnegative().safe(),
    sha256: sha256Schema,
    mode: z.enum(['0644', '0755'])
  })
  .strict()

const agentPackageDescriptorObjectSchema = z
  .object({
    format: z.literal(AGENT_PACKAGE_FORMAT),
    formatVersion: z.literal(AGENT_PACKAGE_FORMAT_VERSION),
    product: z.literal('GoodBuddy'),
    component: z.literal('agent'),
    version: semanticVersionSchema,
    minimumDesktopVersion: semanticVersionSchema,
    platform: z.literal('linux'),
    architecture: agentArchitectureSchema,
    signingKeyId: signingKeyIdSchema,
    agentProtocol: agentProtocolVersionSchema,
    remoteRuntime: z
      .object({
        runtimeId: z.literal('opencode'),
        provider: z.literal('opencode'),
        version: semanticVersionSchema,
        bundleDigest: sha256DigestSchema,
        protocol: agentProtocolVersionSchema
      })
      .strict(),
    contentDigest: sha256DigestSchema,
    files: z
      .array(agentPackageFileSchema)
      .min(1)
      .max(50_000)
  })
  .strict()

export const agentPackageDescriptorSchema =
  agentPackageDescriptorObjectSchema
  .superRefine((descriptor, context) => {
    const paths = descriptor.files.map((file) => file.path)
    if (new Set(paths).size !== paths.length) {
      context.addIssue({
        code: 'custom',
        path: ['files'],
        message: 'Agent package contains duplicate file paths'
      })
    }
  })

export type AgentPackageDescriptor = z.infer<
  typeof agentPackageDescriptorSchema
>

export const agentPackageDownloadSchema = z
  .object({
    url: z.url().max(2_048)
  })
  .strict()

export const agentPackageCatalogEntrySchema =
  agentPackageDescriptorObjectSchema
    .omit({
      contentDigest: true,
      files: true,
      signingKeyId: true
    })
    .extend({
      archive: safeArchiveNameSchema,
      size: z.number().int().positive().safe(),
      sha256: sha256Schema,
      downloads: z
        .object({
          github: agentPackageDownloadSchema,
          mirror: agentPackageDownloadSchema
        })
        .strict()
    })
    .strict()
    .superRefine((entry, context) => {
      if (
        entry.archive !==
        agentPackageArchiveName(entry.version, entry.architecture)
      ) {
        context.addIssue({
          code: 'custom',
          path: ['archive'],
          message:
            'Agent package archive name does not match its identity'
        })
      }
    })

export type AgentPackageCatalogEntry = z.infer<
  typeof agentPackageCatalogEntrySchema
>

export const agentPackageCatalogSchema = z
  .object({
    formatVersion: z.literal(1),
    product: z.literal('GoodBuddy'),
    component: z.literal('agent'),
    signingKeyId: signingKeyIdSchema,
    generatedAt: z.string().datetime(),
    entries: z
      .array(agentPackageCatalogEntrySchema)
      .min(1)
      .max(200)
  })
  .strict()
  .superRefine((catalog, context) => {
    const identities = catalog.entries.map(
      (entry) => `${entry.version}:${entry.architecture}`
    )
    if (new Set(identities).size !== identities.length) {
      context.addIssue({
        code: 'custom',
        path: ['entries'],
        message: 'Agent package catalog contains duplicate entries'
      })
    }
  })

export type AgentPackageCatalog = z.infer<
  typeof agentPackageCatalogSchema
>

export const agentPackageStateSchema = z.enum([
  'not-downloaded',
  'verified',
  'invalid'
])

export const agentPackageInventoryEntrySchema = z
  .object({
    platform: z.literal('linux'),
    architecture: agentArchitectureSchema,
    state: agentPackageStateSchema,
    version: semanticVersionSchema.nullable(),
    latestVersion: semanticVersionSchema.nullable(),
    updateAvailable: z.boolean(),
    remoteRuntimeVersion: semanticVersionSchema.nullable(),
    agentProtocol: agentProtocolVersionSchema.nullable()
  })
  .strict()

export const agentPackageCatalogStatusSchema = z
  .discriminatedUnion('state', [
    z
      .object({
        state: z.literal('not-checked'),
        checkedAt: z.null(),
        error: z.null()
      })
      .strict(),
    z
      .object({
        state: z.literal('available'),
        checkedAt: z.string().datetime(),
        error: z.null()
      })
      .strict(),
    z
      .object({
        state: z.literal('unavailable'),
        checkedAt: z.string().datetime(),
        error: z.string().trim().min(1).max(2_000)
      })
      .strict()
  ])

export const agentPackageInventorySchema = z
  .object({
    checkedAt: z.string().datetime(),
    catalog: agentPackageCatalogStatusSchema,
    entries: z
      .array(agentPackageInventoryEntrySchema)
      .length(agentArchitectureSchema.options.length)
  })
  .strict()
  .superRefine((inventory, context) => {
    const architectures = inventory.entries.map(
      (entry) => entry.architecture
    )
    if (new Set(architectures).size !== architectures.length) {
      context.addIssue({
        code: 'custom',
        path: ['entries'],
        message:
          'Agent package inventory contains duplicate architectures'
      })
    }
  })

export type AgentPackageInventory = z.infer<
  typeof agentPackageInventorySchema
>

export const agentPackageInventoryRequestSchema = z
  .object({
    refresh: z.boolean().default(false)
  })
  .strict()

export const agentPackageArchitectureRequestSchema = z
  .object({
    architecture: agentArchitectureSchema
  })
  .strict()

export type AgentPackageArchitectureRequest = z.infer<
  typeof agentPackageArchitectureRequestSchema
>

export const agentPackageDownloadProgressSchema = z
  .object({
    architecture: agentArchitectureSchema,
    phase: z.enum([
      'catalog',
      'downloading',
      'verifying',
      'installing'
    ]),
    completedBytes: z.number().int().nonnegative().safe(),
    totalBytes: z.number().int().positive().safe().nullable()
  })
  .strict()

export type AgentPackageDownloadProgress = z.infer<
  typeof agentPackageDownloadProgressSchema
>

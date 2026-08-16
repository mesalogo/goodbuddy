import { z } from 'zod'

export const runtimeExtensionStartupFailureCode = 'startup-failed'
export const legacyRuntimeExtensionStartupFailure =
  'Extension failed to start.'

export const runtimeExtensionIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/u)

export const runtimeExtensionPackageNameSchema = z
  .string()
  .min(1)
  .max(214)
  .regex(/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u)

export const runtimeExtensionVersionSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(
    /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u
  )

export const runtimeExtensionExactPackageSchema = z
  .object({
    name: runtimeExtensionPackageNameSchema,
    version: runtimeExtensionVersionSchema
  })
  .strict()

export const runtimeExtensionIntegritySchema = z
  .string()
  .min(1)
  .max(1_024)
  .regex(
    /^(?:sha(?:256|384|512)-[A-Za-z0-9+/]+={0,2})(?:\s+sha(?:256|384|512)-[A-Za-z0-9+/]+={0,2})*$/u
  )

type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue }

type JsonObject = { [key: string]: JsonValue }

const MAXIMUM_CONFIGURATION_BYTES = 64 * 1024
const MAXIMUM_CONFIGURATION_DEPTH = 16
const MAXIMUM_CONFIGURATION_NODES = 4_096
const MAXIMUM_CONFIGURATION_ENTRIES = 256
const MAXIMUM_CONFIGURATION_KEY_LENGTH = 256
const MAXIMUM_CONFIGURATION_STRING_LENGTH = 32_768

function isBoundedJsonConfiguration(value: unknown): value is JsonObject {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value)
  ) {
    return false
  }
  const pending: Array<{ value: unknown; depth: number }> = [
    { value, depth: 0 }
  ]
  const seen = new Set<object>()
  let nodes = 0
  while (pending.length > 0) {
    const current = pending.pop()!
    nodes += 1
    if (
      nodes > MAXIMUM_CONFIGURATION_NODES ||
      current.depth > MAXIMUM_CONFIGURATION_DEPTH
    ) {
      return false
    }
    if (
      current.value === null ||
      typeof current.value === 'boolean'
    ) {
      continue
    }
    if (typeof current.value === 'number') {
      if (!Number.isFinite(current.value)) {
        return false
      }
      continue
    }
    if (typeof current.value === 'string') {
      if (
        current.value.length >
        MAXIMUM_CONFIGURATION_STRING_LENGTH
      ) {
        return false
      }
      continue
    }
    if (
      !current.value ||
      typeof current.value !== 'object' ||
      seen.has(current.value)
    ) {
      return false
    }
    seen.add(current.value)
    if (Array.isArray(current.value)) {
      if (
        current.value.length > MAXIMUM_CONFIGURATION_ENTRIES
      ) {
        return false
      }
      for (const item of current.value) {
        pending.push({
          value: item,
          depth: current.depth + 1
        })
      }
      continue
    }
    const entries = Object.entries(current.value)
    if (entries.length > MAXIMUM_CONFIGURATION_ENTRIES) {
      return false
    }
    for (const [key, item] of entries) {
      if (key.length > MAXIMUM_CONFIGURATION_KEY_LENGTH) {
        return false
      }
      pending.push({
        value: item,
        depth: current.depth + 1
      })
    }
  }
  try {
    return (
      new TextEncoder().encode(JSON.stringify(value)).byteLength <=
      MAXIMUM_CONFIGURATION_BYTES
    )
  } catch {
    return false
  }
}

export const runtimeExtensionConfigurationSchema =
  z.custom<JsonObject>(
    isBoundedJsonConfiguration,
    'Extension configuration must be a bounded JSON object'
  )

export const runtimeExtensionCatalogEntrySchema = z
  .object({
    id: runtimeExtensionIdSchema,
    package: runtimeExtensionExactPackageSchema,
    displayName: z.string().trim().min(1).max(128),
    description: z.string().trim().min(1).max(2_000),
    repository: z.string().url().max(2_048).optional(),
    license: z.string().trim().min(1).max(128).optional()
  })
  .strict()

export const runtimeExtensionInstalledStateSchema = z
  .object({
    id: runtimeExtensionIdSchema,
    package: runtimeExtensionExactPackageSchema,
    entrypoint: z.string().min(1).max(32_768),
    installedAt: z.string().datetime({ offset: true }),
    enabled: z.boolean(),
    configuration: runtimeExtensionConfigurationSchema,
    integrity: runtimeExtensionIntegritySchema.optional(),
    lastError: z.string().trim().min(1).max(1_000).optional()
  })
  .strict()

export const runtimeExtensionMarketplaceInstalledStateSchema =
  runtimeExtensionInstalledStateSchema.omit({
    entrypoint: true
  })

export const runtimeExtensionMarketplaceSnapshotSchema = z
  .object({
    marketplaceEnabled: z.boolean(),
    catalog: z.array(runtimeExtensionCatalogEntrySchema),
    installed: z.array(
      runtimeExtensionMarketplaceInstalledStateSchema
    ),
    catalogError: z.string().trim().min(1).max(1_000).optional()
  })
  .strict()

export const runtimeExtensionInstallActionSchema = z
  .object({
    type: z.literal('install'),
    extensionId: runtimeExtensionIdSchema,
    package: runtimeExtensionExactPackageSchema
  })
  .strict()

export const runtimeExtensionEnableActionSchema = z
  .object({
    type: z.literal('set-enabled'),
    extensionId: runtimeExtensionIdSchema,
    enabled: z.boolean()
  })
  .strict()

export const runtimeExtensionRemoveActionSchema = z
  .object({
    type: z.literal('remove'),
    extensionId: runtimeExtensionIdSchema
  })
  .strict()

export const runtimeExtensionConfigureActionSchema = z
  .object({
    type: z.literal('configure'),
    extensionId: runtimeExtensionIdSchema,
    configuration: runtimeExtensionConfigurationSchema
  })
  .strict()

export const runtimeExtensionMarketplaceEnableActionSchema = z
  .object({
    type: z.literal('set-marketplace-enabled'),
    enabled: z.boolean()
  })
  .strict()

export const runtimeExtensionActionSchema = z.discriminatedUnion('type', [
  runtimeExtensionMarketplaceEnableActionSchema,
  runtimeExtensionInstallActionSchema,
  runtimeExtensionEnableActionSchema,
  runtimeExtensionRemoveActionSchema,
  runtimeExtensionConfigureActionSchema
])

export type RuntimeExtensionExactPackage = z.infer<
  typeof runtimeExtensionExactPackageSchema
>
export type RuntimeExtensionCatalogEntry = z.infer<
  typeof runtimeExtensionCatalogEntrySchema
>
export type RuntimeExtensionInstalledState = z.infer<
  typeof runtimeExtensionInstalledStateSchema
>
export type RuntimeExtensionMarketplaceInstalledState = z.infer<
  typeof runtimeExtensionMarketplaceInstalledStateSchema
>
export type RuntimeExtensionMarketplaceSnapshot = z.infer<
  typeof runtimeExtensionMarketplaceSnapshotSchema
>
export type RuntimeExtensionAction = z.infer<
  typeof runtimeExtensionActionSchema
>
export type RuntimeExtensionConfiguration = z.infer<
  typeof runtimeExtensionConfigurationSchema
>

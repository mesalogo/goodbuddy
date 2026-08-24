import { z } from 'zod'
import { componentVersionSchema } from './agent-installation-contracts'
import {
  agentIdentifierSchema,
  sha256DigestSchema
} from './agent-protocol/contracts'

export const installationRegistryIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9](?:[A-Za-z0-9_-]{0,126}[A-Za-z0-9])?$/u)

export const installationRegistryEntrySchema = z
  .object({
    installationId: installationRegistryIdSchema,
    agentVersion: componentVersionSchema,
    manifestSha256: z.string().regex(/^[a-f0-9]{64}$/u),
    arch: z.enum(['x64', 'arm64'])
  })
  .strict()

export type InstallationRegistryEntry = z.infer<
  typeof installationRegistryEntrySchema
>

export const installationRegistryStateSchema = z
  .object({
    formatVersion: z.literal(1),
    current: installationRegistryEntrySchema.optional(),
    candidate: installationRegistryEntrySchema.optional()
  })
  .strict()
  .superRefine((state, context) => {
    const entries = [
      state.current,
      state.candidate
    ].filter((entry): entry is InstallationRegistryEntry =>
      entry !== undefined
    )
    const ids = new Map<string, InstallationRegistryEntry>()
    for (const entry of entries) {
      const existing = ids.get(entry.installationId)
      if (
        existing !== undefined &&
        !installationEntryEquals(existing, entry)
      ) {
        context.addIssue({
          code: 'custom',
          path: ['candidate'],
          message: 'Agent installation identity is inconsistent across roles'
        })
      }
      ids.set(entry.installationId, entry)
    }
    if (
      state.current !== undefined &&
      state.candidate !== undefined &&
      state.current.installationId === state.candidate.installationId
    ) {
      context.addIssue({
        code: 'custom',
        path: ['candidate'],
        message: 'Current Agent installation cannot also be the candidate'
      })
    }
  })

export type InstallationRegistryState = z.infer<
  typeof installationRegistryStateSchema
>

const compatibleInstallationRegistryStateSchema = z
  .object({
    formatVersion: z.literal(1),
    current: installationRegistryEntrySchema
      .passthrough()
      .optional(),
    candidate: installationRegistryEntrySchema
      .passthrough()
      .optional()
  })
  .passthrough()
  .superRefine((state, context) => {
    const legacyEntry = [state.current, state.candidate].some(
      (entry) =>
        entry !== undefined &&
        (
          'releaseSequence' in entry ||
          'productVersion' in entry ||
          'binaryDigest' in entry
        )
    )
    if (
      !legacyEntry &&
      !('minimumTrustedReleaseSequence' in state) &&
      !('draining' in state) &&
      !('rollback' in state)
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Agent registry is not a recognized legacy format'
      })
    }
  })

export function parseInstallationRegistryState(
  value: unknown
): InstallationRegistryState {
  const current = installationRegistryStateSchema.safeParse(value)
  if (current.success) {
    return current.data
  }
  const compatible =
    compatibleInstallationRegistryStateSchema.parse(value)
  return installationRegistryStateSchema.parse({
    formatVersion: 1,
    ...(compatible.current === undefined
      ? {}
      : {
          current: canonicalInstallationEntry(compatible.current)
        }),
    ...(compatible.candidate === undefined
      ? {}
      : {
          candidate: canonicalInstallationEntry(
            compatible.candidate
          )
        })
  })
}

export const runtimeRegistryEntrySchema = z
  .object({
    runtimeId: agentIdentifierSchema,
    runtimeVersion: componentVersionSchema,
    architecture: z.enum(['x64', 'arm64']),
    bundleDigest: sha256DigestSchema,
    manifestDigest: sha256DigestSchema,
    acpCapabilitiesDigest: sha256DigestSchema
  })
  .strict()

export type RuntimeRegistryEntry = z.infer<
  typeof runtimeRegistryEntrySchema
>

export const runtimeRegistryStateSchema = z
  .object({
    formatVersion: z.literal(1),
    current: z.array(runtimeRegistryEntrySchema).max(16)
  })
  .strict()
  .superRefine((state, context) => {
    const identities = new Set<string>()
    state.current.forEach((entry, index) => {
      const identity = `${entry.runtimeId}:${entry.architecture}`
      if (identities.has(identity)) {
        context.addIssue({
          code: 'custom',
          path: ['current', index],
          message: 'Runtime registry identities must be unique'
        })
      }
      identities.add(identity)
    })
  })

export type RuntimeRegistryState = z.infer<
  typeof runtimeRegistryStateSchema
>

const compatibleRuntimeRegistryStateSchema = z
  .object({
    formatVersion: z.literal(1),
    current: z
      .array(runtimeRegistryEntrySchema.passthrough())
      .max(16)
  })
  .passthrough()
  .superRefine((state, context) => {
    const legacyEntry = state.current.some(
      (entry) =>
        'releaseSequence' in entry ||
        'signingKeyId' in entry ||
        'provider' in entry
    )
    if (
      !legacyEntry &&
      !('minimumTrustedReleaseSequence' in state)
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Runtime registry is not a recognized legacy format'
      })
    }
  })

export function parseRuntimeRegistryState(
  value: unknown
): RuntimeRegistryState {
  const current = runtimeRegistryStateSchema.safeParse(value)
  if (current.success) {
    return current.data
  }
  const compatible =
    compatibleRuntimeRegistryStateSchema.parse(value)
  return runtimeRegistryStateSchema.parse({
    formatVersion: 1,
    current: compatible.current.map(canonicalRuntimeEntry)
  })
}

function canonicalInstallationEntry(
  entry: z.infer<typeof installationRegistryEntrySchema> &
    Record<string, unknown>
): InstallationRegistryEntry {
  return installationRegistryEntrySchema.parse({
    installationId: entry.installationId,
    agentVersion: entry.agentVersion,
    manifestSha256: entry.manifestSha256,
    arch: entry.arch
  })
}

function canonicalRuntimeEntry(
  entry: z.infer<typeof runtimeRegistryEntrySchema> &
    Record<string, unknown>
): RuntimeRegistryEntry {
  return runtimeRegistryEntrySchema.parse({
    runtimeId: entry.runtimeId,
    runtimeVersion: entry.runtimeVersion,
    architecture: entry.architecture,
    bundleDigest: entry.bundleDigest,
    manifestDigest: entry.manifestDigest,
    acpCapabilitiesDigest: entry.acpCapabilitiesDigest
  })
}

function installationEntryEquals(
  left: InstallationRegistryEntry,
  right: InstallationRegistryEntry
): boolean {
  return (
    left.installationId === right.installationId &&
    left.agentVersion === right.agentVersion &&
    left.manifestSha256 === right.manifestSha256 &&
    left.arch === right.arch
  )
}

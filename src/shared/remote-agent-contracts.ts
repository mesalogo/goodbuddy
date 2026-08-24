import { z } from 'zod'
import {
  acpFrameDirectionSchema,
  agentIdentifierSchema,
  agentSequenceSchema,
  positiveAgentSequenceSchema,
  protocolVersionSchema,
  sha256DigestSchema,
  utf8ByteLength,
  utf8StringSchema
} from './agent-protocol/contracts'
import { digestCanonicalOperation } from './agent-protocol/canonical'
import {
  MODEL_BRIDGE_PROTOCOL,
  modelBridgePolicySchema
} from './model-bridge-contracts'

export const runtimeSessionBindingStateSchema = z.enum([
  'opening',
  'ready',
  'prompt-running',
  'reconciling',
  'closed',
  'interrupted',
  'outcome-unknown'
])

export const runtimeSessionBindingSchema = z
  .object({
    bindingId: agentIdentifierSchema,
    controllerId: agentIdentifierSchema,
    controllerGeneration: z.number().int().min(1).max(0xffff_ffff),
    conversationId: agentIdentifierSchema,
    hostId: agentIdentifierSchema,
    hostRevision: z.number().int().min(1),
    hostKeyGeneration: z.number().int().min(1),
    workspaceIdentity: agentIdentifierSchema,
    agentInstallationId: agentIdentifierSchema,
    daemonBootIdAtOpen: agentIdentifierSchema,
    runtimeId: agentIdentifierSchema,
    runtimeBundleDigest: sha256DigestSchema,
    runtimeAdapterDigest: sha256DigestSchema,
    modelBridgeVersion: z.literal(MODEL_BRIDGE_PROTOCOL).optional(),
    modelBridgePolicy: modelBridgePolicySchema.optional(),
    acpSessionId: agentIdentifierSchema,
    acpCapabilitiesDigest: sha256DigestSchema,
    state: runtimeSessionBindingStateSchema,
    activePromptOperationId: agentIdentifierSchema.optional(),
    promptSequence: z
      .number()
      .int()
      .nonnegative()
      .max(Number.MAX_SAFE_INTEGER)
      .default(0),
    channelEpoch: positiveAgentSequenceSchema,
    lastOutboundJournaledSequence: agentSequenceSchema,
    lastOutboundDeliveredSequence: agentSequenceSchema,
    lastInboundJournaledSequence: agentSequenceSchema,
    lastMainAckSequence: agentSequenceSchema
  })
  .strict()
  .superRefine((binding, context) => {
    if (
      (binding.modelBridgeVersion === undefined) !==
      (binding.modelBridgePolicy === undefined)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['modelBridgePolicy'],
        message:
          'Model bridge version and policy must be persisted together'
      })
    }
    if (
      BigInt(binding.lastOutboundDeliveredSequence) >
      BigInt(binding.lastOutboundJournaledSequence)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['lastOutboundDeliveredSequence'],
        message: 'Delivered cursor cannot exceed journaled cursor'
      })
    }
    if (
      BigInt(binding.lastMainAckSequence) >
      BigInt(binding.lastInboundJournaledSequence)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['lastMainAckSequence'],
        message: 'Main ACK cursor cannot exceed inbound journaled cursor'
      })
    }
    if (
      (
        binding.state === 'prompt-running' ||
        binding.state === 'reconciling' ||
        binding.state === 'outcome-unknown'
      ) &&
      binding.activePromptOperationId === undefined
    ) {
      context.addIssue({
        code: 'custom',
        path: ['activePromptOperationId'],
        message: 'A running prompt must have an operation identity'
      })
    }
    if (
      binding.activePromptOperationId !== undefined &&
      binding.state !== 'prompt-running' &&
      binding.state !== 'reconciling' &&
      binding.state !== 'outcome-unknown'
    ) {
      context.addIssue({
        code: 'custom',
        path: ['activePromptOperationId'],
        message: 'Only an active or unreconciled prompt may retain operation identity'
      })
    }
  })

export type RuntimeSessionBinding = z.infer<
  typeof runtimeSessionBindingSchema
>

export const remotePromptOperationBudgetSchema = z
  .object({
    maximumInputBytes: z.number().int().min(1).max(16 * 1024 * 1024),
    maximumOutputBytes: z.number().int().min(1).max(16 * 1024 * 1024)
  })
  .strict()

export const remotePromptModelBridgeSchema = z
  .object({
    version: z.literal(MODEL_BRIDGE_PROTOCOL),
    channelId: agentIdentifierSchema,
    channelEpoch: positiveAgentSequenceSchema,
    policy: modelBridgePolicySchema
  })
  .strict()

const remotePromptOperationIdentityFields = {
  bindingId: agentIdentifierSchema,
  operationId: agentIdentifierSchema,
  requestId: agentIdentifierSchema,
  workMode: z.enum(['ask', 'execute']),
  controllerId: agentIdentifierSchema,
  controllerGeneration: z.number().int().min(1).max(0xffff_ffff),
  connectionGeneration: z.number().int().min(1).max(0xffff_ffff),
  channelEpoch: positiveAgentSequenceSchema,
  hostId: agentIdentifierSchema,
  hostRevision: z.number().int().min(1),
  hostKeyGeneration: z.number().int().min(1),
  workspaceIdentity: agentIdentifierSchema,
  agentInstallationId: agentIdentifierSchema,
  runtimeId: agentIdentifierSchema,
  runtimeBundleDigest: sha256DigestSchema,
  runtimeAdapterDigest: sha256DigestSchema,
  modelBridge: remotePromptModelBridgeSchema.optional(),
  deadlineAt: z.string().datetime({ offset: true }),
  budget: remotePromptOperationBudgetSchema
} as const

export const remotePromptOperationPreparationSchema = z
  .object(remotePromptOperationIdentityFields)
  .strict()

export type RemotePromptOperationPreparation = z.infer<
  typeof remotePromptOperationPreparationSchema
>

export const remotePromptOperationAcceptanceSchema = z
  .object({
    bindingId: agentIdentifierSchema,
    operationId: agentIdentifierSchema,
    requestId: agentIdentifierSchema,
    workMode: z.enum(['ask', 'execute']),
    deadlineAt: z.string().datetime({ offset: true }),
    acceptedAt: z.string().datetime({ offset: true })
  })
  .strict()
  .superRefine((acceptance, context) => {
    if (
      Date.parse(acceptance.acceptedAt) >
      Date.parse(acceptance.deadlineAt)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['deadlineAt'],
        message: 'Prompt was accepted after its deadline'
      })
    }
  })

export type RemotePromptOperationAcceptance = z.infer<
  typeof remotePromptOperationAcceptanceSchema
>

export function assertRemotePromptAcceptanceMatchesPreparation(
  preparation: RemotePromptOperationPreparation,
  acceptance: RemotePromptOperationAcceptance
): void {
  if (
    acceptance.bindingId !== preparation.bindingId ||
    acceptance.operationId !== preparation.operationId ||
    acceptance.requestId !== preparation.requestId ||
    acceptance.workMode !== preparation.workMode ||
    acceptance.deadlineAt !== preparation.deadlineAt
  ) {
    throw new Error('Runtime prompt acceptance identity does not match')
  }
}

export const agentHandshakeIdentitySchema = z
  .object({
    protocol: protocolVersionSchema,
    installationId: agentIdentifierSchema,
    binaryDigest: sha256DigestSchema,
    daemonBootId: agentIdentifierSchema,
    controllerId: agentIdentifierSchema,
    connectionId: agentIdentifierSchema,
    generation: z.number().int().min(1).max(0xffff_ffff),
    hostRevision: z.number().int().min(1),
    hostKeyGeneration: z.number().int().min(1)
  })
  .strict()

export const acpJournalCursorSchema = z
  .object({
    bindingId: agentIdentifierSchema,
    channelEpoch: positiveAgentSequenceSchema,
    direction: acpFrameDirectionSchema,
    journaledSequence: agentSequenceSchema,
    deliveredSequence: agentSequenceSchema,
    mainAckSequence: agentSequenceSchema
  })
  .strict()
  .superRefine((cursor, context) => {
    if (
      cursor.direction === 'main-to-runtime' &&
      BigInt(cursor.deliveredSequence) > BigInt(cursor.journaledSequence)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['deliveredSequence'],
        message: 'Delivered cursor cannot exceed journaled cursor'
      })
    }
    if (
      cursor.direction === 'runtime-to-main' &&
      BigInt(cursor.mainAckSequence) > BigInt(cursor.journaledSequence)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['mainAckSequence'],
        message: 'Main ACK cursor cannot exceed journaled cursor'
      })
    }
  })

export type AcpJournalCursor = z.infer<
  typeof acpJournalCursorSchema
>

export const REMOTE_WORKSPACE_LIMITS = {
  maximumAbsolutePathBytes: 4096,
  maximumRelativePathBytes: 4096,
  maximumPathSegmentBytes: 255,
  maximumDirectoryEntriesPerPage: 1000,
  maximumReadBytes: 4 * 1024 * 1024,
  maximumWriteBytes: 16 * 1024 * 1024,
  maximumSearchQueryBytes: 4096,
  maximumSearchMatchesPerPage: 1000,
  maximumSearchSnippetBytes: 16 * 1024,
  maximumGitStatusEntries: 10_000,
  maximumGitDiffBytes: 4 * 1024 * 1024,
  maximumChangeSetFiles: 1000,
  maximumChangeSetBytes: 64 * 1024 * 1024
} as const

const workspaceGenerationSchema = z.number().int().min(1).max(0xffff_ffff)

export const remoteAbsolutePathSchema = utf8StringSchema(
  REMOTE_WORKSPACE_LIMITS.maximumAbsolutePathBytes,
  { minimumBytes: 1, label: 'Remote absolute path' }
).superRefine((value, context) => {
  if (value.includes('\0')) {
    context.addIssue({
      code: 'custom',
      message: 'Remote path cannot contain NUL'
    })
  }
  if (!value.startsWith('/')) {
    context.addIssue({
      code: 'custom',
      message: 'Remote path must be an absolute POSIX path'
    })
  }
})

export const remoteRelativePathSchema = utf8StringSchema(
  REMOTE_WORKSPACE_LIMITS.maximumRelativePathBytes,
  { label: 'Workspace-relative path' }
).superRefine((value, context) => {
  if (
    value.includes('\0') ||
    value.includes('\\') ||
    value.startsWith('/') ||
    /^[A-Za-z]:/u.test(value)
  ) {
    context.addIssue({
      code: 'custom',
      message: 'Workspace path must be a relative POSIX path'
    })
    return
  }
  const segments = value.split('/')
  if (
    value !== '' &&
    segments.some(
      (segment) =>
        segment === '' ||
        segment === '.' ||
        segment === '..' ||
        utf8ByteLength(segment) >
          REMOTE_WORKSPACE_LIMITS.maximumPathSegmentBytes
    )
  ) {
    context.addIssue({
      code: 'custom',
      message: 'Workspace path contains an invalid or oversized segment'
    })
  }
})

export const remoteWorkspaceCapabilitySchema = z.enum([
  'list',
  'stat',
  'read-text',
  'write-text-atomic',
  'apply-change-set',
  'search',
  'git-status',
  'git-diff'
])

export const REMOTE_WORKSPACE_READ_CAPABILITIES = [
  'list',
  'stat',
  'read-text',
  'search'
] as const

export const remoteWorkspaceHandleSchema = z
  .object({
    workspaceId: agentIdentifierSchema,
    workspaceIdentity: agentIdentifierSchema,
    canonicalDisplayPath: remoteAbsolutePathSchema,
    access: z.enum(['read-only', 'read-write']),
    git: z.enum([
      'available',
      'not-a-repository',
      'unavailable'
    ]),
    capabilities: z.array(remoteWorkspaceCapabilitySchema).max(16),
    generation: workspaceGenerationSchema
  })
  .strict()
  .superRefine((handle, context) => {
    if (new Set(handle.capabilities).size !== handle.capabilities.length) {
      context.addIssue({
        code: 'custom',
        path: ['capabilities'],
        message: 'Workspace capabilities must be unique'
      })
    }
    if (
      handle.access === 'read-only' &&
      handle.capabilities.some(
        (capability) =>
          capability === 'write-text-atomic' ||
          capability === 'apply-change-set'
      )
    ) {
      context.addIssue({
        code: 'custom',
        path: ['capabilities'],
        message: 'Read-only workspace cannot advertise write capabilities'
      })
    }
  })

const remoteWorkspaceReferenceFields = {
  workspaceId: agentIdentifierSchema,
  generation: workspaceGenerationSchema
} as const

const remoteWorkspacePathFields = {
  ...remoteWorkspaceReferenceFields,
  relativePath: remoteRelativePathSchema
} as const

export const remoteWorkspaceValidateRequestSchema = z
  .object({
    remoteRootPath: remoteAbsolutePathSchema,
    requestedAccess: z.enum(['read-only', 'read-write']),
    requiredCapabilities: z
      .array(remoteWorkspaceCapabilitySchema)
      .max(16)
  })
  .strict()
  .superRefine((request, context) => {
    if (
      new Set(request.requiredCapabilities).size !==
      request.requiredCapabilities.length
    ) {
      context.addIssue({
        code: 'custom',
        path: ['requiredCapabilities'],
        message: 'Required capabilities must be unique'
      })
    }
  })

export const remoteWorkspaceValidateResultSchema = z
  .object({
    handle: remoteWorkspaceHandleSchema,
    validatedAt: z.string().datetime({ offset: true })
  })
  .strict()

export const remoteWorkspaceOpenRequestSchema = z
  .object({
    workspaceIdentity: agentIdentifierSchema,
    requestedAccess: z.enum(['read-only', 'read-write'])
  })
  .strict()

export const remoteWorkspaceOpenResultSchema =
  remoteWorkspaceHandleSchema

export const remoteWorkspaceResumeRequestSchema = z
  .object({
    ...remoteWorkspaceReferenceFields,
    workspaceIdentity: agentIdentifierSchema
  })
  .strict()

export const remoteWorkspaceResumeResultSchema = z
  .object({
    resumed: z.boolean(),
    handle: remoteWorkspaceHandleSchema
  })
  .strict()

export const remoteWorkspaceCloseRequestSchema = z
  .object(remoteWorkspaceReferenceFields)
  .strict()

export const remoteWorkspaceCloseResultSchema = z
  .object({
    workspaceId: agentIdentifierSchema,
    generation: workspaceGenerationSchema,
    closed: z.literal(true)
  })
  .strict()

export const remoteWorkspaceEntryKindSchema = z.enum([
  'file',
  'directory',
  'symlink',
  'other'
])

export const remoteWorkspaceEntrySchema = z
  .object({
    relativePath: remoteRelativePathSchema,
    name: utf8StringSchema(
      REMOTE_WORKSPACE_LIMITS.maximumPathSegmentBytes,
      { minimumBytes: 1, label: 'Workspace entry name' }
    ),
    kind: remoteWorkspaceEntryKindSchema,
    byteLength: z.number().int().min(0).safe().optional(),
    modifiedAt: z.string().datetime({ offset: true }).optional(),
    digest: sha256DigestSchema.optional(),
    executable: z.boolean()
  })
  .strict()
  .superRefine((entry, context) => {
    if (entry.kind !== 'file' && entry.digest !== undefined) {
      context.addIssue({
        code: 'custom',
        path: ['digest'],
        message: 'Only regular files may carry a content digest'
      })
    }
  })

export const remoteWorkspaceListRequestSchema = z
  .object({
    ...remoteWorkspacePathFields,
    cursor: agentSequenceSchema.optional(),
    limit: z
      .number()
      .int()
      .min(1)
      .max(REMOTE_WORKSPACE_LIMITS.maximumDirectoryEntriesPerPage)
  })
  .strict()

export const remoteWorkspaceListResultSchema = z
  .object({
    entries: z
      .array(remoteWorkspaceEntrySchema)
      .max(REMOTE_WORKSPACE_LIMITS.maximumDirectoryEntriesPerPage),
    nextCursor: positiveAgentSequenceSchema.optional()
  })
  .strict()

export const remoteWorkspaceStatRequestSchema = z
  .object(remoteWorkspacePathFields)
  .strict()

export const remoteWorkspaceStatResultSchema =
  remoteWorkspaceEntrySchema

export const remoteWorkspaceReadTextRequestSchema = z
  .object({
    ...remoteWorkspacePathFields,
    offsetBytes: z.number().int().min(0).safe(),
    maximumBytes: z
      .number()
      .int()
      .min(1)
      .max(REMOTE_WORKSPACE_LIMITS.maximumReadBytes),
    expectedDigest: sha256DigestSchema.optional()
  })
  .strict()

export const remoteWorkspaceReadTextResultSchema = z
  .object({
    relativePath: remoteRelativePathSchema,
    content: utf8StringSchema(REMOTE_WORKSPACE_LIMITS.maximumReadBytes, {
      label: 'File preview'
    }),
    offsetBytes: z.number().int().min(0).safe(),
    bytesRead: z
      .number()
      .int()
      .min(0)
      .max(REMOTE_WORKSPACE_LIMITS.maximumReadBytes),
    totalBytes: z.number().int().min(0).safe(),
    digest: sha256DigestSchema,
    truncated: z.boolean()
  })
  .strict()
  .superRefine((result, context) => {
    if (utf8ByteLength(result.content) !== result.bytesRead) {
      context.addIssue({
        code: 'custom',
        path: ['bytesRead'],
        message: 'bytesRead must equal the UTF-8 content length'
      })
    }
    if (result.offsetBytes + result.bytesRead > result.totalBytes) {
      context.addIssue({
        code: 'custom',
        path: ['totalBytes'],
        message: 'Read range exceeds total file size'
      })
    }
  })

export const remoteWorkspaceSearchRequestSchema = z
  .object({
    ...remoteWorkspaceReferenceFields,
    query: utf8StringSchema(
      REMOTE_WORKSPACE_LIMITS.maximumSearchQueryBytes,
      { minimumBytes: 1, label: 'Search query' }
    ),
    pathPrefix: remoteRelativePathSchema.optional(),
    caseSensitive: z.boolean(),
    cursor: agentSequenceSchema.optional(),
    limit: z
      .number()
      .int()
      .min(1)
      .max(REMOTE_WORKSPACE_LIMITS.maximumSearchMatchesPerPage)
  })
  .strict()

export const remoteWorkspaceSearchMatchSchema = z
  .object({
    relativePath: remoteRelativePathSchema,
    line: z.number().int().min(1).safe(),
    column: z.number().int().min(1).safe(),
    snippet: utf8StringSchema(
      REMOTE_WORKSPACE_LIMITS.maximumSearchSnippetBytes,
      { label: 'Search snippet' }
    )
  })
  .strict()

export const remoteWorkspaceSearchResultSchema = z
  .object({
    matches: z
      .array(remoteWorkspaceSearchMatchSchema)
      .max(REMOTE_WORKSPACE_LIMITS.maximumSearchMatchesPerPage),
    nextCursor: positiveAgentSequenceSchema.optional(),
    truncated: z.boolean()
  })
  .strict()

export const remoteGitStatusRequestSchema = z
  .object({
    ...remoteWorkspaceReferenceFields,
    includeIgnored: z.boolean(),
    maximumEntries: z
      .number()
      .int()
      .min(1)
      .max(REMOTE_WORKSPACE_LIMITS.maximumGitStatusEntries)
  })
  .strict()

export const remoteGitFileStatusSchema = z
  .object({
    relativePath: remoteRelativePathSchema,
    index: z.enum([
      'unmodified',
      'added',
      'modified',
      'deleted',
      'renamed',
      'copied',
      'unmerged',
      'untracked',
      'ignored'
    ]),
    worktree: z.enum([
      'unmodified',
      'added',
      'modified',
      'deleted',
      'renamed',
      'copied',
      'unmerged',
      'untracked',
      'ignored'
    ]),
    originalRelativePath: remoteRelativePathSchema.optional()
  })
  .strict()

export const remoteGitStatusResultSchema = z
  .object({
    repositoryIdentity: agentIdentifierSchema,
    branch: z
      .union([
        utf8StringSchema(1024, {
          minimumBytes: 1,
          label: 'Git branch'
        }),
        z.null()
      ]),
    headDigest: z.string().regex(/^[a-f0-9]{40,64}$/u).optional(),
    entries: z
      .array(remoteGitFileStatusSchema)
      .max(REMOTE_WORKSPACE_LIMITS.maximumGitStatusEntries),
    truncated: z.boolean()
  })
  .strict()

export const remoteGitDiffRequestSchema = z
  .object({
    ...remoteWorkspaceReferenceFields,
    relativePath: remoteRelativePathSchema.optional(),
    staged: z.boolean(),
    cursor: agentSequenceSchema.optional(),
    maximumBytes: z
      .number()
      .int()
      .min(1)
      .max(REMOTE_WORKSPACE_LIMITS.maximumGitDiffBytes)
  })
  .strict()

export const remoteGitDiffResultSchema = z
  .object({
    repositoryIdentity: agentIdentifierSchema,
    patch: utf8StringSchema(REMOTE_WORKSPACE_LIMITS.maximumGitDiffBytes, {
      label: 'Git diff'
    }),
    byteLength: z
      .number()
      .int()
      .min(0)
      .max(REMOTE_WORKSPACE_LIMITS.maximumGitDiffBytes),
    nextCursor: positiveAgentSequenceSchema.optional(),
    truncated: z.boolean()
  })
  .strict()
  .superRefine((result, context) => {
    if (utf8ByteLength(result.patch) !== result.byteLength) {
      context.addIssue({
        code: 'custom',
        path: ['byteLength'],
        message: 'Diff byteLength must equal its UTF-8 payload length'
      })
    }
  })

const remoteWriteOperationFields = {
  operationId: agentIdentifierSchema,
  payloadDigest: sha256DigestSchema
} as const

export const remoteWorkspaceWriteTextAtomicPayloadSchema = z
  .object({
    ...remoteWorkspacePathFields,
    content: utf8StringSchema(REMOTE_WORKSPACE_LIMITS.maximumWriteBytes, {
      label: 'File content'
    }),
    expectedDigest: z.union([sha256DigestSchema, z.literal('absent')]),
    executable: z.boolean()
  })
  .strict()

export const remoteWorkspaceWriteTextAtomicRequestSchema = z
  .object(remoteWriteOperationFields)
  .extend(remoteWorkspaceWriteTextAtomicPayloadSchema.shape)
  .strict()

export const remoteWorkspaceWriteResultSchema = z
  .object({
    operationId: agentIdentifierSchema,
    payloadDigest: sha256DigestSchema,
    status: z.enum([
      'completed',
      'failed',
      'cancelled',
      'outcome-unknown',
      'partially-applied'
    ]),
    relativePath: remoteRelativePathSchema,
    previousDigest: z
      .union([sha256DigestSchema, z.literal('absent')])
      .optional(),
    resultDigest: sha256DigestSchema.optional(),
    byteLength: z.number().int().min(0).safe().optional()
  })
  .strict()
  .superRefine((result, context) => {
    if (
      result.status === 'completed' &&
      (result.resultDigest === undefined ||
        result.byteLength === undefined ||
        result.previousDigest === undefined)
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Completed write result requires preimage and result metadata'
      })
    }
    if (
      result.status !== 'completed' &&
      (result.resultDigest !== undefined || result.byteLength !== undefined)
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Only a completed write may carry result metadata'
      })
    }
  })

export const remoteWorkspaceChangeSchema = z
  .object({
    relativePath: remoteRelativePathSchema,
    action: z.enum(['write', 'delete']),
    expectedDigest: z.union([sha256DigestSchema, z.literal('absent')]),
    content: utf8StringSchema(
      REMOTE_WORKSPACE_LIMITS.maximumWriteBytes,
      { label: 'Change content' }
    ).optional(),
    executable: z.boolean().optional()
  })
  .strict()
  .superRefine((change, context) => {
    if (
      (change.action === 'write') !==
      (change.content !== undefined && change.executable !== undefined)
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Write changes require content and mode; deletes forbid both'
      })
    }
  })

export const remoteWorkspaceApplyChangeSetPayloadSchema = z
  .object({
    ...remoteWorkspaceReferenceFields,
    workspaceIdentity: agentIdentifierSchema,
    gitIndexIdentity: sha256DigestSchema.optional(),
    changes: z
      .array(remoteWorkspaceChangeSchema)
      .min(1)
      .max(REMOTE_WORKSPACE_LIMITS.maximumChangeSetFiles)
  })
  .strict()
  .superRefine((payload, context) => {
    const paths = new Set<string>()
    let bytes = 0
    for (let index = 0; index < payload.changes.length; index += 1) {
      const change = payload.changes[index]!
      if (paths.has(change.relativePath)) {
        context.addIssue({
          code: 'custom',
          path: ['changes', index, 'relativePath'],
          message: 'Change set paths must be unique'
        })
      }
      paths.add(change.relativePath)
      bytes += change.content === undefined
        ? 0
        : utf8ByteLength(change.content)
    }
    if (bytes > REMOTE_WORKSPACE_LIMITS.maximumChangeSetBytes) {
      context.addIssue({
        code: 'custom',
        path: ['changes'],
        message: 'Change set exceeds its total UTF-8 byte limit'
      })
    }
  })

export const remoteWorkspaceApplyChangeSetRequestSchema =
  remoteWorkspaceApplyChangeSetPayloadSchema.safeExtend(
    remoteWriteOperationFields
  )

export const remoteWorkspaceApplyChangeSetResultSchema = z
  .object({
    operationId: agentIdentifierSchema,
    payloadDigest: sha256DigestSchema,
    status: z.enum([
      'completed',
      'failed',
      'cancelled',
      'outcome-unknown',
      'partially-applied'
    ]),
    committedPaths: z
      .array(remoteRelativePathSchema)
      .max(REMOTE_WORKSPACE_LIMITS.maximumChangeSetFiles),
    pendingPaths: z
      .array(remoteRelativePathSchema)
      .max(REMOTE_WORKSPACE_LIMITS.maximumChangeSetFiles)
  })
  .strict()

export async function createRemoteWorkspaceWriteTextAtomicRequest(
  input: z.input<typeof remoteWorkspaceWriteTextAtomicPayloadSchema> & {
    operationId: string
    workspaceIdentity: string
  }
): Promise<RemoteWorkspaceWriteTextAtomicRequest> {
  const {
    operationId,
    workspaceIdentity,
    ...payloadInput
  } = input
  const parsedOperationId = agentIdentifierSchema.parse(operationId)
  const parsedWorkspaceIdentity =
    agentIdentifierSchema.parse(workspaceIdentity)
  const payload = remoteWorkspaceWriteTextAtomicPayloadSchema.parse(
    payloadInput
  )
  return {
    operationId: parsedOperationId,
    ...payload,
    payloadDigest: await digestValidatedRemoteWorkspaceWriteTextAtomicPayload(
      parsedWorkspaceIdentity,
      payload
    )
  }
}

export async function digestRemoteWorkspaceWriteTextAtomicPayload(
  workspaceIdentity: string,
  input: z.input<typeof remoteWorkspaceWriteTextAtomicPayloadSchema>
): Promise<string> {
  const payload = remoteWorkspaceWriteTextAtomicPayloadSchema.parse(input)
  return await digestValidatedRemoteWorkspaceWriteTextAtomicPayload(
    agentIdentifierSchema.parse(workspaceIdentity),
    payload
  )
}

async function digestValidatedRemoteWorkspaceWriteTextAtomicPayload(
  workspaceIdentity: string,
  payload: z.output<typeof remoteWorkspaceWriteTextAtomicPayloadSchema>
): Promise<string> {
  return await digestCanonicalOperation({
    method: 'workspace/writeTextAtomic',
    scope: {
      kind: 'workspace',
      workspaceIdentity
    },
    payload
  })
}

export async function createRemoteWorkspaceApplyChangeSetRequest(
  input: z.input<typeof remoteWorkspaceApplyChangeSetPayloadSchema> & {
    operationId: string
  }
): Promise<RemoteWorkspaceApplyChangeSetRequest> {
  const { operationId, ...payloadInput } = input
  const parsedOperationId = agentIdentifierSchema.parse(operationId)
  const payload = remoteWorkspaceApplyChangeSetPayloadSchema.parse(
    payloadInput
  )
  return {
    operationId: parsedOperationId,
    ...payload,
    payloadDigest:
      await digestValidatedRemoteWorkspaceApplyChangeSetPayload(payload)
  }
}

export async function digestRemoteWorkspaceApplyChangeSetPayload(
  input: z.input<typeof remoteWorkspaceApplyChangeSetPayloadSchema>
): Promise<string> {
  const payload = remoteWorkspaceApplyChangeSetPayloadSchema.parse(input)
  return await digestValidatedRemoteWorkspaceApplyChangeSetPayload(
    payload
  )
}

async function digestValidatedRemoteWorkspaceApplyChangeSetPayload(
  payload: z.output<typeof remoteWorkspaceApplyChangeSetPayloadSchema>
): Promise<string> {
  return await digestCanonicalOperation({
    method: 'workspace/applyChangeSet',
    scope: {
      kind: 'workspace',
      workspaceIdentity: payload.workspaceIdentity
    },
    payload
  })
}

export class RemoteOperationDigestMismatchError extends Error {
  constructor() {
    super('Remote workspace operation payload digest does not match')
    this.name = 'RemoteOperationDigestMismatchError'
  }
}

export async function assertRemoteWorkspaceWriteTextAtomicDigest(
  input: unknown,
  workspaceIdentity: string
): Promise<RemoteWorkspaceWriteTextAtomicRequest> {
  const request = remoteWorkspaceWriteTextAtomicRequestSchema.parse(input)
  const {
    operationId: _operationId,
    payloadDigest,
    ...payload
  } = request
  void _operationId
  const expected =
    await digestValidatedRemoteWorkspaceWriteTextAtomicPayload(
      workspaceIdentity,
      payload
    )
  if (payloadDigest !== expected) {
    throw new RemoteOperationDigestMismatchError()
  }
  return request
}

export async function assertRemoteWorkspaceApplyChangeSetDigest(
  input: unknown
): Promise<RemoteWorkspaceApplyChangeSetRequest> {
  const request =
    remoteWorkspaceApplyChangeSetRequestSchema.parse(input)
  const {
    operationId: _operationId,
    payloadDigest,
    ...payload
  } = request
  void _operationId
  const expected =
    await digestValidatedRemoteWorkspaceApplyChangeSetPayload(payload)
  if (payloadDigest !== expected) {
    throw new RemoteOperationDigestMismatchError()
  }
  return request
}

export type RemoteWorkspaceHandle = z.infer<
  typeof remoteWorkspaceHandleSchema
>
export type RemoteWorkspaceValidateRequest = z.infer<
  typeof remoteWorkspaceValidateRequestSchema
>
export type RemoteWorkspaceValidateResult = z.infer<
  typeof remoteWorkspaceValidateResultSchema
>
export type RemoteWorkspaceOpenRequest = z.infer<
  typeof remoteWorkspaceOpenRequestSchema
>
export type RemoteWorkspaceOpenResult = z.infer<
  typeof remoteWorkspaceOpenResultSchema
>
export type RemoteWorkspaceResumeRequest = z.infer<
  typeof remoteWorkspaceResumeRequestSchema
>
export type RemoteWorkspaceResumeResult = z.infer<
  typeof remoteWorkspaceResumeResultSchema
>
export type RemoteWorkspaceCloseRequest = z.infer<
  typeof remoteWorkspaceCloseRequestSchema
>
export type RemoteWorkspaceCloseResult = z.infer<
  typeof remoteWorkspaceCloseResultSchema
>
export type RemoteWorkspaceEntry = z.infer<
  typeof remoteWorkspaceEntrySchema
>
export type RemoteWorkspaceListRequest = z.infer<
  typeof remoteWorkspaceListRequestSchema
>
export type RemoteWorkspaceListResult = z.infer<
  typeof remoteWorkspaceListResultSchema
>
export type RemoteWorkspaceStatRequest = z.infer<
  typeof remoteWorkspaceStatRequestSchema
>
export type RemoteWorkspaceStatResult = z.infer<
  typeof remoteWorkspaceStatResultSchema
>
export type RemoteWorkspaceReadTextRequest = z.infer<
  typeof remoteWorkspaceReadTextRequestSchema
>
export type RemoteWorkspaceReadTextResult = z.infer<
  typeof remoteWorkspaceReadTextResultSchema
>
export type RemoteWorkspaceSearchRequest = z.infer<
  typeof remoteWorkspaceSearchRequestSchema
>
export type RemoteWorkspaceSearchResult = z.infer<
  typeof remoteWorkspaceSearchResultSchema
>
export type RemoteGitStatusRequest = z.infer<
  typeof remoteGitStatusRequestSchema
>
export type RemoteGitStatusResult = z.infer<
  typeof remoteGitStatusResultSchema
>
export type RemoteGitDiffRequest = z.infer<
  typeof remoteGitDiffRequestSchema
>
export type RemoteGitDiffResult = z.infer<
  typeof remoteGitDiffResultSchema
>
export type RemoteWorkspaceWriteTextAtomicRequest = z.infer<
  typeof remoteWorkspaceWriteTextAtomicRequestSchema
>
export type RemoteWorkspaceWriteResult = z.infer<
  typeof remoteWorkspaceWriteResultSchema
>
export type RemoteWorkspaceApplyChangeSetRequest = z.infer<
  typeof remoteWorkspaceApplyChangeSetRequestSchema
>
export type RemoteWorkspaceApplyChangeSetResult = z.infer<
  typeof remoteWorkspaceApplyChangeSetResultSchema
>

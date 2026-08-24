import { z } from 'zod'
import {
  agentArchitectureSchema,
  agentBundleManifestSchema,
  agentManifestLicenseSchema,
  agentManifestPathSchema,
  agentProtocolVersionSchema,
  agentReleaseKeySchema
} from './agent-installation-contracts'
import {
  agentIdentifierSchema,
  operationIdentitySchema,
  sha256DigestSchema,
  utf8StringSchema,
  type OperationIdentity
} from './agent-protocol/contracts'
import {
  createOperationIdentity,
  digestCanonicalOperation
} from './agent-protocol/canonical'
import {
  remotePromptOperationPreparationSchema,
  type RemotePromptOperationPreparation
} from './remote-agent-contracts'

export const REMOTE_RUNTIME_LAUNCH_LIMITS = {
  maximumFiles: 10_000,
  maximumLicenses: 1_000,
  maximumFixedArgumentCount: 32,
  maximumFixedArgumentBytes: 1024,
  maximumAdapterParameters: 8,
  maximumEnvironmentNames: 16,
  maximumRuntimeMilliseconds: 24 * 60 * 60 * 1000,
  maximumPromptInputBytes: 16 * 1024 * 1024,
  maximumCapturedOutputBytes: 16 * 1024 * 1024
} as const

export const remoteRuntimeProviderKindSchema = z.enum([
  'deepseek-harness',
  'opencode',
  'continue'
])

export const remoteRuntimeArchitectureSchema = agentArchitectureSchema

export const remoteRuntimeAllowedEnvironmentNameSchema = z.enum([
  'HOME',
  'LANG',
  'LC_ALL',
  'PATH',
  'TMPDIR',
  'XDG_CACHE_HOME',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'XDG_STATE_HOME'
])

export const OPENCODE_REMOTE_RUNTIME_ENVIRONMENT_NAMES = [
  'HOME',
  'LANG',
  'LC_ALL',
  'PATH',
  'TMPDIR',
  'XDG_CACHE_HOME',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'XDG_STATE_HOME'
] as const

const fixedArgumentSchema = utf8StringSchema(
  REMOTE_RUNTIME_LAUNCH_LIMITS.maximumFixedArgumentBytes,
  { label: 'Fixed Runtime argument' }
).refine((value) => !value.includes('\0'), 'Runtime argument contains NUL')

const rawSha256Schema = z.string().regex(/^[a-f0-9]{64}$/u)
const npmPackageIntegritySchema = z
  .string()
  .regex(/^sha512-[A-Za-z0-9+/]{86}==$/u)

export const remoteRuntimeSourcePackageSchema = z
  .object({
    name: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,127}$/u),
    integrity: npmPackageIntegritySchema
  })
  .strict()

export const remoteRuntimeBundleFileSchema = z
  .object({
    path: agentManifestPathSchema,
    size: z.number().int().min(0).safe(),
    sha256: rawSha256Schema,
    mode: z.enum(['0644', '0755'])
  })
  .strict()

export const remoteRuntimeLimitsSchema = z
  .object({
    maximumPromptRuntimeMilliseconds: z
      .number()
      .int()
      .min(1)
      .max(REMOTE_RUNTIME_LAUNCH_LIMITS.maximumRuntimeMilliseconds),
    maximumPromptInputBytes: z
      .number()
      .int()
      .min(1)
      .max(REMOTE_RUNTIME_LAUNCH_LIMITS.maximumPromptInputBytes),
    maximumPromptOutputBytes: z
      .number()
      .int()
      .min(0)
      .max(REMOTE_RUNTIME_LAUNCH_LIMITS.maximumCapturedOutputBytes)
  })
  .strict()

const remoteRuntimeManifestFields = {
    product: z.literal('GoodBuddy'),
    runtimeId: agentIdentifierSchema,
    runtimeVersion: agentBundleManifestSchema.shape.agentVersion,
    provider: remoteRuntimeProviderKindSchema,
    platform: z.literal('linux'),
    architecture: agentArchitectureSchema,
    signingKeyId: agentReleaseKeySchema.shape.keyId,
    bundleDigest: sha256DigestSchema,
    adapterDigest: sha256DigestSchema,
    sourcePackage: remoteRuntimeSourcePackageSchema,
    entrypoint: z
      .object({
        identity: agentIdentifierSchema,
        path: agentManifestPathSchema,
        sha256: rawSha256Schema,
        argvPrefix: z
          .array(fixedArgumentSchema)
          .max(REMOTE_RUNTIME_LAUNCH_LIMITS.maximumFixedArgumentCount)
      })
      .strict(),
    files: z
      .array(remoteRuntimeBundleFileSchema)
      .min(1)
      .max(REMOTE_RUNTIME_LAUNCH_LIMITS.maximumFiles),
    licenses: z
      .array(agentManifestLicenseSchema)
      .min(1)
      .max(REMOTE_RUNTIME_LAUNCH_LIMITS.maximumLicenses),
    allowedEnvironmentNames: z
      .array(remoteRuntimeAllowedEnvironmentNameSchema)
      .max(REMOTE_RUNTIME_LAUNCH_LIMITS.maximumEnvironmentNames),
    protocol: agentProtocolVersionSchema,
    acpCapabilitiesDigest: sha256DigestSchema
} as const

export const remoteRuntimeBundleManifestSchema = z
  .object({
    formatVersion: z.literal(2),
    ...remoteRuntimeManifestFields,
    limits: remoteRuntimeLimitsSchema
  })
  .strict()
  .superRefine((manifest, context) => {
    const files = new Map<string, string>()
    manifest.files.forEach((file, index) => {
      if (
        file.path === 'manifest.json' ||
        file.path === 'manifest.sig'
      ) {
        context.addIssue({
          code: 'custom',
          path: ['files', index, 'path'],
          message: 'Runtime payload cannot declare signature metadata'
        })
      }
      if (files.has(file.path)) {
        context.addIssue({
          code: 'custom',
          path: ['files', index, 'path'],
          message: 'Runtime bundle file paths must be unique'
        })
      }
      files.set(file.path, file.sha256)
    })
    if (files.get(manifest.entrypoint.path) !== manifest.entrypoint.sha256) {
      context.addIssue({
        code: 'custom',
        path: ['entrypoint'],
        message: 'Runtime entrypoint must match a declared bundle file'
      })
    }
    const licensePaths = new Set<string>()
    manifest.licenses.forEach((license, index) => {
      if (licensePaths.has(license.path) || !files.has(license.path)) {
        context.addIssue({
          code: 'custom',
          path: ['licenses', index, 'path'],
          message: 'Runtime licenses must uniquely name declared files'
        })
      }
      licensePaths.add(license.path)
    })
    if (
      new Set(manifest.allowedEnvironmentNames).size !==
      manifest.allowedEnvironmentNames.length
    ) {
      context.addIssue({
        code: 'custom',
        path: ['allowedEnvironmentNames'],
        message: 'Allowed environment names must be unique'
      })
    }
  })

export type RemoteRuntimeBundleManifest = z.infer<
  typeof remoteRuntimeBundleManifestSchema
>

const remoteRuntimeLockedTargetSchema = z
  .object({
    package: remoteRuntimeSourcePackageSchema.shape.name,
    integrity: npmPackageIntegritySchema
  })
  .strict()

export const remoteRuntimeLockSchema = z
  .object({
    formatVersion: z.literal(1),
    runtimes: z
      .object({
        opencode: z
          .object({
            version: z.literal('1.18.9'),
            provider: z.literal('opencode'),
            entrypoint: z.literal('bin/opencode'),
            entrypointIdentity: z.literal('opencode-acp'),
            argvPrefix: z.tuple([z.literal('acp')]),
            allowedEnvironmentNames: z.tuple([
              z.literal('HOME'),
              z.literal('LANG'),
              z.literal('LC_ALL'),
              z.literal('PATH'),
              z.literal('TMPDIR'),
              z.literal('XDG_CACHE_HOME'),
              z.literal('XDG_CONFIG_HOME'),
              z.literal('XDG_DATA_HOME'),
              z.literal('XDG_STATE_HOME')
            ]),
            protocol: agentProtocolVersionSchema,
            targets: z
              .object({
                x64: remoteRuntimeLockedTargetSchema.extend({
                  package: z.literal(
                    'opencode-linux-x64-baseline'
                  )
                }),
                arm64: remoteRuntimeLockedTargetSchema.extend({
                  package: z.literal('opencode-linux-arm64')
                })
              })
              .strict()
          })
          .strict()
      })
      .strict()
  })
  .strict()

export type RemoteRuntimeLock = z.infer<typeof remoteRuntimeLockSchema>

export const remoteRuntimeDetachedSignatureSchema = z
  .object({
    manifestDigest: sha256DigestSchema,
    algorithm: z.literal('ed25519'),
    keyId: agentReleaseKeySchema.shape.keyId,
    signatureBase64: z
      .string()
      .regex(/^(?:[A-Za-z0-9+/]{4}){21}[A-Za-z0-9+/]{2}==$/u)
  })
  .strict()

export const detachedSignedRemoteRuntimeBundleSchema = z
  .object({
    manifest: remoteRuntimeBundleManifestSchema,
    detachedSignature: remoteRuntimeDetachedSignatureSchema
  })
  .strict()
  .superRefine((bundle, context) => {
    if (
      bundle.manifest.signingKeyId !== bundle.detachedSignature.keyId
    ) {
      context.addIssue({
        code: 'custom',
        path: ['detachedSignature', 'keyId'],
        message: 'Detached signature key does not match the manifest'
      })
    }
  })

export const signedRemoteRuntimeManifestSchema =
  detachedSignedRemoteRuntimeBundleSchema
export type SignedRemoteRuntimeManifest = z.infer<
  typeof detachedSignedRemoteRuntimeBundleSchema
>

export const remoteRuntimeDeadlineSchema = z
  .string()
  .datetime({ offset: true })
  .refine((value) => Number.isFinite(Date.parse(value)), 'Invalid deadline')

export const remoteRuntimeAdapterParameterSchema = z
  .object({
    name: z.enum([
      'modelProfileId',
      'configurationId',
      'conversationAdapterId'
    ]),
    value: agentIdentifierSchema.refine(
      (value) =>
        !value.startsWith('-') &&
        !value.includes('/') &&
        !value.includes('\\') &&
        !value.includes('\0') &&
        value !== '.' &&
        value !== '..',
      'Adapter parameter must be an opaque identifier'
    )
  })
  .strict()

const remoteRuntimeAdapterParametersSchema = z
  .array(remoteRuntimeAdapterParameterSchema)
  .max(REMOTE_RUNTIME_LAUNCH_LIMITS.maximumAdapterParameters)
  .superRefine((parameters, context) => {
    const names = new Set<string>()
    parameters.forEach((parameter, index) => {
      if (names.has(parameter.name)) {
        context.addIssue({
          code: 'custom',
          path: [index, 'name'],
          message: 'Adapter parameter names must be unique'
        })
      }
      names.add(parameter.name)
    })
  })

export const remoteRuntimeStartPayloadSchema = z
  .object({
    bindingId: agentIdentifierSchema,
    requestId: agentIdentifierSchema,
    workMode: z.enum(['ask', 'execute']),
    runtimeId: agentIdentifierSchema,
    adapterParameters: remoteRuntimeAdapterParametersSchema,
    deadlineAt: remoteRuntimeDeadlineSchema,
    budget: remotePromptOperationPreparationSchema.shape.budget
  })
  .strict()

export type RemoteRuntimeStartPayload = z.infer<
  typeof remoteRuntimeStartPayloadSchema
>

export const remoteRuntimeStartRequestSchema = z
  .object({
    identity: operationIdentitySchema,
    payload: remoteRuntimeStartPayloadSchema
  })
  .strict()
  .superRefine((request, context) => {
    addOperationBindingIssues(
      request.identity,
      'runtime/startPrompt',
      request.payload.bindingId,
      request.payload.requestId,
      context
    )
  })

export type RemoteRuntimeStartRequest = z.infer<
  typeof remoteRuntimeStartRequestSchema
>

export const remoteRuntimeStartResultSchema = z
  .object({
    launchId: agentIdentifierSchema,
    processId: agentIdentifierSchema,
    startOperationId: agentIdentifierSchema,
    bindingId: agentIdentifierSchema,
    runtimeId: agentIdentifierSchema,
    supervisorIdentityDigest: sha256DigestSchema,
    state: z.enum(['starting', 'running']),
    acceptedAt: z.string().datetime({ offset: true })
  })
  .strict()

export type RemoteRuntimeStartResult = z.infer<
  typeof remoteRuntimeStartResultSchema
>

export const remoteRuntimeStopReasonSchema = z.enum([
  'user-cancelled',
  'deadline-exceeded',
  'binding-closed',
  'shutdown',
  'identity-conflict'
])

export const remoteRuntimeStopPayloadSchema = z
  .object({
    launchId: agentIdentifierSchema,
    bindingId: agentIdentifierSchema,
    runtimeId: agentIdentifierSchema,
    startOperationId: agentIdentifierSchema,
    requestId: agentIdentifierSchema,
    reason: remoteRuntimeStopReasonSchema,
    deadlineAt: remoteRuntimeDeadlineSchema
  })
  .strict()

export const remoteRuntimeStopRequestSchema = z
  .object({
    identity: operationIdentitySchema,
    payload: remoteRuntimeStopPayloadSchema
  })
  .strict()
  .superRefine((request, context) => {
    addOperationBindingIssues(
      request.identity,
      'runtime/stopPrompt',
      request.payload.bindingId,
      request.payload.requestId,
      context
    )
  })

export const remoteRuntimeStopResultSchema = z
  .object({
    launchId: agentIdentifierSchema,
    operationId: agentIdentifierSchema,
    startOperationId: agentIdentifierSchema,
    bindingId: agentIdentifierSchema,
    runtimeId: agentIdentifierSchema,
    supervisorIdentityDigest: sha256DigestSchema,
    state: z.enum(['stop-requested', 'stopped']),
    acceptedAt: z.string().datetime({ offset: true })
  })
  .strict()

export const remoteRuntimeQueryPayloadSchema = z
  .object({
    launchId: agentIdentifierSchema,
    bindingId: agentIdentifierSchema,
    runtimeId: agentIdentifierSchema,
    startOperationId: agentIdentifierSchema,
    requestId: agentIdentifierSchema
  })
  .strict()

export const remoteRuntimeQueryRequestSchema = z
  .object({
    identity: operationIdentitySchema,
    payload: remoteRuntimeQueryPayloadSchema
  })
  .strict()
  .superRefine((request, context) => {
    addOperationBindingIssues(
      request.identity,
      'runtime/queryPrompt',
      request.payload.bindingId,
      request.payload.requestId,
      context
    )
  })

export const remoteRuntimeLaunchStateSchema = z.enum([
  'starting',
  'running',
  'stop-requested',
  'stopped',
  'failed',
  'expired',
  'interrupted',
  'outcome-unknown',
  'identity-conflict'
])

export const remoteRuntimeProcessTreeStateSchema = z.enum([
  'pending',
  'reconciled',
  'terminating',
  'terminated',
  'orphaned',
  'outcome-unknown',
  'identity-conflict'
])

export const REMOTE_RUNTIME_STATE_PROCESS_TREE_MATRIX = {
  starting: ['pending', 'reconciled'],
  running: ['reconciled'],
  'stop-requested': ['reconciled', 'terminating'],
  stopped: ['terminated'],
  failed: ['pending', 'terminated', 'orphaned'],
  expired: ['terminating', 'terminated', 'orphaned'],
  interrupted: [
    'reconciled',
    'terminating',
    'terminated',
    'orphaned',
    'outcome-unknown'
  ],
  'outcome-unknown': ['outcome-unknown'],
  'identity-conflict': ['identity-conflict']
} as const satisfies Record<
  z.infer<typeof remoteRuntimeLaunchStateSchema>,
  readonly z.infer<typeof remoteRuntimeProcessTreeStateSchema>[]
>

export const remoteRuntimeErrorCodeSchema = z.enum([
  'manifest-untrusted',
  'identity-mismatch',
  'deadline-exceeded',
  'output-limit-exceeded',
  'launch-failed',
  'runtime-failed',
  'supervisor-unavailable',
  'process-tree-orphaned',
  'not-found'
])

export const remoteRuntimeOutputMetadataSchema = z
  .object({
    effectiveCapturedOutputLimitBytes: z
      .number()
      .int()
      .min(0)
      .max(REMOTE_RUNTIME_LAUNCH_LIMITS.maximumCapturedOutputBytes),
    stdoutBytes: z
      .number()
      .int()
      .min(0)
      .max(REMOTE_RUNTIME_LAUNCH_LIMITS.maximumCapturedOutputBytes),
    stderrBytes: z
      .number()
      .int()
      .min(0)
      .max(REMOTE_RUNTIME_LAUNCH_LIMITS.maximumCapturedOutputBytes),
    truncated: z.boolean()
  })
  .strict()
  .superRefine((output, context) => {
    const aggregate = output.stdoutBytes + output.stderrBytes
    if (
      aggregate > output.effectiveCapturedOutputLimitBytes ||
      aggregate >
        REMOTE_RUNTIME_LAUNCH_LIMITS.maximumCapturedOutputBytes
    ) {
      context.addIssue({
        code: 'custom',
        path: ['effectiveCapturedOutputLimitBytes'],
        message: 'Captured Runtime output exceeds its aggregate limit'
      })
    }
  })

export const remoteRuntimeQueryResultSchema = z
  .object({
    launchId: agentIdentifierSchema,
    queryOperationId: agentIdentifierSchema,
    startOperationId: agentIdentifierSchema,
    bindingId: agentIdentifierSchema,
    runtimeId: agentIdentifierSchema,
    supervisorIdentityDigest: sha256DigestSchema,
    state: remoteRuntimeLaunchStateSchema,
    processTreeState: remoteRuntimeProcessTreeStateSchema,
    output: remoteRuntimeOutputMetadataSchema,
    errorCode: remoteRuntimeErrorCodeSchema.optional()
  })
  .strict()
  .superRefine((result, context) => {
    const allowedProcessTreeStates =
      REMOTE_RUNTIME_STATE_PROCESS_TREE_MATRIX[result.state]
    if (
      !(allowedProcessTreeStates as readonly string[]).includes(
        result.processTreeState
      )
    ) {
      context.addIssue({
        code: 'custom',
        path: ['processTreeState'],
        message:
          'Runtime launch and process-tree states are inconsistent'
      })
    }
    const needsError =
      result.state === 'failed' ||
      result.state === 'interrupted' ||
      result.state === 'outcome-unknown' ||
      result.state === 'identity-conflict'
    if (needsError !== (result.errorCode !== undefined)) {
      context.addIssue({
        code: 'custom',
        path: ['errorCode'],
        message: 'Runtime error code does not match the durable state'
      })
    }
  })

export type RemoteRuntimeStopRequest = z.infer<
  typeof remoteRuntimeStopRequestSchema
>
export type RemoteRuntimeStopResult = z.infer<
  typeof remoteRuntimeStopResultSchema
>
export type RemoteRuntimeQueryRequest = z.infer<
  typeof remoteRuntimeQueryRequestSchema
>
export type RemoteRuntimeQueryResult = z.infer<
  typeof remoteRuntimeQueryResultSchema
>

export async function digestRemoteRuntimePreparation(
  preparation: RemotePromptOperationPreparation
): Promise<string> {
  const parsed = remotePromptOperationPreparationSchema.parse(preparation)
  return digestCanonicalOperation({
    method: 'runtime/preparePrompt',
    scope: {
      kind: 'run',
      sessionId: parsed.bindingId,
      requestId: parsed.requestId
    },
    payload: parsed
  })
}

export async function createRemoteRuntimeStartRequest(input: {
  controllerId: string
  operationId: string
  prompt: unknown
  adapterParameters?: unknown
  deadlineAt?: string
}): Promise<RemoteRuntimeStartRequest> {
  const prompt = remotePromptOperationPreparationSchema.parse(input.prompt)
  const deadlineAt = input.deadlineAt ?? prompt.deadlineAt
  if (Date.parse(deadlineAt) > Date.parse(prompt.deadlineAt)) {
    throw new Error('Runtime start deadline exceeds the prompt deadline')
  }
  const payload = remoteRuntimeStartPayloadSchema.parse({
    bindingId: prompt.bindingId,
    requestId: prompt.requestId,
    workMode: prompt.workMode,
    runtimeId: prompt.runtimeId,
    adapterParameters: input.adapterParameters ?? [],
    deadlineAt,
    budget: prompt.budget
  })
  const identity = await createOperationIdentity({
    controllerId: agentIdentifierSchema.parse(input.controllerId),
    operationId: agentIdentifierSchema.parse(input.operationId),
    scope: {
      kind: 'run',
      sessionId: prompt.bindingId,
      requestId: prompt.requestId
    },
    method: 'runtime/startPrompt',
    payload
  })
  return remoteRuntimeStartRequestSchema.parse({ identity, payload })
}

export async function createRemoteRuntimeStopRequest(input: {
  controllerId: string
  operationId: string
  payload: unknown
}): Promise<RemoteRuntimeStopRequest> {
  const payload = remoteRuntimeStopPayloadSchema.parse(input.payload)
  const identity = await createOperationIdentity({
    controllerId: input.controllerId,
    operationId: input.operationId,
    scope: {
      kind: 'run',
      sessionId: payload.bindingId,
      requestId: payload.requestId
    },
    method: 'runtime/stopPrompt',
    payload
  })
  return remoteRuntimeStopRequestSchema.parse({ identity, payload })
}

export async function createRemoteRuntimeQueryRequest(input: {
  controllerId: string
  operationId: string
  payload: unknown
}): Promise<RemoteRuntimeQueryRequest> {
  const payload = remoteRuntimeQueryPayloadSchema.parse(input.payload)
  const identity = await createOperationIdentity({
    controllerId: input.controllerId,
    operationId: input.operationId,
    scope: {
      kind: 'run',
      sessionId: payload.bindingId,
      requestId: payload.requestId
    },
    method: 'runtime/queryPrompt',
    payload
  })
  return remoteRuntimeQueryRequestSchema.parse({ identity, payload })
}

export async function digestRemoteRuntimeBundleManifest(
  manifest: unknown
): Promise<string> {
  const parsed = remoteRuntimeBundleManifestSchema.parse(manifest)
  return digestCanonicalOperation({
    method: 'runtime/bundleManifest',
    scope: {
      kind: 'installation',
      installationId: parsed.runtimeId
    },
    payload: parsed
  })
}

export async function digestRemoteRuntimeBundleIdentity(
  manifest: unknown
): Promise<string> {
  const parsed = remoteRuntimeBundleManifestSchema.parse(manifest)
  const { bundleDigest: _bundleDigest, ...identity } = parsed
  void _bundleDigest
  return digestCanonicalOperation({
    method: 'runtime/bundleIdentity',
    scope: {
      kind: 'installation',
      installationId: parsed.runtimeId
    },
    payload: identity
  })
}

export async function assertDetachedRemoteRuntimeBundleDigest(
  bundle: unknown
): Promise<SignedRemoteRuntimeManifest> {
  const parsed = detachedSignedRemoteRuntimeBundleSchema.parse(bundle)
  const bundleDigest = await digestRemoteRuntimeBundleIdentity(
    parsed.manifest
  )
  if (bundleDigest !== parsed.manifest.bundleDigest) {
    throw new Error('Runtime bundle identity digest does not match')
  }
  const digest = await digestRemoteRuntimeBundleManifest(parsed.manifest)
  if (digest !== parsed.detachedSignature.manifestDigest) {
    throw new Error('Detached Runtime manifest digest does not match')
  }
  return parsed
}

export async function assertRemoteRuntimeOperationDigest(
  request: RemoteRuntimeStartRequest | RemoteRuntimeStopRequest | RemoteRuntimeQueryRequest
): Promise<void> {
  const expectedDigest = await digestCanonicalOperation({
    method: request.identity.method,
    scope: request.identity.scope,
    payload: request.payload
  })
  if (request.identity.payloadDigest !== expectedDigest) {
    throw new Error('Runtime operation payload digest does not match')
  }
}

function addOperationBindingIssues(
  identity: OperationIdentity,
  method: string,
  bindingId: string,
  requestId: string,
  context: z.RefinementCtx
): void {
  if (identity.method !== method) {
    context.addIssue({
      code: 'custom',
      path: ['identity', 'method'],
      message: `Operation method must be ${method}`
    })
  }
  if (
    identity.scope.kind !== 'run' ||
    identity.scope.sessionId !== bindingId ||
    identity.scope.requestId !== requestId
  ) {
    context.addIssue({
      code: 'custom',
      path: ['identity', 'scope'],
      message: 'Operation scope does not match Runtime ownership'
    })
  }
}

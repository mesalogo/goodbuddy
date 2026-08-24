import { z } from 'zod'
import { componentVersionSchema } from './agent-installation-contracts'
import { utf8ByteLength } from './agent-protocol/contracts'

export const SSH_HOST_LIMITS = {
  maximumHosts: 100,
  maximumNameLength: 120,
  maximumHostnameLength: 253,
  maximumUsernameLength: 128,
  maximumPort: 65_535,
  maximumPasswordLength: 4_096,
  maximumHostKeyLength: 32 * 1_024,
  maximumDiagnosticLength: 1_000
} as const

const boundedTextSchema = (
  maximum: number,
  minimum = 0
): z.ZodString =>
  z
    .string()
    .trim()
    .min(minimum)
    .max(maximum)
    .refine(
      (value) =>
        Array.from(value).every((character) => {
          const codePoint = character.codePointAt(0) ?? 0
          return codePoint > 31 && codePoint !== 127
        }),
      '内容不能包含控制字符'
    )

export const sshHostIdSchema = z.string().uuid()
export const sshAuthenticationKindSchema = z.enum([
  'password',
  'system-agent'
])

export type SshAuthenticationKind = z.infer<
  typeof sshAuthenticationKindSchema
>

export const sshPasswordUpdateSchema = z.discriminatedUnion(
  'action',
  [
    z.object({ action: z.literal('keep') }).strict(),
    z.object({ action: z.literal('clear') }).strict(),
    z
      .object({
        action: z.literal('replace'),
        value: z
          .string()
          .min(1)
          .max(SSH_HOST_LIMITS.maximumPasswordLength)
      })
      .strict()
  ]
)

export type SshPasswordUpdate = z.infer<
  typeof sshPasswordUpdateSchema
>

const sshHostEditableFields = {
  name: boundedTextSchema(SSH_HOST_LIMITS.maximumNameLength, 1),
  hostname: boundedTextSchema(
    SSH_HOST_LIMITS.maximumHostnameLength,
    1
  ).refine((value) => !/\s/u.test(value), '主机地址不能包含空白字符'),
  port: z
    .number()
    .int()
    .min(1)
    .max(SSH_HOST_LIMITS.maximumPort),
  username: boundedTextSchema(
    SSH_HOST_LIMITS.maximumUsernameLength,
    1
  ).refine((value) => !/\s/u.test(value), '用户名不能包含空白字符'),
  authentication: sshAuthenticationKindSchema,
  password: sshPasswordUpdateSchema
} as const

export const sshHostCreateInputSchema = z
  .object(sshHostEditableFields)
  .strict()
  .superRefine((input, context) => {
    if (
      input.authentication === 'password' &&
      input.password.action !== 'replace'
    ) {
      context.addIssue({
        code: 'custom',
        path: ['password'],
        message: '新建密码认证主机时必须提供密码'
      })
    }
    if (
      input.authentication === 'system-agent' &&
      input.password.action === 'replace'
    ) {
      context.addIssue({
        code: 'custom',
        path: ['password'],
        message: '系统 SSH Agent 认证不接受密码'
      })
    }
  })

export const sshHostUpdateInputSchema = z
  .object(sshHostEditableFields)
  .strict()
  .superRefine((input, context) => {
    if (
      input.authentication === 'system-agent' &&
      input.password.action === 'replace'
    ) {
      context.addIssue({
        code: 'custom',
        path: ['password'],
        message: '系统 SSH Agent 认证不接受密码'
      })
    }
  })

export type SshHostCreateInput = z.infer<
  typeof sshHostCreateInputSchema
>
export type SshHostUpdateInput = z.infer<
  typeof sshHostUpdateInputSchema
>

export const sshHostRequestSchema = z
  .object({
    hostId: sshHostIdSchema
  })
  .strict()

export const sshHostDraftInspectionRequestSchema = z
  .object({
    hostId: sshHostIdSchema.optional(),
    hostname: sshHostCreateInputSchema.shape.hostname,
    port: sshHostCreateInputSchema.shape.port,
    username: sshHostCreateInputSchema.shape.username
  })
  .strict()

export type SshHostDraftInspectionRequest = z.infer<
  typeof sshHostDraftInspectionRequestSchema
>

export const sshHostCandidateRequestSchema = z
  .object({
    candidateId: z.string().uuid()
  })
  .strict()

export const sshHostValidationRequestSchema = z
  .object({
    candidateId: z.string().uuid(),
    fingerprintSha256: z
      .string()
      .regex(/^SHA256:[A-Za-z0-9+/]{43}$/u),
    input: sshHostUpdateInputSchema
  })
  .strict()

export type SshHostValidationRequest = z.infer<
  typeof sshHostValidationRequestSchema
>

export const sshHostKeyStateSchema = z.enum([
  'unverified',
  'verified',
  'changed'
])

export type SshHostKeyState = z.infer<
  typeof sshHostKeyStateSchema
>

export type SshHost = {
  id: string
  name: string
  hostname: string
  port: number
  username: string
  authentication: SshAuthenticationKind
  credentialConfigured: boolean
  credentialSource:
    | 'none'
    | 'encrypted'
    | 'system-agent'
    | 'unreadable'
  hostKey: {
    state: Exclude<SshHostKeyState, 'changed'>
    algorithm?: string
    fingerprintSha256?: string
    generation: number
  }
  lastValidatedAt?: string
  createdAt: string
  updatedAt: string
}

export type SshHostsSnapshot = {
  hosts: SshHost[]
  secureStorageAvailable: boolean
}

export type SshHostKeyInspection = {
  candidateId: string
  hostId?: string
  state: SshHostKeyState
  algorithm: string
  fingerprintSha256: string
  previousHostKey?: {
    algorithm: string
    fingerprintSha256: string
  }
}

export type SshHostConnectionTestResult = {
  hostId: string
  connected: true
  latencyMs: number
  platform: 'linux' | 'darwin' | 'win32' | 'unknown'
  architecture: 'x64' | 'arm64' | 'unknown'
  shell: string
  homeDirectory: string
  detail: string
}

export type SshHostValidationResult = {
  host: SshHost
  connection: SshHostConnectionTestResult
}

export const sshHostRemoteEnvironmentVersionSchema = z
  .object({
    version: componentVersionSchema,
    architecture: z.enum(['x64', 'arm64'])
  })
  .strict()

export const sshHostRemoteEnvironmentStateSchema = z.enum([
  'current',
  'update-available',
  'not-installed'
])

export const sshHostRemoteEnvironmentSchema = z
  .object({
    hostId: sshHostIdSchema,
    checkedAt: z.string().datetime({ offset: true }),
    architecture: z.enum(['x64', 'arm64']),
    agent: z
      .object({
        state: sshHostRemoteEnvironmentStateSchema,
        expected: sshHostRemoteEnvironmentVersionSchema,
        installed: sshHostRemoteEnvironmentVersionSchema.nullable()
      })
      .strict(),
    runtimes: z
      .array(
        z
          .object({
            runtimeId: z.literal('opencode'),
            provider: z.literal('opencode'),
            state: sshHostRemoteEnvironmentStateSchema,
            expected: sshHostRemoteEnvironmentVersionSchema,
            installed:
              sshHostRemoteEnvironmentVersionSchema.nullable()
          })
          .strict()
      )
      .max(16)
  })
  .strict()

export type SshHostRemoteEnvironment = z.infer<
  typeof sshHostRemoteEnvironmentSchema
>

export const agentBootstrapIncompatibleReasonSchema = z.enum([
  'non-linux',
  'unsupported-architecture',
  'home-directory-unavailable',
  'uid-unavailable',
  'shell-unavailable',
  'procfs-unavailable'
])

export type AgentBootstrapIncompatibleReason = z.infer<
  typeof agentBootstrapIncompatibleReasonSchema
>

export const canonicalRemotePathSchema = z
  .string()
  .min(1)
  .max(4_096)
  .refine(
    (value) =>
      value.startsWith('/') &&
      value !== '/.' &&
      value !== '/..' &&
      !value.includes('//') &&
      !value.split('/').some((part) => part === '.' || part === '..') &&
      !/[\p{Cc}\p{Cs}\u2028\u2029\ufffd]/u.test(value),
    '远端路径必须是无控制字符的规范绝对路径'
  )

export const SSH_DIRECTORY_BROWSE_LIMITS = {
  maximumPathBytes: 4_096,
  maximumNameBytes: 255,
  maximumEntries: 500
} as const

export const sshDirectoryBrowsePathSchema =
  canonicalRemotePathSchema.refine(
    (value) =>
      (value === '/' || !value.endsWith('/')) &&
      utf8ByteLength(value) <=
        SSH_DIRECTORY_BROWSE_LIMITS.maximumPathBytes,
    '远端目录路径必须是规范绝对路径，且不能超过 4096 UTF-8 字节'
  )

export const sshDirectoryBrowseRequestSchema = z
  .object({
    hostId: sshHostIdSchema,
    path: sshDirectoryBrowsePathSchema.optional()
  })
  .strict()

export type SshDirectoryBrowseRequest = z.infer<
  typeof sshDirectoryBrowseRequestSchema
>

export const sshDirectoryBrowseEntrySchema = z
  .object({
    name: z
      .string()
      .min(1)
      .max(255)
      .refine(
        (value) =>
          value !== '.' &&
          value !== '..' &&
          !value.includes('/') &&
          !/[\p{Cc}\p{Cs}\u2028\u2029\ufffd]/u.test(value) &&
          utf8ByteLength(value) <=
            SSH_DIRECTORY_BROWSE_LIMITS.maximumNameBytes,
        '远端目录名称无效或超过 255 UTF-8 字节'
      ),
    path: sshDirectoryBrowsePathSchema
  })
  .strict()

export type SshDirectoryBrowseEntry = z.infer<
  typeof sshDirectoryBrowseEntrySchema
>

function parentRemotePath(path: string): string | null {
  if (path === '/') {
    return null
  }
  const separator = path.lastIndexOf('/')
  return separator === 0 ? '/' : path.slice(0, separator)
}

export const sshDirectoryBrowseResultSchema = z
  .object({
    path: sshDirectoryBrowsePathSchema,
    homeDirectory: sshDirectoryBrowsePathSchema,
    parentPath: sshDirectoryBrowsePathSchema.nullable(),
    entries: z
      .array(sshDirectoryBrowseEntrySchema)
      .max(SSH_DIRECTORY_BROWSE_LIMITS.maximumEntries),
    truncated: z.boolean()
  })
  .strict()
  .superRefine((result, context) => {
    const expectedParentPath = parentRemotePath(result.path)
    if (result.parentPath !== expectedParentPath) {
      context.addIssue({
        code: 'custom',
        path: ['parentPath'],
        message: '父目录路径与当前目录不匹配'
      })
    }

    const names = new Set<string>()
    const paths = new Set<string>()
    let previousName: string | undefined
    for (const [index, entry] of result.entries.entries()) {
      const expectedPath =
        result.path === '/'
          ? `/${entry.name}`
          : `${result.path}/${entry.name}`
      if (entry.path !== expectedPath) {
        context.addIssue({
          code: 'custom',
          path: ['entries', index, 'path'],
          message: '目录项路径与当前目录或名称不匹配'
        })
      }
      if (names.has(entry.name) || paths.has(entry.path)) {
        context.addIssue({
          code: 'custom',
          path: ['entries', index],
          message: '目录项不能重复'
        })
      }
      if (previousName !== undefined && previousName >= entry.name) {
        context.addIssue({
          code: 'custom',
          path: ['entries', index, 'name'],
          message: '目录项必须按名称严格升序排列'
        })
      }
      names.add(entry.name)
      paths.add(entry.path)
      previousName = entry.name
    }
  })

export type SshDirectoryBrowseResult = z.infer<
  typeof sshDirectoryBrowseResultSchema
>

// Keep the schema names aligned with the other host-scoped contracts.
export const sshHostDirectoryBrowseRequestSchema =
  sshDirectoryBrowseRequestSchema
export const sshHostDirectoryBrowseResultSchema =
  sshDirectoryBrowseResultSchema
export type SshHostDirectoryBrowseRequest = SshDirectoryBrowseRequest
export type SshHostDirectoryBrowseResult = SshDirectoryBrowseResult

export const agentBootstrapProbeResultSchema = z.discriminatedUnion(
  'ready',
  [
    z
      .object({
        ready: z.literal(true),
        platform: z.literal('linux'),
        architecture: z.enum(['x64', 'arm64']),
        canonicalHomeDirectory: canonicalRemotePathSchema,
        uid: z.number().int().min(0).max(4_294_967_294),
        shell: canonicalRemotePathSchema,
        procfs: z.literal('ready')
      })
      .strict(),
    z
      .object({
        ready: z.literal(false),
        reason: agentBootstrapIncompatibleReasonSchema
      })
      .strict()
  ]
)

export type AgentBootstrapProbeResult = z.infer<
  typeof agentBootstrapProbeResultSchema
>

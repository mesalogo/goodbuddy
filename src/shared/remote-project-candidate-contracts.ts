import { z } from 'zod'
import { assistantIdSchema, projectCreateSchema } from './assistant-contracts'
import {
  REMOTE_WORKSPACE_LIMITS,
  remoteAbsolutePathSchema
} from './remote-agent-contracts'
import { agentRuntimeSelectionSchema } from './runtime-selection-contracts'
import { sshHostIdSchema } from './ssh-host-contracts'

export const REMOTE_PROJECT_SAVE_LIMITS = {
  maximumAbsolutePathBytes:
    REMOTE_WORKSPACE_LIMITS.maximumAbsolutePathBytes
} as const

export const remoteProjectRootPathSchema = remoteAbsolutePathSchema
  .refine(
    (value) => !/[\p{Cc}\p{Cs}\u2028\u2029\ufffd]/u.test(value),
    'Remote project root cannot contain control characters'
  )
  .refine(
    (value) =>
      !value.includes('//') &&
      !value
        .split('/')
        .some((segment) => segment === '.' || segment === '..'),
    'Remote project root cannot contain empty, dot, or parent segments'
  )

const commonDraftFields = {
  name: projectCreateSchema.shape.name,
  description: projectCreateSchema.shape.description,
  defaultWorkMode: projectCreateSchema.shape.defaultWorkMode,
  runtimeSelection: agentRuntimeSelectionSchema,
  hostId: sshHostIdSchema,
  remoteRootPath: remoteProjectRootPathSchema
} as const

export const remoteProjectCreateDraftSchema =
  z.object(commonDraftFields).strict()

export const remoteProjectUpdateDraftSchema = z
  .object({
    projectId: assistantIdSchema,
    ...commonDraftFields
  })
  .strict()

export const remoteProjectSaveRequestSchema = z.discriminatedUnion(
  'intent',
  [
    z
      .object({
        intent: z.literal('create'),
        draft: remoteProjectCreateDraftSchema
      })
      .strict(),
    z
      .object({
        intent: z.literal('update'),
        draft: remoteProjectUpdateDraftSchema
      })
      .strict()
  ]
)

export const remoteProjectSavePhaseSchema = z.enum([
  'host',
  'agent',
  'workspace',
  'runtime',
  'saving'
])

export const remoteProjectSaveProgressSchema = z
  .object({
    phase: remoteProjectSavePhaseSchema
  })
  .strict()

export type RemoteProjectCreateDraft = z.infer<
  typeof remoteProjectCreateDraftSchema
>
export type RemoteProjectUpdateDraft = z.infer<
  typeof remoteProjectUpdateDraftSchema
>
export type RemoteProjectSaveRequest = z.infer<
  typeof remoteProjectSaveRequestSchema
>
export type RemoteProjectSavePhase = z.infer<
  typeof remoteProjectSavePhaseSchema
>
export type RemoteProjectSaveProgress = z.infer<
  typeof remoteProjectSaveProgressSchema
>

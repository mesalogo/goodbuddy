import { z } from 'zod'
import { workbarTargetRefSchema } from './workbar-contracts'

export const TERMINAL_LIMITS = {
  maximumSessionsPerWindow: 12,
  minimumColumns: 2,
  maximumColumns: 500,
  minimumRows: 1,
  maximumRows: 200,
  maximumTitleBytes: 256,
  maximumShellLabelBytes: 256,
  maximumTargetLabelBytes: 512,
  maximumWorkingDirectoryBytes: 4 * 1024,
  maximumInputBytes: 64 * 1024,
  maximumEventBytes: 64 * 1024,
  maximumPendingEvents: 256,
  maximumBufferedOutputBytes: 4 * 1024 * 1024,
  maximumErrorMessageBytes: 2 * 1024
} as const

const boundedUtf8StringSchema = (
  maximumBytes: number,
  minimumBytes = 0
): z.ZodType<string> =>
  z.string().refine(
    (value) => {
      const size = new TextEncoder().encode(value).byteLength
      return size >= minimumBytes && size <= maximumBytes
    },
    `Value must contain ${minimumBytes}-${maximumBytes} UTF-8 bytes`
  )

export const terminalSessionIdSchema = z.string().uuid()
export type TerminalSessionId = z.infer<
  typeof terminalSessionIdSchema
>

export const terminalTargetSchema = workbarTargetRefSchema
export type TerminalTarget = z.infer<typeof terminalTargetSchema>

export const terminalSessionStateSchema = z.enum([
  'starting',
  'running',
  'exited',
  'interrupted',
  'closing',
  'failed'
])
export type TerminalSessionState = z.infer<
  typeof terminalSessionStateSchema
>

export const terminalErrorCodeSchema = z.enum([
  'session-limit-reached',
  'target-not-found',
  'target-unavailable',
  'host-unverified',
  'credentials-unavailable',
  'interactive-shell-unsupported',
  'launch-failed',
  'connection-failed',
  'session-not-found',
  'session-not-running',
  'interrupted',
  'output-limit-exceeded',
  'internal-error'
])
export type TerminalErrorCode = z.infer<
  typeof terminalErrorCodeSchema
>

export const terminalErrorSchema = z
  .object({
    code: terminalErrorCodeSchema,
    message: boundedUtf8StringSchema(
      TERMINAL_LIMITS.maximumErrorMessageBytes,
      1
    ),
    retryable: z.boolean()
  })
  .strict()
export type TerminalError = z.infer<typeof terminalErrorSchema>

export const terminalSizeSchema = z
  .object({
    cols: z
      .number()
      .int()
      .min(TERMINAL_LIMITS.minimumColumns)
      .max(TERMINAL_LIMITS.maximumColumns),
    rows: z
      .number()
      .int()
      .min(TERMINAL_LIMITS.minimumRows)
      .max(TERMINAL_LIMITS.maximumRows)
  })
  .strict()
export type TerminalSize = z.infer<typeof terminalSizeSchema>

export const terminalCreateRequestSchema = z
  .object({
    target: terminalTargetSchema,
    cols: terminalSizeSchema.shape.cols,
    rows: terminalSizeSchema.shape.rows
  })
  .strict()
export type TerminalCreateRequest = z.infer<
  typeof terminalCreateRequestSchema
>

export const terminalWriteRequestSchema = z
  .object({
    sessionId: terminalSessionIdSchema,
    data: boundedUtf8StringSchema(TERMINAL_LIMITS.maximumInputBytes, 1)
  })
  .strict()
export type TerminalWriteRequest = z.infer<
  typeof terminalWriteRequestSchema
>

export const terminalResizeRequestSchema = z
  .object({
    sessionId: terminalSessionIdSchema,
    cols: terminalSizeSchema.shape.cols,
    rows: terminalSizeSchema.shape.rows
  })
  .strict()
export type TerminalResizeRequest = z.infer<
  typeof terminalResizeRequestSchema
>

export const terminalCloseRequestSchema = z
  .object({
    sessionId: terminalSessionIdSchema
  })
  .strict()
export type TerminalCloseRequest = z.infer<
  typeof terminalCloseRequestSchema
>

export const terminalSnapshotRequestSchema = terminalCloseRequestSchema
export type TerminalSnapshotRequest = TerminalCloseRequest

const terminalSequenceSchema = z.number().int().safe().min(0)
const terminalEventSequenceSchema = terminalSequenceSchema.min(1)

export const terminalAckRequestSchema = z
  .object({
    sessionId: terminalSessionIdSchema,
    sequence: terminalSequenceSchema
  })
  .strict()
export type TerminalAckRequest = z.infer<
  typeof terminalAckRequestSchema
>

export const terminalExitSchema = z
  .object({
    exitCode: z.number().int().safe().nullable(),
    signal: boundedUtf8StringSchema(128, 1).nullable()
  })
  .strict()
  .refine(
    (exit) => exit.exitCode !== null || exit.signal !== null,
    'An exit must include an exit code or signal'
  )
export type TerminalExit = z.infer<typeof terminalExitSchema>

export const terminalSnapshotSchema = z
  .object({
    sessionId: terminalSessionIdSchema,
    target: terminalTargetSchema,
    targetLabel: boundedUtf8StringSchema(
      TERMINAL_LIMITS.maximumTargetLabelBytes,
      1
    ),
    title: boundedUtf8StringSchema(
      TERMINAL_LIMITS.maximumTitleBytes,
      1
    ),
    state: terminalSessionStateSchema,
    shell: boundedUtf8StringSchema(
      TERMINAL_LIMITS.maximumShellLabelBytes,
      1
    ),
    workingDirectory: boundedUtf8StringSchema(
      TERMINAL_LIMITS.maximumWorkingDirectoryBytes,
      1
    ),
    size: terminalSizeSchema,
    lastSequence: terminalSequenceSchema,
    exit: terminalExitSchema.nullable(),
    error: terminalErrorSchema.nullable()
  })
  .strict()
  .superRefine((snapshot, context) => {
    if (snapshot.state === 'exited' && snapshot.exit === null) {
      context.addIssue({
        code: 'custom',
        path: ['exit'],
        message: 'Exited terminal snapshots require exit details'
      })
    }
    if (snapshot.state !== 'exited' && snapshot.exit !== null) {
      context.addIssue({
        code: 'custom',
        path: ['exit'],
        message: 'Only exited terminal snapshots include exit details'
      })
    }
  })
export type TerminalSnapshot = z.infer<
  typeof terminalSnapshotSchema
>

const terminalEventBase = {
  sessionId: terminalSessionIdSchema,
  sequence: terminalEventSequenceSchema
} as const

export const terminalEventSchema = z.discriminatedUnion('type', [
  z
    .object({
      ...terminalEventBase,
      type: z.literal('output'),
      data: boundedUtf8StringSchema(
        TERMINAL_LIMITS.maximumEventBytes,
        1
      )
    })
    .strict(),
  z
    .object({
      ...terminalEventBase,
      type: z.literal('state'),
      state: terminalSessionStateSchema
    })
    .strict(),
  z
    .object({
      ...terminalEventBase,
      type: z.literal('exit'),
      exit: terminalExitSchema
    })
    .strict(),
  z
    .object({
      ...terminalEventBase,
      type: z.literal('error'),
      error: terminalErrorSchema
    })
    .strict()
])
export type TerminalEvent = z.infer<typeof terminalEventSchema>

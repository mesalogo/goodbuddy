import { z } from 'zod'

export const AGENT_PROTOCOL_VERSION = {
  major: 2,
  minor: 0
} as const

export const AGENT_PROTOCOL_LIMITS = {
  maximumControlFrameBytes: 1024 * 1024,
  maximumAcpFrameBytes: 1024 * 1024,
  maximumBlobFrameBytes: 2 * 1024 * 1024,
  maximumAckFrameBytes: 1024,
  maximumBufferedProtocolBytes: 32 * 1024 * 1024,
  maximumChannelsPerConnection: 64,
  maximumIdentifierBytes: 128,
  maximumMethodLength: 200,
  maximumEventPayloadBytes: 1024 * 1024,
  runEventJournalBytes: 8 * 1024 * 1024,
  runTerminalReserveBytes: 512 * 1024,
  controllerJournalBytes: 128 * 1024 * 1024,
  daemonJournalBytes: 512 * 1024 * 1024,
  runPendingEvents: 1_000,
  maximumAcpFramesPerChannel: 1_000,
  maximumAcpFramesPerController: 32_000,
  maximumAcpFramesPerDaemon: 128_000
} as const

const identifierPattern = /^[A-Za-z0-9](?:[A-Za-z0-9._:-]{0,127})$/u
const decimalPattern = /^(?:0|[1-9][0-9]{0,15})$/u

export const agentIdentifierSchema = z
  .string()
  .min(1)
  .max(AGENT_PROTOCOL_LIMITS.maximumIdentifierBytes)
  .regex(identifierPattern)

export const agentSequenceSchema = z
  .string()
  .regex(decimalPattern)
  .refine(
    (value) => BigInt(value) <= BigInt(Number.MAX_SAFE_INTEGER),
    'Sequence exceeds the process-neutral safe integer range'
  )

export const positiveAgentSequenceSchema = agentSequenceSchema.refine(
  (value) => value !== '0',
  'Sequence must be positive'
)

export const protocolVersionSchema = z
  .object({
    major: z.number().int().min(0).max(65_535),
    minor: z.number().int().min(0).max(65_535)
  })
  .strict()

export const agentFrameKindSchema = z.enum([
  'control',
  'acp',
  'blob',
  'ack'
])

export const agentFrameDirectionSchema = z.enum([
  'main-to-agent',
  'agent-to-main'
])

export const agentFrameHeaderSchema = z
  .object({
    protocolMajor: protocolVersionSchema.shape.major,
    protocolMinor: protocolVersionSchema.shape.minor,
    connectionId: agentIdentifierSchema,
    generation: z.number().int().min(1).max(0xffff_ffff),
    channelId: agentIdentifierSchema,
    channelEpoch: positiveAgentSequenceSchema,
    direction: agentFrameDirectionSchema,
    sequence: positiveAgentSequenceSchema,
    kind: agentFrameKindSchema,
    payloadLength: z.number().int().min(0)
  })
  .strict()
  .superRefine((header, context) => {
    const maximum = maximumPayloadLength(header.kind)
    if (header.payloadLength > maximum) {
      context.addIssue({
        code: 'too_big',
        origin: 'number',
        maximum,
        inclusive: true,
        path: ['payloadLength'],
        message: `${header.kind} payload exceeds ${maximum} bytes`
      })
    }
  })

export type AgentFrameKind = z.infer<typeof agentFrameKindSchema>
export type AgentFrameDirection = z.infer<
  typeof agentFrameDirectionSchema
>
export type AgentFrameHeader = z.infer<typeof agentFrameHeaderSchema>

export const frameAcknowledgmentSchema = z
  .object({
    acknowledgedSequence: positiveAgentSequenceSchema
  })
  .strict()

export type FrameAcknowledgment = z.infer<
  typeof frameAcknowledgmentSchema
>

export const operationScopeSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('project-candidate'),
      candidateId: agentIdentifierSchema
    })
    .strict(),
  z
    .object({
      kind: z.literal('workspace'),
      workspaceIdentity: agentIdentifierSchema
    })
    .strict(),
  z
    .object({
      kind: z.literal('run'),
      sessionId: agentIdentifierSchema,
      requestId: agentIdentifierSchema
    })
    .strict(),
  z
    .object({
      kind: z.literal('terminal'),
      terminalId: agentIdentifierSchema
    })
    .strict(),
  z
    .object({
      kind: z.literal('managed-process'),
      processId: agentIdentifierSchema
    })
    .strict(),
  z
    .object({
      kind: z.literal('installation'),
      installationId: agentIdentifierSchema
    })
    .strict()
])

export type OperationScope = z.infer<typeof operationScopeSchema>

export const sha256DigestSchema = z
  .string()
  .regex(/^sha256:[a-f0-9]{64}$/u)

export function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength
}

export function utf8StringSchema(
  maximumBytes: number,
  options: {
    minimumBytes?: number
    label?: string
  } = {}
): z.ZodType<string> {
  if (
    !Number.isSafeInteger(maximumBytes) ||
    maximumBytes < 0 ||
    !Number.isSafeInteger(options.minimumBytes ?? 0) ||
    (options.minimumBytes ?? 0) < 0 ||
    (options.minimumBytes ?? 0) > maximumBytes
  ) {
    throw new RangeError('Invalid UTF-8 string byte limits')
  }
  const label = options.label ?? 'String'
  const minimumBytes = options.minimumBytes ?? 0
  return z.string().superRefine((value, context) => {
    const bytes = utf8ByteLength(value)
    if (bytes < minimumBytes) {
      context.addIssue({
        code: 'custom',
        message: `${label} must contain at least ${minimumBytes} UTF-8 bytes`
      })
    }
    if (bytes > maximumBytes) {
      context.addIssue({
        code: 'custom',
        message: `${label} exceeds ${maximumBytes} UTF-8 bytes`
      })
    }
  })
}

export const operationMethodSchema = z
  .string()
  .min(1)
  .max(AGENT_PROTOCOL_LIMITS.maximumMethodLength)
  .regex(/^[a-z][A-Za-z0-9-]*\/[A-Za-z][A-Za-z0-9-]*$/u)

export const operationIdentitySchema = z
  .object({
    controllerId: agentIdentifierSchema,
    operationId: agentIdentifierSchema,
    scope: operationScopeSchema,
    method: operationMethodSchema,
    payloadDigest: sha256DigestSchema
  })
  .strict()

export type OperationIdentity = z.infer<typeof operationIdentitySchema>

export const eventIdentitySchema = z
  .object({
    controllerId: agentIdentifierSchema,
    streamId: agentIdentifierSchema,
    streamEpoch: positiveAgentSequenceSchema,
    sequence: positiveAgentSequenceSchema
  })
  .strict()

export type EventIdentity = z.infer<typeof eventIdentitySchema>

export const acpFrameDirectionSchema = z.enum([
  'main-to-runtime',
  'runtime-to-main'
])

export type AcpFrameDirection = z.infer<
  typeof acpFrameDirectionSchema
>

export function maximumPayloadLength(kind: AgentFrameKind): number {
  switch (kind) {
    case 'control':
      return AGENT_PROTOCOL_LIMITS.maximumControlFrameBytes
    case 'acp':
      return AGENT_PROTOCOL_LIMITS.maximumAcpFrameBytes
    case 'blob':
      return AGENT_PROTOCOL_LIMITS.maximumBlobFrameBytes
    case 'ack':
      return AGENT_PROTOCOL_LIMITS.maximumAckFrameBytes
  }
}

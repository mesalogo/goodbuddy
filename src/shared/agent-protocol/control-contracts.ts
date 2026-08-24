import { z } from 'zod'
import {
  AGENT_PROTOCOL_LIMITS,
  agentIdentifierSchema,
  agentSequenceSchema,
  positiveAgentSequenceSchema,
  protocolVersionSchema,
  sha256DigestSchema,
  utf8StringSchema
} from './contracts'

const generationSchema = z.number().int().min(1).max(0xffff_ffff)
const timestampSchema = z.string().datetime({ offset: true })

export const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.null(),
    z.boolean(),
    z.number().finite(),
    z.string(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema)
  ])
)

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue }

export const jsonRpcIdSchema = z.union([
  z.string().min(1).max(AGENT_PROTOCOL_LIMITS.maximumIdentifierBytes),
  z.number().int().safe()
])

export const jsonRpcResponseIdSchema = z.union([
  jsonRpcIdSchema,
  z.null()
])

export const jsonRpcParamsSchema = z.union([
  z.array(jsonValueSchema),
  z.record(z.string(), jsonValueSchema)
])

const jsonRpcMethodSchema = utf8StringSchema(
  AGENT_PROTOCOL_LIMITS.maximumMethodLength,
  { minimumBytes: 1, label: 'JSON-RPC method' }
)

export const jsonRpcRequestSchema = z
  .object({
    jsonrpc: z.literal('2.0'),
    id: jsonRpcIdSchema,
    method: jsonRpcMethodSchema,
    params: jsonRpcParamsSchema.optional()
  })
  .strict()

export const jsonRpcNotificationSchema = z
  .object({
    jsonrpc: z.literal('2.0'),
    method: jsonRpcMethodSchema,
    params: jsonRpcParamsSchema.optional()
  })
  .strict()

export const jsonRpcSuccessResponseSchema = z
  .object({
    jsonrpc: z.literal('2.0'),
    id: jsonRpcResponseIdSchema,
    result: jsonValueSchema
  })
  .strict()

export const jsonRpcErrorObjectSchema = z
  .object({
    code: z.number().int().safe(),
    message: utf8StringSchema(8 * 1024, {
      minimumBytes: 1,
      label: 'JSON-RPC error message'
    }),
    data: jsonValueSchema.optional()
  })
  .strict()

export const jsonRpcErrorResponseSchema = z
  .object({
    jsonrpc: z.literal('2.0'),
    id: jsonRpcResponseIdSchema,
    error: jsonRpcErrorObjectSchema
  })
  .strict()

export const jsonRpcMessageSchema = z.union([
  jsonRpcRequestSchema,
  jsonRpcNotificationSchema,
  jsonRpcSuccessResponseSchema,
  jsonRpcErrorResponseSchema
])

export type JsonRpcRequest = z.infer<typeof jsonRpcRequestSchema>
export type JsonRpcNotification = z.infer<
  typeof jsonRpcNotificationSchema
>
export type JsonRpcSuccessResponse = z.infer<
  typeof jsonRpcSuccessResponseSchema
>
export type JsonRpcErrorResponse = z.infer<
  typeof jsonRpcErrorResponseSchema
>
export type JsonRpcMessage = z.infer<typeof jsonRpcMessageSchema>

export const attachPrefaceSchema = z
  .object({
    type: z.literal('goodbuddy-agent-attach'),
    protocol: protocolVersionSchema,
    goodBuddyVersion: utf8StringSchema(64, {
      minimumBytes: 1,
      label: 'GoodBuddy version'
    }),
    controllerId: agentIdentifierSchema,
    clientNonce: agentIdentifierSchema,
    hostRevision: generationSchema,
    hostKeyGeneration: generationSchema
  })
  .strict()

export const attachWelcomeSchema = z
  .object({
    type: z.literal('goodbuddy-agent-welcome'),
    protocol: protocolVersionSchema,
    connectionId: agentIdentifierSchema,
    generation: generationSchema,
    installationId: agentIdentifierSchema,
    binaryDigest: sha256DigestSchema,
    daemonBootId: agentIdentifierSchema,
    serverNonce: agentIdentifierSchema
  })
  .strict()

export type AttachPreface = z.infer<typeof attachPrefaceSchema>
export type AttachWelcome = z.infer<typeof attachWelcomeSchema>

export const agentCapabilitySchema = z
  .object({
    name: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[a-z][a-z0-9.-]*(?:\/[a-z][a-z0-9.-]*)?$/u),
    version: z.number().int().min(1).max(65_535),
    critical: z.boolean()
  })
  .strict()

export const daemonStatusSchema = z
  .object({
    state: z.enum([
      'unknown',
      'inspecting',
      'missing',
      'installed',
      'installing',
      'starting',
      'handshaking',
      'synchronizing',
      'ready',
      'draining',
      'offline',
      'incompatible',
      'corrupt',
      'supervisor-unavailable',
      'upgrade-rollback'
    ]),
    installationId: agentIdentifierSchema,
    binaryDigest: sha256DigestSchema,
    daemonBootId: agentIdentifierSchema,
    agentVersion: utf8StringSchema(64, {
      minimumBytes: 1,
      label: 'Agent version'
    }),
    protocol: protocolVersionSchema,
    platform: z.literal('linux'),
    architecture: z.enum(['x64', 'arm64']),
    supervisor: z.literal('detached-on-demand'),
    remoteUserIdentity: agentIdentifierSchema,
    draining: z.boolean()
  })
  .strict()

export const daemonCapabilitiesSchema = z
  .object({
    generation: generationSchema,
    capabilities: z.array(agentCapabilitySchema).max(256),
    runtimes: z
      .array(
        z
          .object({
            runtimeId: agentIdentifierSchema,
            version: utf8StringSchema(64, {
              minimumBytes: 1,
              label: 'Runtime version'
            }),
            bundleDigest: sha256DigestSchema,
            acpCapabilitiesDigest: sha256DigestSchema,
            sessionLoad: z.boolean(),
            sessionResume: z.boolean()
          })
          .strict()
      )
      .max(64)
  })
  .strict()
  .superRefine((value, context) => {
    const names = new Set<string>()
    for (let index = 0; index < value.capabilities.length; index += 1) {
      const name = value.capabilities[index]!.name
      if (names.has(name)) {
        context.addIssue({
          code: 'custom',
          path: ['capabilities', index, 'name'],
          message: 'Capability names must be unique'
        })
      }
      names.add(name)
    }
  })

export const controllerResumeRequestSchema = z
  .object({
    previousGeneration: generationSchema,
    previousConnectionId: agentIdentifierSchema,
    daemonBootId: agentIdentifierSchema,
    capabilityGeneration: generationSchema
  })
  .strict()

export const controllerResumeResultSchema = z
  .object({
    resumed: z.boolean(),
    generation: generationSchema,
    daemonBootId: agentIdentifierSchema,
    capabilityGeneration: generationSchema,
    leaseDeadlineAt: timestampSchema
  })
  .strict()

export const acpOpenChannelRequestSchema = z
  .object({
    bindingId: agentIdentifierSchema,
    runtimeId: agentIdentifierSchema,
    runtimeBundleDigest: sha256DigestSchema,
    workspaceIdentity: agentIdentifierSchema
  })
  .strict()

export const acpOpenChannelResultSchema = z
  .object({
    bindingId: agentIdentifierSchema,
    channelId: agentIdentifierSchema,
    channelEpoch: positiveAgentSequenceSchema,
    acpCapabilitiesDigest: sha256DigestSchema
  })
  .strict()

export const acpCloseChannelRequestSchema = z
  .object({
    bindingId: agentIdentifierSchema,
    channelId: agentIdentifierSchema,
    channelEpoch: positiveAgentSequenceSchema,
    reason: z.enum(['released', 'cancelled', 'draining', 'failed'])
  })
  .strict()

export const acpCloseChannelResultSchema = z
  .object({
    bindingId: agentIdentifierSchema,
    channelEpoch: positiveAgentSequenceSchema,
    closed: z.literal(true)
  })
  .strict()

export const acpGetCursorsRequestSchema = z
  .object({
    bindingId: agentIdentifierSchema
  })
  .strict()

export const acpResumeChannelRequestSchema = z
  .object({
    bindingId: agentIdentifierSchema,
    channelId: agentIdentifierSchema,
    channelEpoch: positiveAgentSequenceSchema
  })
  .strict()

export const acpBindingCursorsSchema = z
  .object({
    lastOutboundJournaledSequence: agentSequenceSchema,
    lastOutboundDeliveredSequence: agentSequenceSchema,
    lastInboundJournaledSequence: agentSequenceSchema,
    lastMainAckSequence: agentSequenceSchema
  })
  .strict()
  .superRefine((cursors, context) => {
    if (
      BigInt(cursors.lastOutboundDeliveredSequence) >
      BigInt(cursors.lastOutboundJournaledSequence)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['lastOutboundDeliveredSequence'],
        message: 'Delivered cursor cannot exceed journaled cursor'
      })
    }
    if (
      BigInt(cursors.lastMainAckSequence) >
      BigInt(cursors.lastInboundJournaledSequence)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['lastMainAckSequence'],
        message: 'Main ACK cursor cannot exceed journaled cursor'
      })
    }
  })

export const acpResumeChannelResultSchema = z
  .object({
    bindingId: agentIdentifierSchema,
    channelId: agentIdentifierSchema,
    channelEpoch: positiveAgentSequenceSchema,
    deadlineAt: timestampSchema,
    cursors: acpBindingCursorsSchema
  })
  .strict()

export const acpReplayChannelRequestSchema = z
  .object({
    bindingId: agentIdentifierSchema,
    channelId: agentIdentifierSchema,
    channelEpoch: positiveAgentSequenceSchema,
    acknowledgedSequence: agentSequenceSchema
  })
  .strict()

export const acpReplayChannelResultSchema = z
  .object({
    bindingId: agentIdentifierSchema,
    channelId: agentIdentifierSchema,
    channelEpoch: positiveAgentSequenceSchema,
    replayedThroughSequence: agentSequenceSchema,
    live: z.literal(true)
  })
  .strict()

export const acpCancellationReasonSchema = z.enum([
  'aborted',
  'timeout',
  'error',
  'requested',
  'unspecified'
])

export const acpEscalateCancellationRequestSchema = z
  .object({
    bindingId: agentIdentifierSchema,
    sessionId: agentIdentifierSchema,
    operationId: agentIdentifierSchema,
    requestId: agentIdentifierSchema,
    reason: acpCancellationReasonSchema
  })
  .strict()

export const acpEscalateCancellationResultSchema = z
  .object({
    bindingId: agentIdentifierSchema,
    stopped: z.literal(true)
  })
  .strict()

export const acpReconcilePromptRequestSchema = z
  .object({
    bindingId: agentIdentifierSchema,
    operationId: agentIdentifierSchema,
    requestId: agentIdentifierSchema
  })
  .strict()

export const acpCompletePromptRequestSchema = z
  .object({
    bindingId: agentIdentifierSchema,
    operationId: agentIdentifierSchema,
    requestId: agentIdentifierSchema
  })
  .strict()

export const acpCompletePromptResultSchema = z
  .object({
    bindingId: agentIdentifierSchema,
    operationId: agentIdentifierSchema,
    requestId: agentIdentifierSchema,
    status: z.literal('completed'),
    processTree: z.enum(['running', 'empty'])
  })
  .strict()

export const acpReconcilePromptResultSchema = z.discriminatedUnion(
  'status',
  [
    z
      .object({
        status: z.literal('terminal'),
        terminalState: z.enum([
          'completed',
          'failed',
          'cancelled',
          'interrupted'
        ]),
        processTree: z.enum(['running', 'empty'])
      })
      .strict()
      .superRefine((result, context) => {
        if (
          result.processTree === 'running' &&
          result.terminalState !== 'completed'
        ) {
          context.addIssue({
            code: 'custom',
            path: ['processTree'],
            message:
              'Only a completed prompt may retain a running process tree'
          })
        }
      }),
    z
      .object({
        status: z.literal('running'),
        processTree: z.literal('running')
      })
      .strict(),
    z
      .object({
        status: z.literal('outcome-unknown'),
        processTree: z.literal('unknown')
      })
      .strict()
  ]
)

export const channelCloseRequestSchema = z
  .object({
    channelId: agentIdentifierSchema,
    channelEpoch: positiveAgentSequenceSchema
  })
  .strict()

export type DaemonStatus = z.infer<typeof daemonStatusSchema>
export type DaemonCapabilities = z.infer<typeof daemonCapabilitiesSchema>
export type ControllerResumeRequest = z.infer<
  typeof controllerResumeRequestSchema
>
export type ControllerResumeResult = z.infer<
  typeof controllerResumeResultSchema
>
export type AcpOpenChannelRequest = z.infer<
  typeof acpOpenChannelRequestSchema
>
export type AcpOpenChannelResult = z.infer<
  typeof acpOpenChannelResultSchema
>
export type AcpCloseChannelRequest = z.infer<
  typeof acpCloseChannelRequestSchema
>
export type AcpCloseChannelResult = z.infer<
  typeof acpCloseChannelResultSchema
>
export type AcpGetCursorsRequest = z.infer<
  typeof acpGetCursorsRequestSchema
>
export type AcpResumeChannelRequest = z.infer<
  typeof acpResumeChannelRequestSchema
>
export type AcpResumeChannelResult = z.infer<
  typeof acpResumeChannelResultSchema
>
export type AcpReplayChannelRequest = z.infer<
  typeof acpReplayChannelRequestSchema
>
export type AcpReplayChannelResult = z.infer<
  typeof acpReplayChannelResultSchema
>
export type AcpBindingCursors = z.infer<
  typeof acpBindingCursorsSchema
>
export type AcpEscalateCancellationRequest = z.infer<
  typeof acpEscalateCancellationRequestSchema
>
export type AcpEscalateCancellationResult = z.infer<
  typeof acpEscalateCancellationResultSchema
>
export type AcpReconcilePromptRequest = z.infer<
  typeof acpReconcilePromptRequestSchema
>
export type AcpReconcilePromptResult = z.infer<
  typeof acpReconcilePromptResultSchema
>
export type AcpCompletePromptRequest = z.infer<
  typeof acpCompletePromptRequestSchema
>
export type AcpCompletePromptResult = z.infer<
  typeof acpCompletePromptResultSchema
>
export const agentAttachPrefaceSchema = attachPrefaceSchema
export const agentAttachWelcomeSchema = attachWelcomeSchema
export const agentStatusSchema = daemonStatusSchema
export const agentCapabilitiesSchema = daemonCapabilitiesSchema

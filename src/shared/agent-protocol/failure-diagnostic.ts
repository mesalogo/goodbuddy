import { z } from 'zod'
import { agentIdentifierSchema } from './contracts'

export const AGENT_PROTOCOL_FAILURE_RECORD_NAME =
  'protocol-failure.json'
export const AGENT_PROTOCOL_FAILURE_STDERR_PREFIX =
  'GoodBuddy Agent protocol failure: '

export const agentProtocolFailureCategorySchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-z][a-z0-9-]*(?:\/[a-z][a-z0-9-]*)*$/u)

export const agentProtocolFailureRecordSchema = z
  .object({
    formatVersion: z.literal(1),
    connectionId: agentIdentifierSchema,
    category: agentProtocolFailureCategorySchema,
    createdAt: z.number().int().safe().nonnegative()
  })
  .strict()

export type AgentProtocolFailureCategory = z.infer<
  typeof agentProtocolFailureCategorySchema
>

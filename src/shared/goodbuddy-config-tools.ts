import { z } from 'zod'
import {
  goodbuddyConfigApplyInputSchema,
  goodbuddyConfigApplyOutputSchema,
  goodbuddyConfigCapabilitiesInputSchema,
  goodbuddyConfigCapabilitiesOutputSchema,
  goodbuddyConfigGetInputSchema,
  goodbuddyConfigGetOutputSchema,
  goodbuddyConfigPlanInputSchema,
  goodbuddyConfigPlanOutputSchema
} from './goodbuddy-config-contracts'

export type GoodBuddyConfigToolDefinition = {
  name: string
  title: string
  description: string
  summary: string
  access: 'read' | 'write'
  inputSchema: z.ZodType
  outputSchema: z.ZodType
}

export const goodbuddyConfigToolCatalog = {
  capabilities: {
    name: 'goodbuddy_config_capabilities',
    title: 'Discover GoodBuddy configuration capabilities',
    description:
      'List supported secret-free configuration operations, examples, risk levels, and reload effects. This tool does not read or change settings.',
    summary: 'Discover supported configuration operations and examples.',
    access: 'read',
    inputSchema: goodbuddyConfigCapabilitiesInputSchema,
    outputSchema: goodbuddyConfigCapabilitiesOutputSchema
  },
  get: {
    name: 'goodbuddy_config_get',
    title: 'Read sanitized GoodBuddy settings',
    description:
      'Read public application preferences, Skill summaries, and redacted MCP summaries for this request. Credentials and connection details are never returned.',
    summary: 'Read sanitized application, Skill, and MCP settings.',
    access: 'read',
    inputSchema: goodbuddyConfigGetInputSchema,
    outputSchema: goodbuddyConfigGetOutputSchema
  },
  plan: {
    name: 'goodbuddy_config_plan',
    title: 'Plan GoodBuddy configuration changes',
    description:
      'Validate and normalize a bounded sequence of strongly typed changes without applying it. The returned plan is scoped to this request and expires.',
    summary: 'Validate configuration changes and inspect their effects.',
    access: 'read',
    inputSchema: goodbuddyConfigPlanInputSchema,
    outputSchema: goodbuddyConfigPlanOutputSchema
  },
  apply: {
    name: 'goodbuddy_config_apply',
    title: 'Apply an approved GoodBuddy configuration plan',
    description:
      'Apply a previously planned request-scoped change after GoodBuddy approval controls authorize it. Raw operations and secrets are not accepted. If a later operation fails, the result reports partial application and the remaining operations are not attempted.',
    summary: 'Apply one approved request-scoped configuration plan.',
    access: 'write',
    inputSchema: goodbuddyConfigApplyInputSchema,
    outputSchema: goodbuddyConfigApplyOutputSchema
  }
} as const satisfies Record<
  'capabilities' | 'get' | 'plan' | 'apply',
  GoodBuddyConfigToolDefinition
>

export const goodbuddyConfigToolKeys = [
  'capabilities',
  'get',
  'plan',
  'apply'
] as const

export const goodbuddyConfigTools = [
  goodbuddyConfigToolCatalog.capabilities,
  goodbuddyConfigToolCatalog.get,
  goodbuddyConfigToolCatalog.plan,
  goodbuddyConfigToolCatalog.apply
] as const satisfies readonly GoodBuddyConfigToolDefinition[]

export type GoodBuddyConfigToolName =
  (typeof goodbuddyConfigTools)[number]['name']

export const goodbuddyConfigToolByName = new Map<
  GoodBuddyConfigToolName,
  (typeof goodbuddyConfigTools)[number]
>(
  goodbuddyConfigTools.map((tool) => [tool.name, tool])
)

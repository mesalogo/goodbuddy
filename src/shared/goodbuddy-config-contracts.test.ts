import { describe, expect, it } from 'vitest'
import {
  goodbuddyConfigApplyInputSchema,
  goodbuddyConfigCapabilities,
  goodbuddyConfigCapabilitiesOutputSchema,
  goodbuddyConfigCommonExamples,
  goodbuddyConfigGetOutputSchema,
  goodbuddyConfigOperationNameSchema,
  goodbuddyConfigOperationSchema,
  goodbuddyConfigPlanInputSchema,
  goodbuddyConfigPlanOutputSchema
} from './goodbuddy-config-contracts'
import {
  goodbuddyConfigToolByName,
  goodbuddyConfigTools
} from './goodbuddy-config-tools'

describe('GoodBuddy configuration contracts', () => {
  it('publishes one valid generated example for every operation', () => {
    const operationNames = goodbuddyConfigOperationNameSchema.options

    expect(goodbuddyConfigCommonExamples).toHaveLength(
      operationNames.length
    )
    expect(
      goodbuddyConfigCommonExamples.map(({ operation }) => operation)
    ).toEqual(operationNames)
    for (const example of goodbuddyConfigCommonExamples) {
      expect(goodbuddyConfigOperationSchema.parse(example)).toEqual(
        example
      )
    }
    expect(
      goodbuddyConfigCapabilitiesOutputSchema.parse(
        goodbuddyConfigCapabilities
      )
    ).toEqual(goodbuddyConfigCapabilities)
  })

  it('accepts a bounded sequence of strongly typed operations', () => {
    const input = {
      operations: [
        {
          operation: 'application.update',
          updates: {
            magicNotesEnabled: true,
            magicNoteCommentMode: 'after-save-manual'
          }
        },
        {
          operation: 'skill.setAssignments',
          skillId: 'document-writing',
          assignments: ['model', 'continue']
        },
        {
          operation: 'mcp.add',
          connection: {
            name: 'Project MCP',
            description: '',
            allowDynamicTools: false,
            transport: 'http',
            url: 'https://mcp.example.com/tools'
          },
          enabled: false,
          assignments: ['model']
        }
      ]
    }

    expect(goodbuddyConfigPlanInputSchema.parse(input)).toEqual(input)
  })

  it('keeps custom MCP assignments limited to the direct model', () => {
    expect(() =>
      goodbuddyConfigOperationSchema.parse({
        operation: 'mcp.add',
        connection: {
          name: 'Project MCP',
          description: '',
          allowDynamicTools: false,
          transport: 'http',
          url: 'https://mcp.example.com/tools'
        },
        enabled: true,
        assignments: ['continue']
      })
    ).toThrow()
  })

  it('never accepts MCP secrets or credential-bearing remote URLs', () => {
    const baseConnection = {
      name: 'Project MCP',
      description: '',
      allowDynamicTools: false,
      transport: 'http',
      url: 'https://mcp.example.com/tools'
    }

    expect(() =>
      goodbuddyConfigOperationSchema.parse({
        operation: 'mcp.add',
        connection: {
          ...baseConnection,
          secret: { action: 'replace', value: 'do-not-accept' }
        },
        enabled: true,
        assignments: ['model']
      })
    ).toThrow()
    expect(() =>
      goodbuddyConfigOperationSchema.parse({
        operation: 'mcp.update',
        serverId: '00000000-0000-4000-8000-000000000001',
        connection: {
          ...baseConnection,
          url: 'https://user:password@mcp.example.com/tools'
        }
      })
    ).toThrow()
    expect(() =>
      goodbuddyConfigOperationSchema.parse({
        operation: 'mcp.update',
        serverId: '00000000-0000-4000-8000-000000000001',
        connection: {
          ...baseConnection,
          url: 'https://mcp.example.com/tools?token=secret'
        }
      })
    ).toThrow()
  })

  it('only exposes redacted MCP summaries from get', () => {
    const snapshot = {
      application: {
        checkUpdatesOnStartup: true,
        updateSource: 'github',
        modelDownloadSource: 'modelscope',
        remoteProjectsEnabled: false,
        magicNotesEnabled: true,
        magicNotesShowIncompleteTodoCount: true,
        magicNoteCommentMode: 'immediate',
        magicNoteCommentFormat: 'combined'
      },
      skills: [],
      mcpServers: [
        {
          id: '00000000-0000-4000-8000-000000000001',
          name: 'Project MCP',
          description: '',
          enabled: true,
          allowDynamicTools: false,
          assignments: ['model'],
          secretConfigured: true,
          transport: 'http'
        }
      ]
    }

    expect(goodbuddyConfigGetOutputSchema.parse(snapshot)).toEqual(
      snapshot
    )
    expect(() =>
      goodbuddyConfigGetOutputSchema.parse({
        ...snapshot,
        mcpServers: [
          {
            ...snapshot.mcpServers[0],
            url: 'https://mcp.example.com?token=secret',
            secret: 'secret'
          }
        ]
      })
    ).toThrow()
  })

  it('requires an expiring, approved plan and applies only its ID', () => {
    const operation = goodbuddyConfigCommonExamples[0]!
    expect(
      goodbuddyConfigPlanOutputSchema.parse({
        planId: '00000000-0000-4000-8000-000000000002',
        expiresAt: '2030-01-01T00:00:00.000Z',
        operations: [operation],
        steps: [
          {
            index: 0,
            operation: operation.operation,
            summary: 'Update startup checks.',
            risk: 'low',
            reload: 'none',
            destructive: false
          }
        ],
        overallRisk: 'low',
        reload: 'none',
        requiresApproval: true
      }).requiresApproval
    ).toBe(true)
    expect(
      goodbuddyConfigApplyInputSchema.parse({
        planId: '00000000-0000-4000-8000-000000000002'
      })
    ).toEqual({
      planId: '00000000-0000-4000-8000-000000000002'
    })
    expect(() =>
      goodbuddyConfigApplyInputSchema.parse({
        planId: '00000000-0000-4000-8000-000000000002',
        operations: [operation]
      })
    ).toThrow()
  })

  it('catalogs the four request-scoped MCP tools', () => {
    expect(goodbuddyConfigTools.map(({ name }) => name)).toEqual([
      'goodbuddy_config_capabilities',
      'goodbuddy_config_get',
      'goodbuddy_config_plan',
      'goodbuddy_config_apply'
    ])
    expect(
      goodbuddyConfigToolByName.get('goodbuddy_config_apply')?.access
    ).toBe(
      'write'
    )
    expect(
      goodbuddyConfigTools
        .filter(({ name }) => name !== 'goodbuddy_config_apply')
        .every(({ access }) => access === 'read')
    ).toBe(true)
  })
})

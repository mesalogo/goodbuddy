import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import type { ResolvedMcpServer } from '../capabilities/capability-service'
import { ModelToolProvider } from './model-tool-provider'

const temporaryDirectories: string[] = []
const crmToken = process.env.GOODBUDDY_TEST_CRM_MCP_TOKEN?.trim()
const externalTest = crmToken ? it : it.skip

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) =>
        rm(directory, { recursive: true, force: true })
      )
  )
})

externalTest(
  'refreshes tools from a real dynamic MCP server',
  async () => {
    const workspace = await mkdtemp(
      join(tmpdir(), 'goodbuddy-dynamic-mcp-')
    )
    temporaryDirectories.push(workspace)
    const server: ResolvedMcpServer = {
      id: '00000000-0000-4000-8000-000000000401',
      name: 'CRM',
      description: '',
      enabled: true,
      allowDynamicTools: true,
      assignments: ['model'],
      secretConfigured: true,
      secret: crmToken,
      transport: 'http',
      url: 'https://crm.digiman.live/mcp'
    }
    const provider = new ModelToolProvider(workspace, [server])
    const signal = new AbortController().signal
    const context = {
      conversationId: 'dynamic-mcp-integration',
      workMode: 'execute'
    } as const

    try {
      const initialTools = await provider.listTools(context, signal)
      const loadTool = initialTools.find(
        (tool) =>
          tool.displayName === 'CRM / crmtools_load_tools'
      )
      expect(loadTool).toBeDefined()

      await provider.callTool(
        loadTool?.name ?? '',
        { groups: ['opportunity'] },
        signal,
        context
      )

      const refreshedTools = await provider.listTools(context, signal)
      expect(refreshedTools).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            displayName: 'CRM / crmtools_list_opportunities'
          })
        ])
      )
    } finally {
      await provider.dispose()
    }
  },
  20_000
)

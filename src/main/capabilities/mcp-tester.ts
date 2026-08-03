import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import type { McpServerTestResult } from '../../shared/capability-contracts'
import type { ResolvedMcpServer } from './capability-service'
import { createMcpTransport } from './mcp-client-transport'

const MCP_TEST_TIMEOUT_MS = 12_000

export async function testMcpServer(
  server: ResolvedMcpServer
): Promise<McpServerTestResult> {
  const client = new Client({
    name: 'goodbuddy',
    version: '0.1.0'
  })
  const transport = createMcpTransport(server)
  const controller = new AbortController()
  const timeout = setTimeout(() => {
    controller.abort(new Error('MCP 连接测试超时'))
  }, MCP_TEST_TIMEOUT_MS)

  try {
    await client.connect(transport, {
      timeout: MCP_TEST_TIMEOUT_MS,
      signal: controller.signal
    })
    const result = await client.listTools(undefined, {
      timeout: MCP_TEST_TIMEOUT_MS,
      signal: controller.signal
    })
    const version = client.getServerVersion()
    return {
      serverName: version?.name.slice(0, 120),
      serverVersion: version?.version.slice(0, 64),
      toolCount: result.tools.length,
      tools: result.tools.slice(0, 100).map((tool) => ({
        name: tool.name.slice(0, 128),
        description: tool.description?.slice(0, 500)
      }))
    }
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error('MCP 连接测试超时', { cause: error })
    }
    throw new Error(
      error instanceof Error &&
      /unauthorized|401|403/iu.test(error.message)
        ? 'MCP Server 拒绝了访问，请检查 Bearer Token'
        : 'MCP Server 连接失败，请检查地址、命令和服务状态',
      { cause: error }
    )
  } finally {
    clearTimeout(timeout)
    await client.close().catch(() => undefined)
  }
}

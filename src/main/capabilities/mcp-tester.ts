import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import type { McpServerTestResult } from '../../shared/capability-contracts'
import type { ResolvedMcpServer } from './capability-service'
import { createMcpTransport } from './mcp-client-transport'

const MCP_TEST_TOTAL_TIMEOUT_MS = 12_000
const MCP_TEST_INACTIVITY_TIMEOUT_MS = 8_000

export async function testMcpServer(
  server: ResolvedMcpServer,
  signal?: AbortSignal
): Promise<McpServerTestResult> {
  const client = new Client({
    name: 'goodbuddy',
    version: '0.1.0'
  })
  const transport = createMcpTransport(server)
  const controller = new AbortController()
  let timedOut = false
  const abortFromCaller = (): void => {
    controller.abort()
  }
  signal?.addEventListener('abort', abortFromCaller, { once: true })
  if (signal?.aborted) {
    abortFromCaller()
  }
  const timeout = setTimeout(() => {
    timedOut = true
    controller.abort(new Error('MCP 连接测试超时'))
  }, MCP_TEST_TOTAL_TIMEOUT_MS)
  const runWithInactivityLimit = async <T>(
    operation: () => Promise<T>
  ): Promise<T> => {
    const inactivityTimeout = setTimeout(() => {
      timedOut = true
      controller.abort(new Error('MCP 连接测试超时'))
    }, MCP_TEST_INACTIVITY_TIMEOUT_MS)
    try {
      return await operation()
    } finally {
      clearTimeout(inactivityTimeout)
    }
  }

  try {
    await runWithInactivityLimit(() =>
      client.connect(transport, {
        timeout: MCP_TEST_INACTIVITY_TIMEOUT_MS,
        signal: controller.signal
      })
    )
    const result = await runWithInactivityLimit(() =>
      client.listTools(undefined, {
        timeout: MCP_TEST_INACTIVITY_TIMEOUT_MS,
        signal: controller.signal
      })
    )
    const version = client.getServerVersion()
    const capabilities = client.getServerCapabilities()
    return {
      serverName: version?.name.slice(0, 120),
      serverVersion: version?.version.slice(0, 64),
      dynamicToolsSupported:
        capabilities?.tools?.listChanged === true,
      toolCount: result.tools.length,
      tools: result.tools.slice(0, 100).map((tool) => ({
        name: tool.name.slice(0, 128),
        description: tool.description?.slice(0, 500)
      }))
    }
  } catch (error) {
    if (signal?.aborted && !timedOut) {
      throw new Error('MCP 连接测试已取消', { cause: error })
    }
    if (timedOut) {
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
    signal?.removeEventListener('abort', abortFromCaller)
    await client.close().catch(() => undefined)
  }
}

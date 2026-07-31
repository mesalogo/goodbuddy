import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type {
  FetchLike,
  Transport
} from '@modelcontextprotocol/sdk/shared/transport.js'
import type { McpServerTestResult } from '../../shared/capability-contracts'
import type { ResolvedMcpServer } from './capability-service'

const MCP_TEST_TIMEOUT_MS = 12_000

function validateRemoteUrl(value: string): URL {
  const url = new URL(value)
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/gu, '')
  if (
    hostname === '169.254.169.254' ||
    hostname === 'metadata.google.internal' ||
    hostname.endsWith('.internal.metadata')
  ) {
    throw new Error('MCP 地址不能指向云平台元数据服务')
  }
  return url
}

function createRestrictedFetch(origin: string): FetchLike {
  return async (input, init) => {
    const url = new URL(String(input))
    if (url.origin !== origin) {
      throw new Error('MCP Server 尝试访问未授权的跨域地址')
    }
    return fetch(url, {
      ...init,
      redirect: 'error'
    })
  }
}

function createTransport(server: ResolvedMcpServer): Transport {
  if (server.transport === 'stdio') {
    return new StdioClientTransport({
      command: server.command,
      args: server.args,
      stderr: 'ignore',
      maxBufferSize: 2 * 1024 * 1024
    })
  }

  const url = validateRemoteUrl(server.url)
  const requestInit: RequestInit | undefined = server.secret
    ? {
        headers: {
          Authorization: `Bearer ${server.secret}`
        }
      }
    : undefined
  const safeFetch = createRestrictedFetch(url.origin)

  return server.transport === 'http'
    ? new StreamableHTTPClientTransport(url, {
        fetch: safeFetch,
        requestInit,
        reconnectionOptions: {
          initialReconnectionDelay: 500,
          maxReconnectionDelay: 2_000,
          reconnectionDelayGrowFactor: 1.5,
          maxRetries: 0
        }
      })
    : new SSEClientTransport(url, {
        fetch: safeFetch,
        requestInit
      })
}

export async function testMcpServer(
  server: ResolvedMcpServer
): Promise<McpServerTestResult> {
  const client = new Client({
    name: 'goodbuddy',
    version: '0.1.0'
  })
  const transport = createTransport(server)
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

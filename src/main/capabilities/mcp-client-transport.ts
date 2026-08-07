import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import type { ResolvedMcpServer } from './capability-service'
import {
  isCuratedMcpLaunchDescriptor,
  type CuratedMcpLaunchDescriptor
} from './curated-mcp-launch'

export function createMcpTransport(
  server: ResolvedMcpServer | CuratedMcpLaunchDescriptor
): Transport {
  if (isCuratedMcpLaunchDescriptor(server)) {
    return new StdioClientTransport({
      command: server.command,
      args: [...server.args],
      cwd: server.cwd,
      env: { ...server.env },
      stderr: 'ignore',
      maxBufferSize: 2 * 1024 * 1024
    })
  }

  if ((server as { transport?: string }).transport === 'curated-stdio') {
    throw new Error('无效的精选 MCP 启动描述')
  }

  if (server.transport === 'stdio') {
    return new StdioClientTransport({
      command: server.command,
      args: server.args,
      stderr: 'ignore',
      maxBufferSize: 2 * 1024 * 1024
    })
  }

  const url = new URL(server.url)
  const requestInit: RequestInit | undefined = server.secret
    ? {
        headers: {
          Authorization: `Bearer ${server.secret}`
        }
      }
    : undefined
  return server.transport === 'http'
    ? new StreamableHTTPClientTransport(url, {
        requestInit,
        reconnectionOptions: {
          initialReconnectionDelay: 500,
          maxReconnectionDelay: 2_000,
          reconnectionDelayGrowFactor: 1.5,
          maxRetries: 0
        }
      })
    : new SSEClientTransport(url, {
        requestInit
      })
}

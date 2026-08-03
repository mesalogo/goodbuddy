import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type {
  FetchLike,
  Transport
} from '@modelcontextprotocol/sdk/shared/transport.js'
import type { ResolvedMcpServer } from './capability-service'

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

export function createMcpTransport(
  server: ResolvedMcpServer
): Transport {
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

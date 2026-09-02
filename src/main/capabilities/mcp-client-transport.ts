import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import type { ResolvedMcpServer } from './capability-service'
import {
  isCuratedMcpLaunchDescriptor,
  type CuratedMcpLaunchDescriptor
} from './curated-mcp-launch'
import {
  applyLaunchEnvironmentPath,
  buildCredentialFilteredUserEnvironment
} from '../agent/process-environment'
import type { LaunchEnvironmentProvider } from '../local-tool-environment/launch-environment-provider'

export function createMcpTransport(
  server: ResolvedMcpServer | CuratedMcpLaunchDescriptor,
  launchEnvironmentProvider?: LaunchEnvironmentProvider
): Transport {
  if (isCuratedMcpLaunchDescriptor(server)) {
    const environment = Object.fromEntries(
      Object.entries(
        applyLaunchEnvironmentPath(
          { ...server.env },
          launchEnvironmentProvider
        )
      ).filter(
        (entry): entry is [string, string] =>
          entry[1] !== undefined
      )
    )
    return new StdioClientTransport({
      command: server.command,
      args: [...server.args],
      cwd: server.cwd,
      env: environment,
      stderr: 'ignore',
      maxBufferSize: 2 * 1024 * 1024
    })
  }

  if ((server as { transport?: string }).transport === 'curated-stdio') {
    throw new Error('无效的精选 MCP 启动描述')
  }

  if (server.transport === 'stdio') {
    const env = launchEnvironmentProvider
      ? Object.fromEntries(
          Object.entries(
            applyLaunchEnvironmentPath(
              buildCredentialFilteredUserEnvironment(),
              launchEnvironmentProvider
            )
          ).filter(
            (entry): entry is [string, string] =>
              entry[1] !== undefined
          )
        )
      : undefined
    return new StdioClientTransport({
      command: server.command,
      args: server.args,
      ...(env ? { env } : {}),
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

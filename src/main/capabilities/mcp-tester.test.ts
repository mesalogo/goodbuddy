import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ResolvedMcpServer } from './capability-service'

const mocks = vi.hoisted(() => {
  const client = {
    connect: vi.fn(),
    listTools: vi.fn(),
    getServerVersion: vi.fn(),
    getServerCapabilities: vi.fn(),
    close: vi.fn()
  }
  return {
    client,
    Client: vi.fn(function Client() {
      return client
    }),
    StdioClientTransport: vi.fn(function StdioClientTransport(
      options: unknown
    ) {
      return { kind: 'stdio', options }
    }),
    StreamableHTTPClientTransport: vi.fn(
      function StreamableHTTPClientTransport(
        url: URL,
        options: unknown
      ) {
        return { kind: 'http', url, options }
      }
    ),
    SSEClientTransport: vi.fn(function SSEClientTransport(
      url: URL,
      options: unknown
    ) {
      return { kind: 'sse', url, options }
    })
  }
})

vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: mocks.Client
}))
vi.mock('@modelcontextprotocol/sdk/client/stdio.js', () => ({
  StdioClientTransport: mocks.StdioClientTransport
}))
vi.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({
  StreamableHTTPClientTransport: mocks.StreamableHTTPClientTransport
}))
vi.mock('@modelcontextprotocol/sdk/client/sse.js', () => ({
  SSEClientTransport: mocks.SSEClientTransport
}))

import { testMcpServer } from './mcp-tester'

const common = {
  id: 'd2ef774b-146c-4467-a909-6feb112a9c2c',
  name: 'Test MCP',
  description: '',
  enabled: true,
  allowDynamicTools: false,
  assignments: ['model'] as Array<'model' | 'opencode' | 'continue'>,
  secretConfigured: false
}

describe('testMcpServer', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.client.connect.mockResolvedValue(undefined)
    mocks.client.listTools.mockResolvedValue({
      tools: [
        {
          name: 'search',
          description: 'Search documents'
        }
      ]
    })
    mocks.client.getServerVersion.mockReturnValue({
      name: 'test-server',
      version: '1.0.0'
    })
    mocks.client.getServerCapabilities.mockReturnValue({
      tools: { listChanged: false }
    })
    mocks.client.close.mockResolvedValue(undefined)
  })

  it('uses separated stdio command arguments and closes the client', async () => {
    const result = await testMcpServer({
      ...common,
      transport: 'stdio',
      command: 'node',
      args: ['server.js', '--safe']
    } satisfies ResolvedMcpServer)

    expect(mocks.StdioClientTransport).toHaveBeenCalledWith({
      command: 'node',
      args: ['server.js', '--safe'],
      stderr: 'ignore',
      maxBufferSize: 2 * 1024 * 1024
    })
    expect(mocks.client.connect).toHaveBeenCalledOnce()
    expect(mocks.client.listTools).toHaveBeenCalledOnce()
    expect(mocks.client.close).toHaveBeenCalledOnce()
    expect(result).toEqual({
      serverName: 'test-server',
      serverVersion: '1.0.0',
      dynamicToolsSupported: false,
      toolCount: 1,
      tools: [{ name: 'search', description: 'Search documents' }]
    })
  })

  it('reports support for dynamic tool-list notifications', async () => {
    mocks.client.getServerCapabilities.mockReturnValue({
      tools: { listChanged: true }
    })

    await expect(
      testMcpServer({
        ...common,
        transport: 'stdio',
        command: 'node',
        args: ['server.js']
      } satisfies ResolvedMcpServer)
    ).resolves.toMatchObject({
      dynamicToolsSupported: true
    })
  })

  it('injects a bearer token only into the remote transport', async () => {
    await testMcpServer({
      ...common,
      transport: 'http',
      url: 'https://mcp.example.com/mcp',
      secretConfigured: true,
      secret: 'test-secret'
    } satisfies ResolvedMcpServer)

    expect(mocks.StreamableHTTPClientTransport).toHaveBeenCalledOnce()
    const [url, options] =
      mocks.StreamableHTTPClientTransport.mock.calls[0] ?? []
    expect(url).toEqual(new URL('https://mcp.example.com/mcp'))
    expect(options).toMatchObject({
      requestInit: {
        headers: { Authorization: 'Bearer test-secret' }
      },
      reconnectionOptions: { maxRetries: 0 }
    })
    expect(options).not.toHaveProperty('fetch')
  })

  it('closes the client and returns a controlled error on failure', async () => {
    mocks.client.connect.mockRejectedValue(
      new Error('server included sensitive diagnostics')
    )

    await expect(
      testMcpServer({
        ...common,
        transport: 'sse',
        url: 'https://mcp.example.com/sse'
      } satisfies ResolvedMcpServer)
    ).rejects.toThrow(
      'MCP Server 连接失败，请检查地址、命令和服务状态'
    )
    expect(mocks.client.close).toHaveBeenCalledOnce()
  })

  it('accepts cancellation, closes the client, and hides abort details', async () => {
    mocks.client.connect.mockImplementation(
      async (
        _transport: unknown,
        options: { signal: AbortSignal }
      ) =>
        new Promise((_resolve, reject) => {
          options.signal.addEventListener(
            'abort',
            () => reject(new Error('sensitive abort reason')),
            { once: true }
          )
        })
    )
    const controller = new AbortController()
    const pending = testMcpServer(
      {
        ...common,
        transport: 'stdio',
        command: 'node',
        args: ['server.js']
      } satisfies ResolvedMcpServer,
      controller.signal
    )

    controller.abort(new Error('caller private context'))

    await expect(pending).rejects.toThrow('MCP 连接测试已取消')
    expect(mocks.client.listTools).not.toHaveBeenCalled()
    expect(mocks.client.close).toHaveBeenCalledOnce()
  })
})

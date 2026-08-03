import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  writeFile
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ResolvedMcpServer } from '../capabilities/capability-service'

const mocks = vi.hoisted(() => {
  const client = {
    connect: vi.fn(),
    listTools: vi.fn(),
    callTool: vi.fn(),
    close: vi.fn()
  }
  return {
    client,
    Client: vi.fn(function Client() {
      return client
    }),
    createMcpTransport: vi.fn(() => ({ kind: 'test-transport' }))
  }
})

vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: mocks.Client
}))
vi.mock('../capabilities/mcp-client-transport', () => ({
  createMcpTransport: mocks.createMcpTransport
}))

import { ModelToolProvider } from './model-tool-provider'

const temporaryDirectories: string[] = []

async function createWorkspace(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'goodbuddy-tools-'))
  temporaryDirectories.push(directory)
  return directory
}

describe('ModelToolProvider', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.client.connect.mockResolvedValue(undefined)
    mocks.client.listTools.mockResolvedValue({ tools: [] })
    mocks.client.callTool.mockResolvedValue({
      content: [{ type: 'text', text: 'MCP result' }]
    })
    mocks.client.close.mockResolvedValue(undefined)
  })

  afterEach(async () => {
    await Promise.all(
      temporaryDirectories
        .splice(0)
        .map((directory) =>
          rm(directory, { recursive: true, force: true })
        )
    )
  })

  it('provides bounded workspace read, list, and atomic write tools', async () => {
    const workspace = await createWorkspace()
    await mkdir(join(workspace, 'docs'))
    await writeFile(join(workspace, 'docs', 'note.txt'), 'hello', 'utf8')
    const provider = new ModelToolProvider(workspace)
    const signal = new AbortController().signal

    await expect(provider.listTools(signal)).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'workspace_read_text' }),
        expect.objectContaining({ name: 'workspace_list_directory' }),
        expect.objectContaining({ name: 'workspace_write_text' })
      ])
    )
    await expect(
      provider.callTool(
        'workspace_read_text',
        { path: 'docs/note.txt' },
        signal
      )
    ).resolves.toBe('hello')
    await expect(
      provider.callTool(
        'workspace_list_directory',
        { path: 'docs' },
        signal
      )
    ).resolves.toContain('"note.txt"')
    await expect(
      provider.callTool(
        'workspace_write_text',
        { path: 'docs/output.txt', content: 'saved' },
        signal
      )
    ).resolves.toContain('"bytesWritten":5')
    await expect(
      readFile(join(workspace, 'docs', 'output.txt'), 'utf8')
    ).resolves.toBe('saved')
  })

  it('rejects workspace traversal before accessing the filesystem', async () => {
    const workspace = await createWorkspace()
    const provider = new ModelToolProvider(workspace)

    await expect(
      provider.callTool(
        'workspace_read_text',
        { path: '../outside.txt' },
        new AbortController().signal
      )
    ).rejects.toThrow('不能超出工作区')
  })

  it('loads and invokes configured MCP tools through provider-safe names', async () => {
    const workspace = await createWorkspace()
    mocks.client.listTools.mockResolvedValue({
      tools: [
        {
          name: 'search-web',
          description: 'Search',
          inputSchema: {
            type: 'object',
            properties: { query: { type: 'string' } },
            required: ['query']
          }
        }
      ]
    })
    const server = {
      id: 'd2ef774b-146c-4467-a909-6feb112a9c2c',
      name: 'Search MCP',
      description: '',
      enabled: true,
      assignments: ['model'],
      secretConfigured: false,
      transport: 'stdio',
      command: 'node',
      args: ['server.js']
    } satisfies ResolvedMcpServer
    const provider = new ModelToolProvider(workspace, [server])
    const signal = new AbortController().signal

    const tools = await provider.listTools(signal)
    const mcpTool = tools.find((tool) => tool.source === 'mcp')
    expect(mcpTool).toMatchObject({
      displayName: 'Search MCP / search-web',
      source: 'mcp'
    })
    expect(mcpTool?.name).toMatch(/^mcp_[a-f0-9]{8}_[a-f0-9]{8}_/u)
    await expect(
      provider.callTool(
        mcpTool?.name ?? '',
        { query: 'GoodBuddy' },
        signal
      )
    ).resolves.toBe('MCP result')
    expect(mocks.client.callTool).toHaveBeenCalledWith(
      {
        name: 'search-web',
        arguments: { query: 'GoodBuddy' }
      },
      undefined,
      expect.objectContaining({
        timeout: 30_000,
        signal
      })
    )

    await provider.dispose()
    expect(mocks.client.close).toHaveBeenCalledOnce()
  })
})

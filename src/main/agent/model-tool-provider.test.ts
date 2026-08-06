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
import type { BrowserToolService } from '../browser/browser-model-tools'
import { BrowserStaleReferenceError } from '../browser/cdp-browser-driver'
import type { KnowledgeMcpGateway } from './knowledge-mcp-gateway'

const mocks = vi.hoisted(() => {
  const tasks = {
    callToolStream: vi.fn(),
    cancelTask: vi.fn()
  }
  const client = {
    connect: vi.fn(),
    listTools: vi.fn(),
    callTool: vi.fn(),
    experimental: { tasks },
    close: vi.fn()
  }
  return {
    client,
    tasks,
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

import {
  ModelToolProvider,
  type ModelToolCallContext
} from './model-tool-provider'

const temporaryDirectories: string[] = []
const png = Buffer.from([
  0x89, 0x50, 0x4e, 0x47,
  0x0d, 0x0a, 0x1a, 0x0a
]).toString('base64')
const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString('base64')
const toolContext = {
  conversationId: 'provider-test-conversation',
  workMode: 'execute'
} satisfies ModelToolCallContext

function createBrowserService(): BrowserToolService {
  return {
    getOrigin: vi.fn(() => 'https://example.com'),
    navigate: vi.fn(async (_conversationId, url) => ({
      url,
      origin: 'https://example.com'
    })),
    snapshot: vi.fn(async () => ({
      url: 'https://example.com/',
      title: 'Example',
      nodes: [],
      truncated: false
    })),
    click: vi.fn(async () => undefined),
    type: vi.fn(async () => undefined),
    select: vi.fn(async () => undefined),
    back: vi.fn(async () => ({
      url: 'https://previous.example/',
      origin: 'https://previous.example'
    })),
    screenshot: vi.fn(async () => ({
      type: 'image' as const,
      mimeType: 'image/jpeg' as const,
      data: jpeg
    })),
    releaseConversation: vi.fn(async () => undefined)
  }
}

function createMcpServer(): ResolvedMcpServer {
  return {
    id: 'd2ef774b-146c-4467-a909-6feb112a9c2c',
    name: 'Search MCP',
    description: '',
    enabled: true,
    assignments: ['model'],
    secretConfigured: false,
    transport: 'stdio',
    command: 'node',
    args: ['server.js']
  }
}

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
    mocks.tasks.callToolStream.mockImplementation(async function* () {
      yield {
        type: 'result',
        result: { content: [{ type: 'text', text: 'MCP task result' }] }
      }
    })
    mocks.tasks.cancelTask.mockResolvedValue({})
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

    await expect(provider.listTools(toolContext, signal)).resolves.toEqual(
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
        signal,
        toolContext
      )
    ).resolves.toEqual({
      parts: [{ type: 'text', text: 'hello' }],
      contextBytes: 5
    })
    const listing = await provider.callTool(
      'workspace_list_directory',
      { path: 'docs' },
      signal,
      toolContext
    )
    expect(listing.parts).toEqual([
      expect.objectContaining({
        type: 'text',
        text: expect.stringContaining('"note.txt"')
      })
    ])
    const written = await provider.callTool(
      'workspace_write_text',
      { path: 'docs/output.txt', content: 'saved' },
      signal,
      toolContext
    )
    expect(written.parts).toEqual([
      expect.objectContaining({
        type: 'text',
        text: expect.stringContaining('"bytesWritten":5')
      })
    ])
    await expect(
      readFile(join(workspace, 'docs', 'output.txt'), 'utf8')
    ).resolves.toBe('saved')
  })

  it('exposes only scoped knowledge search in Ask and never lets the model select library IDs', async () => {
    const workspace = await createWorkspace()
    const search = vi.fn(async () => [])
    const gateway = { search } as unknown as KnowledgeMcpGateway
    const provider = new ModelToolProvider(
      workspace,
      [],
      undefined,
      gateway
    )
    const signal = new AbortController().signal
    const askContext = {
      conversationId: 'knowledge-ask',
      workMode: 'ask',
      knowledgeCapabilityToken: 'main-only-token'
    } satisfies ModelToolCallContext

    const askTools = await provider.listTools(askContext, signal)
    expect(askTools.map((tool) => tool.name)).toEqual([
      'knowledge_search'
    ])
    expect(
      JSON.stringify(askTools[0]?.inputSchema)
    ).not.toContain('library')
    await provider.callTool(
      'knowledge_search',
      { query: 'scope query', limit: 4 },
      signal,
      askContext
    )
    expect(search).toHaveBeenCalledWith(
      'main-only-token',
      { query: 'scope query', limit: 4 },
      signal
    )

    await expect(
      provider.listTools(
        {
          conversationId: 'knowledge-empty',
          workMode: 'ask'
        },
        signal
      )
    ).resolves.toEqual([])
    const executeTools = await provider.listTools(
      { ...askContext, workMode: 'execute' },
      signal
    )
    expect(executeTools.map((tool) => tool.name)).toEqual(
      expect.arrayContaining([
        'workspace_read_text',
        'workspace_list_directory',
        'workspace_write_text',
        'knowledge_search'
      ])
    )
  })

  it('reserves the 100th Execute tool slot for scoped knowledge search', async () => {
    const workspace = await createWorkspace()
    const gateway = {
      search: vi.fn(async () => [])
    } as unknown as KnowledgeMcpGateway
    const context = {
      conversationId: 'knowledge-capacity',
      workMode: 'execute',
      knowledgeCapabilityToken: 'main-only-token'
    } satisfies ModelToolCallContext
    const createTools = (count: number) =>
      Array.from({ length: count }, (_, index) => ({
        name: `remote_tool_${index}`,
        description: 'Remote tool',
        inputSchema: {
          type: 'object',
          properties: {},
          additionalProperties: false
        }
      }))

    mocks.client.listTools.mockResolvedValueOnce({
      tools: createTools(96)
    })
    const validProvider = new ModelToolProvider(
      workspace,
      [createMcpServer()],
      undefined,
      gateway
    )
    await expect(
      validProvider.listTools(context, new AbortController().signal)
    ).resolves.toHaveLength(100)
    await validProvider.dispose()

    mocks.client.listTools.mockResolvedValueOnce({
      tools: createTools(97)
    })
    const overflowingProvider = new ModelToolProvider(
      workspace,
      [createMcpServer()],
      undefined,
      gateway
    )
    await expect(
      overflowingProvider.listTools(
        context,
        new AbortController().signal
      )
    ).rejects.toThrow('无法加载 MCP Server')
    await overflowingProvider.dispose()
  })

  it('rejects workspace traversal before accessing the filesystem', async () => {
    const workspace = await createWorkspace()
    const provider = new ModelToolProvider(workspace)

    await expect(
      provider.callTool(
        'workspace_read_text',
        { path: '../outside.txt' },
        new AbortController().signal,
        toolContext
      )
    ).rejects.toThrow('不能超出工作区')
  })

  it('delegates browser tools with per-call conversation context', async () => {
    const workspace = await createWorkspace()
    const browserService = createBrowserService()
    const provider = new ModelToolProvider(workspace, [], browserService)
    const firstContext = {
      conversationId: 'browser-conversation-one',
      workMode: 'execute'
    } satisfies ModelToolCallContext
    const secondContext = {
      conversationId: 'browser-conversation-two',
      workMode: 'execute'
    } satisfies ModelToolCallContext
    const signal = new AbortController().signal

    for (const workMode of ['ask', 'plan'] as const) {
      const readOnlyContext = {
        conversationId: `browser-${workMode}`,
        workMode
      } satisfies ModelToolCallContext
      await expect(
        provider.listTools(readOnlyContext, signal)
      ).resolves.not.toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: 'browser_screenshot' })
        ])
      )
      await expect(
        provider.callTool(
          'browser_screenshot',
          {},
          signal,
          readOnlyContext
        )
      ).rejects.toThrow('未知工具')
    }
    expect(browserService.screenshot).not.toHaveBeenCalled()

    const tools = await provider.listTools(firstContext, signal)
    expect(
      tools.filter((tool) => tool.name.startsWith('browser_'))
    ).toHaveLength(7)
    const navigate = tools.find((tool) => tool.name === 'browser_navigate')
    expect(
      provider.getApproval(
        navigate!,
        { url: 'https://example.com/path?secret=value' },
        'runtime summary',
        firstContext
      )
    ).toMatchObject({
      scopeKey: 'model:browser:navigate:https://example.com',
      argumentSummary: 'https://example.com/path?[查询参数已隐藏]',
      allowPermanent: false
    })

    await expect(
      provider.callTool('browser_screenshot', {}, signal, firstContext)
    ).resolves.toEqual({
      parts: [{ type: 'image', mimeType: 'image/jpeg', data: jpeg }],
      contextBytes: Buffer.byteLength(jpeg)
    })
    await provider.callTool('browser_screenshot', {}, signal, secondContext)
    expect(browserService.screenshot).toHaveBeenNthCalledWith(
      1,
      firstContext.conversationId,
      signal
    )
    expect(browserService.screenshot).toHaveBeenNthCalledWith(
      2,
      secondContext.conversationId,
      signal
    )

    await provider.releaseConversation(firstContext.conversationId)
    expect(browserService.releaseConversation).toHaveBeenCalledWith(
      firstContext.conversationId
    )
    expect(browserService.releaseConversation).not.toHaveBeenCalledWith(
      secondContext.conversationId
    )
  })

  it('marks stale browser references as recoverable model tool errors', async () => {
    const workspace = await createWorkspace()
    const browserService = createBrowserService()
    vi.mocked(browserService.click).mockRejectedValue(
      new BrowserStaleReferenceError()
    )
    const provider = new ModelToolProvider(workspace, [], browserService)

    await expect(
      provider.callTool(
        'browser_click',
        { ref: 'b_currentReference' },
        new AbortController().signal,
        toolContext
      )
    ).rejects.toMatchObject({
      name: 'RecoverableModelToolError',
      message: '浏览器元素引用已失效，请重新获取快照',
      nextAction: expect.stringContaining('browser_snapshot')
    })
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
    const provider = new ModelToolProvider(workspace, [createMcpServer()])
    const signal = new AbortController().signal

    const tools = await provider.listTools(toolContext, signal)
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
        signal,
        toolContext
      )
    ).resolves.toEqual({
      parts: [{ type: 'text', text: 'MCP result' }],
      contextBytes: 10
    })
    expect(mocks.client.callTool).toHaveBeenCalledWith(
      {
        name: 'search-web',
        arguments: { query: 'GoodBuddy' }
      },
      undefined,
      expect.objectContaining({
        timeout: 30_000,
        signal,
        resetTimeoutOnProgress: true,
        maxTotalTimeout: 300_000,
        onprogress: expect.any(Function)
      })
    )

    await provider.dispose()
    expect(mocks.client.close).toHaveBeenCalledOnce()
  })

  it('preserves ordered bounded MCP text, image, and unsupported audio parts', async () => {
    const workspace = await createWorkspace()
    mocks.client.listTools.mockResolvedValue({
      tools: [
        {
          name: 'capture',
          inputSchema: { type: 'object' }
        }
      ]
    })
    mocks.client.callTool.mockResolvedValue({
      content: [
        { type: 'text', text: 'before' },
        { type: 'image', mimeType: 'image/png', data: png },
        { type: 'audio', mimeType: 'audio/wav', data: 'ignored' },
        { type: 'text', text: 'after' }
      ]
    })
    const provider = new ModelToolProvider(workspace, [createMcpServer()])
    const tools = await provider.listTools(toolContext, new AbortController().signal)
    const tool = tools.find((candidate) => candidate.source === 'mcp')

    await expect(
      provider.callTool(
        tool?.name ?? '',
        {},
        new AbortController().signal,
        toolContext
      )
    ).resolves.toEqual({
      parts: [
        { type: 'text', text: 'before' },
        {
          type: 'image',
          mimeType: 'image/png',
          data: png
        },
        { type: 'text', text: '[audio result unsupported]' },
        { type: 'text', text: 'after' }
      ],
      contextBytes:
        Buffer.byteLength('before') +
        Buffer.byteLength(png) +
        Buffer.byteLength('[audio result unsupported]') +
        Buffer.byteLength('after')
    })
  })

  it.each([
    {
      mimeType: 'image/jpeg',
      data: Buffer.from([0xff, 0xd8, 0xff]).toString('base64')
    },
    {
      mimeType: 'image/webp',
      data: Buffer.from([
        0x52, 0x49, 0x46, 0x46,
        0x00, 0x00, 0x00, 0x00,
        0x57, 0x45, 0x42, 0x50
      ]).toString('base64')
    }
  ])('accepts a valid $mimeType signature', async ({ mimeType, data }) => {
    const workspace = await createWorkspace()
    mocks.client.listTools.mockResolvedValue({
      tools: [{ name: 'capture', inputSchema: { type: 'object' } }]
    })
    mocks.client.callTool.mockResolvedValue({
      content: [{ type: 'image', mimeType, data }]
    })
    const provider = new ModelToolProvider(workspace, [createMcpServer()])
    const tools = await provider.listTools(toolContext, new AbortController().signal)
    const tool = tools.find((candidate) => candidate.source === 'mcp')

    await expect(
      provider.callTool(
        tool?.name ?? '',
        {},
        new AbortController().signal,
        toolContext
      )
    ).resolves.toEqual({
      parts: [{ type: 'image', mimeType, data }],
      contextBytes: Buffer.byteLength(data)
    })
  })

  it.each([
    {
      name: 'malformed base64',
      image: {
        type: 'image',
        mimeType: 'image/png',
        data: `${png.slice(0, -1)}!`
      },
      message: '无效的 base64'
    },
    {
      name: 'MIME signature mismatch',
      image: {
        type: 'image',
        mimeType: 'image/jpeg',
        data: png
      },
      message: 'MIME 类型与文件签名不匹配'
    },
    {
      name: 'unsupported MIME type',
      image: {
        type: 'image',
        mimeType: 'image/gif',
        data: png
      },
      message: '不支持的图片格式'
    }
  ])('rejects $name in MCP image blocks', async ({ image, message }) => {
    const workspace = await createWorkspace()
    mocks.client.listTools.mockResolvedValue({
      tools: [{ name: 'capture', inputSchema: { type: 'object' } }]
    })
    mocks.client.callTool.mockResolvedValue({ content: [image] })
    const provider = new ModelToolProvider(workspace, [createMcpServer()])
    const tools = await provider.listTools(toolContext, new AbortController().signal)
    const tool = tools.find((candidate) => candidate.source === 'mcp')

    await expect(
      provider.callTool(
        tool?.name ?? '',
        {},
        new AbortController().signal,
        toolContext
      )
    ).rejects.toThrow(message)
  })

  it('counts encoded and decoded image data against the MCP result budget', async () => {
    const workspace = await createWorkspace()
    mocks.client.listTools.mockResolvedValue({
      tools: [{ name: 'capture', inputSchema: { type: 'object' } }]
    })
    const encodedContextOversizedPng = Buffer.concat([
      Buffer.from([
        0x89, 0x50, 0x4e, 0x47,
        0x0d, 0x0a, 0x1a, 0x0a
      ]),
      Buffer.alloc(200 * 1024)
    ]).toString('base64')
    mocks.client.callTool.mockResolvedValue({
      content: [
        {
          type: 'image',
          mimeType: 'image/png',
          data: encodedContextOversizedPng
        }
      ]
    })
    const provider = new ModelToolProvider(workspace, [createMcpServer()])
    const tools = await provider.listTools(toolContext, new AbortController().signal)
    const tool = tools.find((candidate) => candidate.source === 'mcp')

    await expect(
      provider.callTool(
        tool?.name ?? '',
        {},
        new AbortController().signal,
        toolContext
      )
    ).rejects.toThrow('工具结果超过 256KB')

    const decodedOversizedPng = Buffer.concat([
      Buffer.from([
        0x89, 0x50, 0x4e, 0x47,
        0x0d, 0x0a, 0x1a, 0x0a
      ]),
      Buffer.alloc(256 * 1024)
    ]).toString('base64')
    mocks.client.callTool.mockResolvedValue({
      content: [
        {
          type: 'image',
          mimeType: 'image/png',
          data: decodedOversizedPng
        }
      ]
    })
    await expect(
      provider.callTool(
        tool?.name ?? '',
        {},
        new AbortController().signal,
        toolContext
      )
    ).rejects.toThrow('过大的 base64 图片')
  })

  it('bounds MCP content block and image counts', async () => {
    const workspace = await createWorkspace()
    mocks.client.listTools.mockResolvedValue({
      tools: [{ name: 'capture', inputSchema: { type: 'object' } }]
    })
    const provider = new ModelToolProvider(workspace, [createMcpServer()])
    const tools = await provider.listTools(toolContext, new AbortController().signal)
    const tool = tools.find((candidate) => candidate.source === 'mcp')

    mocks.client.callTool.mockResolvedValue({
      content: Array.from({ length: 101 }, () => ({
        type: 'text',
        text: 'x'
      }))
    })
    await expect(
      provider.callTool(
        tool?.name ?? '',
        {},
        new AbortController().signal,
        toolContext
      )
    ).rejects.toThrow('内容块数量超过安全限制')

    mocks.client.callTool.mockResolvedValue({
      content: Array.from({ length: 9 }, () => ({
        type: 'image',
        mimeType: 'image/png',
        data: png
      }))
    })
    await expect(
      provider.callTool(
        tool?.name ?? '',
        {},
        new AbortController().signal,
        toolContext
      )
    ).rejects.toThrow('图片数量超过安全限制')
  })

  it('streams required task tools and best-effort cancels their MCP task', async () => {
    const workspace = await createWorkspace()
    mocks.client.listTools.mockResolvedValue({
      tools: [
        {
          name: 'long-job',
          inputSchema: { type: 'object' },
          execution: { taskSupport: 'required' }
        }
      ]
    })
    const controller = new AbortController()
    mocks.tasks.callToolStream.mockImplementation(async function* (
      _params,
      _schema,
      options
    ) {
      yield {
        type: 'taskCreated',
        task: { taskId: 'task-1', status: 'working' }
      }
      controller.abort()
      throw options.signal.reason
    })
    const provider = new ModelToolProvider(workspace, [createMcpServer()])
    const tools = await provider.listTools(toolContext, controller.signal)
    const tool = tools.find((candidate) => candidate.source === 'mcp')
    expect(tool?.taskSupport).toBe('required')

    await expect(
      provider.callTool(
        tool?.name ?? '',
        {},
        controller.signal,
        toolContext
      )
    ).rejects.toThrow()
    expect(mocks.tasks.callToolStream).toHaveBeenCalledWith(
      {
        name: 'long-job',
        arguments: {}
      },
      undefined,
      expect.objectContaining({
        timeout: 30_000,
        signal: controller.signal,
        resetTimeoutOnProgress: true,
        maxTotalTimeout: 300_000
      })
    )
    expect(mocks.tasks.cancelTask).toHaveBeenCalledWith(
      'task-1',
      {
        timeout: 5_000,
        maxTotalTimeout: 5_000
      }
    )
  })
})

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { createHash, randomUUID } from 'node:crypto'
import {
  lstat,
  open,
  rename,
  realpath,
  rm,
  stat
} from 'node:fs/promises'
import {
  dirname,
  isAbsolute,
  resolve
} from 'node:path'
import { z } from 'zod'
import type { ResolvedMcpServer } from '../capabilities/capability-service'
import { createMcpTransport } from '../capabilities/mcp-client-transport'
import {
  getCanonicalWorkspace,
  isPathInside,
  listBoundedDirectoryEntries,
  readBoundedUtf8File
} from '../workspace-file-access'
import type { RuntimeApprovalRequest } from './runtime'

const MAX_MODEL_TOOLS = 100
const MAX_MCP_SERVERS = 16
const MAX_TOOL_SCHEMA_BYTES = 32 * 1024
const MAX_TOOL_RESULT_BYTES = 256 * 1024
const MAX_READ_BYTES = 256 * 1024
const MAX_WRITE_BYTES = 512 * 1024
const MCP_TIMEOUT_MS = 30_000

const workspacePathSchema = z
  .string()
  .trim()
  .min(1)
  .max(4_096)
  .refine((value) => !isAbsolute(value), '路径必须相对于工作区')
  .refine((value) => !value.includes('\0'), '路径包含无效字符')

const readInputSchema = z
  .object({
    path: workspacePathSchema
  })
  .strict()

const listInputSchema = z
  .object({
    path: z.string().max(4_096).default('.')
  })
  .strict()

const writeInputSchema = z
  .object({
    path: workspacePathSchema,
    content: z.string().max(MAX_WRITE_BYTES)
  })
  .strict()

export type ModelToolDefinition = {
  name: string
  displayName: string
  description: string
  inputSchema: Record<string, unknown>
  source: 'builtin' | 'mcp'
  serverName?: string
}

export interface ModelToolProviderLike {
  listTools(signal: AbortSignal): Promise<ModelToolDefinition[]>
  getApproval(
    tool: ModelToolDefinition,
    argumentsValue: Record<string, unknown>,
    argumentSummary: string
  ): RuntimeApprovalRequest
  callTool(
    name: string,
    argumentsValue: Record<string, unknown>,
    signal: AbortSignal
  ): Promise<string>
  dispose(): Promise<void>
}

type McpToolBinding = {
  client: Client
  definition: ModelToolDefinition
  originalName: string
}

type ConnectedMcp = {
  client: Client
  tools: McpToolBinding[]
}

function boundedJson(value: unknown, errorMessage: string): string {
  let serialized: string
  try {
    serialized = JSON.stringify(value)
  } catch (error) {
    throw new Error(errorMessage, { cause: error })
  }
  if (serialized === undefined) {
    throw new Error(errorMessage)
  }
  if (Buffer.byteLength(serialized) > MAX_TOOL_RESULT_BYTES) {
    throw new Error('工具结果超过 256KB 安全限制')
  }
  return serialized
}

function normalizeToolSchema(value: unknown): Record<string, unknown> {
  let serialized: string
  try {
    serialized = JSON.stringify(value)
  } catch (error) {
    throw new Error('MCP 工具参数结构无效', { cause: error })
  }
  if (
    !serialized ||
    Buffer.byteLength(serialized) > MAX_TOOL_SCHEMA_BYTES
  ) {
    throw new Error('MCP 工具参数结构超过 32KB 安全限制')
  }
  const schema = JSON.parse(serialized) as unknown
  if (
    !schema ||
    typeof schema !== 'object' ||
    Array.isArray(schema) ||
    (schema as Record<string, unknown>).type !== 'object'
  ) {
    throw new Error('MCP 工具参数必须使用 object JSON Schema')
  }
  return schema as Record<string, unknown>
}

function createMcpToolName(serverId: string, originalName: string): string {
  const serverHash = createHash('sha256')
    .update(serverId)
    .digest('hex')
    .slice(0, 8)
  const toolHash = createHash('sha256')
    .update(originalName)
    .digest('hex')
    .slice(0, 8)
  const readable = originalName
    .replace(/[^a-zA-Z0-9_-]+/gu, '_')
    .replace(/^_+|_+$/gu, '')
    .slice(0, 36) || 'tool'
  return `mcp_${serverHash}_${toolHash}_${readable}`.slice(0, 64)
}

function getMcpResultText(result: unknown): string {
  if (!result || typeof result !== 'object') {
    return boundedJson(result, 'MCP 工具结果无法序列化')
  }
  const record = result as Record<string, unknown>
  if (record.isError === true) {
    throw new Error('MCP Server 报告工具执行失败')
  }
  if ('toolResult' in record) {
    return boundedJson(record.toolResult, 'MCP 工具结果无法序列化')
  }

  const sections: string[] = []
  if (
    record.structuredContent &&
    typeof record.structuredContent === 'object'
  ) {
    sections.push(
      boundedJson(
        record.structuredContent,
        'MCP 结构化工具结果无法序列化'
      )
    )
  }
  if (Array.isArray(record.content)) {
    for (const item of record.content.slice(0, 100)) {
      if (!item || typeof item !== 'object') {
        continue
      }
      const content = item as Record<string, unknown>
      if (content.type === 'text' && typeof content.text === 'string') {
        sections.push(content.text)
      } else if (
        content.type === 'resource' &&
        content.resource &&
        typeof content.resource === 'object' &&
        typeof (content.resource as Record<string, unknown>).text === 'string'
      ) {
        sections.push(
          (content.resource as Record<string, unknown>).text as string
        )
      } else if (content.type === 'resource_link') {
        sections.push(
          boundedJson(content, 'MCP 资源链接无法序列化')
        )
      } else if (content.type === 'image' || content.type === 'audio') {
        sections.push(`[${String(content.type)} result omitted]`)
      }
    }
  }
  const text = sections.join('\n\n').trim()
  if (!text) {
    return '{}'
  }
  if (Buffer.byteLength(text) > MAX_TOOL_RESULT_BYTES) {
    throw new Error('工具结果超过 256KB 安全限制')
  }
  return text
}

export class ModelToolProvider implements ModelToolProviderLike {
  private canonicalWorkspace?: Promise<string>
  private mcpBindings?: Promise<Map<string, McpToolBinding>>
  private readonly clients = new Set<Client>()

  constructor(
    private readonly workspace: string,
    private readonly mcpServers: ResolvedMcpServer[] = []
  ) {}

  private async getWorkspace(): Promise<string> {
    this.canonicalWorkspace ??= getCanonicalWorkspace(
      this.workspace,
      '直连模型工作区不是目录'
    )
    return this.canonicalWorkspace
  }

  private async resolveExistingPath(
    inputPath: string,
    expected: 'file' | 'directory'
  ): Promise<string> {
    const root = await this.getWorkspace()
    const relativePath = workspacePathSchema.parse(inputPath)
    const candidate = resolve(root, relativePath)
    if (!isPathInside(root, candidate)) {
      throw new Error('工具路径不能超出工作区')
    }
    const canonical = await realpath(candidate)
    if (!isPathInside(root, canonical)) {
      throw new Error('工具路径不能通过符号链接超出工作区')
    }
    const metadata = await stat(canonical)
    if (
      (expected === 'file' && !metadata.isFile()) ||
      (expected === 'directory' && !metadata.isDirectory())
    ) {
      throw new Error(
        expected === 'file' ? '工具路径不是普通文件' : '工具路径不是目录'
      )
    }
    return canonical
  }

  private async resolveWritablePath(inputPath: string): Promise<string> {
    const root = await this.getWorkspace()
    const relativePath = workspacePathSchema.parse(inputPath)
    const candidate = resolve(root, relativePath)
    if (!isPathInside(root, candidate) || candidate === root) {
      throw new Error('工具路径不能超出工作区')
    }
    const canonicalParent = await realpath(dirname(candidate))
    if (!isPathInside(root, canonicalParent)) {
      throw new Error('工具路径不能通过符号链接超出工作区')
    }
    const existing = await lstat(candidate).catch((error: unknown) => {
      if (
        error &&
        typeof error === 'object' &&
        'code' in error &&
        error.code === 'ENOENT'
      ) {
        return undefined
      }
      throw error
    })
    if (existing?.isSymbolicLink()) {
      throw new Error('工作区写入工具拒绝符号链接')
    }
    if (existing && !existing.isFile()) {
      throw new Error('工作区写入目标不是普通文件')
    }
    return candidate
  }

  private getBuiltinTools(): ModelToolDefinition[] {
    return [
      {
        name: 'workspace_read_text',
        displayName: '读取工作区文本',
        description:
          '读取当前工作区内一个不超过 256KB 的 UTF-8 文本文件。',
        inputSchema: {
          type: 'object',
          properties: {
            path: {
              type: 'string',
              description: '相对于当前工作区的文件路径'
            }
          },
          required: ['path'],
          additionalProperties: false
        },
        source: 'builtin'
      },
      {
        name: 'workspace_list_directory',
        displayName: '列出工作区目录',
        description:
          '列出当前工作区内目录的直属内容，最多返回 200 项。',
        inputSchema: {
          type: 'object',
          properties: {
            path: {
              type: 'string',
              description: '相对于当前工作区的目录路径，默认为 .'
            }
          },
          additionalProperties: false
        },
        source: 'builtin'
      },
      {
        name: 'workspace_write_text',
        displayName: '写入工作区文本',
        description:
          '在当前工作区内新建或覆盖一个不超过 512KB 的 UTF-8 文本文件；父目录必须已存在。',
        inputSchema: {
          type: 'object',
          properties: {
            path: {
              type: 'string',
              description: '相对于当前工作区的文件路径'
            },
            content: {
              type: 'string',
              description: '要写入的完整 UTF-8 文本'
            }
          },
          required: ['path', 'content'],
          additionalProperties: false
        },
        source: 'builtin'
      }
    ]
  }

  private async connectMcpServer(
    server: ResolvedMcpServer,
    signal: AbortSignal
  ): Promise<ConnectedMcp> {
    const client = new Client({
      name: 'goodbuddy-direct-model',
      version: '0.1.0'
    })
    this.clients.add(client)
    try {
      await client.connect(createMcpTransport(server), {
        timeout: MCP_TIMEOUT_MS,
        signal
      })
      const result = await client.listTools(undefined, {
        timeout: MCP_TIMEOUT_MS,
        signal
      })
      if (result.tools.length > MAX_MODEL_TOOLS - 3) {
        throw new Error(
          `MCP Server「${server.name}」提供的工具数量超过安全限制`
        )
      }
      const tools = result.tools.map((tool): McpToolBinding => ({
        client,
        originalName: tool.name,
        definition: {
          name: createMcpToolName(server.id, tool.name),
          displayName: `${server.name} / ${tool.name}`.slice(0, 200),
          description: [
            `MCP Server「${server.name}」提供的工具。`,
            tool.description
          ]
            .filter(Boolean)
            .join(' ')
            .slice(0, 1_000),
          inputSchema: normalizeToolSchema(tool.inputSchema),
          source: 'mcp',
          serverName: server.name
        }
      }))
      if (
        tools.some(
          (tool) =>
            !tool.originalName ||
            tool.originalName.length > 128 ||
            [...tool.originalName].some((character) => {
              const code = character.charCodeAt(0)
              return code <= 31 || code === 127
            })
        )
      ) {
        throw new Error(`MCP Server「${server.name}」返回了无效工具名称`)
      }
      return { client, tools }
    } catch (error) {
      this.clients.delete(client)
      await client.close().catch(() => undefined)
      throw new Error(`无法加载 MCP Server「${server.name}」的工具`, {
        cause: error
      })
    }
  }

  private async getMcpBindings(
    signal: AbortSignal
  ): Promise<Map<string, McpToolBinding>> {
    if (this.mcpServers.length > MAX_MCP_SERVERS) {
      throw new Error('直连模型最多可加载 16 个 MCP Server')
    }
    this.mcpBindings ??= Promise.all(
      this.mcpServers.map((server) => this.connectMcpServer(server, signal))
    )
      .then((connections) => {
        const bindings = new Map<string, McpToolBinding>()
        for (const connection of connections) {
          for (const binding of connection.tools) {
            if (bindings.size + 3 >= MAX_MODEL_TOOLS) {
              throw new Error('直连模型工具总数超过 100 个安全限制')
            }
            if (bindings.has(binding.definition.name)) {
              throw new Error('MCP 工具名称发生冲突')
            }
            bindings.set(binding.definition.name, binding)
          }
        }
        return bindings
      })
      .catch(async (error) => {
        this.mcpBindings = undefined
        const clients = [...this.clients]
        this.clients.clear()
        await Promise.allSettled(
          clients.map((client) => client.close())
        )
        throw error
      })
    return this.mcpBindings
  }

  async listTools(signal: AbortSignal): Promise<ModelToolDefinition[]> {
    signal.throwIfAborted()
    const bindings = await this.getMcpBindings(signal)
    return [
      ...this.getBuiltinTools(),
      ...[...bindings.values()].map((binding) => binding.definition)
    ]
  }

  getApproval(
    tool: ModelToolDefinition,
    argumentsValue: Record<string, unknown>,
    argumentSummary: string
  ): RuntimeApprovalRequest {
    const path =
      typeof argumentsValue.path === 'string'
        ? argumentsValue.path.slice(0, 500)
        : undefined
    return {
      scopeKey:
        tool.source === 'mcp'
          ? `model:mcp:${tool.name}`
          : `model:builtin:${tool.name}`,
      title:
        tool.source === 'mcp'
          ? `允许调用 MCP 工具「${tool.displayName}」？`
          : `允许${tool.displayName}？`,
      description:
        tool.source === 'mcp'
          ? `该工具由已启用的 MCP Server「${tool.serverName ?? '未知'}」执行，并使用当前用户权限。`
          : path
            ? `目标位于当前工作区：${path}`
            : '该工具仅允许访问当前工作区。',
      toolName: tool.displayName,
      argumentSummary,
      allowPermanent: false
    }
  }

  async callTool(
    name: string,
    argumentsValue: Record<string, unknown>,
    signal: AbortSignal
  ): Promise<string> {
    signal.throwIfAborted()
    if (name === 'workspace_read_text') {
      const input = readInputSchema.parse(argumentsValue)
      const filePath = await this.resolveExistingPath(input.path, 'file')
      return (
        await readBoundedUtf8File(
          filePath,
          MAX_READ_BYTES,
          '工作区文本文件超过 256KB 安全限制',
          '工作区读取目标不是有效 UTF-8 文本'
        )
      ).content
    }
    if (name === 'workspace_list_directory') {
      const input = listInputSchema.parse(argumentsValue)
      const directoryPath = await this.resolveExistingPath(
        input.path,
        'directory'
      )
      const listing = await listBoundedDirectoryEntries(
        directoryPath,
        200
      )
      return boundedJson(
        {
          entries: listing.entries
            .sort((left, right) => left.name.localeCompare(right.name))
            .map((entry) => ({
              name: entry.name,
              type: entry.isDirectory()
                ? 'directory'
                : entry.isFile()
                  ? 'file'
                  : 'other'
            })),
          truncated: listing.truncated
        },
        '工作区目录结果无法序列化'
      )
    }
    if (name === 'workspace_write_text') {
      const input = writeInputSchema.parse(argumentsValue)
      if (Buffer.byteLength(input.content) > MAX_WRITE_BYTES) {
        throw new Error('写入内容超过 512KB 安全限制')
      }
      const filePath = await this.resolveWritablePath(input.path)
      const temporaryPath = `${filePath}.${randomUUID()}.tmp`
      const handle = await open(temporaryPath, 'wx', 0o600)
      try {
        try {
          await handle.writeFile(input.content, 'utf8')
        } finally {
          await handle.close()
        }
        await rename(temporaryPath, filePath)
      } catch (error) {
        await rm(temporaryPath, { force: true }).catch(() => undefined)
        throw new Error('无法安全写入工作区文件', { cause: error })
      }
      return boundedJson(
        {
          path: input.path,
          bytesWritten: Buffer.byteLength(input.content)
        },
        '工作区写入结果无法序列化'
      )
    }

    const binding = (await this.getMcpBindings(signal)).get(name)
    if (!binding) {
      throw new Error('模型请求了未知工具')
    }
    const result = await binding.client.callTool(
      {
        name: binding.originalName,
        arguments: argumentsValue
      },
      undefined,
      {
        timeout: MCP_TIMEOUT_MS,
        signal
      }
    )
    return getMcpResultText(result)
  }

  async dispose(): Promise<void> {
    const clients = [...this.clients]
    this.clients.clear()
    this.mcpBindings = undefined
    await Promise.allSettled(clients.map((client) => client.close()))
  }
}

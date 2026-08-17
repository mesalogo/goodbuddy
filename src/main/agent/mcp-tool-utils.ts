import { createHash } from 'node:crypto'
import type { Client } from '@modelcontextprotocol/sdk/client/index.js'

const MAXIMUM_MCP_TOOL_SCHEMA_BYTES = 32 * 1024
const DEFAULT_MAXIMUM_MCP_TOOL_PAGES = 100

type ListedMcpTool =
  Awaited<ReturnType<Client['listTools']>>['tools'][number]

export async function listAllMcpTools(
  client: Pick<Client, 'listTools'>,
  serverName: string,
  signal: AbortSignal,
  options: {
    maximumTools: number
    pageTimeoutMs: number
    totalTimeoutMs: number
    maximumPages?: number
  }
): Promise<ListedMcpTool[]> {
  const tools: ListedMcpTool[] = []
  const toolNames = new Set<string>()
  const cursors = new Set<string>()
  const deadline = Date.now() + options.totalTimeoutMs
  const maximumPages =
    options.maximumPages ?? DEFAULT_MAXIMUM_MCP_TOOL_PAGES
  let cursor: string | undefined
  for (let page = 0; page < maximumPages; page += 1) {
    signal.throwIfAborted()
    const remainingMs = deadline - Date.now()
    if (remainingMs <= 0) {
      throw new Error(
        `MCP Server「${serverName}」的工具分页超过总超时`
      )
    }
    const result = await client.listTools(
      cursor !== undefined ? { cursor } : undefined,
      {
        timeout: Math.max(
          1,
          Math.min(options.pageTimeoutMs, remainingMs)
        ),
        signal
      }
    )
    for (const tool of result.tools) {
      if (toolNames.has(tool.name)) {
        throw new Error(
          `MCP Server「${serverName}」返回了重复工具「${tool.name}」`
        )
      }
      toolNames.add(tool.name)
      tools.push(tool)
      if (tools.length > options.maximumTools) {
        throw new Error(
          `MCP Server「${serverName}」提供的工具数量超过安全限制`
        )
      }
    }
    if (result.nextCursor === undefined) {
      return tools
    }
    if (cursors.has(result.nextCursor)) {
      throw new Error(
        `MCP Server「${serverName}」的工具分页游标发生循环`
      )
    }
    cursors.add(result.nextCursor)
    cursor = result.nextCursor
  }
  throw new Error(
    `MCP Server「${serverName}」的工具分页超过安全限制`
  )
}

export function isValidMcpToolName(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 128 &&
    ![...value].some((character) => {
      const code = character.charCodeAt(0)
      return code <= 31 || code === 127
    })
  )
}

export function createMcpToolName(
  serverId: string,
  originalName: string
): string {
  const serverHash = createHash('sha256')
    .update(serverId)
    .digest('hex')
    .slice(0, 8)
  const toolHash = createHash('sha256')
    .update(originalName)
    .digest('hex')
    .slice(0, 8)
  const readable =
    originalName
      .replace(/[^a-zA-Z0-9_-]+/gu, '_')
      .replace(/^_+|_+$/gu, '')
      .slice(0, 36) || 'tool'
  return `mcp_${serverHash}_${toolHash}_${readable}`.slice(0, 64)
}

export function normalizeMcpToolSchema(
  value: unknown
): Record<string, unknown> & { type: 'object' } {
  let serialized: string
  try {
    serialized = JSON.stringify(value)
  } catch (error) {
    throw new Error('MCP 工具参数结构无效', { cause: error })
  }
  if (
    !serialized ||
    Buffer.byteLength(serialized) >
      MAXIMUM_MCP_TOOL_SCHEMA_BYTES
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
  return schema as Record<string, unknown> & { type: 'object' }
}

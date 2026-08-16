import { createHash } from 'node:crypto'

const MAXIMUM_MCP_TOOL_SCHEMA_BYTES = 32 * 1024

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

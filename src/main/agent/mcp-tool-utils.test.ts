import { describe, expect, it } from 'vitest'
import {
  createGatewayMcpToolName,
  MAXIMUM_GATEWAY_MCP_TOOL_NAME_LENGTH
} from './mcp-tool-utils'

describe('createGatewayMcpToolName', () => {
  it('keeps provider-safe original names readable behind a short server hash', () => {
    expect(
      createGatewayMcpToolName('server-1', 'crmtools_search_tools')
    ).toMatch(/^[a-f0-9]{4}_crmtools_search_tools$/u)
  })

  it('separates identical tool names from different servers', () => {
    expect(createGatewayMcpToolName('server-1', 'search')).not.toBe(
      createGatewayMcpToolName('server-2', 'search')
    )
  })

  it('sanitizes unsafe names and keeps them unique with a tool hash', () => {
    const dotted = createGatewayMcpToolName('server-1', 'files.read')
    const spaced = createGatewayMcpToolName('server-1', 'files read')
    expect(dotted).toMatch(/^[a-f0-9]{4}_files_read_[a-f0-9]{4}$/u)
    expect(spaced).toMatch(/^[a-f0-9]{4}_files_read_[a-f0-9]{4}$/u)
    expect(dotted).not.toBe(spaced)
    expect(createGatewayMcpToolName('server-1', '工具')).toMatch(
      /^[a-f0-9]{4}_tool_[a-f0-9]{4}$/u
    )
  })

  it('keeps the runtime-prefixed name within 64 characters for long tool names', () => {
    const longA = `${'a'.repeat(120)}_one`
    const longB = `${'a'.repeat(120)}_two`
    const nameA = createGatewayMcpToolName('server-1', longA)
    const nameB = createGatewayMcpToolName('server-1', longB)
    expect(nameA.length).toBeLessThanOrEqual(
      MAXIMUM_GATEWAY_MCP_TOOL_NAME_LENGTH
    )
    expect(nameA).not.toBe(nameB)
    expect(`gbc-a1b2c3-9_${nameA}`.length).toBeLessThanOrEqual(64)
    expect(nameA).toMatch(/^[a-zA-Z0-9_-]+$/u)
  })
})

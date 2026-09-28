// @vitest-environment node
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, join, resolve } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { CallToolResultSchema, type CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { obsidianReadToolNames, obsidianScopedDataTools, obsidianWriteToolNames } from '../../shared/obsidian-tools'
import type { KnowledgeService } from '../knowledge/knowledge-service'
import { ObsidianService, type ObsidianSettings } from '../obsidian/obsidian-service'
import { packageObsidianMcpVault } from '../obsidian/package-mcpvault'
import { KnowledgeMcpGateway } from './knowledge-mcp-gateway'

let root: string
let vaultPath: string
let service: ObsidianService
const gateways: KnowledgeMcpGateway[] = []
const clients: Client[] = []
const provider = vi.fn<() => NodeJS.ProcessEnv>()

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'goodbuddy-obsidian-gateway-'))
  vaultPath = join(root, 'First Vault')
  const second = join(root, 'Second Vault')
  const config = join(root, 'config')
  const bin = join(root, 'managed-bin')
  await Promise.all([vaultPath, second, bin, join(config, 'obsidian')].map((path) => mkdir(path, { recursive: true })))
  await writeFile(join(config, 'obsidian', 'obsidian.json'), JSON.stringify({ vaults: {
    first: { path: vaultPath }, second: { path: second }
  } }))
  await writeFile(join(bin, process.platform === 'win32' ? 'node.cmd' : 'node'),
    process.platform === 'win32'
      ? `@echo off\r\nset "ELECTRON_RUN_AS_NODE=1"\r\n"${process.execPath}" %*\r\n`
      : `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec '${process.execPath.replaceAll("'", "'\\''")}' "$@"\n`,
    { mode: 0o755 })
  provider.mockImplementation(() => ({ PATH: `${bin}${delimiter}${process.env.PATH ?? process.env.Path ?? ''}` }))
  const appPath = join(root, 'app')
  await packageObsidianMcpVault(resolve('.'), join(appPath, 'out', 'main', 'obsidian-mcpvault'))
  service = new ObsidianService({ appPath, launchEnvironmentProvider: provider,
    platform: 'linux', environment: { ...process.env, XDG_CONFIG_HOME: config } })
}, 60_000)

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()))
  await Promise.all(gateways.splice(0).map((gateway) => gateway.dispose()))
  vi.restoreAllMocks()
})
afterAll(async () => { await rm(root, { recursive: true, force: true }) })

function grant(access: 'read' | 'write', settings: ObsidianSettings = {}, signal = new AbortController().signal) {
  const gateway = new KnowledgeMcpGateway({} as KnowledgeService, { obsidianService: service })
  gateways.push(gateway)
  const token = gateway.grant('obsidian-test', [], signal, 'none', undefined, undefined, undefined, undefined, { settings, access })!
  return { gateway, token }
}

async function connect(gateway: KnowledgeMcpGateway, token: string) {
  await gateway.start()
  const client = new Client({ name: 'obsidian-gateway-test', version: '1.0.0' })
  clients.push(client)
  await client.connect(new StreamableHTTPClientTransport(new URL(gateway.getEndpoint()!), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } }
  }))
  return client
}

function text(result: CallToolResult) {
  return result.content.map((item) => item.type === 'text' ? item.text : '').join('\n')
}

describe('Obsidian gateway', () => {
  it('uses the shared Ask classification and exposes every tool for Execute', async () => {
    const read = grant('read')
    const write = grant('write')
    expect(read.gateway.getAvailableToolNames(read.token)).toEqual(obsidianReadToolNames)
    expect(write.gateway.getAvailableToolNames(write.token)).toEqual([...obsidianReadToolNames, ...obsidianWriteToolNames])
    const client = await connect(write.gateway, write.token)
    const tools = (await client.listTools()).tools
    expect(tools).toHaveLength(19)
    expect(tools.map((tool) => tool.name).sort()).toEqual(obsidianScopedDataTools.map((tool) => tool.name).sort())
    for (const definition of obsidianScopedDataTools) {
      expect(tools.find((tool) => tool.name === definition.name)?.annotations?.readOnlyHint).toBe(definition.access === 'read')
    }
    await expect(read.gateway.callObsidianTool(read.token, 'obsidian_write_note', { path: 'blocked.md', content: '' })).rejects.toThrow('capability is unavailable')
    const absent = new KnowledgeMcpGateway({} as KnowledgeService)
    gateways.push(absent)
    expect(absent.grant('absent', [], new AbortController().signal, 'none', undefined, undefined, undefined, undefined,
      { settings: {}, access: 'write' })).toBeUndefined()
  })

  it('writes, reads, lists and deletes through HTTP using the real service and explicit vault targets', async () => {
    const { gateway, token } = grant('write')
    const client = await connect(gateway, token)
    const call = async (name: string, args: Record<string, unknown> = {}) =>
      CallToolResultSchema.parse(await client.callTool({ name, arguments: args }, CallToolResultSchema))
    const vaults = JSON.parse(text(await call('obsidian_list_vaults'))).vaults
    expect(vaults.map((vault: { id: string }) => vault.id)).toEqual(['first', 'second'])
    await expect(call('obsidian_write_note', { path: 'gateway.md', content: 'ambiguous' })).rejects.toThrow('vaultId is required')
    await expect(call('obsidian_read_note', { vaultId: 'missing', path: 'gateway.md' })).rejects.toThrow('Unknown Obsidian vaultId')
    for (const vaultId of ['first', 'second']) {
      expect((await call('obsidian_write_note', { vaultId, path: 'gateway.md', content: `# ${vaultId}` })).isError).not.toBe(true)
      expect(text(await call('obsidian_read_note', { vaultId, path: 'gateway.md' }))).toContain(`# ${vaultId}`)
      expect(text(await call('obsidian_list_directory', { vaultId }))).toContain('gateway.md')
    }
    expect(await readFile(join(vaultPath, 'gateway.md'), 'utf8')).toContain('# first')
    const failedDelete = await call('obsidian_delete_note', { vaultId: 'first', path: 'gateway.md', confirmPath: 'wrong.md' })
    expect(failedDelete.isError).toBe(true)
    expect(text(failedDelete)).toContain('confirmPath')
    expect(text(failedDelete)).not.toContain('"content":[')
    for (const vaultId of ['first', 'second']) {
      expect((await call('obsidian_delete_note', { vaultId, path: 'gateway.md', confirmPath: 'gateway.md' })).isError).not.toBe(true)
      expect(text(await call('obsidian_list_directory', { vaultId }))).not.toContain('gateway.md')
    }
    expect(provider).toHaveBeenCalled()
  }, 30_000)

  it('allows an omitted vaultId for an explicit single vault and returns native errors directly', async () => {
    const { gateway, token } = grant('write', { vaultPath })
    const result = await gateway.callObsidianTool(token, 'obsidian_read_note', { path: 'absent.md' })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('absent.md')
    expect(JSON.parse(text(await gateway.callObsidianTool(token, 'obsidian_list_vaults', {}))).vaults).toHaveLength(1)
  })

  it('preserves native content and enforces the existing MCP result bound in HTTP and direct calls', async () => {
    const { gateway, token } = grant('read')
    const native: CallToolResult = { isError: true, content: [
      { type: 'text', text: 'upstream detail' },
      { type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' }
    ], structuredContent: { detail: 'upstream detail' } }
    const call = vi.spyOn(service, 'callTool').mockResolvedValue(native)
    const client = await connect(gateway, token)
    expect(await gateway.callObsidianTool(token, 'obsidian_read_note', { vaultId: 'first', path: 'test.md' })).toEqual(native)
    expect(call).toHaveBeenLastCalledWith({}, { vaultId: 'first', name: 'read_note', arguments: { path: 'test.md', prettyPrint: false } }, expect.any(AbortSignal))
    expect(await client.callTool({ name: 'obsidian_read_note', arguments: { path: 'test.md' } }, CallToolResultSchema)).toEqual(native)
    call.mockResolvedValue({ content: [{ type: 'text', text: 'x'.repeat(256 * 1024) }] })
    await expect(gateway.callObsidianTool(token, 'obsidian_read_note', { path: 'large.md' })).rejects.toThrow('256KB')
    await expect(client.callTool({ name: 'obsidian_read_note', arguments: { path: 'large.md' } })).rejects.toThrow('256KB')
  })

  it('revokes all Obsidian grants while retaining unrelated capabilities and allowing new grants', () => {
    const { gateway, token } = grant('read')
    const signal = new AbortController().signal
    const writeToken = gateway.grant('write', [], signal, 'none', undefined, undefined, undefined, undefined,
      { settings: { vaultPath }, access: 'write' })!
    const mixedToken = gateway.grant('mixed', ['library'], signal, 'none', undefined, undefined, undefined, undefined,
      { settings: {}, access: 'write' })!
    const knowledgeToken = gateway.grant('knowledge', ['library'], signal)!
    gateway.revokeObsidianCapabilities()
    gateway.revokeObsidianCapabilities()
    for (const revoked of [token, writeToken, mixedToken]) {
      expect(() => gateway.getAvailableToolNames(revoked)).toThrow('Tool authorization is unavailable')
    }
    expect(gateway.getAvailableToolNames(knowledgeToken)).toEqual(['knowledge_list', 'knowledge_search'])
    const replacement = gateway.grant('replacement', [], signal, 'none', undefined, undefined, undefined, undefined,
      { settings: { vaultPath }, access: 'write' })!
    expect(gateway.getAvailableToolNames(replacement)).toEqual([...obsidianReadToolNames, ...obsidianWriteToolNames])
  })

  it.each([false, true])('awaits transport close during disposal, including previously revoked calls (%s)', async (revokeFirst) => {
    const { gateway, token } = grant('read', { vaultPath })
    let markStarted!: () => void
    const started = new Promise<void>((resolve) => { markStarted = resolve })
    let markClosing!: () => void
    const closing = new Promise<void>((resolve) => { markClosing = resolve })
    let releaseClose!: () => void
    const closeGate = new Promise<void>((resolve) => { releaseClose = resolve })
    let closed = false
    const close = StdioClientTransport.prototype.close
    vi.spyOn(StdioClientTransport.prototype, 'close').mockImplementation(async function (this: StdioClientTransport) {
      markClosing()
      await closeGate
      await close.call(this)
      closed = true
    })
    const send = StdioClientTransport.prototype.send
    vi.spyOn(StdioClientTransport.prototype, 'send').mockImplementation(function (this: StdioClientTransport, message) {
      const result = send.call(this, message)
      if ('method' in message && message.method === 'tools/call') markStarted()
      return result
    })
    const pending = gateway.callObsidianTool(token, 'obsidian_list_directory', {})
      .then(() => undefined, (error: unknown) => error)
    await Promise.race([started, pending.then(() => { throw new Error('Call ended before upstream dispatch') })])
    if (revokeFirst) gateway.revokeObsidianCapabilities()
    let disposed = false
    const disposal = gateway.dispose().then(() => { disposed = true })
    try {
      await closing
      await new Promise<void>((resolve) => setImmediate(resolve))
      expect(disposed).toBe(false)
      expect(closed).toBe(false)
    } finally {
      releaseClose()
      await disposal
      await pending
    }
    expect(closed).toBe(true)
    expect(await pending).toBeInstanceOf(Error)
  })

  it.each(['revoke', 'settings', 'request', 'call', 'dispose'] as const)('cancels and closes the actual upstream child on %s', async (cancellation) => {
    const controller = new AbortController()
    const callController = new AbortController()
    const { gateway, token } = grant('read', { vaultPath }, controller.signal)
    const transports = new Set<StdioClientTransport>()
    const send = StdioClientTransport.prototype.send
    vi.spyOn(StdioClientTransport.prototype, 'send').mockImplementation(function (this: StdioClientTransport, message) {
      transports.add(this)
      const result = send.call(this, message)
      if ('method' in message && message.method === 'tools/call') {
        if (cancellation === 'revoke') gateway.revoke(token)
        else if (cancellation === 'settings') gateway.revokeObsidianCapabilities()
        else if (cancellation === 'request') controller.abort(new Error('Request cancelled'))
        else if (cancellation === 'call') callController.abort(new Error('Call cancelled'))
        else void gateway.dispose()
      }
      return result
    })
    await expect(gateway.callObsidianTool(token, 'obsidian_list_directory', {}, callController.signal)).rejects.toThrow(/revoked|cancelled/)
    expect(transports.size).toBe(1)
    for (const transport of transports) expect(transport.pid).toBeNull()
  })
})

// @vitest-environment node
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, join, resolve } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { z } from 'zod'
import { obsidianReadToolNames, obsidianScopedDataTools } from '../../shared/obsidian-tools'
import type { ResolvedMcpServer } from '../capabilities/capability-service'
import type { KnowledgeService } from '../knowledge/knowledge-service'
import { ObsidianService } from '../obsidian/obsidian-service'
import { packageObsidianMcpVault } from '../obsidian/package-mcpvault'
import { KnowledgeMcpGateway } from './knowledge-mcp-gateway'
import { ModelToolProvider, type ModelToolCallContext, type ModelToolResult } from './model-tool-provider'

let root: string
let vaultPath: string
let secondVaultPath: string
let service: ObsidianService
const fixtures: { provider: ModelToolProvider; gateway: KnowledgeMcpGateway }[] = []

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'goodbuddy-obsidian-model-'))
  vaultPath = join(root, 'First Vault')
  secondVaultPath = join(root, 'Second Vault')
  const config = join(root, 'config')
  const bin = join(root, 'managed-bin')
  await Promise.all([vaultPath, secondVaultPath, bin, join(config, 'obsidian')]
    .map((path) => mkdir(path, { recursive: true })))
  await writeFile(join(config, 'obsidian', 'obsidian.json'), JSON.stringify({ vaults: {
    first: { path: vaultPath }, second: { path: secondVaultPath }
  } }))
  await writeFile(join(bin, process.platform === 'win32' ? 'node.cmd' : 'node'),
    process.platform === 'win32'
      ? `@echo off\r\nset "ELECTRON_RUN_AS_NODE=1"\r\n"${process.execPath}" %*\r\n`
      : `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec '${process.execPath.replaceAll("'", "'\\''")}' "$@"\n`,
    { mode: 0o755 })
  const appPath = join(root, 'app')
  await packageObsidianMcpVault(resolve('.'), join(appPath, 'out', 'main', 'obsidian-mcpvault'))
  service = new ObsidianService({
    appPath,
    launchEnvironmentProvider: () => ({ PATH: `${bin}${delimiter}${process.env.PATH ?? process.env.Path ?? ''}` }),
    platform: 'linux', environment: { ...process.env, XDG_CONFIG_HOME: config }
  })
}, 60_000)

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map(async ({ provider, gateway }) => {
    await provider.dispose()
    await gateway.dispose()
  }))
  vi.restoreAllMocks()
})
afterAll(async () => { await rm(root, { recursive: true, force: true }) })

function fixture(access: 'read' | 'write' = 'write') {
  const gateway = new KnowledgeMcpGateway({} as KnowledgeService, { obsidianService: service })
  const signal = new AbortController().signal
  const token = gateway.grant('obsidian-model-test', [], signal, 'none', undefined,
    undefined, undefined, undefined, { settings: {}, access })!
  const provider = new ModelToolProvider(root, [], undefined, gateway)
  fixtures.push({ provider, gateway })
  const context: ModelToolCallContext = {
    conversationId: 'obsidian-model-test', runtimeTarget: 'model',
    knowledgeCapabilityToken: token
  }
  return { gateway, provider, token, signal, context,
    call: (name: string, args: Record<string, unknown> = {}) => provider.callTool(name, args, signal, context) }
}

function text(result: ModelToolResult): string {
  expect(result.contextBytes).toBe(result.parts.reduce((sum, part) =>
    sum + Buffer.byteLength(part.type === 'text' ? part.text : part.data), 0))
  return result.parts.map((part) => part.type === 'text' ? part.text : '').join('\n')
}

describe('ModelToolProvider with bundled Obsidian service', () => {
  it('discovers and executes all 19 tools through a scoped token, with real filesystem effects', async () => {
    const { provider, context, signal, call } = fixture()
    const tools = (await provider.listTools(context, signal)).filter((tool) => tool.name.startsWith('obsidian_'))
    expect(tools).toHaveLength(19)
    expect(tools.map((tool) => tool.name).sort()).toEqual(obsidianScopedDataTools.map((tool) => tool.name).sort())
    const executed = new Set<string>()
    const run = async (name: string, args: Record<string, unknown> = {}) => {
      const result = text(await call(name, args))
      executed.add(name)
      return result
    }
    expect(JSON.parse(await run('obsidian_list_vaults')).vaults).toEqual([
      { id: 'first', name: 'First Vault', path: vaultPath },
      { id: 'second', name: 'Second Vault', path: secondVaultPath }
    ])
    await expect(call('obsidian_write_note', { path: 'model.md', content: 'ambiguous' }))
      .rejects.toThrow('vaultId is required')
    await expect(call('obsidian_read_note', { vaultId: 'unknown', path: 'model.md' }))
      .rejects.toThrow('Unknown Obsidian vaultId')
    const target = { vaultId: 'first', path: 'model.md' }
    await run('obsidian_write_note', { ...target, content: '# Original\nBody', frontmatter: { title: 'Model' } })
    expect(await readFile(join(vaultPath, 'model.md'), 'utf8')).toContain('# Original')
    await expect(readFile(join(secondVaultPath, 'model.md'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(JSON.parse(await run('obsidian_read_note', target)).content).toContain('# Original')
    expect(await run('obsidian_list_directory', { vaultId: 'first' })).toContain('model.md')
    await run('obsidian_patch_note', { ...target, oldString: 'Original', newString: 'Patched' })
    await run('obsidian_update_frontmatter', { ...target, frontmatter: { status: 'verified' } })
    await run('obsidian_manage_tags', { ...target, operation: 'add', tags: ['integration'] })
    expect(await run('obsidian_get_frontmatter', target)).toContain('verified')
    expect(await run('obsidian_search_notes', { vaultId: 'first', query: 'Patched' })).toContain('model.md')
    expect(await run('obsidian_read_multiple_notes', { vaultId: 'first', paths: ['model.md'] })).toContain('Patched')
    expect(await run('obsidian_get_notes_info', { vaultId: 'first', paths: ['model.md'] })).toContain('model.md')
    expect(await run('obsidian_get_vault_stats', { vaultId: 'first' })).toContain('model.md')
    expect(await run('obsidian_list_all_tags', { vaultId: 'first' })).toContain('integration')
    expect(await run('obsidian_wiki_link', { vaultId: 'first', document: '[[model]]' })).toContain('Patched')
    expect(await run('obsidian_get_note_outline', target)).toContain('Patched')
    expect(await run('obsidian_read_note_lines', { ...target, startLine: 1, endLine: 20 })).toContain('Patched')
    await run('obsidian_move_note', { vaultId: 'first', oldPath: 'model.md', newPath: 'renamed.md' })
    expect(await readFile(join(vaultPath, 'renamed.md'), 'utf8')).toContain('# Patched')
    await writeFile(join(vaultPath, 'attachment.bin'), Buffer.from([0, 1, 255]))
    await run('obsidian_move_file', { vaultId: 'first', oldPath: 'attachment.bin', newPath: 'moved.bin',
      confirmOldPath: 'attachment.bin', confirmNewPath: 'moved.bin' })
    expect(await readFile(join(vaultPath, 'moved.bin'))).toEqual(Buffer.from([0, 1, 255]))
    await run('obsidian_delete_note', { vaultId: 'first', path: 'renamed.md', confirmPath: 'renamed.md' })
    await expect(readFile(join(vaultPath, 'renamed.md'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await run('obsidian_list_directory', { vaultId: 'first' })).not.toContain('renamed.md')
    expect([...executed].sort()).toEqual(tools.map((tool) => tool.name).sort())
  }, 60_000)

  it('enforces scoped grants, missing tokens and revoked tokens at the provider boundary', async () => {
    const { provider, gateway, context, signal, token, call } = fixture()
    const read = fixture('read')
    expect((await read.provider.listTools(read.context, signal)).filter((tool) => tool.name.startsWith('obsidian_'))
      .map((tool) => tool.name).sort()).toEqual([...obsidianReadToolNames].sort())
    const args = { vaultId: 'first', path: 'blocked.md', content: 'blocked' }
    await expect(fixture('read').call('obsidian_write_note', args)).rejects.toThrow('capability is unavailable')
    const unscoped = { ...context, knowledgeCapabilityToken: undefined }
    expect((await provider.listTools(unscoped, signal)).some((tool) => tool.name.startsWith('obsidian_'))).toBe(false)
    await expect(provider.callTool('obsidian_list_vaults', {}, signal, unscoped)).rejects.toThrow()
    gateway.revoke(token)
    await expect(call('obsidian_list_vaults')).rejects.toThrow()
    await expect(readFile(join(vaultPath, 'blocked.md'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('awaits the active bundled child cleanup when the gateway is disposed', async () => {
    const { gateway, call } = fixture()
    let markStarted!: (transport: StdioClientTransport) => void
    const started = new Promise<StdioClientTransport>((resolve) => { markStarted = resolve })
    const closed = new Set<StdioClientTransport>()
    const close = StdioClientTransport.prototype.close
    vi.spyOn(StdioClientTransport.prototype, 'close').mockImplementation(async function (this: StdioClientTransport) {
      await close.call(this)
      closed.add(this)
    })
    const send = StdioClientTransport.prototype.send
    vi.spyOn(StdioClientTransport.prototype, 'send').mockImplementation(function (this: StdioClientTransport, message) {
      const result = send.call(this, message)
      if ('method' in message && message.method === 'tools/call') markStarted(this)
      return result
    })
    const pending = call('obsidian_list_directory', { vaultId: 'first' })
      .then(() => undefined, (error: unknown) => error)
    const transport = await Promise.race([
      started,
      pending.then(() => { throw new Error('Tool call ended before upstream dispatch') })
    ])
    expect(transport.pid).not.toBeNull()
    try {
      await gateway.dispose()
      // The SDK clears pid at the start of close(), before awaiting process exit.
      expect(closed.has(transport), 'dispose must await the actual transport close promise').toBe(true)
    } finally {
      expect(await pending).toBeInstanceOf(Error)
      expect(closed.has(transport)).toBe(true)
      expect(transport.pid).toBeNull()
    }
  })

  it('keeps upstream defaulted arguments optional in model discovery', async () => {
    const { provider, context, signal } = fixture()
    const tools = await provider.listTools(context, signal)
    for (const definition of obsidianScopedDataTools) {
      const expected = z.toJSONSchema(definition.inputSchema, { io: 'input' })
      expect.soft(tools.find((tool) => tool.name === definition.name)?.inputSchema.required ?? [], definition.name)
        .toEqual(expected.required ?? [])
    }
  })

  it('does not spend the custom MCP budget on disabled Obsidian tools', async () => {
    const gateway = new KnowledgeMcpGateway({} as KnowledgeService, { obsidianService: service })
    const servers: ResolvedMcpServer[] = Array.from({ length: 4 }, (_, index) => ({
      id: `00000000-0000-4000-8000-00000000000${index}`, name: `Vault ${index}`,
      description: '', enabled: true, allowDynamicTools: false, assignments: ['model'],
      secretConfigured: false, transport: 'stdio', command: 'node',
      args: [join(root, 'app', 'out', 'main', 'obsidian-mcpvault', 'node_modules',
        '@bitbonsai', 'mcpvault', 'dist', 'server.js'), vaultPath]
    }))
    const provider = new ModelToolProvider(root, servers, undefined, gateway, false, {}, () => ({
      PATH: `${join(root, 'managed-bin')}${delimiter}${process.env.PATH ?? process.env.Path ?? ''}`
    }))
    fixtures.push({ provider, gateway })
    // No scoped grant: 72 real upstream tools plus two workspace tools fit below 100.
    const tools = await provider.listTools({ conversationId: 'disabled-obsidian' },
      new AbortController().signal)
    expect(tools.filter((tool) => tool.source === 'mcp')).toHaveLength(72)
    expect(tools.some((tool) => tool.name.startsWith('obsidian_'))).toBe(false)
    expect(tools).toHaveLength(74)
  }, 30_000)

  it.each(['read_note', 'delete_note'] as const)('preserves the native %s error detail for the model', async (name) => {
    const { call } = fixture()
    const args = name === 'read_note' ? { path: 'missing.md' }
      : { path: 'protected.md', confirmPath: 'wrong.md' }
    if (name === 'delete_note') await call('obsidian_write_note', { vaultId: 'first', path: args.path, content: 'keep me' })
    // Establish the actual bundled server error, without injecting a service or gateway double.
    const native = await service.callTool({}, { vaultId: 'first', name, arguments: args })
    expect(native.isError).toBe(true)
    const detail = native.content.map((part) => part.type === 'text' ? part.text : '').join('\n')
    expect(detail).toContain(name === 'read_note' ? 'missing.md' : 'confirmPath')
    const failure = await call(`obsidian_${name}`, { vaultId: 'first', ...args }).catch((error: unknown) => error)
    if (name === 'delete_note') expect(await readFile(join(vaultPath, args.path), 'utf8')).toContain('keep me')
    expect(failure).toBeInstanceOf(Error)
    expect((failure as Error).message).toContain(detail)
  }, 30_000)
})

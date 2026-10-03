import { createHash } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, isAbsolute, join, resolve } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { CallToolResultSchema, type CallToolResult, type Tool } from '@modelcontextprotocol/sdk/types.js'
import { applyLaunchEnvironmentPath, buildCredentialFilteredUserEnvironment } from '../agent/process-environment'
import type { LaunchEnvironmentProvider, LaunchEnvironmentReady } from '../local-tool-environment/launch-environment-provider'

export type ObsidianSettings = { vaultPath?: string }
export type ObsidianVault = { id: string; name: string; path: string }
export type ObsidianServiceOptions = {
  /** Electron app.getAppPath(), or the project root in development. */
  appPath: string
  launchEnvironmentProvider: LaunchEnvironmentProvider
  /** Awaited before reading the provider; startup builds the environment in the background. */
  launchEnvironmentReady?: LaunchEnvironmentReady
  homePath?: string
  platform?: NodeJS.Platform
  environment?: NodeJS.ProcessEnv
}

export class ObsidianService {
  constructor(private readonly options: ObsidianServiceOptions) {}

  async listVaults(settings: ObsidianSettings): Promise<ObsidianVault[]> {
    const platform = this.options.platform ?? process.platform
    const vault = async (path: string, id?: string): Promise<ObsidianVault> => {
      if (!isAbsolute(path)) throw new Error(`Obsidian vault path must be absolute: ${path}`)
      const normalized = resolve(path)
      let directory: boolean
      try {
        directory = (await stat(normalized)).isDirectory()
      } catch (cause) {
        throw new Error(`Obsidian vault folder is missing or inaccessible: ${normalized}`, { cause })
      }
      if (!directory) throw new Error(`Obsidian vault path is not a folder: ${normalized}`)
      return {
        id: id ?? createHash('sha256').update(platform === 'win32' ? normalized.toLowerCase() : normalized).digest('hex'),
        name: basename(normalized) || normalized,
        path: normalized
      }
    }
    if (settings.vaultPath?.trim()) return [await vault(settings.vaultPath)]

    const home = this.options.homePath ?? homedir()
    const env = this.options.environment ?? process.env
    const configRoot = platform === 'win32'
      ? env.APPDATA || join(home, 'AppData', 'Roaming')
      : platform === 'darwin'
        ? join(home, 'Library', 'Application Support')
        : env.XDG_CONFIG_HOME || join(home, '.config')
    const configPath = join(configRoot, 'obsidian', 'obsidian.json')
    let config: { vaults?: Record<string, { path?: unknown }> }
    try {
      config = JSON.parse(await readFile(configPath, 'utf8'))
    } catch (cause) {
      throw new Error(`Cannot read Obsidian vault registry: ${configPath}. Open a vault in Obsidian or set vaultPath.`, { cause })
    }
    const entries = Object.entries(config?.vaults ?? {})
    if (!entries.length) throw new Error('No Obsidian vaults registered. Open a vault in Obsidian or set vaultPath.')
    return Promise.all(entries.map(([id, entry]) => {
      if (typeof entry?.path !== 'string' || !entry.path) {
        throw new Error(`Invalid Obsidian vault registry entry: ${id}`)
      }
      return vault(entry.path, id)
    }))
  }

  async testConnection(settings: ObsidianSettings): Promise<{ vaults: ObsidianVault[]; toolCount: number }> {
    const vaults = await this.listVaults(settings)
    const names = new Set<string>()
    for (const vault of vaults) {
      const tools = await this.withClient(vault, (client) => this.readTools(client))
      for (const tool of tools) names.add(tool.name)
    }
    return { vaults, toolCount: names.size }
  }

  /** Unmodified upstream schemas; callers can wrap every tool with a vaultId argument. */
  async listTools(settings: ObsidianSettings): Promise<Tool[]> {
    const [vault] = await this.listVaults(settings)
    return this.withClient(vault!, (client) => this.readTools(client))
  }

  async callTool(
    settings: ObsidianSettings,
    request: { vaultId?: string; name: string; arguments: Record<string, unknown> },
    signal?: AbortSignal
  ): Promise<CallToolResult> {
    signal?.throwIfAborted()
    const vaults = await this.listVaults(settings)
    const vault = request.vaultId === undefined
      ? vaults.length === 1 ? vaults[0] : undefined
      : vaults.find((candidate) => candidate.id === request.vaultId)
    if (!vault) {
      throw new Error(request.vaultId === undefined
        ? 'Multiple Obsidian vaults are available; vaultId is required.'
        : `Unknown Obsidian vaultId: ${request.vaultId}`)
    }
    return this.withClient(vault, async (client) => CallToolResultSchema.parse(await client.callTool(
      { name: request.name, arguments: request.arguments },
      CallToolResultSchema,
      { signal }
    )), signal)
  }

  private async readTools(client: Client): Promise<Tool[]> {
    const tools: Tool[] = []
    let cursor: string | undefined
    do {
      const page = await client.listTools({ cursor })
      tools.push(...page.tools)
      cursor = page.nextCursor
    } while (cursor)
    return tools
  }

  private async withClient<T>(vault: ObsidianVault, action: (client: Client) => Promise<T>, signal?: AbortSignal): Promise<T> {
    signal?.throwIfAborted()
    const appPath = this.options.appPath.replace(/\.asar(?=[\\/]|$)/u, '.asar.unpacked')
    const serverPath = join(appPath, 'out', 'main', 'obsidian-mcpvault', 'node_modules', '@bitbonsai', 'mcpvault', 'dist', 'server.js')
    await stat(serverPath).catch((cause) => {
      throw new Error(`Bundled Obsidian MCPVault server is missing: ${serverPath}`, { cause })
    })
    await this.options.launchEnvironmentReady?.()
    const env = applyLaunchEnvironmentPath(
      buildCredentialFilteredUserEnvironment(this.options.environment ?? process.env),
      this.options.launchEnvironmentProvider
    )
    const client = new Client({ name: 'goodbuddy-obsidian', version: '1.0.0' })
    const transport = new StdioClientTransport({
      command: 'node',
      args: [serverPath, vault.path],
      cwd: vault.path,
      env: Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined)),
      stderr: 'ignore'
    })
    // SDK initialization failures also close asynchronously; await that same cleanup.
    const closeTransport = transport.close.bind(transport)
    let closing: Promise<void> | undefined
    transport.close = () => closing ??= closeTransport()
    try {
      signal?.throwIfAborted()
      await client.connect(transport, { signal })
      signal?.throwIfAborted()
      return await action(client)
    } finally {
      // Close the transport even if initialization failed before Client took ownership.
      await transport.close()
      await client.close()
    }
  }
}

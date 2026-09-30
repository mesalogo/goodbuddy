import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { cp, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { AgentModelCallLedger, AgentModelGateway } from '../../agent-daemon/agent-model-gateway'
import {
  ModelBridgeLoopbackProxy,
  MODEL_BRIDGE_SDK_AUTH_SENTINEL,
  createOpenCodeModelBridgeProviderConfig
} from '../../agent-daemon/model-bridge-helper'
import type { TerminalSize, TerminalSnapshot } from '../../shared/terminal-contracts'
import type { ResolvedRuntimeSettings } from '../runtime-settings-store'
import type { RuntimeSkillPackage } from '../capabilities/capability-service'
import type { LaunchEnvironmentProvider } from '../local-tool-environment/launch-environment-provider'
import { createManagedModelBridge, createResolvedModelProfileDigest } from '../remote-agent/managed-model-bridge'
import type { TerminalSessionManager, NativeTerminalLaunch } from '../terminal/terminal-session-manager'
import type { BundledRuntimePaths } from './bundled-runtimes'
import { ContinueHostAdapter, loadContinueConfig } from './continue-host-adapter'
import { detectRuntimeBinary } from './runtime-discovery'
import { applyLaunchEnvironmentPath, buildCredentialFilteredUserEnvironment, runtimePrivacyEnvironment } from './process-environment'
import { stageRuntimeSkillPackages } from './runtime-skill-packages'

export type NativeTerminalClientInput = {
  projectId: string
  projectName: string
  directory: string
  runtime: 'continue' | 'opencode'
  workMode: 'ask' | 'execute'
  settings: ResolvedRuntimeSettings
  size?: TerminalSize
  skillPackages?: RuntimeSkillPackage[]
  /** Session-lived, Main-owned MCP endpoints, such as the existing knowledge gateway. */
  mcpServers?: Array<{ name: string; url: string; headers: Record<string, string>; readOnlyTools?: readonly string[] }>
}

export type NativeTerminalClientOptions = {
  terminalManager: Pick<TerminalSessionManager, 'create'>
  /** GoodBuddy user-data directory; native history is retained here. */
  rootDirectory: string
  bundledRuntimePaths: BundledRuntimePaths
  /** Standard Node resolved by the local tool environment, never Electron. */
  nodeExecutable?: string
  launchEnvironmentProvider?: LaunchEnvironmentProvider
  fetcher?: typeof fetch
}

// Same native read permissions as the existing remote OpenCode adapter.
const openCodeReadTools = ['read', 'glob', 'grep', 'list', 'lsp', 'webfetch', 'websearch', 'codesearch', 'question', 'external_directory']
const continueReadTools = ['Read', 'List', 'Search', 'Fetch', 'Diff', 'AskQuestion', 'CheckBackgroundJob', 'Skills']
const sharedOpenCodeConfigs = new Map<string, Promise<string>>()

/** Copies the bundled OpenCode plugin tree once instead of on every terminal launch. */
function prepareSharedOpenCodeConfig(source: string, target: string): Promise<string> {
  const existing = sharedOpenCodeConfigs.get(target)
  if (existing) return existing
  const operation = (async () => {
    const marker = '.goodbuddy-ready.json'
    const expected = await readFile(join(source, marker), 'utf8').catch(() => undefined)
    if (expected !== undefined && await readFile(join(target, marker), 'utf8').catch(() => undefined) === expected) return target
    const staging = `${target}.staging-${randomUUID()}`
    try {
      await cp(source, staging, { recursive: true })
      await rm(target, { recursive: true, force: true })
      await rename(staging, target)
    } finally {
      await rm(staging, { recursive: true, force: true })
    }
    return target
  })().catch(error => { sharedOpenCodeConfigs.delete(target); throw error })
  sharedOpenCodeConfigs.set(target, operation)
  return operation
}

export class NativeTerminalClient {
  private readonly pending = new Map<string, Promise<TerminalSnapshot>>()

  constructor(private readonly options: NativeTerminalClientOptions) {}

  open(ownerId: number, input: NativeTerminalClientInput): Promise<TerminalSnapshot> {
    const profile = input.runtime === 'continue'
      ? input.settings.continueModelProfile
      : input.settings.opencodeModelProfile
    if (!profile) return Promise.reject(new Error('Native client requires the selected text model connection'))
    const key = JSON.stringify([ownerId, input.projectId, input.runtime, input.workMode, createResolvedModelProfileDigest(profile)])
    const existing = this.pending.get(key)
    if (existing) return existing
    const operation = this.launch(ownerId, structuredClone(input)).finally(() => this.pending.delete(key))
    this.pending.set(key, operation)
    return operation
  }

  private async launch(ownerId: number, input: NativeTerminalClientInput): Promise<TerminalSnapshot> {
    const launch = await this.prepare(input)
    try {
      const snapshot = await this.options.terminalManager.create(ownerId, {
        target: { type: 'project', projectId: input.projectId },
        ...(input.size ?? { cols: 100, rows: 30 })
      }, launch)
      if (snapshot.state === 'failed') {
        await launch.dispose()
        throw new Error(snapshot.error?.message ?? 'Native terminal failed to start')
      }
      return snapshot
    } catch (error) {
      await launch.dispose()
      throw error
    }
  }

  private async prepare(input: NativeTerminalClientInput): Promise<NativeTerminalLaunch> {
    if (!(await stat(input.directory)).isDirectory()) throw new Error('Native client project directory is unavailable')
    const selected = input.runtime === 'continue' ? input.settings.continueModelProfile : input.settings.opencodeModelProfile
    if (!selected) throw new Error('Native client requires a model connection')
    const managed = createManagedModelBridge({ profile: selected })
    const detection = await detectRuntimeBinary({
      binaryPath: input.runtime === 'continue' ? input.settings.continueBinaryPath : input.settings.opencodeBinaryPath,
      bundledPath: this.options.bundledRuntimePaths[input.runtime],
      binaryNames: input.runtime === 'continue' ? ['cn'] : ['opencode'],
      label: input.runtime,
      validation: 'canonical-file'
    })
    if (!detection.path) throw new Error(detection.detail)
    const env = applyLaunchEnvironmentPath({
      ...buildCredentialFilteredUserEnvironment(), ...runtimePrivacyEnvironment
    }, this.options.launchEnvironmentProvider)
    // Do not inherit another native client's provider/config selection.
    for (const name of Object.keys(env)) {
      if (/^(OPENCODE_|CONTINUE_)/u.test(name)) delete env[name]
    }
    let executable = detection.path
    const args: string[] = []
    if (input.runtime === 'continue') {
      const node = this.options.nodeExecutable
      if (!node) throw new Error('Continue interactive terminal requires a standard Node executable from the local tool environment')
      const { stdout } = await promisify(execFile)(node, ['-p', 'JSON.stringify({node:process.versions.node,electron:process.versions.electron})'], { env, timeout: 5_000, windowsHide: true })
      const version = JSON.parse(stdout.trim()) as { node?: string; electron?: string }
      if (!version.node || version.electron) throw new Error('Continue interactive terminal requires standard Node, not Electron')
      executable = node
      args.push(detection.path)
    }
    const root = this.options.rootDirectory
    await mkdir(root, { recursive: true })
    const temporary = await mkdtemp(join(root, 'launch-'))
    const history = join(root, input.runtime, randomUUID())
    let ledger: AgentModelCallLedger | undefined
    let gateway: AgentModelGateway
    const bindingId = randomUUID()
    const proxy = new ModelBridgeLoopbackProxy({ exchange: (request, context) => gateway.dispatch({
      bindingId, operationId: context.requestId, promptSequence: 0, roundIndex: 0,
      profileDigest: managed.profile.modelProfileDigest, profile: managed.profile
    }, request, context.signal) })
    let disposal: Promise<void> | undefined
    const dispose = (): Promise<void> => disposal ??= (async () => {
      try { await proxy.close() } finally {
        ledger?.close()
        await rm(temporary, { recursive: true, force: true })
      }
    })()
    try {
      ledger = new AgentModelCallLedger(join(temporary, 'model-calls.sqlite'))
      gateway = new AgentModelGateway({ ledger, fetcher: this.options.fetcher })
      await mkdir(history, { recursive: true })
      const origin = await proxy.listen()
      const skills = input.skillPackages ?? []
      const mcp = input.mcpServers ?? []
      const allowedContinueTools = [...continueReadTools, ...mcp.flatMap(server => server.readOnlyTools ?? [])]
      const allowedOpenCodeTools = [...openCodeReadTools, 'skill', ...mcp.flatMap(server => (server.readOnlyTools ?? []).map(name => `${server.name}_${name}`))]
      if (input.runtime === 'continue') {
        // Reuse the pinned adapter's protocol, permission-order and Windows fixes.
        const adapter = new ContinueHostAdapter({ binaryPath: detection.path,
          configPath: '', workspace: input.directory, cacheRoot: temporary, mode: 'chat' })
        const prepared = await adapter.getPreparedHost()
        const bundlePath = join(dirname(prepared.entryPath), 'index.js')
        const bundle = await readFile(bundlePath, 'utf8')
        const executionMarker = 'async function hti(e,t={parallelToolCallCount:1}){'
        if (bundle.split(executionMarker).length !== 2) throw new Error('Continue native tool execution entry point is incompatible')
        await writeFile(bundlePath, bundle.replace(executionMarker, `${executionMarker}if(${JSON.stringify(input.workMode)}==="ask"&&!${JSON.stringify(allowedContinueTools)}.includes(e.name))throw new Error("GoodBuddy Ask mode is read-only");`))
        args[0] = prepared.entryPath
        const configured = input.settings.continueConfigPath.trim()
          ? await loadContinueConfig(input.settings.continueConfigPath.trim()) : {}
        const configPath = join(temporary, 'continue.json')
        await writeFile(configPath, JSON.stringify({
          name: 'GoodBuddy Native Client', version: '1.0.0', schema: 'v1',
          models: [{ name: selected.name, model: selected.modelName,
            provider: selected.protocol === 'anthropic-messages' ? 'anthropic' : 'openai',
            apiBase: `${origin}/v1`, apiKey: MODEL_BRIDGE_SDK_AUTH_SENTINEL,
            roles: ['chat'], capabilities: selected.supportsImageInput ? ['image_input'] : [],
            ...(selected.protocol !== 'anthropic-messages' ? { useResponsesApi: selected.protocol === 'openai-responses' } : {})
          }],
          ...(configured.rules ? { rules: configured.rules } : {}),
          ...(configured.prompts ? { prompts: configured.prompts } : {}),
          mcpServers: mcp.map(server => ({ name: server.name, type: 'streamable-http', url: server.url, requestOptions: { headers: server.headers } }))
        }), { mode: 0o600 })
        await stageRuntimeSkillPackages(history, skills, 'Continue')
        Object.assign(env, { CONTINUE_GLOBAL_DIR: history, GOODBUDDY_DISABLE_CONTINUE_UPDATES: '1', CONTINUE_CLI_AUTO_UPDATED: '1', CONTINUE_CLI_ENABLE_TELEMETRY: '0', CONTINUE_METRICS_ENABLED: '0', CONTINUE_CLI_DISABLE_COMMIT_SIGNATURE: '1' })
        args.push('--config', configPath)
        if (input.workMode === 'execute') args.push('--auto')
        else args.push('--readonly', ...allowedContinueTools.flatMap(name => ['--allow', name]), '--exclude', '*')
      } else {
        const bundledConfig = this.options.bundledRuntimePaths.opencodeConfig
        const configDirectory = bundledConfig
          ? await prepareSharedOpenCodeConfig(bundledConfig, join(root, 'opencode-config'))
          : join(temporary, 'config')
        await mkdir(configDirectory, { recursive: true })
        const skillsRoot = await stageRuntimeSkillPackages(join(temporary, 'opencode'), skills, 'OpenCode')
        const config = createOpenCodeModelBridgeProviderConfig({
          protocol: managed.profile.protocol, model: selected.modelName, name: selected.name,
          loopbackOrigin: origin, supportsImageInput: selected.supportsImageInput, workMode: input.workMode
        })
        const permission = input.workMode === 'execute' ? 'allow' : Object.fromEntries([
          ['*', 'deny'], ...allowedOpenCodeTools.map(name => [name, 'allow'])
        ])
        // A tool hook keeps the launch mode fixed even when the TUI changes agents.
        const pluginPath = join(temporary, 'work-mode.mjs')
        await writeFile(pluginPath, `export default async () => ({'tool.execute.before': async ({tool}) => { if (${JSON.stringify(input.workMode)} === 'ask' && !${JSON.stringify(allowedOpenCodeTools)}.includes(tool)) throw new Error('GoodBuddy Ask mode is read-only'); }});`, { mode: 0o600 })
        Object.assign(env, {
          OPENCODE_CONFIG_DIR: configDirectory,
          OPENCODE_CONFIG_CONTENT: JSON.stringify({ ...config, permission,
            agent: { ...config.agent, build: { permission }, plan: { permission } },
            plugin: [pathToFileURL(pluginPath).href], skills: { paths: [skillsRoot] },
            mcp: Object.fromEntries(mcp.map(server => [server.name, { type: 'remote', url: server.url, headers: server.headers, enabled: true }]))
          }),
          OPENCODE_DISABLE_AUTOUPDATE: '1', OPENCODE_DISABLE_PROJECT_CONFIG: '1',
          OPENCODE_DISABLE_CLAUDE_CODE_SKILLS: '1', OPENCODE_DISABLE_EXTERNAL_SKILLS: '1',
          OPENCODE_DISABLE_MODELS_FETCH: '1', OPENCODE_DISABLE_LSP_DOWNLOAD: '1', OPENCODE_DISABLE_SHARE: '1',
          XDG_CONFIG_HOME: join(temporary, 'xdg-config'), XDG_CACHE_HOME: join(root, 'cache'),
          XDG_DATA_HOME: join(history, 'data'), XDG_STATE_HOME: join(history, 'state')
        })
        args.push('--model', config.model)
      }
      return { spawnSpec: { executable, args, cwd: input.directory, env, label: input.runtime }, title: `${input.runtime} · ${input.projectName}`, dispose }
    } catch (error) {
      await dispose()
      throw error
    }
  }
}

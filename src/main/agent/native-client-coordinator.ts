import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { normalizeInteractiveWorkMode } from '../../shared/assistant-contracts'
import type { RuntimeNativeClientResult } from '../../shared/runtime-native-client-contracts'
import type { AssistantDatabase } from '../assistant/assistant-database'
import type { ApplicationSettingsStore } from '../application-settings-store'
import type { CapabilityService } from '../capabilities/capability-service'
import type { ExecutionSpaceResolver } from '../execution-space/execution-space-resolver'
import type { LocalToolEnvironmentService } from '../local-tool-environment/local-tool-environment-service'
import type { RuntimeSettingsStore } from '../runtime-settings-store'
import type { TerminalSessionManager } from '../terminal/terminal-session-manager'
import type { BundledRuntimePaths } from './bundled-runtimes'
import type { KnowledgeMcpGateway } from './knowledge-mcp-gateway'
import { NativeDshWebClientService } from './native-dsh-web-client'
import { NativeTerminalClient } from './native-terminal-client'
import { applyRuntimeSelection, resolveLayeredRuntimeSelection } from './runtime-selection'

type Options = {
  database: AssistantDatabase
  settingsStore: RuntimeSettingsStore
  applicationSettingsStore: ApplicationSettingsStore
  capabilities: CapabilityService
  executionSpaceResolver: ExecutionSpaceResolver
  terminalManager: TerminalSessionManager
  localEnvironment: LocalToolEnvironmentService
  bundledRuntimePaths: BundledRuntimePaths
  rootDirectory: string
  managedNodeDirectory: string
  npmCliPath: string
  resourcesPath?: string
  createGateway: () => KnowledgeMcpGateway
  openExternal: (url: string) => Promise<void>
}

export class NativeClientCoordinator {
  private readonly browser: NativeDshWebClientService
  private readonly services = new Map<string, { ownerId: number; id: string; dispose: () => Promise<void> }>()
  private readonly pending = new Map<string, Promise<RuntimeNativeClientResult>>()
  private readonly closedOwners = new Set<number>()
  private nodePreparation?: Promise<string>
  private readonly controller = new AbortController()

  constructor(private readonly options: Options) {
    this.browser = new NativeDshWebClientService({
      rootDirectory: join(options.rootDirectory, 'dsh'),
      resourcesPath: options.resourcesPath,
      resolveLaunchEnvironment: async () => ({
        nodeExecutablePath: await this.prepareNode(),
        environment: options.localEnvironment.launchEnvironmentProvider()
      })
    })
  }

  private async prepareNode(): Promise<string> {
    const selection = (await this.options.applicationSettingsStore.get()).localToolEnvironment.node
    if (selection.source === 'custom') return selection.executablePath
    this.nodePreparation ??= (async () => {
      const directory = this.options.managedNodeDirectory
      const packageName = `node-${process.platform === 'win32' ? 'win' : process.platform}-${process.arch}`
      const executable = join(directory, 'node_modules', packageName, 'bin', process.platform === 'win32' ? 'node.exe' : 'node')
      if (!(await stat(executable).catch(() => undefined))?.isFile()) {
        await mkdir(directory, { recursive: true })
        await promisify(execFile)(process.execPath, [this.options.npmCliPath, 'install', '--prefix', directory,
          '--no-save', '--no-package-lock', '--ignore-scripts', '--no-audit', '--no-fund', '--prefer-offline', `${packageName}@22.22.0`], {
          env: { ...this.options.localEnvironment.launchEnvironmentProvider(), ELECTRON_RUN_AS_NODE: '1' },
          cwd: directory, windowsHide: true, timeout: 180_000, signal: this.controller.signal, maxBuffer: 1024 * 1024
        })
      }
      const { stdout } = await promisify(execFile)(executable, ['-p', 'JSON.stringify({node:process.versions.node,electron:process.versions.electron})'], {
        env: { ...this.options.localEnvironment.launchEnvironmentProvider() },
        windowsHide: true, timeout: 5_000, signal: this.controller.signal
      })
      const runtime = JSON.parse(stdout.trim()) as { node?: string; electron?: string }
      if (runtime.node !== '22.22.0' || runtime.electron) throw new Error('Native clients require managed standard Node 22.22.0')
      return executable
    })().catch(error => { this.nodePreparation = undefined; throw error })
    return this.nodePreparation
  }

  private async resolve(conversationId: string) {
    const conversation = this.options.database.getConversation(conversationId)
    if (!conversation.projectId) throw new Error('Native clients require a saved project conversation')
    const project = this.options.database.getProject(conversation.projectId)
    const settings = await this.options.settingsStore.getResolvedSettings()
    const selected = applyRuntimeSelection(settings, resolveLayeredRuntimeSelection(
      settings,
      { project: project.runtimeSelection, conversation: conversation.runtimeSelection },
      { remote: project.executionSpace?.kind === 'ssh' }
    ).selection)
    const space = this.options.executionSpaceResolver.resolveProject(project)
    const workMode = normalizeInteractiveWorkMode(conversation.workMode ?? project.defaultWorkMode)
    const [skills, mcpServers, builtin, application, obsidian] = await Promise.all([
      this.options.capabilities.getRuntimeSkillContext(selected.target),
      this.options.capabilities.getResolvedMcpServers(selected.target),
      this.options.capabilities.getEnabledBuiltinMcpServerIds(selected.target),
      this.options.applicationSettingsStore.get(),
      this.options.capabilities.getObsidianSettings()
    ])
    const key = createHash('sha256').update(JSON.stringify({ projectId: project.id, space: space.cacheIdentity,
      target: selected.target, profile: selected.target === 'deepseek-harness' ? selected.settings.deepseekHarnessModelProfile
        : selected.target === 'continue' ? selected.settings.continueModelProfile : selected.settings.opencodeModelProfile,
      workMode, skills, mcpServers, builtin,
      libraries: conversation.knowledgeLibraryIds, magicNotes: application.magicNotesEnabled, supervisor: application.heartbeatEnabled, obsidian,
      node: application.localToolEnvironment.node,
      binary: selected.target === 'continue' ? selected.settings.continueBinaryPath
        : selected.target === 'opencode' ? selected.settings.opencodeBinaryPath : undefined,
      config: selected.target === 'continue' ? selected.settings.continueConfigPath : undefined })).digest('hex')
    return { conversation, project, selected, space, workMode, skills, mcpServers, builtin, application, obsidian, key }
  }

  async get(ownerId: number, conversationId: string): Promise<{ serviceId: string } | null> {
    const context = await this.resolve(conversationId)
    const entry = this.services.get(`${ownerId}:${context.key}`)
    if (!entry) return null
    if (await this.browser.get(entry.id)) return { serviceId: entry.id }
    await entry.dispose()
    this.services.delete(`${ownerId}:${context.key}`)
    return null
  }

  async open(ownerId: number, conversationId: string): Promise<RuntimeNativeClientResult> {
    this.assertOwner(ownerId)
    const context = await this.resolve(conversationId)
    this.assertOwner(ownerId)
    const key = `${ownerId}:${context.key}`
    const pending = this.pending.get(key)
    if (pending) return pending
    const operation = this.launch(ownerId, key, context).finally(() => this.pending.delete(key))
    this.pending.set(key, operation)
    return operation
  }

  private assertOwner(ownerId: number): void {
    this.controller.signal.throwIfAborted()
    if (this.closedOwners.has(ownerId)) throw new Error('Native client window is closed')
  }

  private async launch(ownerId: number, key: string, context: Awaited<ReturnType<NativeClientCoordinator['resolve']>>): Promise<RuntimeNativeClientResult> {
    const { project, selected, space, workMode, skills, mcpServers, builtin, application, conversation, obsidian } = context
    if (selected.target === 'model') throw new Error('This runtime has no native client')
    if (space.kind !== 'local') throw new Error('Native client requires a local execution space')
    const existing = this.services.get(key)
    if (existing) {
      const handle = await this.browser.get(existing.id)
      if (handle) {
        this.assertOwner(ownerId)
        await this.options.openExternal(handle.url)
        return { kind: 'browser', serviceId: handle.id }
      }
      await existing.dispose()
      this.services.delete(key)
    }
    const gateway = this.options.createGateway()
    const controller = new AbortController()
    const signal = AbortSignal.any([controller.signal, this.controller.signal])
    const dispose = async (): Promise<void> => { controller.abort(); await gateway.dispose() }
    try {
      await gateway.start()
      const requestId = randomUUID()
      const access = workMode === 'execute' ? 'write' : 'read'
      const token = gateway.grant(requestId, builtin.includes('knowledge-base') ? conversation.knowledgeLibraryIds ?? [] : [], signal,
        builtin.includes('magic-notes') && application.magicNotesEnabled ? access : 'none',
        builtin.includes('goodbuddy-config') ? { access, workspacePath: space.rootPath } : undefined,
        undefined, undefined, undefined, builtin.includes('obsidian') ? { settings: obsidian, access } : undefined,
        builtin.includes('story-graph') && application.heartbeatEnabled ? { projectId: project.id, runtimeTarget: selected.target } : undefined)
      const customToken = workMode === 'execute' ? gateway.grantCustomMcp(requestId, mcpServers, signal) : undefined
      const endpoints = [token, customToken].flatMap((value, index) => value ? [{ name: `goodbuddy-${index}`, url: gateway.getEndpoint()!, headers: { Authorization: `Bearer ${value}` },
        readOnlyTools: index === 0 && workMode === 'ask' ? gateway.getAvailableToolNames(value) : [] }] : [])
      if (selected.target === 'deepseek-harness') {
        const profile = selected.settings.deepseekHarnessModelProfile
        if (!profile) throw new Error('DS Web requires a text model connection')
        const readOnlyTools = token && workMode === 'ask' ? gateway.getAvailableToolNames(token) : []
        const handle = await this.browser.start({ projectId: project.id, ownerId, configurationKey: context.key, workspace: space.rootPath, profile, workMode,
          skillDirectories: skills.packages.map(skill => skill.directory),
          mcpServers: endpoints.map(endpoint => ({ serverName: endpoint.name, transport: 'streamable-http', url: endpoint.url, headers: endpoint.headers,
            readOnlyTools: endpoint.name === 'goodbuddy-0' ? readOnlyTools : [] })) })
        this.services.set(key, { ownerId, id: handle.id, dispose })
        this.assertOwner(ownerId)
        await this.options.openExternal(handle.url)
        return { kind: 'browser', serviceId: handle.id }
      }
      const nodeExecutable = selected.target === 'continue' ? await this.prepareNode() : undefined
      this.assertOwner(ownerId)
      const terminal = await new NativeTerminalClient({
        rootDirectory: join(this.options.rootDirectory, 'terminal'), bundledRuntimePaths: this.options.bundledRuntimePaths,
        nodeExecutable, launchEnvironmentProvider: this.options.localEnvironment.launchEnvironmentProvider,
        terminalManager: { create: async (owner, input, launch) => {
          if (!launch) throw new Error('Native terminal launch is missing')
          return this.options.terminalManager.create(owner, input, { ...launch, dispose: async () => {
            try { await launch.dispose() } finally { await dispose() }
          } })
        } }
      }).open(ownerId, { projectId: project.id, projectName: project.name, directory: space.rootPath,
        runtime: selected.target, settings: selected.settings, workMode, skillPackages: skills.packages, mcpServers: endpoints })
      if (this.closedOwners.has(ownerId) || this.controller.signal.aborted) {
        await this.options.terminalManager.closeOwner(ownerId)
        throw new Error('Native client window is closed')
      }
      return { kind: 'terminal', terminal }
    } catch (error) {
      // Once ready, the service owns its gateway even if the OS browser cannot open.
      if (!this.services.has(key)) await dispose()
      throw error
    }
  }

  async stop(ownerId: number, serviceId: string): Promise<void> {
    for (const [key, entry] of this.services) {
      if (entry.id !== serviceId || entry.ownerId !== ownerId) continue
      await this.browser.stop(entry.id)
      await entry.dispose()
      this.services.delete(key)
    }
  }

  async closeOwner(ownerId: number): Promise<void> {
    this.closedOwners.add(ownerId)
    await Promise.allSettled([...this.pending.entries()].filter(([key]) => key.startsWith(`${ownerId}:`)).map(([, operation]) => operation))
    await Promise.all([...this.services.values()].filter(entry => entry.ownerId === ownerId).map(entry => this.stop(ownerId, entry.id)))
    await this.options.terminalManager.closeOwner(ownerId)
  }

  async dispose(): Promise<void> {
    this.controller.abort()
    await this.browser.dispose()
    await Promise.allSettled(this.pending.values())
    await Promise.all([...this.services.values()].map(entry => entry.dispose()))
    this.services.clear()
  }
}

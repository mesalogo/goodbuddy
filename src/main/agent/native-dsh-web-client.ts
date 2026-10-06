import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, realpath, stat, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { AgentModelGateway, type ModelCallLedger, type ModelCallLedgerFactory } from '../../agent-daemon/agent-model-gateway'
import { MODEL_BRIDGE_SDK_AUTH_SENTINEL, ModelBridgeLoopbackProxy } from '../../agent-daemon/model-bridge-helper'
import { canonicalJson } from '../../shared/agent-protocol/canonical'
import type { ResolvedModelProfile } from '../runtime-settings-store'
import { createManagedModelBridge } from '../remote-agent/managed-model-bridge'
import { terminateProcessTreeAndWait } from './child-process-termination'
import { buildCredentialFilteredUserEnvironment, runtimePrivacyEnvironment } from './process-environment'
import { nativeDshWebPatch, type NativeDshMcpServer } from './native-dsh-web-policy'
import { createRuntimeTemporaryDirectory, recordRuntimeTemporaryChild, removeRuntimeTemporaryDirectory } from '../runtime-temporary-directory'

export type { NativeDshMcpServer } from './native-dsh-web-policy'

export type NativeDshWebRequest = {
  projectId: string
  ownerId?: number
  /** Includes the coordinator's current capability digests and launch settings. */
  configurationKey?: string
  workspace: string
  profile: ResolvedModelProfile
  /** Directories containing SKILL.md, or roots containing skill bundles. */
  skillDirectories?: string[]
  /** Already resolved by Main; GoodBuddy-only tools need a caller-owned MCP adapter. */
  mcpServers?: NativeDshMcpServer[]
}

export type NativeDshWebHandle = { id: string; url: string }
export type NativeDshWebClientOptions = {
  openModelCallLedger: ModelCallLedgerFactory
  rootDirectory: string
  /** Application version/run launch root; DSH_HOME remains persistent. */
  temporaryRoot?: string
  resolveLaunchEnvironment: () => Promise<{
    nodeExecutablePath: string
    environment: Readonly<NodeJS.ProcessEnv>
  }>
  /** Packaged: process.resourcesPath. Omit in development. */
  resourcesPath?: string
  cliPath?: string
  startupTimeoutMs?: number
  /** Existing gateway supports injecting fetch for focused protocol tests. */
  fetcher?: typeof fetch
}

type Instance = {
  id: string
  controller: AbortController
  ready: Promise<NativeDshWebHandle>
  child?: ChildProcess
  proxy?: ModelBridgeLoopbackProxy
  ledger?: ModelCallLedger
  ledgerOpening?: boolean
  cleanup?: Promise<void>
  home: string
  temporary?: string
}

export function resolveNativeDshCli(resourcesPath?: string): string {
  return resourcesPath
    ? join(resourcesPath, 'runtimes', 'dsh', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
    : join(dirname(createRequire(import.meta.url).resolve('@deepseek-ai/dsh/package.json')), 'lib', 'bin.js')
}

export class NativeDshWebClientService {
  private readonly instances = new Map<string, Instance>()
  private disposed = false

  constructor(private readonly options: NativeDshWebClientOptions) {}

  async start(input: NativeDshWebRequest): Promise<NativeDshWebHandle> {
    if (this.disposed) throw new Error('DS Web service is disposed')
    const request = structuredClone(input)
    request.workspace = await realpath(request.workspace)
    if (!(await stat(request.workspace)).isDirectory()) throw new Error('DS Web workspace is not a directory')
    if (this.disposed) throw new Error('DS Web service is disposed')
    // Include credentials in the in-memory match hash so credential rotation starts
    // a fresh bridge. Only the digest is used as a directory name.
    const key = createHash('sha256').update(canonicalJson(JSON.parse(JSON.stringify(request)))).digest('hex')
    const existing = this.instances.get(key)
    if (existing) {
      if (existing.controller.signal.aborted || (existing.child &&
        (existing.child.exitCode !== null || existing.child.signalCode !== null))) {
        await existing.ready.catch(() => undefined)
        await this.cleanup(existing)
        return this.start(request)
      }
      return existing.ready
    }
    const instance: Instance = {
      id: key, controller: new AbortController(),
      home: join(this.options.rootDirectory, key),
      ready: Promise.resolve({ id: key, url: '' })
    }
    this.instances.set(key, instance)
    instance.ready = this.launch(instance, request).catch(async error => {
      await this.cleanup(instance)
      throw error
    })
    return instance.ready
  }

  async stop(id: string): Promise<void> {
    const instance = this.instances.get(id)
    if (!instance) return
    instance.controller.abort(new Error('DS Web service stopped'))
    await instance.ready.catch(() => undefined)
    await this.cleanup(instance)
  }

  async get(id: string): Promise<NativeDshWebHandle | null> {
    const instance = this.instances.get(id)
    if (!instance || instance.controller.signal.aborted) return null
    const handle = await instance.ready.catch(() => null)
    return instance.controller.signal.aborted || (instance.child &&
      (instance.child.exitCode !== null || instance.child.signalCode !== null)) ? null : handle
  }

  async dispose(): Promise<void> {
    this.disposed = true
    await Promise.all([...this.instances.keys()].map(id => this.stop(id)))
  }

  private async cleanup(instance: Instance): Promise<void> {
    instance.cleanup ??= (async () => {
      instance.controller.abort(new Error('DS Web service stopped'))
      if (instance.child && instance.child.signalCode === null) {
        await terminateProcessTreeAndWait(instance.child, { processGroup: process.platform !== 'win32' })
      }
      if (instance.child?.pid && instance.child.exitCode === null && instance.child.signalCode === null) {
        throw new Error('DS Web child exit is unconfirmed')
      }
      await instance.proxy?.close()
      await instance.ledger?.close()
      // Native history and profile settings are persistent; only launch material is disposable.
      // A lost open reply must not cause deletion beneath the host's connection.
      if (instance.temporary && (!instance.ledgerOpening || instance.ledger)) {
        await removeRuntimeTemporaryDirectory(instance.temporary)
      }
      if (this.instances.get(instance.id) === instance) this.instances.delete(instance.id)
    })()
    return instance.cleanup
  }

  private async launch(instance: Instance, request: NativeDshWebRequest): Promise<NativeDshWebHandle> {
    const signal = AbortSignal.any([instance.controller.signal, AbortSignal.timeout(this.options.startupTimeoutMs ?? 60_000)])
    const launch = await this.options.resolveLaunchEnvironment()
    signal.throwIfAborted()
    if (!launch.nodeExecutablePath) throw new Error('DS Web requires a standard Node executable from the local tool environment')
    const environment = buildCredentialFilteredUserEnvironment({ ...launch.environment })
    const { stdout } = await promisify(execFile)(launch.nodeExecutablePath,
      ['-p', 'JSON.stringify({node:process.versions.node,electron:process.versions.electron})'],
      { env: { ...environment, ELECTRON_RUN_AS_NODE: '1' }, signal, timeout: 5_000, windowsHide: true })
    const runtime = JSON.parse(stdout.trim()) as { node?: string; electron?: string }
    if (!runtime.node || runtime.electron) throw new Error('DS Web requires standard Node, not Electron')
    const cli = this.options.cliPath ?? resolveNativeDshCli(this.options.resourcesPath)
    await stat(cli)
    await mkdir(instance.home, { recursive: true, mode: 0o700 })
    instance.temporary = await createRuntimeTemporaryDirectory(
      this.options.temporaryRoot ?? join(this.options.rootDirectory, 'goodbuddy-runtime-launch'), 'goodbuddy-native-dsh-')
    const managed = createManagedModelBridge({ profile: request.profile })
    instance.ledgerOpening = true
    instance.ledger = await this.options.openModelCallLedger(join(instance.temporary, 'bridge.sqlite'))
    const gateway = new AgentModelGateway({ ledger: instance.ledger, fetcher: this.options.fetcher })
    const operationId = randomUUID()
    let roundIndex = 0
    instance.proxy = new ModelBridgeLoopbackProxy({ exchange: (message, context) => gateway.dispatch({
      bindingId: instance.id, operationId, promptSequence: 0, roundIndex: roundIndex++,
      profileDigest: managed.profile.modelProfileDigest, profile: managed.profile
    }, message, context.signal) })
    const origin = await instance.proxy.listen()
    const mcpServers = request.mcpServers ?? []
    const patch = nativeDshWebPatch({
      model: request.profile.modelName,
      api: request.profile.protocol === 'anthropic-messages' ? 'anthropic-messages'
        : request.profile.protocol === 'openai-responses' ? 'openai-responses' : 'openai-completions',
      baseURL: `${origin}/v1`,
      skillDirectories: request.skillDirectories ?? [], mcpServers
    })
    const patchPath = join(instance.temporary, 'cordis.patch.yml')
    await writeFile(patchPath, JSON.stringify(patch), { mode: 0o600 })
    signal.throwIfAborted()
    for (const name of Object.keys(environment)) if (name.startsWith('DSH_')) delete environment[name]
    instance.child = spawn(launch.nodeExecutablePath, [cli, 'web', '--patch', patchPath, '--no-open', '--host', '127.0.0.1', '--port', '0'], {
      cwd: request.workspace, shell: false, windowsHide: true,
      detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...environment, ...runtimePrivacyEnvironment, DSH_HOME: instance.home, DSH_TELEMETRY_DISABLED: '1',
        DSH_PERMISSION_MODE: 'danger-full-access', GOODBUDDY_DSH_MODEL_KEY: MODEL_BRIDGE_SDK_AUTH_SENTINEL }
    })
    const child = instance.child
    const ready = new Promise<string>((resolve, reject) => {
      let output = ''
      const finish = (error?: Error, address?: string): void => {
        signal.removeEventListener('abort', onAbort)
        child.removeListener('error', onError)
        child.removeListener('exit', onExit)
        child.stdout?.removeListener('data', onData)
        child.stderr?.removeListener('data', onData)
        if (error) reject(error)
        else resolve(address!)
      }
      const onAbort = (): void => finish(new Error('DS Web startup cancelled or timed out', { cause: signal.reason }))
      const onError = (error: Error): void => finish(new Error(`DS Web process could not start: ${error.message}`))
      const onExit = (code: number | null): void => finish(new Error(`DS Web exited during startup (${code})`))
      const onData = (chunk: Buffer): void => {
        output = (output + chunk.toString()).slice(-32_768)
        // Wait for the full line; stdout can split in the middle of the token.
        // eslint-disable-next-line no-control-regex
        const match = output.match(/http:\/\/127\.0\.0\.1:\d+[^\s\x1b]*(?=[\s\x1b])/u)
        if (match) finish(undefined, match[0])
      }
      child.once('error', onError)
      child.once('exit', onExit)
      child.stdout?.on('data', onData)
      child.stderr?.on('data', onData)
      signal.addEventListener('abort', onAbort, { once: true })
      if (signal.aborted) onAbort()
    })
    // Attach startup listeners before the asynchronous PID write.
    const [startup, ownership] = await Promise.allSettled([ready, recordRuntimeTemporaryChild(instance.temporary, child.pid)])
    if (ownership.status === 'rejected') throw ownership.reason
    if (startup.status === 'rejected') throw startup.reason
    const url = startup.value
    // Drain subsequent logs without retaining token-bearing output.
    child.stdout?.resume()
    child.stderr?.resume()
    child.once('exit', () => {
      // stop/dispose observes the retained cleanup failure and leaves files intact.
      void this.cleanup(instance).catch(() => undefined)
    })
    const auth = await fetch(url, { redirect: 'manual', signal })
    if (auth.status !== 303) throw new Error(`DS Web authentication failed (HTTP ${auth.status})`)
    const cookie = auth.headers.getSetCookie().map(value => value.split(';')[0]).join('; ')
    const response = await fetch(new URL('/api/workspace/create', url), {
      method: 'POST', signal,
      headers: { 'content-type': 'application/json', cookie, origin: new URL(url).origin },
      body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method: 'workspace/create',
        payload: { args: { request: { path: request.workspace } } } })
    })
    if (!response.ok) throw new Error(`DS Web workspace creation failed (HTTP ${response.status})`)
    const result = await response.json() as { result?: { ok?: boolean } }
    if (result.result?.ok !== true) throw new Error('DS Web workspace creation was rejected')
    signal.throwIfAborted()
    if (child.exitCode !== null || child.signalCode !== null) throw new Error('DS Web exited during workspace initialization')
    return { id: instance.id, url }
  }
}

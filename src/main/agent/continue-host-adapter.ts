import spawn from 'cross-spawn'
import { createHash, randomBytes } from 'node:crypto'
import {
  copyFile,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile
} from 'node:fs/promises'
import {
  basename,
  dirname,
  isAbsolute,
  join,
  resolve
} from 'node:path'
import { z } from 'zod'
import type { RuntimeSettings } from '../../shared/contracts'
import type { RuntimeAuthorizer } from './runtime'
import type { ResolvedModelProfile } from '../runtime-settings-store'
import { getAvailableLoopbackPort } from './loopback-port'
import {
  buildRuntimeEnvironment,
  runtimePrivacyEnvironment
} from './process-environment'
import { createAnthropicApiBaseUrl } from './anthropic-endpoint'
import { createOpenAIApiBaseUrl } from './openai-endpoint'
import {
  redactSensitiveText
} from './approval-summary'

const supportedVersion = '1.5.47'
const supportedBundleHashes = new Set([
  '500cf1ae9637ba397fcb5ae0856fdd31b9ad49ba45a32e277477452be196e5d6'
])
const maximumBundleBytes = 32 * 1024 * 1024
const maximumStateBytes = 8 * 1024 * 1024
export const continueConfigurationRequiredMessage =
  'Continue 尚未配置模型连接，请在设置中选择 GoodBuddy 模型连接或指定 Continue 配置文件'
const utilityBootstrap = [
  "import { pathToFileURL } from 'node:url'",
  'const entryPath = process.argv[2]',
  "if (!entryPath) throw new Error('Missing Continue host entry')",
  'process.argv = process.argv.slice(2)',
  'await import(pathToFileURL(entryPath).href)',
  ''
].join('\n')

const tokenCountSchema = z
  .number()
  .int()
  .min(0)
  .max(Number.MAX_SAFE_INTEGER)

const sessionUsageSchema = z.object({
  promptTokens: tokenCountSchema,
  completionTokens: tokenCountSchema,
  promptTokensDetails: z
    .object({
      cachedTokens: tokenCountSchema.optional(),
      cacheWriteTokens: tokenCountSchema.optional()
    })
    .optional()
})

const stateSchema = z.object({
  session: z.object({
    history: z.array(z.unknown()).max(5_000),
    usage: sessionUsageSchema.optional()
  }),
  isProcessing: z.boolean(),
  messageQueueLength: z.number().int().min(0),
  pendingPermission: z
    .object({
      toolName: z.string().min(1).max(128),
      toolArgs: z.record(z.string(), z.unknown()),
      requestId: z.string().min(1).max(256),
      toolCallPreview: z.array(z.unknown()).max(100).optional()
    })
    .nullable()
})

type ContinueHostState = z.infer<typeof stateSchema>

type PreparedHost = {
  entryPath: string
  version: string
}

export type ContinueHostUsage = {
  provider: string
  model: string
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
}

export type ContinueHostTool = {
  callId: string
  name: string
  state: 'pending' | 'running' | 'completed' | 'failed'
}

export type ContinueHostRunResult = {
  text: string
  usage?: ContinueHostUsage
  tools?: ContinueHostTool[]
}

export class ContinueHostRunError extends Error {
  constructor(
    message: string,
    options: { cause: unknown; tools: ContinueHostTool[] }
  ) {
    super(message, { cause: options.cause })
    this.name = 'ContinueHostRunError'
    this.tools = options.tools
  }

  readonly tools: ContinueHostTool[]
}

export type ContinueHostAdapterOptions = {
  binaryPath: string
  configPath: string
  workspace: string
  cacheRoot: string
  mode?: RuntimeSettings['continueMode']
  trustedBundleHashes?: string[]
  launchHost?: ContinueHostLauncher
  modelProfile?: ResolvedModelProfile
}

export function hasContinueModelConfiguration(
  configPath: string,
  modelProfile?: ResolvedModelProfile
): boolean {
  return Boolean(modelProfile || configPath.trim())
}

export type ContinueHostChild = {
  exitCode: number | null
  killed: boolean
  pid?: number
  stderr?: {
    on: (
      event: 'data',
      listener: (chunk: Buffer | string) => void
    ) => unknown
  } | null
  once: (
    event: 'error',
    listener: (error: Error) => void
  ) => unknown
  kill: (signal?: NodeJS.Signals) => unknown
}

export type ContinueHostLauncher = (
  entryPath: string,
  args: string[],
  options: {
    cwd: string
    env: NodeJS.ProcessEnv
  }
) => ContinueHostChild

function hashContents(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}

function replaceExactly(
  source: string,
  marker: string,
  replacement: string
): string {
  const first = source.indexOf(marker)
  if (first < 0 || source.indexOf(marker, first + marker.length) >= 0) {
    throw new Error('Continue CLI 版本与宿主适配层不兼容')
  }
  return `${source.slice(0, first)}${replacement}${source.slice(
    first + marker.length
  )}`
}

async function isFile(filePath: string): Promise<boolean> {
  try {
    return (await stat(filePath)).isFile()
  } catch {
    return false
  }
}

async function resolveDistribution(binaryPath: string): Promise<string> {
  const canonical = await realpath(binaryPath).catch(() => binaryPath)
  const candidates = [
    basename(canonical).toLowerCase() === 'cn.js'
      ? dirname(canonical)
      : '',
    join(dirname(canonical), 'node_modules', '@continuedev', 'cli', 'dist'),
    join(dirname(binaryPath), 'node_modules', '@continuedev', 'cli', 'dist')
  ].filter(Boolean)
  for (const candidate of candidates) {
    if (
      (await isFile(join(candidate, 'cn.js'))) &&
      (await isFile(join(candidate, 'index.js')))
    ) {
      return candidate
    }
  }
  throw new Error(
    '当前 Continue 二进制不包含可适配的宿主模块，请使用 npm 安装的 Continue CLI 1.5.47'
  )
}

function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolveDelay, reject) => {
    const finish = (): void => {
      signal.removeEventListener('abort', abort)
      resolveDelay()
    }
    const timeout = setTimeout(finish, milliseconds)
    const abort = (): void => {
      clearTimeout(timeout)
      signal.removeEventListener('abort', abort)
      reject(signal.reason)
    }
    signal.addEventListener('abort', abort, { once: true })
  })
}

function extractAssistantText(
  history: unknown[],
  startIndex: number
): string {
  for (const item of history.slice(startIndex).reverse()) {
    if (!item || typeof item !== 'object') {
      continue
    }
    const message = (item as Record<string, unknown>).message
    if (!message || typeof message !== 'object') {
      continue
    }
    const record = message as Record<string, unknown>
    if (
      record.role === 'assistant' &&
      typeof record.content === 'string' &&
      record.content.trim()
    ) {
      return record.content.trim()
    }
  }
  return ''
}

function parseContinueFailure(text: string): string | undefined {
  const match = /^Error:\s*(\{[\s\S]{1,16384}\})$/u.exec(text.trim())
  if (!match?.[1]) {
    return undefined
  }
  try {
    const payload = JSON.parse(match[1]) as unknown
    if (!payload || typeof payload !== 'object') {
      return undefined
    }
    const record = payload as Record<string, unknown>
    const error = record.error
    const message =
      typeof error === 'string'
        ? error
        : error && typeof error === 'object'
          ? (error as Record<string, unknown>).message
          : record.message
    const detail =
      typeof message === 'string' && message.trim()
        ? `：${redactSensitiveText(message.trim()).slice(0, 500)}`
        : ''
    return `Continue 模型请求失败${detail}`
  } catch {
    return undefined
  }
}

function extractContinueFailure(
  history: unknown[],
  startIndex: number
): string | undefined {
  for (const item of history.slice(startIndex).reverse()) {
    if (!item || typeof item !== 'object') {
      continue
    }
    const message = (item as Record<string, unknown>).message
    if (!message || typeof message !== 'object') {
      continue
    }
    const content = (message as Record<string, unknown>).content
    if (typeof content !== 'string') {
      continue
    }
    const failure = parseContinueFailure(content)
    if (failure) {
      return failure
    }
  }
  return undefined
}

function extractContinueTools(
  history: unknown[],
  startIndex: number
): ContinueHostTool[] {
  const tools = new Map<string, ContinueHostTool>()
  for (const item of history.slice(startIndex)) {
    if (!item || typeof item !== 'object') {
      continue
    }
    const states = (item as Record<string, unknown>).toolCallStates
    if (!Array.isArray(states)) {
      continue
    }
    for (const value of states) {
      if (!value || typeof value !== 'object') {
        continue
      }
      const state = value as Record<string, unknown>
      const toolCall = state.toolCall
      const toolFunction =
        toolCall && typeof toolCall === 'object'
          ? (toolCall as Record<string, unknown>).function
          : undefined
      const callId =
        typeof state.toolCallId === 'string'
          ? state.toolCallId.slice(0, 256)
          : ''
      const name =
        toolFunction && typeof toolFunction === 'object'
          ? (toolFunction as Record<string, unknown>).name
          : undefined
      if (!callId || typeof name !== 'string' || !name.trim()) {
        continue
      }
      if (!tools.has(callId) && tools.size >= 100) {
        throw new Error('Continue 单次运行的工具调用超过 100 个')
      }
      const status = state.status
      const normalizedState =
        status === 'done' || status === 'completed'
          ? 'completed'
          : status === 'calling' || status === 'running'
            ? 'running'
            : status === 'generated' || status === 'pending'
              ? 'pending'
              : 'failed'
      tools.set(callId, {
        callId,
        name: name.trim().slice(0, 200),
        state: normalizedState
      })
    }
  }
  return [...tools.values()]
}

function subtractTokenCount(completed: number, initial: number): number {
  return Math.max(0, completed - initial)
}

function extractUsageDelta(
  initial: ContinueHostState['session']['usage'],
  completed: ContinueHostState['session']['usage'],
  fallbackProvider: string,
  fallbackModel?: string
): ContinueHostUsage | undefined {
  if (!initial || !completed) {
    return undefined
  }
  return {
    provider: fallbackProvider,
    model: fallbackModel ?? 'unknown',
    inputTokens: subtractTokenCount(
      completed.promptTokens,
      initial.promptTokens
    ),
    outputTokens: subtractTokenCount(
      completed.completionTokens,
      initial.completionTokens
    ),
    cacheReadTokens: subtractTokenCount(
      completed.promptTokensDetails?.cachedTokens ?? 0,
      initial.promptTokensDetails?.cachedTokens ?? 0
    ),
    cacheWriteTokens: subtractTokenCount(
      completed.promptTokensDetails?.cacheWriteTokens ?? 0,
      initial.promptTokensDetails?.cacheWriteTokens ?? 0
    )
  }
}

export class ContinueHostAdapter {
  private readonly children = new Set<ContinueHostChild>()
  private preparation?: Promise<PreparedHost>

  constructor(private readonly options: ContinueHostAdapterOptions) {}

  private async prepare(): Promise<PreparedHost> {
    if (!isAbsolute(this.options.cacheRoot)) {
      throw new Error('Continue 宿主缓存目录必须是绝对路径')
    }
    const distribution = await resolveDistribution(this.options.binaryPath)
    const packagePath = resolve(distribution, '..', 'package.json')
    const packageValue = JSON.parse(await readFile(packagePath, 'utf8')) as {
      version?: unknown
    }
    if (packageValue.version !== supportedVersion) {
      throw new Error(
        `Continue 宿主适配层仅支持 ${supportedVersion}，当前版本为 ${
          typeof packageValue.version === 'string'
            ? packageValue.version
            : 'unknown'
        }`
      )
    }

    const sourceBundlePath = join(distribution, 'index.js')
    const sourceBundle = await readFile(sourceBundlePath, 'utf8')
    if (Buffer.byteLength(sourceBundle) > maximumBundleBytes) {
      throw new Error('Continue CLI bundle 超过安全大小限制')
    }
    const sourceHash = hashContents(sourceBundle)
    const trustedHashes = new Set(
      this.options.trustedBundleHashes ?? supportedBundleHashes
    )
    if (!trustedHashes.has(sourceHash)) {
      throw new Error('Continue CLI bundle 未通过宿主兼容性校验')
    }

    const serveInitializationMarker =
      'toolPermissionOverrides:s,headless:!0});let[a,u,l,c]'
    const permissionOptionsMarker =
      'i={allow:o.allow,ask:o.ask,exclude:o.exclude,isHeadless:e.headless}'
    const permissionInitializeMarker =
      'E6t.initialize({isHeadless:e.headless},r,n)'
    const serverMarker =
      'let j=(0,atn.default)();j.use(atn.default.json()),j.get("/state"'
    const listenMarker =
      'listen(i,async()=>{console.log(Ht.green(`Server started on http://localhost:${i}`))'
    const versionCheckMarker =
      'async function SCt(e){return n5e||'
    let patched = replaceExactly(
      sourceBundle,
      serveInitializationMarker,
      'toolPermissionOverrides:s,headless:!0,interactivePermissions:!0});let[a,u,l,c]'
    )
    patched = replaceExactly(
      patched,
      permissionOptionsMarker,
      'i={allow:o.allow,ask:o.ask,exclude:o.exclude,isHeadless:e.interactivePermissions?!1:e.headless}'
    )
    patched = replaceExactly(
      patched,
      permissionInitializeMarker,
      'E6t.initialize({isHeadless:e.interactivePermissions?!1:e.headless},r,n)'
    )
    patched = replaceExactly(
      patched,
      serverMarker,
      'let j=(0,atn.default)();if(!process.env.GOODBUDDY_CONTINUE_HOST_TOKEN)throw new Error("Missing GoodBuddy host token");j.use((we,Te,ue)=>{we.headers.authorization===`Bearer ${process.env.GOODBUDDY_CONTINUE_HOST_TOKEN}`?ue():Te.status(401).json({error:"Unauthorized"})}),j.use(atn.default.json({limit:"1mb"})),j.get("/state"'
    )
    patched = replaceExactly(
      patched,
      listenMarker,
      'listen(i,"127.0.0.1",async()=>{console.log(Ht.green(`Server started on http://localhost:${i}`))'
    )
    patched = replaceExactly(
      patched,
      versionCheckMarker,
      'async function SCt(e){if(process.env.GOODBUDDY_DISABLE_CONTINUE_UPDATES==="1")return null;return n5e||'
    )
    const patchedHash = hashContents(patched)
    const digest = sourceHash.slice(0, 16)
    const targetRoot = join(
      this.options.cacheRoot,
      `host-v2-${supportedVersion}-${digest}`
    )
    const targetDist = join(targetRoot, 'dist')
    const targetBundle = join(targetDist, 'index.js')
    const readyMarker = join(targetRoot, '.ready')
    if (
      (await isFile(readyMarker)) &&
      (await isFile(join(targetDist, 'cn.js'))) &&
      (await isFile(join(targetDist, 'utility-bootstrap.mjs'))) &&
      (await isFile(targetBundle)) &&
      hashContents(await readFile(targetBundle)) === patchedHash
    ) {
      return {
        entryPath: join(targetDist, 'cn.js'),
        version: supportedVersion
      }
    }
    await rm(targetRoot, { recursive: true, force: true })

    const stagingRoot = `${targetRoot}.staging-${crypto.randomUUID()}`
    const stagingDist = join(stagingRoot, 'dist')
    try {
      await mkdir(stagingDist, { recursive: true })
      await Promise.all([
        writeFile(join(stagingDist, 'index.js'), patched, 'utf8'),
        copyFile(join(distribution, 'cn.js'), join(stagingDist, 'cn.js')),
        copyFile(
          join(distribution, 'xhr-sync-worker.js'),
          join(stagingDist, 'xhr-sync-worker.js')
        ),
        writeFile(
          join(stagingDist, 'utility-bootstrap.mjs'),
          utilityBootstrap,
          'utf8'
        ),
        copyFile(packagePath, join(stagingRoot, 'package.json'))
      ])
      await writeFile(
        join(stagingRoot, '.ready'),
        JSON.stringify({ sourceHash, patchedHash }),
        'utf8'
      )
      await mkdir(this.options.cacheRoot, { recursive: true })
      await rename(stagingRoot, targetRoot).catch(async (error) => {
        if (
          !(await isFile(targetBundle)) ||
          hashContents(await readFile(targetBundle)) !== patchedHash
        ) {
          throw error
        }
      })
    } finally {
      await rm(stagingRoot, { recursive: true, force: true })
    }
    return {
      entryPath: join(targetDist, 'cn.js'),
      version: supportedVersion
    }
  }

  getPreparedHost(): Promise<PreparedHost> {
    this.preparation ??= this.prepare().catch((error) => {
      this.preparation = undefined
      throw error
    })
    return this.preparation
  }

  private async request(
    origin: string,
    token: string,
    path: string,
    init: RequestInit = {}
  ): Promise<unknown> {
    const response = await fetch(`${origin}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        ...init.headers
      },
      redirect: 'error',
      signal: init.signal
    })
    const contentLength = Number(response.headers.get('content-length') ?? 0)
    if (contentLength > maximumStateBytes) {
      throw new Error('Continue 宿主响应超过安全大小限制')
    }
    const body = await response.text()
    if (Buffer.byteLength(body) > maximumStateBytes) {
      throw new Error('Continue 宿主响应超过安全大小限制')
    }
    if (!response.ok) {
      throw new Error(`Continue 宿主请求失败（HTTP ${response.status}）`)
    }
    return body ? JSON.parse(body) : undefined
  }

  private async waitForStartup(
    child: ContinueHostChild,
    getChildFailure: () => Error | undefined,
    origin: string,
    token: string,
    signal: AbortSignal
  ): Promise<ContinueHostState> {
    const expiresAt = Date.now() + 30_000
    while (Date.now() < expiresAt) {
      signal.throwIfAborted()
      const childFailure = getChildFailure()
      if (childFailure) {
        throw childFailure
      }
      if (child.exitCode !== null) {
        throw new Error('Continue 宿主在启动期间退出')
      }
      try {
        return stateSchema.parse(
          await this.request(origin, token, '/state', { signal })
        )
      } catch {
        await delay(150, signal)
      }
    }
    throw new Error('Continue 宿主启动超时')
  }

  async run(
    prompt: string,
    signal: AbortSignal,
    authorize: RuntimeAuthorizer
  ): Promise<ContinueHostRunResult> {
    signal.throwIfAborted()
    if (
      !hasContinueModelConfiguration(
        this.options.configPath,
        this.options.modelProfile
      )
    ) {
      throw new Error(continueConfigurationRequiredMessage)
    }
    let generatedConfigPath: string | undefined
    if (this.options.modelProfile) {
      if (
        this.options.modelProfile.authentication === 'api-key' &&
        !this.options.modelProfile.apiKey
      ) {
        throw new Error('Continue 独立模型连接尚未配置 API Key')
      }
      const anthropic =
        this.options.modelProfile.protocol === 'anthropic-messages'
      const modelConfig: Record<string, unknown> = {
        name: this.options.modelProfile.name,
        provider: anthropic ? 'anthropic' : 'openai',
        model: this.options.modelProfile.modelName,
        apiBase: anthropic
          ? createAnthropicApiBaseUrl(this.options.modelProfile.baseUrl)
          : createOpenAIApiBaseUrl(this.options.modelProfile.baseUrl),
        roles: ['chat']
      }
      if (this.options.modelProfile.authentication === 'api-key') {
        modelConfig.apiKey = anthropic
          ? '${{ secrets.ANTHROPIC_API_KEY }}'
          : '${{ secrets.OPENAI_API_KEY }}'
      }
      await mkdir(this.options.cacheRoot, { recursive: true })
      generatedConfigPath = join(
        this.options.cacheRoot,
        `model-config-${crypto.randomUUID()}.yaml`
      )
      await writeFile(
        generatedConfigPath,
        JSON.stringify({
          name: 'GoodBuddy Runtime',
          version: '1.0.0',
          schema: 'v1',
          models: [modelConfig]
        }),
        { encoding: 'utf8', mode: 0o600, flag: 'wx' }
      )
    }
    const [{ entryPath }, port] = await Promise.all([
      this.getPreparedHost(),
      getAvailableLoopbackPort()
    ]).catch(async (error) => {
      if (generatedConfigPath) {
        await rm(generatedConfigPath, { force: true })
      }
      throw error
    })
    const token = randomBytes(32).toString('base64url')
    const origin = `http://127.0.0.1:${port}`
    const isolatedGlobalDirectory = join(
      this.options.cacheRoot,
      'isolated-global'
    )
    await mkdir(isolatedGlobalDirectory, { recursive: true, mode: 0o700 })
    const args: string[] = []
    const configPath =
      generatedConfigPath ?? this.options.configPath.trim()
    if (configPath) {
      args.push('--config', configPath)
    }
    if (this.options.mode === 'chat') {
      args.push('--readonly')
    }
    args.push('serve', '--port', String(port), '--timeout', '300')
    const environment = buildRuntimeEnvironment({
      ...runtimePrivacyEnvironment,
      CONTINUE_CLI_DISABLE_COMMIT_SIGNATURE: '1',
      CONTINUE_CLI_AUTO_UPDATED: '1',
      CONTINUE_CLI_ENABLE_TELEMETRY: '0',
      CONTINUE_METRICS_ENABLED: '0',
      CONTINUE_GLOBAL_DIR: isolatedGlobalDirectory,
      FORCE_NO_TTY: '1',
      GOODBUDDY_CONTINUE_HOST_TOKEN: token,
      GOODBUDDY_DISABLE_CONTINUE_UPDATES: '1'
    })
    if (this.options.modelProfile) {
      delete environment.ANTHROPIC_API_KEY
      delete environment.OPENAI_API_KEY
    }
    if (
      this.options.modelProfile?.authentication === 'api-key' &&
      this.options.modelProfile.apiKey
    ) {
      environment[
        this.options.modelProfile.protocol === 'anthropic-messages'
          ? 'ANTHROPIC_API_KEY'
          : 'OPENAI_API_KEY'
      ] = this.options.modelProfile.apiKey
    }
    signal.throwIfAborted()
    let child: ContinueHostChild
    try {
      child = (
        this.options.launchHost ??
        ((hostEntryPath, hostArgs, hostOptions) =>
          spawn(
            process.platform === 'win32' ? 'node.exe' : 'node',
            [hostEntryPath, ...hostArgs],
            {
              ...hostOptions,
              shell: false,
              stdio: ['ignore', 'ignore', 'pipe'],
              windowsHide: true
            }
          ))
      )(entryPath, args, {
        cwd: this.options.workspace,
        env: environment
      })
    } catch (error) {
      if (generatedConfigPath) {
        await rm(generatedConfigPath, { force: true })
      }
      throw error
    }
    this.children.add(child)
    let childFailure: Error | undefined
    child.once('error', (error) => {
      childFailure = new Error('Continue 宿主进程启动失败', {
        cause: error
      })
    })
    let stderrBytes = 0
    child.stderr?.on('data', (chunk: Buffer | string) => {
      stderrBytes += Buffer.byteLength(chunk)
      if (stderrBytes > 64 * 1024) {
        this.terminate(child)
      }
    })
    const abort = (): void => {
      this.terminate(child)
    }
    signal.addEventListener('abort', abort, { once: true })

    let observedTools: ContinueHostTool[] = []
    try {
      const initialState = await this.waitForStartup(
        child,
        () => childFailure,
        origin,
        token,
        signal
      )
      const startIndex = initialState.session.history.length
      await this.request(origin, token, '/message', {
        method: 'POST',
        body: JSON.stringify({ message: prompt }),
        signal
      })

      const expiresAt = Date.now() + 10 * 60_000
      const handledPermissionIds = new Set<string>()
      while (Date.now() < expiresAt) {
        signal.throwIfAborted()
        if (childFailure) {
          throw childFailure
        }
        if (child.exitCode !== null) {
          throw new Error(
            `Continue 宿主意外退出（code ${child.exitCode}）`
          )
        }
        const state = stateSchema.parse(
          await this.request(origin, token, '/state', { signal })
        )
        observedTools = extractContinueTools(
          state.session.history,
          startIndex
        )
        const pending = state.pendingPermission
        if (pending && !handledPermissionIds.has(pending.requestId)) {
          if (handledPermissionIds.size >= 100) {
            throw new Error('Continue 单次运行的工具调用超过 100 个')
          }
          handledPermissionIds.add(pending.requestId)
          const pendingCallId =
            observedTools.find(
              (tool) =>
                tool.name === pending.toolName &&
                tool.state !== 'completed' &&
                tool.state !== 'failed'
            )?.callId ?? pending.requestId.slice(0, 256)
          if (
            !observedTools.some((tool) => tool.callId === pendingCallId)
          ) {
            if (observedTools.length >= 100) {
              throw new Error('Continue 单次运行的工具调用超过 100 个')
            }
            observedTools = [
              ...observedTools,
              {
                callId: pendingCallId,
                name: pending.toolName,
                state: 'pending'
              }
            ]
          }
          const decision = await authorize({
            scopeKey: `continue:${pending.toolName}`,
            title: `Continue 请求调用 ${pending.toolName}`,
            description: 'Continue Runtime 工具调用由 GoodBuddy 自动放行。',
            toolName: pending.toolName,
            allowPermanent: false
          })
          await this.request(origin, token, '/permission', {
            method: 'POST',
            body: JSON.stringify({
              requestId: pending.requestId,
              approved: decision !== 'deny'
            }),
            signal
          })
        }
        if (
          !state.isProcessing &&
          state.messageQueueLength === 0 &&
          !state.pendingPermission &&
          state.session.history.length > startIndex
        ) {
          const failure = extractContinueFailure(
            state.session.history,
            startIndex
          )
          if (failure) {
            throw new Error(failure)
          }
          const text = extractAssistantText(
            state.session.history,
            startIndex
          )
          if (!text) {
            throw new Error('Continue 宿主未返回最终回复')
          }
          const usage = extractUsageDelta(
            initialState.session.usage,
            state.session.usage,
            this.options.modelProfile
              ? this.options.modelProfile.protocol ===
                'anthropic-messages'
                ? 'anthropic'
                : 'openai'
              : 'continue',
            this.options.modelProfile?.modelName
          )
          return {
            text,
            ...(usage ? { usage } : {}),
            ...(observedTools.length > 0
              ? { tools: observedTools }
              : {})
          }
        }
        await delay(150, signal)
      }
      throw new Error('Continue 宿主执行超时')
    } catch (error) {
      if (error instanceof ContinueHostRunError) {
        throw error
      }
      throw new ContinueHostRunError(
        error instanceof Error ? error.message : 'Continue 宿主执行失败',
        { cause: error, tools: observedTools }
      )
    } finally {
      signal.removeEventListener('abort', abort)
      try {
        const cleanupSignal = AbortSignal.timeout(1_000)
        if (signal.aborted) {
          await this.request(origin, token, '/pause', {
            method: 'POST',
            signal: cleanupSignal
          }).catch(() => undefined)
        }
        await this.request(origin, token, '/exit', {
          method: 'POST',
          signal: cleanupSignal
        }).catch(() => undefined)
      } finally {
        this.terminate(child)
        this.children.delete(child)
        if (generatedConfigPath) {
          await rm(generatedConfigPath, { force: true })
        }
      }
    }
  }

  private terminate(child: ContinueHostChild): void {
    if (child.exitCode !== null || child.killed) {
      return
    }
    if (process.platform === 'win32' && child.pid) {
      const killer = spawn(
        'taskkill.exe',
        ['/PID', String(child.pid), '/T', '/F'],
        {
          shell: false,
          stdio: 'ignore',
          windowsHide: true
        }
      )
      killer.unref()
    } else {
      child.kill('SIGTERM')
    }
  }

  dispose(): void {
    for (const child of this.children) {
      this.terminate(child)
    }
    this.children.clear()
  }
}

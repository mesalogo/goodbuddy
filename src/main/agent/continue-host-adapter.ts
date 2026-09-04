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
  extname,
  isAbsolute,
  join,
  resolve
} from 'node:path'
import json5 from 'json5'
import { parse as parseYaml } from 'yaml'
import { z } from 'zod'
import type {
  AgentQuestionAnswer,
  RuntimeNativeSnapshot,
  RuntimeSettings
} from '../../shared/contracts'
import {
  continueConfigurationPresetSchema,
  runtimeNativeInventoryLimits,
  type ContinueConfigurationPreset
} from '../../shared/runtime-customization-contracts'
import type { AgentImage, RuntimeAuthorizer } from './runtime'
import type { ResolvedModelProfile } from '../runtime-settings-store'
import type { RuntimeSkillPackage } from '../capabilities/capability-service'
import { getAvailableLoopbackPort } from './loopback-port'
import {
  applyLaunchEnvironmentPath,
  buildExplicitProfileRuntimeEnvironment,
  buildRuntimeEnvironment,
  runtimePrivacyEnvironment
} from './process-environment'
import type { LaunchEnvironmentProvider } from '../local-tool-environment/launch-environment-provider'
import { createAnthropicApiBaseUrl } from './anthropic-endpoint'
import { createOpenAIApiBaseUrl } from './openai-endpoint'
import {
  boundedToolDetail,
  safeToolErrorDetail
} from './approval-summary'
import { stageRuntimeSkillPackages } from './runtime-skill-packages'
import { readBoundedResponseText } from './bounded-response'
import { scopedReadToolNames } from '../../shared/scoped-data-tools'
import { readBoundedFile } from '../workspace-file-access'
import { terminateProcessTreeAndWait } from './child-process-termination'

const supportedVersion = '1.5.47'
const supportedBundleHashes = new Set([
  '500cf1ae9637ba397fcb5ae0856fdd31b9ad49ba45a32e277477452be196e5d6'
])
const maximumBundleBytes = 32 * 1024 * 1024
const maximumStateBytes = 8 * 1024 * 1024
const maximumMessageBytes = 20 * 1024 * 1024
const maximumConfigBytes = 1024 * 1024
const maximumConfiguredMcpServers =
  runtimeNativeInventoryLimits.mcpServers
const maximumConfiguredRules = runtimeNativeInventoryLimits.rules
const maximumConfiguredPrompts = runtimeNativeInventoryLimits.prompts
const maximumStreamEventBytes = 2 * 1024 * 1024
const defaultControlRequestTimeoutMs = 30_000
const knowledgeMcpName = 'goodbuddy-knowledge'
const customMcpName = 'goodbuddy-custom-mcp'
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

const continueHostStreamEventSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('text'),
      delta: z.string().min(1).max(100_000)
    })
    .strict(),
  z
    .object({
      type: z.literal('tool'),
      callId: z.string().min(1).max(256),
      name: z.string().min(1).max(200),
      state: z.enum(['running', 'completed', 'failed']),
      input: z.string().max(4_000).optional(),
      output: z.string().max(16_000).optional(),
      error: z.string().max(1_000).optional()
    })
    .strict()
])

const continueHostQuestionSchema = z
  .object({
    requestId: z.string().min(1).max(128),
    timestamp: z.number().finite().optional(),
    question: z
      .object({
        question: z.string().trim().min(1).max(2_000),
        options: z
          .array(z.string().trim().min(1).max(200))
          .max(20)
          .optional(),
        defaultAnswer: z.string().trim().max(2_000).optional()
      })
      .passthrough()
  })
  .strict()

const stateSchema = z.object({
  session: z.object({
    history: z.array(z.unknown()),
    usage: sessionUsageSchema.optional()
  }),
  isProcessing: z.boolean(),
  messageQueueLength: z.number().int().min(0),
  pendingPermission: z
    .object({
      toolName: z.string().min(1).max(128),
      toolArgs: z.record(z.string(), z.unknown()),
      requestId: z.string().min(1).max(256),
      toolCallPreview: z.array(z.unknown()).optional()
    })
    .nullable(),
  goodbuddyEvents: z
    .array(continueHostStreamEventSchema)
    .optional(),
  goodbuddyEventsOverflow: z.boolean().optional(),
  goodbuddyQuestion: continueHostQuestionSchema.nullable().optional()
})

type ContinueHostState = z.infer<typeof stateSchema>

function isRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value)
  )
}

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
  input?: string
  output?: string
  error?: string
}

export type ContinueHostRunResult = {
  text: string
  streamedText?: true
  streamTruncated?: true
  usage?: ContinueHostUsage
  tools?: ContinueHostTool[]
}

export type ContinueHostStreamEvent =
  | { type: 'text'; delta: string }
  | { type: 'tool'; tool: ContinueHostTool }
  | {
      type: 'question'
      questionId: string
      questions: Array<{
        header: string
        question: string
        options: Array<{
          label: string
          description: string
        }>
        multiple: boolean
        custom: boolean
      }>
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
  skillPackages?: RuntimeSkillPackage[]
  launchEnvironmentProvider?: LaunchEnvironmentProvider
}

export type ContinueHostAdapterDependencies = {
  terminateProcessTree: typeof terminateProcessTreeAndWait
  maximumStreamEventBytes: number
  controlRequestTimeoutMs: number
}

export type ContinueHostRunOptions = {
  workMode?: 'ask' | 'execute'
  images?: AgentImage[]
  knowledgeCapability?: {
    endpoint: string
    token: string
  }
  customMcpCapability?: {
    endpoint: string
    token: string
  }
  preset?: ContinueConfigurationPreset
  onEvent?: (event: ContinueHostStreamEvent) => void | Promise<void>
}

type KnowledgeCapability = NonNullable<
  ContinueHostRunOptions['knowledgeCapability']
>

function createLoopbackMcpServer(
  name: string,
  capability: KnowledgeCapability
): Record<string, unknown> {
  return {
    name,
    type: 'streamable-http',
    url: capability.endpoint,
    requestOptions: {
      headers: {
        Authorization: `Bearer ${capability.token}`
      }
    }
  }
}

export async function loadContinueConfig(
  configPath: string
): Promise<Record<string, unknown>> {
  const tooLargeMessage =
    'Continue 配置文件超过 1 MB 安全大小限制'
  const invalidFileMessage = 'Continue 配置路径不是文件'
  const data = await readBoundedFile(
    configPath,
    maximumConfigBytes,
    tooLargeMessage,
    invalidFileMessage
  ).catch((error: unknown) => {
    if (
      error instanceof Error &&
      (error.message === tooLargeMessage ||
        error.message === invalidFileMessage)
    ) {
      throw error
    }
    throw new Error('Continue 配置文件无法读取', { cause: error })
  })
  const source = data.toString('utf8')

  let parsed: unknown
  try {
    const extension = extname(configPath).toLowerCase()
    parsed =
      extension === '.json' || extension === '.jsonc'
        ? json5.parse(source)
        : parseYaml(source, { maxAliasCount: 100 })
  } catch (error) {
    throw new Error(
      'Continue 配置文件无法解析，无法安全注入知识库工具',
      { cause: error }
    )
  }
  if (!isRecord(parsed)) {
    throw new Error('Continue 配置文件必须包含配置对象')
  }
  return parsed
}

function boundedText(
  value: unknown,
  maximum: number
): string | undefined {
  if (typeof value !== 'string') {
    return undefined
  }
  const normalized = value.trim()
  if (
    !normalized ||
    normalized.length > maximum ||
    [...normalized].some((character) => {
      const code = character.charCodeAt(0)
      return code <= 31 && code !== 9 && code !== 10 && code !== 13
    })
  ) {
    return undefined
  }
  return normalized
}

function configuredRules(config: Record<string, unknown>): unknown[] {
  if (config.rules === undefined) {
    return []
  }
  if (
    !Array.isArray(config.rules) ||
    config.rules.length > maximumConfiguredRules
  ) {
    throw new Error(
      `Continue 配置文件中的 Rules 不能超过 ${maximumConfiguredRules} 个`
    )
  }
  return config.rules
}

function configuredPrompts(config: Record<string, unknown>): unknown[] {
  if (config.prompts === undefined) {
    return []
  }
  if (
    !Array.isArray(config.prompts) ||
    config.prompts.length > maximumConfiguredPrompts
  ) {
    throw new Error(
      `Continue 配置文件中的 Prompts 不能超过 ${maximumConfiguredPrompts} 个`
    )
  }
  return config.prompts
}

function presetConfig(
  preset: ContinueConfigurationPreset | undefined
): {
  rules: Array<Record<string, unknown>>
  prompts: Array<Record<string, unknown>>
} {
  if (!preset) {
    return { rules: [], prompts: [] }
  }
  const validPreset = continueConfigurationPresetSchema.parse(preset)
  return {
    rules: validPreset.rules
      .filter((rule) => rule.enabled)
      .map((rule) => ({
        name: rule.name,
        rule: rule.content
      })),
    prompts: validPreset.prompts.map((prompt) => ({
      name: prompt.name,
      ...(prompt.description
        ? { description: prompt.description }
        : {}),
      prompt: prompt.prompt
    }))
  }
}

export async function inspectContinueNativeConfiguration(options: {
  configPath: string
  workspace: string
}): Promise<
  Pick<
    RuntimeNativeSnapshot,
    'mcpServers' | 'rules' | 'prompts'
  > & { detail: string }
> {
  const config = options.configPath.trim()
    ? await loadContinueConfig(options.configPath.trim())
    : {}
  const prompts: RuntimeNativeSnapshot['prompts'] = []
  const rules: RuntimeNativeSnapshot['rules'] = []
  for (const [index, value] of configuredRules(config).entries()) {
    if (!isRecord(value)) {
      continue
    }
    const prompt = boundedText(value.rule ?? value.content, 20_000)
    const name =
      boundedText(value.name, 200) ?? `Rule ${index + 1}`
    if (prompt) {
      rules.push({
        id: `configuration-rule-${index + 1}`,
        name,
        content: prompt,
        source: 'configuration'
      })
    }
  }
  for (const [index, value] of configuredPrompts(config).entries()) {
    if (!isRecord(value)) {
      continue
    }
    const prompt = boundedText(value.prompt, 20_000)
    const name =
      boundedText(value.name, 200) ?? `Prompt ${index + 1}`
    const description = boundedText(value.description, 2_000)
    if (prompt) {
      prompts.push({
        id: `configuration-prompt-${index + 1}`,
        name,
        ...(description ? { description } : {}),
        prompt,
        source: 'configuration'
      })
    }
  }
  const mcpServers: RuntimeNativeSnapshot['mcpServers'] = []
  if (
    config.mcpServers !== undefined &&
    !Array.isArray(config.mcpServers)
  ) {
    throw new Error('Continue 配置文件中的 mcpServers 必须是数组')
  }
  const servers = config.mcpServers ?? []
  if (servers.length > maximumConfiguredMcpServers) {
    throw new Error(
      `Continue 配置文件中的 MCP Server 不能超过 ${maximumConfiguredMcpServers} 个`
    )
  }
  for (const [index, value] of servers.entries()) {
    if (!isRecord(value)) {
      continue
    }
    const name = boundedText(value.name, 200)
    if (
      !name ||
      name === knowledgeMcpName ||
      name === customMcpName
    ) {
      continue
    }
    mcpServers.push({
      id: `configuration-mcp-${index + 1}`,
      name,
      status: value.disabled === true ? 'disabled' : 'unknown',
      detail:
        value.disabled === true
          ? '已在 Continue 配置中停用'
          : '已配置；静态快照不会启动 MCP Server 或验证连接'
    })
  }
  return {
    mcpServers,
    rules,
    prompts: prompts.slice(0, 200),
    detail:
      'Rules 与 Prompts 来自原始静态配置；MCP Prompt 仅在 MCPService 运行并连接后可发现，非运行快照不会启动服务器。Continue MCPService 不提供 Resources。'
  }
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
    event: 'error' | 'close',
    listener: (error: Error | number | null) => void
  ) => unknown
  removeListener?: (
    event: 'error' | 'close',
    listener: (error: Error | number | null) => void
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
        ? `：${message.trim().slice(0, 500)}`
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
      const status = state.status
      const normalizedState =
        status === 'done' || status === 'completed'
          ? 'completed'
          : status === 'calling' || status === 'running'
            ? 'running'
            : status === 'generated' || status === 'pending'
              ? 'pending'
              : 'failed'
      const error =
        normalizedState === 'failed'
          ? normalizeContinueToolError(state.output)
          : undefined
      const input =
        toolFunction && typeof toolFunction === 'object'
          ? boundedToolDetail(
              (toolFunction as Record<string, unknown>).arguments,
              4_000
            )
          : undefined
      const output =
        normalizedState === 'completed'
          ? boundedToolDetail(state.output, 16_000)
          : undefined
      tools.set(callId, {
        callId,
        name: name.trim().slice(0, 200),
        state: normalizedState,
        ...(input ? { input } : {}),
        ...(output ? { output } : {}),
        ...(error ? { error } : {})
      })
    }
  }
  return [...tools.values()]
}

function mergeContinueTools(
  current: ContinueHostTool[],
  updates: ContinueHostTool[]
): ContinueHostTool[] {
  const tools = new Map(current.map((tool) => [tool.callId, tool]))
  for (const tool of updates) {
    const previous = tools.get(tool.callId)
    tools.set(tool.callId, {
      ...previous,
      ...tool,
      input: tool.input ?? previous?.input,
      output: tool.output ?? previous?.output,
      error: tool.error ?? previous?.error
    })
  }
  return [...tools.values()]
}

function normalizeContinueToolError(value: unknown): string | undefined {
  return safeToolErrorDetail(value)
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
  private readonly childTerminations = new WeakMap<
    ContinueHostChild,
    Promise<void>
  >()
  private readonly pendingQuestions = new Map<
    string,
    {
      origin: string
      token: string
      signal: AbortSignal
    }
  >()
  private preparation?: Promise<PreparedHost>

  private readonly dependencies: ContinueHostAdapterDependencies

  constructor(
    private readonly options: ContinueHostAdapterOptions,
    dependencies: Partial<ContinueHostAdapterDependencies> = {}
  ) {
    this.dependencies = {
      terminateProcessTree: terminateProcessTreeAndWait,
      maximumStreamEventBytes,
      controlRequestTimeoutMs: defaultControlRequestTimeoutMs,
      ...dependencies
    }
  }

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
    const permissionFlagOrderMarker =
      'function ZZo(e){let t=[];if(e.exclude)for(let n of e.exclude){let r=n;t.push({tool:r,permission:"exclude"})}if(e.ask)for(let n of e.ask){let r=n;t.push({tool:r,permission:"ask"})}if(e.allow)for(let n of e.allow){let r=n;t.push({tool:r,permission:"allow"})}return t}'
    const serverMarker =
      'let j=(0,atn.default)();j.use(atn.default.json()),j.get("/state"'
    const listenMarker =
      'listen(i,async()=>{console.log(Ht.green(`Server started on http://localhost:${i}`))'
    const versionCheckMarker =
      'async function SCt(e){return n5e||'
    const responseRoutingMarker =
      'shouldUseResponsesEndpoint(t){return this.config.useResponsesApi===!1?!1:this.apiBase==="https://api.openai.com/v1/"&&A0e(t)}'
    const modelConfigurationMarker =
      'function uAe(e,t){let n={provider:e.provider,model:e.model,apiKey:e.apiKey,apiBase:e.apiBase,requestOptions:e.requestOptions,env:e.env};return CGn(n)??null}'
    const messageOrderingMarker =
      'function Sin(e,t){let n=[];n.push({role:"system",content:t});let r=oot(e);return n.push(...r),n}'
    const windowsShellMarker =
      'function Csa(e){return process.platform==="win32"?{shell:"powershell.exe",args:["-NoLogo","-ExecutionPolicy","Bypass","-Command",e]}'
    const terminalOutputMarker =
      'let{shell:d,args:p}=Csa(e),f=Esa(d,p),g="",y="",A,S=!1,x=18e4;'
    const skillDirectoriesMarker =
      'let r=[eS.join(n,".continue",AKt),eS.join(n,".claude",AKt),eS.join(hu.continueHome,AKt)],o='
    const streamCallbacksMarker =
      'a={onContent:u=>{},onContentComplete:u=>{},onToolStart:(u,l)=>{},onToolResult:(u,l,c)=>{},onToolError:(u,l)=>{},onToolPermissionRequest:'
    const serverStateMarker = 'pendingPermission:null},B='
    const serverStateEndpointMarker =
      'j.get("/state",(we,Te)=>{M.lastActivity=Date.now(),B();let ue=e7e(M.session,M.isProcessing,rS.getQueueLength(),M.pendingPermission);Te.json(ue)})'
    const preprocessToolStartMarker =
      'n?.onToolStart?.(i.name,i.arguments);'
    const preprocessToolErrorMarker =
      'n?.onToolError?.(l,i.name)'
    const executeToolStartMarker =
      't?.onToolStart?.(c.name,c.arguments);'
    const cancelledToolResultMarker =
      't?.onToolResult?.(String(y.content),c.name,"canceled")'
    const completedToolResultMarker =
      't?.onToolResult?.(f,c.name,"done")'
    const failedToolResultMarker = 't?.onToolError?.(g,c.name)'
    const permissionToolErrorMarker = 't?.onToolError?.(p,c.name)'
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
      permissionFlagOrderMarker,
      'function ZZo(e){let t=[];if(e.allow)for(let n of e.allow){let r=n;t.push({tool:r,permission:"allow"})}if(e.exclude)for(let n of e.exclude){let r=n;t.push({tool:r,permission:"exclude"})}if(e.ask)for(let n of e.ask){let r=n;t.push({tool:r,permission:"ask"})}return t}'
    )
    patched = replaceExactly(
      patched,
      serverMarker,
      'let j=(0,atn.default)();if(!process.env.GOODBUDDY_CONTINUE_HOST_TOKEN)throw new Error("Missing GoodBuddy host token");j.use((we,Te,ue)=>{we.headers.authorization===`Bearer ${process.env.GOODBUDDY_CONTINUE_HOST_TOKEN}`?ue():Te.status(401).json({error:"Unauthorized"})}),j.use(atn.default.json({limit:"20mb"})),j.post("/goodbuddy/question-answer",(we,Te)=>{let{requestId:ue,answer:ce,isCustomAnswer:de}=we.body??{};typeof ue==="string"&&ue.length>0&&ue.length<=128&&typeof ce==="string"&&ce.length>0&&ce.length<=2e3?Lbe.answerQuestion(ue,ce,de===!0)?Te.json({success:!0}):Te.status(404).json({error:"Question not pending"}):Te.status(400).json({error:"Invalid question answer"})}),j.get("/state"'
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
    patched = replaceExactly(
      patched,
      responseRoutingMarker,
      'shouldUseResponsesEndpoint(t){return this.config.useResponsesApi===!0?!0:this.config.useResponsesApi===!1?!1:this.apiBase==="https://api.openai.com/v1/"&&A0e(t)}'
    )
    patched = replaceExactly(
      patched,
      modelConfigurationMarker,
      'function uAe(e,t){let n={provider:e.provider,model:e.model,apiKey:e.apiKey,apiBase:e.apiBase,requestOptions:e.requestOptions,env:e.env,useResponsesApi:e.useResponsesApi};return CGn(n)??null}'
    )
    patched = replaceExactly(
      patched,
      messageOrderingMarker,
      'function Sin(e,t){let n=[];n.push({role:"system",content:t});let r=oot(e).filter(o=>o.role!=="system");return n.push(...r),n}'
    )
    patched = replaceExactly(
      patched,
      windowsShellMarker,
      'function Csa(e){return process.platform==="win32"?{shell:"powershell.exe",args:["-NoLogo","-NoProfile","-ExecutionPolicy","Bypass","-Command",\'[Console]::InputEncoding=[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);$OutputEncoding=[Console]::OutputEncoding;\'+e]}'
    )
    patched = replaceExactly(
      patched,
      terminalOutputMarker,
      `${terminalOutputMarker}f.stdout.setEncoding("utf8"),f.stderr.setEncoding("utf8");`
    )
    patched = replaceExactly(
      patched,
      skillDirectoriesMarker,
      'let r=[eS.join(hu.continueHome,AKt)],o='
    )
    patched = replaceExactly(
      patched,
      streamCallbacksMarker,
      'a={onContent:u=>{if(!u)return;let l=String(u);e.goodbuddyEventsBytes+=Buffer.byteLength(l);l.length<=1e5&&e.goodbuddyEventsBytes<=2097152?e.goodbuddyEvents.push({type:"text",delta:l}):e.goodbuddyEventsOverflow=!0},onContentComplete:u=>{},onToolStart:(u,l,c)=>{if(!c)return;let d={type:"tool",callId:c,name:u,state:"running",input:(()=>{try{return JSON.stringify(l).slice(0,4e3)}catch{return"[无法序列化]"}})()};e.goodbuddyEventsBytes+=Buffer.byteLength(JSON.stringify(d));e.goodbuddyEventsBytes<=2097152?e.goodbuddyEvents.push(d):e.goodbuddyEventsOverflow=!0},onToolResult:(u,l,c,d)=>{if(!d)return;let p={type:"tool",callId:d,name:l,state:c==="done"?"completed":"failed",output:String(u).slice(0,16e3)};e.goodbuddyEventsBytes+=Buffer.byteLength(JSON.stringify(p));e.goodbuddyEventsBytes<=2097152?e.goodbuddyEvents.push(p):e.goodbuddyEventsOverflow=!0},onToolError:(u,l,c)=>{if(!c)return;let d={type:"tool",callId:c,name:l??"unknown",state:"failed",error:String(u).slice(0,1e3)};e.goodbuddyEventsBytes+=Buffer.byteLength(JSON.stringify(d));e.goodbuddyEventsBytes<=2097152?e.goodbuddyEvents.push(d):e.goodbuddyEventsOverflow=!0},onToolPermissionRequest:'
    )
    patched = replaceExactly(
      patched,
      serverStateMarker,
      'pendingPermission:null,goodbuddyEvents:[],goodbuddyEventsBytes:0,goodbuddyEventsOverflow:!1},B='
    )
    patched = replaceExactly(
      patched,
      serverStateEndpointMarker,
      'j.get("/state",(we,Te)=>{M.lastActivity=Date.now(),B();let ue=e7e(M.session,M.isProcessing,rS.getQueueLength(),M.pendingPermission),ce=M.goodbuddyEvents.splice(0),de=M.goodbuddyEventsOverflow;M.goodbuddyEventsBytes=0,M.goodbuddyEventsOverflow=!1;Te.json({...ue,goodbuddyEvents:ce,goodbuddyEventsOverflow:de,goodbuddyQuestion:Lbe.currentState.pendingQuestion})})'
    )
    patched = replaceExactly(
      patched,
      preprocessToolStartMarker,
      'n?.onToolStart?.(i.name,i.arguments,i.id);'
    )
    patched = replaceExactly(
      patched,
      preprocessToolErrorMarker,
      'n?.onToolError?.(l,i.name,i.id)'
    )
    patched = replaceExactly(
      patched,
      executeToolStartMarker,
      't?.onToolStart?.(c.name,c.arguments,c.id);'
    )
    patched = replaceExactly(
      patched,
      cancelledToolResultMarker,
      't?.onToolResult?.(String(y.content),c.name,"canceled",c.id)'
    )
    patched = replaceExactly(
      patched,
      completedToolResultMarker,
      't?.onToolResult?.(f,c.name,"done",c.id)'
    )
    patched = replaceExactly(
      patched,
      failedToolResultMarker,
      't?.onToolError?.(g,c.name,c.id)'
    )
    patched = replaceExactly(
      patched,
      permissionToolErrorMarker,
      't?.onToolError?.(p,c.name,c.id)'
    )
    const patchedHash = hashContents(patched)
    const digest = sourceHash.slice(0, 16)
    const targetRoot = join(
      this.options.cacheRoot,
      `host-v7-${supportedVersion}-${digest}`
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

  async respondToQuestion(
    questionId: string,
    answers?: AgentQuestionAnswer[]
  ): Promise<void> {
    const pending = this.pendingQuestions.get(questionId)
    if (!pending) {
      throw new Error('Continue 提问已失效或不存在')
    }
    let answer = 'User declined to answer this question.'
    let isCustomAnswer = true
    if (answers) {
      if (
        answers.length !== 1 ||
        answers[0]?.length !== 1 ||
        !answers[0][0]?.trim()
      ) {
        throw new Error('Continue 提问回答数量不匹配')
      }
      answer = answers[0][0].trim()
      isCustomAnswer = false
    }
    await this.request(
      pending.origin,
      pending.token,
      '/goodbuddy/question-answer',
      {
        method: 'POST',
        body: JSON.stringify({
          requestId: questionId,
          answer,
          isCustomAnswer
        }),
        signal: pending.signal
      }
    )
    this.pendingQuestions.delete(questionId)
  }

  private async request(
    origin: string,
    token: string,
    path: string,
    init: RequestInit = {}
  ): Promise<unknown> {
    const timeoutSignal = AbortSignal.timeout(
      Math.max(1, this.dependencies.controlRequestTimeoutMs)
    )
    const requestSignal = init.signal
      ? AbortSignal.any([init.signal, timeoutSignal])
      : timeoutSignal
    let response: Response
    try {
      response = await fetch(`${origin}${path}`, {
        ...init,
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          ...init.headers
        },
        redirect: 'error',
        signal: requestSignal
      })
    } catch (error) {
      if (timeoutSignal.aborted && !init.signal?.aborted) {
        throw new Error(`Continue 宿主请求超时（${path}）`, {
          cause: error
        })
      }
      throw error
    }
    const body = await readBoundedResponseText(response, {
      maxBytes: maximumStateBytes,
      tooLargeMessage: 'Continue 宿主响应超过安全大小限制'
    })
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
    const timeoutSignal = AbortSignal.timeout(30_000)
    const startupSignal = AbortSignal.any([signal, timeoutSignal])
    try {
      while (Date.now() < expiresAt) {
        startupSignal.throwIfAborted()
        const childFailure = getChildFailure()
        if (childFailure) {
          throw childFailure
        }
        if (child.exitCode !== null) {
          throw new Error('Continue 宿主在启动期间退出')
        }
        try {
          return stateSchema.parse(
            await this.request(origin, token, '/state', {
              signal: startupSignal
            })
          )
        } catch {
          await delay(150, startupSignal)
        }
      }
    } catch (error) {
      if (timeoutSignal.aborted && !signal.aborted) {
        throw new Error('Continue 宿主启动超时', { cause: error })
      }
      throw error
    }
    throw new Error('Continue 宿主启动超时')
  }

  private async writeTemporaryConfig(
    prefix: string,
    config: Record<string, unknown>
  ): Promise<string> {
    await mkdir(this.options.cacheRoot, { recursive: true })
    const configPath = join(
      this.options.cacheRoot,
      `${prefix}-${crypto.randomUUID()}.yaml`
    )
    await writeFile(configPath, JSON.stringify(config), {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx'
    })
    return configPath
  }

  private async createRunConfig(
    runOptions: ContinueHostRunOptions
  ): Promise<string | undefined> {
    const knowledgeCapability = runOptions.knowledgeCapability
    const customMcpCapability = runOptions.customMcpCapability
    if (
      customMcpCapability &&
      runOptions.workMode !== 'execute'
    ) {
      throw new Error(
        'Continue 自定义 MCP 仅允许在 Agent Execute 模式使用'
      )
    }
    const capabilityServers = [
      ...(knowledgeCapability
        ? [
            createLoopbackMcpServer(
              knowledgeMcpName,
              knowledgeCapability
            )
          ]
        : []),
      ...(customMcpCapability
        ? [
            createLoopbackMcpServer(
              customMcpName,
              customMcpCapability
            )
          ]
        : [])
    ]
    const selectedPreset = presetConfig(runOptions.preset)
    const hasPresetContent =
      selectedPreset.rules.length > 0 ||
      selectedPreset.prompts.length > 0
    if (!this.options.modelProfile) {
      if (capabilityServers.length === 0 && !hasPresetContent) {
        return undefined
      }
      const configured = await loadContinueConfig(
        this.options.configPath.trim()
      )
      const nativeRules = configuredRules(configured)
      const nativePrompts = configuredPrompts(configured)
      if (
        nativeRules.length + selectedPreset.rules.length >
        maximumConfiguredRules
      ) {
        throw new Error(
          `Continue 合并后的 Rules 不能超过 ${maximumConfiguredRules} 个`
        )
      }
      if (
        nativePrompts.length + selectedPreset.prompts.length >
        maximumConfiguredPrompts
      ) {
        throw new Error(
          `Continue 合并后的 Prompts 不能超过 ${maximumConfiguredPrompts} 个`
        )
      }
      const existingServers = configured.mcpServers
      if (
        existingServers !== undefined &&
        !Array.isArray(existingServers)
      ) {
        throw new Error(
          'Continue 配置文件中的 mcpServers 必须是数组'
        )
      }
      const servers = existingServers ?? []
      if (servers.length > maximumConfiguredMcpServers) {
        throw new Error(
          `Continue 配置文件中的 MCP Server 不能超过 ${maximumConfiguredMcpServers} 个`
        )
      }
      const retainedServers =
        runOptions.workMode === 'ask' && Boolean(knowledgeCapability)
          ? []
          : servers.filter(
              (server) =>
                !isRecord(server) ||
                (
                  server.name !== knowledgeMcpName &&
                  server.name !== customMcpName
                )
            )
      if (
        retainedServers.length + capabilityServers.length >
        maximumConfiguredMcpServers
      ) {
        throw new Error(
          `Continue 配置文件中的 MCP Server 不能超过 ${maximumConfiguredMcpServers} 个`
        )
      }
      return this.writeTemporaryConfig(
        capabilityServers.length > 0
          ? 'knowledge-config'
          : 'customization-config',
        {
          ...configured,
          ...(nativeRules.length + selectedPreset.rules.length > 0
            ? {
                rules: [...nativeRules, ...selectedPreset.rules]
              }
            : {}),
          ...(nativePrompts.length + selectedPreset.prompts.length > 0
            ? {
                prompts: [...nativePrompts, ...selectedPreset.prompts]
              }
            : {}),
          mcpServers: [
            ...retainedServers,
            ...capabilityServers
          ]
        }
      )
    }

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
      roles: ['chat'],
      capabilities: this.options.modelProfile.supportsImageInput === true
        ? ['image_input']
        : []
    }
    if (!anthropic) {
      modelConfig.useResponsesApi =
        this.options.modelProfile.protocol === 'openai-responses'
    }
    if (this.options.modelProfile.authentication === 'api-key') {
      modelConfig.apiKey = anthropic
        ? '${{ secrets.ANTHROPIC_API_KEY }}'
        : '${{ secrets.OPENAI_API_KEY }}'
    }
    const requestHeaders =
      this.options.modelProfile.requestHeaders ?? {}
    const requestBody = this.options.modelProfile.requestBody ?? {}
    if (
      Object.keys(requestHeaders).length > 0 ||
      Object.keys(requestBody).length > 0
    ) {
      modelConfig.requestOptions = {
        ...(Object.keys(requestHeaders).length > 0
          ? { headers: requestHeaders }
          : {}),
        ...(Object.keys(requestBody).length > 0
          ? { extraBodyProperties: requestBody }
          : {})
      }
    }
    const configured = this.options.configPath.trim()
      ? await loadContinueConfig(this.options.configPath.trim())
      : {}
    const nativeRules = configuredRules(configured)
    const nativePrompts = configuredPrompts(configured)
    if (
      nativeRules.length + selectedPreset.rules.length >
      maximumConfiguredRules
    ) {
      throw new Error(
        `Continue 合并后的 Rules 不能超过 ${maximumConfiguredRules} 个`
      )
    }
    if (
      nativePrompts.length + selectedPreset.prompts.length >
      maximumConfiguredPrompts
    ) {
      throw new Error(
        `Continue 合并后的 Prompts 不能超过 ${maximumConfiguredPrompts} 个`
      )
    }
    return this.writeTemporaryConfig('model-config', {
      name: 'GoodBuddy Runtime',
      version: '1.0.0',
      schema: 'v1',
      models: [modelConfig],
      ...(nativeRules.length + selectedPreset.rules.length > 0
        ? {
            rules: [...nativeRules, ...selectedPreset.rules]
          }
        : {}),
      ...(nativePrompts.length + selectedPreset.prompts.length > 0
        ? {
            prompts: [...nativePrompts, ...selectedPreset.prompts]
          }
        : {}),
      ...(capabilityServers.length > 0
        ? {
            mcpServers: capabilityServers
          }
        : {})
    })
  }

  private async createRunGlobalDirectory(): Promise<string> {
    const root = join(
      this.options.cacheRoot,
      `isolated-global-${crypto.randomUUID()}`
    )
    await mkdir(root, { recursive: false, mode: 0o700 })
    const skillPackages = this.options.skillPackages ?? []
    if (skillPackages.length === 0) {
      return root
    }
    await stageRuntimeSkillPackages(root, skillPackages, 'Continue')
    return root
  }

  async run(
    prompt: string,
    signal: AbortSignal,
    authorize: RuntimeAuthorizer,
    runOptions: ContinueHostRunOptions = {}
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
    let isolatedGlobalDirectory: string | undefined
    try {
      generatedConfigPath = await this.createRunConfig(runOptions)
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
    isolatedGlobalDirectory = await this.createRunGlobalDirectory()
    const args: string[] = []
    const configPath =
      generatedConfigPath ?? this.options.configPath.trim()
    if (configPath) {
      args.push('--config', configPath)
    }
    if (
      runOptions.workMode === 'ask' &&
      runOptions.knowledgeCapability
    ) {
      for (const toolName of scopedReadToolNames) {
        args.push('--allow', toolName)
      }
      args.push('--exclude', '*')
    } else if (runOptions.workMode === 'execute') {
      args.push('--auto')
    } else if (this.options.mode === 'chat') {
      args.push('--readonly')
    }
    args.push('serve', '--port', String(port), '--timeout', '300')
    const environmentOverrides = {
      ...runtimePrivacyEnvironment,
      CONTINUE_CLI_DISABLE_COMMIT_SIGNATURE: '1',
      CONTINUE_CLI_AUTO_UPDATED: '1',
      CONTINUE_CLI_ENABLE_TELEMETRY: '0',
      CONTINUE_METRICS_ENABLED: '0',
      CONTINUE_GLOBAL_DIR: isolatedGlobalDirectory,
      ...(process.platform === 'win32'
        ? {
            PYTHONIOENCODING: 'utf-8',
            PYTHONUTF8: '1'
          }
        : {}),
      FORCE_NO_TTY: '1',
      GOODBUDDY_CONTINUE_HOST_TOKEN: token,
      GOODBUDDY_DISABLE_CONTINUE_UPDATES: '1'
    }
    const profile = this.options.modelProfile
    let environment = profile
      ? buildExplicitProfileRuntimeEnvironment(
          environmentOverrides,
          profile.authentication === 'api-key' && profile.apiKey
            ? {
                name:
                  profile.protocol === 'anthropic-messages'
                    ? 'ANTHROPIC_API_KEY'
                    : 'OPENAI_API_KEY',
                value: profile.apiKey
              }
            : undefined
        )
      : buildRuntimeEnvironment(environmentOverrides)
    environment = applyLaunchEnvironmentPath(
      environment,
      this.options.launchEnvironmentProvider
    )
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
      await rm(isolatedGlobalDirectory, {
        recursive: true,
        force: true
      })
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
        void this.terminate(child)
      }
    })
    const abort = (): void => {
      void this.terminate(child)
    }
    signal.addEventListener('abort', abort, { once: true })

    let observedTools: ContinueHostTool[] = []
    const reportedQuestionIds = new Set<string>()
    let streamedText = false
    let streamTruncated = false
    let streamEventBytes = 0
    const observedToolCallIds = new Set<string>()
    try {
      const initialState = await this.waitForStartup(
        child,
        () => childFailure,
        origin,
        token,
        signal
      )
      const startIndex = initialState.session.history.length
      const executionSignal = signal
      const message =
        runOptions.images && runOptions.images.length > 0
          ? [
              { type: 'text', text: prompt },
              ...runOptions.images.map((image) => ({
                type: 'imageUrl',
                imageUrl: {
                  url: `data:${image.mediaType};base64,${image.data}`
                }
              }))
            ]
          : prompt
      const messageBody = JSON.stringify({ message })
      if (Buffer.byteLength(messageBody) > maximumMessageBytes) {
        throw new Error('Continue 图片上下文超过 20 MB 安全大小限制')
      }
      await this.request(origin, token, '/message', {
        method: 'POST',
        body: messageBody,
        signal: executionSignal
      })

      const handledPermissionIds = new Set<string>()
      while (true) {
        executionSignal.throwIfAborted()
        if (childFailure) {
          throw childFailure
        }
        if (child.exitCode !== null) {
          throw new Error(
            `Continue 宿主意外退出（code ${child.exitCode}）`
          )
        }
        const state = stateSchema.parse(
          await this.request(origin, token, '/state', {
            signal: executionSignal
          })
        )
        streamTruncated ||= state.goodbuddyEventsOverflow === true
        let streamEvents = state.goodbuddyEvents ?? []
        const batchStreamEventBytes = Buffer.byteLength(
          JSON.stringify(streamEvents)
        )
        const nextStreamEventBytes =
          streamEventBytes + batchStreamEventBytes
        if (
          streamTruncated ||
          nextStreamEventBytes >
            this.dependencies.maximumStreamEventBytes
        ) {
          streamTruncated = true
          streamEvents = []
        } else {
          streamEventBytes = nextStreamEventBytes
        }
        const nextToolCallIds = new Set(observedToolCallIds)
        for (const event of streamEvents) {
          if (event.type === 'tool') {
            nextToolCallIds.add(event.callId)
          }
        }
        for (const callId of nextToolCallIds) {
          observedToolCallIds.add(callId)
        }
        const historyTools = extractContinueTools(
          state.session.history,
          startIndex
        )
        for (const tool of historyTools) {
          observedToolCallIds.add(tool.callId)
        }
        observedTools = mergeContinueTools(
          observedTools,
          historyTools
        )
        for (const event of streamEvents) {
          if (event.type === 'text') {
            streamedText = true
            await runOptions.onEvent?.(event)
            continue
          }
          const tool: ContinueHostTool = {
            callId: event.callId,
            name: event.name,
            state: event.state,
            ...(event.input
              ? { input: boundedToolDetail(event.input, 4_000) }
              : {}),
            ...(event.output
              ? { output: boundedToolDetail(event.output, 16_000) }
              : {}),
            ...(event.error
              ? { error: normalizeContinueToolError(event.error) }
              : {})
          }
          observedTools = mergeContinueTools(observedTools, [tool])
          await runOptions.onEvent?.({ type: 'tool', tool })
        }
        const pendingQuestion = state.goodbuddyQuestion
        if (
          pendingQuestion &&
          !reportedQuestionIds.has(pendingQuestion.requestId)
        ) {
          if (this.pendingQuestions.has(pendingQuestion.requestId)) {
            throw new Error('Continue 提问 ID 与另一活动请求冲突')
          }
          reportedQuestionIds.add(pendingQuestion.requestId)
          this.pendingQuestions.set(pendingQuestion.requestId, {
            origin,
            token,
            signal: executionSignal
          })
          await runOptions.onEvent?.({
            type: 'question',
            questionId: pendingQuestion.requestId,
            questions: [
              {
                header: 'Continue',
                question: pendingQuestion.question.question,
                options: (
                  pendingQuestion.question.options ?? []
                ).map((option) => ({
                  label: option,
                  description: ''
                })),
                multiple: false,
                custom: true
              }
            ]
          })
        }
        const pending = state.pendingPermission
        if (pending && !handledPermissionIds.has(pending.requestId)) {
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
            observedToolCallIds.add(pendingCallId)
            observedTools = [
              ...observedTools,
              {
                callId: pendingCallId,
                name: pending.toolName,
                state: 'pending',
                input: boundedToolDetail(pending.toolArgs, 4_000)
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
            signal: executionSignal
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
            ...(streamedText ? { streamedText: true as const } : {}),
            ...(streamTruncated
              ? { streamTruncated: true as const }
              : {}),
            ...(usage ? { usage } : {}),
            ...(observedTools.length > 0
              ? { tools: observedTools }
              : {})
          }
        }
        await delay(150, executionSignal)
      }
    } catch (error) {
      if (error instanceof ContinueHostRunError) {
        throw error
      }
      throw new ContinueHostRunError(
        error instanceof Error
          ? error.message
          : 'Continue 宿主执行失败',
        { cause: error, tools: observedTools }
      )
    } finally {
      signal.removeEventListener('abort', abort)
      for (const questionId of reportedQuestionIds) {
        this.pendingQuestions.delete(questionId)
      }
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
        await this.terminate(child)
        this.children.delete(child)
        if (generatedConfigPath) {
          await rm(generatedConfigPath, { force: true })
        }
        await rm(isolatedGlobalDirectory, {
          recursive: true,
          force: true
        })
      }
    }
    } finally {
      if (generatedConfigPath) {
        await rm(generatedConfigPath, { force: true })
      }
      if (isolatedGlobalDirectory) {
        await rm(isolatedGlobalDirectory, {
          recursive: true,
          force: true
        })
      }
    }
  }

  private async terminate(child: ContinueHostChild): Promise<void> {
    const existing = this.childTerminations.get(child)
    if (existing) {
      await existing
      return
    }
    const termination = this.dependencies
      .terminateProcessTree(child)
      .catch(() => undefined)
    this.childTerminations.set(child, termination)
    await termination
  }

  async dispose(): Promise<void> {
    this.pendingQuestions.clear()
    await Promise.all(
      [...this.children].map((child) => this.terminate(child))
    )
    this.children.clear()
  }
}

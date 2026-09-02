import {
  createOpencodeClient,
  type AssistantMessage,
  type OpencodeClient,
  type PermissionRequest,
  type PermissionRuleset,
  type QuestionRequest
} from '@opencode-ai/sdk/v2'
import spawn from 'cross-spawn'
import { createHash, randomBytes } from 'node:crypto'
import {
  mkdtemp,
  readFile,
  rm,
  writeFile
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'
import type {
  AgentQuestionAnswer,
  AgentRuntimeStatus,
  SubagentEvent
} from '../../shared/contracts'
import {
  maximumConversationToolActivities
} from '../../shared/assistant-contracts'
import {
  boundedRuntimeIdentifierSchema,
  runtimeNativeInventoryLimits,
  type RuntimeConversationCompactInput,
  type RuntimeCustomizationSettings,
  type RuntimeNativeSnapshot,
  type RuntimeNativeTool
} from '../../shared/runtime-customization-contracts'
import { createAnthropicApiBaseUrl } from './anthropic-endpoint'
import { createOpenAIApiBaseUrl } from './openai-endpoint'
import type {
  AgentExecutionRequest,
  AgentRuntime,
  RuntimeConversationCompactOutcome,
  RuntimeEvent,
  RuntimeModelUsageEvent
} from './runtime'
import type { KnowledgeMcpGateway } from './knowledge-mcp-gateway'
import { detectRuntimeBinary } from './runtime-discovery'
import { getAvailableLoopbackPort } from './loopback-port'
import type { ResolvedModelProfile } from '../runtime-settings-store'
import {
  applyLaunchEnvironmentPath,
  buildExplicitProfileRuntimeEnvironment,
  buildRuntimeEnvironment,
  runtimePrivacyEnvironment
} from './process-environment'
import type { LaunchEnvironmentProvider } from '../local-tool-environment/launch-environment-provider'
import {
  boundedToolDetail,
  safeToolErrorDetail
} from './approval-summary'
import type {
  ResolvedMcpServer,
  RuntimeSkillPackage
} from '../capabilities/capability-service'
import { stageRuntimeSkillPackages } from './runtime-skill-packages'
import {
  requestProcessTreeTermination,
  waitForProcessExit
} from './child-process-termination'
import { toOpenCodeSubagentEvent } from './opencode-subagent'
import { promptWithUntrustedConversationHistory } from './runtime-conversation-history'

const STARTUP_TIMEOUT_MS = 30_000
const STARTUP_POLL_INTERVAL_MS = 100
const STARTUP_PROBE_TIMEOUT_MS = 500
const CONTROL_REQUEST_TIMEOUT_MS = 30_000
const MAX_PERMISSION_NAME_LENGTH = 128
const MAX_PERMISSION_PATTERNS = 32
const MAX_PERMISSION_PATTERN_LENGTH = 1_024
const MAX_PERMISSION_PATTERNS_BYTES = 8 * 1_024
const MAX_PERMISSION_METADATA_BYTES = 8 * 1_024
const MAX_TOOL_CALLS_PER_RUN = maximumConversationToolActivities
const MAX_EXECUTION_OUTPUT_BYTES = 1024 * 1024
const MAX_QUESTION_REQUEST_BYTES = 32 * 1_024
const MAX_QUESTIONS_PER_REQUEST = 4
const MAX_QUESTION_OPTIONS = 20
const MAX_NATIVE_AGENTS = runtimeNativeInventoryLimits.agents
const MAX_NATIVE_TOOLS = runtimeNativeInventoryLimits.tools
const MAX_NATIVE_COMMANDS = runtimeNativeInventoryLimits.commands
const MAX_NATIVE_LSP = runtimeNativeInventoryLimits.lsp
const MAX_NATIVE_FORMATTERS = runtimeNativeInventoryLimits.formatters
const MAX_NATIVE_MCP_SERVERS =
  runtimeNativeInventoryLimits.mcpServers
const MAX_NATIVE_SKILLS = runtimeNativeInventoryLimits.skills
const MAX_NATIVE_RESOURCES = runtimeNativeInventoryLimits.resources
const COMPACTION_USAGE_EVENT_GRACE_MS = 1_000
const EMBEDDED_SERVER_USERNAME = 'goodbuddy'
const OPENCODE_SKILL_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u
const TEMPORARY_MCP_PREFIXES = [
  'goodbuddy-data-',
  'goodbuddy-custom-'
] as const
const OPENCODE_INTERNAL_TOOL_IDS = new Set(['invalid'])
const OPENCODE_BUILTIN_TOOL_KINDS: Readonly<
  Partial<Record<string, RuntimeNativeTool['kind']>>
> = {
  apply_patch: 'write',
  bash: 'shell',
  edit: 'write',
  glob: 'read',
  grep: 'read',
  question: 'interaction',
  read: 'read',
  skill: 'agent',
  task: 'agent',
  todowrite: 'agent',
  webfetch: 'network',
  websearch: 'network',
  write: 'write'
}

type SpawnedProcess = ReturnType<typeof spawn>

type OpenCodeProviderConfig = {
  model: string
  provider: Record<
    string,
    {
      name: string
      npm: string
      options: {
        apiKey?: string
        baseURL: string
      }
      models: Record<
        string,
        {
          name: string
          attachment: boolean
          modalities: {
            input: Array<'text' | 'image'>
            output: ['text']
          }
          provider: {
            npm: string
          }
        }
      >
    }
  >
}

type OpenCodeProviderDescriptor = {
  id: string
  npm: string
  baseURL: string
}

type OpenCodeServer = {
  url: string
  authorization: string
  close: () => Promise<void>
}

type OpenCodeSkillRegistration = {
  root: string
  configDirectory: string
  skillsRoot: string
}

const executePermissionRules: PermissionRuleset = [
  { permission: '*', pattern: '*', action: 'allow' }
]

const readOnlyPermissionRules: PermissionRuleset = [
  { permission: '*', pattern: '*', action: 'deny' }
]

function resolveOpenCodeProvider(
  profile: ResolvedModelProfile
): OpenCodeProviderDescriptor {
  if (profile.protocol === 'openai-images-generations') {
    throw new Error(
      'OpenCode 独立模型连接不支持图像生成协议'
    )
  }
  return profile.protocol === 'anthropic-messages'
    ? {
        id: 'goodbuddy-anthropic',
        npm: '@ai-sdk/anthropic',
        baseURL: createAnthropicApiBaseUrl(profile.baseUrl)
      }
    : profile.protocol === 'openai-chat-completions'
      ? {
          id: 'goodbuddy-openai-chat',
          npm: '@ai-sdk/openai-compatible',
          baseURL: createOpenAIApiBaseUrl(profile.baseUrl)
        }
      : {
          id: 'goodbuddy-openai-responses',
          npm: '@ai-sdk/openai',
          baseURL: createOpenAIApiBaseUrl(profile.baseUrl)
        }
}

function createOpenCodeProviderConfig(
  profile: ResolvedModelProfile
): OpenCodeProviderConfig {
  const provider = resolveOpenCodeProvider(profile)
  const options: {
    apiKey?: string
    baseURL: string
  } = {
    baseURL: provider.baseURL
  }
  if (profile.authentication === 'api-key' && profile.apiKey) {
    options.apiKey = profile.apiKey
  }
  return {
    model: `${provider.id}/${profile.modelName}`,
    provider: {
      [provider.id]: {
        name: profile.name,
        npm: provider.npm,
        options,
        models: {
          [profile.modelName]: {
            name: profile.name,
            attachment: profile.supportsImageInput === true,
            modalities: {
              input: profile.supportsImageInput === true
                ? ['text', 'image']
                : ['text'],
              output: ['text']
            },
            provider: {
              npm: provider.npm
            }
          }
        }
      }
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value)
  )
}

function opencodeErrorMessage(value: unknown, fallback: string): string {
  return safeToolErrorDetail(value, 1_000) ?? fallback
}

function byteLengthWithin(value: string, maximum: number): boolean {
  return Buffer.byteLength(value) <= maximum
}

function createPublicQuestionId(
  requestId: string,
  sessionId: string,
  upstreamQuestionId: string
): string {
  return `opencode-${createHash('sha256')
    .update(`${requestId}\0${sessionId}\0${upstreamQuestionId}`)
    .digest('hex')
    .slice(0, 48)}`
}

function executionDeadlineLabel(milliseconds: number): string {
  return milliseconds % 60_000 === 0
    ? `${milliseconds / 60_000} 分钟`
    : `${milliseconds} 毫秒`
}

function awaitWithAbort<T>(
  operation: Promise<T>,
  signal: AbortSignal
): Promise<T> {
  signal.throwIfAborted()
  return new Promise<T>((resolveOperation, rejectOperation) => {
    const abort = (): void => rejectOperation(signal.reason)
    signal.addEventListener('abort', abort, { once: true })
    operation.then(
      (value) => {
        signal.removeEventListener('abort', abort)
        resolveOperation(value)
      },
      (error: unknown) => {
        signal.removeEventListener('abort', abort)
        rejectOperation(error)
      }
    )
  })
}

function areBoundedPatterns(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length <= MAX_PERMISSION_PATTERNS &&
    value.every(
      (pattern) =>
        typeof pattern === 'string' &&
        pattern.length <= MAX_PERMISSION_PATTERN_LENGTH
    ) &&
    byteLengthWithin(
      value.join('\0'),
      MAX_PERMISSION_PATTERNS_BYTES
    )
  )
}

function parsePermissionRequest(
  properties: unknown,
  sessionId: string
): PermissionRequest | undefined {
  if (!isRecord(properties) || properties.sessionID !== sessionId) {
    return undefined
  }
  const { id, permission, patterns, metadata, always, tool } =
    properties
  if (
    typeof id !== 'string' ||
    id.length === 0 ||
    id.length > MAX_PERMISSION_NAME_LENGTH ||
    typeof permission !== 'string' ||
    permission.length === 0 ||
    permission.length > MAX_PERMISSION_NAME_LENGTH ||
    !areBoundedPatterns(patterns) ||
    !isRecord(metadata) ||
    !areBoundedPatterns(always) ||
    (tool !== undefined &&
      (!isRecord(tool) ||
        typeof tool.messageID !== 'string' ||
        tool.messageID.length === 0 ||
        tool.messageID.length > 256 ||
        typeof tool.callID !== 'string' ||
        tool.callID.length === 0 ||
        tool.callID.length > 256))
  ) {
    throw new Error('OpenCode 权限请求格式无效')
  }
  let serializedMetadata: string
  try {
    serializedMetadata = JSON.stringify(metadata)
  } catch {
    throw new Error('OpenCode 权限请求元数据无效')
  }
  if (
    !byteLengthWithin(
      serializedMetadata,
      MAX_PERMISSION_METADATA_BYTES
    )
  ) {
    throw new Error('OpenCode 权限请求元数据超过安全限制')
  }
  return properties as PermissionRequest
}

function parseQuestionRequest(
  properties: unknown,
  sessionId: string
): QuestionRequest | undefined {
  if (!isRecord(properties) || properties.sessionID !== sessionId) {
    return undefined
  }
  const { id, questions, tool } = properties
  if (
    typeof id !== 'string' ||
    id.length === 0 ||
    id.length > MAX_PERMISSION_NAME_LENGTH ||
    !Array.isArray(questions) ||
    questions.length === 0 ||
    questions.length > MAX_QUESTIONS_PER_REQUEST ||
    !questions.every(
      (question) =>
        isRecord(question) &&
        typeof question.question === 'string' &&
        question.question.trim().length > 0 &&
        question.question.length <= 2_000 &&
        typeof question.header === 'string' &&
        question.header.trim().length > 0 &&
        question.header.length <= 120 &&
        Array.isArray(question.options) &&
        question.options.length <= MAX_QUESTION_OPTIONS &&
        question.options.every(
          (option) =>
            isRecord(option) &&
            typeof option.label === 'string' &&
            option.label.trim().length > 0 &&
            option.label.length <= 200 &&
            typeof option.description === 'string' &&
            option.description.length <= 1_000
        ) &&
        (question.multiple === undefined ||
          typeof question.multiple === 'boolean') &&
        (question.custom === undefined ||
          typeof question.custom === 'boolean')
    ) ||
    (tool !== undefined &&
      (!isRecord(tool) ||
        typeof tool.messageID !== 'string' ||
        tool.messageID.length === 0 ||
        tool.messageID.length > 256 ||
        typeof tool.callID !== 'string' ||
        tool.callID.length === 0 ||
        tool.callID.length > 256))
  ) {
    throw new Error('OpenCode 提问请求格式无效')
  }
  let serialized: string
  try {
    serialized = JSON.stringify(properties)
  } catch {
    throw new Error('OpenCode 提问请求无法序列化')
  }
  if (!byteLengthWithin(serialized, MAX_QUESTION_REQUEST_BYTES)) {
    throw new Error('OpenCode 提问请求超过安全限制')
  }
  return properties as QuestionRequest
}

function isSafeTokenCount(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0
}

function createUsageEvent(
  requestId: string,
  message: AssistantMessage
): RuntimeModelUsageEvent | undefined {
  const { tokens } = message
  if (
    message.time.completed === undefined ||
    !isSafeTokenCount(tokens.input) ||
    !isSafeTokenCount(tokens.output) ||
    !isSafeTokenCount(tokens.cache.read) ||
    !isSafeTokenCount(tokens.cache.write) ||
    (tokens.total !== undefined && !isSafeTokenCount(tokens.total))
  ) {
    return undefined
  }

  return {
    requestId,
    type: 'model-usage',
    callId: message.id.slice(0, 256),
    runtime: 'opencode',
    provider: message.providerID.slice(0, 100),
    model: message.modelID.slice(0, 500),
    inputTokens: tokens.input,
    outputTokens: tokens.output,
    cacheReadTokens: tokens.cache.read,
    cacheWriteTokens: tokens.cache.write,
    ...(tokens.total === undefined
      ? {}
      : { reportedTotalTokens: tokens.total })
  }
}

export type OpenCodeRuntimeDependencies = {
  spawn: typeof spawn
  detectBinary: (
    runtime: 'opencode',
    configuredPath: string,
    bundledPath?: string
  ) => Promise<{ path?: string; detail: string }>
  createClient: typeof createOpencodeClient
  checkServerHealth: (
    url: string,
    authorization: string,
    signal: AbortSignal
  ) => Promise<boolean>
  platform: NodeJS.Platform
  startupTimeoutMs: number
  controlRequestTimeoutMs: number
  executionTimeoutMs?: number
}

export type OpenCodeRuntimeOptions = {
  baseUrl?: string
  embedded: boolean
  binaryPath: string
  bundledBinaryPath?: string
  configPath: string
  defaultWorkspace: string
  modelProfile?: ResolvedModelProfile
  skillInstructions?: string
  skillPackages?: RuntimeSkillPackage[]
  knowledgeGateway?: KnowledgeMcpGateway
  mcpServers?: ResolvedMcpServer[]
  customization?: RuntimeCustomizationSettings['opencode']
  launchEnvironmentProvider?: LaunchEnvironmentProvider
}

function boundedNativeIdentifier(value: unknown): string | undefined {
  const parsed = boundedRuntimeIdentifierSchema.safeParse(value)
  return parsed.success ? parsed.data : undefined
}

function boundedNativeText(
  value: unknown,
  maximum: number
): string | undefined {
  if (typeof value !== 'string') {
    return undefined
  }
  const normalized = value.trim()
  return normalized ? normalized.slice(0, maximum) : undefined
}

function isTemporaryMcpName(value: string): boolean {
  return TEMPORARY_MCP_PREFIXES.some((prefix) =>
    value.startsWith(prefix)
  )
}

function isTemporaryMcpInventoryItem(
  ...values: Array<string | undefined>
): boolean {
  return values.some(
    (value) => value !== undefined && isTemporaryMcpName(value)
  )
}

function mapOpenCodeNativeTools(
  values: readonly string[]
): RuntimeNativeTool[] {
  const seen = new Set<string>()
  const tools: RuntimeNativeTool[] = []
  for (const value of values) {
    if (tools.length >= MAX_NATIVE_TOOLS) {
      break
    }
    const id = boundedNativeIdentifier(value)
    if (
      !id ||
      seen.has(id) ||
      OPENCODE_INTERNAL_TOOL_IDS.has(id) ||
      isTemporaryMcpName(id)
    ) {
      continue
    }
    seen.add(id)
    const builtinKind = OPENCODE_BUILTIN_TOOL_KINDS[id]
    tools.push({
      id,
      name: id.slice(0, 200),
      kind: builtinKind ?? 'other',
      source: builtinKind ? 'runtime' : 'unknown',
      ask: id === 'skill' ? 'conditional' : 'blocked',
      execute: 'allowed'
    })
  }
  return tools
}

function isLocalPathLikeResourceUri(value: string): boolean {
  return (
    /^file:/iu.test(value) ||
    /^[a-z]:[\\/]/iu.test(value) ||
    /^(?:[\\/]{1,2}|\.\.?[\\/]|~[\\/])/u.test(value)
  )
}

function boundedResourceUri(value: unknown): string | undefined {
  const bounded = boundedNativeText(value, 2_048)
  if (
    !bounded ||
    isLocalPathLikeResourceUri(bounded) ||
    /^data:/iu.test(bounded)
  ) {
    return undefined
  }
  try {
    const url = new URL(bounded)
    if (url.protocol === 'file:' || url.protocol === 'data:') {
      return undefined
    }
    url.username = ''
    url.password = ''
    url.search = ''
    url.hash = ''
    return url.toString().slice(0, 2_048)
  } catch {
    return bounded.includes('?') || bounded.includes('#')
      ? undefined
      : bounded
  }
}

function createSkillPermissionRules(
  skillIds: readonly string[]
): PermissionRuleset {
  if (skillIds.length === 0) {
    return []
  }
  return Object.entries(createSkillPermissionConfig(skillIds)).map(
    ([pattern, action]) => ({
      permission: 'skill',
      pattern,
      action
    })
  )
}

function createSkillPermissionConfig(
  skillIds: readonly string[]
): Record<string, 'allow' | 'deny'> {
  return Object.fromEntries([
    ['*', 'deny' as const],
    ...skillIds.map((skillId) => [skillId, 'allow' as const])
  ])
}

function createOpenCodeSkillConfig(
  registration: OpenCodeSkillRegistration,
  skillIds: readonly string[]
): {
  skills: { paths: string[]; urls: never[] }
  permission: {
    skill: Record<string, 'allow' | 'deny'>
  }
} {
  return {
    skills: {
      paths: [registration.skillsRoot],
      urls: []
    },
    permission: {
      skill: createSkillPermissionConfig(skillIds)
    }
  }
}

async function normalizeOpenCodeSkillManifest(
  skillDirectory: string,
  skillId: string
): Promise<void> {
  const manifestPath = join(skillDirectory, 'SKILL.md')
  const content = await readFile(manifestPath, 'utf8')
  const match =
    /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]+)$/u.exec(content)
  if (!match?.[1] || !match[2]?.trim()) {
    throw new Error('OpenCode Skill 清单格式无效')
  }
  const metadata = parseYaml(match[1])
  if (
    typeof metadata !== 'object' ||
    metadata === null ||
    Array.isArray(metadata)
  ) {
    throw new Error('OpenCode Skill 清单元数据无效')
  }
  const normalizedMetadata: Record<string, unknown> = {
    ...metadata,
    name: skillId
  }
  delete normalizedMetadata.id
  await writeFile(
    manifestPath,
    [
      '---',
      stringifyYaml(normalizedMetadata).trimEnd(),
      '---',
      match[2]
    ].join('\n'),
    'utf8'
  )
}

async function defaultDetectBinary(
  runtime: 'opencode',
  configuredPath: string,
  bundledPath?: string
): Promise<{ path?: string; detail: string }> {
  return detectRuntimeBinary({
    binaryPath: configuredPath,
    bundledPath,
    binaryNames: [runtime],
    label: 'OpenCode CLI'
  })
}

async function defaultCheckServerHealth(
  url: string,
  authorization: string,
  signal: AbortSignal
): Promise<boolean> {
  const client = createOpencodeClient({
    baseUrl: url,
    headers: { Authorization: authorization }
  })
  const response = await client.global.health({ signal })
  return response.error === undefined && response.data?.healthy === true
}

export class OpenCodeRuntime implements AgentRuntime {
  readonly runtimeId = 'opencode'
  readonly requiresToolApproval = false
  readonly supportsToolExecution = true
  private client?: OpencodeClient
  private clientInitialization?: Promise<OpencodeClient>
  private server?: OpenCodeServer
  private startingChild?: SpawnedProcess
  private readonly sessions = new Map<string, string>()
  private readonly sessionInitializations = new Map<
    string,
    Promise<string>
  >()
  private readonly pendingQuestions = new Map<
    string,
    {
      client: OpencodeClient
      directory: string
      questionCount: number
      upstreamQuestionId: string
    }
  >()
  private embeddedRunTail: Promise<void> = Promise.resolve()
  private readonly conversationRunTails = new Map<string, Promise<void>>()
  private readonly dependencies: OpenCodeRuntimeDependencies

  constructor(
    private readonly options: OpenCodeRuntimeOptions,
    dependencies: Partial<OpenCodeRuntimeDependencies> = {}
  ) {
    this.dependencies = {
      spawn,
      detectBinary: defaultDetectBinary,
      createClient: createOpencodeClient,
      checkServerHealth: defaultCheckServerHealth,
      platform: process.platform,
      startupTimeoutMs: STARTUP_TIMEOUT_MS,
      controlRequestTimeoutMs: CONTROL_REQUEST_TIMEOUT_MS,
      ...dependencies
    }
  }

  private usesEmbeddedPermissionMediation(): boolean {
    return this.options.embedded && !this.options.baseUrl
  }

  private supportsNativeCustomization(): boolean {
    return this.usesEmbeddedPermissionMediation()
  }

  get supportsScopedDataTools(): boolean {
    return this.usesEmbeddedPermissionMediation()
  }

  private async acquireEmbeddedRun(
    signal: AbortSignal
  ): Promise<() => void> {
    signal.throwIfAborted()
    const previous = this.embeddedRunTail
    let release!: () => void
    const current = new Promise<void>((resolve) => {
      release = resolve
    })
    this.embeddedRunTail = previous.then(
      () => current,
      () => current
    )
    let abort!: () => void
    const aborted = new Promise<never>((_resolve, reject) => {
      abort = () => reject(signal.reason)
    })
    signal.addEventListener('abort', abort, { once: true })
    try {
      await Promise.race([previous, aborted])
      signal.throwIfAborted()
      return release
    } catch (error) {
      release()
      throw error
    } finally {
      signal.removeEventListener('abort', abort)
    }
  }

  private async acquireConversationRun(
    conversationId: string,
    signal: AbortSignal
  ): Promise<() => void> {
    signal.throwIfAborted()
    const previous =
      this.conversationRunTails.get(conversationId) ?? Promise.resolve()
    let releaseGate!: () => void
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve
    })
    const tail = previous.then(
      () => gate,
      () => gate
    )
    this.conversationRunTails.set(conversationId, tail)
    let abort!: () => void
    const aborted = new Promise<never>((_resolve, reject) => {
      abort = () => reject(signal.reason)
    })
    signal.addEventListener('abort', abort, { once: true })
    try {
      await Promise.race([previous, aborted])
      signal.throwIfAborted()
      return () => {
        releaseGate()
        if (this.conversationRunTails.get(conversationId) === tail) {
          this.conversationRunTails.delete(conversationId)
        }
      }
    } catch (error) {
      releaseGate()
      if (this.conversationRunTails.get(conversationId) === tail) {
        this.conversationRunTails.delete(conversationId)
      }
      throw error
    } finally {
      signal.removeEventListener('abort', abort)
    }
  }

  private terminate(child: SpawnedProcess): void {
    requestProcessTreeTermination(child, {
      platform: this.dependencies.platform,
      spawn: this.dependencies.spawn
    })
  }

  private waitForExit(child: SpawnedProcess): Promise<void> {
    return waitForProcessExit(child)
  }

  private getNativeSkillIds(): string[] {
    if (!this.usesEmbeddedPermissionMediation()) {
      return []
    }
    const ids = (this.options.skillPackages ?? []).map(
      (skill) => skill.id
    )
    if (
      new Set(ids).size !== ids.length ||
      ids.some(
        (id) =>
          id.length > 64 || !OPENCODE_SKILL_NAME_PATTERN.test(id)
      )
    ) {
      throw new Error('OpenCode Skill 注册信息无效')
    }
    return ids
  }

  private async createSkillRegistration(): Promise<OpenCodeSkillRegistration> {
    const root = await mkdtemp(join(tmpdir(), 'goodbuddy-opencode-'))
    const configDirectory = join(root, 'config')
    try {
      const skillsRoot = await stageRuntimeSkillPackages(
        configDirectory,
        this.options.skillPackages ?? [],
        'OpenCode'
      )
      for (const skill of this.options.skillPackages ?? []) {
        await normalizeOpenCodeSkillManifest(
          join(skillsRoot, skill.id),
          skill.id
        )
      }
      return { root, configDirectory, skillsRoot }
    } catch (error) {
      await rm(root, { recursive: true, force: true })
      throw error
    }
  }

  private async launchEmbedded(signal?: AbortSignal): Promise<OpenCodeServer> {
    if (signal?.aborted) {
      throw new Error('OpenCode Server 启动已取消')
    }
    const detection = await this.dependencies.detectBinary(
      'opencode',
      this.options.binaryPath,
      this.options.bundledBinaryPath
    )
    const binaryPath = detection.path
    if (!binaryPath) {
      throw new Error(detection.detail)
    }
    if (signal?.aborted) {
      throw new Error('OpenCode Server 启动已取消')
    }
    const port = await getAvailableLoopbackPort()
    if (signal?.aborted) {
      throw new Error('OpenCode Server 启动已取消')
    }

    if (
      this.options.modelProfile?.authentication === 'api-key' &&
      !this.options.modelProfile.apiKey
    ) {
      throw new Error('OpenCode 独立模型连接尚未配置 API Key')
    }
    const skillIds = this.getNativeSkillIds()
    const registration = await this.createSkillRegistration()
    try {
      if (signal?.aborted) {
        throw new Error('OpenCode Server 启动已取消')
      }
      const profile = this.options.modelProfile
      let env = profile
        ? buildExplicitProfileRuntimeEnvironment(
            runtimePrivacyEnvironment,
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
        : buildRuntimeEnvironment(runtimePrivacyEnvironment)
      env = applyLaunchEnvironmentPath(
        env,
        this.options.launchEnvironmentProvider
      )
      delete env.OPENCODE_CONFIG
      delete env.OPENCODE_CONFIG_CONTENT
      delete env.OPENCODE_CONFIG_DIR
      delete env.OPENCODE_SERVER_PASSWORD
      delete env.OPENCODE_SERVER_USERNAME
      const serverPassword = randomBytes(32).toString('base64url')
      const authorization = `Basic ${Buffer.from(
        `${EMBEDDED_SERVER_USERNAME}:${serverPassword}`
      ).toString('base64')}`
      env.OPENCODE_SERVER_USERNAME = EMBEDDED_SERVER_USERNAME
      env.OPENCODE_SERVER_PASSWORD = serverPassword
      env.OPENCODE_CONFIG_DIR = registration.configDirectory
      env.OPENCODE_DISABLE_AUTOUPDATE = '1'
      env.OPENCODE_DISABLE_CLAUDE_CODE_SKILLS = '1'
      env.OPENCODE_DISABLE_EMBEDDED_WEB_UI = '1'
      env.OPENCODE_DISABLE_EXTERNAL_SKILLS = '1'
      env.OPENCODE_DISABLE_LSP_DOWNLOAD = '1'
      env.OPENCODE_DISABLE_MODELS_FETCH = '1'
      env.OPENCODE_DISABLE_PROJECT_CONFIG = '1'
      env.OPENCODE_DISABLE_SHARE = '1'
      env.XDG_CACHE_HOME = join(registration.root, 'xdg-cache')
      env.XDG_CONFIG_HOME = join(registration.root, 'xdg-config')
      env.XDG_DATA_HOME = join(registration.root, 'xdg-data')
      env.XDG_STATE_HOME = join(registration.root, 'xdg-state')
      const skillConfig = createOpenCodeSkillConfig(
        registration,
        skillIds
      )
      env.OPENCODE_CONFIG_CONTENT = JSON.stringify(
        profile
          ? {
              ...createOpenCodeProviderConfig(profile),
              ...skillConfig
            }
          : skillConfig
      )
      if (!profile && this.options.configPath.trim()) {
        env.OPENCODE_CONFIG = resolve(this.options.configPath)
      }
      const serverArgs = [
        'serve',
        '--hostname=127.0.0.1',
        `--port=${port}`
      ]

      return await new Promise<OpenCodeServer>((resolveServer, reject) => {
        const child = this.dependencies.spawn(
          binaryPath,
          serverArgs,
          {
            cwd: this.options.defaultWorkspace,
            env,
            shell: false,
            stdio: ['ignore', 'pipe', 'pipe'],
            windowsHide: true
          }
        )
        this.startingChild = child
        const { stdout, stderr } = child
        let settled = false
        let pollTimer: NodeJS.Timeout | undefined
        const probeController = new AbortController()
        const probeSignal = signal
          ? AbortSignal.any([signal, probeController.signal])
          : probeController.signal
        const url = `http://127.0.0.1:${port}`

        const cleanupStartupListeners = (): void => {
          clearTimeout(timeout)
          if (pollTimer) {
            clearTimeout(pollTimer)
          }
          probeController.abort()
          signal?.removeEventListener('abort', abort)
          child.removeListener('error', onError)
          child.removeListener('close', onClose)
        }
        const fail = (message: string): void => {
          if (settled) {
            return
          }
          settled = true
          cleanupStartupListeners()
          const clearStartingChild = (): void => {
            if (this.startingChild === child) {
              this.startingChild = undefined
            }
          }
          const exited = this.waitForExit(child)
          this.terminate(child)
          void exited.finally(() => {
            if (child.exitCode !== null) {
              clearStartingChild()
            }
            reject(new Error(message.slice(0, 1_000)))
          })
        }
        const succeed = (url: string): void => {
          if (settled) {
            return
          }
          settled = true
          cleanupStartupListeners()
          if (this.startingChild === child) {
            this.startingChild = undefined
          }
          stdout?.resume()
          stderr?.resume()
          resolveServer({
            url,
            authorization,
            close: async () => {
              try {
                const exited = this.waitForExit(child)
                this.terminate(child)
                await exited
              } finally {
                await rm(registration.root, {
                  recursive: true,
                  force: true
                })
              }
            }
          })
        }
        const onError = (): void => {
          fail('OpenCode Server 启动失败')
        }
        const onClose = (code: number | null): void => {
          fail(`OpenCode Server 启动前退出（code ${code ?? 'unknown'}）`)
        }
        const abort = (): void => {
          fail('OpenCode Server 启动已取消')
        }
        const probe = async (): Promise<void> => {
          try {
            const attemptSignal = AbortSignal.any([
              probeSignal,
              AbortSignal.timeout(STARTUP_PROBE_TIMEOUT_MS)
            ])
            if (
              await this.dependencies.checkServerHealth(
                url,
                authorization,
                attemptSignal
              )
            ) {
              succeed(url)
              return
            }
          } catch {
            // The server is not ready yet.
          }
          if (!settled) {
            pollTimer = setTimeout(
              () => void probe(),
              STARTUP_POLL_INTERVAL_MS
            )
          }
        }
        const timeout = setTimeout(() => {
          fail('OpenCode Server 启动超时（30 秒）')
        }, this.dependencies.startupTimeoutMs)

        if (!stdout || !stderr) {
          fail('OpenCode Server 管道初始化失败')
          return
        }
        stdout.resume()
        stderr.resume()
        child.once('error', onError)
        child.once('close', onClose)
        signal?.addEventListener('abort', abort, { once: true })
        if (signal?.aborted) {
          abort()
          return
        }
        void probe()
      })
    } catch (error) {
      await rm(registration.root, {
        recursive: true,
        force: true
      }).catch(() => undefined)
      throw error
    }
  }

  private async getClient(signal?: AbortSignal): Promise<OpencodeClient> {
    if (this.client) {
      return this.client
    }
    const existingInitialization = this.clientInitialization
    this.clientInitialization ??= this.initializeClient(signal)
    try {
      return signal && existingInitialization
        ? await awaitWithAbort(this.clientInitialization, signal)
        : await this.clientInitialization
    } catch (error) {
      this.clientInitialization = undefined
      throw error
    }
  }

  private async controlRequest<T>(
    label: string,
    operation: (signal: AbortSignal) => Promise<T>,
    callerSignal?: AbortSignal,
    onAbortedResult?: (value: T) => void | Promise<void>
  ): Promise<T> {
    const timeoutController = new AbortController()
    const timeout = setTimeout(() => {
      timeoutController.abort(
        new Error(`OpenCode ${label}超时`)
      )
    }, Math.max(1, this.dependencies.controlRequestTimeoutMs))
    timeout.unref?.()
    const controlSignal = callerSignal
      ? AbortSignal.any([callerSignal, timeoutController.signal])
      : timeoutController.signal
    try {
      controlSignal.throwIfAborted()
      const request = operation(controlSignal)
      if (onAbortedResult) {
        void request
          .then(async (value) => {
            if (controlSignal.aborted) {
              await onAbortedResult(value)
            }
          })
          .catch(() => undefined)
      }
      return await awaitWithAbort(
        request,
        controlSignal
      )
    } catch (error) {
      if (
        timeoutController.signal.aborted &&
        !callerSignal?.aborted
      ) {
        throw timeoutController.signal.reason
      }
      throw error
    } finally {
      clearTimeout(timeout)
    }
  }

  private async initializeClient(
    signal?: AbortSignal
  ): Promise<OpencodeClient> {
    let baseUrl = this.options.baseUrl
    if (baseUrl && this.options.modelProfile) {
      throw new Error('OpenCode 独立模型连接仅支持由 GoodBuddy 启动的本机服务')
    }
    if (!baseUrl && this.options.embedded) {
      this.server = await this.launchEmbedded(signal)
      baseUrl = this.server.url
    }

    if (!baseUrl) {
      throw new Error('未配置 OpenCode Server')
    }

    this.client = this.dependencies.createClient({
      baseUrl,
      directory: this.options.defaultWorkspace,
      ...(this.server
        ? {
            headers: {
              Authorization: this.server.authorization
            }
          }
        : {})
    })
    return this.client
  }

  async getStatus(): Promise<AgentRuntimeStatus> {
    try {
      const client = await this.getClient()
      const response = await this.controlRequest(
        '连接检查',
        (signal) =>
          client.session.list(
            { directory: this.options.defaultWorkspace },
            { signal }
          )
      )

      if (response.error) {
        throw new Error('OpenCode Server 返回错误')
      }

      return {
        id: 'opencode',
        label: 'OpenCode',
        available: true,
        supportsToolExecution: this.supportsToolExecution,
        detail: this.server
          ? '由 GoodBuddy 以当前用户权限管理本机 OpenCode 进程'
          : `已连接 ${this.options.baseUrl}`
      }
    } catch (error) {
      return {
        id: 'opencode',
        label: 'OpenCode',
        available: false,
        supportsToolExecution: this.supportsToolExecution,
        detail: error instanceof Error ? error.message : 'OpenCode 不可用'
      }
    }
  }

  private async discoverAgents(
    client: OpencodeClient,
    signal?: AbortSignal
  ): Promise<
    Array<{
      id: string
      name: string
      description?: string
      mode: 'primary' | 'subagent' | 'all'
      native: boolean
      hidden: boolean
    }>
  > {
    const response = await this.controlRequest(
      '读取 Agent 清单',
      (controlSignal) =>
        client.app.agents(
          {
            directory: this.options.defaultWorkspace
          },
          { signal: controlSignal }
        ),
      signal
    )
    if (response.error || !response.data) {
      throw new Error('OpenCode Agent 清单不可用')
    }
    return response.data
      .flatMap((agent) => {
        const id = boundedNativeIdentifier(agent.name)
        if (!id) {
          return []
        }
        const description = boundedNativeText(
          agent.description,
          2_000
        )
        return [
          {
            id,
            name: id.slice(0, 200),
            ...(description ? { description } : {}),
            mode: agent.mode,
            native: agent.native === true,
            hidden: agent.hidden === true
          }
        ]
      })
      .slice(0, MAX_NATIVE_AGENTS)
  }

  private async resolveSelectedAgent(
    client: OpencodeClient,
    request: AgentExecutionRequest,
    signal: AbortSignal
  ): Promise<string | undefined> {
    const control =
      request.runtimeControl?.provider === 'opencode'
        ? request.runtimeControl
        : undefined
    const selected =
      control?.agent ?? this.options.customization?.defaultAgent
    if (!selected) {
      return undefined
    }
    if (!this.supportsNativeCustomization()) {
      throw new Error(
        '外部 OpenCode Server 不支持由 GoodBuddy 选择 Agent'
      )
    }
    const agents = await this.discoverAgents(client, signal)
    if (
      !agents.some(
        (agent) =>
          agent.id === selected &&
          !agent.hidden &&
          (agent.mode === 'primary' || agent.mode === 'all')
      )
    ) {
      throw new Error(
        `OpenCode Agent 不存在、已隐藏或不可作为主 Agent：${selected.slice(0, 128)}`
      )
    }
    return selected
  }

  async getNativeSnapshot(): Promise<RuntimeNativeSnapshot> {
    const controlled = this.supportsNativeCustomization()
    const empty: RuntimeNativeSnapshot = {
      provider: 'opencode',
      available: false,
      inventoryStatus: controlled
        ? 'unavailable'
        : 'connection-only',
      detail: controlled
        ? 'OpenCode 原生能力不可用'
        : '外部 OpenCode Server 仅支持连接状态；GoodBuddy 不支持读取或控制其原生自定义能力',
      agents: [],
      tools: [],
      toolsSupported: controlled,
      commands: [],
      lsp: [],
      formatters: [],
      mcpServers: [],
      skills: [],
      rules: [],
      prompts: [],
      resources: [],
      resourcesSupported: false,
      context: {
        strategy: controlled ? 'native' : 'unsupported',
        manualCompact: controlled,
        detail: controlled
          ? '由 OpenCode 原生上下文与手动 Compact 管理'
          : '外部 OpenCode Server 不支持由 GoodBuddy 管理上下文'
      }
    }
    if (!controlled) {
      try {
        const client = await this.getClient()
        const response = await this.controlRequest(
          '连接检查',
          (signal) =>
            client.session.list(
              {
                directory: this.options.defaultWorkspace,
                limit: 1
              },
              { signal }
            )
        )
        if (response.error || !response.data) {
          throw new Error('connection check failed')
        }
        return { ...empty, available: true }
      } catch {
        return {
          ...empty,
          inventoryStatus: 'unavailable',
          detail:
            '外部 OpenCode Server 无法连接，且不支持由 GoodBuddy 读取或控制原生自定义能力'
        }
      }
    }

    let client: OpencodeClient
    try {
      client = await this.getClient()
    } catch {
      return {
        ...empty,
        detail: 'OpenCode Server 无法连接'
      }
    }

    const directory = this.options.defaultWorkspace
    const assignedSkillIds = new Set(
      (this.options.skillPackages ?? []).map((skill) => skill.id)
    )
    const [
      availabilityResult,
      agentsResult,
      toolsResult,
      commandsResult,
      lspResult,
      formattersResult,
      mcpResult,
      skillsResult,
      resourcesResult
    ] = await Promise.allSettled([
      this.controlRequest('连接检查', (signal) =>
        client.session.list(
          {
            directory,
            limit: 1
          },
          { signal }
        )
      ),
      this.discoverAgents(client),
      this.controlRequest('读取工具清单', (signal) =>
        client.tool.ids({ directory }, { signal })
      ),
      this.controlRequest('读取命令清单', (signal) =>
        client.command.list({ directory }, { signal })
      ),
      this.controlRequest('读取 LSP 状态', (signal) =>
        client.lsp.status({ directory }, { signal })
      ),
      this.controlRequest('读取格式化器状态', (signal) =>
        client.formatter.status({ directory }, { signal })
      ),
      this.controlRequest('读取 MCP 状态', (signal) =>
        client.mcp.status({ directory }, { signal })
      ),
      this.controlRequest('读取技能清单', (signal) =>
        client.app.skills({ directory }, { signal })
      ),
      this.controlRequest('读取资源清单', (signal) =>
        client.experimental.resource.list(
          { directory },
          { signal }
        )
      )
    ])
    if (
      availabilityResult.status === 'rejected' ||
      availabilityResult.value.error ||
      !availabilityResult.value.data
    ) {
      return {
        ...empty,
        detail: 'OpenCode Server 无法连接'
      }
    }
    const unavailable: string[] = []

    const agents =
      agentsResult.status === 'fulfilled'
        ? agentsResult.value
        : (unavailable.push('Agent'), [])

    const toolIds =
      toolsResult.status === 'fulfilled' &&
      !toolsResult.value.error &&
      toolsResult.value.data
        ? toolsResult.value.data
        : (unavailable.push('工具'), [])
    const tools = mapOpenCodeNativeTools(toolIds)

    const commandData =
      commandsResult.status === 'fulfilled' &&
      !commandsResult.value.error &&
      commandsResult.value.data
        ? commandsResult.value.data
        : (unavailable.push('命令'), [])
    const nativeCommandData = commandData
      .filter((command) => {
        const name = boundedNativeIdentifier(command.name)
        return (
          name !== undefined &&
          !isTemporaryMcpInventoryItem(name) &&
          !assignedSkillIds.has(name)
        )
      })
      .slice(0, MAX_NATIVE_COMMANDS)
    const commands = nativeCommandData.flatMap((command) => {
      const id = boundedNativeIdentifier(command.name)
      if (!id) {
        return []
      }
      const description = boundedNativeText(
        command.description,
        2_000
      )
      const agent = boundedNativeIdentifier(command.agent)
      return [
        {
          id,
          name: id.slice(0, 200),
          ...(description ? { description } : {}),
          source: command.source ?? ('command' as const),
          ...(agent ? { agent } : {})
        }
      ]
    })
    const prompts = nativeCommandData.flatMap((command) => {
      if (command.source !== 'mcp') {
        return []
      }
      const id = boundedNativeIdentifier(command.name)
      const prompt = boundedNativeText(command.template, 20_000)
      if (!id || !prompt) {
        return []
      }
      const description = boundedNativeText(
        command.description,
        2_000
      )
      return [
        {
          id,
          name: id.slice(0, 200),
          ...(description ? { description } : {}),
          prompt,
          source: 'mcp' as const
        }
      ]
    })

    const lspData =
      lspResult.status === 'fulfilled' &&
      !lspResult.value.error &&
      lspResult.value.data
        ? lspResult.value.data
        : (unavailable.push('LSP'), [])
    const lsp = lspData
      .flatMap((server) => {
        const id = boundedNativeIdentifier(server.id)
        const name = boundedNativeText(server.name, 200)
        if (!id || !name) {
          return []
        }
        return [
          {
            id,
            name,
            status: server.status
          }
        ]
      })
      .slice(0, MAX_NATIVE_LSP)

    const formatterData =
      formattersResult.status === 'fulfilled' &&
      !formattersResult.value.error &&
      formattersResult.value.data
        ? formattersResult.value.data
        : (unavailable.push('Formatter'), [])
    const formatters = formatterData
      .flatMap((formatter) => {
        const id = boundedNativeIdentifier(formatter.name)
        if (!id) {
          return []
        }
        return [
          {
            id,
            name: id.slice(0, 200),
            enabled: formatter.enabled,
            extensions: formatter.extensions
              .flatMap((extension) => {
                const value = boundedNativeText(extension, 32)
                return value ? [value] : []
              })
              .slice(0, 100)
          }
        ]
      })
      .slice(0, MAX_NATIVE_FORMATTERS)

    const mcpData =
      mcpResult.status === 'fulfilled' &&
      !mcpResult.value.error &&
      mcpResult.value.data
        ? mcpResult.value.data
        : (unavailable.push('MCP'), {})
    const mcpServers = Object.entries(mcpData)
      .flatMap(([rawName, server]) => {
        const id = boundedNativeIdentifier(rawName)
        if (!id || isTemporaryMcpName(id)) {
          return []
        }
        const status =
          server.status === 'needs_auth'
            ? ('needs-auth' as const)
            : server.status === 'needs_client_registration'
              ? ('unsupported' as const)
              : server.status
        return [
          {
            id,
            name: id.slice(0, 200),
            status
          }
        ]
      })
      .slice(0, MAX_NATIVE_MCP_SERVERS)

    const skillData =
      skillsResult.status === 'fulfilled' &&
      !skillsResult.value.error &&
      skillsResult.value.data
        ? skillsResult.value.data
        : (unavailable.push('Skill'), [])
    const skills = skillData
      .flatMap((skill) => {
        const id = boundedNativeIdentifier(skill.name)
        if (!id || assignedSkillIds.has(id)) {
          return []
        }
        const description = boundedNativeText(
          skill.description,
          2_000
        )
        return [
          {
            id,
            name: id.slice(0, 200),
            ...(description ? { description } : {}),
            source: 'unknown' as const
          }
        ]
      })
      .slice(0, MAX_NATIVE_SKILLS)

    const resourceData =
      resourcesResult.status === 'fulfilled' &&
      !resourcesResult.value.error &&
      resourcesResult.value.data
        ? resourcesResult.value.data
        : (unavailable.push('资源'), {})
    const resources = Object.entries(resourceData)
      .flatMap(([rawId, resource]) => {
        const id =
          boundedNativeIdentifier(rawId) ??
          boundedNativeIdentifier(resource.name)
        const name = boundedNativeText(resource.name, 200)
        const uri = boundedResourceUri(resource.uri)
        const server = boundedNativeText(resource.client, 200)
        if (
          !id ||
          !name ||
          !uri ||
          isTemporaryMcpInventoryItem(id, name, server)
        ) {
          return []
        }
        const description = boundedNativeText(
          resource.description,
          2_000
        )
        const mimeType = boundedNativeText(resource.mimeType, 200)
        return [
          {
            id,
            name,
            uri,
            ...(description ? { description } : {}),
            ...(mimeType ? { mimeType } : {}),
            ...(server ? { server } : {})
          }
        ]
      })
      .slice(0, MAX_NATIVE_RESOURCES)

    return {
      provider: 'opencode',
      available: true,
      inventoryStatus:
        unavailable.length === 0 ? 'available' : 'partial',
      detail:
        unavailable.length === 0
          ? 'OpenCode 原生能力已就绪'
          : `OpenCode 已连接；部分原生清单暂不可用：${unavailable.join('、')}`.slice(
              0,
              1_000
            ),
      agents,
      tools,
      toolsSupported:
        toolsResult.status === 'fulfilled' &&
        !toolsResult.value.error &&
        toolsResult.value.data !== undefined,
      commands,
      lsp,
      formatters,
      mcpServers,
      skills,
      rules: [],
      prompts,
      resources,
      resourcesSupported:
        resourcesResult.status === 'fulfilled' &&
        !resourcesResult.value.error &&
        resourcesResult.value.data !== undefined,
      context: {
        strategy: 'native',
        manualCompact: true,
        detail: '由 OpenCode 原生上下文与手动 Compact 管理'
      }
    }
  }

  private async getSessionId(
    client: OpencodeClient,
    request: AgentExecutionRequest,
    directory: string,
    signal: AbortSignal,
    agent?: string,
    permission?: PermissionRuleset
  ): Promise<{ id: string; created: boolean }> {
    const current = this.sessions.get(request.conversationId)
    if (current) {
      return { id: current, created: false }
    }
    const pending = this.sessionInitializations.get(
      request.conversationId
    )
    if (pending) {
      return {
        id: await awaitWithAbort(pending, signal),
        created: false
      }
    }
    const creation: Promise<string> = this.controlRequest(
      '创建会话',
      (controlSignal) =>
        client.session.create(
          {
            title: 'GoodBuddy 对话',
            directory,
            ...(agent ? { agent } : {}),
            ...(permission ? { permission } : {})
          },
          { signal: controlSignal }
        ),
      signal,
      async (response) => {
        const sessionId = response.data?.id
        if (sessionId) {
          await client.session
            .delete(
              {
                sessionID: sessionId,
                directory
              },
              { signal: AbortSignal.timeout(1_000) }
            )
            .catch(() => undefined)
        }
      }
    )
      .then((response) => {
        if (!response.data) {
          throw new Error('OpenCode 会话创建失败')
        }
        const sessionId = response.data.id
        const stillCurrent =
          this.sessionInitializations.get(request.conversationId) ===
          creation
        if (signal.aborted || !stillCurrent) {
          if (this.sessions.get(request.conversationId) !== sessionId) {
            void client.session
              .delete(
                {
                  sessionID: sessionId,
                  directory
                },
                { signal: AbortSignal.timeout(1_000) }
              )
              .catch(() => undefined)
          }
          if (signal.aborted) {
            throw signal.reason
          }
          throw new Error('OpenCode 会话初始化已失效')
        }
        this.sessions.set(request.conversationId, sessionId)
        return sessionId
      })
    this.sessionInitializations.set(request.conversationId, creation)
    try {
      return {
        id: await awaitWithAbort(creation, signal),
        created: true
      }
    } finally {
      if (
        this.sessionInitializations.get(request.conversationId) ===
        creation
      ) {
        this.sessionInitializations.delete(request.conversationId)
      }
    }
  }

  async *run(
    request: AgentExecutionRequest,
    signal: AbortSignal
  ): AsyncGenerator<RuntimeEvent, void, void> {
    const configuredTimeout = this.dependencies.executionTimeoutMs
    const deadline =
      configuredTimeout === undefined
        ? undefined
        : new AbortController()
    const deadlineTimer =
      configuredTimeout === undefined || deadline === undefined
        ? undefined
        : setTimeout(
            () =>
              deadline.abort(
                new Error(
                  `OpenCode 执行超过 ${executionDeadlineLabel(
                    configuredTimeout
                  )}总时限`
                )
              ),
            configuredTimeout
          )
    deadlineTimer?.unref?.()
    const executionSignal = deadline
      ? AbortSignal.any([signal, deadline.signal])
      : signal
    let releaseEmbedded: (() => void) | undefined
    let releaseConversation: (() => void) | undefined
    try {
      releaseEmbedded = this.usesEmbeddedPermissionMediation()
        ? await this.acquireEmbeddedRun(executionSignal)
        : undefined
      releaseConversation = await this.acquireConversationRun(
        request.conversationId,
        executionSignal
      )
      yield* this.runUnlocked(request, executionSignal)
    } catch (error) {
      if (deadline?.signal.aborted && !signal.aborted) {
        throw deadline.signal.reason
      }
      throw error
    } finally {
      if (deadlineTimer) {
        clearTimeout(deadlineTimer)
      }
      releaseConversation?.()
      releaseEmbedded?.()
    }
  }

  private async *runUnlocked(
    request: AgentExecutionRequest,
    signal: AbortSignal
  ): AsyncGenerator<RuntimeEvent, void, void> {
    signal.throwIfAborted()
    if (
      request.images?.length &&
      this.options.modelProfile &&
      this.options.modelProfile.supportsImageInput !== true
    ) {
      throw new Error('当前模型连接未启用图像输入')
    }
    const client = await this.getClient(signal)
    const directory = this.options.defaultWorkspace
    const runtimeControl =
      request.runtimeControl?.provider === 'opencode'
        ? request.runtimeControl
        : undefined
    if (
      runtimeControl?.command &&
      !this.supportsNativeCustomization()
    ) {
      throw new Error(
        '外部 OpenCode Server 不支持由 GoodBuddy 执行原生命令'
      )
    }
    const selectedAgent = await this.resolveSelectedAgent(
      client,
      request,
      signal
    )
    let selectedCommand:
      | {
          name: string
          arguments: string
        }
      | undefined
    if (runtimeControl?.command) {
      const commandResponse = await this.controlRequest(
        '验证原生命令',
        (controlSignal) =>
          client.command.list(
            { directory },
            { signal: controlSignal }
          ),
        signal
      )
      if (commandResponse.error || !commandResponse.data) {
        throw new Error('OpenCode 无法验证原生命令')
      }
      const assignedSkillIds = new Set(
        (this.options.skillPackages ?? []).map((skill) => skill.id)
      )
      const command = commandResponse.data.find(
        (candidate) => {
          const name = boundedNativeIdentifier(candidate.name)
          return (
            name !== undefined &&
            name === runtimeControl.command?.name &&
            !isTemporaryMcpName(name) &&
            !assignedSkillIds.has(name)
          )
        }
      )
      if (!command) {
        throw new Error(
          `OpenCode 原生命令不存在或已失效：${runtimeControl.command.name.slice(0, 128)}`
        )
      }
      selectedCommand = runtimeControl.command
    }
    const nativeSkillIds = this.getNativeSkillIds()
    const nativeSkillPermissionRules =
      createSkillPermissionRules(nativeSkillIds)
    let knowledgeMcpName: string | undefined
    let knowledgeToolIds: string[] = []
    let customMcpName: string | undefined
    let customMcpToken: string | undefined
    try {
      if (
        request.knowledgeCapabilityToken &&
        this.usesEmbeddedPermissionMediation() &&
        this.options.knowledgeGateway?.getEndpoint()
      ) {
        const knowledgeEndpoint =
          this.options.knowledgeGateway.getEndpoint()!
        knowledgeMcpName = `goodbuddy-data-${createHash('sha256')
          .update(`${request.conversationId}\0${request.requestId}`)
          .digest('hex')
          .slice(0, 20)}`
        const added = await this.controlRequest(
          '连接内置只读工具',
          (controlSignal) =>
            client.mcp.add(
            {
              directory,
              name: knowledgeMcpName,
              config: {
                type: 'remote',
                url: knowledgeEndpoint,
                enabled: true,
                headers: {
                  Authorization: `Bearer ${request.knowledgeCapabilityToken}`
                },
                oauth: false
              }
            },
            { signal: controlSignal }
          ),
          signal
        )
        if (added.error || !added.data) {
          throw new Error('OpenCode 内置只读工具连接失败')
        }
        const addedStatus = added.data[knowledgeMcpName]
        if (!addedStatus || addedStatus.status !== 'connected') {
          throw new Error(
            `OpenCode 内置只读工具连接失败（${addedStatus?.status ?? 'unknown'}）`
          )
        }
        // OpenCode 1.18.x does not include dynamically added MCP tools in
        // experimental/tool/ids. Its model tool namespace is deterministic:
        // "<MCP server name>_<declared tool name>".
        knowledgeToolIds =
          this.options.knowledgeGateway
            .getAvailableToolNames(request.knowledgeCapabilityToken)
            .map((toolName) => `${knowledgeMcpName}_${toolName}`)
      }
      if (
        request.workMode === 'execute' &&
        this.usesEmbeddedPermissionMediation() &&
        this.options.knowledgeGateway?.getEndpoint() &&
        this.options.mcpServers?.length
      ) {
        const customMcpEndpoint =
          this.options.knowledgeGateway.getEndpoint()!
        customMcpToken = this.options.knowledgeGateway.grantCustomMcp(
          request.requestId,
          this.options.mcpServers,
          signal
        )
        if (customMcpToken) {
          const tools =
            await this.options.knowledgeGateway.prepareCustomMcpTools(
              customMcpToken,
              signal
            )
          customMcpName = `goodbuddy-custom-${createHash('sha256')
            .update(`${request.conversationId}\0${request.requestId}`)
            .digest('hex')
            .slice(0, 20)}`
          const added = await this.controlRequest(
            '连接自定义 MCP 工具',
            (controlSignal) =>
              client.mcp.add(
              {
                directory,
                name: customMcpName,
                config: {
                  type: 'remote',
                  url: customMcpEndpoint,
                  enabled: true,
                  headers: {
                    Authorization: `Bearer ${customMcpToken}`
                  },
                  oauth: false
                }
              },
              { signal: controlSignal }
            ),
            signal
          )
          const addedStatus = added.data?.[customMcpName]
          if (
            added.error ||
            !added.data ||
            !addedStatus ||
            addedStatus.status !== 'connected'
          ) {
            throw new Error(
              `OpenCode 自定义 MCP 连接失败（${addedStatus?.status ?? 'unknown'}）`
            )
          }
          knowledgeToolIds.push(
            ...tools.map(
              (tool) => `${customMcpName}_${tool.name}`
            )
          )
        }
      }
      const permission =
        request.workMode === 'execute'
          ? [
              ...executePermissionRules,
              ...nativeSkillPermissionRules,
              ...knowledgeToolIds.map((toolId) => ({
                permission: toolId,
                pattern: '*',
                action: 'allow' as const
              }))
            ]
          : knowledgeToolIds.length > 0
            ? [
                ...readOnlyPermissionRules,
                ...nativeSkillPermissionRules,
                ...knowledgeToolIds.map((toolId) => ({
                  permission: toolId,
                  pattern: '*',
                  action: 'allow' as const
                }))
              ]
            : [
                ...readOnlyPermissionRules,
                ...nativeSkillPermissionRules
              ]
      let disabledTools: Record<string, boolean> | undefined
      if (request.workMode !== 'execute') {
        const tools = await this.controlRequest(
          '读取工具清单',
          (controlSignal) =>
            client.tool.ids(
              { directory },
              { signal: controlSignal }
            ),
          signal
        )
        if (tools.error || !tools.data) {
          throw new Error('OpenCode 无法确认工具已禁用，已阻止只读请求')
        }
        disabledTools = {
          ...Object.fromEntries(
            tools.data.map((toolId) => [toolId, false])
          ),
          ...Object.fromEntries(
            knowledgeToolIds.map((toolId) => [toolId, true])
          ),
          ...(nativeSkillIds.length > 0 ? { skill: true } : {})
        }
      }
      const session = await this.getSessionId(
        client,
        request,
        directory,
        signal,
        selectedAgent,
        permission
      )
      const sessionId = session.id
      if (!session.created) {
        const update = await this.controlRequest(
          '更新会话权限',
          (controlSignal) =>
            client.session.update(
            {
              sessionID: sessionId,
              directory,
              permission
            },
            { signal: controlSignal }
          ),
          signal
        )
        if (update.error || !update.data) {
          throw new Error('OpenCode 会话权限配置失败')
        }
      }

    yield {
      requestId: request.requestId,
      type: 'status',
      message: 'OpenCode 正在处理请求'
    }

    const subscription = await this.controlRequest(
      '订阅事件流',
      (controlSignal) =>
        client.event.subscribe(
          { directory },
          { signal: controlSignal }
        ),
      signal
    )

    const abortSession = (): void => {
      void client.session.abort({
        sessionID: sessionId,
        directory
      }).catch(() => undefined)
    }
    signal.addEventListener('abort', abortSession, { once: true })

    const toolStates = new Map<
      string,
      {
        name: string
        state: 'pending' | 'running' | 'completed' | 'failed'
        input?: string
        output?: string
        error?: string
        subagent?: SubagentEvent
      }
    >()
    const reasoningPartIds = new Set<string>()
    const reportedQuestionIds = new Map<string, string>()
    let aggregateOutputBytes = 0
    const consumeOutputBudget = (delta: string): void => {
      aggregateOutputBytes += Buffer.byteLength(delta)
      if (aggregateOutputBytes > MAX_EXECUTION_OUTPUT_BYTES) {
        throw new Error(
          'OpenCode 单次运行的文本与推理输出超过 1 MB 安全限制'
        )
      }
    }
    let hasResponseTextAfterFailure = false
    try {
      const promptText = promptWithUntrustedConversationHistory(
        request,
        session.created
      )
      const imageParts = (request.images ?? []).map((image) => ({
        type: 'file' as const,
        mime: image.mediaType,
        filename: image.name,
        url: `data:${image.mediaType};base64,${image.data}`
      }))
      const prompt = selectedCommand
        ? client.session.command(
            {
              sessionID: sessionId,
              directory,
              command: selectedCommand.name,
              arguments: selectedCommand.arguments,
              ...(selectedAgent ? { agent: selectedAgent } : {}),
              ...(this.options.modelProfile
                ? {
                    model: `${resolveOpenCodeProvider(
                      this.options.modelProfile
                    ).id}/${this.options.modelProfile.modelName}`
                  }
                : {}),
              ...(imageParts.length > 0
                ? { parts: imageParts }
                : {})
            },
            { signal }
          )
        : this.controlRequest(
            '提交请求',
            (controlSignal) =>
              client.session.promptAsync(
                {
                  sessionID: sessionId,
                  directory,
                  model: this.options.modelProfile
                    ? {
                        providerID: resolveOpenCodeProvider(
                          this.options.modelProfile
                        ).id,
                        modelID: this.options.modelProfile.modelName
                      }
                    : undefined,
                  ...(selectedAgent
                    ? { agent: selectedAgent }
                    : {}),
                  system:
                    nativeSkillIds.length > 0
                      ? undefined
                      : this.options.skillInstructions || undefined,
                  ...(disabledTools
                    ? { tools: disabledTools }
                    : {}),
                  parts: [
                    { type: 'text' as const, text: promptText },
                    ...imageParts
                  ]
                },
                { signal: controlSignal }
              ),
            signal
          )
      prompt.catch(() => undefined)

      const repliedPermissionIds = new Set<string>()
      const reportedMessageIds = new Set<string>()
      for await (const event of subscription.stream) {
        if (
          event.type === 'message.updated' &&
          event.properties.sessionID === sessionId &&
          event.properties.info.sessionID === sessionId &&
          event.properties.info.role === 'assistant' &&
          !reportedMessageIds.has(event.properties.info.id)
        ) {
          const usage = createUsageEvent(
            request.requestId,
            event.properties.info
          )
          if (usage) {
            reportedMessageIds.add(event.properties.info.id)
            yield usage
          }
        }

        if (
          event.type === 'message.part.delta' &&
          event.properties.sessionID === sessionId &&
          event.properties.delta
        ) {
          const reasoning =
            reasoningPartIds.has(event.properties.partID) ||
            [
              'reasoning',
              'reasoning_content',
              'reasoning_details',
              'thinking'
            ].includes(event.properties.field)
          if (reasoning || event.properties.field === 'text') {
            consumeOutputBudget(event.properties.delta)
            if (
              !reasoning &&
              /\S/u.test(event.properties.delta) &&
              [...toolStates.values()].some(
                (tool) => tool.state === 'failed'
              )
            ) {
              hasResponseTextAfterFailure = true
            }
            yield {
              requestId: request.requestId,
              type: reasoning ? 'reasoning' : 'text',
              delta: event.properties.delta
            }
          }
        }

        if (
          event.type === 'message.part.updated' &&
          event.properties.sessionID === sessionId
        ) {
          const { part } = event.properties
          if (part.type === 'reasoning') {
            reasoningPartIds.add(part.id)
          } else if (part.type === 'tool') {
            const callId = part.callID || part.id
            if (!callId || callId.length > 256) {
              throw new Error('OpenCode 工具调用 ID 格式无效')
            }
            const toolName = part.tool.slice(0, 200)
            if (
              !toolStates.has(callId) &&
              toolStates.size >= MAX_TOOL_CALLS_PER_RUN
            ) {
              throw new Error('OpenCode 单次运行的工具调用超过 100 个')
            }
            const state =
              part.state.status === 'error' ? 'failed' : part.state.status
            if (state === 'failed') {
              hasResponseTextAfterFailure = false
            }
            const error =
              part.state.status === 'error'
                ? safeToolErrorDetail(part.state.error)
                : undefined
            const input = isRecord(part.state.input)
              ? boundedToolDetail(part.state.input, 4_000)
              : undefined
            const output =
              part.state.status === 'completed' &&
              typeof part.state.output === 'string'
                ? part.state.output.slice(0, 16_000)
                : undefined
            const subagent =
              toolName.trim().toLowerCase() === 'task'
                ? toOpenCodeSubagentEvent({
                    requestId: request.requestId,
                    callId,
                    state: part.state.status,
                    input: part.state.input,
                    output,
                    error
                  })
                : undefined
            toolStates.set(callId, {
              name: toolName,
              state,
              ...(input ? { input } : {}),
              ...(output ? { output } : {}),
              ...(error ? { error } : {}),
              ...(subagent ? { subagent } : {})
            })
            if (subagent) {
              yield subagent
            } else {
              yield {
                requestId: request.requestId,
                type: 'tool',
                callId,
                name: toolName,
                state,
                summary: `OpenCode 工具：${toolName}`,
                ...(input ? { input } : {}),
                ...(output ? { output } : {}),
                ...(error ? { error } : {})
              }
            }
          }
        }

        if (
          event.type === 'session.next.reasoning.delta' &&
          event.properties.sessionID === sessionId &&
          event.properties.delta
        ) {
          consumeOutputBudget(event.properties.delta)
          yield {
            requestId: request.requestId,
            type: 'reasoning',
            delta: event.properties.delta
          }
        }

        if (
          event.type === 'question.asked' &&
          event.properties.sessionID === sessionId
        ) {
          const questionRequest = parseQuestionRequest(
            event.properties,
            sessionId
          )
          if (
            questionRequest &&
            !reportedQuestionIds.has(questionRequest.id)
          ) {
            const publicQuestionId = createPublicQuestionId(
              request.requestId,
              sessionId,
              questionRequest.id
            )
            if (this.pendingQuestions.has(publicQuestionId)) {
              throw new Error('OpenCode 提问公开 ID 与另一活动请求冲突')
            }
            reportedQuestionIds.set(
              questionRequest.id,
              publicQuestionId
            )
            this.pendingQuestions.set(publicQuestionId, {
              client,
              directory,
              questionCount: questionRequest.questions.length,
              upstreamQuestionId: questionRequest.id
            })
            yield {
              requestId: request.requestId,
              type: 'question',
              questionId: publicQuestionId,
              questions: questionRequest.questions.map((question) => ({
                header: question.header,
                question: question.question,
                options: question.options.map((option) => ({
                  label: option.label,
                  description: option.description
                })),
                multiple: question.multiple ?? false,
                custom: question.custom ?? true
              }))
            }
          }
        }

        if (
          (event.type === 'question.replied' ||
            event.type === 'question.rejected') &&
          event.properties.sessionID === sessionId
        ) {
          const publicQuestionId = reportedQuestionIds.get(
            event.properties.requestID
          )
          if (publicQuestionId) {
            this.pendingQuestions.delete(publicQuestionId)
          }
        }

        if (
          this.usesEmbeddedPermissionMediation() &&
          event.type === 'permission.asked'
        ) {
          const properties = event.properties as unknown
          if (
            isRecord(properties) &&
            typeof properties.sessionID === 'string' &&
            properties.sessionID !== sessionId
          ) {
            continue
          }

          let permissionRequest: PermissionRequest
          try {
            const parsed = parsePermissionRequest(properties, sessionId)
            if (!parsed) {
              throw new Error('OpenCode 权限请求格式无效')
            }
            permissionRequest = parsed
          } catch (error) {
            if (
              isRecord(properties) &&
              typeof properties.id === 'string' &&
              properties.id.length > 0 &&
              properties.id.length <= MAX_PERMISSION_NAME_LENGTH &&
              !repliedPermissionIds.has(properties.id)
            ) {
              if (
                repliedPermissionIds.size >= MAX_TOOL_CALLS_PER_RUN
              ) {
                throw new Error(
                  'OpenCode 单次运行的权限请求超过 100 个',
                  { cause: error }
                )
              }
              const permissionId = properties.id
              repliedPermissionIds.add(properties.id)
              const rejection = await this.controlRequest(
                '回复权限请求',
                (controlSignal) =>
                  client.permission.reply(
                    {
                      requestID: permissionId,
                      directory,
                      reply: 'reject'
                    },
                    { signal: controlSignal }
                  ),
                signal
              )
              if (rejection.error || rejection.data !== true) {
                throw new Error('OpenCode 权限拒绝回复失败', {
                  cause: error
                })
              }
              continue
            }
            throw error
          }

          if (repliedPermissionIds.has(permissionRequest.id)) {
            continue
          }
          if (repliedPermissionIds.size >= MAX_TOOL_CALLS_PER_RUN) {
            throw new Error('OpenCode 单次运行的权限请求超过 100 个')
          }
          repliedPermissionIds.add(permissionRequest.id)

          const callId = (
            permissionRequest.tool?.callID ?? permissionRequest.id
          )
          const toolName = permissionRequest.permission.slice(0, 200)
          if (
            !toolStates.has(callId) &&
            toolStates.size >= MAX_TOOL_CALLS_PER_RUN
          ) {
            throw new Error('OpenCode 单次运行的工具调用超过 100 个')
          }
          toolStates.set(callId, { name: toolName, state: 'pending' })
          yield {
            requestId: request.requestId,
            type: 'tool',
            callId,
            name: toolName,
            state: 'pending',
            summary: `OpenCode 工具：${toolName}`
          }
          const allowKnowledge =
            request.workMode === 'ask' &&
            knowledgeToolIds.includes(permissionRequest.permission)
          const response = await this.controlRequest(
            '回复权限请求',
            (controlSignal) =>
              client.permission.reply(
                {
                  requestID: permissionRequest.id,
                  directory,
                  reply:
                    request.workMode === 'execute' ||
                    allowKnowledge
                      ? 'once'
                      : 'reject'
                },
                { signal: controlSignal }
              ),
            signal
          )
          if (response.error || response.data !== true) {
            throw new Error('OpenCode 权限回复失败')
          }
        }

        if (
          event.type === 'session.error' &&
          event.properties.sessionID === sessionId
        ) {
          const error = event.properties.error
          throw new Error(
            opencodeErrorMessage(error, 'OpenCode 执行失败')
          )
        }

        if (
          event.type === 'session.idle' &&
          event.properties.sessionID === sessionId
        ) {
          const promptResult = await prompt
          if (promptResult.error) {
            throw new Error(
              opencodeErrorMessage(
                promptResult.error,
                'OpenCode 提交请求失败'
              )
            )
          }
          const incompleteTool = [...toolStates.entries()].find(
            ([, tool]) =>
              tool.state === 'pending' || tool.state === 'running'
          )
          if (incompleteTool) {
            const [callId] = incompleteTool
            throw new Error(
              `OpenCode 工具未完成（${callId.slice(0, 128)}）`
            )
          }
          const failedTools = [...toolStates.entries()].filter(
            ([, tool]) => tool.state === 'failed'
          )
          if (
            failedTools.length > 0 &&
            !hasResponseTextAfterFailure
          ) {
            const [callId, tool] = failedTools[0]!
            throw new Error(
              `OpenCode 工具执行失败（${callId.slice(0, 128)}）${tool.error ? `：${tool.error}` : ''}`
            )
          }
          for (const [callId, tool] of failedTools) {
            if (tool.subagent) {
              continue
            }
            yield {
              requestId: request.requestId,
              type: 'tool',
              callId,
              name: tool.name,
              state: 'recoverable',
              summary: `OpenCode 已在后续响应中处理工具失败：${tool.name}`,
              ...(tool.input ? { input: tool.input } : {}),
              ...(tool.output ? { output: tool.output } : {}),
              ...(tool.error ? { error: tool.error } : {})
            }
          }
          yield {
            requestId: request.requestId,
            type: 'done',
            sessionId
          }
          return
        }
      }

      const promptResult = await prompt
      if (promptResult.error) {
        throw new Error(
          opencodeErrorMessage(
            promptResult.error,
            'OpenCode 提交请求失败'
          )
        )
      }
      throw new Error('OpenCode 事件流意外结束')
    } catch (error) {
      abortSession()
      for (const [callId, tool] of toolStates) {
        if (tool.state === 'pending' || tool.state === 'running') {
          if (tool.subagent) {
            yield {
              ...tool.subagent,
              state: signal.aborted ? 'cancelled' : 'failed',
              ...(signal.aborted
                ? { reason: tool.subagent.reason ?? '父请求已取消' }
                : {
                    error:
                      tool.subagent.error ??
                      'OpenCode 子 Agent 未返回完成状态'
                  })
            }
          } else {
            yield {
              requestId: request.requestId,
              type: 'tool',
              callId,
              name: tool.name,
              state: 'failed',
              summary: `OpenCode 工具：${tool.name}`,
              ...(tool.input ? { input: tool.input } : {}),
              ...(tool.output ? { output: tool.output } : {}),
              ...(tool.error ? { error: tool.error } : {})
            }
          }
        }
      }
      throw error
    } finally {
      signal.removeEventListener('abort', abortSession)
      for (const questionId of reportedQuestionIds.values()) {
        this.pendingQuestions.delete(questionId)
      }
    }
    } finally {
      const cleanupSignal = AbortSignal.timeout(1_000)
      if (knowledgeMcpName) {
        await awaitWithAbort(
          client.mcp.disconnect(
            { name: knowledgeMcpName, directory },
            { signal: cleanupSignal }
          ),
          cleanupSignal
        ).catch(() => undefined)
      }
      if (customMcpName) {
        await awaitWithAbort(
          client.mcp.disconnect(
            { name: customMcpName, directory },
            { signal: cleanupSignal }
          ),
          cleanupSignal
        ).catch(() => undefined)
      }
      if (customMcpToken) {
        this.options.knowledgeGateway?.revoke(customMcpToken)
      }
    }
  }

  async respondToQuestion(
    questionId: string,
    answers?: AgentQuestionAnswer[]
  ): Promise<void> {
    const pending = this.pendingQuestions.get(questionId)
    if (!pending) {
      throw new Error('OpenCode 提问已失效或不存在')
    }
    const response = answers
      ? answers.length === pending.questionCount
        ? await this.controlRequest(
            '提交提问回答',
            (signal) =>
              pending.client.question.reply(
                {
                  requestID: pending.upstreamQuestionId,
                  directory: pending.directory,
                  answers
                },
                { signal }
              )
          )
        : undefined
      : await this.controlRequest(
          '取消提问',
          (signal) =>
            pending.client.question.reject(
              {
                requestID: pending.upstreamQuestionId,
                directory: pending.directory
              },
              { signal }
            )
        )
    if (!response) {
      throw new Error('OpenCode 提问回答数量不匹配')
    }
    if (response.error || response.data !== true) {
      throw new Error(
        answers ? 'OpenCode 提交回答失败' : 'OpenCode 取消提问失败'
      )
    }
    this.pendingQuestions.delete(questionId)
  }

  async compactConversation(
    request: RuntimeConversationCompactInput,
    signal: AbortSignal
  ): Promise<RuntimeConversationCompactOutcome> {
    signal.throwIfAborted()
    if (!this.supportsNativeCustomization()) {
      throw new Error(
        '外部 OpenCode Server 不支持由 GoodBuddy 执行原生 Compact'
      )
    }
    const configuredTimeout = this.dependencies.executionTimeoutMs
    const deadline =
      configuredTimeout === undefined
        ? undefined
        : new AbortController()
    const deadlineTimer =
      configuredTimeout === undefined || deadline === undefined
        ? undefined
        : setTimeout(
            () =>
              deadline.abort(
                new Error('OpenCode 原生 Compact 执行超时')
              ),
            configuredTimeout
          )
    deadlineTimer?.unref?.()
    const executionSignal = deadline
      ? AbortSignal.any([signal, deadline.signal])
      : signal
    let releaseEmbedded: (() => void) | undefined
    let releaseConversation: (() => void) | undefined
    try {
      releaseEmbedded = await this.acquireEmbeddedRun(executionSignal)
      releaseConversation = await this.acquireConversationRun(
        request.conversationId,
        executionSignal
      )
      const sessionId = this.sessions.get(request.conversationId)
      if (!sessionId) {
        return {
          result: {
            provider: 'opencode',
            strategy: 'native',
            compacted: false,
            detail: '当前 GoodBuddy 对话尚无可压缩的 OpenCode 会话'
          }
        }
      }
      const client = await this.getClient(executionSignal)
      const context = await this.controlRequest(
        '读取原生上下文',
        (controlSignal) =>
          client.v2.session.context(
            { sessionID: sessionId },
            { signal: controlSignal }
          ),
        executionSignal
      )
      if (context.error || !context.data) {
        throw new Error('OpenCode 原生上下文不可用，无法执行 Compact')
      }
      const latestAssistant = [...context.data.data]
        .reverse()
        .find((message) => message.type === 'assistant')
      const configuredModel = this.options.modelProfile
        ? {
            providerID: resolveOpenCodeProvider(
              this.options.modelProfile
            ).id,
            modelID: this.options.modelProfile.modelName
          }
        : latestAssistant?.type === 'assistant'
          ? {
              providerID: latestAssistant.model.providerID,
              modelID: latestAssistant.model.id
            }
          : undefined
      if (!configuredModel) {
        return {
          result: {
            provider: 'opencode',
            strategy: 'native',
            compacted: false,
            detail: '当前 OpenCode 会话尚无可用于压缩的模型记录'
          }
        }
      }
      executionSignal.throwIfAborted()
      const subscriptionController = new AbortController()
      const subscriptionSignal = AbortSignal.any([
        executionSignal,
        subscriptionController.signal
      ])
      const subscription = await this.controlRequest(
        '订阅 Compact 事件流',
        (controlSignal) =>
          client.event.subscribe(
            { directory: this.options.defaultWorkspace },
            { signal: controlSignal }
          ),
        subscriptionSignal
      )
      const usageEvents: RuntimeModelUsageEvent[] = []
      const reportedMessageIds = new Set<string>()
      const usageCapture = (async () => {
        for await (const event of subscription.stream) {
          if (
            event.type === 'message.updated' &&
            event.properties.sessionID === sessionId &&
            event.properties.info.sessionID === sessionId &&
            event.properties.info.role === 'assistant' &&
            !reportedMessageIds.has(event.properties.info.id)
          ) {
            const usage = createUsageEvent(
              request.requestId,
              event.properties.info
            )
            if (usage) {
              reportedMessageIds.add(event.properties.info.id)
              usageEvents.push(usage)
            }
          }
          if (
            event.type === 'session.idle' &&
            event.properties.sessionID === sessionId
          ) {
            return
          }
        }
      })()
      try {
        const compact = await client.session.summarize(
          {
            sessionID: sessionId,
            directory: this.options.defaultWorkspace,
            providerID: configuredModel.providerID,
            modelID: configuredModel.modelID,
            auto: false
          },
          { signal: executionSignal }
        )
        if (compact.error || compact.data !== true) {
          throw new Error(
            opencodeErrorMessage(
              compact.error,
              'OpenCode 原生 Compact 失败'
            )
          )
        }
        let graceTimer: ReturnType<typeof setTimeout> | undefined
        try {
          await Promise.race([
            usageCapture,
            new Promise<void>((resolveGrace) => {
              graceTimer = setTimeout(
                resolveGrace,
                COMPACTION_USAGE_EVENT_GRACE_MS
              )
              graceTimer.unref?.()
            })
          ])
        } finally {
          if (graceTimer) {
            clearTimeout(graceTimer)
          }
        }
        return {
          result: {
            provider: 'opencode',
            strategy: 'native',
            compacted: true,
            detail: 'OpenCode 已完成原生上下文压缩'
          },
          ...(usageEvents.length > 0 ? { usageEvents } : {})
        }
      } finally {
        subscriptionController.abort()
        await usageCapture.catch(() => undefined)
      }
    } catch (error) {
      if (deadline?.signal.aborted && !signal.aborted) {
        throw deadline.signal.reason
      }
      throw error
    } finally {
      if (deadlineTimer) {
        clearTimeout(deadlineTimer)
      }
      releaseConversation?.()
      releaseEmbedded?.()
    }
  }

  async dispose(): Promise<void> {
    this.pendingQuestions.clear()
    const startingChild = this.startingChild
    this.startingChild = undefined
    if (startingChild) {
      this.terminate(startingChild)
      await this.waitForExit(startingChild)
    }
    const server = this.server
    this.server = undefined
    this.client = undefined
    this.clientInitialization = undefined
    this.sessions.clear()
    this.sessionInitializations.clear()
    this.conversationRunTails.clear()
    await server?.close()
  }

  async releaseConversation(conversationId: string): Promise<void> {
    const sessionId = this.sessions.get(conversationId)
    this.sessions.delete(conversationId)
    if (!sessionId || !this.client) {
      return
    }
    await this.controlRequest(
      '释放会话',
      (signal) =>
        this.client!.session.delete(
          {
            sessionID: sessionId,
            directory: this.options.defaultWorkspace
          },
          { signal }
        )
    )
      .catch(() => undefined)
  }
}

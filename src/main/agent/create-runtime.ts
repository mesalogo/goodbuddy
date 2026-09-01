import {
  ModelAgentRuntime,
  type ModelRuntimeOptions
} from './model-runtime'
import { ContinueAgentRuntime } from './continue-runtime'
import { OpenCodeRuntime } from './opencode-runtime'
import {
  DeepSeekHarnessRuntime,
  type DeepSeekHarnessRuntimeOptions
} from './deepseek-harness-runtime'
import type { AgentRuntime } from './runtime'
import { UnconfiguredAgentRuntime } from './unconfigured-runtime'
import type {
  ResolvedModelProfile,
  ResolvedRuntimeSettings
} from '../runtime-settings-store'
import {
  defaultRuntimeSettings,
  isDeepSeekHarnessModelProfile,
  isAgentRuntimeModelProtocol
} from '../../shared/contracts'
import type {
  ResolvedMcpServer,
  RuntimeSkillPackage
} from '../capabilities/capability-service'
import type { BundledRuntimePaths } from './bundled-runtimes'
import type { ContinueHostLauncher } from './continue-host-adapter'
import type { BrowserToolService } from '../browser/browser-model-tools'
import type { ModelToolProviderLike } from './model-tool-provider'
import type { SubagentScheduler } from '../assistant/subagent-scheduler'
import type { KnowledgeMcpGateway } from './knowledge-mcp-gateway'
import { ModelToolProvider } from './model-tool-provider'
import type { ControlledHarnessExtensionPackage } from './deepseek-harness-extension-loader'
import {
  LocalWorkspaceAccess,
  type WorkspaceAccess
} from '../workspace'
import {
  REMOTE_EXECUTION_SPACE_UNAVAILABLE,
  type ExecutionSpaceDescriptor
} from '../execution-space'

const noSubagentTools: ModelToolProviderLike = {
  listTools: async () => [],
  getApproval: () => {
    throw new Error('子专家不允许工具调用')
  },
  callTool: async () => {
    throw new Error('子专家不允许工具调用')
  },
  releaseConversation: async () => undefined,
  dispose: async () => undefined
}

export type AgentCapabilityContext = {
  skillInstructions?: string
  skillPackages?: RuntimeSkillPackage[]
  mcpServers?: ResolvedMcpServer[]
  continueHostCacheRoot?: string
  bundledRuntimePaths?: BundledRuntimePaths
  continueHostLauncher?: ContinueHostLauncher
  deepseekHarnessLauncher?: DeepSeekHarnessRuntimeOptions['launch']
  deepseekHarnessExtensions?: ControlledHarnessExtensionPackage[]
  browserService?: BrowserToolService
  knowledgeGateway?: KnowledgeMcpGateway
  webSearchEnabled?: boolean
  executionSpace?: ExecutionSpaceDescriptor
  workspaceAccess?: WorkspaceAccess
  directModelSubagentScheduler?: SubagentScheduler
}

function resolveContextCompression(
  settings: ResolvedRuntimeSettings,
  currentProfile: ResolvedModelProfile | undefined
): ModelRuntimeOptions['contextCompression'] {
  const compression =
    settings.contextCompression ?? defaultRuntimeSettings.contextCompression
  const source = compression.modelSource
  const summaryProfile =
    source.kind === 'profile'
      ? settings.modelProfiles.find(
          (profile) =>
            profile.id === source.profileId &&
            isAgentRuntimeModelProtocol(profile.protocol)
        )
      : undefined
  return {
    settings: compression,
    contextWindowTokens: currentProfile?.contextWindowTokens,
    ...(summaryProfile
      ? {
          summaryModel: {
            apiKey: summaryProfile.apiKey,
            baseUrl: summaryProfile.baseUrl,
            model: summaryProfile.modelName,
            protocol: summaryProfile.protocol as Exclude<
              typeof summaryProfile.protocol,
              'openai-images-generations'
            >,
            authentication: summaryProfile.authentication,
            contextWindowTokens: summaryProfile.contextWindowTokens,
            maximumOutputTokens: summaryProfile.maximumOutputTokens
          }
        }
      : {})
  }
}

export function createDefaultModelRuntime(
  defaultWorkspace: string,
  settings: ResolvedRuntimeSettings
): AgentRuntime {
  if (settings.modelProtocol === 'openai-images-generations') {
    return new UnconfiguredAgentRuntime()
  }
  const currentProfile = settings.modelProfiles.find(
    (profile) => profile.id === settings.defaultModelProfileId
  )
  return new ModelAgentRuntime({
    apiKey: settings.apiKey,
    baseUrl: settings.modelBaseUrl,
    model: settings.modelName,
    protocol: settings.modelProtocol,
    authentication: settings.modelAuthentication,
    supportsImageInput: settings.supportsImageInput,
    maximumOutputTokens: currentProfile?.maximumOutputTokens,
    defaultWorkspace: settings.workspacePath || defaultWorkspace,
    contextCompression: resolveContextCompression(
      settings,
      currentProfile
    ),
    toolProvider: noSubagentTools
  })
}

export function createModelProfileRuntime(
  defaultWorkspace: string,
  settings: ResolvedRuntimeSettings,
  profile: ResolvedModelProfile
): ModelAgentRuntime {
  return new ModelAgentRuntime({
    apiKey: profile.apiKey,
    baseUrl: profile.baseUrl,
    model: profile.modelName,
    protocol: profile.protocol,
    authentication: profile.authentication,
    supportsImageInput: profile.supportsImageInput,
    maximumOutputTokens: profile.maximumOutputTokens,
    imageGenerationQuality:
      profile.imageGenerationQuality ??
      defaultRuntimeSettings.imageGenerationQuality,
    contextCompression: resolveContextCompression(settings, profile),
    defaultWorkspace: settings.workspacePath || defaultWorkspace,
    toolProvider: noSubagentTools
  })
}

export function createAgentRuntime(
  defaultWorkspace: string,
  settings?: ResolvedRuntimeSettings,
  capabilities: AgentCapabilityContext = {}
): AgentRuntime {
  const executionSpace = capabilities.executionSpace
  const remote = executionSpace?.kind === 'ssh'
  const baseUrl = (
    settings?.opencodeBaseUrl ||
    process.env.GOODBUDDY_OPENCODE_URL ||
    ''
  ).trim()
  const embedded = !baseUrl
  const workspace =
    executionSpace?.kind === 'local'
      ? executionSpace.rootPath
      : settings?.workspacePath || defaultWorkspace
  const getWorkspaceAccess = (): WorkspaceAccess =>
    capabilities.workspaceAccess ??
    executionSpace?.workspaceAccess ??
    new LocalWorkspaceAccess(workspace)
  const provider = settings?.provider ?? defaultRuntimeSettings.provider

  if (
    remote &&
    (provider === 'continue' ||
      provider === 'opencode' ||
      provider === 'deepseek-harness' ||
      provider === 'auto')
  ) {
    throw new Error(REMOTE_EXECUTION_SPACE_UNAVAILABLE)
  }

  if (provider === 'deepseek-harness') {
    const profile = settings?.deepseekHarnessModelProfile
    if (!profile || !isDeepSeekHarnessModelProfile(profile)) {
      throw new Error(
        'DeepSeek Harness 需要使用 API Key 的 OpenAI 兼容 Chat Completions 模型连接'
      )
    }
    if (!profile.apiKey) {
      throw new Error('DeepSeek Harness 模型连接未配置 API Key')
    }
    if (!capabilities.deepseekHarnessLauncher) {
      throw new Error('DeepSeek Harness 受控 Host 启动器不可用')
    }
    return new DeepSeekHarnessRuntime({
      defaultWorkspace: workspace,
      baseUrl: profile.baseUrl,
      model: profile.modelName,
      supportsImageInput: profile.supportsImageInput === true,
      launch: capabilities.deepseekHarnessLauncher,
      credentialRefs: {
        GOODBUDDY_HARNESS_MODEL_API_KEY: profile.apiKey
      },
      skillPackages: capabilities.skillPackages,
      extensionPackages: capabilities.deepseekHarnessExtensions,
      toolProvider: new ModelToolProvider(
        getWorkspaceAccess(),
        capabilities.mcpServers,
        undefined,
        capabilities.knowledgeGateway,
        capabilities.webSearchEnabled === true
      )
    })
  }

  if (provider === 'continue') {
    if (
      settings?.continueModelProfile &&
      !isAgentRuntimeModelProtocol(
        settings.continueModelProfile.protocol
      )
    ) {
      throw new Error(
        'Continue 独立模型连接仅支持文本对话协议，不支持图像生成协议'
      )
    }
    return new ContinueAgentRuntime({
      binaryPath:
        settings?.continueBinaryPath ??
        process.env.GOODBUDDY_CONTINUE_BINARY?.trim() ??
        process.env.GOODBUDDY_CONTINUE_COMMAND?.trim() ??
        '',
      bundledBinaryPath: capabilities.bundledRuntimePaths?.continue,
      configPath:
        settings?.continueConfigPath ??
        process.env.GOODBUDDY_CONTINUE_CONFIG?.trim() ??
        '',
      modelProfile: settings?.continueModelProfile,
      skillInstructions: capabilities.skillInstructions,
      skillPackages: capabilities.skillPackages,
      defaultWorkspace: workspace,
      hostCacheRoot:
        capabilities.continueHostCacheRoot ??
        process.env.GOODBUDDY_CONTINUE_HOST_CACHE?.trim() ??
        '',
      launchHost: capabilities.continueHostLauncher,
      knowledgeGateway: capabilities.knowledgeGateway,
      mcpServers: capabilities.mcpServers,
      customization: settings?.runtimeCustomization.continue
    })
  }

  if (provider === 'opencode' || (provider === 'auto' && (baseUrl || embedded))) {
    if (
      settings?.opencodeModelProfile &&
      !isAgentRuntimeModelProtocol(
        settings.opencodeModelProfile.protocol
      )
    ) {
      throw new Error(
        'OpenCode 独立模型连接仅支持文本对话协议，不支持图像生成协议'
      )
    }
    return new OpenCodeRuntime({
      baseUrl,
      embedded,
      binaryPath:
        settings?.opencodeBinaryPath ??
        process.env.GOODBUDDY_OPENCODE_BINARY?.trim() ??
        '',
      bundledBinaryPath: capabilities.bundledRuntimePaths?.opencode,
      configPath:
        settings?.opencodeConfigPath ??
        process.env.GOODBUDDY_OPENCODE_CONFIG?.trim() ??
        '',
      modelProfile: settings?.opencodeModelProfile,
      skillInstructions: capabilities.skillInstructions,
      skillPackages: capabilities.skillPackages,
      defaultWorkspace: workspace,
      knowledgeGateway: capabilities.knowledgeGateway,
      mcpServers: capabilities.mcpServers,
      customization: settings?.runtimeCustomization.opencode
    })
  }

  const defaultModelProfile =
    settings?.modelProfiles.find(
      (profile) => profile.id === settings.defaultModelProfileId
    ) ?? settings?.modelProfiles[0]
  const modelApiKey =
    defaultModelProfile?.apiKey ||
    settings?.apiKey ||
    process.env.GOODBUDDY_MODEL_API_KEY?.trim() ||
    process.env.GOODBUDDY_BIGTOKEN_API_KEY?.trim()
  const modelAuthentication =
    defaultModelProfile?.authentication ??
    settings?.modelAuthentication ??
    defaultRuntimeSettings.modelAuthentication
  if (
    provider === 'model' ||
    (provider === 'auto' &&
      (modelAuthentication === 'none' || modelApiKey))
  ) {
    return new ModelAgentRuntime({
      apiKey: modelApiKey ?? '',
      baseUrl:
        defaultModelProfile?.baseUrl ||
        settings?.modelBaseUrl ||
        process.env.GOODBUDDY_MODEL_BASE_URL?.trim() ||
        process.env.GOODBUDDY_BIGTOKEN_BASE_URL?.trim() ||
        defaultRuntimeSettings.modelBaseUrl,
      model:
        defaultModelProfile?.modelName ||
        settings?.modelName ||
        process.env.GOODBUDDY_MODEL_NAME?.trim() ||
        process.env.GOODBUDDY_BIGTOKEN_MODEL?.trim() ||
        defaultRuntimeSettings.modelName,
      protocol:
        defaultModelProfile?.protocol ??
        settings?.modelProtocol ??
        defaultRuntimeSettings.modelProtocol,
      authentication: modelAuthentication,
      supportsImageInput:
        defaultModelProfile?.supportsImageInput ??
        settings?.supportsImageInput ??
        defaultRuntimeSettings.supportsImageInput,
      imageGenerationQuality:
        defaultModelProfile?.imageGenerationQuality ??
        settings?.imageGenerationQuality ??
        defaultRuntimeSettings.imageGenerationQuality,
      skillInstructions: capabilities.skillInstructions,
      defaultWorkspace: workspace,
      mcpServers: capabilities.mcpServers,
      browserService: capabilities.browserService,
      knowledgeGateway: capabilities.knowledgeGateway,
      webSearchEnabled: capabilities.webSearchEnabled,
      contextCompression: settings
        ? resolveContextCompression(settings, defaultModelProfile)
        : undefined,
      workspaceAccess: getWorkspaceAccess(),
      directModelSubagentScheduler:
        capabilities.directModelSubagentScheduler
    })
  }

  return new UnconfiguredAgentRuntime()
}

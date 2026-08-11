import { ModelAgentRuntime } from './model-runtime'
import { ContinueAgentRuntime } from './continue-runtime'
import { OpenCodeRuntime } from './opencode-runtime'
import type { AgentRuntime } from './runtime'
import { UnconfiguredAgentRuntime } from './unconfigured-runtime'
import type {
  ResolvedModelProfile,
  ResolvedRuntimeSettings
} from '../runtime-settings-store'
import {
  defaultRuntimeSettings,
  isAgentRuntimeModelProtocol
} from '../../shared/contracts'
import type {
  ResolvedMcpServer,
  RuntimeSkillPackage
} from '../capabilities/capability-service'
import type { BundledRuntimePaths } from './bundled-runtimes'
import type { ContinueHostLauncher } from './continue-host-adapter'
import { resolveRuntimeSandbox } from './runtime-sandbox'
import type { BrowserToolService } from '../browser/browser-model-tools'
import type { ModelToolProviderLike } from './model-tool-provider'
import type { KnowledgeMcpGateway } from './knowledge-mcp-gateway'

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
  browserService?: BrowserToolService
  knowledgeGateway?: KnowledgeMcpGateway
  webSearchEnabled?: boolean
}

export function createDefaultModelRuntime(
  defaultWorkspace: string,
  settings: ResolvedRuntimeSettings
): AgentRuntime {
  if (settings.modelProtocol === 'openai-images-generations') {
    return new UnconfiguredAgentRuntime()
  }
  return new ModelAgentRuntime({
    apiKey: settings.apiKey,
    baseUrl: settings.modelBaseUrl,
    model: settings.modelName,
    protocol: settings.modelProtocol,
    authentication: settings.modelAuthentication,
    supportsImageInput: settings.supportsImageInput,
    defaultWorkspace: settings.workspacePath || defaultWorkspace,
    toolProvider: noSubagentTools
  })
}

export function createModelProfileRuntime(
  defaultWorkspace: string,
  settings: ResolvedRuntimeSettings,
  profile: ResolvedModelProfile
): AgentRuntime {
  return new ModelAgentRuntime({
    apiKey: profile.apiKey,
    baseUrl: profile.baseUrl,
    model: profile.modelName,
    protocol: profile.protocol,
    authentication: profile.authentication,
    supportsImageInput: profile.supportsImageInput,
    imageGenerationQuality:
      profile.imageGenerationQuality ??
      defaultRuntimeSettings.imageGenerationQuality,
    defaultWorkspace: settings.workspacePath || defaultWorkspace,
    toolProvider: noSubagentTools
  })
}

export function createAgentRuntime(
  defaultWorkspace: string,
  settings?: ResolvedRuntimeSettings,
  capabilities: AgentCapabilityContext = {}
): AgentRuntime {
  const baseUrl = (
    settings?.opencodeBaseUrl ||
    process.env.GOODBUDDY_OPENCODE_URL ||
    ''
  ).trim()
  const embedded = !baseUrl
  const workspace = settings?.workspacePath || defaultWorkspace
  const provider = settings?.provider ?? defaultRuntimeSettings.provider
  const sandboxMode =
    settings?.runtimeSandboxMode ??
    defaultRuntimeSettings.runtimeSandboxMode

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
      runtimeSandboxMode: sandboxMode,
      modelProfile: settings?.continueModelProfile,
      skillInstructions: capabilities.skillInstructions,
      skillPackages: capabilities.skillPackages,
      defaultWorkspace: workspace,
      hostCacheRoot:
        capabilities.continueHostCacheRoot ??
        process.env.GOODBUDDY_CONTINUE_HOST_CACHE?.trim() ??
        '',
      launchHost: capabilities.continueHostLauncher,
      knowledgeGateway: capabilities.knowledgeGateway
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
      sandbox: resolveRuntimeSandbox(sandboxMode),
      defaultWorkspace: workspace,
      knowledgeGateway: capabilities.knowledgeGateway
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
      webSearchEnabled: capabilities.webSearchEnabled
    })
  }

  return new UnconfiguredAgentRuntime()
}

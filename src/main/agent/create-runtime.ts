import { ModelAgentRuntime } from './model-runtime'
import { ContinueAgentRuntime } from './continue-runtime'
import { OpenCodeRuntime } from './opencode-runtime'
import type { AgentRuntime } from './runtime'
import { UnconfiguredAgentRuntime } from './unconfigured-runtime'
import type { ResolvedRuntimeSettings } from '../runtime-settings-store'
import { defaultRuntimeSettings } from '../../shared/contracts'
import type { ResolvedMcpServer } from '../capabilities/capability-service'
import type { BundledRuntimePaths } from './bundled-runtimes'
import type { ContinueHostLauncher } from './continue-host-adapter'
import { resolveRuntimeSandbox } from './runtime-sandbox'

export type AgentCapabilityContext = {
  skillInstructions?: string
  mcpServers?: ResolvedMcpServer[]
  continueHostCacheRoot?: string
  bundledRuntimePaths?: BundledRuntimePaths
  continueHostLauncher?: ContinueHostLauncher
}

export function createAgentRuntime(
  defaultWorkspace: string,
  settings?: ResolvedRuntimeSettings,
  capabilities: AgentCapabilityContext = {}
): AgentRuntime {
  const baseUrl =
    settings?.opencodeBaseUrl || process.env.GOODBUDDY_OPENCODE_URL
  const embedded =
    settings?.opencodeEmbedded ??
    process.env.GOODBUDDY_OPENCODE_EMBEDDED === 'true'
  const workspace = settings?.workspacePath || defaultWorkspace
  const provider = settings?.provider ?? 'auto'
  const sandboxMode =
    settings?.runtimeSandboxMode ??
    defaultRuntimeSettings.runtimeSandboxMode

  if (provider === 'continue') {
    if (
      settings?.continueModelProfile?.protocol ===
      'openai-images-generations'
    ) {
      throw new Error('Continue 不支持图像生成模型连接')
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
      mode: settings?.continueMode ?? defaultRuntimeSettings.continueMode,
      runtimeSandboxMode: sandboxMode,
      modelProfile: settings?.continueModelProfile,
      skillInstructions: capabilities.skillInstructions,
      defaultWorkspace: workspace,
      hostCacheRoot:
        capabilities.continueHostCacheRoot ??
        process.env.GOODBUDDY_CONTINUE_HOST_CACHE?.trim() ??
        '',
      launchHost: capabilities.continueHostLauncher
    })
  }

  if (provider === 'opencode' || (provider === 'auto' && (baseUrl || embedded))) {
    if (
      settings?.opencodeModelProfile &&
      (settings.opencodeModelProfile.protocol !== 'anthropic-messages' ||
        settings.opencodeModelProfile.authentication !== 'api-key')
    ) {
      throw new Error(
        'OpenCode 独立模型连接仅支持需要 API Key 的 Anthropic Messages 协议'
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
      mcpServers: capabilities.mcpServers,
      sandbox: resolveRuntimeSandbox(sandboxMode),
      defaultWorkspace: workspace
    })
  }

  const modelApiKey =
    settings?.apiKey ||
    process.env.GOODBUDDY_MODEL_API_KEY?.trim() ||
    process.env.GOODBUDDY_BIGTOKEN_API_KEY?.trim()
  const modelAuthentication =
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
        settings?.modelBaseUrl ||
        process.env.GOODBUDDY_MODEL_BASE_URL?.trim() ||
        process.env.GOODBUDDY_BIGTOKEN_BASE_URL?.trim() ||
        defaultRuntimeSettings.modelBaseUrl,
      model:
        settings?.modelName ||
        process.env.GOODBUDDY_MODEL_NAME?.trim() ||
        process.env.GOODBUDDY_BIGTOKEN_MODEL?.trim() ||
        defaultRuntimeSettings.modelName,
      protocol:
        settings?.modelProtocol ??
        defaultRuntimeSettings.modelProtocol,
      authentication: modelAuthentication,
      skillInstructions: capabilities.skillInstructions
    })
  }

  return new UnconfiguredAgentRuntime()
}

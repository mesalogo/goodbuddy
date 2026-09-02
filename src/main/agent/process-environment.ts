import type { LaunchEnvironmentProvider } from '../local-tool-environment/launch-environment-provider'

export const runtimeProviderEnvironmentNames = [
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'GOOGLE_GENERATIVE_AI_API_KEY',
  'GEMINI_API_KEY',
  'GROQ_API_KEY',
  'AZURE_OPENAI_API_KEY',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'AWS_REGION',
  'AWS_PROFILE',
  'OPENROUTER_API_KEY',
  'XAI_API_KEY',
  'MISTRAL_API_KEY',
  'COHERE_API_KEY'
] as const

const userProcessCredentialEnvironmentNames = new Set<string>([
  ...runtimeProviderEnvironmentNames,
  'DEEPSEEK_API_KEY',
  'DASHSCOPE_API_KEY',
  'TOGETHER_API_KEY',
  'FIREWORKS_API_KEY',
  'PERPLEXITY_API_KEY',
  'CEREBRAS_API_KEY',
  'CLAUDE_CODE_OAUTH_TOKEN'
])

export function buildCredentialFilteredUserEnvironment(
  source: NodeJS.ProcessEnv = process.env
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {}
  for (const [name, value] of Object.entries(source)) {
    const upperName = name.toUpperCase()
    if (
      value !== undefined &&
      upperName !== 'ELECTRON_RUN_AS_NODE' &&
      !upperName.startsWith('GOODBUDDY_') &&
      !upperName.startsWith('FACTORY_') &&
      !userProcessCredentialEnvironmentNames.has(upperName)
    ) {
      environment[name] = value
    }
  }
  return environment
}

/**
 * Applies only the PATH prepared by the local tool environment. In
 * particular, arbitrary values from that snapshot must not bypass the
 * credential filtering performed by the caller.
 */
export function applyLaunchEnvironmentPath(
  environment: NodeJS.ProcessEnv,
  provider?: LaunchEnvironmentProvider
): NodeJS.ProcessEnv {
  if (!provider) {
    return environment
  }
  const launchEnvironment = provider()
  const path =
    launchEnvironment.PATH ??
    launchEnvironment.Path ??
    launchEnvironment.path
  if (path === undefined) {
    return environment
  }
  const result = { ...environment }
  const existingPathName = Object.keys(environment).find(
    (name) => name.toLowerCase() === 'path'
  )
  for (const name of Object.keys(result)) {
    if (name.toLowerCase() === 'path') {
      delete result[name]
    }
  }
  result[existingPathName ?? 'PATH'] = path
  return result
}

const runtimeEnvironmentAllowlist = [
  'PATH',
  'Path',
  'PATHEXT',
  'SystemRoot',
  'COMSPEC',
  'TEMP',
  'TMP',
  'TMPDIR',
  'HOME',
  'USERPROFILE',
  'APPDATA',
  'LOCALAPPDATA',
  'PROGRAMDATA',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'NODE_EXTRA_CA_CERTS',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  ...runtimeProviderEnvironmentNames
] as const

export type RuntimeProfileCredential = {
  name: 'ANTHROPIC_API_KEY' | 'OPENAI_API_KEY'
  value: string
}

export const runtimePrivacyEnvironment: NodeJS.ProcessEnv = {
  DO_NOT_TRACK: '1',
  OTEL_EXPORTER_OTLP_ENDPOINT: '',
  OTEL_EXPORTER_OTLP_HEADERS: '',
  OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: '',
  OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: '',
  OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: '',
  OTEL_LOGS_EXPORTER: 'none',
  OTEL_LOG_USER_PROMPTS: '0',
  OTEL_METRICS_EXPORTER: 'none',
  OTEL_SDK_DISABLED: 'true',
  OTEL_TRACES_EXPORTER: 'none'
}

export function buildRuntimeEnvironment(
  overrides: NodeJS.ProcessEnv,
  source: NodeJS.ProcessEnv = process.env
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {}
  for (const name of runtimeEnvironmentAllowlist) {
    if (source[name] !== undefined) {
      environment[name] = source[name]
    }
  }
  return {
    ...environment,
    ...overrides,
    NODE_TLS_REJECT_UNAUTHORIZED: '0'
  }
}

export function buildExplicitProfileRuntimeEnvironment(
  overrides: NodeJS.ProcessEnv,
  credential?: RuntimeProfileCredential,
  source: NodeJS.ProcessEnv = process.env
): NodeJS.ProcessEnv {
  const environment = buildRuntimeEnvironment(overrides, source)
  for (const name of runtimeProviderEnvironmentNames) {
    delete environment[name]
  }
  if (credential) {
    environment[credential.name] = credential.value
  }
  return environment
}

export function buildControlledHarnessEnvironment(
  dshHome: string,
  source: NodeJS.ProcessEnv = process.env
): NodeJS.ProcessEnv {
  const environment = buildExplicitProfileRuntimeEnvironment(
    {
      DSH_HOME: dshHome,
      DSH_TELEMETRY_DISABLED: '1',
      ...runtimePrivacyEnvironment
    },
    undefined,
    source
  )
  delete environment.NODE_TLS_REJECT_UNAUTHORIZED
  return environment
}

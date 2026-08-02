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
    ...overrides
  }
}

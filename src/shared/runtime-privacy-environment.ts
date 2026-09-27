/** Disable optional Runtime telemetry without restricting user-requested networking. */
export const runtimePrivacyEnvironment: Readonly<NodeJS.ProcessEnv> = Object.freeze({
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
})

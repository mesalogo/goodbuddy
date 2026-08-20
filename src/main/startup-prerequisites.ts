export type StartupPrerequisiteDependencies<ConfiguredRuntime> = {
  prepareDeepSeekHome: () => Promise<void>
  initializeKnowledgeAndGateway: () => Promise<void>
  hydrateConfiguredRuntime: () => Promise<ConfiguredRuntime>
  initializeAssistant: () => void
}

export type StartupPrerequisiteStage =
  | 'runtime-home'
  | 'knowledge'
  | 'runtime'
  | 'assistant-database'

export type StartupFailureStage =
  | StartupPrerequisiteStage
  | 'application'

export type StartupFailureDiagnostic = Readonly<{
  stages: readonly StartupFailureStage[]
  errorName: string
  causeName?: string
}>

export class StartupPrerequisiteError extends Error {
  readonly stage: StartupPrerequisiteStage
  readonly stages: readonly StartupPrerequisiteStage[]

  constructor(
    stage: StartupPrerequisiteStage,
    cause: unknown,
    stages: readonly StartupPrerequisiteStage[] = [stage]
  ) {
    super(`Startup prerequisite failed: ${stage}`, { cause })
    this.name = 'StartupPrerequisiteError'
    this.stage = stage
    this.stages = Object.freeze([...stages])
  }
}

const applicationFailureStages = Object.freeze([
  'application'
] satisfies StartupFailureStage[])

const safeErrorNames = new Set([
  'AbortError',
  'AggregateError',
  'Error',
  'EvalError',
  'RangeError',
  'ReferenceError',
  'SyntaxError',
  'TimeoutError',
  'TypeError',
  'URIError'
])

function safeErrorName(error: unknown): string {
  if (!(error instanceof Error)) {
    return 'NonError'
  }

  let name: unknown
  try {
    name = error.name
  } catch {
    return 'Error'
  }
  return typeof name === 'string' && safeErrorNames.has(name)
    ? name
    : 'Error'
}

export function getStartupFailureStages(
  error: unknown
): readonly StartupFailureStage[] {
  return error instanceof StartupPrerequisiteError
    ? error.stages
    : applicationFailureStages
}

export function formatStartupFailureMessage(error: unknown): string {
  const stages = getStartupFailureStages(error)
  return `启动初始化未完成（阶段：${stages.join(', ')}）。请重启应用；若问题持续，请记录阶段标识，并在备份数据后排查应用数据或 Runtime 配置。`
}

export function createStartupFailureDiagnostic(
  error: unknown
): StartupFailureDiagnostic {
  const stages = Object.freeze([...getStartupFailureStages(error)])
  if (error instanceof StartupPrerequisiteError) {
    return Object.freeze({
      stages,
      errorName: 'StartupPrerequisiteError',
      causeName: safeErrorName(error.cause)
    })
  }
  return Object.freeze({
    stages,
    errorName: safeErrorName(error)
  })
}

function startObserved<T>(operation: () => Promise<T>): Promise<T> {
  let started: Promise<T>
  try {
    started = Promise.resolve(operation())
  } catch (error) {
    started = Promise.reject(error)
  }
  void started.catch(() => undefined)
  return started
}

export async function runStartupPrerequisites<ConfiguredRuntime>(
  dependencies: StartupPrerequisiteDependencies<ConfiguredRuntime>
): Promise<ConfiguredRuntime> {
  const deepSeekHomeReady = startObserved(
    dependencies.prepareDeepSeekHome
  )
  const knowledgeAndGatewayReady = startObserved(
    dependencies.initializeKnowledgeAndGateway
  )
  const configuredRuntimeReady = startObserved(
    dependencies.hydrateConfiguredRuntime
  )

  let assistantInitializationFailed = false
  let assistantInitializationError: unknown
  try {
    dependencies.initializeAssistant()
  } catch (error) {
    assistantInitializationFailed = true
    assistantInitializationError = error
  }

  const [deepSeekHome, knowledgeAndGateway, configuredRuntime] =
    await Promise.allSettled([
      deepSeekHomeReady,
      knowledgeAndGatewayReady,
      configuredRuntimeReady
    ] as const)

  const failures: Array<
    Readonly<{
      stage: StartupPrerequisiteStage
      cause: unknown
    }>
  > = []
  if (assistantInitializationFailed) {
    failures.push({
      stage: 'assistant-database',
      cause: assistantInitializationError
    })
  }
  if (deepSeekHome.status === 'rejected') {
    failures.push({
      stage: 'runtime-home',
      cause: deepSeekHome.reason
    })
  }
  if (knowledgeAndGateway.status === 'rejected') {
    failures.push({
      stage: 'knowledge',
      cause: knowledgeAndGateway.reason
    })
  }
  if (configuredRuntime.status === 'rejected') {
    failures.push({
      stage: 'runtime',
      cause: configuredRuntime.reason
    })
  }

  const primaryFailure = failures[0]
  if (primaryFailure) {
    throw new StartupPrerequisiteError(
      primaryFailure.stage,
      primaryFailure.cause,
      failures.map(({ stage }) => stage)
    )
  }

  if (configuredRuntime.status === 'fulfilled') {
    return configuredRuntime.value
  }
  throw new Error('Unreachable startup prerequisite state')
}

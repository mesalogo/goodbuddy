export type StartupPrerequisiteDependencies<ConfiguredRuntime> = {
  prepareDeepSeekHome: () => Promise<void>
  initializeKnowledgeAndGateway: () => Promise<void>
  hydrateConfiguredRuntime: () => Promise<ConfiguredRuntime>
  initializeAssistant: () => void
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

  if (assistantInitializationFailed) {
    throw assistantInitializationError
  }
  if (deepSeekHome.status === 'rejected') {
    throw deepSeekHome.reason
  }
  if (knowledgeAndGateway.status === 'rejected') {
    throw knowledgeAndGateway.reason
  }
  if (configuredRuntime.status === 'rejected') {
    throw configuredRuntime.reason
  }
  return configuredRuntime.value
}

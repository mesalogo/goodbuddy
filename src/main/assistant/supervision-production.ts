import { randomUUID } from 'node:crypto'
import type { ApplicationSettings } from '../../shared/application-settings-contracts'
import { defaultSupervisionTimeoutSeconds, defaultSupervisorModelConcurrency } from '../../shared/application-settings-contracts'
import { defaultExperienceMinEvents, defaultStoryThreadEvents, supervisionReviewSettingsSchema } from '../../shared/supervision-review-contracts'
import type { SupervisionRunRequest } from '../../shared/supervision-contracts'
import type { ReviewConfiguration } from './supervision-review-store'
import { assignStories } from './supervision-stories'
import { extractExperiences } from './supervision-experiences'
import type { AgentRuntime, RuntimeModelUsageEvent } from '../agent/runtime'
import type { AssistantDatabase } from './assistant-database'
import type { SupervisionModelPool } from './supervision-model-pool'
import type { SuggestionPhraser } from './supervision-suggester'
import { SupervisorService } from './supervisor-service'

type SupervisionModelDependencies = {
  database: AssistantDatabase
  getSettings: () => Promise<Partial<ApplicationSettings> | undefined>
  resolveRuntime: () => Promise<AgentRuntime>
  pool: SupervisionModelPool
  persistUsage: (event: RuntimeModelUsageEvent) => void
}

/** One bounded, tool-free text call that shares the supervisor concurrency pool. */
async function runSupervisionModel(dependencies: SupervisionModelDependencies, request: {
  prompt: string
  title: string
  instructions: string
  timeoutMessage: (seconds: number) => string
  timeoutSeconds?: number
  signal?: AbortSignal
  authorizeTool: (name: string) => Promise<never>
}): Promise<string> {
  const { database, getSettings, resolveRuntime, pool, persistUsage } = dependencies
  const settings = await getSettings()
  pool.setLimit(settings?.supervisorModelConcurrency ?? defaultSupervisorModelConcurrency)
  return pool.run(async signal => {
    const timeoutSeconds = request.timeoutSeconds ?? settings?.supervisorOrganizeTimeoutSeconds ?? defaultSupervisionTimeoutSeconds
    const runtime = await resolveRuntime()
    const controller = new AbortController()
    const modelSignal = AbortSignal.any([signal, controller.signal, ...(request.signal ? [request.signal] : [])])
    modelSignal.throwIfAborted()
    let timeoutError: Error | undefined
    const timeout = setTimeout(() => {
      timeoutError = new Error(request.timeoutMessage(timeoutSeconds))
      controller.abort(timeoutError)
    }, timeoutSeconds * 1000)
    const responseKiB = settings?.supervisionReview?.responseKiB ?? 1024
    let output = '', completed = false
    const requestId = randomUUID()
    const conversationId = `supervision:${requestId}`
    // Hidden task row so model usage can be attributed to supervision.
    database.createTask({ id: requestId, conversationId, title: request.title, instructions: request.instructions,
      origin: 'assistant', visible: false })
    try {
      for await (const event of runtime.run({ requestId, conversationId, prompt: request.prompt },
        modelSignal, async approval => { await request.authorizeTool(approval.toolName ?? approval.scopeKey); return 'deny' })) {
        if (event.type === 'text') {
          output += event.delta
          if (Buffer.byteLength(output) > responseKiB * 1024) {
            controller.abort(new Error(`单次模型响应超过 ${responseKiB} KiB。请在监督者设置中调高响应容量后继续；已保存批次会保留。`))
            modelSignal.throwIfAborted()
          }
        }
        if (event.type === 'model-usage') persistUsage(event)
        if (event.type === 'tool') throw new Error('监督者只允许只读模型摘要，不允许工具调用')
        if (event.type === 'error') throw new Error(event.message)
        if (event.type === 'done') completed = true
      }
      modelSignal.throwIfAborted()
      if (!completed) throw new Error('监督者模型未报告完成')
      database.updateTaskStatus(requestId, 'completed')
      return output
    } catch (error) {
      const failure = timeoutError ?? error
      try {
        database.updateTaskStatus(requestId, modelSignal.aborted ? 'cancelled' : 'failed',
          failure instanceof Error ? failure.message.slice(0, 2_000) : '监督者模型调用失败')
      } catch { /* status bookkeeping must not mask the model failure */ }
      throw failure
    }
    finally { clearTimeout(timeout); await runtime.releaseConversation?.(conversationId) }
  }, request.signal)
}

function dependencies(
  database: AssistantDatabase,
  getSettings: () => Promise<Partial<ApplicationSettings> | undefined>,
  resolveRuntime: (profileId?: string | null) => Promise<AgentRuntime>,
  pool: SupervisionModelPool,
  persistUsage?: (event: RuntimeModelUsageEvent) => void
): SupervisionModelDependencies {
  return { database, getSettings, resolveRuntime, pool, persistUsage: persistUsage ?? (event => database.upsertModelUsageCall({
    requestId: event.requestId, callId: event.callId, runtime: event.runtime, provider: event.provider, model: event.model,
    input: event.inputTokens, output: event.outputTokens, cacheRead: event.cacheReadTokens, cacheWrite: event.cacheWriteTokens
  })) }
}

export function createProductionSupervisorService(
  database: AssistantDatabase,
  getSettings: () => Promise<Partial<ApplicationSettings> | undefined>,
  resolveRuntime: (profileId?: string | null) => Promise<AgentRuntime>,
  pool: SupervisionModelPool,
  persistUsage?: (event: RuntimeModelUsageEvent) => void
): SupervisorService {
  // The service admits only one execution at a time, including resume and story retry.
  let runtime: AgentRuntime | undefined
  const model = dependencies(database, getSettings, async () => {
    if (!runtime) throw new Error('Supervisor model execution is not active')
    return runtime
  }, pool, persistUsage)
  return new SupervisorService({ collect: async () => { throw new Error('Paged review collector required') } }, {
    summarize: async request => runSupervisionModel(model, {
      title: '监督者回顾', instructions: '根据有界证据整理监督者回顾',
      timeoutMessage: seconds => `监督者整理模型阶段超过 ${seconds} 秒，已停止本次回顾；未保存结果`, timeoutSeconds: request.timeoutSeconds,
      signal: request.signal, authorizeTool: request.authorizeTool,
      prompt: [request.systemInstruction, 'OUTPUT CONTRACT:', request.outputContract,
        'REVIEW TIME RANGE:', JSON.stringify(request.request.timeRange), 'KNOWN ENTITIES:', JSON.stringify(request.candidates.map((candidate, index) => ({
          candidateRef: `known_${index + 1}`, label: candidate.label, description: candidate.description
        }))),
        'PREVIOUS SUMMARY (background only):', request.previousSummary ?? '',
        'CURRENT MEMORY (background only; do not cite as new evidence):', JSON.stringify(request.background ?? []),
        'BOUNDED EVIDENCE:', JSON.stringify(request.evidence), 'Return only JSON.'].join('\n\n')
    })
  }, {
    scope: scope => database.resolveReviewScope(scope), summary: request => database.reviewSummary(request.scope, 'supervisor'),
    background: request => database.reviewBackground(request.scope),
    start: (request, heartbeatRunId) => database.startSupervisionRun(request, heartbeatRunId),
    fail: (runId, error) => database.failSupervisionRun(runId, error), noChange: runId => database.noChangeSupervisionRun(runId),
    candidates: request => database.supervisionCandidates(request), save: async result => database.saveSupervisionResult(result)
  }, { database: () => database.supervisionReviewStore(),
    initialize: (runId, state, signal) => database.initializeSupervisionReview(runId, state, signal),
    resume: (runId, signal) => database.resumeSupervisionReview(runId, signal),
    context: (request, signal) => database.supervisionContext(request, signal),
    withExecution: async operation => {
    runtime = await resolveRuntime((await getSettings())?.supervisorModelProfileId)
    try { return await operation() }
    finally {
      const completed = runtime
      runtime = undefined
      await completed.dispose?.()
    }
  }, configuration: async () => {
    const settings = await getSettings()
    return { ...supervisionReviewSettingsSchema.parse(settings?.supervisionReview ?? {}), version: 1,
      timeoutSeconds: settings?.supervisorOrganizeTimeoutSeconds ?? defaultSupervisionTimeoutSeconds,
      concurrency: settings?.supervisorModelConcurrency ?? defaultSupervisorModelConcurrency }
  }, stories: (request, config, signal) => organizeSupervisionStories(model, request, config, signal) })
}

/** Story assignment for the review's scope: event text and story summaries only, one bounded call per chunk. */
async function organizeSupervisionStories(model: SupervisionModelDependencies, request: SupervisionRunRequest, config: ReviewConfiguration, signal: AbortSignal) {
  const run = (title: string, prompt: string, modelSignal?: AbortSignal) => runSupervisionModel(model, {
    title, instructions: title,
    timeoutMessage: seconds => `${title}超时 ${seconds} 秒，已停止；回顾结果已保留`, timeoutSeconds: config.timeoutSeconds,
    signal: modelSignal, authorizeTool: async name => { throw new Error(`监督者禁止调用工具 ${name}`) }, prompt
  })
  const result = await assignStoriesStep(model, request, config, signal)
  // Experiences read stories, so they follow assignment; a failure keeps the assigned stories.
  try {
    const experiences = await extractExperiences(model.database.supervisionExperiences(), (prompt, modelSignal) => run('监督者经验整理', prompt, modelSignal),
      { minEvents: config.experienceMinEvents ?? defaultExperienceMinEvents, batchCharacters: Math.max(4000, config.batchCharacters * 2), signal })
    return { ...result, experiences: { status: 'completed' as const, ...experiences } }
  } catch (error) {
    if (signal.aborted) throw error
    return { ...result, experiences: { status: 'failed' as const, error: error instanceof Error ? error.message.slice(0, 2000) : 'Experience extraction failed' } }
  }
}

async function assignStoriesStep(model: SupervisionModelDependencies, request: SupervisionRunRequest, config: ReviewConfiguration, signal: AbortSignal) {
  const result = await assignStories(model.database.supervisionStories(), (prompt, modelSignal) => runSupervisionModel(model, {
    title: '监督者故事整理', instructions: '把已发布的事件归入故事',
    timeoutMessage: seconds => `监督者故事整理超过 ${seconds} 秒，已停止；回顾结果已保留`, timeoutSeconds: config.timeoutSeconds,
    signal: modelSignal, authorizeTool: async name => { throw new Error(`监督者禁止调用工具: ${name}`) }, prompt
  }), request.scope, { crossProject: config.crossProject === true, threadEvents: config.storyThreadEvents ?? defaultStoryThreadEvents,
    batchCharacters: Math.max(4000, config.batchCharacters * 2), concurrency: config.concurrency, signal })
  return { status: 'completed' as const, ...result }
}

/** Phrases rule-selected suggestion candidates in one bounded model call. */
export function createProductionSuggestionPhraser(
  database: AssistantDatabase,
  getSettings: () => Promise<Partial<ApplicationSettings> | undefined>,
  resolveRuntime: (profileId?: string | null) => Promise<AgentRuntime>,
  pool: SupervisionModelPool,
  persistUsage?: (event: RuntimeModelUsageEvent) => void
): SuggestionPhraser {
  return async request => {
    const runtime = await resolveRuntime((await getSettings())?.supervisorModelProfileId)
    const model = dependencies(database, getSettings, async () => runtime, pool, persistUsage)
    try {
      return await runSupervisionModel(model, {
        title: '监督者建议', instructions: '根据已发布的图谱变化生成建议',
        timeoutMessage: seconds => `监督者建议生成超过 ${seconds} 秒，已停止；回顾结果已保留`,
        authorizeTool: async name => { throw new Error(`监督者禁止调用工具: ${name}`) },
        prompt: [request.systemInstruction, 'OUTPUT CONTRACT:', request.outputContract,
          'CANDIDATES:', JSON.stringify(request.candidates), 'Return only JSON.'].join('\n\n')
      })
    } finally { await runtime.dispose?.() }
  }
}

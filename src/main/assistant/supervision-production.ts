import { randomUUID } from 'node:crypto'
import type { ApplicationSettings } from '../../shared/application-settings-contracts'
import { defaultSupervisionTimeoutSeconds, defaultSupervisorModelConcurrency } from '../../shared/application-settings-contracts'
import { supervisionReviewSettingsSchema } from '../../shared/supervision-review-contracts'
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
      workMode: 'ask', origin: 'assistant', visible: false })
    try {
      for await (const event of runtime.run({ requestId, conversationId, workMode: 'ask', prompt: request.prompt },
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
  resolveRuntime: () => Promise<AgentRuntime>,
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
  resolveRuntime: () => Promise<AgentRuntime>,
  pool: SupervisionModelPool,
  persistUsage?: (event: RuntimeModelUsageEvent) => void
): SupervisorService {
  const model = dependencies(database, getSettings, resolveRuntime, pool, persistUsage)
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
    candidates: async request => database.listSupervisionCandidates(request), save: async result => database.saveSupervisionResult(result)
  }, { database: () => database.supervisionReviewStore(), configuration: async () => {
    const settings = await getSettings()
    return { ...supervisionReviewSettingsSchema.parse(settings?.supervisionReview ?? {}), version: 1,
      timeoutSeconds: settings?.supervisorOrganizeTimeoutSeconds ?? defaultSupervisionTimeoutSeconds,
      concurrency: settings?.supervisorModelConcurrency ?? defaultSupervisorModelConcurrency }
  } })
}

/** Phrases rule-selected suggestion candidates in one bounded model call. */
export function createProductionSuggestionPhraser(
  database: AssistantDatabase,
  getSettings: () => Promise<Partial<ApplicationSettings> | undefined>,
  resolveRuntime: () => Promise<AgentRuntime>,
  pool: SupervisionModelPool,
  persistUsage?: (event: RuntimeModelUsageEvent) => void
): SuggestionPhraser {
  const model = dependencies(database, getSettings, resolveRuntime, pool, persistUsage)
  return async request => runSupervisionModel(model, {
    title: '监督者建议', instructions: '根据已发布的图谱变化生成建议',
    timeoutMessage: seconds => `监督者建议生成超过 ${seconds} 秒，已停止；回顾结果已保留`,
    authorizeTool: async name => { throw new Error(`监督者禁止调用工具: ${name}`) },
    prompt: [request.systemInstruction, 'OUTPUT CONTRACT:', request.outputContract,
      'CANDIDATES:', JSON.stringify(request.candidates), 'Return only JSON.'].join('\n\n')
  })
}

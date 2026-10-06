import { randomUUID } from 'node:crypto'
import type { ApplicationSettings } from '../../shared/application-settings-contracts'
import { defaultSupervisionTimeoutSeconds, defaultSupervisorModelConcurrency } from '../../shared/application-settings-contracts'
import { defaultExperienceMinEvents, defaultStoryThreadEvents, supervisionReviewSettingsSchema } from '../../shared/supervision-review-contracts'
import type { SupervisionRunRequest } from '../../shared/supervision-contracts'
import type { ReviewConfiguration } from './supervision-review-store'
import { assignStories } from './story-assignment-service'
import { extractExperiences } from './experience-extraction-service'
import type { AgentRuntime, RuntimeModelUsageEvent } from '../agent/runtime'
import type { Awaitable, SupervisionDomainPort } from './supervision-domain-ports'
import type { SupervisionModelPool } from './supervision-model-pool'
import type { SuggestionPhraser } from './supervision-suggester'
import { SupervisorService } from './supervisor-service'

type SupervisionModelDependencies = {
  database: SupervisionDomainPort
  getSettings: () => Promise<Partial<ApplicationSettings> | undefined>
  resolveRuntime: () => Promise<AgentRuntime>
  pool: SupervisionModelPool
  persistUsage: (event: RuntimeModelUsageEvent) => Awaitable<void>
}

function isTransientSupervisionError(error: unknown): boolean {
  let transient = false
  const seen = new Set<unknown>()
  for (let current = error; current && typeof current === 'object' && !seen.has(current);) {
    seen.add(current)
    const record = current as Record<string, unknown>
    const message = typeof record.message === 'string' ? record.message : ''
    const code = typeof record.code === 'string' ? record.code : ''
    // Direct-model errors retain status; runtime events carry only the public message.
    const status = record.status ?? record.statusCode ?? /\bHTTP\s+(\d{3})\b/iu.exec(message)?.[1]
    const failureText = Number(status) === 504 ? message.replace(/\bgateway (?:timeout|timed out)\b/giu, '') : message
    if (record.name === 'AbortError' || record.name === 'TimeoutError' ||
      /^(?:ENOTFOUND|ERR_INVALID_URL|CERT_.*|.*CERTIFICATE.*|DEPTH_ZERO_SELF_SIGNED_CERT)$/u.test(code) ||
      /abort|cancel|timed?\s*out|timeout|超时|取消|容量|context[_ ](?:length|window)|max[_ ]tokens|quota|billing|insufficient|capacity|api[_ -]?key|unauthori[sz]ed|forbidden|authentication|configuration/iu.test(`${code} ${failureText}`)) return false
    if (status !== undefined) {
      if (![429, 500, 502, 503, 504].includes(Number(status))) return false
      transient = true
    }
    if (/^(?:ECONNRESET|ECONNREFUSED|EPIPE|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH|UND_ERR_SOCKET)$/u.test(code) ||
      /^(?:TypeError:\s*)?(?:terminated|fetch failed|network error|socket hang up)$/iu.test(message) ||
      message === '模型接口流式响应意外中断' || /^rate limit (?:exceeded|reached)\b/iu.test(message)) transient = true
    current = record.cause
  }
  return transient
}

/** One bounded, tool-free text call, with one transient retry in the supervisor pool. */
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
    for (let attempt = 0; ; attempt++) {
      signal.throwIfAborted()
      const controller = new AbortController()
      const modelSignal = AbortSignal.any([signal, controller.signal])
      let timeoutError: Error | undefined
      const timeout = setTimeout(() => {
        timeoutError = new Error(request.timeoutMessage(timeoutSeconds))
        controller.abort(timeoutError)
      }, timeoutSeconds * 1000)
      const responseKiB = settings?.supervisionReview?.responseKiB ?? 1024
      let output = '', completed = false
      let overflowError: Error | undefined
      let drainTimeout: ReturnType<typeof setTimeout> | undefined
      let drainDeadline: Promise<never> | undefined
      let events: ReturnType<AgentRuntime['run']> | undefined
      const requestId = randomUUID()
      const conversationId = `supervision:${requestId}`
      let persistenceFailed = false
      const commit = async <T>(operation: () => Awaitable<T>): Promise<T> => {
        try { return await operation() }
        catch (error) { persistenceFailed = true; throw error }
      }
      try {
        // Each attempt has its own hidden task so reported usage survives retries.
        await commit(() => database.createTask({ id: requestId, conversationId, title: request.title, instructions: request.instructions,
          origin: 'assistant', visible: false }))
        modelSignal.throwIfAborted()
        events = runtime.run({ requestId, conversationId, prompt: request.prompt },
          modelSignal, async approval => { await request.authorizeTool(approval.toolName ?? approval.scopeKey); return 'deny' })
        while (true) {
          const next = events.next()
          const step = await (drainDeadline ? Promise.race([next, drainDeadline]) : next)
          if (step.done) break
          const event = step.value
          if (event.type === 'model-usage') await commit(() => persistUsage(event))
          if (overflowError) continue
          if (event.type === 'text') {
            if (Buffer.byteLength(output + event.delta) > responseKiB * 1024) {
              overflowError = new Error(`单次模型响应超过 ${responseKiB} KiB。请在监督者设置中调高响应容量后继续；已保存批次会保留。`)
              output = ''
              controller.abort(overflowError)
              // Let the aborted stream emit usage, but never retain further text
              // or let an unresponsive iterator hold the supervisor pool forever.
              drainDeadline = new Promise<never>((_resolve, reject) => {
                drainTimeout = setTimeout(() => reject(overflowError), 1_000)
              })
            } else output += event.delta
          }
          if (event.type === 'tool') throw new Error('监督者只允许只读模型摘要，不允许工具调用')
          if (event.type === 'error') {
            const error = new Error(event.message)
            if (event.status === 'cancelled') controller.abort(error)
            throw error
          }
          if (event.type === 'done') completed = true
        }
        modelSignal.throwIfAborted()
        if (!completed) throw new Error('监督者模型未报告完成')
        await commit(() => database.updateTaskStatus(requestId, 'completed'))
        return output
      } catch (error) {
        const failure = overflowError ?? timeoutError ?? (modelSignal.aborted ? modelSignal.reason : error)
        try {
          await database.updateTaskStatus(requestId, modelSignal.aborted ? 'cancelled' : 'failed',
            failure instanceof Error ? failure.message.slice(0, 2_000) : '监督者模型调用失败')
        } catch { persistenceFailed = true /* Keep the model error, but do not retry after an unconfirmed write. */ }
        if (persistenceFailed || attempt > 0 || modelSignal.aborted || !isTransientSupervisionError(failure)) throw failure
      } finally {
        clearTimeout(timeout)
        clearTimeout(drainTimeout)
        controller.abort()
        const closing = events?.return().catch(() => undefined)
        if (!overflowError) await closing
        await runtime.releaseConversation?.(conversationId)
      }
      signal.throwIfAborted()
      await new Promise<void>((resolve, reject) => {
        const abort = () => { clearTimeout(wait); reject(signal.reason) }
        const wait = setTimeout(() => { signal.removeEventListener('abort', abort); resolve() }, 500)
        signal.addEventListener('abort', abort, { once: true })
      })
    }
  }, request.signal)
}

function dependencies(
  database: SupervisionDomainPort,
  getSettings: () => Promise<Partial<ApplicationSettings> | undefined>,
  resolveRuntime: (profileId?: string | null) => Promise<AgentRuntime>,
  pool: SupervisionModelPool,
  persistUsage?: (event: RuntimeModelUsageEvent) => Awaitable<void>
): SupervisionModelDependencies {
  return { database, getSettings, resolveRuntime, pool, persistUsage: persistUsage ?? (async event => { await database.upsertModelUsageCall({
    requestId: event.requestId, callId: event.callId, runtime: event.runtime, provider: event.provider, model: event.model,
    input: event.inputTokens, output: event.outputTokens, cacheRead: event.cacheReadTokens, cacheWrite: event.cacheWriteTokens
  }) }) }
}

export function createProductionSupervisorService(
  database: SupervisionDomainPort,
  getSettings: () => Promise<Partial<ApplicationSettings> | undefined>,
  resolveRuntime: (profileId?: string | null) => Promise<AgentRuntime>,
  pool: SupervisionModelPool,
  persistUsage?: (event: RuntimeModelUsageEvent) => Awaitable<void>
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
    candidates: async (request, batch) => database.supervisionCandidates(request, batch), save: async result => database.saveSupervisionResult(result)
  }, { database: () => database.supervisionReviewStore(),
    initialize: async (runId, state, signal) => database.initializeSupervisionReview(runId, state, signal),
    resume: async (runId, signal) => database.resumeSupervisionReview(runId, signal),
    context: async (request, signal) => database.supervisionContext(request, signal),
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
    const experiences = await extractExperiences(await model.database.supervisionExperiences(), (prompt, modelSignal) => run('监督者经验整理', prompt, modelSignal),
      { minEvents: config.experienceMinEvents ?? defaultExperienceMinEvents, batchCharacters: Math.max(4000, config.batchCharacters * 2), signal })
    return { ...result, experiences: { status: 'completed' as const, ...experiences } }
  } catch (error) {
    if (signal.aborted) throw error
    return { ...result, experiences: { status: 'failed' as const, error: error instanceof Error ? error.message.slice(0, 2000) : 'Experience extraction failed' } }
  }
}

async function assignStoriesStep(model: SupervisionModelDependencies, request: SupervisionRunRequest, config: ReviewConfiguration, signal: AbortSignal) {
  const result = await assignStories(await model.database.supervisionStories(), (prompt, modelSignal) => runSupervisionModel(model, {
    title: '监督者故事整理', instructions: '把已发布的事件归入故事',
    timeoutMessage: seconds => `监督者故事整理超过 ${seconds} 秒，已停止；回顾结果已保留`, timeoutSeconds: config.timeoutSeconds,
    signal: modelSignal, authorizeTool: async name => { throw new Error(`监督者禁止调用工具: ${name}`) }, prompt
  }), request.scope, { crossProject: config.crossProject === true, threadEvents: config.storyThreadEvents ?? defaultStoryThreadEvents,
    batchCharacters: Math.max(4000, config.batchCharacters * 2), concurrency: config.concurrency, signal })
  return { status: 'completed' as const, ...result }
}

/** Phrases rule-selected suggestion candidates in one bounded model call. */
export function createProductionSuggestionPhraser(
  database: SupervisionDomainPort,
  getSettings: () => Promise<Partial<ApplicationSettings> | undefined>,
  resolveRuntime: (profileId?: string | null) => Promise<AgentRuntime>,
  pool: SupervisionModelPool,
  persistUsage?: (event: RuntimeModelUsageEvent) => Awaitable<void>
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

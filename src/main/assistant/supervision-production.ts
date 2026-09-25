import { randomUUID } from 'node:crypto'
import type { ApplicationSettings } from '../../shared/application-settings-contracts'
import { defaultSupervisionTimeoutSeconds, defaultSupervisorModelConcurrency } from '../../shared/application-settings-contracts'
import { supervisionReviewSettingsSchema } from '../../shared/supervision-review-contracts'
import type { AgentRuntime } from '../agent/runtime'
import type { AssistantDatabase } from './assistant-database'
import type { SupervisionModelPool } from './supervision-model-pool'
import { SupervisorService } from './supervisor-service'

export function createProductionSupervisorService(
  database: AssistantDatabase,
  getSettings: () => Promise<Partial<ApplicationSettings> | undefined>,
  resolveRuntime: () => Promise<AgentRuntime>,
  pool: SupervisionModelPool
): SupervisorService {
  return new SupervisorService({ collect: async () => { throw new Error('Paged review collector required') } }, {
    summarize: async request => {
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
          timeoutError = new Error(`监督者整理模型阶段超过 ${timeoutSeconds} 秒，已停止本次回顾；未保存结果`)
          controller.abort(timeoutError)
        }, timeoutSeconds * 1000)
        const responseKiB = settings?.supervisionReview?.responseKiB ?? 1024
        let output = '', completed = false
        const conversationId = `supervision:${randomUUID()}`
        try {
          for await (const event of runtime.run({ requestId: randomUUID(), conversationId, workMode: 'ask',
            prompt: [request.systemInstruction, 'OUTPUT CONTRACT:', request.outputContract,
              'REVIEW TIME RANGE:', JSON.stringify(request.request.timeRange), 'KNOWN ENTITIES:', JSON.stringify(request.candidates.map((candidate, index) => ({
                candidateRef: `known_${index + 1}`, label: candidate.label, description: candidate.description
              }))),
              'PREVIOUS SUMMARY (background only):', request.previousSummary ?? '',
              'CURRENT MEMORY (background only; do not cite as new evidence):', JSON.stringify(request.background ?? []),
              'BOUNDED EVIDENCE:', JSON.stringify(request.evidence), 'Return only JSON.'].join('\n\n')
          }, modelSignal, async approval => { await request.authorizeTool(approval.toolName ?? approval.scopeKey); return 'deny' })) {
            if (event.type === 'text') {
              output += event.delta
              if (Buffer.byteLength(output) > responseKiB * 1024) {
                controller.abort(new Error(`单次模型响应超过 ${responseKiB} KiB。请在监督者设置中调高响应容量后继续；已保存批次会保留。`))
                modelSignal.throwIfAborted()
              }
            }
            if (event.type === 'tool') throw new Error('监督者只允许只读模型摘要，不允许工具调用')
            if (event.type === 'error') throw new Error(event.message)
            if (event.type === 'done') completed = true
          }
          modelSignal.throwIfAborted()
          if (!completed) throw new Error('监督者模型未报告完成')
          return output
        } catch (error) { throw timeoutError ?? error }
        finally { clearTimeout(timeout); await runtime.releaseConversation?.(conversationId) }
      }, request.signal)
    }
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

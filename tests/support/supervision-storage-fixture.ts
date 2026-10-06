import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { app } from 'electron'
import { DesktopStorageClient } from '../../src/main/desktop-storage-client'
import { createSupervisionDomainPorts } from '../../src/main/assistant/supervision-domain-ports'
import { createProductionSupervisorService, createProductionSuggestionPhraser } from '../../src/main/assistant/supervision-production'
import { SupervisionModelPool } from '../../src/main/assistant/supervision-model-pool'
import { HeartbeatService } from '../../src/main/assistant/heartbeat-service'
import { deriveSuggestions } from '../../src/main/assistant/supervision-suggester'
import type { AgentRuntime } from '../../src/main/agent/runtime'
import type { SupervisionEvidence, SupervisionRunRequest } from '../../src/shared/supervision-contracts'

const root = process.env.GB_SUPERVISION_STORAGE_ROOT!
app.setPath('userData', join(root, 'electron'))
async function run(): Promise<void> {
  await app.whenReady()
  const storage = new DesktopStorageClient({ assistantPath: join(root, 'assistant.sqlite'), knowledgePath: join(root, 'knowledge.sqlite'),
    defaultRootPath: root, userDataPath: root, entryPath: join(root, 'desktop-storage-entry.mjs'),
    readerWorkerPath: join(root, 'readonly-query-worker.cjs'), upgradeWorkerPath: join(root, 'assistant-storage-worker.cjs') })
  const pool = new SupervisionModelPool()
  try {
    await storage.ready
    const ports = createSupervisionDomainPorts(storage)
    const project = (await storage.call('assistant', 'listProjects', []))[0]!
    const now = Date.now()
    const seed = async (content: string) => storage.call('assistant', 'saveLocalConversations', [[{
      header: { id: randomUUID(), projectId: project.id, title: 'Review fixture', updatedAt: now },
      messages: [{ id: randomUUID(), role: 'user', content, state: 'complete', createdAt: now }]
    }]])
    await seed('A'.repeat(1500))
    const request: SupervisionRunRequest = { trigger: 'heartbeat', scope: { kind: 'global' },
      timeRange: { from: new Date(now - 1000).toISOString(), to: new Date(now + 10000).toISOString() } }
    const phases: string[] = []
    let block = false
    let entered!: () => void
    const modelEntered = new Promise<void>(resolve => { entered = resolve })
    const runtime: AgentRuntime = { runtimeId: 'model', capability: 'chat', requiresToolApproval: false, supportsToolExecution: false,
      getStatus: async () => ({ id: 'model', label: 'Fixture', available: true, detail: 'Fixture ready', supportsToolExecution: false }),
      dispose: async () => {},
      run: async function* (input, signal) {
        if (block) {
          entered()
          await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }))
          yield { type: 'error', requestId: input.requestId, status: 'cancelled', message: 'Cancelled fixture' }
          return
        }
        let output: unknown
        const empty = { summary: 'Review', changeDigest: '', openItems: ['Choose the next milestone'], events: [], entities: [], entityChanges: [], relations: [] }
        if (input.prompt.includes('You organise the GoodBuddy')) {
          phases.push('stories')
          output = { stories: [{ key: 'new_1', level: 'feature', name: 'Delivery' }],
            assignments: [{ event: 'e_1', story: 'new_1' }, { event: 'e_2', story: 'new_1' }] }
        } else if (input.prompt.includes('You distil reusable experience')) {
          phases.push('experiences')
          output = { experiences: [{ key: 'new_1', statement: 'Check the assumption before publishing', formed: ['e_1'] }] }
        } else if (input.prompt.includes('You write short, concrete suggestions')) {
          phases.push('suggestions')
          const candidates = JSON.parse(input.prompt.split('CANDIDATES:\n\n')[1]!.split('\n\nReturn only JSON.')[0]!)
          output = { suggestions: candidates }
        } else if (input.prompt.includes('These inputs are navigation summaries')) {
          phases.push('navigation')
          output = empty
        } else {
          phases.push('leaf')
          const evidence = JSON.parse(input.prompt.split('BOUNDED EVIDENCE:\n\n')[1]!.split('\n\nReturn only JSON.')[0]!) as SupervisionEvidence[]
          output = { ...empty, events: [{ title: 'Decide delivery approach', description: 'Validate the assumption first', eventType: 'decision',
            occurredAt: new Date(now).toISOString(), entityIds: [], sourceReferenceIds: [evidence[0]!.id] }] }
        }
        yield { type: 'text', requestId: input.requestId, delta: JSON.stringify(output) }
        yield { type: 'model-usage', requestId: input.requestId, callId: 'call', runtime: 'model', provider: 'fixture', model: 'fixture',
          inputTokens: 4, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 }
        yield { type: 'done', requestId: input.requestId }
      } }
    const settings = async () => ({ supervisionReview: { pageSize: 10, batchCharacters: 1000, batchMessages: 10,
      executionSeconds: 300, experienceMinEvents: 2 } })
    const supervisor = createProductionSupervisorService(ports.supervision, settings, async () => runtime, pool)
    const phrase = createProductionSuggestionPhraser(ports.supervision, settings, async () => runtime, pool)
    const heartbeat = new HeartbeatService(ports.heartbeat, {
      review: async ({ run }) => {
        const result = await supervisor.run(request, run.id)
        return { status: result.status ?? 'completed', runId: result.runId }
      },
      suggest: async ({ run, supervisionRunId }) => deriveSuggestions(ports.suggestions, phrase, { heartbeatRunId: run.id, supervisionRunId })
    })
    const config = await heartbeat.create({ name: 'Fixture', scope: request.scope, timezone: 'UTC', recurrence: { type: 'daily', localTime: '09:00' },
      enabled: true, lookbackHours: 24, retentionDays: 30 })
    const first = await heartbeat.runNow({ id: config.id, idempotencyKey: 'first' })
    assert.equal(first.status, 'completed')
    assert.deepEqual(phases, ['leaf', 'leaf', 'navigation', 'stories', 'experiences', 'suggestions'])
    assert.equal((await ports.stories.list(request.scope)).length, 1)
    assert.equal((await ports.experiences.list()).length, 1)
    assert.ok(await ports.suggestions.countForHeartbeat(first.id) > 0)
    assert.equal((await storage.call('assistant', 'getTokenUsageSummary', [])).systemTotals?.callCount, 6)
    assert.equal((await heartbeat.runNow({ id: config.id, idempotencyKey: 'quiet' })).status, 'no_change')
    assert.equal(phases.length, 6)
    await seed('A new decision')
    block = true
    const pending = supervisor.run(request)
    await modelEntered
    const runId = supervisor.execution().runId!
    await supervisor.cancel(runId)
    assert.equal((await pending).status, 'cancelled')
    assert.equal(supervisor.execution().active, false)
    assert.equal((await storage.call('assistant', 'listSupervisionActivity', [])).find(row => row.id === runId)!.status, 'cancelled')
    assert.equal(storage.pendingCount, 0)
    console.log('supervision-storage: passed')
  } finally { pool.dispose(); await storage.close() }
}
void run().then(() => app.exit(0), error => { console.error(error); app.exit(1) })

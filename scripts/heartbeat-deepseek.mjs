// Isolated live check of the heartbeat → incremental review → suggestion path.
// Uses a throwaway SQLite database and the DeepSeek profile from an env file.
// Usage: node scripts/heartbeat-deepseek.cjs <env-file> <output-directory>
/* global process, fetch, AbortSignal, console */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { parseEnv } from 'node:util'
import { AssistantDatabase } from '../src/main/assistant/assistant-database.ts'
import { SupervisorService } from '../src/main/assistant/supervisor-service.ts'
import { HeartbeatService } from '../src/main/assistant/heartbeat-service.ts'
import { deriveSuggestions } from '../src/main/assistant/supervision-suggester.ts'

const [envPath, directory] = process.argv.slice(2)
const config = parseEnv(readFileSync(envPath, 'utf8'))
assert(config.DEEPSEEK_BASE_URL && config.DEEPSEEK_API_KEY && config.DEEPSEEK_MODEL, 'DeepSeek configuration unavailable')
mkdirSync(directory, { recursive: true })
const calls = []
const maximumCalls = 6

async function model(stage, prompt) {
  assert(calls.length < maximumCalls, 'Live request budget exhausted')
  const entry = { stage, inputCharacters: prompt.length }
  calls.push(entry)
  const started = Date.now()
  const url = config.DEEPSEEK_BASE_URL.replace(/\/+$/, '')
  const response = await fetch(url.endsWith('/chat/completions') ? url : `${url}/chat/completions`, {
    method: 'POST', headers: { Authorization: `Bearer ${config.DEEPSEEK_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: config.DEEPSEEK_MODEL, messages: [{ role: 'user', content: prompt }], stream: false,
      temperature: 0, max_tokens: 8192, response_format: { type: 'json_object' } }),
    signal: AbortSignal.timeout(180_000)
  })
  entry.status = response.status
  assert(response.ok, `Provider HTTP ${response.status}`)
  const body = await response.json()
  entry.model = body.model
  entry.usage = body.usage
  entry.ms = Date.now() - started
  return body.choices[0].message.content
}

const path = join(directory, 'assistant.sqlite')
const db = new AssistantDatabase(path)
db.initialize(directory)
const sql = new DatabaseSync(path)
const report = { calls }
try {
  const now = Date.now()
  const project = db.listProjects()[0]
  const conversationId = randomUUID()
  const messages = [
    ['user', '监督者回顾最初的方案是：单次整理执行 300 秒后自动暂停，用户点击继续。'],
    ['assistant', '可以，这样能控制单轮成本。'],
    ['user', '不对，回顾应该持续执行直到完成或者我主动取消，不要每 300 秒暂停。单次模型超时和并发限制保留。'],
    ['assistant', '明白，改为持续执行，保留单次超时与并发限制。'],
    ['user', '还有一个没定：每页读取多少条消息比较合适，50 还是 100？这个下次再决定。']
  ].map(([role, content], index) => ({ id: randomUUID(), role, content, state: 'complete', createdAt: now - (10 - index) * 60_000 }))
  db.replaceConversations([{ id: conversationId, projectId: project.id, title: '监督者回顾调度', updatedAt: now, messages }])

  const supervisor = new SupervisorService({ collect: async () => { throw new Error('Paged review collector required') } }, {
    summarize: async input => model(input.evidence[0]?.sourceType === 'note' ? 'navigation' : 'review', [input.systemInstruction,
      'OUTPUT CONTRACT:', input.outputContract, 'REVIEW TIME RANGE:', JSON.stringify(input.request.timeRange),
      'KNOWN ENTITIES:', JSON.stringify(input.candidates.map((candidate, index) => ({ candidateRef: `known_${index + 1}`, label: candidate.label, description: candidate.description }))),
      'PREVIOUS SUMMARY (background only):', input.previousSummary ?? '',
      'CURRENT MEMORY (background only; do not cite as new evidence):', JSON.stringify(input.background ?? []),
      'BOUNDED EVIDENCE:', JSON.stringify(input.evidence), 'Return only JSON.'].join('\n\n'))
  }, {
    scope: scope => db.resolveReviewScope(scope), summary: request => db.reviewSummary(request.scope, 'supervisor'),
    background: request => db.reviewBackground(request.scope), start: (request, heartbeatRunId) => db.startSupervisionRun(request, heartbeatRunId),
    fail: (runId, error) => db.failSupervisionRun(runId, error), noChange: runId => db.noChangeSupervisionRun(runId),
    candidates: async request => db.listSupervisionCandidates(request), save: async result => db.saveSupervisionResult(result)
  }, { database: () => db.supervisionReviewStore(), configuration: async () => ({ version: 1, pageSize: 50,
    batchCharacters: 8000, batchMessages: 20, concurrency: 1, timeoutSeconds: 180, executionSeconds: 300 }) })

  const heartbeat = new HeartbeatService(db, {
    review: async ({ config: plan, run }) => {
      const to = new Date(Date.now() + 60_000).toISOString()
      const from = new Date(Date.parse(to) - plan.lookbackHours * 3_600_000).toISOString()
      const result = await supervisor.run({ trigger: 'heartbeat', scope: plan.scope, timeRange: { from, to } }, run.id)
      return { status: result.status ?? 'completed', runId: result.runId }
    },
    suggest: async ({ run, supervisionRunId }) => deriveSuggestions(db.supervisionSuggestions(),
      request => model('suggestion', [request.systemInstruction, 'OUTPUT CONTRACT:', request.outputContract,
        'CANDIDATES:', JSON.stringify(request.candidates), 'Return only JSON.'].join('\n\n')),
      { supervisionRunId, heartbeatRunId: run.id })
  })
  const plan = heartbeat.create({ name: '项目回顾', scope: { kind: 'projects', projectIds: [project.id] }, timezone: 'UTC',
    recurrence: { type: 'daily', localTime: '09:00' }, enabled: true, lookbackHours: 24, retentionDays: 30 })
  let tick = 0
  const due = async () => {
    sql.prepare('UPDATE heartbeat_configs SET next_run_at = ? WHERE id = ?').run(new Date(Date.now() - 10_000 + tick++).toISOString(), plan.id)
    return (await heartbeat.processDue())[0]
  }

  // 1. First heartbeat: one review call (single batch, no navigation merge) plus one suggestion call.
  const first = await due()
  const firstActivity = db.listSupervisionActivity(1, 0, plan.id)[0]
  const firstCalls = calls.map(call => call.stage)
  assert.equal(firstActivity.status, 'completed')
  assert(!firstCalls.includes('heartbeat'), 'The heartbeat made its own report request')
  assert.equal(firstCalls.filter(stage => stage === 'review').length, 1)
  const suggestions = db.supervisionSuggestions().list('pending', 50, 0)
  report.first = { heartbeatStatus: first.status, activity: firstActivity.status, suggestionStatus: firstActivity.suggestionStatus,
    calls: firstCalls, suggestions: suggestions.map(({ kind, title, detail, sourceIds }) => ({ kind, title, detail, sources: sourceIds.length })) }
  const sources = new Set(db.getSupervisionGraph({ resultId: firstActivity.resultId }).sources.map(source => source.id))
  assert(suggestions.every(item => item.sourceIds.length && item.sourceIds.every(id => sources.has(id))), 'Suggestion lacks a valid source')
  const suggestionPrompt = calls.find(call => call.stage === 'suggestion')
  report.first.suggestionInputCharacters = suggestionPrompt?.inputCharacters ?? 0

  // 2. Unchanged: zero model calls, no new suggestions.
  const before = calls.length
  const second = await due()
  assert.equal(calls.length, before, 'Unchanged heartbeat made a model request')
  assert.equal(second.status, 'no_change')
  report.unchanged = { heartbeatStatus: second.status, calls: calls.length - before,
    pendingSuggestions: db.supervisionSuggestions().list('pending', 50, 0).length }

  // 3. Manual review is incremental by default: still no model call.
  const manual = await supervisor.run({ trigger: 'manual', scope: plan.scope, timeRange: {
    from: new Date(now - 24 * 3_600_000).toISOString(), to: new Date(Date.now() + 60_000).toISOString() } })
  assert.equal(manual.status, 'no_change')
  assert.equal(calls.length, before)
  report.manualUnchanged = { status: manual.status, calls: calls.length - before }

  // 4. A new message: only the new source is reviewed and linked to existing entities.
  const entitiesBefore = db.listSupervisionCandidates({ trigger: 'heartbeat', scope: plan.scope, timeRange: manual.request.timeRange })
  // Append like a real conversation turn; existing messages keep their revisions.
  db.appendConversationMessage({ conversationId, role: 'user', content: '每页读取消息数定为 50，已经决定了。' })
  const third = await due()
  const thirdActivity = db.listSupervisionActivity(1, 0, plan.id)[0]
  const coverage = thirdActivity.reviewProgress
  const entitiesAfter = db.listSupervisionCandidates({ trigger: 'heartbeat', scope: plan.scope, timeRange: manual.request.timeRange })
  report.changed = { heartbeatStatus: third.status, activity: thirdActivity.status, reviewedSources: coverage?.sources,
    calls: calls.slice(before).map(call => call.stage), entitiesBefore: entitiesBefore.length, entitiesAfter: entitiesAfter.length,
    reusedEntities: entitiesAfter.filter(entity => entitiesBefore.some(old => old.id === entity.id)).length }
  assert.equal(coverage?.sources, 1, 'Changed heartbeat did not limit itself to the new source')
  assert.deepEqual(sql.prepare('PRAGMA foreign_key_check').all(), [])
  report.passed = true
} catch (error) {
  report.passed = false
  report.error = error instanceof Error ? error.message.replaceAll(config.DEEPSEEK_API_KEY, '[redacted]') : 'Live check failed'
  process.exitCode = 1
} finally {
  sql.close(); db.close()
  writeFileSync(join(directory, 'report.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report, null, 2))
}

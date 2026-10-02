// Long-session acceptance of the production review on real data (isolated copy, DeepSeek).
// 1. Online backup of the live assistant.sqlite, upgraded through AssistantDatabase. Only the copy is changed:
//    every other conversation is archived in the copy so the review reads exactly one long real conversation.
// 2. Full review with one injected provider failure after `failAfter` successful extraction calls (no paid call is
//    spent on the failure), then resume of the same run: saved batches must be reused, not re-extracted.
// 3. Coverage: the saved batch fragments of every message must rebuild its text exactly, with no gaps or overlaps.
// 4. Unchanged reruns (heartbeat and default manual) must finish as no_change with zero model calls.
// Logs counts and timings only, no source text.
// Usage: npx jiti scripts/long-session-acceptance.mjs <live.sqlite> <env-file> <output-directory> <conversation-id-prefix> [failAfter]
/* global process, fetch, AbortSignal, console */
import assert from 'node:assert/strict'
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { DatabaseSync, backup } from 'node:sqlite'
import { parseEnv } from 'node:util'
import { AssistantDatabase } from '../src/main/assistant/assistant-database.ts'
import { SupervisorService } from '../src/main/assistant/supervisor-service.ts'

const [livePath, envPath, directory, prefix, failAfterArg] = process.argv.slice(2)
const config = parseEnv(readFileSync(envPath, 'utf8'))
assert(config.DEEPSEEK_BASE_URL && config.DEEPSEEK_API_KEY && config.DEEPSEEK_MODEL, 'DeepSeek configuration unavailable')
const failAfter = Number(failAfterArg ?? 4)
const maximumCalls = 120
mkdirSync(directory, { recursive: true })
const report = { calls: [], phases: {} }
const calls = report.calls
let phase = 'first', extractionCalls = 0, injected = false

async function model(stage, prompt) {
  if (stage === 'extract' && phase === 'first' && ++extractionCalls > failAfter && !injected) {
    injected = true
    throw new Error('Injected provider failure (acceptance test)')
  }
  assert(calls.length < maximumCalls, 'Live request budget exhausted')
  const entry = { phase, stage, inputCharacters: prompt.length }
  calls.push(entry)
  const started = Date.now()
  const url = config.DEEPSEEK_BASE_URL.replace(/\/+$/, '')
  const response = await fetch(url.endsWith('/chat/completions') ? url : `${url}/chat/completions`, {
    method: 'POST', headers: { Authorization: `Bearer ${config.DEEPSEEK_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: config.DEEPSEEK_MODEL, messages: [{ role: 'user', content: prompt }], stream: false,
      temperature: 0, max_tokens: 32768, response_format: { type: 'json_object' } }),
    signal: AbortSignal.timeout(240_000)
  })
  entry.status = response.status
  assert(response.ok, `Provider HTTP ${response.status}`)
  const body = await response.json()
  entry.model = body.model; entry.inputTokens = body.usage?.prompt_tokens; entry.outputTokens = body.usage?.completion_tokens; entry.ms = Date.now() - started
  const content = body.choices[0].message.content ?? ''
  entry.finishReason = body.choices[0].finish_reason
  try { JSON.parse(content); entry.json = true } catch { entry.json = false; entry.contentChars = content.length; entry.head = content.slice(0, 40).replace(/\s+/g, ' '); entry.tailLength = content.trimEnd().slice(-1) }
  return content
}

// 1. Copy and isolate one conversation.
const copy = join(directory, 'assistant.sqlite')
const live = new DatabaseSync(livePath, { readOnly: true })
await backup(live, copy)
live.close()
// Magic note files live beside the database; copy them so initialization finds them (read-only from the live side).
const notes = join(dirname(livePath), 'notes')
if (existsSync(notes) && !existsSync(join(directory, 'notes'))) cpSync(notes, join(directory, 'notes'), { recursive: true })
const db = new AssistantDatabase(copy)
db.initialize(directory)
const sql = new DatabaseSync(copy)
const target = sql.prepare("SELECT id, project_id FROM conversations WHERE id LIKE ? AND status = 'active'").get(`${prefix}%`)
assert(target, 'Target conversation not found')
sql.prepare("UPDATE conversations SET status = 'archived' WHERE id != ?").run(target.id)
// Tasks are sources too; hide them in the copy so coverage is measured on the conversation alone.
sql.prepare('UPDATE tasks SET visible = 0').run()
const messages = sql.prepare(`SELECT id, content, created_at FROM messages WHERE conversation_id = ? AND role IN ('user','assistant') ORDER BY sequence`).all(target.id)
const points = messages.reduce((sum, message) => sum + Array.from(message.content).length, 0)
const timeRange = { from: new Date(Date.parse(messages[0].created_at) - 1000).toISOString(), to: new Date(Date.parse(messages.at(-1).created_at) + 1000).toISOString() }
const scope = { kind: 'projects', projectIds: [target.project_id] }
report.target = { messages: messages.length, codePoints: points, days: +((Date.parse(timeRange.to) - Date.parse(timeRange.from)) / 86_400_000).toFixed(1) }

const reviewConfig = { version: 1, pageSize: 50, batchCharacters: 8000, batchMessages: 20, concurrency: 2, timeoutSeconds: 240, executionSeconds: 300, crossProject: false }
const supervisor = new SupervisorService({ collect: async () => { throw new Error('Paged review collector required') } }, {
  summarize: async input => model(input.evidence[0]?.sourceType === 'note' ? 'navigation' : 'extract', [input.systemInstruction,
    'OUTPUT CONTRACT:', input.outputContract, 'REVIEW TIME RANGE:', JSON.stringify(input.request.timeRange),
    'KNOWN ENTITIES:', JSON.stringify(input.candidates.map((candidate, index) => ({ candidateRef: `known_${index + 1}`, label: candidate.label, description: candidate.description }))),
    'PREVIOUS SUMMARY (background only):', input.previousSummary ?? '',
    'CURRENT MEMORY (background only; do not cite as new evidence):', JSON.stringify(input.background ?? []),
    'BOUNDED EVIDENCE:', JSON.stringify(input.evidence), 'Return only JSON.'].join('\n\n'))
}, {
  scope: value => db.resolveReviewScope(value), summary: request => db.reviewSummary(request.scope, 'supervisor'),
  background: request => db.reviewBackground(request.scope), start: (request, heartbeatRunId) => db.startSupervisionRun(request, heartbeatRunId),
  fail: (runId, error) => db.failSupervisionRun(runId, error), noChange: runId => db.noChangeSupervisionRun(runId),
  candidates: async (request, batch) => db.listSupervisionCandidates(request, batch), save: async result => db.saveSupervisionResult(result)
}, { database: () => db.supervisionReviewStore(), configuration: async () => reviewConfig })

const batchRows = runId => sql.prepare('SELECT id, evidence_json FROM supervision_review_batches WHERE run_id = ?').all(runId)
try {
  // 2. First run fails once mid-way; then resume the same run.
  let started = Date.now()
  let first
  try { first = await supervisor.run({ trigger: 'heartbeat', scope, timeRange }) } catch (error) { first = { error: String(error?.message ?? error) } }
  const runId = first.runId ?? String(sql.prepare('SELECT id FROM supervision_runs ORDER BY started_at DESC LIMIT 1').get().id)
  const savedBefore = batchRows(runId)
  report.phases.first = { status: first.status ?? String(sql.prepare('SELECT status FROM supervision_runs WHERE id = ?').get(runId).status),
    error: first.error, injected, savedBatches: savedBefore.length, calls: calls.length, ms: Date.now() - started }
  // A real provider or output failure before the injected one is accepted too: the point is resuming after a failure.
  assert(injected || first.error, 'First run did not fail; raise the conversation size or lower failAfter')
  assert(savedBefore.length > 0, 'No batch was saved before the failure')
  phase = 'resume'
  started = Date.now()
  // Resume until complete; each resume after a real failure counts. At most 3.
  let resumed, attempts = 0
  for (;;) {
    attempts++
    try { resumed = await supervisor.resume(runId); break } catch (error) {
      report.phases[`resumeFailure${attempts}`] = { error: String(error?.message ?? error), savedBatches: batchRows(runId).length }
      if (attempts >= 3) throw error
    }
  }
  report.resumeAttempts = attempts
  const savedAfter = batchRows(runId)
  const keptIds = savedBefore.every(row => savedAfter.some(other => other.id === row.id))
  report.phases.resume = { status: resumed.status, savedBatches: savedAfter.length, keptEarlierBatches: keptIds,
    calls: calls.filter(call => call.phase === 'resume').length, extractionCalls: calls.filter(call => call.phase === 'resume' && call.stage === 'extract').length,
    navigationCalls: calls.filter(call => call.phase === 'resume' && call.stage === 'navigation').length, ms: Date.now() - started }
  assert.equal(resumed.status, 'completed', 'Resumed review did not complete')
  assert(keptIds, 'Resume dropped batches saved before the failure')

  // 3. Coverage: rebuild each message from the saved fragments.
  const fragments = new Map()
  for (const row of savedAfter) for (const item of JSON.parse(row.evidence_json)) {
    if (!item.locator?.messageId) continue
    const list = fragments.get(item.locator.messageId) ?? []
    list.push({ start: item.locator.start, end: item.locator.end, content: item.content })
    fragments.set(item.locator.messageId, list)
  }
  let rebuilt = 0, gaps = 0, overlaps = 0, mismatched = 0
  for (const message of messages) {
    const list = (fragments.get(message.id) ?? []).sort((a, b) => a.start - b.start)
    let at = 0, text = ''
    for (const fragment of list) {
      if (fragment.start > at) gaps++
      if (fragment.start < at) overlaps++
      text += fragment.content; at = fragment.end
    }
    const expected = Array.from(message.content)
    if (at < expected.length) gaps++
    if (text === message.content) rebuilt++; else mismatched++
  }
  report.coverage = { messages: messages.length, rebuiltExactly: rebuilt, mismatched, gaps, overlaps,
    fragments: [...fragments.values()].reduce((sum, list) => sum + list.length, 0),
    reviewedPoints: [...fragments.values()].flat().reduce((sum, fragment) => sum + Array.from(fragment.content).length, 0), totalPoints: points }
  assert.equal(rebuilt, messages.length, 'Some messages were not rebuilt exactly')

  // 4. Unchanged reruns: heartbeat (incremental) and default manual (incremental) make no model call.
  phase = 'unchanged'
  const before = calls.length
  const heartbeat = await supervisor.run({ trigger: 'heartbeat', scope, timeRange })
  const manual = await supervisor.run({ trigger: 'manual', scope, timeRange })
  report.phases.unchanged = { heartbeat: heartbeat.status, manual: manual.status, calls: calls.length - before }
  assert.equal(calls.length, before, 'Unchanged rerun called the model')

  // Published graph for this run.
  report.published = {
    events: Number(sql.prepare(`SELECT COUNT(*) n FROM supervision_events e JOIN supervision_results r ON r.id = e.result_id WHERE r.run_id = ? AND e.superseded_by IS NULL`).get(runId).n),
    summaryCharacters: String(sql.prepare('SELECT summary FROM supervision_results WHERE run_id = ?').get(runId)?.summary ?? '').length
  }
  report.totals = { calls: calls.length, failedCalls: calls.filter(call => call.status !== 200).length,
    inputTokens: calls.reduce((sum, call) => sum + (call.inputTokens ?? 0), 0), outputTokens: calls.reduce((sum, call) => sum + (call.outputTokens ?? 0), 0),
    slowestMs: Math.max(...calls.map(call => call.ms ?? 0)) }
  report.models = [...new Set(calls.map(call => call.model))]
  report.passed = true
} catch (error) {
  report.passed = false
  report.error = String(error?.stack ?? error).slice(0, 2000)
} finally {
  sql.close(); db.close()
  writeFileSync(join(directory, 'report.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify({ ...report, calls: report.calls.length }, null, 2))
}

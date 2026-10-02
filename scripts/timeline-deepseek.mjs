// Real-data check of the shared supervisor timeline (storyline model step 1).
// Backs up a live assistant.sqlite with SQLite's online backup, upgrades the copy through
// AssistantDatabase, then runs bounded reviews with the DeepSeek profile from an env file.
// The source database is opened read-only and never modified. Logs contain counts only.
// Usage: node scripts/timeline-deepseek.mjs <source.sqlite> <env-file> <output-directory> [maxCalls]
/* global process, fetch, AbortSignal, console */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, statSync, writeFileSync, createReadStream } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync, backup } from 'node:sqlite'
import { parseEnv } from 'node:util'
import { AssistantDatabase } from '../src/main/assistant/assistant-database.ts'
import { SupervisorService } from '../src/main/assistant/supervisor-service.ts'

const [sourcePath, envPath, directory, maxCallsArg] = process.argv.slice(2)
const config = parseEnv(readFileSync(envPath, 'utf8'))
assert(config.DEEPSEEK_BASE_URL && config.DEEPSEEK_API_KEY && config.DEEPSEEK_MODEL, 'DeepSeek configuration unavailable')
mkdirSync(directory, { recursive: true })
const maximumCalls = Number(maxCallsArg ?? 12)
const calls = []
const sha256 = path => new Promise((resolve, reject) => {
  const hash = createHash('sha256'); createReadStream(path).on('data', d => hash.update(d)).on('end', () => resolve(hash.digest('hex'))).on('error', reject)
})

async function model(stage, prompt) {
  assert(calls.length < maximumCalls, 'Live request budget exhausted')
  const entry = { stage, inputCharacters: prompt.length }
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
  entry.model = body.model; entry.usage = body.usage; entry.ms = Date.now() - started
  return body.choices[0].message.content
}

const report = { calls }
// 1. Consistent online backup of the live database (WAL included), then upgrade only the copy.
const copy = join(directory, 'assistant.sqlite')
const sourceBefore = statSync(sourcePath).size
const source = new DatabaseSync(sourcePath, { readOnly: true })
const backupStarted = Date.now()
await backup(source, copy)
source.close()
report.backup = { bytes: statSync(copy).size, sourceBytes: sourceBefore, ms: Date.now() - backupStarted, sha256: await sha256(copy) }
const raw = new DatabaseSync(copy)
const count = sql => Number(raw.prepare(sql).get().n)
report.before = {
  schema: Number(raw.prepare('PRAGMA user_version').get().user_version),
  events: count('SELECT COUNT(*) n FROM supervision_events'),
  // Events from two results that cite the same source version and offsets.
  crossResultSameSource: count(`SELECT COUNT(DISTINCT es.event_id) n FROM supervision_event_sources es JOIN supervision_sources s ON s.id = es.source_id
    JOIN supervision_sources t ON t.result_id != s.result_id AND json_extract(t.locator_json,'$.source') = json_extract(s.locator_json,'$.source')
      AND json_extract(t.locator_json,'$.revision') = json_extract(s.locator_json,'$.revision')`),
  checkpointScopes: raw.prepare("SELECT scope, COUNT(*) n FROM review_checkpoints GROUP BY scope").all().map(r => ({ scope: r.scope, n: Number(r.n) }))
}
raw.close()

const upgradeStarted = Date.now()
const db = new AssistantDatabase(copy)
db.initialize(directory)
report.upgradeMs = Date.now() - upgradeStarted
const sql = new DatabaseSync(copy)
const n = query => Number(sql.prepare(query).get().n)
report.after = {
  schema: Number(sql.prepare('PRAGMA user_version').get().user_version),
  events: n('SELECT COUNT(*) n FROM supervision_events'),
  current: n('SELECT COUNT(*) n FROM supervision_events WHERE superseded_by IS NULL'),
  superseded: n('SELECT COUNT(*) n FROM supervision_events WHERE superseded_by IS NOT NULL'),
  withSpan: n('SELECT COUNT(*) n FROM supervision_events WHERE started_at IS NOT NULL AND ended_at IS NOT NULL'),
  multiHourSpan: n("SELECT COUNT(*) n FROM supervision_events WHERE (julianday(ended_at) - julianday(started_at)) * 24 >= 1"),
  withProject: n("SELECT COUNT(*) n FROM supervision_events WHERE COALESCE(project_id, '') != ''"),
  currentByProject: sql.prepare(`SELECT COALESCE(p.name, '(none)') AS project, COUNT(*) n FROM supervision_events e LEFT JOIN projects p ON p.id = e.project_id
    WHERE e.superseded_by IS NULL GROUP BY project ORDER BY n DESC`).all().map(r => ({ project: r.project, n: Number(r.n) })),
  integrity: sql.prepare('PRAGMA integrity_check').get().integrity_check
}
const global = db.getSupervisionGraph({ storyLineId: String(sql.prepare(`SELECT id FROM story_lines WHERE scope_json = '{"kind":"global"}'`).get()?.id ?? '') })
report.after.globalGraph = { events: global.events.length, entities: global.entities.length, attentionHours: global.attention?.length ?? 0,
  attentionTurns: (global.attention ?? []).reduce((sum, slot) => sum + slot.turns, 0) }

// 2. Live reviews on a bounded real slice: the most recent two hours of the goodbuddy project.
const goodbuddy = sql.prepare("SELECT id FROM projects WHERE name = 'goodbuddy' AND status = 'active'").get()?.id
assert(goodbuddy, 'goodbuddy project not found')
const last = sql.prepare(`SELECT MAX(m.created_at) AS t FROM messages m JOIN conversations c ON c.id = m.conversation_id
  WHERE c.project_id = ? AND c.status = 'active' AND m.role IN ('user','assistant')`).get(goodbuddy).t
const to = new Date(Date.parse(last) + 1000).toISOString()
const from = new Date(Date.parse(to) - 2 * 3_600_000).toISOString()
const timeRange = { from, to }
const projectScope = { kind: 'projects', projectIds: [goodbuddy] }
report.slice = { messages: n(`SELECT COUNT(*) n FROM messages m JOIN conversations c ON c.id = m.conversation_id
  WHERE c.project_id = '${goodbuddy}' AND c.status = 'active' AND m.role IN ('user','assistant') AND m.created_at >= '${from}' AND m.created_at <= '${to}'`),
  globalMessages: n(`SELECT COUNT(*) n FROM messages m JOIN conversations c ON c.id = m.conversation_id JOIN projects p ON p.id = c.project_id
  WHERE c.status = 'active' AND p.status = 'active' AND m.role IN ('user','assistant') AND m.created_at >= '${from}' AND m.created_at <= '${to}'`) }

const reviewConfig = { version: 1, pageSize: 50, batchCharacters: 8000, batchMessages: 20, concurrency: 2, timeoutSeconds: 240, executionSeconds: 300, crossProject: false }
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
  candidates: async (request, batch) => db.listSupervisionCandidates(request, batch), save: async result => db.saveSupervisionResult(result)
}, { database: () => db.supervisionReviewStore(), configuration: async () => reviewConfig })

try {
  // a) Project review: extracts the slice once.
  const projectRun = await supervisor.run({ trigger: 'manual', scope: projectScope, timeRange })
  const projectCalls = calls.length
  report.project = { status: projectRun.status, coverage: projectRun.coverage, calls: projectCalls }
  const eventsAfterProject = n('SELECT COUNT(*) n FROM supervision_events WHERE superseded_by IS NULL')
  // b) Unchanged project review: no model call.
  const repeat = await supervisor.run({ trigger: 'manual', scope: projectScope, timeRange })
  assert.equal(calls.length, projectCalls, 'Unchanged project review called the model')
  report.projectRepeat = { status: repeat.status, calls: 0 }
  // c) Global review over the same interval: goodbuddy sources are not re-extracted.
  const globalRun = await supervisor.run({ trigger: 'manual', scope: { kind: 'global' }, timeRange })
  const extracted = globalRun.coverage?.sources ?? 0
  report.global = { status: globalRun.status, sourcesExtracted: extracted, calls: calls.length - projectCalls,
    otherProjectSources: report.slice.globalMessages - report.slice.messages }
  const reExtracted = n(`SELECT COUNT(*) n FROM supervision_review_sources WHERE run_id = '${globalRun.runId}' AND project_id = '${goodbuddy}'`)
  assert.equal(reExtracted, 0, 'Global review re-extracted project sources')
  report.global.reExtractedProjectSources = reExtracted
  const projectEvents = sql.prepare(`SELECT started_at, ended_at FROM supervision_events WHERE superseded_by IS NULL AND project_id = ?
    AND started_at >= ?`).all(goodbuddy, from)
  report.events = { currentAfterProject: eventsAfterProject, currentAfterGlobal: n('SELECT COUNT(*) n FROM supervision_events WHERE superseded_by IS NULL'),
    sliceProjectEvents: projectEvents.length,
    spansWithinSlice: projectEvents.every(e => e.started_at >= from && e.ended_at <= to && e.started_at <= e.ended_at),
    multiMinuteSpans: projectEvents.filter(e => Date.parse(e.ended_at) - Date.parse(e.started_at) >= 60_000).length,
    entitiesFromOtherProjects: n(`SELECT COUNT(*) n FROM supervision_event_entities ee JOIN supervision_events e ON e.id = ee.event_id
      WHERE e.project_id = '${goodbuddy}' AND e.started_at >= '${from}' AND EXISTS (SELECT 1 FROM supervision_event_entities o JOIN supervision_events oe ON oe.id = o.event_id
        WHERE o.entity_id = ee.entity_id AND oe.superseded_by IS NULL AND COALESCE(oe.project_id,'') NOT IN ('', '${goodbuddy}'))`) }
  report.models = [...new Set(calls.map(call => call.model))]
} finally {
  sql.close(); db.close()
  writeFileSync(join(directory, 'report.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report, null, 2))
}

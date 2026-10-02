// Real-data check of storyline step 5 on an isolated copy: story-level heartbeat suggestions
// (stalled stories, experiences that may apply elsewhere) phrased by DeepSeek, and Story Graph
// MCP reads of stories and experiences. Takes a database with stories and experiences
// (scripts/experiences-deepseek.mjs), copies it and upgrades it with product code. Logs counts,
// titles and kinds only; no source text. Usage:
//   npx jiti scripts/story-suggestions-deepseek.mjs <experiences.sqlite> <env-file> <output-directory> [stalledDays] [now]
/* global process, fetch, AbortSignal, console */
import assert from 'node:assert/strict'
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { parseEnv } from 'node:util'
import { AssistantDatabase } from '../src/main/assistant/assistant-database.ts'
import { deriveSuggestions } from '../src/main/assistant/supervision-suggester.ts'

const [prepared, envPath, directory, stalledArg, nowArg] = process.argv.slice(2)
const config = parseEnv(readFileSync(envPath, 'utf8'))
assert(config.DEEPSEEK_BASE_URL && config.DEEPSEEK_API_KEY && config.DEEPSEEK_MODEL, 'DeepSeek configuration unavailable')
const stalledDays = Number(stalledArg ?? 14)
mkdirSync(directory, { recursive: true })
const copy = join(directory, 'assistant.sqlite')
copyFileSync(prepared, copy)
if (existsSync(join(dirname(prepared), 'notes')) && !existsSync(join(directory, 'notes'))) cpSync(join(dirname(prepared), 'notes'), join(directory, 'notes'), { recursive: true })
const calls = []
async function phrase(request) {
  assert(calls.length < 3, 'Live request budget exhausted')
  const prompt = [request.systemInstruction, 'OUTPUT CONTRACT:', request.outputContract, 'CANDIDATES:', JSON.stringify(request.candidates), 'Return only JSON.'].join('\n\n')
  // Story-level candidates must carry no source locators or text; open items may quote locator IDs the extractor wrote.
  const story = request.candidates.filter(item => item.kind === 'stalled' || item.kind === 'experience')
  const entry = { inputCharacters: prompt.length, candidates: request.candidates.length, storyCandidates: story.length,
    storyCandidateLocators: story.some(item => JSON.stringify(item).includes('message:')) }
  calls.push(entry)
  const started = Date.now()
  const url = config.DEEPSEEK_BASE_URL.replace(/\/+$/, '')
  const response = await fetch(url.endsWith('/chat/completions') ? url : `${url}/chat/completions`, {
    method: 'POST', headers: { Authorization: `Bearer ${config.DEEPSEEK_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: config.DEEPSEEK_MODEL, messages: [{ role: 'user', content: prompt }], stream: false,
      temperature: 0, max_tokens: 8192, response_format: { type: 'json_object' } }),
    signal: AbortSignal.timeout(300_000)
  })
  entry.status = response.status
  assert(response.ok, `Provider HTTP ${response.status}`)
  const body = await response.json()
  entry.model = body.model; entry.outputTokens = body.usage?.completion_tokens; entry.ms = Date.now() - started
  return body.choices[0].message.content
}

const db = new AssistantDatabase(copy)
db.initialize(directory)
const sql = new DatabaseSync(copy)
const report = { calls }
try {
  report.schema = Number(sql.prepare('PRAGMA user_version').get().user_version)
  // The last event time stands in for "now", so stalling is measured against the data, not the wall clock.
  const latest = String(sql.prepare('SELECT MAX(COALESCE(ended_at, occurred_at)) AS at FROM supervision_events WHERE superseded_by IS NULL').get().at)
  const now = nowArg ?? latest
  report.now = now
  // The latest published review, unless an earlier one has more experience candidates: the rule
  // only looks at events a review placed, so this picks a review where reuse can actually show.
  const store = db.supervisionSuggestions()
  const runs = sql.prepare(`SELECT r.run_id FROM supervision_results r JOIN supervision_events e ON e.result_id = r.id
    WHERE e.superseded_by IS NULL GROUP BY r.id ORDER BY MAX(r.created_at) DESC`).all()
  const scored = runs.map(row => ({ row, experience: store.candidates(String(row.run_id), { stalledDays, now }).candidates.filter(item => item.kind === 'experience').length }))
  const run = (scored.find(item => item.experience === Math.max(...scored.map(entry => entry.experience))) ?? scored[0]).row
  report.reviewsScanned = runs.length
  report.experienceCandidatesByReview = scored.map(item => item.experience).filter(Boolean)
  const selected = store.candidates(String(run.run_id), { stalledDays, now })
  report.candidates = selected.candidates.reduce((counts, item) => ({ ...counts, [item.kind]: (counts[item.kind] ?? 0) + 1 }), {})
  const story = selected.candidates.filter(item => item.kind === 'stalled' || item.kind === 'experience')
  report.storyCandidates = story.map(item => ({ kind: item.kind, title: item.title, detail: item.detail, sources: item.sourceIds.length }))
  report.saved = await deriveSuggestions(store, phrase, { supervisionRunId: String(run.run_id), heartbeatRunId: 'live-check', stalledDays, now })
  const before = calls.length
  const again = await deriveSuggestions(store, phrase, { supervisionRunId: String(run.run_id), heartbeatRunId: 'live-check-2', stalledDays, now })
  // A second pass may phrase candidates the per-review cap left over, but never repeats a pending one.
  report.secondPass = { saved: again, calls: calls.length - before }
  const pending = store.list('pending', 100, 0)
  const fingerprints = sql.prepare("SELECT fingerprint, COUNT(*) n FROM supervision_suggestions WHERE status = 'pending' GROUP BY fingerprint HAVING n > 1").all()
  assert.equal(fingerprints.length, 0, 'A pending suggestion was repeated')
  report.storySuggestions = pending.filter(item => item.kind === 'experience').concat(pending.filter(item => item.kind === 'stalled').slice(0, 3)).filter(item => item.kind === 'stalled' || item.kind === 'experience')
    .map(item => ({ kind: item.kind, title: item.title, detail: item.detail, storyId: Boolean(item.storyId), experienceId: Boolean(item.experienceId), sources: item.sourceIds.length }))
  assert(report.storySuggestions.every(item => item.storyId), 'Story suggestion without a story')
  // MCP reads of the shared timeline.
  const global = { kind: 'global' }
  const stories = db.readStoryGraph('story_graph_search', { query: '监督', object_types: ['story'], scope: global, page_size: 5 })
  const experiences = db.readStoryGraph('story_graph_search', { query: '回顾', object_types: ['experience'], scope: global, page_size: 5 })
  report.mcp = {
    stories: stories.page.total_count,
    experiences: experiences.page.total_count,
    firstExperience: experiences.items[0]?.preview?.slice(0, 160)
  }
  if (experiences.items[0]) {
    const context = db.readStoryGraph('story_graph_get_context', { object_ref: experiences.items[0].object_ref, scope: global, page_size: 50 })
    report.mcp.experienceContextEvents = context.items.filter(item => item.object_ref.type === 'event').length
  }
  if (stories.items[0]) {
    const context = db.readStoryGraph('story_graph_get_context', { object_ref: stories.items[0].object_ref, scope: global, page_size: 50, mode: 'timeline' })
    report.mcp.storyContextEvents = context.page.total_count - 1
  }
  report.models = [...new Set(calls.map(call => call.model))]
} finally {
  sql.close(); db.close()
  writeFileSync(join(directory, 'report.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report, null, 2))
}

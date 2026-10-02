// Real-data check of story assignment (storyline model step 2) on an isolated copy.
// Takes a database already upgraded by scripts/timeline-deepseek.mjs, copies it, and assigns
// its current events to stories with the DeepSeek profile from an env file. Logs counts and
// story names only; no source text. Usage:
//   node scripts/stories-deepseek.mjs <prepared.sqlite> <env-file> <output-directory> <off|cross> [maxCalls]
/* global process, fetch, AbortSignal, console */
import assert from 'node:assert/strict'
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { parseEnv } from 'node:util'
import { AssistantDatabase } from '../src/main/assistant/assistant-database.ts'
import { assignStories } from '../src/main/assistant/supervision-stories.ts'

const [prepared, envPath, directory, mode, maxCallsArg] = process.argv.slice(2)
const config = parseEnv(readFileSync(envPath, 'utf8'))
assert(config.DEEPSEEK_BASE_URL && config.DEEPSEEK_API_KEY && config.DEEPSEEK_MODEL, 'DeepSeek configuration unavailable')
const crossProject = mode === 'cross'
const maximumCalls = Number(maxCallsArg ?? 12)
mkdirSync(directory, { recursive: true })
const copy = join(directory, 'assistant.sqlite')
copyFileSync(prepared, copy)
if (existsSync(join(dirname(prepared), 'notes')) && !existsSync(join(directory, 'notes'))) cpSync(join(dirname(prepared), 'notes'), join(directory, 'notes'), { recursive: true })
const calls = []
async function model(prompt) {
  assert(calls.length < maximumCalls, 'Live request budget exhausted')
  const entry = { inputCharacters: prompt.length }
  calls.push(entry)
  const started = Date.now()
  const url = config.DEEPSEEK_BASE_URL.replace(/\/+$/, '')
  const response = await fetch(url.endsWith('/chat/completions') ? url : `${url}/chat/completions`, {
    method: 'POST', headers: { Authorization: `Bearer ${config.DEEPSEEK_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: config.DEEPSEEK_MODEL, messages: [{ role: 'user', content: prompt }], stream: false,
      temperature: 0, max_tokens: 32768, response_format: { type: 'json_object' } }),
    signal: AbortSignal.timeout(300_000)
  })
  entry.status = response.status
  assert(response.ok, `Provider HTTP ${response.status}`)
  const body = await response.json()
  entry.model = body.model; entry.outputTokens = body.usage?.completion_tokens; entry.ms = Date.now() - started
  const content = body.choices[0].message.content
  // Refs only, so a rejected answer can be diagnosed without logging event text.
  try {
    const value = JSON.parse(content)
    entry.shape = { stories: (value.stories ?? []).map(s => [s.key, s.level, s.parent ?? null]),
      assignments: (value.assignments ?? value.moves ?? []).map(a => [a.event, a.story ?? a.thread ?? null]), concluded: value.concluded, links: value.links }
  } catch { entry.shape = 'invalid JSON' }
  return content
}

const db = new AssistantDatabase(copy)
db.initialize(directory)
const sql = new DatabaseSync(copy)
const n = query => Number(sql.prepare(query).get().n)
const stories = db.supervisionStories()
const report = { mode, calls }
try {
  report.schema = Number(sql.prepare('PRAGMA user_version').get().user_version)
  const projects = sql.prepare("SELECT id, name FROM projects WHERE status = 'active'").all()
  const scope = { kind: 'global' }
  report.pendingBefore = stories.pending(scope).length
  const options = { crossProject, threadEvents: 20, batchCharacters: 16000, concurrency: 2 }
  const started = Date.now()
  report.first = await assignStories(stories, model, scope, options)
  report.firstMs = Date.now() - started
  const before = calls.length
  report.second = await assignStories(stories, model, scope, options)
  assert.equal(calls.length, before, 'Second assignment called the model')
  const list = stories.list(scope)
  report.summary = {
    stories: list.length,
    byLevel: Object.fromEntries(['feature', 'thread', 'cross'].map(level => [level, list.filter(s => s.level === level).length])),
    concluded: list.filter(s => s.state === 'concluded').length,
    concludedWithEvidence: list.filter(s => s.state === 'concluded' && s.stateEventId && s.events.some(e => e.id === s.stateEventId)).length,
    unassigned: stories.unassignedCount(scope),
    primaryLinks: n('SELECT COUNT(*) n FROM supervision_event_stories WHERE is_primary = 1'),
    eventsWithTwoPrimaries: n('SELECT COUNT(*) n FROM (SELECT event_id FROM supervision_event_stories WHERE is_primary = 1 GROUP BY event_id HAVING COUNT(*) > 1)'),
    primaryAcrossProjects: n(`SELECT COUNT(*) n FROM supervision_event_stories es JOIN supervision_events e ON e.id = es.event_id
      JOIN supervision_stories s ON s.id = es.story_id WHERE es.is_primary = 1 AND s.project_id != e.project_id`),
    threadsInSmallFeatures: list.filter(s => s.level === 'thread').filter(t => {
      const parent = list.find(s => s.id === t.parentId)
      return (parent?.events.filter(e => e.primary).length ?? 0) + list.filter(s => s.parentId === t.parentId).reduce((sum, s) => sum + s.events.filter(e => e.primary).length, 0) < 20
    }).length,
    singleEventFeatures: list.filter(s => s.level === 'feature' && s.events.filter(e => e.primary).length === 1 && !list.some(c => c.parentId === s.id)).length
  }
  report.tree = projects.map(project => ({ project: project.name,
    features: list.filter(s => s.level === 'feature' && s.projectId === project.id).map(f => ({ name: f.name,
      events: f.events.filter(e => e.primary).length, spanHours: f.startedAt ? Math.round((Date.parse(f.endedAt) - Date.parse(f.startedAt)) / 36e5) : 0,
      threads: list.filter(s => s.parentId === f.id).map(s => `${s.name} (${s.events.filter(e => e.primary).length})`) })) }))
    .filter(project => project.features.length)
  report.cross = list.filter(s => s.level === 'cross').map(s => ({ name: s.name, events: s.events.length,
    projects: [...new Set(s.events.map(e => projects.find(p => p.id === e.projectId)?.name))], features: stories.crossMembers(s.id) }))
  report.featuresWithVersionInName = list.filter(s => s.level === 'feature' && /\d+\.\d+/.test(s.name)).map(s => s.name)
  report.models = [...new Set(calls.map(call => call.model))]
} finally {
  sql.close(); db.close()
  writeFileSync(join(directory, 'report.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report, null, 2))
}

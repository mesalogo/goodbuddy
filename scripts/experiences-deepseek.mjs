// Real-data check of experience extraction (storyline model step 4) on an isolated copy.
// Takes a database whose events were already assigned to stories (scripts/stories-deepseek.mjs),
// copies it, upgrades it with product code and extracts experiences with the DeepSeek profile from
// an env file. Logs counts, statements and evidence titles only; no source text. Usage:
//   node --import jiti/register scripts/experiences-deepseek.mjs <stories.sqlite> <env-file> <output-directory> [maxCalls]
/* global process, fetch, AbortSignal, console */
import assert from 'node:assert/strict'
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { parseEnv } from 'node:util'
import { AssistantDatabase } from '../src/main/assistant/assistant-database.ts'
import { extractExperiences } from '../src/main/assistant/supervision-experiences.ts'

const [prepared, envPath, directory, maxCallsArg] = process.argv.slice(2)
const config = parseEnv(readFileSync(envPath, 'utf8'))
assert(config.DEEPSEEK_BASE_URL && config.DEEPSEEK_API_KEY && config.DEEPSEEK_MODEL, 'DeepSeek configuration unavailable')
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
      temperature: 0, max_tokens: 16384, response_format: { type: 'json_object' } }),
    signal: AbortSignal.timeout(300_000)
  })
  entry.status = response.status
  assert(response.ok, `Provider HTTP ${response.status}`)
  const body = await response.json()
  entry.model = body.model; entry.outputTokens = body.usage?.completion_tokens; entry.ms = Date.now() - started
  entry.sourceTextSent = prompt.includes('message:')
  return body.choices[0].message.content
}

const db = new AssistantDatabase(copy)
db.initialize(directory)
const sql = new DatabaseSync(copy)
const store = db.supervisionExperiences()
const report = { calls }
try {
  report.schema = Number(sql.prepare('PRAGMA user_version').get().user_version)
  report.stories = Number(sql.prepare("SELECT COUNT(*) n FROM supervision_stories WHERE status = 'current'").get().n)
  const options = { minEvents: 5, batchCharacters: 16000 }
  const started = Date.now()
  report.first = await extractExperiences(store, model, options)
  report.firstMs = Date.now() - started
  const before = calls.length
  report.second = await extractExperiences(store, model, options)
  assert.equal(calls.length, before, 'Second extraction called the model')
  const list = store.list()
  const sourced = sql.prepare('SELECT COUNT(*) n FROM supervision_event_sources WHERE event_id = ?')
  report.summary = {
    experiences: list.length,
    withoutFormed: list.filter(item => !item.events.some(event => event.role === 'formed')).length,
    evidenceWithoutSource: list.flatMap(item => item.events).filter(event => Number(sourced.get(event.id).n) === 0).length,
    applicationsBeforeFormation: list.filter(item => {
      const formed = item.events.filter(event => event.role === 'formed').map(event => event.at).sort()[0]
      return item.events.some(event => event.role === 'applied' && event.at <= formed)
    }).length,
    crossStory: list.filter(item => new Set(item.events.map(event => event.storyId)).size > 1).length,
    applications: list.reduce((sum, item) => sum + item.events.filter(event => event.role === 'applied').length, 0)
  }
  report.experiences = list.map(item => ({ statement: item.statement, conditions: item.conditions, boundaries: item.boundaries,
    formed: item.events.filter(event => event.role === 'formed').map(event => `${event.storyName}: ${event.title}`),
    applied: item.events.filter(event => event.role === 'applied').map(event => `${event.storyName}: ${event.title} (${event.note})`) }))
  report.models = [...new Set(calls.map(call => call.model))]
} finally {
  sql.close(); db.close()
  writeFileSync(join(directory, 'report.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report, null, 2))
}

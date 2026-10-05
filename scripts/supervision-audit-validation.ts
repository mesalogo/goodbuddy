// Synthetic SQLite / bounded live validation for A03-A05. Never opens a user database.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { parseEnv } from 'node:util'
import { build } from 'esbuild'
import type { DatabaseSync } from 'node:sqlite'
import { AssistantDatabase } from '../src/main/assistant/assistant-database'
import { createProductionSupervisorService } from '../src/main/assistant/supervision-production'
import { SupervisionModelPool } from '../src/main/assistant/supervision-model-pool'
import { ModelAgentRuntime } from '../src/main/agent/model-runtime'
import type { SupervisionRunRequest } from '../src/shared/supervision-contracts'
import { supervisionReviewSettingsSchema } from '../src/shared/supervision-review-contracts'

async function main() {
  const [mode, parent, envPath] = process.argv.slice(2)
  assert((mode === 'scale' || mode === 'live') && parent)
  const rel = relative(process.cwd(), resolve(parent))
  assert(rel.startsWith('..') || isAbsolute(rel), 'Output must be outside repository')
  const directory = await mkdtemp(join(resolve(parent), 'supervision-audit-'))
  const path = join(directory, 'assistant.sqlite')
  const worker = join(directory, 'readonly-query-worker.cjs')
  await build({ entryPoints: [resolve('src/main/readonly-query-worker.ts')], outfile: worker,
    bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent' })
  const db = new AssistantDatabase(path)
  db.initialize(directory)
  db.enableReadonlyWorker(worker)
  const sql = (db as unknown as { requireDatabase(): DatabaseSync }).requireDatabase()
  const pool = new SupervisionModelPool()
  const report: Record<string, unknown> = { mode, directory, externalCalls: 0 }
  let calls = 0
  const started = performance.now()
  const request: SupervisionRunRequest = { trigger: 'manual', scope: { kind: 'global' },
    timeRange: { from: '2026-10-01T00:00:00.000Z', to: '2026-10-02T00:00:00.000Z' } }
  const empty = { summary: 'Synthetic audit', changeDigest: '', openItems: [], events: [], entities: [], entityChanges: [], relations: [] }
  try {
    if (mode === 'scale') {
      const projects = [db.listProjects()[0]!, ...Array.from({ length: 9 }, (_, i) => db.createProject({ name: `Synthetic ${i}`, description: '', rootPath: directory }))]
      for (const project of projects) {
        db.saveSupervisionResult({ request, evidence: [{ id: 's', sourceType: 'conversation', sourceId: randomUUID(),
          title: 'Synthetic ownership', content: 'Synthetic source', occurredAt: request.timeRange.from, locator: { projectId: project.id } }],
        output: { ...empty,
          entities: Array.from({ length: 100 }, (_, i) => ({ id: `e${i}`, label: `${project.id}:${i}`, description: 'Synthetic knowledge', sourceReferenceIds: ['s'] })),
          events: Array.from({ length: 1000 }, (_, i) => ({ title: `Event ${i}`, description: 'Synthetic decision', occurredAt: request.timeRange.from,
            eventType: 'discussion' as const, entityIds: [`e${i % 100}`], sourceReferenceIds: ['s'] })) } })
      }
      report.seedMs = performance.now() - started
      const counts = () => ['supervision_entities', 'supervision_events', 'supervision_event_entities', 'supervision_sources'].map(table =>
        [table, Number(sql.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()!.n)])
      const before = counts()
      await db.supervisionCandidates(request, { projectId: projects[0]!.id, crossProject: false })
      const legacy = sql.prepare(`SELECT e.id FROM supervision_entities e WHERE e.confirmation_state != 'revoked' AND EXISTS (
        SELECT 1 FROM supervision_event_entities ee JOIN supervision_events ev ON ev.id = ee.event_id
        WHERE ee.entity_id = e.id AND ev.superseded_by IS NULL AND COALESCE(ev.project_id, '') = ?)
        ORDER BY e.updated_at DESC, e.id LIMIT 100`)
      const rounds: Array<{ legacyMs: number; isolatedMs: number; crossProjectMs: number }> = []
      for (let round = 0; round < 3; round++) {
        const legacyStart = performance.now()
        const expected = new Map(projects.map(project => [project.id, legacy.all(project.id).map(row => row.id)]))
        const legacyMs = performance.now() - legacyStart
        const start = performance.now()
        for (const project of projects) {
          const candidates = await db.supervisionCandidates(request, { projectId: project.id, crossProject: false })
          assert.equal(candidates.length, 100)
          assert(candidates.every(item => item.label.startsWith(project.id + ':')))
          assert.deepEqual(candidates.map(item => item.id), expected.get(project.id))
        }
        const isolatedMs = performance.now() - start
        const crossStart = performance.now()
        const candidates = await db.supervisionCandidates(request, { projectId: projects[0]!.id, crossProject: true })
        assert.equal(candidates.length, 100)
        rounds.push({ legacyMs, isolatedMs, crossProjectMs: performance.now() - crossStart })
      }
      assert.deepEqual(counts(), before)
      report.rows = Object.fromEntries(before)
      report.rounds = rounds
      report.isolatedQueriesPerRound = projects.length
      // Exercise the new destination check with the largest admitted assignment chunk.
      sql.exec('INSERT INTO supervision_story_assigned SELECT id FROM supervision_events')
      const project = projects[0]!
      const events = sql.prepare('SELECT id, project_id, started_at, event_type, title, description FROM supervision_events WHERE project_id = ? LIMIT 120').all(project.id)
      const stories = db.supervisionStories()
      const applyStart = performance.now()
      stories.apply(project.id, events as Parameters<typeof stories.apply>[1], [], {
        stories: [{ key: 'new_1', level: 'feature', name: 'Synthetic feature', description: '' }],
        assignments: events.map((_, i) => ({ event: `e_${i + 1}`, story: 'new_1' })), concluded: [], links: []
      }, { crossProject: false, threadEvents: 500 })
      report.assignment120Ms = performance.now() - applyStart
      assert.equal(stories.list({ kind: 'projects', projectIds: [project.id] })[0]!.events.length, 120)
    } else {
      assert(envPath, 'Environment file required')
      const env = parseEnv(await readFile(envPath, 'utf8'))
      assert(env.DEEPSEEK_API_KEY && env.DEEPSEEK_BASE_URL && env.DEEPSEEK_MODEL)
      const content = 'We decided to use SQLite transactions to save review facts and coverage together. This prevents partial publication. The implementation is pending.'
      db.saveLocalConversations([{ header: { id: randomUUID(), projectId: db.listProjects()[0]!.id, title: 'Synthetic review decision', updatedAt: Date.parse(request.timeRange.from) },
        messages: [{ id: randomUUID(), role: 'user', state: 'complete', content, createdAt: Date.parse(request.timeRange.from) }] }])
      const runtime = new ModelAgentRuntime({ protocol: 'openai-chat-completions', authentication: 'api-key',
        baseUrl: env.DEEPSEEK_BASE_URL, model: env.DEEPSEEK_MODEL, apiKey: env.DEEPSEEK_API_KEY, defaultWorkspace: directory,
        maximumOutputTokens: 1800, requestBody: { thinking: { type: 'disabled' }, response_format: { type: 'json_object' } },
        toolProvider: { listTools: async () => [], getApproval: () => { throw new Error('Tools disabled') },
          callTool: async () => { throw new Error('Tools disabled') }, releaseConversation: async () => undefined, dispose: async () => undefined },
        fetcher: async (input, init) => {
          assert(calls < 3, 'Three external request cap')
          assert.equal(JSON.parse(String(init?.body)).tools?.length ?? 0, 0)
          calls++
          return fetch(input, init)
        } })
      const service = createProductionSupervisorService(db, async () => ({ supervisorOrganizeTimeoutSeconds: 45,
        supervisionReview: supervisionReviewSettingsSchema.parse({ crossProject: false, experienceMinEvents: 200 }) }), async () => runtime, pool)
      const result = await service.run(request)
      assert.equal(result.status, 'completed')
      assert.equal(result.coverage?.stories?.status, 'completed')
      const evidence = db.supervisionReviewStore().batches(result.runId!).flatMap(batch => batch.evidence)
      assert.equal(evidence.map(item => item.content).join(''), content)
      const before = calls
      assert.equal((await service.run(request)).status, 'no_change')
      assert.equal(calls, before)
      report.messages = 1
      report.characters = content.length
      report.status = result.status
      report.storyCalls = result.coverage?.stories?.calls
      report.noChangeAdditionalCalls = calls - before
    }
    assert.deepEqual(sql.prepare('PRAGMA foreign_key_check').all(), [])
    assert.equal(sql.prepare('PRAGMA integrity_check').get()!.integrity_check, 'ok')
    report.integrity = 'ok'
    report.passed = true
  } catch (error) {
    report.passed = false
    report.errorType = error instanceof Error ? error.name : 'Error'
    process.exitCode = 1
  } finally {
    report.externalCalls = calls
    report.elapsedMs = performance.now() - started
    db.close()
    pool.dispose()
    report.databaseBytes = (await stat(path)).size
    await writeFile(join(directory, 'metrics.json'), JSON.stringify(report, null, 2))
    console.log(JSON.stringify(report, null, 2))
  }
}
void main().catch(() => { console.error('Synthetic supervision validation preflight failed'); process.exitCode = 1 })

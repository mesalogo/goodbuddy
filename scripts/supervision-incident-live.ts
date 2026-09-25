import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { parseEnv } from 'node:util'
import { DatabaseSync } from 'node:sqlite'
import { AssistantDatabase } from '../src/main/assistant/assistant-database'
import { createProductionSupervisorService } from '../src/main/assistant/supervision-production'
import { SupervisionModelPool } from '../src/main/assistant/supervision-model-pool'
import { ModelAgentRuntime } from '../src/main/agent/model-runtime'

async function main() {
  const [directory, envPath, mode] = process.argv.slice(2)
  assert(directory && envPath)
  const metricsPath = join(directory, 'live-metrics.json')
  const previous = mode === 'resume-cached' ? JSON.parse(readFileSync(metricsPath, 'utf8')) : undefined
  assert(previous || !existsSync(metricsPath), 'Do not duplicate a paid validation')
  if (previous) assert.equal(previous.calls.length, 1)
  let cached = previous ? readFileSync(join(directory, 'response-1.private.sse'), 'utf8') : undefined
  const incident = JSON.parse(readFileSync(join(directory, 'incident.private.json'), 'utf8'))
  const env = parseEnv(readFileSync(envPath, 'utf8'))
  assert(env.DEEPSEEK_API_KEY && env.DEEPSEEK_BASE_URL && env.DEEPSEEK_MODEL)
  const calls: Array<Record<string, unknown>> = previous?.calls ?? []
  const metrics: Record<string, unknown> = { startedAt: previous?.startedAt ?? new Date().toISOString(), maxCalls: 3, calls, originalWrites: 0,
    previousFailure: previous?.previousFailure ?? previous?.error }
  const persist = () => writeFileSync(metricsPath, JSON.stringify(metrics, null, 2))
  const seen = new Set<string>(), captures: Promise<void>[] = []
  let stage = 'resume-first-leaf'
  const runtime = new ModelAgentRuntime({ protocol: 'openai-chat-completions', authentication: 'api-key',
    baseUrl: env.DEEPSEEK_BASE_URL, apiKey: env.DEEPSEEK_API_KEY, model: env.DEEPSEEK_MODEL,
    defaultWorkspace: directory, maximumOutputTokens: 6000,
    requestBody: { thinking: { type: 'disabled' }, response_format: { type: 'json_object' } },
    toolProvider: { listTools: async () => [], getApproval: () => { throw new Error('Tools disabled') },
      callTool: async () => { throw new Error('Tools disabled') }, releaseConversation: async () => undefined, dispose: async () => undefined },
    fetcher: async (input, init) => {
      const body = String(init?.body)
      if (cached !== undefined) {
        const withoutClock = (text: string) => text.replace(/Current system time: \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\./, 'Current system time: [clock].')
        assert(withoutClock(body) === withoutClock(readFileSync(join(directory, 'request-1.private.json'), 'utf8')), 'Cached response requires identical request except runtime clock')
        const response = new Response(cached, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
        cached = undefined; seen.add(stage); metrics.cachedResponses = 1; persist()
        return response
      }
      assert(calls.length < 3 && !seen.has(stage), 'Three calls total; retries and fallback forbidden')
      assert.equal(JSON.parse(body).tools?.length ?? 0, 0)
      seen.add(stage)
      const index = calls.length + 1
      const call: Record<string, unknown> = { stage, startedAt: new Date().toISOString(), inputBytes: Buffer.byteLength(body) }
      calls.push(call); persist()
      writeFileSync(join(directory, `request-${index}.private.json`), body)
      const start = performance.now()
      const response = await fetch(input, init)
      call.status = response.status
      captures.push(response.clone().text().then(text => {
        writeFileSync(join(directory, `response-${index}.private.sse`), text)
        call.ms = performance.now() - start; persist()
      }))
      return response
    }
  })
  // Only the backup is initialized; the original is never passed to AssistantDatabase.
  const db = new AssistantDatabase(join(directory, 'assistant.sqlite'))
  db.initialize(directory)
  const pool = new SupervisionModelPool()
  try {
    const store = db.supervisionReviewStore()
    const state = store.load(incident.run.id)
    const candidates = db.listSupervisionCandidates(state.request)
    writeFileSync(join(directory, 'candidates.private.json'), JSON.stringify(candidates))
    metrics.originalCandidates = candidates.length
    const service = createProductionSupervisorService(db, async () => ({ supervisorModelConcurrency: 1, supervisorOrganizeTimeoutSeconds: 120 }), async () => runtime, pool)
    const originalStore = db.supervisionReviewStore.bind(db)
    const save = store.save.bind(store)
    store.save = (...args) => { save(...args); service.pause(incident.run.id) }
    db.supervisionReviewStore = () => store
    const resumed = await service.resume(incident.run.id)
    assert.equal(resumed.status, 'paused')
    const batches = store.batches(incident.run.id)
    assert.equal(batches.length, 1)
    metrics.resumed = resumed.coverage
    const evidence = batches[0]!.evidence
    const sql = new DatabaseSync(join(directory, 'assistant.sqlite'), { readOnly: true })
    for (const item of evidence) {
      const source = sql.prepare('SELECT content FROM messages WHERE id=?').get(String(item.locator!.messageId))!
      assert.equal(Array.from(String(source.content)).slice(Number(item.locator!.start), Number(item.locator!.end)).join(''), item.content)
    }
    sql.close()
    metrics.exactSourceMatches = evidence.length
    metrics.firstLeafSourceHash = createHash('sha256').update(JSON.stringify(evidence)).digest('hex')
    db.supervisionReviewStore = originalStore
    const sample = [...evidence].sort((a, b) => b.content.length - a.content.length)[0]!
    const request = { ...state.request, timeRange: { from: sample.occurredAt, to: sample.occurredAt } }
    stage = 'bounded-real-review'
    const first = await service.run(request)
    assert.equal(first.status, 'completed')
    assert(first.output.entities.length > 0, 'Real sample must produce entities')
    const known = db.listSupervisionCandidates(request)
    stage = 'known-entity-reuse'
    const second = await service.run(request)
    assert.equal(second.status, 'completed')
    const reused = second.output.entities.filter(entity => entity.persistedId && known.some(candidate => candidate.id === entity.persistedId))
    assert(reused.length > 0, 'Known entity reuse was not demonstrated')
    metrics.completed = [first, second].map(result => ({ runId: result.runId, coverage: result.coverage, entities: result.output.entities.length }))
    metrics.reusedEntities = reused.length
    metrics.passed = true
  } catch (error) {
    metrics.passed = false
    metrics.error = error instanceof Error ? error.message : String(error)
    process.exitCode = 1
  } finally {
    await Promise.allSettled(captures)
    const original = new DatabaseSync(incident.source, { readOnly: true })
    assert.deepEqual({ ...original.prepare('SELECT * FROM supervision_runs WHERE id=?').get(incident.run.id) }, incident.run)
    metrics.originalRunUnchanged = true
    original.close()
    metrics.finishedAt = new Date().toISOString(); persist()
    console.log(JSON.stringify({ passed: metrics.passed, calls: calls.length, directory }))
    db.close(); pool.dispose(); await runtime.dispose()
  }
}
void main().catch(error => { console.error(error); process.exitCode = 1 })

// Offline production-factory replay. The source is read-only; only a new backup is initialized.
import assert from 'node:assert/strict'
import { DatabaseSync, backup } from 'node:sqlite'
import { cpSync, existsSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { AssistantDatabase } from '../src/main/assistant/assistant-database'
import { createProductionSupervisorService } from '../src/main/assistant/supervision-production'
import { SupervisionModelPool } from '../src/main/assistant/supervision-model-pool'
import type { AgentRuntime } from '../src/main/agent/runtime'

async function main() {
  const [sourcePath, destinationPath, runId] = process.argv.slice(2)
  assert(sourcePath && destinationPath && runId)
  assert(resolve(sourcePath) !== resolve(destinationPath) && !existsSync(destinationPath))
  const source = new DatabaseSync(sourcePath, { readOnly: true })
  const before = source.prepare('SELECT * FROM supervision_runs WHERE id = ?').get(runId)
  assert(before)
  const cached = source.prepare('SELECT output_json FROM supervision_review_navigation WHERE run_id = ? LIMIT 1').get(runId)
  assert(cached, 'Replay requires a saved navigation response')
  const { summary, changeDigest, openItems } = JSON.parse(String(cached.output_json))
  await backup(source, destinationPath)
  const notes = join(dirname(sourcePath), 'notes')
  const copiedNotes = join(dirname(destinationPath), 'notes')
  if (existsSync(notes) && !existsSync(copiedNotes)) cpSync(notes, copiedNotes, { recursive: true })
  const db = new AssistantDatabase(destinationPath)
  const pool = new SupervisionModelPool()
  let calls = 0
  const run: AgentRuntime['run'] = async function* (input) {
    assert(input.prompt.includes('These inputs are navigation summaries'), 'No successful leaf may be replayed')
    calls++
    yield { type: 'text', requestId: input.requestId, delta: JSON.stringify({ summary, changeDigest, openItems }) }
    yield { type: 'done', requestId: input.requestId }
  }
  try {
    db.initialize(dirname(destinationPath))
    const store = db.supervisionReviewStore()
    const leaves = store.batches(runId, 20)
    assert.equal(leaves.length, 6)
    assert.equal(store.progress(runId).remainingSources, 0)
    const service = createProductionSupervisorService(db, async () => ({ supervisorModelConcurrency: 1 }),
      async () => ({ runtimeId: 'offline-replay', capability: 'chat', run } as AgentRuntime), pool)
    const result = await service.resume(runId)
    assert.equal(result.status, 'completed')
    assert.deepEqual(store.batches(runId, 20), leaves)
    assert.equal(calls, 4)
    assert.deepEqual(source.prepare('SELECT * FROM supervision_runs WHERE id = ?').get(runId), before)
    const report = { runId, status: result.status, retainedLeaves: leaves.length, offlineResponses: calls, paidCalls: 0,
      originalUnchanged: true, progress: store.progress(runId), limitation: 'Saved successful navigation text replayed with optional arrays omitted; failed raw response was not persisted.' }
    writeFileSync(`${destinationPath}.report.json`, JSON.stringify(report, null, 2))
    console.log(JSON.stringify(report))
  } finally { db.close(); pool.dispose(); source.close() }
}
void main().catch(error => { console.error(error); process.exitCode = 1 })

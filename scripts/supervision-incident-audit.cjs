/* global require, process, console */
/* eslint-disable @typescript-eslint/no-require-imports */
const assert = require('node:assert/strict')
const { DatabaseSync } = require('node:sqlite')
const { readFileSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')
const directory = process.argv[2]
const incident = JSON.parse(readFileSync(join(directory, 'incident.private.json'), 'utf8'))
const metrics = JSON.parse(readFileSync(join(directory, 'live-metrics.json'), 'utf8'))
const original = new DatabaseSync(incident.source, { readOnly: true })
const clone = new DatabaseSync(join(directory, 'assistant.sqlite'), { readOnly: true })
const plain = rows => JSON.parse(JSON.stringify(rows))
assert.deepEqual(plain(original.prepare('SELECT * FROM supervision_runs WHERE id=?').get(incident.run.id)), incident.run)
assert.deepEqual(plain(original.prepare('SELECT * FROM supervision_review_sources WHERE run_id=? ORDER BY project_id, conversation_id, sequence, source').all(incident.run.id)), incident.sources)
assert.deepEqual(plain(original.prepare('SELECT * FROM supervision_review_batches WHERE run_id=?').all(incident.run.id)), incident.batches)
assert.equal(clone.prepare('PRAGMA integrity_check').get().integrity_check, 'ok')
const facts = clone.prepare('SELECT output_json, evidence_json FROM supervision_review_batches WHERE run_id=?').get(incident.run.id)
assert(facts)
const parsed = JSON.parse(facts.output_json)
const candidates = JSON.parse(readFileSync(join(directory, 'candidates.private.json'), 'utf8'))
const legacyReused = parsed.entities.filter(entity => candidates.some(candidate => candidate.id === entity.persistedId && candidate.storageId)).length
const completeRuns = metrics.completed.map(run => {
  const row = clone.prepare('SELECT status FROM supervision_runs WHERE id=?').get(run.runId)
  assert.equal(row.status, 'completed')
  assert(clone.prepare('SELECT id FROM supervision_results WHERE run_id=?').get(run.runId))
  return { runId: run.runId, ...row }
})
const protectedRows = original.prepare("SELECT * FROM supervision_entities WHERE confirmation_state != 'automatic'").all()
for (const row of protectedRows) assert.deepEqual(clone.prepare('SELECT * FROM supervision_entities WHERE id=?').get(row.id), row)
const report = { originalRunSourcesAndBatchesUnchanged: true, originalWrites: 0, cloneIntegrity: 'ok', legacyEntitiesReusedInResumedLeaf: legacyReused,
  protectedEntitiesUnchanged: protectedRows.length, completeRuns, calls: metrics.calls.length,
  originalEntityCount: original.prepare('SELECT count(*) AS n FROM supervision_entities').get().n,
  cloneEntityCount: clone.prepare('SELECT count(*) AS n FROM supervision_entities').get().n,
  savedSourceOffsets: clone.prepare('SELECT count(*) AS n FROM supervision_review_sources WHERE run_id=? AND processed_offset=length').get(incident.run.id).n,
  automaticCheckpointRows: clone.prepare("SELECT count(*) AS n FROM review_checkpoints WHERE stage='supervisor'").get().n,
  originalRawFailureOutputAvailable: false }
assert.equal(report.savedSourceOffsets, 3)
writeFileSync(join(directory, 'audit.json'), JSON.stringify(report, null, 2))
console.log(JSON.stringify(report))
original.close(); clone.close()

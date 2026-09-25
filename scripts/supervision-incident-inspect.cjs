/* global require, process, console */
/* eslint-disable @typescript-eslint/no-require-imports */
const { DatabaseSync, backup } = require('node:sqlite')
const { mkdirSync, writeFileSync, existsSync, cpSync } = require('node:fs')
const { join, dirname } = require('node:path')
async function main() {
  const [source, output, runId] = process.argv.slice(2)
  if (existsSync(output)) throw new Error('Use a new private output directory')
  mkdirSync(output, { recursive: true })
  const db = new DatabaseSync(source, { readOnly: true })
  const run = db.prepare('SELECT * FROM supervision_runs WHERE id=?').get(runId)
  if (!run) throw new Error('Exact run not found')
  const state = db.prepare('SELECT * FROM supervision_review_runs WHERE run_id=?').get(runId)
  const sources = db.prepare('SELECT * FROM supervision_review_sources WHERE run_id=? ORDER BY project_id, conversation_id, sequence, source').all(runId)
  const batches = db.prepare('SELECT * FROM supervision_review_batches WHERE run_id=?').all(runId)
  const report = { source, run, state, sources, batches }
  writeFileSync(join(output, 'incident.private.json'), JSON.stringify(report, null, 2))
  await backup(db, join(output, 'assistant.sqlite'))
  db.close()
  const notes = join(dirname(source), 'notes')
  if (existsSync(notes)) cpSync(notes, join(output, 'notes'), { recursive: true })
  console.log(JSON.stringify({ run, state, sources: sources.length, batches: batches.length, output }))
}
main().catch(error => { console.error(error); process.exitCode = 1 })

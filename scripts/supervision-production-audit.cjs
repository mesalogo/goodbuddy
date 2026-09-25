/* global require, process, console */
/* eslint-disable @typescript-eslint/no-require-imports */
const { DatabaseSync } = require('node:sqlite')
const db = new DatabaseSync(process.argv[2], { readOnly: true })
try {
  db.exec('PRAGMA query_only = ON')
  console.log(JSON.stringify({
    runs: db.prepare('SELECT status, error FROM supervision_runs').all(),
    coverage: db.prepare(`SELECT COUNT(*) AS sources, SUM(length) AS totalCodePoints,
      SUM(processed_offset - initial_offset) AS savedCodePoints,
      SUM(processed_offset = length) AS completeSources, SUM(processed_offset < length) AS remainingSources
      FROM supervision_review_sources`).get(),
    batches: db.prepare(`SELECT COUNT(*) AS batches,
      SUM(json_array_length(evidence_json)) AS spans,
      SUM(json_array_length(output_json, '$.events')) AS events,
      SUM(json_array_length(output_json, '$.entities')) AS entities,
      SUM(json_array_length(output_json, '$.entityChanges')) AS changes,
      SUM(json_array_length(output_json, '$.relations')) AS relations FROM supervision_review_batches`).get(),
    checkpoints: db.prepare('SELECT COUNT(*) AS count FROM review_checkpoints').get(),
    results: db.prepare('SELECT COUNT(*) AS count FROM supervision_results').get(),
    integrity: db.prepare('PRAGMA integrity_check').get()
  }, null, 2))
} finally { db.close() }

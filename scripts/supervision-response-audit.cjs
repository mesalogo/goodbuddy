/* global require, process, console */
/* eslint-disable @typescript-eslint/no-require-imports */
const { readFileSync } = require('node:fs')
const { DatabaseSync } = require('node:sqlite')
const { join } = require('node:path')
const directory = process.argv[2]
const events = readFileSync(join(directory, 'response-1.private.sse'), 'utf8').split('\n')
  .filter(line => line.startsWith('data: ') && !line.includes('[DONE]')).map(line => JSON.parse(line.slice(6)))
const text = events.map(event => event.choices?.[0]?.delta?.content ?? '').join('')
const output = JSON.parse(text)
const db = new DatabaseSync(join(directory, 'assistant.sqlite'), { readOnly: true })
try {
  db.exec('PRAGMA query_only = ON')
  const sources = new Set(db.prepare('SELECT source FROM supervision_review_sources').all().map(row => row.source))
  const refs = [...new Set(['events', 'entities', 'entityChanges', 'relations'].flatMap(key => output[key].flatMap(item => item.sourceReferenceIds)))]
  console.log(JSON.stringify({ finishReasons: events.flatMap(event => event.choices ?? []).map(choice => choice.finish_reason).filter(Boolean),
    outputCharacters: text.length, references: refs.map(id => ({ id, exactSource: sources.has(id),
      sourceWithoutSpan: sources.has(id.replace(/:\d+:\d+$/, '')) })),
    records: Object.fromEntries(['events', 'entities', 'entityChanges', 'relations'].map(key => [key, output[key].length])) }, null, 2))
} finally { db.close() }

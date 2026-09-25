/* global require, process, console */
/* eslint-disable @typescript-eslint/no-require-imports */
const assert = require('node:assert/strict')
const { DatabaseSync } = require('node:sqlite')
const { createHash } = require('node:crypto')
const { mkdirSync, writeFileSync, existsSync } = require('node:fs')
const { resolve, relative, isAbsolute, join } = require('node:path')
const [path, directoryArg, excludedConversation] = process.argv.slice(2)
const directory = resolve(directoryArg), rel = relative(process.cwd(), directory)
assert((rel.startsWith('..') || isAbsolute(rel)) && !existsSync(directory))
const db = new DatabaseSync(path, { readOnly: true })
try {
  db.exec('PRAGMA query_only = ON; BEGIN')
  const selected = db.prepare(`SELECT c.id, COUNT(*) AS messages, SUM(length(m.content)) AS characters
    FROM conversations c JOIN projects p ON p.id = c.project_id JOIN messages m ON m.conversation_id = c.id
    WHERE c.status = 'active' AND p.status = 'active' AND m.role IN ('user', 'assistant') AND c.id != ?
    GROUP BY c.id HAVING COUNT(*) BETWEEN 21 AND 40 AND SUM(length(m.content)) BETWEEN 8001 AND 14000
      AND MIN(length(m.content)) > 0 AND MAX(length(m.content)) < 8000
    ORDER BY c.updated_at DESC, c.id LIMIT 1`).get(excludedConversation)
  assert(selected, 'No complete conversation meets the bounded experiment criteria')
  const messages = db.prepare(`SELECT id, role, content, created_at, sequence FROM messages
    WHERE conversation_id = ? AND role IN ('user','assistant') ORDER BY sequence, id`).all(selected.id)
  assert.equal(messages.length, selected.messages)
  const dates = messages.map(message => message.created_at).sort()
  const scope = { conversationId: selected.id, sourceMessages: messages.length,
    sourceHash: createHash('sha256').update(JSON.stringify(messages)).digest('hex'),
    codePoints: messages.reduce((sum, message) => sum + Array.from(message.content).length, 0),
    firstAt: dates[0], lastAt: dates.at(-1), originalDatabaseReadOnly: true }
  mkdirSync(directory, { recursive: true })
  writeFileSync(join(directory, 'scope.json'), JSON.stringify(scope, null, 2))
  writeFileSync(join(directory, 'sources.private.json'), JSON.stringify({ messagePages: [messages] }))
  console.log(JSON.stringify({ sourceMessages: scope.sourceMessages, codePoints: scope.codePoints, directory }))
  db.exec('COMMIT')
} finally { db.close() }

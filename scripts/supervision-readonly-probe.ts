// Bundle with esbuild (Node, CJS); all output files must be outside the repository.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import ts from 'typescript'
import { AssistantDatabase } from '../src/main/assistant/assistant-database'
import { SupervisorService } from '../src/main/assistant/supervisor-service'
import type { SupervisionEvidence, SupervisionRunRequest } from '../src/shared/supervision-contracts'

async function main() {
  const [databasePath, conversationId, outputDirectory, repository] = process.argv.slice(2)
  assert(databasePath && conversationId && outputDirectory && repository)
  assert(!resolve(outputDirectory).toLowerCase().startsWith(resolve(repository).toLowerCase()))
  const started = performance.now()
  const sql = new DatabaseSync(databasePath, { readOnly: true })
  sql.exec('PRAGMA query_only = ON; BEGIN')
  // Do not initialize AssistantDatabase: initialization performs migrations and recovery writes.
  const database = Object.create(AssistantDatabase.prototype) as AssistantDatabase
  Object.assign(database, { requireDatabase: () => sql })
  const digest = (text: string) => createHash('sha256').update(text).digest('hex')
  const runs = sql.prepare(`SELECT id, trigger, status, started_at, completed_at, scope_json,
    time_range_json, error FROM supervision_runs ORDER BY created_at DESC LIMIT 20`).all()
  const last = runs.find((r) => r.trigger === 'manual' && JSON.parse(String(r.scope_json)).kind === 'global')
  assert(last, 'No manual global run')
  const request: SupervisionRunRequest = { trigger: 'manual', scope: { kind: 'global' }, timeRange: JSON.parse(String(last.time_range_json)) }
  // Extract the actual IPC collector, so this probe cannot silently diverge from its mapping.
  const ipc = readFileSync(join(repository, 'src/main/ipc.ts'), 'utf8')
  const ast = ts.createSourceFile('ipc.ts', ipc, ts.ScriptTarget.Latest, true)
  let collectorText = ''
  const visit = (node: ts.Node) => {
    if (ts.isNewExpression(node) && node.expression.getText(ast) === 'SupervisorService') {
      const collector = node.arguments?.[0]
      assert(collector && ts.isObjectLiteralExpression(collector))
      const property = collector.properties.find((p) => p.name?.getText(ast) === 'collect')
      assert(property && ts.isPropertyAssignment(property))
      collectorText = property.initializer.getText(ast)
    }
    ts.forEachChild(node, visit)
  }
  visit(ast)
  assert(collectorText)
  const js = ts.transpile(`const collect = ${collectorText}`, { target: ts.ScriptTarget.ES2022 })
  const collect = new Function('assistantDatabase', `${js}; return collect`)(database) as (r: SupervisionRunRequest) => Promise<SupervisionEvidence[]>
  const collectStart = performance.now()
  const evidence = await collect(request)
  const collectMs = performance.now() - collectStart
  let included: SupervisionEvidence[] = []
  let promptChars = 0
  let baselineCalls = 0
  const empty = { summary: 'probe', changeDigest: '', openItems: [], events: [], entities: [], entityChanges: [], relations: [] }
  const supervisor = new SupervisorService({ collect: async () => evidence }, {
    summarize: async (input) => {
      baselineCalls++
      included = input.evidence
      promptChars = [input.systemInstruction, 'OUTPUT CONTRACT:', input.outputContract,
        'REVIEW TIME RANGE:', JSON.stringify(input.request.timeRange), 'KNOWN ENTITIES:', JSON.stringify(input.candidates),
        'PREVIOUS SUMMARY (background only):', input.previousSummary ?? '', 'BOUNDED EVIDENCE:', JSON.stringify(input.evidence), 'Return only JSON.'].join('\n\n').length
      return empty
    }
  }, { candidates: async (r) => database.listSupervisionCandidates(r), summary: (r) => database.reviewSummary(r.scope, 'supervisor'), save: async () => {} })
  await supervisor.run(request)
  await supervisor.run(request)
  const eligible = sql.prepare(`SELECT count(*) AS messages, count(DISTINCT c.id) AS conversations,
    count(DISTINCT c.project_id) AS projects, sum(length(m.content)) AS codePoints
    FROM messages m JOIN conversations c ON c.id=m.conversation_id JOIN projects p ON p.id=c.project_id
    WHERE c.status='active' AND p.status='active' AND m.role IN ('user','assistant') AND m.created_at>=? AND m.created_at<=?`).get(request.timeRange.from, request.timeRange.to)
  const target = sql.prepare(`SELECT c.id, c.status, p.status AS project_status FROM conversations c JOIN projects p ON p.id=c.project_id WHERE c.id=?`).get(conversationId)
  assert(target, 'Conversation ID not found')
  type Message = { id: string; role: string; content: string; created_at: string; sequence: number }
  const messages = sql.prepare(`SELECT id, role, content, created_at, sequence FROM messages
    WHERE conversation_id=? AND role IN ('user','assistant') ORDER BY sequence, id`).all(conversationId) as Message[]
  const inRange = messages.filter((m) => m.created_at >= request.timeRange.from && m.created_at <= request.timeRange.to)
  const mapping: object[] = []
  let codePoints = 0, jsChars = 0, chunks = 0, maxChunkJsChars = 0
  for (const message of messages) {
    const points = Array.from(message.content)
    let reconstructed = ''
    for (let start = 0; start < points.length; start += 2000) {
      const end = Math.min(points.length, start + 2000)
      const content = points.slice(start, end).join('')
      reconstructed += content
      maxChunkJsChars = Math.max(maxChunkJsChars, content.length)
      mapping.push({ messageId: message.id, sequence: message.sequence, start, end, revision: digest(message.content), chunkHash: digest(content) })
      chunks++
    }
    assert.equal(reconstructed, message.content)
    codePoints += points.length
    jsChars += message.content.length
  }
  console.log(JSON.stringify({ targetMetadata: { messages: messages.length, jsChars, codePoints, roles: ['user', 'assistant'].map((role) => ({ role, count: messages.filter((m) => m.role === role).length, maxJsChars: Math.max(0, ...messages.filter((m) => m.role === role).map((m) => m.content.length)) })) } }))
  const selected = messages.filter((m) => m.content.length >= 120 && m.content.length <= 8000 && /[。.!！]/u.test(m.content))
  assert(selected.length >= 2)
  const samples = [selected[0]!, selected[selected.length - 1]!].map((m, i) => {
    const sentences = m.content.match(/[^。！？.!?\n]+[。！？.!?]?/gu) ?? []
    const anchor = sentences.map((s) => s.trim()).find((s) => s.length >= 25 && s.length <= 160)
    assert(anchor, 'No bounded anchor')
    return { id: `sample-${i + 1}`, messageId: m.id, sequence: m.sequence, role: m.role, occurredAt: m.created_at, content: m.content, anchor }
  })
  const byType = (items: SupervisionEvidence[]) => Object.fromEntries(['conversation', 'knowledge', 'task', 'memory'].map((type) => {
    const rows = items.filter((i) => i.sourceType === type)
    return [type, { count: rows.length, jsChars: rows.reduce((n, i) => n + i.content.length, 0) }]
  }))
  const includedIds = new Set(included.map((e) => e.id))
  const targetEvidence = (items: SupervisionEvidence[]) => items.filter((e) => e.sourceType === 'conversation' && e.sourceId === conversationId)
  const incrementalStart = performance.now()
  const incremental = database.collectIncrementalReview({ ...request, trigger: 'heartbeat' }, 'supervisor', 44000)
  const incrementalMs = performance.now() - incrementalStart
  let sourceErrors = 0
  for (const e of evidence.filter((e) => e.sourceType === 'conversation')) {
    const m = sql.prepare('SELECT content, conversation_id FROM messages WHERE id=?').get(e.id.slice(e.sourceId.length + 1))
    if (!m || m.conversation_id !== e.sourceId || m.content !== e.content) sourceErrors++
  }
  const report = { capturedAt: new Date().toISOString(), databaseReadOnly: true, historicalSnapshot: false,
    request, runs: runs.map((r) => ({ id: r.id, trigger: r.trigger, status: r.status, startedAt: r.started_at, completedAt: r.completed_at,
      durationMs: r.completed_at ? Date.parse(String(r.completed_at)) - Date.parse(String(r.started_at)) : null,
      errorKind: /abort/i.test(String(r.error)) ? 'abort' : r.error ? 'other' : null })),
    counts: Object.fromEntries(['supervision_results','review_checkpoints','heartbeat_runs'].map((t) => [t, sql.prepare(`SELECT count(*) AS n FROM ${t}`).get()!.n])),
    eligible, collector: { ms: collectMs, byType: byType(evidence), sourceMappingErrors: sourceErrors, sourceHash: digest(collectorText) },
    service: { byType: byType(included), promptJsChars: promptChars, omittedEvidence: evidence.filter((e) => !includedIds.has(e.id)).length,
      truncatedEvidence: included.filter((e) => e.content !== evidence.find((s) => s.id === e.id)!.content).length,
      uniqueConversations: new Set(included.filter((e) => e.sourceType === 'conversation').map((e) => e.sourceId)).size,
      missingMessageLocator: included.filter((e) => e.sourceType === 'conversation' && !e.locator?.messageId).length,
      repeatedManualSummarizerCalls: baselineCalls, realModelCalls: 0 },
    target: { ...target, messages: messages.length, firstAt: messages[0]?.created_at, lastAt: messages.at(-1)?.created_at,
      codePoints, jsChars, inRange: inRange.length, inRangeJsChars: inRange.reduce((n, m) => n + m.content.length, 0),
      collectorMessages: targetEvidence(evidence).length, includedMessages: targetEvidence(included).length,
      includedJsChars: targetEvidence(included).reduce((n, e) => n + e.content.length, 0) },
    offlineChunkAudit: { chunks, maxChunkJsChars, reconstructedMessages: messages.length, sourceMappingErrors: 0, modelProcessedChunks: 0 },
    incremental: { ms: incrementalMs, evidence: incremental.evidence.length, jsChars: incremental.evidence.reduce((n, e) => n + e.content.length, 0),
      completeSources: incremental.checkpoints.filter((c) => c.offset === c.length).length },
    samples: samples.map(({ id, sequence, content, anchor }) => ({ id, sequence, jsChars: content.length, anchorJsChars: anchor.length })),
    totalMs: performance.now() - started }
  sql.exec('ROLLBACK')
  sql.close()
  writeFileSync(join(outputDirectory, 'coverage.json'), JSON.stringify(report, null, 2))
  writeFileSync(join(outputDirectory, 'source-map.json'), JSON.stringify(mapping))
  writeFileSync(join(outputDirectory, 'samples.private.json'), JSON.stringify(samples))
  console.log(JSON.stringify(report, null, 2))
}
void main().catch((error) => { console.error(JSON.stringify({ failed: error instanceof Error ? error.name : 'Error', stack: error instanceof Error ? error.stack?.split('\n').slice(1) : [] })); process.exitCode = 1 })

// Bounded validation of the same factory used by Main IPC. Private artifacts stay outside the repository.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { resolve, join, relative, isAbsolute } from 'node:path'
import { parseEnv } from 'node:util'
import { AssistantDatabase } from '../src/main/assistant/assistant-database'
import { createProductionSupervisorService } from '../src/main/assistant/supervision-production'
import { SupervisionModelPool } from '../src/main/assistant/supervision-model-pool'
import { ModelAgentRuntime } from '../src/main/agent/model-runtime'

async function main() {
  const [sourceArg, outputArg, envArg, mode] = process.argv.slice(2)
  assert(sourceArg && outputArg && envArg, 'Expected source-directory output-directory env-file')
  const output = resolve(outputArg), rel = relative(process.cwd(), output)
  assert(rel.startsWith('..') || isAbsolute(rel), 'Private output must be outside repository')
  mkdirSync(output, { recursive: true })
  const env = parseEnv(readFileSync(envArg, 'utf8'))
  assert(env.DEEPSEEK_API_KEY && env.DEEPSEEK_BASE_URL && env.DEEPSEEK_MODEL?.startsWith('deepseek-'))
  const scope = JSON.parse(readFileSync(join(sourceArg, 'scope.json'), 'utf8'))
  const source = JSON.parse(readFileSync(join(sourceArg, 'sources.private.json'), 'utf8'))
  const messages = source.messagePages.flat() as Array<{ id: string; content: string; role: 'user' | 'assistant'; created_at: string }>
  assert.equal(createHash('sha256').update(JSON.stringify(messages)).digest('hex'), scope.sourceHash)
  assert.equal(messages.length, scope.sourceMessages)
  const previous = mode === 'resume-cached' ? JSON.parse(readFileSync(join(output, 'metrics.json'), 'utf8')) : undefined
  if (previous) assert.equal(previous.sourceHash, scope.sourceHash)
  const calls: Array<{ status?: number; ms?: number; inputBytes: number; requestHash?: string }> = previous?.calls ?? []
  let cachedResponse = previous ? readFileSync(join(output, 'response-1.private.sse'), 'utf8') : undefined
  const seen = new Set<string>()
  const captures: Promise<void>[] = []
  const maxCalls = 8
  const started = performance.now()
  const metrics: Record<string, unknown> = { model: env.DEEPSEEK_MODEL, maxCalls, sourceMessages: messages.length,
    sourceCodePoints: scope.codePoints, sourceHash: scope.sourceHash, originalDatabaseOpened: false, calls,
    previousFailure: previous ? { error: previous.error, elapsedMs: previous.elapsedMs, paidCalls: previous.calls.length } : undefined }
  const persist = () => writeFileSync(join(output, 'metrics.json'), JSON.stringify(metrics, null, 2))
  const runtime = new ModelAgentRuntime({ protocol: 'openai-chat-completions', authentication: 'api-key',
    baseUrl: env.DEEPSEEK_BASE_URL, model: env.DEEPSEEK_MODEL, apiKey: env.DEEPSEEK_API_KEY,
    defaultWorkspace: output, maximumOutputTokens: 16384, requestBody: { thinking: { type: 'disabled' }, response_format: { type: 'json_object' } },
    toolProvider: { listTools: async () => [], getApproval: () => { throw new Error('Tools disabled') },
      callTool: async () => { throw new Error('Tools disabled') }, releaseConversation: async () => undefined, dispose: async () => undefined },
    fetcher: async (input, init) => {
      const body = String(init?.body)
      assert.equal(JSON.parse(body).tools?.length ?? 0, 0)
      const hash = createHash('sha256').update(body).digest('hex')
      if (cachedResponse !== undefined) {
        assert.equal(calls.length, 1, 'Only the recorded first response may be revalidated')
        assert.equal(Buffer.byteLength(body), calls[0]!.inputBytes, 'Cached response input shape changed')
        const response = new Response(cachedResponse, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
        cachedResponse = undefined
        seen.add(hash)
        metrics.cachedResponses = 1
        persist()
        return response
      }
      assert(!seen.has(hash), 'Paid retries forbidden')
      assert(calls.length < maxCalls, 'Paid request cap reached')
      seen.add(hash)
      const call: typeof calls[number] = { inputBytes: Buffer.byteLength(body), requestHash: hash }
      calls.push(call); persist()
      const start = performance.now()
      const response = await fetch(input, init)
      call.status = response.status; call.ms = performance.now() - start; persist()
      const index = calls.length
      captures.push(response.clone().text().then(text => {
        writeFileSync(join(output, `response-${index}.private.sse`), text)
      }).catch(() => undefined))
      return response
    }
  })
  const db = new AssistantDatabase(join(output, 'assistant.sqlite'))
  db.initialize(output)
  const pool = new SupervisionModelPool()
  try {
    const existing = db.listSupervisionActivity()
    assert.equal(existing.length, previous ? 1 : 0, 'Unexpected saved run')
    if (previous) assert.equal(existing[0]!.reviewProgress?.batches, 0, 'Only revalidate the unsaved first response')
    if (!previous) db.saveLocalConversations([{ header: { id: scope.conversationId, projectId: db.listProjects()[0]!.id,
      title: 'Private selected conversation', updatedAt: Date.parse(scope.lastAt) },
      messages: messages.map(message => ({ id: message.id, content: message.content, role: message.role,
        createdAt: Date.parse(message.created_at), state: 'complete' })) }])
    const service = createProductionSupervisorService(db, async () => ({ heartbeatEnabled: true,
      supervisorModelConcurrency: 2, supervisorOrganizeTimeoutSeconds: 180,
      supervisionReview: { pageSize: 17, batchCharacters: 8000, batchMessages: 20, executionSeconds: 600 }
    }), async () => runtime, pool)
    const result = previous ? await service.resume(existing[0]!.id)
      : await service.run({ trigger: 'manual', scope: { kind: 'global' }, timeRange: { from: scope.firstAt, to: scope.lastAt } })
    assert.equal(result.status, 'completed')
    const evidence = db.supervisionReviewStore().batches(result.runId!, 1000).flatMap(batch => batch.evidence)
    for (const message of messages) {
      const spans = evidence.filter(item => item.locator?.messageId === message.id).sort((a, b) => Number(a.locator!.start) - Number(b.locator!.start))
      assert.equal(spans.map(span => span.content).join(''), message.content)
      let at = 0
      for (const span of spans) { assert.equal(span.locator!.start, at); at += Array.from(span.content).length; assert.equal(span.locator!.end, at) }
    }
    metrics.coverage = result.coverage
    metrics.spans = evidence.length
    metrics.retainedFacts = db.supervisionReviewStore().batches(result.runId!, 1000).reduce((sum, batch) =>
      sum + batch.output.events.length + batch.output.entities.length + batch.output.entityChanges.length + batch.output.relations.length, 0)
    metrics.passed = true
  } catch (error) {
    metrics.passed = false
    metrics.error = error instanceof Error ? error.message : 'Validation failed'
    process.exitCode = 1
  } finally {
    await Promise.all(captures)
    metrics.elapsedMs = performance.now() - started
    persist()
    // No prompts, model responses, credentials, or source text in terminal output.
    console.log(JSON.stringify({ passed: metrics.passed, calls: calls.length, coverage: metrics.coverage, elapsedMs: metrics.elapsedMs, output }))
    db.close(); pool.dispose(); await runtime.dispose()
  }
}
void main().catch(() => { console.error('Production review preflight failed'); process.exitCode = 1 })

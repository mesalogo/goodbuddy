import { app, safeStorage } from 'electron'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { RuntimeSettingsStore } from '../../src/main/runtime-settings-store'
import { createDefaultModelRuntime } from '../../src/main/agent/create-runtime'
import { AssistantDatabase } from '../../src/main/assistant/assistant-database'
import { SupervisorService } from '../../src/main/assistant/supervisor-service'
import { HeartbeatService } from '../../src/main/assistant/heartbeat-service'
import type { SupervisionRunRequest } from '../../src/shared/supervision-contracts'

const directory = process.env.GB_REVIEW_LIVE_DIRECTORY!
const settingsPath = process.env.GB_REVIEW_LIVE_SETTINGS!
const profileDirectory = join(directory, 'profile')
mkdirSync(profileDirectory, { recursive: true })
app.setPath('userData', profileDirectory)
if (process.platform === 'win32') {
  const localState = JSON.parse(readFileSync(join(dirname(settingsPath), 'Local State'), 'utf8'))
  writeFileSync(join(profileDirectory, 'Local State'), JSON.stringify({ os_crypt: localState.os_crypt }))
}

void app.whenReady().then(async () => {
  const original = readFileSync(settingsPath)
  const snapshot = join(directory, 'settings.snapshot.json')
  writeFileSync(snapshot, original)
  const store = new RuntimeSettingsStore(snapshot, {
    isAvailable: () => safeStorage.isEncryptionAvailable(),
    encrypt: () => { throw new Error('Probe must not write credentials') },
    decrypt: (value) => safeStorage.decryptString(value)
  }, {})
  const settings = await store.getResolvedSettings().finally(() => unlinkSync(snapshot))
  assert(settings.modelName && settings.modelProtocol !== 'openai-images-generations', 'Default profile is not a text model')
  assert(settings.modelAuthentication === 'none' || settings.apiKey, 'Default profile credential is unavailable')
  settings.workspacePath = directory
  settings.modelProfiles = settings.modelProfiles.map((profile) => ({ ...profile, maximumOutputTokens: 2500 }))
  const observations: Array<{ status?: number; tools: number; stage: string }> = []
  let stage = ''
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (input, init) => {
    assert(observations.length < 3, 'Three-request live budget exhausted')
    const body = JSON.parse(String(init?.body))
    assert.equal(body.tools?.length ?? 0, 0)
    assert(!/"(?:input_image|image_url|input_file)"/.test(JSON.stringify(body)), 'Unexpected attachment')
    const record = { stage, tools: 0, status: undefined as number | undefined }
    observations.push(record)
    const response = await originalFetch(input, init)
    record.status = response.status
    return response
  }
  const runtime = createDefaultModelRuntime(directory, settings)
  const db = new AssistantDatabase(join(directory, 'assistant.sqlite'))
  db.initialize(directory)
  const sql = new DatabaseSync(join(directory, 'assistant.sqlite'))
  const call = async (prompt: string) => {
    const conversationId = `review-probe:${randomUUID()}`
    let text = ''
    try {
      for await (const event of runtime.run({ requestId: randomUUID(), conversationId, workMode: 'ask', prompt },
        AbortSignal.timeout(90000), async () => 'deny')) {
        if (event.type === 'text') text += event.delta
        if (event.type === 'error') throw new Error(event.message)
        assert(event.type !== 'tool', 'Unexpected tool event')
      }
      return text
    } finally { await runtime.releaseConversation?.(conversationId) }
  }
  try {
    const now = new Date()
    const messageId = randomUUID()
    db.replaceConversations([{ id: randomUUID(), projectId: db.listProjects()[0]!.id, title: 'Atlas release', updatedAt: now.getTime(),
      messages: [{ id: messageId, role: 'user', state: 'complete', createdAt: now.getTime() - 1000,
        content: 'The Atlas release uses SQLite. The release date is October 4. Track Atlas as one release entity.' }] }])
    const request: SupervisionRunRequest = { trigger: 'heartbeat', scope: { kind: 'global' }, timeRange: {
      from: new Date(now.getTime() - 3600_000).toISOString(), to: new Date(now.getTime() + 3600_000).toISOString()
    } }
    const supervisor = new SupervisorService({
      collect: async () => { throw new Error('Expected automatic collector') },
      incremental: async (input) => db.collectIncrementalReview(input, 'supervisor')
    }, { summarize: async (input) => {
      stage = 'supervisor'
      return call([input.systemInstruction, 'OUTPUT CONTRACT:', input.outputContract,
        'REVIEW TIME RANGE:', JSON.stringify(input.request.timeRange), 'KNOWN ENTITIES:', JSON.stringify(input.candidates),
        'PREVIOUS SUMMARY (background only):', input.previousSummary ?? '', 'BOUNDED EVIDENCE:', JSON.stringify(input.evidence), 'Return only JSON.'].join('\n\n'))
    } }, {
      scope: (scope) => db.resolveReviewScope(scope), summary: (input) => db.reviewSummary(input.scope, 'supervisor'),
      start: (input, heartbeatRunId) => db.startSupervisionRun(input, heartbeatRunId),
      fail: (id, error) => db.failSupervisionRun(id, error), noChange: (id) => db.noChangeSupervisionRun(id),
      candidates: async (input) => db.listSupervisionCandidates(input), save: async (result) => db.saveSupervisionResult(result)
    })
    const heartbeat = new HeartbeatService(db, { summarize: async (input) => {
      stage = 'heartbeat'
      return call([input.systemInstruction, 'OUTPUT CONTRACT:', JSON.stringify(input.outputContract),
        'BOUNDED INPUT:', JSON.stringify(input.input), 'Return only JSON. Do not propose memories or follow-up tasks for this simple release update.'].join('\n\n'))
    } }, () => { throw new Error('Tools denied') }, async ({ run }) => { await supervisor.run(request, run.id) })
    const config = heartbeat.create({ name: 'Isolated live test', scope: request.scope, timezone: 'UTC',
      recurrence: { type: 'daily', localTime: '09:00' }, enabled: true, lookbackHours: 24, retentionDays: 30 }, now)
    let tick = 0
    const due = async () => {
      sql.prepare('UPDATE heartbeat_configs SET next_run_at = ? WHERE id = ?').run(new Date(now.getTime() - 10000 + tick++).toISOString(), config.id)
      await heartbeat.processDue(new Date())
    }
    await due()
    assert.equal(observations.length, 2)
    assert.equal(db.listSupervisionActivity()[0]!.status, 'completed')
    const first = db.listSupervisionCandidates(request)
    assert(first.length > 0, 'Model did not create an entity')
    const firstGraph = db.getSupervisionGraph()
    await due()
    assert.equal(observations.length, 2, 'Unchanged automatic run made a request')
    assert.equal(db.listSupervisionActivity()[0]!.status, 'no_change')
    assert.deepEqual(db.getSupervisionGraph(), firstGraph)
    sql.prepare('UPDATE messages SET content = ? WHERE id = ?').run(
      'The same Atlas release has moved from October 4 to October 6. SQLite remains the storage choice. Update the existing Atlas release entity.', messageId)
    const changed = await supervisor.run(request)
    assert.equal(observations.length, 3)
    const reused = changed.output.entities.filter((entity) => entity.persistedId && first.some((candidate) => candidate.id === entity.persistedId))
    assert(reused.length > 0, 'Changed review did not reuse a known entity ID')
    assert.equal((await supervisor.run(request)).status, 'no_change')
    assert.equal(observations.length, 3)
    assert.deepEqual(sql.prepare('PRAGMA foreign_key_check').all(), [])
    assert(readFileSync(settingsPath).equals(original), 'Source settings changed')
    console.log(JSON.stringify({ model: settings.modelName, protocol: settings.modelProtocol, actualCalls: observations,
      unchangedAutomaticCalls: 0, unchangedSupervisorCalls: 0, originalSettingsUnchanged: true,
      firstEntityCount: first.length, reusedEntityCount: reused.length, changedEvidenceCount: changed.evidence.length,
      changedSummary: changed.output.summary, changedEntities: changed.output.entities.map(({ label, description }) => ({ label, description })),
      resultCount: db.listSupervisionResults().length, integrity: sql.prepare('PRAGMA integrity_check').get() }))
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Live validation failed'
    console.log(JSON.stringify({ failed: settings.apiKey ? message.replaceAll(settings.apiKey, '[redacted]') : message,
      model: settings.modelName, actualCalls: observations }))
    process.exitCode = 1
  } finally {
    sql.close(); db.close(); await runtime.dispose?.(); globalThis.fetch = originalFetch
  }
  app.exit(process.exitCode ? 1 : 0)
}).catch(() => { console.log('Live preflight failed: encrypted default text profile could not be loaded'); app.exit(1) })

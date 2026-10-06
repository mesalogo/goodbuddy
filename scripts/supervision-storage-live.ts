// Run through supervision-storage-live.cjs. Only synthetic evidence is sent to the model.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile, writeFile, rm } from 'node:fs/promises'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { app, safeStorage } from 'electron'
import { RuntimeSettingsStore } from '../src/main/runtime-settings-store'
import { ModelAgentRuntime } from '../src/main/agent/model-runtime'
import { DesktopStorageClient } from '../src/main/desktop-storage-client'
import { createSupervisionDomainPorts } from '../src/main/assistant/supervision-domain-ports'
import { createProductionSupervisorService, createProductionSuggestionPhraser } from '../src/main/assistant/supervision-production'
import { SupervisionModelPool } from '../src/main/assistant/supervision-model-pool'
import { HeartbeatService } from '../src/main/assistant/heartbeat-service'
import { deriveSuggestions } from '../src/main/assistant/supervision-suggester'
import type { SupervisionRunRequest } from '../src/shared/supervision-contracts'

const root = process.env.GB_SUPERVISION_STORAGE_ROOT!
const settingsPath = process.env.GB_SUPERVISION_SETTINGS!
const calls: Array<{ status?: number; inputBytes: number; ms?: number }> = []
const report: Record<string, unknown> = { syntheticOnly: true, maximumHttpCalls: 4, calls }
async function run() {
  report.stage = 'preflight'
  assert(root && settingsPath)
  const profileDirectory = join(root, 'electron')
  // Electron must see the copied encryption state before its ready event.
  mkdirSync(profileDirectory)
  app.setPath('userData', profileDirectory)
  if (process.platform === 'win32') {
    const state = JSON.parse(readFileSync(join(dirname(settingsPath), 'Local State'), 'utf8'))
    writeFileSync(join(profileDirectory, 'Local State'), JSON.stringify({ os_crypt: state.os_crypt }))
  }
  await app.whenReady()
  const original = await readFile(settingsPath)
  const snapshot = join(root, 'settings.snapshot.json')
  await writeFile(snapshot, original)
  const settings = await new RuntimeSettingsStore(snapshot, {
    isAvailable: () => safeStorage.isEncryptionAvailable(),
    encrypt: () => { throw new Error('Probe does not write credentials') },
    decrypt: value => safeStorage.decryptString(value)
  }, {}).getResolvedSettings().finally(() => rm(snapshot, { force: true }))
  const application = JSON.parse(await readFile(join(dirname(settingsPath), 'application-settings.json'), 'utf8'))
  const selectedId = application.supervisorModelProfileId ?? settings.defaultModelProfileId
  const selected = settings.modelProfiles.find(profile => profile.id === selectedId)
  report.selection = { profileCount: settings.modelProfiles.length, explicitSupervisor: Boolean(application.supervisorModelProfileId),
    found: Boolean(selected), protocol: selected?.protocol, authentication: selected?.authentication, credentialAvailable: Boolean(selected?.apiKey) }
  assert(selected && selected.protocol !== 'openai-images-generations', 'No configured supervisor text model')
  assert(selected.authentication === 'none' || selected.apiKey, 'No configured credential')
  report.model = selected.modelName
  report.protocol = selected.protocol
  const storage = new DesktopStorageClient({ assistantPath: join(root, 'assistant.sqlite'), knowledgePath: join(root, 'knowledge.sqlite'),
    userDataPath: root, defaultRootPath: root, entryPath: join(root, 'desktop-storage-entry.mjs'),
    readerWorkerPath: join(root, 'readonly-query-worker.cjs'), upgradeWorkerPath: join(root, 'assistant-storage-worker.cjs') })
  const pool = new SupervisionModelPool()
  const runtime = () => new ModelAgentRuntime({ protocol: selected.protocol, authentication: selected.authentication,
    apiKey: selected.apiKey, baseUrl: selected.baseUrl, model: selected.modelName,
    requestHeaders: selected.requestHeaders, requestBody: selected.requestBody,
    maximumOutputTokens: 3000, defaultWorkspace: root,
    toolProvider: { listTools: async () => [], getApproval: () => { throw new Error('Probe tools disabled') },
      callTool: async () => { throw new Error('Probe tools disabled') }, releaseConversation: async () => {}, dispose: async () => {} },
    fetcher: async (input, init) => {
      assert(calls.length < 4, 'Probe HTTP capacity reached')
      const body = JSON.parse(String(init?.body))
      assert.equal(body.tools?.length ?? 0, 0)
      const call: (typeof calls)[number] = { inputBytes: Buffer.byteLength(String(init?.body)) }
      calls.push(call)
      console.log(JSON.stringify({ event: 'model-request', number: calls.length }))
      const start = performance.now()
      const response = await fetch(input, { ...init, signal: AbortSignal.any([...(init?.signal ? [init.signal] : []), AbortSignal.timeout(60_000)]) })
      call.status = response.status
      call.ms = Math.round(performance.now() - start)
      return response
    } })
  try {
    report.stage = 'storage-ready'
    await storage.ready
    const ports = createSupervisionDomainPorts(storage)
    const project = (await storage.call('assistant', 'listProjects', []))[0]!
    const now = Date.now()
    const messages = [
      'Synthetic project Aurora maintains a weather sensor calibration module. Decision: calibrate against a reference sensor before each field deployment. This replaced the earlier plan to calibrate only after deployment.',
      'Milestone: the pre-deployment reference calibration detected a two-degree offset, which we corrected before deployment. The field measurements then matched the reference. Lesson: verify calibration before deployment to prevent biased field data.',
      'Open question for the calibration module: should routine recalibration happen monthly or quarterly? No interval has been decided.'
    ].map((content, index) => ({ id: randomUUID(), role: 'user' as const, content, state: 'complete' as const, createdAt: now + index }))
    await storage.call('assistant', 'saveLocalConversations', [[{
      header: { id: randomUUID(), projectId: project.id, title: 'Synthetic Aurora calibration', updatedAt: now + 2 }, messages
    }]])
    const request: SupervisionRunRequest = { trigger: 'heartbeat', scope: { kind: 'global' },
      timeRange: { from: new Date(now - 1000).toISOString(), to: new Date(now + 1000).toISOString() } }
    const getSettings = async () => ({ supervisorModelProfileId: selectedId, supervisorOrganizeTimeoutSeconds: 60,
      supervisorModelConcurrency: 1, supervisionReview: { pageSize: 10, batchCharacters: 8000, batchMessages: 10,
        executionSeconds: 300, experienceMinEvents: 2, storyThreadEvents: 20 } })
    const supervisor = createProductionSupervisorService(ports.supervision, getSettings, async () => runtime(), pool)
    const phrase = createProductionSuggestionPhraser(ports.supervision, getSettings, async () => runtime(), pool)
    const heartbeat = new HeartbeatService(ports.heartbeat, {
      review: async ({ run }) => {
        const result = await supervisor.run(request, run.id)
        assert.equal(result.status, 'completed')
        assert.equal(result.coverage?.complete, true)
        assert.equal(result.coverage?.stories?.status, 'completed')
        report.coverage = result.coverage
        return { status: result.status, runId: result.runId }
      },
      suggest: async ({ run, supervisionRunId }) => deriveSuggestions(ports.suggestions, phrase, { supervisionRunId, heartbeatRunId: run.id })
    })
    const config = await heartbeat.create({ name: 'Synthetic probe', scope: request.scope, timezone: 'UTC',
      recurrence: { type: 'daily', localTime: '09:00' }, enabled: true, lookbackHours: 24, retentionDays: 30 })
    const first = await heartbeat.runNow({ id: config.id, idempotencyKey: 'first' })
    report.stage = 'verify-publication'
    const activity = (await storage.call('assistant', 'listSupervisionActivity', [10, 0, config.id]))[0]!
    assert.equal(activity.status, 'completed')
    assert.equal(activity.suggestionStatus, 'completed')
    const stories = await ports.stories.list(request.scope)
    const experiences = await ports.experiences.list()
    const suggestions = await ports.suggestions.countForHeartbeat(first.id)
    assert(stories.length > 0 && experiences.length > 0 && suggestions > 0)
    const before = calls.length
    const quiet = await supervisor.run(request)
    assert.equal(quiet.status, 'no_change')
    assert.equal(calls.length, before)
    report.counts = { stories: stories.length, experiences: experiences.length, suggestions }
    report.noChangeCalls = calls.length - before
    report.usage = (await storage.call('assistant', 'getTokenUsageSummary', [])).systemTotals
    report.settingsUnchanged = (await readFile(settingsPath)).equals(original)
    assert.equal(report.settingsUnchanged, true)
    assert.equal(storage.pendingCount, 0)
    report.passed = true
  } finally { pool.dispose(); await storage.close() }
}
void run().catch(error => {
  report.passed = false
  report.errorType = error instanceof Error ? error.name : 'Error'
  // Do not print provider errors, headers, credentials, or settings.
}).finally(() => { console.log(JSON.stringify(report)); app.exit(report.passed ? 0 : 1) })

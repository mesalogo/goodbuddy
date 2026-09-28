import { app, safeStorage } from 'electron'
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import { RuntimeSettingsStore } from '../../src/main/runtime-settings-store'
import { createModelProfileRuntime } from '../../src/main/agent/create-runtime'
import { applyRuntimeSelection } from '../../src/main/agent/runtime-selection'
import { defaultRuntimeSettings } from '../../src/shared/contracts'

let calls = 0
let stage = 'settings'
void app.whenReady().then(async () => {
  const directory = process.env.GB_COMPACT_LIVE_DIRECTORY!
  const source = process.env.GB_COMPACT_LIVE_SETTINGS!
  const original = readFileSync(source)
  const snapshot = join(directory, 'settings-snapshot.json')
  writeFileSync(snapshot, original)
  const store = new RuntimeSettingsStore(snapshot, {
    isAvailable: () => safeStorage.isEncryptionAvailable(),
    encrypt: () => { throw new Error('Read-only probe') },
    decrypt: value => safeStorage.decryptString(value)
  }, process.env)
  const settings = await store.getResolvedSettings().finally(() => unlinkSync(snapshot))
  stage = 'profile'
  const profile = settings.modelProfiles.find(item => item.protocol !== 'openai-images-generations' &&
    (item.authentication === 'none' || Boolean(item.apiKey)))
  assert(profile && profile.protocol !== 'openai-images-generations')
  console.log(JSON.stringify({ credentialReadable: Boolean(profile.apiKey), authentication: profile.authentication,
    encryptionAvailable: safeStorage.isEncryptionAvailable() }))
  const runtimeSelection = { provider: 'model' as const, profileId: profile.id }
  const selected = applyRuntimeSelection(settings, runtimeSelection).settings
  selected.contextCompression = { ...(selected.contextCompression ?? defaultRuntimeSettings.contextCompression), enabled: false, modelSource: { kind: 'current' } }
  selected.workspacePath = directory
  const originalFetch = globalThis.fetch
  const payloads: string[] = []
  globalThis.fetch = async (input, init) => {
    assert(calls < 2, 'Two-call budget exceeded')
    const body = JSON.parse(String(init?.body))
    assert.equal(body.tools?.length ?? 0, 0)
    payloads.push(JSON.stringify(body.messages ?? body.input))
    calls++
    return originalFetch(input, init)
  }
  const history = [
    { role: 'user' as const, content: 'Remember the project codename is Cedar. Reply briefly.' },
    { role: 'assistant' as const, content: 'The project codename is Cedar.' },
    { role: 'user' as const, content: 'The next meeting is Tuesday.' },
    { role: 'assistant' as const, content: 'Meeting: Tuesday.' }
  ]
  const historyMessageIds = history.map(() => crypto.randomUUID())
  const runtime = createModelProfileRuntime(directory, selected, { ...profile, maximumOutputTokens: 1024 })
  stage = 'compact'
  const signal = AbortSignal.timeout(90000)
  const result = await runtime.compactConversation({
    requestId: crypto.randomUUID(), conversationId: crypto.randomUUID(), runtimeSelection,
    history, historyMessageIds
  }, signal)
  assert.equal(result.result.compacted, true)
  const state = result.result.contextCompressionState!
  assert.equal(state.coveredMessageCount, 2)
  await runtime.dispose()
  // A new Runtime must consume the serialized state, without relying on an in-memory cache.
  const next = createModelProfileRuntime(directory, selected, { ...profile, maximumOutputTokens: 1024 })
  stage = 'restore'
  let answer = ''
  try {
    for await (const event of next.run({
      requestId: crypto.randomUUID(), conversationId: crypto.randomUUID(), runtimeSelection,
      prompt: 'What is the project codename? Reply with that word only.', history, historyMessageIds,
      contextCompressionState: JSON.parse(JSON.stringify(state))
    }, signal)) {
      assert.notEqual(event.type, 'error', 'Runtime returned an error')
      if (event.type === 'text') answer += event.delta
    }
  } finally { await next.dispose() }
  stage = 'summary-payload'
  assert(payloads[1]!.includes(JSON.stringify(state.summary).slice(1, -1)))
  stage = 'history-payload'
  assert(!payloads[1]!.includes(history[0]!.content))
  assert(payloads[1]!.includes(history[2]!.content))
  stage = 'answer'
  assert.match(answer, /Cedar/i)
  stage = 'settings-unchanged'
  assert(readFileSync(source).equals(original))
  console.log(JSON.stringify({ realCallCount: calls, compacted: true, coveredMessageCount: state.coveredMessageCount,
    summaryRestoredInNewRuntime: true, recentHistoryRetained: true, answerCorrect: true, sourceSettingsUnchanged: true }))
  app.exit(0)
}).catch((error: unknown) => {
  console.error(JSON.stringify({ realCallCount: calls, failed: true, stage,
    errorType: error instanceof Error ? error.name : 'unknown',
    location: error instanceof Error ? error.stack?.split('\n')[1]?.replace(/\([^)]*\)/g, '(redacted)') : undefined }))
  app.exit(1)
})

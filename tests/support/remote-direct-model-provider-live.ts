import { app, safeStorage, net } from 'electron'
import { randomUUID } from 'node:crypto'
import { copyFile, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import { RuntimeSettingsStore } from '../../src/main/runtime-settings-store'
import { defaultRuntimeSettings } from '../../src/shared/contracts'
import { createAgentRuntime } from '../../src/main/agent/create-runtime'
import { applyRuntimeSelection } from '../../src/main/agent/runtime-selection'
import { RemoteModelTools } from '../../src/main/remote-agent/remote-model-tools'
import { connectDirectModelTestHost } from './remote-direct-model-connection'

let calls = 0
let stage = 'connect'
const redactions: string[] = []
void app.whenReady().then(async () => {
  console.log(JSON.stringify({ stage, realModelCalls: calls }))
  const fixture = await connectDirectModelTestHost(process.env.GB_DIRECT_MODEL_HOST!, process.env.GB_DIRECT_MODEL_HOST_NODE!)
  console.log(JSON.stringify({ stage: 'connected', realModelCalls: calls }))
  try {
    stage = 'settings'
    const snapshot = join(fixture.local, 'settings.json')
    await copyFile(process.env.GB_DIRECT_MODEL_SETTINGS!, snapshot)
    const store = new RuntimeSettingsStore(snapshot, {
      isAvailable: () => safeStorage.isEncryptionAvailable(), encrypt: () => { throw new Error('Read-only validation') },
      decrypt: value => safeStorage.decryptString(value)
    }, process.env)
    const settings = await store.getResolvedSettings().finally(() => unlink(snapshot))
    for (const profile of settings.modelProfiles) redactions.push(profile.apiKey ?? '', profile.baseUrl)
    const profile = settings.modelProfiles.find(profile => profile.id === settings.defaultModelProfileId && profile.protocol !== 'openai-images-generations' && (profile.authentication === 'none' || profile.apiKey)) ??
      settings.modelProfiles.find(profile => profile.protocol !== 'openai-images-generations' && (profile.authentication === 'none' || profile.apiKey))
    assert(profile)
    const selection = { provider: 'model' as const, profileId: profile.id }
    const selected = applyRuntimeSelection(settings, selection).settings
    selected.contextCompression = { ...(selected.contextCompression ?? defaultRuntimeSettings.contextCompression), enabled: false }
    const conversationId = randomUUID()
    const token = `remote-${randomUUID()}`
    stage = 'seed'
    const tools = new RemoteModelTools(fixture.workspace, {})
    await tools.callTool('workspace_apply_patch', { patch: `*** Begin Patch\n*** Add File: verification.txt\n+${token}\n*** End Patch` }, AbortSignal.timeout(10000), { conversationId, runtimeTarget: 'model' })
    const runtime = createAgentRuntime(fixture.local, selected, {
      executionSpace: { kind: 'ssh', hostId: 'host-test', remoteRootPath: `${fixture.remote}/workspace`, cacheIdentity: fixture.remote, routeIdentity: fixture.remote, workspaceAccess: fixture.workspace },
      modelFetcher: async (input, init) => {
        assert(calls < 3, 'Three-request real-model budget exceeded')
        calls++
        console.log(JSON.stringify({ stage, realModelCallStarted: calls }))
        return net.fetch(input instanceof URL ? input.href : input, init)
      }
    })
    try {
      stage = 'real-tool-request'
      let answer = ''
      let reads = 0
      for await (const event of runtime.run({ requestId: randomUUID(), conversationId, runtimeSelection: selection,
        prompt: 'Use workspace_read_text to read verification.txt in the current workspace. Reply with only the exact token stored in that file. Do not use other tools.' }, AbortSignal.timeout(90000))) {
        assert.notEqual(event.type, 'error')
        if (event.type === 'text') answer += event.delta
        if (event.type === 'tool' && event.state === 'completed') reads++
      }
      assert(answer.includes(token), 'Model must return the actual remote file token')
      assert.equal(reads, 1)
      stage = 'history'
      answer = ''
      for await (const event of runtime.run({ requestId: randomUUID(), conversationId, runtimeSelection: selection,
        prompt: 'Without calling any tools, repeat the token from your previous answer, and nothing else.' }, AbortSignal.timeout(90000))) {
        assert.notEqual(event.type, 'error')
        if (event.type === 'text') answer += event.delta
      }
      assert(answer.includes(token), 'Conversation history must preserve the remote result')
      assert.equal(calls, 3)
      console.log(JSON.stringify({ realModelCalls: calls, remoteFileRead: true, tokenCorrect: true, historyRetained: true }))
    } finally { await runtime.dispose(); await tools.dispose() }
  } finally { await fixture.close() }
  app.exit(0)
}).catch(error => {
  let message = error instanceof Error ? error.message : 'unknown'
  for (const secret of redactions.filter(Boolean)) message = message.replaceAll(secret, '[redacted]')
  console.error(JSON.stringify({ stage, realModelCalls: calls, errorType: error instanceof Error ? error.name : 'unknown', message: message.slice(0, 500) }))
  app.exit(1)
})

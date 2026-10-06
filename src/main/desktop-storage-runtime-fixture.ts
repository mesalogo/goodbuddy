import assert from 'node:assert/strict'
import { join } from 'node:path'
import { stat } from 'node:fs/promises'
import {
  createDesktopRuntimeStorageAdapters,
  type DesktopRuntimeStorageCall
} from './desktop-storage-runtime-operations'

const root = process.env.GB_RUNTIME_STORAGE_TEST_ROOT!
void (async () => {
  const { app } = await import('electron')
  const { DesktopStorageClient } = await import('./desktop-storage-client')
  const { NativeTerminalClient } = await import('./agent/native-terminal-client')
  app.disableHardwareAcceleration()
  app.setPath('userData', join(root, 'electron-data'))
  await app.whenReady()
  const storage = new DesktopStorageClient({
    assistantPath: '', knowledgePath: '', defaultRootPath: root, userDataPath: root,
    entryPath: join(root, 'host.mjs')
  })
  try {
    await storage.ready
    // The dedicated fixture supplies the domain until core composition registers it.
    const adapters = createDesktopRuntimeStorageAdapters(storage.call.bind(storage) as unknown as DesktopRuntimeStorageCall)
    const ledger = await adapters.openModelCallLedger(join(root, 'calls.sqlite'))
    const claim = { callId: 'call', bindingId: 'binding', operationId: 'operation', promptSequence: 0,
      roundIndex: 0, profileDigest: 'profile', requestDigest: 'request' }
    await ledger.claim(claim)
    await assert.rejects(async () => ledger.claim(claim), { code: 'already-dispatched' })
    await ledger.complete('call')
    await ledger.delivered('call')
    assert.equal((await ledger.get('call'))?.response_delivered, 1)
    await ledger.close()
    await assert.rejects(async () => ledger.get('call'), /not open/)

    let launch: import('./terminal/terminal-session-manager').NativeTerminalLaunch | undefined
    let requests = 0
    const native = new NativeTerminalClient({
      ...adapters, rootDirectory: join(root, 'native'),
      bundledRuntimePaths: { opencode: process.execPath, continue: '', ripgrep: '', deepseekHarness: '' },
      terminalManager: { create: async (_owner, _request, prepared) => {
        launch = prepared
        return { sessionId: 'fixture', state: 'running' } as import('../shared/terminal-contracts').TerminalSnapshot
      } },
      fetcher: async () => { requests++; return new Response('{"choices":[]}') }
    })
    await native.open(1, {
      projectId: 'project', projectName: 'Fixture', directory: root, runtime: 'opencode',
      settings: { opencodeBinaryPath: '', opencodeModelProfile: {
        id: 'profile', name: 'Fixture', modelName: 'fixture', baseUrl: 'https://provider.invalid/v1',
        protocol: 'openai-chat-completions', authentication: 'none'
      } } as import('./runtime-settings-store').ResolvedRuntimeSettings
    })
    try {
      const config = JSON.parse(launch!.spawnSpec.env.OPENCODE_CONFIG_CONTENT!)
      const provider = Object.values(config.provider)[0] as { options: { baseURL: string; apiKey: string } }
      const response = await fetch(`${provider.options.baseURL}/chat/completions`, {
        method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${provider.options.apiKey}` },
        body: JSON.stringify({ model: 'fixture', messages: [{ role: 'user', content: 'test' }] })
      })
      assert.equal(response.status, 200)
      await response.text()
      assert.equal(requests, 1)
    } finally { await launch!.dispose() }
    await assert.rejects(stat(launch!.spawnSpec.env.OPENCODE_CONFIG_DIR!), { code: 'ENOENT' })
    await storage.close()
    console.log('desktop-runtime-storage-electron: passed')
    app.exit(0)
  } catch (error) {
    console.error(error)
    await storage.close().catch(() => undefined)
    app.exit(1)
  }
})().catch(error => { console.error(error); process.exit(1) })

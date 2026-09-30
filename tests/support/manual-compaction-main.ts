import { app, BrowserWindow } from 'electron'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { registerIpcHandlers } from '../../src/main/ipc'
import { AssistantDatabase } from '../../src/main/assistant/assistant-database'
import { ApplicationSettingsStore } from '../../src/main/application-settings-store'
import { RuntimeSettingsStore } from '../../src/main/runtime-settings-store'
import { createModelProfileRuntime } from '../../src/main/agent/create-runtime'
import { defaultRuntimeSettings } from '../../src/shared/contracts'

const directory = process.env.GB_COMPACT_DIRECTORY!
app.setPath('userData', join(directory, 'profile'))

void app.whenReady().then(async () => {
  const payloads: string[] = []
  const server = createServer(async (request, response) => {
    let body = ''
    for await (const chunk of request) body += chunk
    payloads.push(body)
    response.setHeader('Content-Type', 'text/event-stream')
    const content = payloads.length === 1 ? 'Project codename: Cedar.' : 'Cedar'
    response.end(`data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: null }] })}\n\ndata: [DONE]\n\n`)
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert(address && typeof address !== 'string')
  const settingsStore = new RuntimeSettingsStore(join(directory, 'runtime.json'), {
    isAvailable: () => false, encrypt: () => { throw new Error('No credentials') }, decrypt: () => { throw new Error('No credentials') }
  }, {})
  const profileId = randomUUID()
  await settingsStore.update({ ...defaultRuntimeSettings, apiKey: { action: 'keep' }, provider: 'model', workspacePath: directory,
    deepseekHarnessModelSource: { kind: 'platform' },
    modelProfiles: [{ id: profileId, name: 'Local text fixture', baseUrl: `http://127.0.0.1:${address.port}/v1`,
      modelName: 'selected-text', protocol: 'openai-chat-completions', authentication: 'none',
      imageGenerationQuality: 'auto', apiKey: { action: 'keep' } }],
    defaultModelProfileId: profileId,
    contextCompression: { ...defaultRuntimeSettings.contextCompression, enabled: false }
  })
  const settings = await settingsStore.getResolvedSettings()
  const runtime = createModelProfileRuntime(directory, settings, settings.modelProfiles[0]!)
  const win = new BrowserWindow({ show: true, width: 1280, height: 900, webPreferences: {
    sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false,
    preload: join(directory, 'preload.cjs')
  } })
  const database = new AssistantDatabase(join(directory, 'assistant.sqlite'))
  database.initialize(directory)
  const project = database.listProjects()[0]!
  const header = { id: randomUUID(), title: 'Manual compaction', projectId: project.id,
    runtimeSelection: { provider: 'model' as const, model: { kind: 'profile' as const, profileId } }, updatedAt: Date.now() }
  const messages = ['Remember the project codename is Cedar.', 'Codename recorded.', 'Meeting is Tuesday.', 'Tuesday recorded.']
    .map((content, index) => ({ id: randomUUID(), role: index % 2 ? 'assistant' as const : 'user' as const,
      content, state: 'complete' as const, createdAt: Date.now() + index }))
  database.saveLocalConversations([{ header, messages }])
  const applicationSettings = new ApplicationSettingsStore(join(directory, 'application.json'))
  await applicationSettings.update({ checkUpdatesOnStartup: false })
  // Only unrelated App services are fixtures; compaction, model HTTP and persistence use production code.
  const dispose = registerIpcHandlers(win, runtime, 'CommandOrControl+Shift+Space', settingsStore,
    {} as never, { clear() {}, cancelImport() {}, getDraft: () => [] } as never,
    { snapshot: () => ({ libraries: [], sources: [], documents: [], entities: [], relations: [], evidence: [], tasks: [] }),
      database: { externalStore: { listBindings: () => [] } }, external: { listInstances: () => [] } } as never, database,
    { clear() {} } as never, {} as never, async () => {}, undefined, undefined, undefined, undefined, applicationSettings,
    undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
    { getPending: async () => undefined } as never)
  const run = <T = unknown>(script: string): Promise<T> => win.webContents.executeJavaScript(script, true)
  async function wait(check: () => Promise<unknown> | unknown, label: string): Promise<void> {
    for (let i = 0; i < 400; i++) {
      if (await check()) return
      await new Promise(resolve => setTimeout(resolve, 50))
    }
    throw new Error(`Timed out: ${label}`)
  }
  try {
    await win.loadURL(process.env.GB_COMPACT_URL!)
    await wait(() => run(`document.body.innerText.includes('Tuesday recorded.')`), 'selected conversation history rendered')
    const button = `[...document.querySelectorAll('button')].find(e => e.textContent.trim() === 'Compact context')`
    await wait(() => run(`Boolean(${button}) && !${button}.disabled`), 'manual button with auto disabled')
    await run(`${button}.click()`)
    await wait(() => database.getConversation(header.id).contextCompressionState, 'summary persisted by App')
    const saved = database.getConversation(header.id)
    assert.equal(saved.contextCompressionState?.coveredMessageCount, 2)
    assert.equal(saved.contextCompressionState?.summary, 'Project codename: Cedar.')
    assert.deepEqual(saved.messages.map(message => message.content), messages.map(message => message.content))
    assert.equal(payloads.length, 1)
    assert.equal(JSON.parse(payloads[0]!).model, 'selected-text')
    assert(payloads[0]!.includes(messages[0]!.content))
    assert(!payloads[0]!.includes(messages[2]!.content))
    await win.reload()
    await wait(() => run(`document.body.innerText.includes('Tuesday recorded.')`), 'reload persisted conversation')
    const restored = await run<{ contextCompressionState: typeof saved.contextCompressionState }>(
      `window.goodbuddy.conversations.get(${JSON.stringify(header.id)})`)
    assert.deepEqual(restored.contextCompressionState, saved.contextCompressionState)
    // A fresh production Runtime consumes the state returned across the real preload boundary.
    const next = createModelProfileRuntime(directory, settings, settings.modelProfiles[0]!)
    try {
      for await (const event of next.run({ requestId: randomUUID(), conversationId: header.id,
        runtimeSelection: { provider: 'model', profileId }, prompt: 'What is the codename?',
        history: messages.map(({ role, content }) => ({ role, content })), historyMessageIds: messages.map(({ id }) => id),
        contextCompressionState: restored.contextCompressionState
      }, AbortSignal.timeout(10000))) {
        assert.notEqual(event.type, 'error')
      }
    } finally { await next.dispose() }
    assert.equal(payloads.length, 2)
    assert(payloads[1]!.includes(saved.contextCompressionState!.summary))
    assert(!payloads[1]!.includes(messages[0]!.content))
    assert(payloads[1]!.includes(messages[2]!.content))
    console.log(JSON.stringify({ appClick: true, ipc: true, sqliteSaved: true, summaryRestored: true, httpCalls: payloads.length, externalModelCalls: 0 }))
  } finally {
    await dispose()
    await runtime.dispose()
    database.close()
    win.destroy()
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
  app.exit(0)
}).catch(error => { console.error(error); app.exit(1) })

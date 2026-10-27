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
import { ContextManager } from '../../src/main/context-manager'
import { defaultRuntimeSettings } from '../../src/shared/contracts'

const directory = process.env.GB_EDIT_DIRECTORY!
app.setPath('userData', join(directory, 'profile'))
void app.whenReady().then(async () => {
  const payloads: string[] = []
  const server = createServer(async (request, response) => {
    let body = ''
    for await (const chunk of request) body += chunk
    payloads.push(body)
    response.setHeader('Content-Type', 'text/event-stream')
    response.end(`data: ${JSON.stringify({ choices: [{ delta: { content: 'NEW BRANCH REPLY' }, finish_reason: null }] })}\n\ndata: [DONE]\n\n`)
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
    modelProfiles: [{ id: profileId, name: 'Local fixture', baseUrl: `http://127.0.0.1:${address.port}/v1`,
      modelName: 'fixture', protocol: 'openai-chat-completions', authentication: 'none', imageGenerationQuality: 'auto', apiKey: { action: 'keep' } }],
    defaultModelProfileId: profileId, contextCompression: { ...defaultRuntimeSettings.contextCompression, enabled: false }
  })
  const settings = await settingsStore.getResolvedSettings()
  const runtime = createModelProfileRuntime(directory, settings, settings.modelProfiles[0]!)
  const win = new BrowserWindow({ show: true, width: 1280, height: 900, webPreferences: {
    sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, preload: join(directory, 'preload.cjs')
  } })
  const database = new AssistantDatabase(join(directory, 'assistant.sqlite'))
  await database.initialize(directory)
  const project = database.listProjects()[0]!
  const header = { id: randomUUID(), title: 'Edit history', projectId: project.id,
    runtimeSelection: { provider: 'model' as const, model: { kind: 'profile' as const, profileId } }, updatedAt: Date.now(),
    contextCompressionState: { summary: 'STALE SUMMARY', coveredHistoryDigest: 'a'.repeat(64), coveredMessageCount: 4 } }
  const messages = ['PREFIX QUESTION', 'PREFIX ANSWER', 'ORIGINAL QUESTION', 'OLD SUFFIX']
    .map((content, index) => ({ id: randomUUID(), role: index % 2 ? 'assistant' as const : 'user' as const, content, state: 'complete' as const, createdAt: Date.now() + index }))
  database.saveLocalConversations([{ header, messages }])
  const sourceBefore = database.getConversation(header.id)
  const applicationSettings = new ApplicationSettingsStore(join(directory, 'application.json'))
  await applicationSettings.update({ checkUpdatesOnStartup: false })
  const context = new ContextManager()
  const dispose = registerIpcHandlers(win, runtime, 'CommandOrControl+Shift+Space', settingsStore,
    { getEnabledBuiltinMcpServerIds: () => [] } as never, context,
    { snapshot: () => ({ libraries: [], sources: [], documents: [], entities: [], relations: [], evidence: [], tasks: [] }),
      database: { externalStore: { listBindings: () => [] } }, external: { listInstances: () => [] } } as never, database,
    {} as never, async () => {}, undefined, undefined, undefined, undefined, applicationSettings,
    undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
    { getPending: async () => undefined } as never)
  const run = <T = unknown>(script: string): Promise<T> => win.webContents.executeJavaScript(script, true)
  async function wait(check: () => Promise<unknown> | unknown, label: string): Promise<void> {
    for (let i = 0; i < 400; i++) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 50)) }
    throw new Error(`Timed out: ${label}; ${await run('document.body.innerText')}`)
  }
  try {
    await win.loadURL(process.env.GB_EDIT_URL!)
    win.focus()
    await wait(() => run(`document.body.innerText.includes('ORIGINAL QUESTION') && document.hasFocus()`), 'history and focus')
    await run(`[...document.querySelectorAll('article')].find(e => e.innerText.includes('ORIGINAL QUESTION')).querySelector('button[aria-label="Edit message"]').click()`)
    win.focus()
    await wait(() => run(`document.hasFocus() && document.activeElement === document.querySelector('[role="dialog"] textarea')`), 'edit focus')
    await run(`document.querySelector('[role="dialog"] textarea').select()`)
    await wait(() => run(`(() => { const input = document.querySelector('[role="dialog"] textarea'); return input.selectionStart === 0 && input.selectionEnd === input.value.length })()`), 'selected original text')
    await win.webContents.insertText('EDITED QUESTION')
    await wait(() => run(`document.querySelector('[role="dialog"] textarea').value === 'EDITED QUESTION'`), 'edited input')
    await run(`[...document.querySelectorAll('[role="dialog"] button')].find(e => e.textContent === 'Save and regenerate').click()`)
    await wait(() => run(`document.body.innerText.includes('NEW BRANCH REPLY')`), 'reply')
    const branch = database.listConversations().find(item => item.id !== header.id && item.branch?.sourceConversationId === header.id)!
    assert(branch)
    await wait(() => database.getConversation(branch.id).messages.at(-1)?.state === 'complete', 'reply persisted')
    assert.deepEqual(database.getConversation(header.id), sourceBefore)
    assert.deepEqual(database.getConversation(branch.id).messages.map(m => m.content), ['PREFIX QUESTION', 'PREFIX ANSWER', 'EDITED QUESTION', 'NEW BRANCH REPLY'])
    assert.equal(branch.branch?.sourceMessageId, messages[2]!.id)
    assert.equal(payloads.length, 1)
    const request = JSON.parse(payloads[0]!)
    const inputText = JSON.stringify(request.messages)
    assert(inputText.includes('PREFIX QUESTION') && inputText.includes('PREFIX ANSWER') && inputText.includes('EDITED QUESTION'))
    assert(!inputText.includes('ORIGINAL QUESTION') && !inputText.includes('OLD SUFFIX') && !inputText.includes('STALE SUMMARY'))
    await win.reload()
    await wait(() => run(`document.body.innerText.includes('NEW BRANCH REPLY')`), 'reload')
    await run(`[...document.querySelectorAll('button')].find(e => e.textContent.includes('Return to original conversation:')).click()`)
    await wait(() => run(`document.body.innerText.includes('OLD SUFFIX')`), 'return to original')
    console.log(JSON.stringify({ editedBranchVerified: true, prefixIsolated: true, sourcePreserved: true, reload: true, nativeInput: true, httpCalls: payloads.length, externalModelCalls: 0 }))
  } finally {
    await dispose(); await runtime.dispose(); database.close(); win.destroy()
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
  app.exit(0)
}).catch(error => { console.error(error); app.exit(1) })

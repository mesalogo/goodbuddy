import { app, BrowserWindow, safeStorage } from 'electron'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { readFile, writeFile, unlink } from 'node:fs/promises'
import { copyFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { registerIpcHandlers } from '../../src/main/ipc'
import { DesktopStorageClient } from '../../src/main/desktop-storage-client'
import { createAssistantStoragePort } from '../../src/main/assistant-storage-port'
import { createKnowledgeStoragePort } from '../../src/main/knowledge/knowledge-storage-port'
import { KnowledgeService } from '../../src/main/knowledge/knowledge-service'
import { KnowledgeMcpGateway } from '../../src/main/agent/knowledge-mcp-gateway'
import { ApplicationSettingsStore } from '../../src/main/application-settings-store'
import { RuntimeSettingsStore } from '../../src/main/runtime-settings-store'
import { createAgentRuntime } from '../../src/main/agent/create-runtime'
import { defaultRuntimeSettings } from '../../src/shared/contracts'
import { configureDocumentParseWorker } from '../../src/main/document-parse-client'
import { ContextManager } from '../../src/main/context-manager'

const directory = process.env.GB_REFERENCE_DIRECTORY!
app.setPath('userData', join(directory, 'profile'))
if (process.env.GB_REFERENCE_LIVE_SETTINGS) {
  const localState = join(dirname(process.env.GB_REFERENCE_LIVE_SETTINGS), 'Local State')
  if (existsSync(localState)) {
    mkdirSync(join(directory, 'profile'), { recursive: true })
    copyFileSync(localState, join(directory, 'profile', 'Local State'))
  }
}
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion')

void app.whenReady().then(async () => {
  const storage = new DesktopStorageClient({ assistantPath: join(directory, 'assistant.sqlite'), knowledgePath: join(directory, 'knowledge.sqlite'),
    defaultRootPath: directory, userDataPath: directory, entryPath: join(directory, 'desktop-storage-entry.mjs'),
    readerWorkerPath: join(directory, 'readonly-query-worker.mjs'), upgradeWorkerPath: join(directory, 'assistant-storage-worker.mjs') })
  await storage.ready
  configureDocumentParseWorker(join(directory, 'document-parse-worker.mjs'))
  const database = createAssistantStoragePort(storage)
  const knowledge = new KnowledgeService({ database: createKnowledgeStoragePort(storage), managedRoot: join(directory, 'knowledge') })
  await knowledge.initialize()
  const library = await knowledge.database.createKnowledgeBase({ name: 'Reference test library', storageMode: 'managed', graphEnabled: false, graphStrategy: 'rules' })
  const file = join(directory, 'reference-report.txt')
  await writeFile(file, 'The acceptance code is CEDAR-7391. The shipment date is November 18.')
  await knowledge.importPaths(library.id, [file], 'rules')
  const documents = await knowledge.database.searchDocumentNames({ libraryIds: [library.id], query: 'reference-report' })
  assert.equal(documents.length, 1)
  const document = documents[0]!
  const otherFile = join(directory, 'reference-other.txt')
  await writeFile(otherFile, 'The comparison code is MAPLE-2854.')
  await knowledge.importPaths(library.id, [otherFile], 'rules')
  const other = (await knowledge.database.searchDocumentNames({ libraryIds: [library.id], query: 'reference-other' }))[0]!
  const gateway = new KnowledgeMcpGateway(knowledge)
  let knowledgeReadCalls = 0
  const readDocument = gateway.readDocument.bind(gateway)
  gateway.readDocument = async (...args) => {
    knowledgeReadCalls++
    return readDocument(...args)
  }
  await gateway.start()
  const payloads: string[] = []
  const server = createServer(async (request, response) => {
    let body = ''
    for await (const chunk of request) body += chunk
    payloads.push(body)
    const payload = JSON.parse(body)
    const messages = payload.messages as { role: string; content: string }[]
    const needed = [document, other].find(doc => !messages.some(message => message.role === 'tool' && message.content.includes(doc.id)))
    response.setHeader('Content-Type', 'text/event-stream')
    const delta = !needed ? { content: 'Verified CEDAR-7391 and MAPLE-2854 from the selected local documents.' }
      : { tool_calls: [{ index: 0, id: `read-${needed.id}`, type: 'function', function: { name: 'knowledge_read', arguments: JSON.stringify({ documentId: needed.id }) } }] }
    response.end(`data: ${JSON.stringify({ choices: [{ delta, finish_reason: needed ? 'tool_calls' : 'stop' }] })}\n\ndata: [DONE]\n\n`)
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
    modelProfiles: [{ id: profileId, name: 'Local reference test', baseUrl: `http://127.0.0.1:${address.port}/v1`, modelName: 'reference-test',
      protocol: 'openai-chat-completions', authentication: 'none', imageGenerationQuality: 'auto', apiKey: { action: 'keep' } }],
    defaultModelProfileId: profileId, contextCompression: { ...defaultRuntimeSettings.contextCompression, enabled: false } })
  const settings = await settingsStore.getResolvedSettings()
  const liveSource = process.env.GB_REFERENCE_LIVE_SETTINGS
  let liveCalls = 0
  if (liveSource) {
    const snapshot = join(directory, 'live-settings.json')
    await writeFile(snapshot, await readFile(liveSource))
    const saved = new RuntimeSettingsStore(snapshot, {
      isAvailable: () => safeStorage.isEncryptionAvailable(), encrypt: () => { throw new Error('Read-only') },
      decrypt: value => safeStorage.decryptString(value)
    }, {})
    const resolved = await saved.getResolvedSettings().finally(() => unlink(snapshot))
    const profile = resolved.modelProfiles.find(item => item.id === resolved.defaultModelProfileId && item.protocol !== 'openai-images-generations' && (item.authentication === 'none' || item.apiKey))
      ?? resolved.modelProfiles.find(item => item.protocol !== 'openai-images-generations' && (item.authentication === 'none' || item.apiKey))
    assert(profile && (profile.authentication === 'none' || profile.apiKey), 'No readable text-model profile')
    settings.modelProfiles = [{ ...profile, id: profileId, maximumOutputTokens: 1024 }]
  }
  const runtime = createAgentRuntime(directory, settings, { knowledgeGateway: gateway, ...(liveSource ? { modelFetcher: async (input, init) => {
    assert(liveCalls < 4, 'Live request budget exceeded')
    liveCalls++
    payloads.push(String(init?.body))
    return fetch(input, init)
  } } : {}) })
  const win = new BrowserWindow({ show: true, width: 1280, height: 900, webPreferences: {
    sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, preload: join(directory, 'preload.cjs') } })
  const project = (await database.listProjects())[0]!
  const header = { id: randomUUID(), title: 'Local reference acceptance', projectId: project.id, knowledgeLibraryIds: [library.id],
    runtimeSelection: { provider: 'model' as const, model: { kind: 'profile' as const, profileId } }, updatedAt: Date.now() }
  await database.saveLocalConversations([{ header, messages: [{ id: randomUUID(), role: 'assistant', state: 'complete', content: 'Reference fixture ready.', createdAt: Date.now() }] }])
  const applicationSettings = new ApplicationSettingsStore(join(directory, 'application.json'))
  await applicationSettings.update({ checkUpdatesOnStartup: false })
  const dispose = registerIpcHandlers(win, runtime, 'CommandOrControl+Shift+Space', settingsStore,
    {} as never, new ContextManager(),
    knowledge, database, {} as never, async () => {}, undefined, undefined, undefined, undefined, applicationSettings,
    undefined, undefined, undefined, undefined, undefined, gateway,
    undefined, undefined, undefined, undefined, { getPending: async () => undefined } as never)
  const run = <T = unknown>(script: string): Promise<T> => win.webContents.executeJavaScript(script, true)
  const key = (keyCode: string, modifiers: ('control' | 'shift')[] = []): void => {
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers })
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers })
  }
  async function wait(check: () => Promise<unknown> | unknown, label: string): Promise<void> {
    for (let i = 0; i < 400; i++) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 50)) }
    throw new Error(`Timed out: ${label}; ${await run('JSON.stringify({text: document.body.innerText, value: document.querySelector("textarea")?.value, focus: document.activeElement?.outerHTML})')}`)
  }
  try {
    await win.loadURL(process.env.GB_REFERENCE_URL!)
    win.focus(); win.webContents.focus()
    await wait(() => run(`document.hasFocus() && !!document.querySelector('textarea[aria-autocomplete="list"]') && document.body.innerText.includes('Reference fixture ready.')`), 'composer and selected history ready')
    await run(`document.querySelector('textarea').focus()`)
    const start = performance.now()
    await win.webContents.insertText('Read the referenced document with knowledge_read. Report its acceptance code, starting your reply with Verified. @reference-report.txt')
    await wait(() => run(`document.querySelector('textarea').value.endsWith('@reference-report.txt')`), 'text input')
    await wait(() => run(`document.querySelectorAll('[role="option"]').length === 1`), 'local search result')
    const searchMs = performance.now() - start
    assert(await run(`document.querySelector('[role="option"]').textContent.includes('Reference test library')`))
    await wait(() => run(`document.querySelector('textarea').getAttribute('aria-activedescendant') === 'external-reference-option-0'`), 'keyboard selection ready')
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Tab' })
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Tab' })
    await wait(() => run(`!!document.querySelector('.composer-inline-input .composer-inline-reference') && document.activeElement.matches('.composer-inline-input')`), 'inline chip and caret')
    assert(await run(`document.querySelector('.composer-inline-reference').querySelector('svg') !== null`))
    assert(await run(`!document.querySelector('.context-list .composer-inline-reference')`))
    key('Backspace')
    await wait(() => run(`document.querySelectorAll('.composer-inline-reference').length === 0`), 'atomic backspace')
    key('z', ['control'])
    await wait(() => run(`document.querySelectorAll('.composer-inline-reference').length === 1`), 'undo restores inline reference')
    key('z', ['control', 'shift'])
    await wait(() => run(`document.querySelectorAll('.composer-inline-reference').length === 0`), 'redo deletion')
    key('z', ['control'])
    await wait(() => run(`document.querySelectorAll('.composer-inline-reference').length === 1`), 'second undo')
    key('Left')
    await win.webContents.insertText('before ')
    assert(await run(`document.querySelector('.composer-inline-input').firstChild.textContent.endsWith('before ')`))
    key('Right')
    await win.webContents.insertText(' after')
    assert(await run(`document.querySelector('.composer-inline-input').textContent.endsWith(' after')`))
    key('Enter', ['shift'])
    await wait(() => run(`!!document.querySelector('.composer-inline-input br')`), 'Shift+Enter line break')
    assert.equal(payloads.length, 0)
    await win.webContents.insertText('Compare with @reference-other.txt')
    assert(await run(`document.querySelector('.composer-inline-input').innerText.includes('after' + String.fromCharCode(10) + 'Compare with')`), 'Typing after Shift+Enter must retain the line break')
    await wait(() => run(`document.querySelectorAll('[role="option"]').length === 1 && document.querySelector('.composer-inline-input').getAttribute('aria-activedescendant') === 'external-reference-option-0'`), 'second mention from inline editor')
    key('Tab')
    await wait(() => run(`document.querySelectorAll('.composer-inline-reference').length === 2`), 'second inline reference')
    for (const theme of ['light', 'dark']) {
      await run(`if (document.documentElement.dataset.theme !== ${JSON.stringify(theme)}) document.querySelector('.theme-toggle-button').click()`)
      await wait(() => run(`document.documentElement.dataset.theme === ${JSON.stringify(theme)}`), `${theme} theme applied`)
      await run(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`)
      assert(await run(`Array.from(document.querySelectorAll('.composer-inline-reference')).every(chip => {
        const box = chip.getBoundingClientRect(), editor = chip.closest('.composer-inline-input').getBoundingClientRect();
        return box.width > 0 && box.left >= editor.left && box.right <= editor.right + 1;
      })`))
      if (process.env.GB_REFERENCE_SCREENSHOT_DIRECTORY) await writeFile(join(process.env.GB_REFERENCE_SCREENSHOT_DIRECTORY, `inline-reference-${theme}.png`), (await win.webContents.capturePage()).toPNG())
    }
    await wait(() => run(`!!document.querySelector('.send-button:not(:disabled)')`), 'send enabled')
    await run(`document.querySelector('.send-button').click()`)
    await wait(async () => (await database.getConversation(header.id)).messages.some(message => message.role === 'assistant' && message.content.includes('CEDAR-7391')), 'model tool result persisted')
    assert(payloads.length >= 2 && payloads.length <= 4)
    assert(payloads[0]!.includes(`documentId: ${document.id}`))
    assert(payloads[0]!.includes('@reference-report.txt [1]'))
    assert(payloads[0]!.includes('@reference-other.txt [2]'))
    assert(!payloads[0]!.includes('\uFFF9'))
    assert(payloads[1]!.includes('CEDAR-7391'))
    assert(payloads[1]!.includes('knowledge_read'))
    assert(knowledgeReadCalls >= 1, 'The model must call the production document reader')
    const token = gateway.grant('scope-check', [], new AbortController().signal)
    if (token) await assert.rejects(() => gateway.readDocument(token, { documentId: document.id }))
    await win.reload()
    await wait(() => run(`document.body.innerText.includes('CEDAR-7391')`), 'answer survives reload')
    await wait(() => run(`!!document.querySelector('.message--user .message-document-references')`), 'reference footer survives reload')
    assert(await run(`(() => {
      const message = document.querySelector('.message--user');
      const details = message.querySelector('.message-document-references');
      return !details.open && details.querySelectorAll('li').length === 2 &&
        !message.textContent.includes('documentId:') && !message.textContent.includes('按返回的 next') &&
        message.querySelector('.message__content').textContent.includes('@reference-report.txt [1]');
    })()`), 'References are collapsed; reading instructions are absent from the message DOM')
    await run(`document.querySelector('.message-document-references summary').click()`)
    await wait(() => run(`document.querySelector('.message-document-references').open && document.querySelector('.message-document-references').innerText.includes('reference-report.txt')`), 'expand reference details')
    console.log(JSON.stringify({ localReferencePassed: true, importedFile: true, storageUtility: true, keyboardSelection: true,
      searchMs: Math.round(searchMs), httpCalls: payloads.length, externalModelCalls: liveCalls, knowledgeReadCalls,
      inlineReferences: 2, collapsedMessageReferences: true, nativeDeleteUndoRedo: true, textBeforeAndAfter: true, themes: 2, reloaded: true }))
  } finally {
    await dispose(); await runtime.dispose(); await gateway.dispose(); await knowledge.dispose(); await storage.close()
    configureDocumentParseWorker(undefined)
    win.destroy()
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
  app.exit(0)
}).catch(error => { console.error(error); app.exit(1) })

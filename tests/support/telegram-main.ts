import { app, BrowserWindow, net, safeStorage, session } from 'electron'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { registerIpcHandlers } from '../../src/main/ipc'
import { AssistantDatabase } from '../../src/main/assistant/assistant-database'
import { RuntimeSettingsStore } from '../../src/main/runtime-settings-store'
import { ChannelSettingsStore } from '../../src/main/channels/channel-settings-store'
import { ContextManager } from '../../src/main/context-manager'
import { createModelProfileRuntime } from '../../src/main/agent/create-runtime'
import { defaultRuntimeSettings } from '../../src/shared/contracts'
import type { ConversationSnapshot } from '../../src/shared/assistant-contracts'

const directory = process.env.GB_TELEGRAM_DIRECTORY!
assert(directory)
app.setPath('userData', join(directory, 'profile'))
app.setPath('sessionData', join(directory, 'session'))
app.commandLine.appendSwitch('disable-background-networking')
const token = '123456:telegram-smoke-not-a-real-token'
const prompt = 'Reply with the project codename Cedar.'
const answer = 'The project codename is Cedar.'

void app.whenReady().then(async () => {
  const blocked: string[] = []
  const local = (value: string) => new URL(value).hostname === '127.0.0.1'
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    const forbidden = /^https?:|^wss?:/.test(details.url) && !local(details.url)
    if (forbidden) blocked.push(new URL(details.url).origin)
    callback({ cancel: forbidden })
  })
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (input, init) => {
    const url = input instanceof Request ? input.url : String(input)
    if (!local(url)) { blocked.push(new URL(url).origin); throw new Error('Non-local model request blocked') }
    return originalFetch(input, init)
  }
  const calls: { method: string; body: Record<string, unknown> }[] = []
  const updates: object[] = []
  let pollsAborted = 0
  let pollingUnavailable = false
  let pollingConflict = false
  let sendingForbidden = false
  const originalNetFetch = net.fetch
  // This is the only Telegram substitution: production driver construction and IPC stay intact.
  net.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input)
    if (url.origin !== 'https://api.telegram.org' || !url.pathname.startsWith(`/bot${token}/`)) {
      blocked.push(url.origin)
      throw new Error('Unexpected Electron net request blocked')
    }
    const method = url.pathname.split('/').at(-1)!
    assert.equal(init?.method, 'POST')
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>
    calls.push({ method, body })
    let result: unknown
    switch (method) {
      case 'getMe': result = { id: 123456, is_bot: true, username: 'goodbuddy_smoke_bot' }; break
      case 'getWebhookInfo': result = { url: '' }; break
      case 'getUpdates':
        assert.deepEqual(body.allowed_updates, ['message'])
        try { await delay(50, undefined, { signal: init?.signal ?? undefined }) }
        catch (error) { pollsAborted++; throw error }
        if (pollingConflict) {
          return new Response(JSON.stringify({ ok: false, error_code: 409 }), { status: 409 })
        }
        if (pollingUnavailable) {
          return new Response(JSON.stringify({ ok: false, error_code: 503 }), { status: 503 })
        }
        result = updates.splice(0)
        break
      case 'sendChatAction': result = true; break
      case 'sendMessage':
        if (sendingForbidden) return new Response(JSON.stringify({ ok: false, error_code: 403,
          description: `https://api.telegram.org/bot${token}/sendMessage` }), { status: 403 })
        result = { message_id: 1000 }; break
      default: throw new Error(`Unexpected Telegram method: ${method}`)
    }
    return new Response(JSON.stringify({ ok: true, result }), { headers: { 'content-type': 'application/json' } })
  }
  const payloads: string[] = []
  let cancelledModel = false
  const model = createServer(async (request, response) => {
    assert.equal(request.url, '/v1/chat/completions')
    assert.equal(request.headers.authorization, undefined)
    let body = ''
    for await (const chunk of request) body += chunk
    payloads.push(body)
    response.setHeader('Content-Type', 'text/event-stream')
    if (body.includes('Wait for cancellation')) {
      response.write(': waiting\n\n')
      response.on('close', () => { cancelledModel = true })
      return
    }
    response.end(`data: ${JSON.stringify({ choices: [{ delta: { content: answer }, finish_reason: null }] })}\n\ndata: [DONE]\n\n`)
  })
  await new Promise<void>(resolve => model.listen(0, '127.0.0.1', resolve))
  const address = model.address()
  assert(address && typeof address !== 'string')
  const cipher = { isAvailable: () => safeStorage.isEncryptionAvailable(),
    encrypt: (value: string) => safeStorage.encryptString(value), decrypt: (value: Buffer) => safeStorage.decryptString(value) }
  assert(cipher.isAvailable(), 'Electron safeStorage must be available for the production settings save')
  const settingsStore = new RuntimeSettingsStore(join(directory, 'runtime.json'), cipher, {})
  const profileId = randomUUID()
  await settingsStore.update({ ...defaultRuntimeSettings, apiKey: { action: 'keep' }, provider: 'model', workspacePath: directory,
    deepseekHarnessModelSource: { kind: 'platform' },
    modelProfiles: [{ id: profileId, name: 'Telegram local fixture', baseUrl: `http://127.0.0.1:${address.port}/v1`,
      modelName: 'telegram-text-fixture', protocol: 'openai-chat-completions', authentication: 'none',
      imageGenerationQuality: 'auto', apiKey: { action: 'keep' } }], defaultModelProfileId: profileId,
    contextCompression: { ...defaultRuntimeSettings.contextCompression, enabled: false }
  })
  const settings = await settingsStore.getResolvedSettings()
  const runtime = createModelProfileRuntime(directory, settings, settings.modelProfiles[0]!)
  const channelsPath = join(directory, 'channels.json')
  const channels = new ChannelSettingsStore(channelsPath, cipher, {})
  const databasePath = join(directory, 'assistant.sqlite')
  const database = new AssistantDatabase(databasePath)
  database.initialize(directory)
  database.ensureChannelProjects(directory)
  const win = new BrowserWindow({ show: false, width: 1280, height: 900, webPreferences: {
    sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false,
    preload: join(directory, 'preload.cjs')
  } })
  // Unused capabilities/knowledge have no implementation; the text execution path uses real services.
  const dispose = registerIpcHandlers(win, runtime, 'CommandOrControl+Shift+Space', settingsStore,
    {} as never, new ContextManager(), {} as never, database, {} as never, async () => {},
    undefined, undefined, undefined, channels,
    undefined, undefined, undefined, undefined, undefined, undefined, undefined,
    () => { throw new Error('This smoke must never launch a WeChat sidecar') })
  const run = <T = unknown>(script: string): Promise<T> => win.webContents.executeJavaScript(script, true)
  async function wait(check: () => Promise<unknown> | unknown, label: string): Promise<void> {
    for (let i = 0; i < 300; i++) {
      if (await check()) return
      await delay(50)
    }
    throw new Error(`Timed out: ${label}; UI: ${await run('document.body.innerText')}`)
  }
  async function click(selector: string): Promise<void> {
    await wait(() => run(`Boolean(document.querySelector(${JSON.stringify(selector)})) && !document.querySelector(${JSON.stringify(selector)}).disabled`), selector)
    await run(`document.querySelector(${JSON.stringify(selector)}).click()`)
  }
  async function fill(selector: string, value: string): Promise<void> {
    await run(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); Object.getOwnPropertyDescriptor(e instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, 'value').set.call(e, ${JSON.stringify(value)}); e.dispatchEvent(new Event('input', { bubbles: true })); })()`)
  }
  function inbound(id: number, text: string, sender = 700001) {
    return { update_id: id, message: { message_id: id, date: Math.floor(Date.now() / 1000),
      from: { id: sender, is_bot: false }, chat: { id: sender, type: 'private' }, text } }
  }
  try {
    await win.loadURL(process.env.GB_TELEGRAM_RENDERER!)
    await wait(() => run(`Boolean(document.querySelector('input[aria-label="Telegram Bot Token"]'))`), 'Telegram settings loaded')
    await fill('input[aria-label="Telegram Bot Token"]', token)
    await fill('textarea[aria-label="Telegram allowed sender IDs"]', '700001')
    await click('#channel-settings-panel-telegram button.secondary-button')
    await wait(() => run(`document.body.innerText.includes('@goodbuddy_smoke_bot')`), 'connection test identity shown')
    assert.deepEqual(calls.map(call => call.method), ['getMe', 'getWebhookInfo'])
    assert.equal((await channels.resolve('telegram')).enabled, false, 'Test must not enable receiving')
    await click('#channel-settings-panel-telegram input[role="switch"]')
    await click('button.primary-button')
    await wait(async () => (await channels.resolve('telegram')).enabled && calls.some(call => call.method === 'getUpdates'), 'saved channel polling')
    const saved = await new ChannelSettingsStore(channelsPath, cipher, {}).resolve('telegram')
    assert.equal(saved.secret, token)
    assert.deepEqual(saved.allowedSenderIds, ['700001'])
    assert(!(await readFile(channelsPath, 'utf8')).includes(token), 'Token must not be persisted in plaintext')
    const snapshot = await run<string>('window.goodbuddy.channels.getSnapshot().then(JSON.stringify)')
    assert(!snapshot.includes(token), 'Snapshot must not expose the Token')

    updates.push(inbound(10, 'Unauthorized request', 700002), inbound(11, prompt), inbound(11, prompt))
    await wait(() => calls.some(call => call.method === 'sendMessage' && call.body.text === answer), 'model reply delivered through Telegram driver')
    assert.equal(payloads.length, 1, 'Unauthorized/duplicate updates must not reach the model')
    assert.equal(JSON.parse(payloads[0]!).model, 'telegram-text-fixture')
    assert(payloads[0]!.includes(prompt))
    const replies = calls.filter(call => call.method === 'sendMessage')
    assert.equal(replies.length, 1)
    assert.equal(replies[0]!.body.chat_id, '700001')
    const conversations = await run<ConversationSnapshot[]>('window.goodbuddy.conversations.list()')
    const conversation = conversations.find(item => item.messages.some(message => message.content === prompt))
    assert(conversation, 'Channel conversation must be visible through the desktop IPC')
    assert.deepEqual(conversation.messages.map(message => [message.role, message.content]), [['user', prompt], ['assistant', answer]])
    assert.equal(database.getProject(conversation.projectId!).channel, 'telegram')

    await wait(() => run(`!document.querySelector('button.primary-button').disabled && document.querySelector('.channel-settings-card .capability-card__header > span')?.textContent === 'Connected'`), 'saved connection visible')
    pollingConflict = true
    await wait(() => run(`document.querySelector('.channel-settings-card [role="alert"]')?.textContent.includes('polling conflict')`), 'terminal polling conflict visible')
    pollingConflict = false
    const validationsBeforeRecovery = calls.filter(call => call.method === 'getMe').length
    await click('button.primary-button')
    await wait(() => calls.filter(call => call.method === 'getMe').length === validationsBeforeRecovery + 1, 'unchanged Save restarts conflicted poller')
    await wait(() => run(`!document.querySelector('button.primary-button').disabled && document.querySelector('.channel-settings-card .capability-card__header > span')?.textContent === 'Connected'`), 'recovered connection visible')
    await click('button.primary-button')
    await wait(() => run(`!document.querySelector('button.primary-button').disabled`), 'healthy unchanged Save completed')
    assert.equal(calls.filter(call => call.method === 'getMe').length, validationsBeforeRecovery + 1, 'Healthy Save must not restart polling')
    await fill('input[aria-label="Telegram Bot Token"]', 'unsaved-token-placeholder')
    await fill('textarea[aria-label="Telegram allowed sender IDs"]', '700001\n700003')
    pollingUnavailable = true
    await wait(() => run(`document.querySelector('.channel-settings-card .capability-card__header > span')?.textContent === 'Connecting' && document.querySelector('.channel-settings-card [role="alert"]')?.textContent.includes('503')`), 'poll failure pushed through production IPC')
    pollingUnavailable = false
    await wait(() => run(`document.querySelector('.channel-settings-card .capability-card__header > span')?.textContent === 'Connected' && !document.querySelector('.channel-settings-card [role="alert"]')`), 'reconnect pushed through production IPC')
    assert.equal(await run(`document.querySelector('input[aria-label="Telegram Bot Token"]').value`), 'unsaved-token-placeholder')
    assert.equal(await run(`document.querySelector('textarea[aria-label="Telegram allowed sender IDs"]').value`), '700001\n700003')

    await win.reload()
    await wait(() => run(`document.querySelector('input[aria-label="Telegram Bot Token"]')?.placeholder === 'Leave blank to keep the saved Token'`), 'settings restored after renderer reload')
    assert.equal(await run(`document.querySelector('#channel-settings-panel-telegram input[role="switch"]').checked`), true)
    const restored = await run<ConversationSnapshot>(`window.goodbuddy.conversations.get(${JSON.stringify(conversation.id)})`)
    assert.deepEqual(restored.messages, conversation.messages)
    const disk = new AssistantDatabase(databasePath)
    try {
      disk.openReadOnly()
      assert.deepEqual(disk.getConversation(conversation.id).messages, conversation.messages)
    }
    finally { disk.close() }

    updates.push(inbound(12, 'Wait for cancellation'))
    await wait(() => payloads.length === 2, 'second model request running')
    await click('#channel-settings-panel-telegram input[role="switch"]')
    await click('button.primary-button')
    await wait(() => cancelledModel, 'disable channel aborts model HTTP stream')
    await wait(async () => !(await channels.resolve('telegram')).enabled, 'disabled settings persisted')
    await wait(() => run(`!document.querySelector('button.primary-button').disabled`), 'disable and service shutdown completed')
    const stopped = await run<{ telegram: { status: { state: string } } }>('window.goodbuddy.channels.getSnapshot()')
    assert.equal(stopped.telegram.status.state, 'disabled')
    assert.equal(calls.filter(call => call.method === 'sendMessage').length, 1, 'No reply after disabling')

    await click('#channel-settings-panel-telegram input[role="switch"]')
    await click('button.primary-button')
    await wait(() => run(`!document.querySelector('button.primary-button').disabled && document.querySelector('.channel-settings-card .capability-card__header > span')?.textContent === 'Connected'`), 're-enabled before clearing credentials')
    sendingForbidden = true
    database.enqueueChannelResult({ channel: 'telegram', eventId: 'delivery-status-fixture',
      conversationId: '123456:700001', recipientId: '700001', status: 'completed', output: 'Synthetic saved reply' })
    pollingConflict = true
    await wait(() => run(`document.querySelector('.channel-settings-card [role="alert"]')?.textContent.includes('polling conflict')`), 'conflict before saved reply retry')
    pollingConflict = false
    await click('button.primary-button')
    await wait(() => run(`document.querySelector('.channel-settings-card .capability-card__header > span')?.textContent === 'Connected' && document.querySelector('.channel-settings-card [role="alert"]')?.textContent.includes('Telegram sending failed:')`), 'sending failure visible while polling stays connected')
    assert.equal(database.listUndeliveredChannelResults('telegram').find(entry => entry.message.eventId === 'delivery-status-fixture')?.state, 'terminal')
    const visibleFailure = await run<string>(`document.querySelector('.channel-settings-card [role="alert"]').textContent`)
    assert(visibleFailure.includes('forbidden'))
    assert(!visibleFailure.includes(token) && !visibleFailure.includes('api.telegram.org'))
    await fill('input[aria-label="Telegram Bot Token"]', 'unsaved-delivery-token')
    await fill('textarea[aria-label="Telegram allowed sender IDs"]', '700001\n700004')
    const pollsBefore = calls.filter(call => call.method === 'getUpdates').length
    await wait(() => calls.filter(call => call.method === 'getUpdates').length >= pollsBefore + 2, 'healthy polls after delivery failure')
    assert.equal(await run(`document.querySelector('.channel-settings-card [role="alert"]').textContent`), visibleFailure)
    assert.equal(await run(`document.querySelector('input[aria-label="Telegram Bot Token"]').value`), 'unsaved-delivery-token')
    assert.equal(await run(`document.querySelector('textarea[aria-label="Telegram allowed sender IDs"]').value`), '700001\n700004')
    await win.reload()
    await wait(() => run(`document.querySelector('.channel-settings-card [role="alert"]')?.textContent.includes('Telegram sending failed:')`), 'delivery error restored from snapshot')
    sendingForbidden = false
    const projectBeforeClear = database.getProject(conversation.projectId!)
    const historyBeforeClear = database.getConversation(conversation.id)
    await click('#channel-settings-panel-telegram input[type="checkbox"]:not([role="switch"])')
    await click('button.primary-button')
    await wait(() => run(`!document.querySelector('button.primary-button').disabled && !document.querySelector('#channel-settings-panel-telegram input[role="switch"]').checked && !document.querySelector('#channel-settings-panel-telegram input[type="checkbox"]:not([role="switch"])') && document.querySelector('.channel-settings-card .capability-card__header > span')?.textContent === 'Not configured'`), 'cleared Token disables the enabled channel')
    const cleared = await new ChannelSettingsStore(channelsPath, cipher, {}).resolve('telegram')
    assert.equal(cleared.enabled, false)
    assert.equal(cleared.secret, undefined)
    assert.equal(cleared.source, 'none')
    assert.deepEqual({ ...database.getProject(conversation.projectId!), updatedAt: projectBeforeClear.updatedAt }, projectBeforeClear)
    assert.deepEqual(database.getConversation(conversation.id), historyBeforeClear)
    assert.deepEqual(blocked, [], 'No unexpected external requests')
    console.log(JSON.stringify({ telegramSmoke: 'passed', uiConfigSaveTest: true, productionPreloadIpc: true,
      productionExecutor: true, desktopConversationPersisted: true, reloadRestored: true,
      disableCancelsModel: true, liveStatusPreservesDrafts: true, unchangedSaveRecoversConflict: true, clearTokenDisablesAndPreservesHistory: true,
      sendingFailureRetainsPollingStateAndDrafts: true,
      modelCalls: payloads.length, telegramReplies: replies.length,
      pollsAborted, externalNetworkCalls: 0 }))
  } finally {
    await dispose()
    await runtime.dispose()
    database.close()
    win.destroy()
    net.fetch = originalNetFetch
    globalThis.fetch = originalFetch
    model.closeAllConnections()
    await new Promise<void>(resolve => model.close(() => resolve()))
  }
  app.exit(0)
}).catch(error => { console.error(error); app.exit(1) })

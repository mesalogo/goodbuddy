import { app, BrowserWindow } from 'electron'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { registerIpcHandlers } from '../../src/main/ipc'
import { AssistantDatabase } from '../../src/main/assistant/assistant-database'
import { ApplicationSettingsStore } from '../../src/main/application-settings-store'
import { createDefaultModelRuntime } from '../../src/main/agent/create-runtime'
import { defaultRuntimeSettings } from '../../src/shared/contracts'
import { ContextManager } from '../../src/main/context-manager'

const directory = process.env.GB_CAPTURE_DIRECTORY!
app.setPath('userData', join(directory, 'profile'))
app.whenReady().then(async () => {
  let calls = 0
  let scenario = 'empty'
  const server = createServer(async (req, res) => {
    for await (const chunk of req) { void chunk /* Drain the real model request. */ }
    calls++
    if (scenario === 'failed') { res.writeHead(400, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'Probe failure' } })); return }
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write(`data: ${JSON.stringify({ id: 'probe', choices: [{ index: 0, delta: { role: 'assistant', content: scenario === 'partial' ? 'PARTIAL_REPLY' : '' }, finish_reason: null }] })}\n\n`)
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const modelBaseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`
  const settings = { ...defaultRuntimeSettings, workspacePath: directory, defaultModelProfileId: '', modelProfiles: [], embeddingConnections: [], modelBaseUrl,
    modelName: 'terminal-probe', modelProtocol: 'openai-chat-completions' as const, modelAuthentication: 'none' as const }
  const runtime = createDefaultModelRuntime(directory, settings)
  const win = new BrowserWindow({ show: true, width: 1100, height: 800, webPreferences: {
    sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, preload: join(directory, 'preload.cjs')
  } })
  const database = new AssistantDatabase(join(directory, 'assistant.sqlite')); database.initialize(directory)
  const appSettings = new ApplicationSettingsStore(join(directory, 'application.json'))
  await appSettings.update({ checkUpdatesOnStartup: false, heartbeatEnabled: false })
  const dispose = registerIpcHandlers(win, runtime, 'CommandOrControl+Shift+Space',
    { getResolvedSettings: async () => settings, getPublicSettings: async () => settings } as never,
    { getEnabledBuiltinMcpServerIds: async () => [] } as never, new ContextManager(),
    { snapshot: () => ({ libraries: [], sources: [], documents: [], entities: [], relations: [], evidence: [], tasks: [] }),
      database: { externalStore: { listBindings: () => [] } }, external: { listInstances: () => [] } } as never,
    database, { clear() {} } as never, {} as never, async () => {}, undefined, undefined, undefined, undefined, appSettings,
    undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
    { getPending: async () => undefined } as never)
  const run = <T = unknown>(script: string): Promise<T> => win.webContents.executeJavaScript(script, true)
  async function wait(script: string) {
    for (let i = 0; i < 300; i++) { if (await run(script)) return; await new Promise(resolve => setTimeout(resolve, 50)) }
    throw new Error(`Timeout ${script}: ${await run('document.body.innerText')}`)
  }
  const row = 'document.querySelectorAll(".message--assistant")[document.querySelectorAll(".message--assistant").length-1]'
  try {
    await win.loadURL(process.env.GB_CAPTURE_URL!)
    for (scenario of ['empty', 'partial', 'failed']) {
      const expectedCalls = calls + 1
      await wait('!!document.querySelector(".composer textarea")')
      await run(`(() => { const e=document.querySelector('.composer textarea'); const set=Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set; set.call(e,${JSON.stringify('Probe ')}+${JSON.stringify(scenario)});e.dispatchEvent(new Event('input',{bubbles:true})); })()`)
      await wait('!document.querySelector(".send-button").disabled')
      await run('document.querySelector(".send-button").click()')
      for (let i = 0; calls < expectedCalls && i < 200; i++) await new Promise(resolve => setTimeout(resolve, 50))
      assert.equal(calls, expectedCalls)
      if (scenario !== 'failed') {
        if (scenario === 'partial') await wait(`${row}.textContent.includes('PARTIAL_REPLY')`)
        await wait('!!document.querySelector(".send-button--stop")')
        await run('document.querySelector(".send-button--stop").click()')
      }
      const role = scenario === 'failed' ? 'alert' : 'status'
      await wait(`${row}.querySelector('.message__status')?.getAttribute('role') === '${role}' && !!${row}.querySelector('.message-retry')`)
      const status = await run<string>(`${row}.querySelector('.message__status').textContent`)
      assert.equal(await run(`${row}.querySelectorAll('.message__content').length`), scenario === 'partial' ? 1 : 0)
      assert.equal(await run(`${row}.textContent.split(${JSON.stringify(status)}).length - 1`), 1)
      for (const theme of ['light', 'dark']) {
        await run(`document.documentElement.dataset.theme='${theme}'`)
        assert.equal(await run(`${row}.querySelector('.message__status').classList.contains('message__status--error')`), scenario === 'failed')
        const colors = await run<string[]>(`(() => { const e=${row}.querySelector('.message__status'), c=document.createElement('span'); c.style.color='var(${scenario === 'failed' ? '--danger' : '--text-muted'})';e.append(c); const result=[getComputedStyle(e).color,getComputedStyle(c).color];c.remove();return result })()`)
        assert.equal(colors[0], colors[1])
      }
      await run(`${row}.querySelector('.message-retry').click()`)
      assert.equal(await run('document.activeElement === document.querySelector(".composer textarea")'), true)
      assert.equal(await run('document.querySelector(".composer textarea").value'), `Probe ${scenario}`)
      assert.equal(calls, expectedCalls)
      let saved
      for (let i = 0; i < 200; i++) {
        saved = database.listConversations()[0]?.messages.at(-1)
        if (saved?.terminalStatus === (scenario === 'failed' ? 'failed' : 'cancelled')) break
        await new Promise(resolve => setTimeout(resolve, 50))
      }
      assert.equal(saved?.terminalStatus, scenario === 'failed' ? 'failed' : 'cancelled')
      assert.equal(saved?.content, scenario === 'partial' ? 'PARTIAL_REPLY' : '')
      database.close(); database.initialize(directory)
      await win.loadURL(process.env.GB_CAPTURE_URL!)
      await wait(`${row}?.querySelector('.message__status')?.getAttribute('role') === '${role}'`)
      assert.equal(await run(`${row}.querySelectorAll('.message__content').length`), scenario === 'partial' ? 1 : 0)
    }
    console.log(JSON.stringify({ nativeElectron: true, productionIpc: true, sqliteReopened: true, themes: ['light', 'dark'], scenarios: 3, deterministicHttpCalls: calls, paidCalls: 0 }))
  } finally { dispose(); database.close(); await runtime.dispose(); server.closeAllConnections(); server.close(); win.destroy() }
}).then(() => app.exit(0)).catch(error => { console.error(error); app.exit(1) })

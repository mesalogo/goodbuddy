import { app, BrowserWindow, safeStorage } from 'electron'
import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { registerIpcHandlers } from '../../src/main/ipc'
import { AssistantDatabase } from '../../src/main/assistant/assistant-database'
import { ApplicationSettingsStore } from '../../src/main/application-settings-store'
import { CapabilityService } from '../../src/main/capabilities/capability-service'
import { RuntimeSettingsStore } from '../../src/main/runtime-settings-store'
import { KnowledgeMcpGateway } from '../../src/main/agent/knowledge-mcp-gateway'
import type { KnowledgeService } from '../../src/main/knowledge/knowledge-service'

const directory = process.env.GB_MCP_DIRECTORY!
app.setPath('userData', join(directory, 'profile'))
app.commandLine.appendSwitch('force-device-scale-factor', '1')
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion')

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: true, width: 1280, height: 900, useContentSize: true,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false,
      backgroundThrottling: false, preload: join(directory, 'preload.cjs') } })
  const database = new AssistantDatabase(join(directory, 'assistant.sqlite'))
  database.initialize(directory)
  const projectId = database.listProjects()[0]!.id
  const conversationId = '00000000-0000-4000-8000-000000000321'
  database.saveLocalConversations([{ header: { id: conversationId, projectId, title: 'Graph switch', updatedAt: 1 }, messages: [] }])
  const application = new ApplicationSettingsStore(join(directory, 'application.json'))
  await application.update({ heartbeatEnabled: true, checkUpdatesOnStartup: false })
  const cipher = { isAvailable: () => safeStorage.isEncryptionAvailable(),
    encrypt: (value: string) => safeStorage.encryptString(value), decrypt: (value: Buffer) => safeStorage.decryptString(value) }
  const capabilities = new CapabilityService(join(directory, 'capabilities.json'), join(directory, 'builtin-skills'), join(directory, 'imported-skills'), cipher)
  const settings = new RuntimeSettingsStore(join(directory, 'runtime.json'), cipher, {})
  const knowledge = { snapshot: () => ({ libraries: [{ id: '00000000-0000-4000-8000-000000000322', name: 'Knowledge', documentCount: 0 }], sources: [], documents: [], entities: [], relations: [], evidence: [], tasks: [] }),
    database: { externalStore: { listBindings: () => [] } }, external: { listInstances: () => [] } } as unknown as KnowledgeService
  const gateway = new KnowledgeMcpGateway(knowledge, { storyGraphService: {
    available: async binding => (await application.get()).heartbeatEnabled === true && database.isConversationStoryGraphEnabled(binding.conversationId!),
    read: database.readStoryGraph.bind(database)
  } })
  const token = gateway.grant('ui-probe', [], new AbortController().signal, 'none', undefined, undefined, undefined, undefined, undefined,
    { projectId, conversationId, runtimeTarget: 'model' })!
  const binding = gateway.bindRemoteStoryGraph(token)!
  const dispose = registerIpcHandlers(win,
    { capability: 'text', getStatus: async () => ({ available: true, name: 'Switch test', capability: 'text' }) } as never,
    'CommandOrControl+Shift+Space', settings, capabilities,
    { clear() {}, cancelImport() {}, getDraft: () => [] } as never, knowledge,
    database, {} as never, async () => {}, undefined, undefined,
    undefined, undefined, application, undefined, undefined, undefined, undefined, undefined,
    undefined, undefined, undefined, undefined, undefined, { getPending: async () => undefined } as never)
  const js = <T = unknown>(code: string): Promise<T> => win.webContents.executeJavaScript(code)
  win.webContents.on('console-message', event => { if (event.level === 'error') console.error(event.message) })
  const wait = async (code: string): Promise<void> => {
    for (let i = 0; i < 400; i++) {
      if (await js(code)) return
      await new Promise(resolve => setTimeout(resolve, 25))
    }
    throw new Error(`Timeout: ${code}; ${await js('JSON.stringify({focus:document.activeElement?.tagName + " " + document.activeElement?.className,hidden:document.querySelector(".composer__options")?.hidden,text:document.body.innerText.slice(0,1000)})')}`)
  }
  const toggle = '.composer__options input[role="switch"]'
  const open = async (): Promise<void> => {
    await wait('!!document.querySelector(".composer__options-trigger")')
    await wait(`!!document.querySelector('${toggle}')`)
    await wait('document.querySelector(".topbar")?.textContent.includes("Graph switch")')
    win.focus(); win.webContents.focus()
    await wait('document.hasFocus()')
    await js('document.querySelector(".composer__options-trigger").focus()')
    const point = await js<{ x: number; y: number }>(`(() => { const r = document.querySelector('.composer__options-trigger').getBoundingClientRect(); return { x: Math.round(r.x+r.width/2), y: Math.round(r.y+r.height/2) }; })()`)
    win.webContents.sendInputEvent({ type: 'mouseDown', ...point, button: 'left', clickCount: 1 })
    win.webContents.sendInputEvent({ type: 'mouseUp', ...point, button: 'left', clickCount: 1 })
    // Focus the first enabled context control, which is the story-graph
    // switch when no knowledge libraries are available.
    await wait('document.activeElement === document.querySelector(".composer__options button:not(:disabled), .composer__options input:not(:disabled)")')
  }
  const scenarios: object[] = []
  try {
    await win.loadURL(process.env.GB_MCP_URL!)
    await js('window.goodbuddy.updates.updateSettings({heartbeatEnabled:true})')
    await wait('document.body.innerText.includes("Supervisor") || document.body.innerText.includes("监督")')
    await open()
    assert.equal(await binding.available(), true)
    for (const width of [1280, 390]) for (const theme of ['light', 'dark']) {
      win.setContentSize(width, 900)
      await js(`document.documentElement.dataset.theme = '${theme}'`)
      await wait(`innerWidth === ${width}`)
      if (width < 900) await wait('!document.querySelector(".assistant-sidebar--open")')
      await js('Promise.all(document.getAnimations().filter(a => a.effect.getTiming().iterations !== Infinity).map(a => a.finished.catch(() => {}))).then(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))')
      if (await js('document.querySelector(".composer__options").hidden')) await open()
      const layout = await js<{ fits: boolean; shared: boolean; beforeKnowledge: boolean }>(`(() => {
        const e = document.querySelector('${toggle}'), r = e.getBoundingClientRect(), s = getComputedStyle(e);
        const kb = document.querySelector('.knowledge-scope');
        return { fits: r.width > 0 && r.left >= 0 && r.right <= innerWidth,
          shared: s.appearance === 'none' && !!e.closest('.toggle-row'),
          beforeKnowledge: !!(e.compareDocumentPosition(kb) & Node.DOCUMENT_POSITION_FOLLOWING) };
      })()`)
      assert.deepEqual(layout, { fits: true, shared: true, beforeKnowledge: true }, JSON.stringify({ width, theme,
        rect: await js(`document.querySelector('${toggle}').getBoundingClientRect().toJSON()`) }))
      scenarios.push({ width, theme, ...layout })
    }
    win.focus(); win.webContents.focus()
    await js(`document.querySelector('${toggle}').focus()`)
    await wait('document.hasFocus()')
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Space' })
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Space' })
    await wait(`!document.querySelector('${toggle}').checked && !document.querySelector('${toggle}').disabled`)
    assert.equal(database.isConversationStoryGraphEnabled(conversationId), false)
    assert.equal(await binding.available(), false)
    await assert.rejects(binding.call('story_graph_search', { query: 'Decision' }, new AbortController().signal), /story_graph_unavailable/)
    await win.loadURL(process.env.GB_MCP_URL!)
    await open()
    assert.equal(await js(`document.querySelector('${toggle}').checked`), false)
    await js('window.goodbuddy.updates.updateSettings({heartbeatEnabled:false})')
    await wait(`!document.querySelector('${toggle}')`)
    await js('window.goodbuddy.updates.updateSettings({heartbeatEnabled:true})')
    await wait(`!!document.querySelector('${toggle}')`)
    assert.equal(await js(`document.querySelector('${toggle}').checked`), false)
    const modelAttempts = (globalThis as typeof globalThis & { overlayModelAttempts?: number }).overlayModelAttempts ?? 0
    assert.equal(modelAttempts, 0)
    await writeFile(join(directory, 'result.json'), JSON.stringify({ scenarios, modelAttempts,
      persistedAfterReload: true, revokedExistingBinding: true, hiddenWhenDisabled: true }))
  } finally { win.destroy(); await dispose(); await gateway.dispose(); database.close() }
  app.exit(0)
}).catch(error => { console.error(error); app.exit(1) })

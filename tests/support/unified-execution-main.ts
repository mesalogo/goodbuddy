import { app, BrowserWindow, safeStorage } from 'electron'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { registerIpcHandlers } from '../../src/main/ipc'
import { AssistantDatabase } from '../../src/main/assistant/assistant-database'
import { ApplicationSettingsStore } from '../../src/main/application-settings-store'
import { CapabilityService } from '../../src/main/capabilities/capability-service'
import { RuntimeSettingsStore } from '../../src/main/runtime-settings-store'

const directory = process.env.GB_MCP_DIRECTORY!
app.setPath('userData', join(directory, 'profile'))
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion')
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: true, width: 1280, height: 900, useContentSize: true,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false,
      backgroundThrottling: false, preload: join(directory, 'preload.cjs') } })
  const database = new AssistantDatabase(join(directory, 'assistant.sqlite'))
  database.initialize(directory)
  const conversationId = randomUUID()
  database.saveLocalConversations([{ header: { id: conversationId, projectId: database.listProjects()[0]!.id,
    title: 'Confirmation sentinel', updatedAt: Date.now() }, messages: [
    { id: randomUUID(), role: 'assistant', state: 'complete', createdAt: Date.now(), content: 'Keep until confirmed' }
  ] }])
  const applicationSettings = new ApplicationSettingsStore(join(directory, 'application.json'))
  await applicationSettings.update({ checkUpdatesOnStartup: false })
  const cipher = { isAvailable: () => safeStorage.isEncryptionAvailable(),
    encrypt: (value: string) => safeStorage.encryptString(value), decrypt: (value: Buffer) => safeStorage.decryptString(value) }
  const settings = new RuntimeSettingsStore(join(directory, 'runtime.json'), cipher, {})
  const capabilities = new CapabilityService(join(directory, 'capabilities.json'),
    join(directory, 'builtin-skills'), join(directory, 'imported-skills'), cipher)
  // App, preload, IPC, settings and SQLite are production; unrelated startup services are isolated.
  const dispose = registerIpcHandlers(win,
    { capability: 'text', getStatus: async () => ({ available: true, name: 'UI regression', capability: 'text' }) } as never,
    'CommandOrControl+Shift+Space', settings, capabilities,
    { clear() {}, cancelImport() {}, getDraft: () => [] } as never,
    { snapshot: () => ({ libraries: [], sources: [], documents: [], entities: [], relations: [], evidence: [], tasks: [] }),
      database: { externalStore: { listBindings: () => [] } }, external: { listInstances: () => [] } } as never,
    database, {} as never, async () => {}, undefined, undefined,
    undefined, undefined, applicationSettings, undefined, undefined, undefined, undefined, undefined,
    undefined, undefined, undefined, undefined, undefined, { getPending: async () => undefined } as never)
  const js = <T = unknown>(code: string): Promise<T> => win.webContents.executeJavaScript(code)
  const wait = async (code: string): Promise<void> => {
    for (let i = 0; i < 400; i++) {
      if (await js(code)) return
      await new Promise(resolve => setTimeout(resolve, 25))
    }
    throw new Error(`Timeout: ${code}\n${await js('document.body.innerText')}`)
  }
  const click = async (selector: string): Promise<void> => {
    await wait(`!!document.querySelector(${JSON.stringify(selector)})`)
    await js(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:'center'})`)
    await js('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))')
    const point = await js<{ x: number; y: number; hit: boolean }>(`(() => {
      const e=document.querySelector(${JSON.stringify(selector)}),r=e.getBoundingClientRect(),x=Math.round(r.x+r.width/2),y=Math.round(r.y+r.height/2);
      return {x,y,hit:e.contains(document.elementFromPoint(x,y))}; })()`)
    win.focus(); win.webContents.focus()
    win.webContents.sendInputEvent({ type: 'mouseMove', x: point.x, y: point.y })
    await wait(`(() => { const e=document.querySelector(${JSON.stringify(selector)}); return e.contains(document.elementFromPoint(${point.x},${point.y})); })()`)
    win.webContents.sendInputEvent({ type: 'mouseDown', x: point.x, y: point.y, button: 'left', clickCount: 1 })
    win.webContents.sendInputEvent({ type: 'mouseUp', x: point.x, y: point.y, button: 'left', clickCount: 1 })
  }
  const escape = async (): Promise<void> => {
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' })
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' })
  }
  const preserved = (): boolean => database.listConversationSummaries().some(item => item.id === conversationId)
  const assertNoMode = async (selector: string): Promise<void> => {
    assert(await js(`(() => {
      const root=document.querySelector(${JSON.stringify(selector)});
      return !!root && !root.querySelector('.composer-picker--mode, [name="workMode"], [name="defaultWorkMode"]') &&
        ![...root.querySelectorAll('button, label, [role="group"]')].some(e => /^(Ask|Execute|Plan|Default mode|Work mode)$/.test((e.getAttribute('aria-label') || e.textContent).trim()));
    })()`), `Product work mode must be absent in ${selector}`)
  }
  try {
    await win.loadURL(process.env.GB_MCP_URL!)
    await js('window.goodbuddy.updates.updateSettings({heartbeatEnabled:true})')
    await wait('!!document.querySelector(".composer textarea") && document.body.innerText.includes("Keep until confirmed")')
    await assertNoMode('.composer')
    await click('.composer__options-trigger')
    await wait('!!document.querySelector(".composer__options")')
    await assertNoMode('.composer__options')
    await escape()
    await click('.project-switcher__trigger')
    await click('.project-switcher__menu-settings')
    await wait('!!document.querySelector(".project-create-card")')
    await assertNoMode('.project-create-card')
    await escape()
    await wait('!document.querySelector(".project-create-card")')
    await click('button[aria-label="Settings"]')
    await wait('!!document.querySelector(".settings-tabs")')
    assert(await js('!document.querySelector("#settings-tab-security")'))
    await click('#settings-tab-platform-features')
    const danger = '.settings-section--danger'
    await wait(`!!document.querySelector('${danger} > .danger-button')`)
    assert.equal(await js(`(() => {
      let e=document.querySelector('#settings-tab-platform-features').previousElementSibling;
      while (e && !e.matches('.settings-tabs__group-label')) e=e.previousElementSibling;
      return e?.textContent.trim();
    })()`), 'General')
    assert(preserved())
    await click(`${danger} > .danger-button`)
    await wait(`!!document.querySelector('${danger} .danger-actions')`)
    assert(preserved(), 'First click must not delete data')
    await click(`${danger} .danger-actions .secondary-button`)
    await wait(`!document.querySelector('${danger} .danger-actions')`)
    assert(preserved(), 'Cancel must preserve data')
    await click(`${danger} > .danger-button`)
    await click(`${danger} .danger-actions .danger-button`)
    await wait(`!document.querySelector('${danger} .danger-actions')`)
    assert.equal(preserved(), false, 'Confirmed clear must reach production IPC and SQLite')
    await win.loadURL(process.env.GB_MCP_URL!)
    await wait('!!document.querySelector(".composer textarea")')
    assert.equal(preserved(), false)
    assert(await js('!document.body.innerText.includes("Keep until confirmed")'))
    const modelAttempts = (globalThis as typeof globalThis & { overlayModelAttempts?: number }).overlayModelAttempts ?? 0
    assert.equal(modelAttempts, 0)
    await writeFile(join(directory, 'result.json'), JSON.stringify({ composer: true, project: true,
      securityAbsent: true, generalClearData: true, cancelPreservedData: true, confirmedClear: true,
      persistedAfterReload: true, modelAttempts }))
  } finally { await dispose(); win.destroy(); database.close() }
  app.exit(0)
}).catch(error => { console.error(error); app.exit(1) })

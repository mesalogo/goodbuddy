import { app, BrowserWindow, safeStorage, WebContentsView } from 'electron'
import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { registerIpcHandlers } from '../../src/main/ipc'
import { AssistantDatabase } from '../../src/main/assistant/assistant-database'
import { ApplicationSettingsStore } from '../../src/main/application-settings-store'
import { CapabilityService } from '../../src/main/capabilities/capability-service'
import { BrowserService } from '../../src/main/browser/browser-service'
import { RuntimeSettingsStore } from '../../src/main/runtime-settings-store'

const directory = process.env.GB_MCP_DIRECTORY!
app.setPath('userData', join(directory, 'profile'))
app.commandLine.appendSwitch('force-device-scale-factor', '1')
// Other desktop windows must not suspend the frame-based input synchronization.
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion')

app.whenReady().then(async () => {
  console.log('MCP overlay: Electron ready')
  const win = new BrowserWindow({ show: true, width: 1280, height: 900, useContentSize: true,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false,
      backgroundThrottling: false, preload: join(directory, 'preload.cjs') } })
  const database = new AssistantDatabase(join(directory, 'assistant.sqlite'))
  database.initialize(directory)
  const applicationSettings = new ApplicationSettingsStore(join(directory, 'application.json'))
  await applicationSettings.update({ checkUpdatesOnStartup: false })
  const cipher = { isAvailable: () => safeStorage.isEncryptionAvailable(),
    encrypt: (value: string) => safeStorage.encryptString(value), decrypt: (value: Buffer) => safeStorage.decryptString(value) }
  const capabilities = new CapabilityService(join(directory, 'capabilities.json'),
    join(directory, 'builtin-skills'), join(directory, 'imported-skills'), cipher)
  const browser = new BrowserService({ parentWindow: win })
  const settings = new RuntimeSettingsStore(join(directory, 'runtime.json'), cipher, {})
  // Only unrelated startup dependencies are substituted; MCP, browser, preload and IPC are production.
  const dispose = registerIpcHandlers(win,
    { capability: 'text', getStatus: async () => ({ available: true, name: 'Overlay test', capability: 'text' }) } as never,
    'CommandOrControl+Shift+Space', settings,
    capabilities, { clear() {}, cancelImport() {}, getDraft: () => [] } as never,
    { snapshot: () => ({ libraries: [], sources: [], documents: [], entities: [], relations: [], evidence: [], tasks: [] }),
      database: { externalStore: { listBindings: () => [] } }, external: { listInstances: () => [] } } as never,
    database, {} as never, async () => {}, undefined, browser,
    undefined, undefined, applicationSettings, undefined, undefined, undefined, undefined, undefined,
    undefined, undefined, undefined, undefined, undefined, { getPending: async () => undefined } as never)
  const errors: string[] = []
  win.webContents.on('console-message', event => { if (event.level === 'error') errors.push(event.message) })
  const js = <T = unknown>(code: string): Promise<T> => win.webContents.executeJavaScript(code)
  const settle = (): Promise<unknown> => js('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
  const wait = async (code: string): Promise<void> => {
    for (let i = 0; i < 600; i++) {
      if (await js(code)) return
      await new Promise(resolve => setTimeout(resolve, 25))
    }
    throw new Error(`Timeout: ${code}\nFocus: ${await js('document.activeElement?.tagName + " " + document.activeElement?.className')}\n${await js('document.body.innerText')}\n${errors.join('\n')}`)
  }
  const click = async (selector: string): Promise<void> => {
    win.focus(); win.webContents.focus()
    await wait(`!!document.querySelector(${JSON.stringify(selector)})`)
    await js(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:'nearest', inline:'nearest'})`)
    await settle()
    const point = await js<{ x: number; y: number; hit: boolean }>(`(() => {
      const e = document.querySelector(${JSON.stringify(selector)}); e.scrollIntoView({block:'nearest'});
      const r = e.getBoundingClientRect(), x = Math.round(r.x+r.width/2), y = Math.round(r.y+r.height/2);
      return {x,y,hit:e.contains(document.elementFromPoint(x,y))}; })()`)
    assert(point.hit, `Occluded: ${selector} ${JSON.stringify(point)} ${await js(`document.elementFromPoint(${point.x},${point.y})?.className`)}`)
    win.focus(); win.webContents.focus()
    win.webContents.sendInputEvent({ type: 'mouseDown', x: point.x, y: point.y, button: 'left', clickCount: 1 })
    win.webContents.sendInputEvent({ type: 'mouseUp', x: point.x, y: point.y, button: 'left', clickCount: 1 })
    await settle()
  }
  const key = async (keyCode: string, modifiers: Electron.KeyboardInputEvent['modifiers'] = []): Promise<void> => {
    win.focus(); win.webContents.focus()
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers })
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers })
    await settle()
  }
  const evidence: Record<string, unknown> = {}
  const pageServer = createServer((_request, response) => {
    response.setHeader('Content-Type', 'text/html')
    response.end('<html><body style="background:#f80"><h1>MCP overlay browser fixture</h1><input id="browser-input"></body></html>')
  })
  await new Promise<void>(resolve => pageServer.listen(0, '127.0.0.1', resolve))
  const pageAddress = pageServer.address() as { port: number }
  const nativeView = (): WebContentsView | undefined => win.contentView.children.find(view => view instanceof WebContentsView) as WebContentsView | undefined
  const waitNative = async (visible: boolean): Promise<void> => {
    for (let i = 0; i < 200; i++) {
      if (nativeView()?.getVisible() === visible) return
      await new Promise(resolve => setTimeout(resolve, 25))
    }
    assert.equal(nativeView()?.getVisible(), visible, 'Native browser visibility ' + JSON.stringify(await js(`({
      overlays:[...document.querySelectorAll('[aria-modal=true],[role=dialog],[role=menu],.app-notification')].map(e=>[e.className,e.getBoundingClientRect().toJSON()]),
      viewport:document.querySelector('.assistant-sidebar__browser-viewport')?.getBoundingClientRect().toJSON(),
      workbar:document.querySelector('.assistant-sidebar-toggle')?.outerHTML,
      inert:[...document.querySelectorAll('[inert]')].map(e=>e.className || e.id)})`)))
  }
  try {
    console.log('MCP overlay: loading App')
    await win.loadURL(process.env.GB_MCP_URL!)
    console.log('MCP overlay: App loaded')
    await wait('!!document.querySelector(".sidebar")')
    console.log('MCP overlay: App mounted')
    const add = '#mcp-settings-panel-custom .settings-content-actions button'
    const scenarios: unknown[] = []
    for (const withBrowser of [false, true]) {
      if (withBrowser) {
        await click('.assistant-sidebar-toggle[aria-expanded=false]')
        await wait('!!document.querySelector(".assistant-sidebar-toggle[aria-expanded=true]")')
        await js('document.querySelector(".workbar-shell__tab[aria-selected=true]").focus()')
        await key('Right')
        await key('Right')
        await wait('document.querySelector(".workbar-shell__tab[aria-selected=true]").textContent.startsWith("Browser")')
        await waitNative(true)
        await wait('!document.querySelector(".assistant-sidebar__browser-address input").disabled')
        await click('.assistant-sidebar__browser-address input')
        await key('A', ['control'])
        await win.webContents.insertText(`http://127.0.0.1:${pageAddress.port}/`)
        await wait(`document.querySelector('.assistant-sidebar__browser-address input').value === 'http://127.0.0.1:${pageAddress.port}/' &&
          !document.querySelector('.assistant-sidebar__browser-go').disabled`)
        await click('.assistant-sidebar__browser-go')
        for (let i = 0; i < 200; i++) {
          if (await nativeView()!.webContents.executeJavaScript('document.querySelector("h1")?.textContent === "MCP overlay browser fixture"')) break
          await new Promise(resolve => setTimeout(resolve, 25))
        }
        assert.equal(await nativeView()!.webContents.executeJavaScript('document.querySelector("h1")?.textContent'), 'MCP overlay browser fixture',
          'Browser page ' + nativeView()!.webContents.getURL() + ' ' + await nativeView()!.webContents.executeJavaScript('document.body?.innerText'))
        await nativeView()!.webContents.executeJavaScript('window.overlayDocumentToken = "preserve-page"')
      }
      for (const theme of ['light', 'dark']) {
        console.log('MCP overlay scenario:', { withBrowser, theme })
        const width = theme === 'light' || withBrowser ? 1280 : 960
        const height = theme === 'light' ? 900 : 420
        await js(`document.documentElement.dataset.theme = '${theme}'`)
        await click('button[aria-label="Settings"]')
        await click('#settings-tab-capabilities')
        await click('#capabilities-settings-tab-mcp')
        await click('#mcp-settings-tab-custom')
        win.setContentSize(width, height)
        await wait(`innerWidth === ${width} && innerHeight === ${height}`)
        await settle()
        if (withBrowser) await waitNative(false)
        const browserId = nativeView()?.webContents.id
        await click(add)
        await wait('document.activeElement === document.querySelector(".mcp-editor input")')
        if (withBrowser) await waitNative(false)
        assert(await js(`document.querySelector('.settings-backdrop').inert && document.querySelector('.app-shell').inert &&
          !document.querySelector('.mcp-editor').closest('[inert]')`), 'Only the child modal may be interactive')
        await click('.mcp-editor input')
        await win.webContents.insertText('Keyboard draft')
        await wait('document.querySelector(".mcp-editor input").value === "Keyboard draft"')
        // Programmatic background focus must also be rejected by Chromium inert handling.
        await js('document.querySelector("#settings-tab-appearance").focus()')
        assert(await js('!!document.activeElement.closest(".mcp-editor")'))
        await click('.mcp-editor__header button')
        await wait(`!document.querySelector('.mcp-editor') && document.activeElement === document.querySelector('${add}')`)
        for (const close of ['escape', 'cancel', 'backdrop']) {
          await click(add)
          await wait('document.activeElement === document.querySelector(".mcp-editor input")')
          await key('Tab', ['shift'])
          assert(await js('document.activeElement.matches(".mcp-editor__header button")'))
          await key('Tab', ['shift'])
          assert(await js('document.activeElement.matches(".mcp-editor__actions .primary-button")'))
          await key('Tab')
          assert(await js('document.activeElement.matches(".mcp-editor__header button")'))
          if (close === 'escape') await key('Escape')
          else if (close === 'cancel') await click('.mcp-editor__actions .secondary-button')
          else {
            win.webContents.sendInputEvent({ type: 'mouseDown', x: 2, y: 2, button: 'left', clickCount: 1 })
            win.webContents.sendInputEvent({ type: 'mouseUp', x: 2, y: 2, button: 'left', clickCount: 1 })
          }
          await wait(`!document.querySelector('.mcp-editor') && document.activeElement === document.querySelector('${add}')`)
          assert(await js('!!document.querySelector(".settings-panel") && !document.querySelector(".settings-backdrop").inert && document.querySelector(".app-shell").inert'))
          if (withBrowser) await waitNative(false)
        }
        await click(add)
        await click('.mcp-editor input')
        const name = `Overlay ${withBrowser}-${theme}`
        await win.webContents.insertText(name)
        await click('.mcp-editor input[aria-label]')
        await win.webContents.insertText('overlay-test-command')
        // Disable the test configuration so no MCP process is launched by runtime refresh.
        await click('.mcp-editor input[role="switch"]')
        await click('.mcp-editor__actions .primary-button')
        await wait(`!document.querySelector('.mcp-editor') && document.activeElement === document.querySelector('${add}')`)
        const saved = (await capabilities.getSnapshot()).mcpServers.find(server => server.name === name)!
        assert(saved && !saved.enabled && saved.transport === 'stdio' && saved.command === 'overlay-test-command', 'Production IPC must persist the form')
        const edit = '#mcp-settings-panel-custom button[aria-label="Edit ' + name + '"]'
        await click(edit)
        await wait(`document.querySelector('.mcp-editor input')?.value === '${name}'`)
        await click('.mcp-editor input')
        await key('Escape')
        await wait(`!document.querySelector('.mcp-editor') && document.activeElement === document.querySelector('${edit}')`)
        win.setContentSize(1280, 900)
        await wait('innerWidth === 1280 && innerHeight === 900')
        await settle()
        await key('Escape')
        await wait('!document.querySelector(".settings-panel") && !document.querySelector(".app-shell").inert')
        assert(await js('document.activeElement.matches("button[aria-label=Settings]")'), 'Settings must restore its own trigger')
        if (withBrowser) {
          await waitNative(true)
          assert.equal(nativeView()!.webContents.id, browserId, 'Modal must not recreate browser')
          assert.equal(nativeView()!.webContents.getURL(), `http://127.0.0.1:${pageAddress.port}/`)
          assert.equal(await nativeView()!.webContents.executeJavaScript('window.overlayDocumentToken'), 'preserve-page', 'Modal must not reload browser')
        }
        scenarios.push({ withBrowser, theme, width, height, hitTesting: true, focusCycle: true, parentIsolation: true,
          closeMethods: ['X', 'Escape', 'Cancel', 'backdrop', 'save'], savedId: saved.id, edit: true,
          ...(withBrowser ? { nativeHiddenDuringModals: true, nativeRestoredWithoutReload: true } : {}) })
      }
      win.setContentSize(1280, 900)
      await wait('innerWidth === 1280 && innerHeight === 900')
      await settle()
    }
    const reloaded = new CapabilityService(join(directory, 'capabilities.json'),
      join(directory, 'builtin-skills'), join(directory, 'imported-skills'), cipher)
    assert.equal((await reloaded.getSnapshot()).mcpServers.length, 4)
    evidence.scenarios = scenarios
    evidence.persistedAfterReload = true
    evidence.modelAttempts = (globalThis as typeof globalThis & { overlayModelAttempts?: number }).overlayModelAttempts ?? 0
    await writeFile(join(directory, 'result.json'), JSON.stringify(evidence))
    assert.equal(evidence.modelAttempts, 0)
    assert.deepEqual(errors, [])
  } finally {
    win.destroy()
    await dispose()
    await browser.dispose()
    pageServer.close()
    database.close()
  }
  app.exit(0)
}).catch(error => { console.error(error); app.exit(1) })

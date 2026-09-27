import { app, BrowserWindow, ipcMain, nativeImage, safeStorage, screen, WebContentsView } from 'electron'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { createServer } from 'node:http'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { registerIpcHandlers } from '../../src/main/ipc'
import { AssistantDatabase } from '../../src/main/assistant/assistant-database'
import { ApplicationSettingsStore } from '../../src/main/application-settings-store'
import { BrowserService } from '../../src/main/browser/browser-service'
import { CapabilityService } from '../../src/main/capabilities/capability-service'
import { defaultRuntimeSettings } from '../../src/shared/contracts'
import { ipcChannels } from '../../src/shared/ipc-channels'

const directory = process.env.GB_MCP_DIRECTORY!
app.setPath('userData', join(directory, 'profile'))
app.commandLine.appendSwitch('force-device-scale-factor', '1')
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion')

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: true, frame: false, width: 1280, height: 800, useContentSize: true,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false,
      backgroundThrottling: false, preload: join(directory, 'preload.cjs') } })
  const database = new AssistantDatabase(join(directory, 'assistant.sqlite'))
  database.initialize(directory)
  const project = database.listProjects()[0]!
  const resultId = randomUUID()
  const html = '<html><body><a href="#end">Jump to end</a>' + '<p>Long preview text</p>'.repeat(80) +
    '<h2 id="end">End</h2><script>window.parent.previewUnsafe=true</script><img src="https://example.invalid/leak"></body></html>'
  database.saveLocalConversations([{ header: { id: randomUUID(), projectId: project.id, title: 'Overlay paths', updatedAt: Date.now() },
    messages: [{ id: randomUUID(), role: 'assistant', state: 'complete', createdAt: Date.now(), content: '```html\n' + html + '\n```',
      attachments: [{ id: randomUUID(), kind: 'text', name: 'review.pdf', size: 20, preview: 'Saved result', resultId }],
      sourceReferences: [{ libraryId: randomUUID(), libraryName: 'Review', documentName: 'Review source', sourceName: 'Fixture',
        snippet: 'Saved citation', rank: 1, external: { kind: 'external', provider: 'fastgpt', instanceId: randomUUID(), remoteKnowledgeBaseId: 'review' } }]
    }, { id: randomUUID(), role: 'assistant', state: 'complete', createdAt: Date.now(),
      content: '```html\n<html><body><h1>Plain keyboard preview</h1>' + '<p>Long plain content</p>'.repeat(80) + '</body></html>\n```' }] }])
  const settings = { ...defaultRuntimeSettings, workspacePath: directory, modelProfiles: [], embeddingConnections: [] }
  const applicationSettings = new ApplicationSettingsStore(join(directory, 'application.json'))
  await applicationSettings.update({ checkUpdatesOnStartup: false })
  const browser = new BrowserService({ parentWindow: win })
  const cipher = { isAvailable: () => safeStorage.isEncryptionAvailable(),
    encrypt: (value: string) => safeStorage.encryptString(value), decrypt: (value: Buffer) => safeStorage.decryptString(value) }
  const capabilities = new CapabilityService(join(directory, 'capabilities.json'), join(directory, 'builtin-skills'), join(directory, 'imported-skills'), cipher)
  const dispose = registerIpcHandlers(win,
    { capability: 'text', getStatus: async () => ({ available: true, name: 'Overlay fixture', capability: 'text' }) } as never,
    'CommandOrControl+Shift+Space', { getResolvedSettings: async () => settings, getPublicSettings: async () => settings } as never,
    capabilities, { clear() {}, cancelImport() {}, getDraft: () => [] } as never,
    { snapshot: () => ({ libraries: [], sources: [], documents: [], entities: [], relations: [], evidence: [], tasks: [] }),
      database: { externalStore: { listBindings: () => [] } }, external: { listInstances: () => [] } } as never,
    database, { clear() {} } as never, {} as never, async () => {}, undefined, browser,
    undefined, undefined, applicationSettings, undefined, undefined, undefined, undefined, undefined,
    undefined, undefined, undefined, undefined, undefined, { getPending: async () => undefined } as never)
  // Parsing payloads are fixtures; App, preload, window keyboard IPC and browser services are production.
  const redImage = nativeImage.createFromBitmap(Buffer.from([0, 0, 255, 255]), { width: 1, height: 1 }).resize({ width: 200, height: 100 }).toDataURL()
  ipcMain.removeHandler(ipcChannels.documentParsingResult)
  ipcMain.removeHandler(ipcChannels.documentParsingImage)
  ipcMain.handle(ipcChannels.documentParsingResult, () => ({ id: resultId, fileName: 'review.pdf', sourceFormat: '.pdf',
    sections: [{ locator: 'Page 1', content: '![Review](asset:image)' }],
    images: [{ id: 'image', pageNumber: 1, width: 200, height: 100, size: 100, mimeType: 'image/png' }],
    missingImages: [], warnings: [], completeness: 'complete', parsedAt: new Date().toISOString(), durationMs: 1, settings: {} }))
  ipcMain.handle(ipcChannels.documentParsingImage, () => redImage)
  const js = <T = unknown>(code: string): Promise<T> => win.webContents.executeJavaScript(code)
  const settle = (): Promise<unknown> => js('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))')
  const wait = async (code: string): Promise<void> => {
    for (let i = 0; i < 400; i++) {
      if (await js(code)) return
      await new Promise(r => setTimeout(r, 25))
    }
    throw new Error(`Timeout: ${code}\nFocus: ${await js('document.activeElement?.outerHTML')}\n${await js('document.body.innerText')}`)
  }
  const click = async (selector: string): Promise<void> => {
    await wait(`!!document.querySelector(${JSON.stringify(selector)})`)
    await js(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:'nearest'})`)
    await settle()
    const p = await js<{ x: number; y: number; hit: boolean }>(`(()=>{const e=document.querySelector(${JSON.stringify(selector)}),r=e.getBoundingClientRect(),x=Math.round(r.x+r.width/2),y=Math.round(r.y+r.height/2);return {x,y,hit:e.contains(document.elementFromPoint(x,y))}})()`)
    assert(p.hit, `Occluded ${selector}`)
    win.focus()
    win.webContents.sendInputEvent({ type: 'mouseDown', x: p.x, y: p.y, button: 'left', clickCount: 1 })
    win.webContents.sendInputEvent({ type: 'mouseUp', x: p.x, y: p.y, button: 'left', clickCount: 1 })
    await settle()
  }
  const key = async (keyCode: string, modifiers: Electron.KeyboardInputEvent['modifiers'] = []): Promise<void> => {
    if (!win.isFocused()) win.focus()
    // Do not refocus WebContents here: it would reset a focused child frame.
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers })
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers })
    await settle()
  }
  const evidence: Record<string, unknown> = {}
  const artifacts = process.env.GB_OVERLAY_PATHS_ARTIFACTS
  if (artifacts) await mkdir(artifacts, { recursive: true })
  const screenshot = async (name: string): Promise<void> => {
    if (artifacts) await writeFile(join(artifacts, name + '.png'), (await win.webContents.capturePage()).toPNG())
  }
  const server = createServer((_q, r) => { r.setHeader('Content-Type', 'text/html'); r.end('<h1>Native overlay page</h1>') })
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}/`
  const native = (): WebContentsView | undefined => win.contentView.children.find(v => v instanceof WebContentsView) as WebContentsView | undefined
  const waitNative = async (visible: boolean): Promise<void> => {
    for (let i = 0; i < 400; i++) {
      if (native()?.getVisible() === visible) return
      await new Promise(r => setTimeout(r, 25))
    }
    assert.equal(native()?.getVisible(), visible)
  }
  try {
    await win.loadURL(process.env.GB_MCP_URL!)
    await wait('!!document.querySelector(".message-html-preview")')
    for (const theme of ['light', 'dark']) {
      await js(`document.documentElement.dataset.theme='${theme}'`)
      await click('[aria-label="查看解析结果：review.pdf"]')
      await click('.document-result-image button')
      await wait('!!document.querySelector(".image-viewer-dialog")')
      assert(await js(`getComputedStyle(document.querySelector('.image-viewer-backdrop')).zIndex === getComputedStyle(document.querySelector('.document-parsing-diagnostic-backdrop')).zIndex && document.querySelector('.document-parsing-diagnostic-backdrop').inert`))
      const imageRect = await js<{ x: number; y: number }>(`(()=>{const r=document.querySelector('.image-viewer-dialog img').getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()`)
      const pixel = (await win.webContents.capturePage({ ...imageRect, width: 1, height: 1 })).toBitmap()
      assert(pixel[2]! > 240 && pixel[1]! < 10 && pixel[0]! < 10, 'Image pixels must paint above the inert parent')
      await screenshot(theme + '-nested-image')
      await key('Escape')
      await wait('!document.querySelector(".image-viewer-dialog") && !document.querySelector(".document-parsing-diagnostic-backdrop").inert')
      await wait('document.activeElement.matches(".document-result-image button")')
      await key('Escape')
      await wait('!document.querySelector(".document-parsing-diagnostic")')
    }
    evidence.image = true
    await click('.message-html-preview__actions button:last-child')
    await wait('!!document.querySelector(".html-preview-viewer")')
    assert(await js(`document.querySelector('.html-preview-viewer iframe').getAttribute('sandbox') === '' && document.querySelector('.html-preview-viewer iframe').srcdoc.includes("script-src 'none'")`))
    await key('Tab')
    await wait('document.activeElement.matches(".html-preview-viewer iframe")')
    assert(await js(`!document.querySelector('.html-preview-viewer iframe').srcdoc.includes('<script>') && !document.querySelector('.html-preview-viewer iframe').srcdoc.includes('https://example.invalid/leak')`))
    for (let i = 0; i < 6 && !await js('document.activeElement.matches(".html-preview-viewer__header button")'); i++) {
      await key('Tab')
    }
    await wait('document.activeElement.matches(".html-preview-viewer__header button")')
    await key('Tab', ['shift'])
    await wait('document.activeElement.matches(".html-preview-viewer iframe")')
    for (let i = 0; i < 6 && !await js('document.activeElement.matches(".html-preview-viewer__header button")'); i++) {
      await key('Tab', ['shift'])
    }
    await wait('document.activeElement.matches(".html-preview-viewer__header button")')
    await key('Tab')
    await wait('document.activeElement.matches(".html-preview-viewer iframe")')
    await key('Escape')
    await wait('!document.querySelector(".html-preview-viewer")')
    assert(await js('document.activeElement.matches(".message-html-preview__actions button:last-child")'))
    assert(await js('window.previewUnsafe !== true'))
    await click('.message-html-preview:has(iframe[srcdoc*="Plain keyboard preview"]) .message-html-preview__actions button:last-child')
    await wait('!!document.querySelector(".html-preview-viewer")')
    await key('Tab')
    await wait('document.activeElement.matches(".html-preview-viewer iframe")')
    await key('PageDown')
    await key('Escape')
    await wait('!document.querySelector(".html-preview-viewer")')
    evidence.iframe = true
    win.setContentSize(760, 700)
    await wait('document.querySelector(".sidebar").inert')
    await click('.sidebar-toggle')
    await click('.project-switcher .icon-button')
    await wait('!!document.querySelector(".project-create-card") && document.querySelector(".app-shell").inert')
    await key('Escape')
    await wait('!document.querySelector(".project-create-card")')
    assert(await js('!document.querySelector(".sidebar").inert && document.activeElement.matches(".project-switcher .icon-button")'))
    await key('Escape')
    await wait('document.querySelector(".sidebar").inert')
    evidence.project = true
    win.setContentSize(1280, 800)
    await click('.sidebar-toggle')
    await click('.message-citations summary')
    await click('.message-citations__actions button')
    await wait('!!document.querySelector(".knowledge-citation-dialog")')
    assert.equal(await js('getComputedStyle(document.querySelector(".knowledge-citation-dialog")).webkitAppRegion'), 'no-drag')
    if (process.platform === 'win32') {
      const koffi = createRequire(join(process.cwd(), 'package.json'))('koffi') as typeof import('koffi')
      const send = koffi.load('user32.dll').func('intptr_t __stdcall SendMessageW(void *hWnd, uint32_t Msg, uintptr_t wParam, intptr_t lParam)')
      const hwnd = koffi.decode(win.getNativeWindowHandle(), 'void *')
      await js('document.querySelector(".knowledge-citation-dialog").style.webkitAppRegion="initial"')
      const bounds = win.getBounds()
      const hit = (x: number): number => {
        const point = screen.dipToScreenPoint({ x: bounds.x + x, y: bounds.y + 12 })
        return Number(send(hwnd, 0x84, 0, (point.y << 16) | (point.x & 0xffff)))
      }
      let captionX: number | undefined
      for (let attempt = 0; attempt < 40 && captionX === undefined; attempt++) {
        for (let x = 20; x < 1200; x += 20) if (hit(x) === 2) { captionX = x; break }
        if (captionX === undefined) await new Promise(r => setTimeout(r, 25))
      }
      assert.notEqual(captionX, undefined, 'Control must exercise an actual native drag region')
      await js('document.querySelector(".knowledge-citation-dialog").style.removeProperty("-webkit-app-region")')
      for (let attempt = 0; attempt < 40 && hit(captionX!) !== 1; attempt++) await new Promise(r => setTimeout(r, 25))
      assert.equal(hit(captionX!), 1, 'Citation overlay must receive HTCLIENT, not HTCAPTION')
      evidence.nativeHit = 'HTCLIENT; negative control HTCAPTION'
    }
    await key('Escape')
    evidence.citation = true
    await click('.assistant-sidebar-toggle[aria-expanded=false]')
    await js('document.querySelector(".workbar-shell__tab[aria-selected=true]").focus()')
    await key('Right'); await key('Right')
    await wait('document.querySelector(".workbar-shell__tab[aria-selected=true]").textContent.startsWith("Browser")')
    await waitNative(true)
    await wait('!document.querySelector(".assistant-sidebar__browser-address input").disabled')
    await click('.assistant-sidebar__browser-address input')
    await key('A', ['control'])
    await win.webContents.insertText(origin)
    await click('.assistant-sidebar__browser-go')
    for (let i = 0; i < 400 && native()!.webContents.getURL() !== origin; i++) await new Promise(r => setTimeout(r, 25))
    await native()!.webContents.executeJavaScript('window.overlayToken="same-document"')
    const nativeId = native()!.webContents.id
    await js(`[...document.querySelectorAll('.primary-nav button')].find(e=>e.textContent.includes('Run history')).click()`)
    await wait('!!document.querySelector(".activity-panel .inline-help")')
    for (const width of [1600, 1000]) {
      win.setContentSize(width, 800)
      await wait(`innerWidth === ${width}`)
      if (width === 1000) {
        await wait('document.querySelector(".assistant-sidebar-toggle").getAttribute("aria-expanded") === "false"')
        await click('.assistant-sidebar-toggle')
        await waitNative(true)
      }
      await js('document.querySelector(".assistant-sidebar__resize-handle").focus()')
      await key(width === 1000 ? 'End' : 'Home')
      await wait(`(()=>{const e=document.querySelector('.assistant-sidebar');return Math.abs(e.getBoundingClientRect().width-parseFloat(e.style.getPropertyValue('--assistant-sidebar-width')))<=2})()`)
      await click('.activity-panel .inline-help')
      await wait('!!document.querySelector(".inline-help__content")')
      const overlaps = await js<boolean>(`(()=>{const a=document.querySelector('.inline-help__content').getBoundingClientRect(),b=document.querySelector('.assistant-sidebar__browser-viewport').getBoundingClientRect();return a.right>b.left&&a.left<b.right&&a.top<b.bottom&&a.bottom>b.top})()`)
      assert.equal(overlaps, width === 1000, 'Real help/viewport layout ' + JSON.stringify(await js(`['.inline-help__content','.assistant-sidebar__browser-viewport','.assistant-sidebar__resize-handle'].map(s=>{const e=document.querySelector(s);return [s,e.getBoundingClientRect().toJSON(),e.getAttribute('aria-valuenow')]})`)))
      await waitNative(!overlaps)
      await screenshot(width + '-browser-help')
      await key('Escape')
      await waitNative(true)
      assert.equal(native()!.webContents.id, nativeId)
      assert.equal(await native()!.webContents.executeJavaScript('window.overlayToken'), 'same-document')
    }
    evidence.tooltip = true
    evidence.modelAttempts = (globalThis as typeof globalThis & { overlayModelAttempts?: number }).overlayModelAttempts ?? 0
    assert.equal(evidence.modelAttempts, 0)
    await writeFile(join(directory, 'result.json'), JSON.stringify(evidence))
    if (artifacts) await writeFile(join(artifacts, 'result.json'), JSON.stringify(evidence, null, 2))
  } finally {
    await dispose()
    await browser.dispose()
    win.destroy()
    server.close()
    database.close()
  }
  app.exit(0)
}).catch(error => { console.error(error); app.exit(1) })

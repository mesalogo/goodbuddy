import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { readFile, mkdir, writeFile, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { app, BrowserWindow, WebContentsView, ipcMain, clipboard } from 'electron'
import { BrowserService } from '../src/main/browser/browser-service'
import { BrowserModelTools } from '../src/main/browser/browser-model-tools'
import { configureNativeBrowserAutomation } from '../src/main/browser/electron-playwright'
import { ipcChannels } from '../src/shared/ipc-channels'
import { browserSetViewportRequestSchema } from '../src/shared/contracts'
import { runRemoteBrowserProbe } from './managed-browser-remote-e2e'

const root = resolve('temp/managed-browser-ui')
const scale = process.env.GB_BROWSER_SCALE ?? '1'
app.setPath('userData', join(root, `profile-${scale}`))
app.commandLine.appendSwitch('force-device-scale-factor', scale)
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion')
configureNativeBrowserAutomation()

async function main(): Promise<void> {
  await app.whenReady()
  await mkdir(root, { recursive: true })
  const window = new BrowserWindow({ width: 1000, height: 740, show: true, webPreferences: { preload: join(root, 'preload.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } })
  window.webContents.on('console-message', (event) => { if (event.level === 'error') console.error('Renderer:', event.message) })
  const browser = new BrowserService({ parentWindow: window, downloadsDirectory: join(root, 'downloads') })
  const server = createServer(async (request, response) => {
    if (request.url === '/download') {
      response.setHeader('content-disposition', 'attachment; filename="result.txt"')
      response.end('download result')
      return
    }
    if (request.url === '/frame') { response.setHeader('content-type', 'text/html'); response.end('<label>Frame field<input></label>'); return }
    if (request.url?.startsWith('/target')) {
      response.setHeader('content-type', 'text/html; charset=utf-8')
      response.end('<!doctype html><html><body><label>姓名<input id="name"></label><input type="file" aria-label="文件"><button id="waiting" disabled onclick="document.body.dataset.late=\'yes\'">等待按钮</button><a target="_blank" href="/target?popup">新窗口</a><a href="/download">下载</a><iframe title="frame" src="/frame"></iframe><div style="height:1500px"></div><button onclick="document.body.dataset.clicked=\'yes\'">提交</button></body></html>')
      return
    }
    if (request.url === '/view.js') {
      response.setHeader('content-type', 'text/javascript')
      response.end(await readFile(join(root, 'view.js')))
      return
    }
    response.setHeader('content-type', 'text/html; charset=utf-8')
    response.end('<!doctype html><html><head><style>html,body,#root{height:100%;margin:0}#root,section{display:flex;flex-direction:column;flex:1;min-height:0}.assistant-sidebar__browser-viewport{flex:1;min-height:0}header{height:40px}</style></head><body><div id="root"></div><script src="/view.js"></script></body></html>')
  })
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  const address = server.address()
  assert(address && typeof address === 'object')
  const origin = `http://127.0.0.1:${address.port}`
  ipcMain.handle(ipcChannels.browserSetViewport, (event, input: unknown) => {
    assert.equal(event.sender.id, window.webContents.id)
    const request = browserSetViewportRequestSchema.parse(input)
    browser.setViewport(request.conversationId, request.bounds, request.tabId, request.leaseToken, event.sender.id)
  })
  const removeState = browser.onState((state) => { if (!window.isDestroyed()) window.webContents.send(ipcChannels.browserState, state) })
  const until = async (predicate: () => Promise<boolean> | boolean): Promise<void> => {
    const deadline = Date.now() + 15_000
    while (!await predicate()) {
      if (Date.now() > deadline) throw new Error('Browser validation condition timed out')
      await new Promise((done) => setTimeout(done, 25))
    }
  }
  try {
    const signal = AbortSignal.timeout(90_000)
    const tab = await browser.createTab('browser-ui-e2e', window.webContents.id, signal)
    const tools = new BrowserModelTools({ service: browser, conversationId: 'browser-ui-e2e', browserTabId: tab.tabId })
    await window.loadURL(`${origin}/?tab=${tab.tabId}`)
    window.focus(); window.webContents.focus()
    await browser.navigate('browser-ui-e2e', `${origin}/target`, signal, tab.tabId)
    const view = window.contentView.children.find((child) => child instanceof WebContentsView) as WebContentsView
    assert(view)
    try { await until(() => view.getVisible() && view.getBounds().width > 400) }
    catch (error) {
      console.error('Viewport', view.getVisible(), view.getBounds(), await window.webContents.executeJavaScript('({html:document.body.innerHTML,rect:document.querySelector(".assistant-sidebar__browser-viewport")?.getBoundingClientRect().toJSON()})'))
      throw error
    }
    assert.equal(await window.webContents.executeJavaScript('document.querySelectorAll("canvas,textarea,button").length'), 0)
    const ratio = await view.webContents.executeJavaScript('devicePixelRatio')
    assert(Math.abs(ratio - Number(scale)) < 0.02)
    const metrics = await view.webContents.executeJavaScript('({width:innerWidth,height:innerHeight})')
    assert.equal(metrics.width, view.getBounds().width)
    assert.equal(metrics.height, view.getBounds().height)
    assert.equal(view.webContents.getZoomFactor(), 1)
    const png = (await view.webContents.capturePage()).toPNG()
    const imageWidth = png.readUInt32BE(16)
    assert(imageWidth >= Math.floor(metrics.width * ratio) - 2)
    console.log('PASS native pixels and unchanged page scale', JSON.stringify({ scale: ratio, cssWidth: metrics.width, capturedPixels: imageWidth }))

    let snapshot = await browser.snapshot('browser-ui-e2e', signal, tab.tabId)
    const ref = (name: string): string => {
      const node = snapshot.nodes.find((item) => item.name === name)
      assert(node, `Missing ${name}: ${snapshot.tree}`)
      return node.ref
    }
    await tools.callTool('browser_type', { ref: ref('姓名'), text: '自动填写' }, signal)
    await tools.callTool('browser_action', { action: { kind: 'fill', ref: ref('Frame field'), text: 'iframe' } }, signal)
    assert.equal(await view.webContents.executeJavaScript('document.querySelector("#name").value'), '自动填写')
    await tools.callTool('browser_click', { ref: ref('提交') }, signal)
    assert.equal(await view.webContents.executeJavaScript('document.body.dataset.clicked'), 'yes')

    // Direct native input remains available without any control-mode transition.
    window.focus(); view.webContents.focus()
    await view.webContents.executeJavaScript('document.querySelector("#name").scrollIntoView(); document.querySelector("#name").focus(); document.querySelector("#name").select()')
    await view.webContents.debugger.sendCommand('Input.imeSetComposition', { text: '中文', selectionStart: 2, selectionEnd: 2 })
    await view.webContents.debugger.sendCommand('Input.insertText', { text: '中文' })
    await until(() => view.webContents.executeJavaScript('document.querySelector("#name").value === "中文"'))
    clipboard.writeText('粘贴')
    view.webContents.paste()
    await until(() => view.webContents.executeJavaScript('document.querySelector("#name").value === "中文粘贴"'))
    snapshot = await browser.snapshot('browser-ui-e2e', signal, tab.tabId)
    assert.match(snapshot.tree ?? '', /中文粘贴/u)
    await tools.callTool('browser_type', { ref: ref('姓名'), text: '' }, signal)
    assert.equal(await view.webContents.executeJavaScript('document.querySelector("#name").value'), '')
    console.log('PASS automatic Playwright operations, iframe, scrolling, direct IME and clipboard, AI continues without a mode switch')

    const cancel = new AbortController()
    const pending = tools.callTool('browser_click', { ref: ref('等待按钮') }, cancel.signal).then(() => { throw new Error('Cancelled click completed') }, (error: unknown) => error)
    await new Promise((done) => setTimeout(done, 100))
    cancel.abort(new Error('test cancellation'))
    await pending
    await view.webContents.executeJavaScript('document.querySelector("#waiting").disabled=false')
    await new Promise((done) => setTimeout(done, 200))
    assert.equal(await view.webContents.executeJavaScript('document.body.dataset.late'), undefined)

    const file = join(root, 'upload.txt')
    await writeFile(file, 'test upload')
    await tools.callTool('browser_action', { action: { kind: 'upload', ref: ref('文件'), paths: [file] } }, signal)
    assert.equal(await view.webContents.executeJavaScript('document.querySelector("input[type=file]").files.length'), 1)
    await tools.callTool('browser_click', { ref: ref('下载') }, signal)
    await until(async () => {
      const records = await browser.action('browser-ui-e2e', { kind: 'downloads' }, signal, tab.tabId) as Array<{ status: string }>
      return records.some((record) => record.status === 'completed')
    })
    const downloads = await browser.action('browser-ui-e2e', { kind: 'downloads' }, signal, tab.tabId) as Array<{ path: string }>
    assert.equal(await readFile(downloads[0]!.path, 'utf8'), 'download result')
    await tools.callTool('browser_click', { ref: ref('新窗口') }, signal)
    assert.equal(browser.listTabs('browser-ui-e2e').length, 2)
    assert.notEqual(tools.getBoundTabId(), tab.tabId)
    await browser.closeTab('browser-ui-e2e', tools.getBoundTabId())
    assert(!view.webContents.isDestroyed())
    console.log('PASS cancelled action has no late click; page file controls, native download, popup binding and sibling isolation')

    window.setContentSize(780, 600)
    await until(() => view.getBounds().width < metrics.width)
    assert.equal(await view.webContents.executeJavaScript('innerWidth'), view.getBounds().width)
    assert.equal(await view.webContents.executeJavaScript('devicePixelRatio'), ratio)
    if (process.env.GB_BROWSER_TEST_HOST && scale === '1') await runRemoteBrowserProbe(browser, tab.tabId, process.env.GB_BROWSER_TEST_HOST)
    console.log('PASS native resize, stable DPI, no stream canvas or added controls')
  } finally {
    removeState()
    await browser.dispose()
    window.destroy()
    await new Promise<void>((done) => server.close(() => done()))
    await rm(join(root, 'downloads'), { recursive: true, force: true })
  }
}
void main().then(() => app.exit(0), (error: unknown) => { console.error(error); app.exit(1) })

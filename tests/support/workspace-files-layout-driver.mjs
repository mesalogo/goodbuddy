import { app, BrowserWindow } from 'electron'
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import process from 'node:process'
import { setTimeout } from 'node:timers/promises'
import { setTimeout as startTimeout } from 'node:timers'

const directory = process.env.GB_LAYOUT_DIRECTORY
const artifacts = process.env.GB_LAYOUT_ARTIFACTS
app.setPath('userData', join(directory, 'profile'))
app.setPath('sessionData', join(directory, 'session'))
app.setAppLogsPath(join(directory, 'logs'))
app.commandLine.appendSwitch('force-device-scale-factor', '1')
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion')

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: true, width: 1280, height: 800, useContentSize: true,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } })
  const observations = [], errors = []
  let pending = 'startup'
  const environment = { platform: process.platform, arch: process.arch, electron: process.versions.electron, locale: 'en-US' }
  const report = async result => {
    const text = JSON.stringify({ ...result, environment, pending, observations, errors, modelCalls: 0 }, null, 2)
    await writeFile(join(directory, 'result.json'), text)
    if (artifacts) await writeFile(join(artifacts, 'result.json'), text)
  }
  startTimeout(async () => { await report({ passed: false, error: 'Driver timeout' }); app.exit(1) }, 80000)
  win.webContents.on('console-message', event => { if (event.level === 'error') errors.push(event.message) })
  win.webContents.on('render-process-gone', (_event, details) => errors.push(JSON.stringify(details)))
  const js = code => { pending = code; return win.webContents.executeJavaScript(code) }
  const wait = async code => {
    for (let i = 0; i < 240; i++) { if (await js(code)) return; await setTimeout(25) }
    throw new Error(`Timeout: ${code}\n${errors.join('\n')}`)
  }
  const settle = () => js('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
  const point = selector => js(`(() => {
    const e=document.querySelector(${JSON.stringify(selector)}),r=e.getBoundingClientRect();
    return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2),hit:e.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2))};
  })()`)
  const click = async selector => {
    win.focus(); win.webContents.focus()
    await wait('document.hasFocus()')
    const p = await point(selector)
    win.webContents.sendInputEvent({ type: 'mouseMove', x: p.x, y: p.y })
    await settle()
    assert((await point(selector)).hit, `Control occluded: ${selector}`)
    win.webContents.sendInputEvent({ type: 'mouseDown', x: p.x, y: p.y, button: 'left', clickCount: 1 })
    win.webContents.sendInputEvent({ type: 'mouseUp', x: p.x, y: p.y, button: 'left', clickCount: 1 })
    await settle()
  }
  const screenshot = async name => {
    if (artifacts) await writeFile(join(artifacts, `${name}.png`), (await win.webContents.capturePage()).toPNG())
  }
  const viewport = "document.querySelector('.workspace-files__files-view')"
  const geometry = () => js(`(() => {
    const rect=e=>{const r=e.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,bottom:r.bottom,right:r.right}};
    const v=${viewport},body=document.querySelector('.assistant-sidebar__body'),nav=document.querySelector('.workspace-files__navigation');
    const selectors=['.workspace-files__header','.workspace-files__actions','.workspace-files__breadcrumbs'];
    const controls=[...document.querySelectorAll('.workspace-files__header button,.workspace-files__actions button,.workspace-files__breadcrumbs button')];
    return {viewport:rect(v),scrollTop:v.scrollTop,scrollHeight:v.scrollHeight,clientHeight:v.clientHeight,overflow:getComputedStyle(v).overflowY,
      fixed:selectors.map(s=>{const e=document.querySelector(s);return e?rect(e):null}),
      controls:controls.map(e=>{const r=e.getBoundingClientRect();return {label:e.getAttribute('aria-label')||e.textContent,hit:e.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)),outside:!v.contains(e),...rect(e)}}),
      bodyScroll:body.scrollTop,bodyOverflow:body.scrollHeight-body.clientHeight,nav:rect(nav),
      horizontalOverflow:[document.documentElement,body,nav,v].map(e=>e.scrollWidth-e.clientWidth),
      innerWidth,innerHeight,scale:devicePixelRatio};
  })()`)
  const docked = (before, after) => {
    assert.deepEqual(after.fixed, before.fixed, 'Header/actions/breadcrumbs moved with files')
    assert(after.controls.every(c => c.hit && c.outside && c.height > 0), 'Docked controls must remain visible and hit-testable')
    assert.equal(after.bodyScroll, 0, 'Sidebar body must not scroll with files')
    assert(after.bodyOverflow <= 1, 'Files must not overflow the sidebar body')
    assert(after.horizontalOverflow.every(value => value <= 1), 'Unexpected horizontal overflow')
    assert(after.viewport.bottom <= after.nav.bottom + 1, 'Files viewport exceeds navigation bounds')
    assert(after.viewport.y >= Math.max(...after.fixed.filter(Boolean).map(r => r.bottom)) - 1, 'Controls overlap files viewport')
  }
  try {
    if (artifacts) await mkdir(artifacts, { recursive: true })
    for (const git of [false, true]) for (const theme of ['light', 'dark']) {
      for (const [width, height, sidebar] of [[1280, 800, 560], [960, 720, 420], [720, 640, 320], [640, 420, 300]]) {
        const name = `${git ? 'git' : 'non-git'}-${theme}-${width}x${height}`
        win.setContentSize(width, height)
        await win.loadURL(`${process.env.GB_LAYOUT_URL}?git=${git}&theme=${theme}&sidebar=${sidebar}`)
        await wait(`document.querySelectorAll('.workspace-files__row').length===121 && !!${viewport}`)
        await js('document.fonts.ready')
        await settle()
        assert.equal(await js('document.querySelectorAll(".workspace-files__view-switch button").length'), git ? 2 : 1)
        assert.equal(await js('document.querySelector(".workspace-files__view-switch button").textContent'), 'Files')
        assert.equal(await js('document.querySelector(".workspace-files__view-switch button").getAttribute("aria-pressed")'), 'true')
        const root = await geometry()
        assert.equal(root.innerWidth, width); assert.equal(root.innerHeight, height)
        assert(root.scrollHeight > root.clientHeight * 3 && root.clientHeight > 50, 'Long files list needs a bounded viewport')
        assert.equal(root.overflow, 'auto')
        docked(root, root)
        const p = await point('.workspace-files__files-view')
        win.webContents.sendInputEvent({ type: 'mouseWheel', x: p.x, y: p.y, deltaY: -240, deltaX: 0 })
        await wait(`${viewport}.scrollTop > 0`)
        // Native wheel scrolling finishes asynchronously in Chromium.
        await setTimeout(350)
        docked(root, await geometry())
        await js(`${viewport}.scrollTop=0`)
        await settle()
        await click('.workspace-files__entry .workspace-files__more')
        await wait('!!document.querySelector("[role=menuitem]")')
        await click('[role=menuitem]:first-child')
        await wait('document.querySelectorAll(".workspace-files__row").length===120 && !!document.querySelector(".workspace-files__breadcrumbs")')
        const before = await geometry()
        assert.equal(await js('document.querySelector(".workspace-files__breadcrumbs [aria-current=location]").textContent'), 'documents')
        await js(`${viewport}.scrollTop=${viewport}.scrollHeight`)
        await settle()
        const after = await geometry()
        assert(after.scrollTop > 0)
        docked(before, after)
        const last = '.workspace-files__entry:last-child .workspace-files__row'
        assert(await js(`(() => {const r=document.querySelector(${JSON.stringify(last)}).getBoundingClientRect(),v=${viewport}.getBoundingClientRect();return r.top>=v.top && r.bottom<=v.bottom+1})()`), 'Last file must be fully visible')
        assert.equal(await js(`document.querySelector(${JSON.stringify(last)}).title`), 'documents/file-120-workspace-notes.md')
        await screenshot(name)
        await click(last)
        await wait('!!document.querySelector("#return-to-files")')
        assert.equal(await js('getComputedStyle(document.querySelector(".workspace-files__navigation")).display'), 'none')
        await click('#return-to-files')
        await wait('!document.querySelector("#return-to-files")')
        assert.equal(await js(`${viewport}.scrollTop`), after.scrollTop, 'Preview return must retain files scroll')
        assert.equal(await js('document.querySelector(".workspace-files__row[aria-current=true]").title'), 'documents/file-120-workspace-notes.md')
        docked(before, await geometry())
        if (git) {
          await click('.workspace-files__view-switch button:last-child')
          assert.equal(await js(`getComputedStyle(${viewport}).display`), 'none')
          await click('.workspace-files__view-switch button:first-child')
          assert.equal(await js(`${viewport}.scrollTop`), after.scrollTop, 'Git view return must retain files scroll')
          docked(before, await geometry())
        }
        for (const index of [1, 2]) {
          await click(`.workspace-files__actions button:nth-child(${index})`)
          await wait('!!document.querySelector("[role=dialog]")')
          win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' })
          win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' })
          await wait('!document.querySelector("[role=dialog]")')
        }
        observations.push({ name, git, theme, sidebar, root, before, after, previewRetention: true, gitRetention: git, createDialogs: 2 })
      }
    }
    assert.deepEqual(errors, [])
    await report({ passed: true })
    app.exit(0)
  } catch (error) {
    await screenshot('failure')
    await report({ passed: false, error: String(error.stack) })
    app.exit(1)
  }
})

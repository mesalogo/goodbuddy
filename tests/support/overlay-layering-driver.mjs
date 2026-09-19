import { app, BrowserWindow } from 'electron'
import assert from 'node:assert/strict'
import { writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import process from 'node:process'
import console from 'node:console'
import { setTimeout } from 'node:timers'

const url = process.env.GOODBUDDY_OVERLAY_URL
const directory = process.env.GOODBUDDY_OVERLAY_DIRECTORY
app.setPath('userData', join(directory, 'profile'))
app.commandLine.appendSwitch('force-device-scale-factor', '1')
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: true, width: 1280, height: 800, useContentSize: true,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } })
  const errors = []
  win.webContents.on('console-message', event => { if (event.level === 'error') errors.push(event.message) })
  const js = code => win.webContents.executeJavaScript(code)
  const settle = () => js('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
  const wait = async code => {
    for (let i = 0; i < 1000; i++) {
      if (await js(code)) return
      await new Promise(resolve => setTimeout(resolve, 25))
    }
    throw new Error('Timeout: ' + code + '\n' + errors.join('\n'))
  }
  const key = async (keyCode, modifiers = []) => {
    win.focus(); win.webContents.focus()
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers })
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers })
    await settle()
  }
  const click = async selector => {
    const point = await js(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); e.scrollIntoView({block:'nearest'});
      const r = e.getBoundingClientRect(); const x = r.x + r.width/2, y = r.y + r.height/2;
      return { x: Math.round(x), y: Math.round(y), hit: e.contains(document.elementFromPoint(x, y)) }; })()`)
    assert(point.hit, 'Occluded: ' + selector)
    win.webContents.sendInputEvent({ type: 'mouseDown', x: point.x, y: point.y, button: 'left', clickCount: 1 })
    win.webContents.sendInputEvent({ type: 'mouseUp', x: point.x, y: point.y, button: 'left', clickCount: 1 })
    await settle()
  }
  const notify = async (tone = 'error') => {
    await js(`window.dispatchEvent(new CustomEvent('fixture-notify', { detail: ${JSON.stringify(tone)} }))`)
    await wait('!!document.querySelector(".app-notification")')
    await settle()
  }
  const artifacts = process.env.GOODBUDDY_OVERLAY_ARTIFACTS
  if (artifacts) await mkdir(artifacts, { recursive: true })
  const screenshot = async name => {
    if (artifacts) await writeFile(join(artifacts, name + '.png'), (await win.webContents.capturePage()).toPNG())
  }
  await win.loadURL(url)
  await wait('!!document.querySelector("#settings")')
  await js('document.fonts.ready')

  for (const theme of ['light', 'dark']) {
    await js(`window.dispatchEvent(new CustomEvent('fixture-theme', { detail: '${theme}' }))`)
    for (const [width, height] of [[1280, 800], [960, 720], [720, 640], [640, 420]]) {
      win.setContentSize(width, height); await settle()
      await notify()
      await click('#settings')
      await wait('!!document.querySelector("[aria-haspopup=menu][aria-expanded=false]")')
      assert(await js('document.querySelector(".settings-panel").contains(document.querySelector(".app-notification"))'))
      assert(await js('document.querySelector(".app-shell").inert'))
      const before = await js('document.activeElement.className')
      await notify('success')
      assert.equal(await js('document.activeElement.className'), before, 'Notification stole focus')
      await screenshot(`${theme}-${width}-notification`)
      await click('.app-notification--error button')
      await click('.app-notification--success button')
      assert(await js('!!document.activeElement.closest(".settings-panel")'), 'Dismissal lost modal focus')
      await click('[aria-haspopup=menu][aria-expanded=false]')
      await wait('!!document.querySelector("#document-test-menu")')
      assert(await js('document.querySelector(".settings-panel").contains(document.querySelector("#document-test-menu"))'))
      assert(await js('document.activeElement.matches("[role=menuitem]")'))
      await screenshot(`${theme}-${width}-menu`)
      await key('Escape')
      assert(await js('!document.querySelector("#document-test-menu") && !!document.querySelector(".settings-panel")'))
      assert(await js('document.activeElement.matches("[aria-haspopup=menu]")'))
      await key('Space')
      await wait('!!document.querySelector("#document-test-menu")')
      await click('#document-test-menu [role=menuitem]')
      await wait('!!document.querySelector(".document-parsing-diagnostic")')
      await notify()
      assert(await js('document.querySelector(".document-parsing-diagnostic").contains(document.querySelector(".app-notification"))'))
      assert(await js('document.querySelector(".settings-backdrop").inert'))
      await js('document.querySelector(".app-notification button").focus()')
      await key('Tab')
      assert(await js('document.activeElement.matches(".document-parsing-diagnostic header button")'))
      await key('Tab', ['shift'])
      assert(await js('document.activeElement.matches(".app-notification button")'))
      await key('Escape')
      assert(await js('!!document.querySelector(".document-parsing-diagnostic") && !document.activeElement.closest(".app-notification")'))
      await key('Escape')
      await wait('!document.querySelector(".document-parsing-diagnostic")')
      assert(await js('document.querySelector(".settings-panel").contains(document.querySelector(".app-notification"))'))
      await click('.app-notification button')
      await key('Escape')
      await wait('!document.querySelector(".settings-panel")')
      assert(await js('!document.querySelector(".app-shell").inert && document.activeElement.id === "settings"'))
    }
  }
  for (const id of ['applications', 'inference', 'native']) {
    await notify()
    await click('#' + id)
    await wait('!!document.querySelector("[aria-modal=true], dialog[open]")')
    await settle()
    assert(await js('!!document.querySelector(".app-notification").closest("[aria-modal=true], dialog[open]")'))
    await click('.app-notification button')
    if (id === 'native') await click('dialog[open] button')
    else await key('Escape')
    await wait('!document.querySelector("[aria-modal=true], dialog[open]")')
  }
  // A notification can outlive a modal; moving its host must not restart its timer.
  await notify('success')
  await click('#applications')
  await js('window.fixtureToast = document.querySelector(".app-notification")')
  await key('Escape')
  assert(await js('window.fixtureToast === document.querySelector(".app-notification") && document.querySelector(".floating-portal").parentElement === document.body'))
  await wait('!document.querySelector(".app-notification")')
  assert.deepEqual(errors, [])
  console.log('PASS: 8 theme/size scenarios; parsing menu and nested result; notification hit testing, native Tab/Shift+Tab/Escape; application center, inference, native dialog; persistent host and timeout')
  app.exit(0)
}).catch(error => { console.error(error); app.exit(1) })

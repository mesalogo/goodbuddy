import { app, BrowserWindow } from 'electron'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { mkdir, writeFile } from 'node:fs/promises'
import process from 'node:process'
import console from 'node:console'
import { setTimeout } from 'node:timers/promises'

app.setPath('userData', join(process.env.GOODBUDDY_HELP_DIRECTORY, 'profile'))
app.commandLine.appendSwitch('force-device-scale-factor', '1')
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: true, width: 1000, height: 700, useContentSize: true,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } })
  win.webContents.on('console-message', event => { if (event.level === 'error') console.error(event.message) })
  const js = async code => {
    try { return await win.webContents.executeJavaScript(code) }
    catch (error) { throw new Error('Renderer script: ' + code, { cause: error }) }
  }
  const settle = () => js('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
  const wait = async code => {
    for (let i = 0; i < 200; i++) {
      if (await js(code)) return
      await setTimeout(25)
    }
    throw new Error('Timeout: ' + code)
  }
  // scrollIntoView also scrolls overflow:hidden <details>, unlike a user's wheel.
  const reveal = async selector => {
    await js(`(() => { const e = document.querySelector(${JSON.stringify(selector)});
      for (let p = e.parentElement; p; p = p.parentElement) {
        if (!/(auto|scroll)/.test(getComputedStyle(p).overflowY)) continue;
        const r = e.getBoundingClientRect(), bounds = p.getBoundingClientRect();
        p.scrollTop += r.top + r.height/2 - bounds.top - p.clientHeight/2;
      } })()`)
    await settle()
  }
  const mouse = async (selector, click = false) => {
    await reveal(selector)
    const point = await js(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); const r = e.getBoundingClientRect();
      const x = Math.round(r.x + r.width / 2), y = Math.round(r.y + r.height / 2);
      const parents = []; for (let p = e; p && parents.length < 9; p = p.parentElement) {
        const b = p.getBoundingClientRect(); parents.push({ tag: p.tagName, class: p.className, inert: p.inert,
          top: b.top, height: b.height, scrollTop: p.scrollTop, overflow: getComputedStyle(p).overflow, pointer: getComputedStyle(p).pointerEvents }); }
      return { x, y, hit: e.contains(document.elementFromPoint(x,y)), target: document.elementFromPoint(x,y)?.outerHTML.slice(0, 250), parents }; })()`)
    assert(point.hit, 'Occluded: ' + selector + ' ' + JSON.stringify(point))
    win.webContents.sendInputEvent({ type: 'mouseMove', x: point.x, y: point.y })
    if (click) {
      win.webContents.sendInputEvent({ type: 'mouseDown', x: point.x, y: point.y, button: 'left', clickCount: 1 })
      win.webContents.sendInputEvent({ type: 'mouseUp', x: point.x, y: point.y, button: 'left', clickCount: 1 })
    }
    await settle()
  }
  const key = async keyCode => {
    win.focus()
    win.webContents.focus()
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode })
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode })
    await settle()
  }
  await win.loadURL(process.env.GOODBUDDY_HELP_URL)
  await wait('!!document.querySelector("#open")')
  win.focus()
  win.webContents.focus()
  await settle()
  for (const theme of ['light', 'dark']) {
    await js(`document.documentElement.dataset.theme = '${theme}'`)
    for (const [width, height] of [[1000, 700], [360, 320]]) {
      win.setContentSize(width, height)
      await settle()
      await mouse('#open', true)
      await wait('!!document.querySelector("#outside")')
      assert(await js('document.querySelector(".app-shell").inert'))
      await mouse('[aria-label="Page"]')
      await wait('!!document.querySelector("[role=tooltip]")')
      assert(await js('document.activeElement.id === "outside"'), 'Hover stole focus')
      assert(await js('document.querySelector("[aria-modal=true]").contains(document.querySelector("[role=tooltip]"))'))
      await mouse('[role=tooltip]')
      await setTimeout(160)
      assert(await js('!!document.querySelector("[role=tooltip]")'), 'Hover transfer closed help')
      await key('Escape')
      await wait('!document.querySelector("[role=tooltip]")')
      assert(await js('!!document.querySelector("[aria-modal=true]")'), `Hover Escape closed modal: ${theme} ${width}x${height}`)
      // Re-establish a native keyboard starting point after hover-only Escape.
      await mouse('#outside', true)
      assert(await js('document.activeElement.id === "outside"'))
      await key('Tab')
      await wait('!!document.querySelector("[role=tooltip]")')
      assert(await js('document.activeElement.matches(".inline-help")'))
      await key('Escape')
      await key('Space')
      await wait('!!document.querySelector("[role=tooltip]")')
      await key('Space')
      assert(await js('!document.querySelector("[role=tooltip]")'))
      await mouse('[aria-label="Long help"]', true)
      await wait('!!document.querySelector("#long-help[role=tooltip]")')
      win.webContents.sendInputEvent({ type: 'mouseMove', x: 5, y: 5 })
      await setTimeout(160)
      assert(await js('!!document.querySelector("#long-help[role=tooltip]")'), 'Click did not pin help')
      assert(await js(`(() => { const e = document.querySelector('#long-help'), r = e.getBoundingClientRect();
        return r.left >= 15 && r.top >= 15 && r.right <= innerWidth - 15 && r.bottom <= innerHeight - 15 && e.scrollWidth <= e.clientWidth; })()`), 'Help overflowed viewport')
      win.webContents.sendInputEvent({ type: 'mouseDown', x: 5, y: 5, button: 'left', clickCount: 1 })
      win.webContents.sendInputEvent({ type: 'mouseUp', x: 5, y: 5, button: 'left', clickCount: 1 })
      await settle()
      assert(await js('!document.querySelector("[role=tooltip]")'))
      await key('Escape')
      await wait('!document.querySelector("[aria-modal=true]")')
      assert(await js('document.activeElement.id === "open"'))
    }
  }
  console.log('InlineHelp: hover/focus/click/Escape/outside/modal/narrow bounds passed in light and dark themes')

  win.webContents.debugger.attach('1.3')
  const evidence = []
  const artifacts = process.env.GOODBUDDY_HELP_ARTIFACTS
  if (artifacts) await mkdir(artifacts, { recursive: true })
  let capturePrefix = ''
  let captureIndex = 0
  const snapshot = root => js(`(() => { const root = document.querySelector(${JSON.stringify(root)});
    return JSON.stringify({ fields: Array.from(root.querySelectorAll('input, select, textarea')).map(e => [e.id, e.value, e.checked]),
      details: Array.from(root.querySelectorAll('details')).map(e => e.open),
      tabs: Array.from(root.querySelectorAll('[aria-selected], [aria-pressed]')).map(e => [e.textContent, e.getAttribute('aria-selected'), e.getAttribute('aria-pressed')]) }); })()`)
  const description = async selector => {
    const expected = await js(`(() => { const e = document.querySelector(${JSON.stringify(selector)});
      const id = e.getAttribute('aria-describedby'); const targets = Array.from(document.querySelectorAll('[id]')).filter(e => e.id === id);
      if (targets.length !== 1) throw new Error('Missing or duplicate description: ' + id);
      return targets[0].textContent.replace(/\\s+/g, ' ').trim(); })()`)
    assert(expected.length > 0)
    const { root } = await win.webContents.debugger.sendCommand('DOM.getDocument')
    const { nodeId } = await win.webContents.debugger.sendCommand('DOM.querySelector', { nodeId: root.nodeId, selector })
    const { nodes } = await win.webContents.debugger.sendCommand('Accessibility.getPartialAXTree', { nodeId })
    assert.equal(nodes[0].description?.value, expected, 'Chromium accessibility description: ' + selector)
  }
  const checkHelp = async (selector, root, describedControl) => {
    await reveal(selector)
    if (describedControl) await description(describedControl)
    const before = await snapshot(root)
    const geometry = await js(`(() => { const button = document.querySelector(${JSON.stringify(selector)});
      const previous = button.previousSibling; const range = document.createRange(); range.selectNodeContents(previous);
      const label = range.getBoundingClientRect(), r = button.getBoundingClientRect();
      const style = getComputedStyle(button), svg = button.querySelector('svg'), icon = getComputedStyle(svg);
      return { label: button.getAttribute('aria-label'), sameLine: Math.min(label.bottom, r.bottom) > Math.max(label.top, r.top),
        appearance: Object.fromEntries(['width', 'height', 'padding', 'margin', 'color', 'backgroundColor', 'border', 'borderRadius'].map(key => [key, style[key]])),
        icon: { width: icon.width, height: icon.height, color: icon.color },
        gap: r.left - label.right, centerOffset: r.top + r.height / 2 - label.top - label.height / 2,
        afterLabel: r.left >= label.right - 1, nested: !!button.closest('label, summary, [role=tab]') || !!button.parentElement.closest('button') }; })()`)
    assert(geometry.sameLine && geometry.afterLabel, 'Help not beside label: ' + JSON.stringify(geometry))
    assert(!geometry.nested, 'Help nested in another control: ' + geometry.label)
    const focused = () => js('document.activeElement.tagName + ":" + document.activeElement.id + ":" + document.activeElement.getAttribute("aria-label")')
    const beforeHover = await focused()
    await mouse(selector)
    await wait('!!document.querySelector("[role=tooltip]")')
    assert.equal(await focused(), beforeHover, 'Consumer hover stole focus')
    await key('Escape')
    await wait('!document.querySelector("[role=tooltip]")')
    await js(`document.querySelector(${JSON.stringify(selector)}).focus()`)
    await wait('!!document.querySelector("[role=tooltip]")')
    await key('Escape')
    await wait('!document.querySelector("[role=tooltip]")')
    await mouse(selector, true)
    await wait('!!document.querySelector("[role=tooltip]")')
    assert(await js(`document.activeElement === document.querySelector(${JSON.stringify(selector)})`), 'Help click focused another input')
    const panel = await js(`(() => { const e = document.querySelector('[role=tooltip]'), r = e.getBoundingClientRect();
      const style = getComputedStyle(e);
      const hit = document.elementFromPoint(r.x + r.width/2, r.y + Math.min(r.height/2, 20));
      return { text: e.textContent, width: r.width, height: r.height, scrollHeight: e.scrollHeight, clientHeight: e.clientHeight,
        appearance: Object.fromEntries(['fontFamily', 'fontSize', 'fontWeight', 'lineHeight', 'color', 'backgroundColor', 'padding', 'border', 'borderRadius'].map(key => [key, style[key]])),
        inBounds: r.left >= 15 && r.top >= 15 && r.right <= innerWidth - 15 && r.bottom <= innerHeight - 15,
        wraps: e.scrollWidth <= e.clientWidth, hit: e.contains(hit), modal: !!e.closest('[aria-modal=true]') }; })()`)
    assert(panel.text.trim().length > 0 && panel.inBounds && panel.wraps && panel.hit, 'Unreadable help: ' + JSON.stringify(panel))
    if (root.includes('dialog') || root.includes('settings-panel') || root.includes('application-center')) assert(panel.modal)
    if (describedControl) await description(describedControl)
    assert.equal(await snapshot(root), before, 'Help click changed values, tabs or disclosure state')
    if (artifacts) await writeFile(join(artifacts, `${capturePrefix}-${++captureIndex}.png`), (await win.webContents.capturePage()).toPNG())
    await key('Escape')
    assert(await js(`!document.querySelector('[role=tooltip]') && !!document.querySelector(${JSON.stringify(root)})`), 'Escape closed consumer')
    assert.equal(await snapshot(root), before, 'Help dismissal changed consumer state')
    if (describedControl) await description(describedControl)
    win.webContents.sendInputEvent({ type: 'mouseMove', x: 5, y: 5 })
    await settle()
    return { ...geometry, panelAppearance: panel.appearance, characters: panel.text.length, width: panel.width, height: panel.height }
  }
  const profileId = '00000000-0000-4000-8000-000000000001'
  for (const theme of ['light', 'dark']) {
    await js(`document.documentElement.dataset.theme = '${theme}'`)
    for (const [width, height] of [[1280, 800], [640, 480]]) {
      capturePrefix = `${theme}-${width}x${height}`
      captureIndex = 0
      win.setContentSize(width, height)
      await settle()
      const checked = []
      await mouse('#applications', true)
      await wait('!!document.querySelector("#application-center")')
      await mouse('[aria-label="魔法笔记 应用设置"]', true)
      await wait('!!document.querySelector("#magic-note-canvas-page-count")')
      assert.equal(await js('document.querySelector("#magic-note-canvas-page-count").value'), '3')
      checked.push(await checkHelp('.inline-help[aria-label="常驻左侧菜单"]', '#application-center', '[aria-describedby="application-pin-help"][role=switch]'))
      checked.push(await checkHelp('.inline-help[aria-label="发送画布页数"]', '#application-center', '#magic-note-canvas-page-count'))
      await key('Escape')
      await wait('!document.querySelector("#application-center")')

      await mouse('#settings', true)
      const context = '#model-context-window-' + profileId
      await wait(`!!document.querySelector('${context}')`)
      assert.equal(await js(`document.querySelector('${context}').value`), '128')
      checked.push(await checkHelp('.inline-help[aria-label="上下文上限（可选）"]', '.settings-panel', context))
      assert(await js('!document.querySelector(".model-connection-detail details.settings-section").open'), 'Advanced model settings should start collapsed')
      await mouse('.model-connection-detail details.settings-section > summary', true)
      await wait('document.querySelector(".model-connection-detail details.settings-section").open')
      checked.push(await checkHelp('.inline-help[aria-label="自定义请求体"]', '.settings-panel', '#model-request-body-' + profileId))
      for (const applicationHelp of checked.slice(0, 2)) {
        assert.deepEqual(applicationHelp.appearance, checked[2].appearance, 'Application/settings help button styles differ')
        assert.deepEqual(applicationHelp.icon, checked[2].icon, 'Application/settings help icons differ')
        assert.deepEqual(applicationHelp.panelAppearance, checked[2].panelAppearance, 'Application/settings tooltip styles differ')
        assert.equal(applicationHelp.gap, checked[2].gap, 'Application/settings label gaps differ')
        assert.equal(applicationHelp.centerOffset, checked[2].centerOffset, 'Application/settings label alignment differs')
      }
      await key('Escape')
      await wait('!document.querySelector(".settings-panel")')

      await mouse('#retrieval', true)
      await wait('!!document.querySelector(".knowledge-retrieval-workbench")')
      const queryHelp = '.knowledge-workbench-section__heading .inline-help'
      checked.push(await checkHelp(queryHelp, '.knowledge-retrieval-workbench'))
      const disclosureHeight = await js('document.querySelector(".knowledge-workbench-settings").getBoundingClientRect().height')
      await js('document.querySelector(".knowledge-workbench-settings > summary").focus({preventScroll: true})')
      await key('Space')
      assert(await js('document.querySelector(".knowledge-workbench-settings").open'))
      checked.push(await checkHelp(queryHelp, '.knowledge-retrieval-workbench'))
      assert.equal(await js('document.querySelector(".knowledge-retrieval-workbench textarea").value'), 'Preserve this query')
      await key('Escape')
      await wait('!document.querySelector(".knowledge-retrieval-workbench")')

      await mouse('#activity', true)
      await wait('!!document.querySelector(".page-header .inline-help")')
      checked.push(await checkHelp('.page-header .inline-help', 'main'))
      await mouse('#home', true)
      evidence.push({ theme, viewport: `${width}x${height}`, retrievalDisclosureHeight: disclosureHeight, checked })
    }
  }
  assert.equal(await js('document.documentElement.dataset.fixtureActions ?? "[]"'), '[]', 'Help triggered a consumer operation')
  console.log('InlineHelp consumer evidence: ' + JSON.stringify(evidence))
  console.log('InlineHelp consumer actions: 0; model calls: 0; Chromium AX descriptions passed closed/open/closed')
  if (artifacts) await writeFile(join(artifacts, 'evidence.json'), JSON.stringify({ evidence, consumerActions: 0, modelCalls: 0 }, null, 2))
  win.destroy()
  app.exit(0)
}).catch(error => { console.error(error); app.exit(1) })

import { app, BrowserWindow } from 'electron'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import process from 'node:process'
import console from 'node:console'

app.setPath('userData', join(process.env.GB_EXPANSION_DIRECTORY, 'profile'))
app.commandLine.appendSwitch('force-device-scale-factor', '1')
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: true, width: 1280, height: 800, useContentSize: true,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } })
  const errors = []
  win.webContents.on('console-message', event => {
    if (event.level === 'error') { errors.push(event.message); console.error('RendererError', event.message) }
  })
  const evaluate = source => win.webContents.executeJavaScript(source)
  const started = Date.now()
  const mark = phase => {
    console.log('MessageExpansionPhase ' + JSON.stringify({ phase, elapsedMs: Date.now() - started }))
  }
  const waitFor = source => evaluate(`new Promise((resolve, reject) => {
    let frame;
    const timeout = setTimeout(() => { cancelAnimationFrame(frame); reject(new Error(${JSON.stringify(source)})); }, 10000);
    const check = () => {
      try {
        if (${source}) { clearTimeout(timeout); resolve(true); }
        else frame = requestAnimationFrame(check);
      } catch (error) { clearTimeout(timeout); reject(error); }
    }; check(); })`)
  const frames = () => evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))')
  const click = async selector => {
    await evaluate(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:'center'})`)
    await frames()
    const point = await evaluate(`(() => { const e = document.querySelector(${JSON.stringify(selector)}), r = e.getBoundingClientRect();
      const x = r.x + r.width / 2, y = r.y + r.height / 2;
      if (!e.contains(document.elementFromPoint(x,y))) throw new Error('Obscured ' + ${JSON.stringify(selector)});
      return {x: Math.round(x), y: Math.round(y)}; })()`)
    win.webContents.sendInputEvent({ type: 'mouseDown', ...point, button: 'left', clickCount: 1 })
    win.webContents.sendInputEvent({ type: 'mouseUp', ...point, button: 'left', clickCount: 1 })
  }
  for (const count of process.env.GB_EXPANSION_SUPERVISOR_ONLY ? [] : [2000, 10000]) {
    mark(`history-${count}-load`)
    await win.loadURL(process.env.GB_EXPANSION_URL + '?count=' + count)
    win.focus()
    win.webContents.focus()
    await waitFor('document.hasFocus() && document.querySelector("[data-message-id=m0] details")')
    await evaluate('document.fonts.ready.then(() => true)')
    mark(`history-${count}-sweep`)
    const untouched = await evaluate(`(async () => {
      const start = performance.now(), visited = new Set(); let maxRows = 0;
      for (let index = 0; index < ${count}; index += Math.floor(${count} / 200)) {
        window.expansionNavigate(index);
        await new Promise((resolve, reject) => {
          const deadline = performance.now() + 5000;
          const check = () => {
            const row = document.querySelector('[data-message-id=m' + index + ']');
            if (row?.contains(document.activeElement) && document.activeElement.matches('article')) resolve();
            else if (performance.now() > deadline) reject(new Error('Sweep navigation timeout'));
            else requestAnimationFrame(check);
          }; requestAnimationFrame(check);
        });
        const rows = [...document.querySelectorAll('.message-window-row')];
        maxRows = Math.max(maxRows, rows.length); rows.forEach(row => visited.add(row.dataset.messageId));
      }
      return { visited: visited.size, entries: window.expansionEntryCount(), elapsedMs: performance.now() - start, maxRows };
    })()`)
    assert.ok(untouched.visited >= 1000, JSON.stringify(untouched))
    assert.ok(untouched.maxRows <= 70, JSON.stringify(untouched))
    if (process.env.GB_EXPANSION_DENSE_SOURCE) assert.ok(untouched.entries >= untouched.visited, JSON.stringify(untouched))
    else if (!process.env.GB_HISTORY_SOURCE) assert.equal(untouched.entries, 0)
    const times = []
    mark(`history-${count}-disclosures`)
    let maxRows = 0
    let maxNodes = 0
    const visit = async index => {
      const elapsed = await evaluate(`new Promise((resolve, reject) => {
        const start = performance.now(); window.expansionNavigate(${index});
        const check = () => {
          const row = document.querySelector('[data-message-id=m${index}]');
          if (row?.contains(document.activeElement) && document.activeElement.matches('article')) {
            requestAnimationFrame(() => requestAnimationFrame(() => resolve(performance.now() - start)));
          } else if (performance.now() - start > 10000) reject(new Error('Navigation timeout ${index}'));
          else requestAnimationFrame(check);
        }; requestAnimationFrame(check);
      })`)
      times.push(elapsed)
      const size = await evaluate('({rows:document.querySelectorAll(".message-window-row").length,nodes:document.querySelectorAll("*").length})')
      maxRows = Math.max(maxRows, size.rows)
      maxNodes = Math.max(maxNodes, size.nodes)
      assert.ok(size.rows <= 70, JSON.stringify(size))
    }
    for (let n = 0; n < 13; n++) {
      const index = n * Math.floor(count / 15)
      await visit(index)
      const row = `[data-message-id=m${index}]`
      await click(row + ' .tool-execution > summary')
      await waitFor(`document.querySelector('${row} .tool-execution').open`)
      await click(row + ' .tool-execution__input > summary')
      await waitFor(`document.querySelector('${row} .tool-execution__input').open`)
      await click(row + ' .message-reasoning > summary')
      await waitFor(`document.querySelector('${row} .message-reasoning').open`)
    }
    assert.equal(await evaluate('!!document.querySelector("[data-message-id=m0]")'), false, 'original row must actually unmount')
    await visit(0)
    const restored = await evaluate('[...document.querySelectorAll("[data-message-id=m0] details")].map(e=>e.open)')
    assert.deepEqual(restored, process.env.GB_HISTORY_SOURCE ? [false, false, false] : [true, true, true])
    // Native keyboard toggling still closes a restored disclosure.
    const summary = '[data-message-id=m0] .message-reasoning > summary'
    await evaluate(`document.querySelector('${summary}').focus()`)
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Space' })
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Space' })
    await waitFor(`document.querySelector('[data-message-id=m0] .message-reasoning').open === ${Boolean(process.env.GB_HISTORY_SOURCE)}`)
    assert.equal(await evaluate('document.querySelector("textarea").value'), 'Preserved draft')
    if (!process.env.GB_EXPANSION_DENSE_SOURCE && !process.env.GB_HISTORY_SOURCE) await waitFor('window.expansionEntryCount() === 38')
    const changedEntries = await evaluate('window.expansionEntryCount()')
    await evaluate('window.expansionDeleteMessages()')
    await waitFor('document.querySelectorAll(".message-window-row").length === 0')
    await frames()
    if (!process.env.GB_EXPANSION_DENSE_SOURCE && !process.env.GB_HISTORY_SOURCE) await waitFor('window.expansionEntryCount() === 0')
    const afterDeletion = await evaluate('window.expansionEntryCount()')
    if (!process.env.GB_EXPANSION_DENSE_SOURCE && !process.env.GB_HISTORY_SOURCE) assert.equal(afterDeletion, 0)
    times.sort((a,b)=>a-b)
    console.log('MessageExpansion ' + JSON.stringify({ version: process.env.GB_HISTORY_SOURCE ? 'baseline' : process.env.GB_EXPANSION_DENSE_SOURCE ? 'dense' : 'sparse', count,
      samples: times.length, navigationTwoFramesP95Ms: times[Math.ceil(times.length * .95)-1],
      navigationTwoFramesMedianMs: times[Math.floor(times.length/2)], maxRows, maxNodes, restored, untouched, changedEntries, afterDeletion,
      electron: process.versions.electron, platform: process.platform, arch: process.arch }))
  }
  mark('supervisor-load')
  await win.loadURL(process.env.GB_EXPANSION_URL + '?supervisor=1')
  mark('supervisor-source-ready')
  await waitFor('document.querySelector(".supervisor-workspace__detail .link-button")')
  await click('.supervisor-workspace__detail .link-button')
  await waitFor('typeof window.finishSource === "function"')
  await click('#change-language')
  mark('supervisor-language-refresh')
  await waitFor('document.documentElement.lang === "en-US" && document.querySelector(".supervisor-workspace__detail .link-button")?.textContent.includes("Synthetic source 2")')
  await evaluate('window.finishSource()')
  await frames()
  const stuck = await evaluate('document.querySelector(".supervisor-workspace__detail .link-button").disabled')
  assert.equal(stuck, Boolean(process.env.GB_HISTORY_SOURCE))
  assert.equal(await evaluate('document.body.innerText.includes("Stale content")'), false)
  console.log('MessageExpansion ' + JSON.stringify({ scenario: 'supervisor-invalidation', version: process.env.GB_HISTORY_SOURCE ? 'baseline' : 'fixed', stuck }))
  assert.deepEqual(errors, [])
  mark('complete')
  win.destroy()
  app.quit()
}).catch(error => { console.error(error); app.exit(1) })

import { app, BrowserWindow } from 'electron'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'
import console from 'node:console'
import { setTimeout as wait } from 'node:timers/promises'
const evidence = process.env.CHECKLIST_VISUAL_EVIDENCE
const results = []
let window
const evaluate = script => window.webContents.executeJavaScript(script, true)
const click = selector => evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`)
const check = async (name, script) => {
  const passed = await evaluate(script)
  results.push({ name, passed })
  console.log(name, passed ? 'PASS' : 'FAIL')
}
async function key(keyCode, modifiers = []) {
  if (keyCode === 'Enter') keyCode = 'Return'
  window.focus()
  window.webContents.focus()
  window.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers })
  if (keyCode === 'Return') window.webContents.sendInputEvent({ type: 'char', keyCode: '\r', modifiers })
  window.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers })
  await wait(100)
}
async function capture(name) {
  await wait(150)
  const measurements = await evaluate(`(() => {
    const rect = selector => { const e = document.querySelector(selector); if (!e) return null; const r = e.getBoundingClientRect(); return { x:r.x,y:r.y,width:r.width,height:r.height,right:r.right,bottom:r.bottom,clientHeight:e.clientHeight,scrollHeight:e.scrollHeight,clientWidth:e.clientWidth,scrollWidth:e.scrollWidth } };
    return { viewport: {width:innerWidth,height:innerHeight,dpr:devicePixelRatio}, body:rect('body'), top:rect('.conversation-context-strips'), task:rect('.conversation-task-strip__toggle'), checklist:rect('.runtime-checklist__toggle'), list:rect('.runtime-checklist__content'), chat:rect('.chat'), input:rect('input'), focus:document.activeElement?.className };
  })()`)
  const image = await window.webContents.capturePage()
  writeFileSync(join(evidence, `${name}.png`), image.toPNG())
  results.push({ name, ...measurements })
  results.push({ name: `${name}-layout`, passed: measurements.body.scrollWidth <= measurements.body.clientWidth + 1 && measurements.input.bottom <= measurements.viewport.height + 1 && measurements.chat.height > 40 && (!measurements.checklist || measurements.checklist.bottom <= measurements.top.bottom + 1) && (!measurements.task || measurements.task.y >= measurements.top.y - 1) })
  console.log(name, JSON.stringify(measurements))
}
app.whenReady().then(async () => {
  mkdirSync(evidence, { recursive: true })
  window = new BrowserWindow({ width: 1440, height: 1000, useContentSize: true, show: true, autoHideMenuBar: true, webPreferences: { contextIsolation: true, sandbox: true } })
  window.webContents.on('console-message', event => console.log('renderer:', event.message))
  await window.loadURL(process.env.CHECKLIST_VISUAL_URL)
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await evaluate('Boolean(window.checklistHarness)')) break
    await wait(100)
  }
  if (process.env.CHECKLIST_VISUAL_BASELINE === '1') {
    await evaluate('document.fonts.ready.then(() => true)')
    await click('.runtime-checklist__toggle')
    for (const [name, width, height, zoom] of [
      ['wide-100', 1440, 1000, 1], ['narrow-100', 760, 800, 1],
      ['wide-200', 1440, 1000, 2], ['narrow-200', 760, 800, 2]
    ]) {
      window.setContentSize(width, height)
      window.focus()
      await wait(300)
      window.webContents.setZoomFactor(zoom)
      await window.webContents.capturePage()
      let viewportReady = false
      for (let attempt = 0; attempt < 40; attempt++) {
        await wait(100)
        viewportReady = await evaluate(`Math.abs(innerWidth - ${width / zoom}) < 3 && Math.abs(innerHeight - ${height / zoom}) < 3`)
        if (viewportReady) break
      }
      if (!viewportReady) throw new Error(`Viewport did not settle for ${name}: ${JSON.stringify(await evaluate('({width:innerWidth,height:innerHeight,dpr:devicePixelRatio})'))}; native=${window.getContentSize()}; zoom=${window.webContents.getZoomFactor()}`)
      for (const index of [0, 1, 3, 4]) {
        await evaluate(`document.querySelectorAll('.runtime-checklist__content li')[${index}].scrollIntoView({block:'start'})`)
        await wait(100)
        const measured = await evaluate(`(() => {
          const item = document.querySelectorAll('.runtime-checklist__content li')[${index}];
          const label = item.querySelector('.runtime-checklist__status > span');
          const text = item.querySelector('.runtime-checklist__text');
          const range = document.createRange();
          const rect = r => ({top:r.top,bottom:r.bottom,height:r.height,left:r.left,right:r.right});
          range.selectNodeContents(label);
          const labelText = rect(range.getClientRects()[0]);
          range.selectNodeContents(text);
          const lines = Array.from(range.getClientRects()).filter(r => r.width > 0);
          const firstLine = rect(lines[0]);
          const labelSpan = rect(label.getBoundingClientRect());
          return {status:label.textContent, content:text.textContent, viewport:{width:innerWidth,height:innerHeight,dpr:devicePixelRatio},
            lineCount:new Set(lines.map(r => r.top)).size, labelSpan, labelText, firstLine,
            spanTopDelta:labelSpan.top-firstLine.top,spanBottomDelta:labelSpan.bottom-firstLine.bottom,
            textTopDelta:labelText.top-firstLine.top,textBottomDelta:labelText.bottom-firstLine.bottom};
        })()`)
        const passed = [measured.textTopDelta, measured.textBottomDelta, measured.spanTopDelta, measured.spanBottomDelta]
          .every(delta => Math.abs(delta) < 0.1)
        results.push({ name, index, zoom, passed, ...measured })
        console.log('baseline', JSON.stringify({ name, index, passed, ...measured, content: undefined }))
        if (index === 0 || index === 3) {
          writeFileSync(join(evidence, `${name}-item-${index + 1}.png`), (await window.webContents.capturePage()).toPNG())
        }
      }
    }
    writeFileSync(join(evidence, 'baseline-results.json'), JSON.stringify({ environment: {
      platform:process.platform,electron:process.versions.electron,chrome:process.versions.chrome,
      path:'production renderer components in Electron harness; not full desktop IPC',units:'CSS pixels'
    }, results }, null, 2))
    app.exit(results.some(result => !result.passed) ? 1 : 0)
    return
  }
  await capture('01-wide-collapsed')
  await click('.conversation-task-strip__toggle')
  await click('.runtime-checklist__toggle')
  await capture('02-wide-both-expanded')
  await evaluate("document.querySelector('.runtime-checklist__toggle').focus()")
  await key('Space')
  await check('space-collapses-only-checklist', "document.querySelector('.runtime-checklist__toggle').getAttribute('aria-expanded') === 'false' && document.querySelector('.conversation-task-strip__toggle').getAttribute('aria-expanded') === 'true'")
  await key('Enter')
  await check('enter-expands-checklist-keeps-focus', "document.querySelector('.runtime-checklist__toggle').getAttribute('aria-expanded') === 'true' && document.activeElement.matches('.runtime-checklist__toggle')")
  await evaluate("document.querySelector('input').focus(); window.checklistHarness.update()")
  results.push({ name: 'update-keeps-input-focus', passed: await evaluate("document.activeElement === document.querySelector('input')") })
  await evaluate("document.querySelector('.runtime-checklist__content').scrollTop = 100000")
  await capture('03-long-list-end')
  window.webContents.setZoomFactor(2)
  await capture('03b-wide-200-percent')
  window.webContents.setZoomFactor(1)
  window.setContentSize(760, 800)
  await capture('04-narrow-both-expanded')
  window.webContents.setZoomFactor(2)
  await capture('05-narrow-200-percent')
  await evaluate("document.querySelector('.runtime-checklist__toggle').focus()")
  await key('Tab')
  await check('tab-reaches-checklist-scroll-region', "document.activeElement.matches('.runtime-checklist__content')")
  await key('End', ['control'])
  await wait(300)
  await check('keyboard-reaches-last-item-at-200-percent', "(() => {const list=document.querySelector('.runtime-checklist__content'); const last=list.querySelector('li:last-child').getBoundingClientRect(); const r=list.getBoundingClientRect(); return document.activeElement === list && last.bottom <= r.bottom + 1 && last.bottom > r.top;})()")
  await evaluate("document.querySelector('.conversation-task-details__actions button').focus()")
  await key('Enter')
  await check('task-run-action-at-200-percent', 'window.checklistHarness.runs === 1')
  await capture('05b-narrow-keyboard-task-action')
  await evaluate("window.checklistHarness.theme('dark')")
  await check('dark-theme-applied-to-root', "document.documentElement.dataset.theme === 'dark' && getComputedStyle(document.documentElement).getPropertyValue('--surface-raised').trim() !== '#ffffff'")
  await capture('06-dark-narrow-200-percent')
  window.webContents.setZoomFactor(1)
  window.setContentSize(1440, 1000)
  await evaluate("window.checklistHarness.scenario('next')")
  results.push({ name: 'new-request-hides-old-checklist', passed: await evaluate("!document.querySelector('.runtime-checklist')") })
  await capture('07-new-request')
  await evaluate("window.checklistHarness.scenario('stale')")
  await check('stale-terminal-request-does-not-revive-old-checklist', "!document.querySelector('.runtime-checklist')")
  await evaluate("window.checklistHarness.scenario('cleared')")
  results.push({ name: 'empty-hides-old-checklist', passed: await evaluate("!document.querySelector('.runtime-checklist')") })
  await evaluate("window.checklistHarness.scenario('history')")
  await click('.runtime-checklist__toggle')
  await capture('08-cancelled-history')
  await evaluate("window.checklistHarness.scenario('remote')")
  await capture('09-remote-without-task')
  writeFileSync(join(evidence, 'results.json'), JSON.stringify({ environment: { platform:process.platform, electron:process.versions.electron, chrome:process.versions.chrome, node:process.versions.node, path:'component harness, not full desktop IPC path', sandbox:true, contextIsolation:true, gpu:'default', checklistItems:80 }, results }, null, 2))
  app.exit(results.some(result => result.passed === false) ? 1 : 0)
}).catch(error => { console.error(error); app.exit(1) })

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
  let documentLoads = 0
  win.webContents.on('did-finish-load', () => { documentLoads++ })
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
    const state = await win.webContents.executeJavaScript(`({
      scenario: document.querySelector('[data-files-scenario]')?.dataset.filesScenario, readyState: document.readyState,
      visibility: document.visibilityState, focused: document.hasFocus(),
      width: innerWidth, height: innerHeight,
      rootChildren: document.querySelector('#root')?.childElementCount,
      rows: document.querySelectorAll('.workspace-files__row').length,
      text: document.querySelector('#root')?.textContent?.slice(0, 1000)
    })`)
    throw new Error(`Timeout: ${code}; ${JSON.stringify(state)}\n${errors.join('\n')}`)
  }
  const settle = () => js('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
  const point = selector => js(`(() => {
    const e=document.querySelector(${JSON.stringify(selector)}),r=e.getBoundingClientRect();
    return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2),hit:e.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2))};
  })()`)
  const click = async selector => {
    win.focus(); win.webContents.focus()
    await wait('document.hasFocus()')
    await js(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:'nearest',inline:'nearest'})`)
    await settle()
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
     assert(after.horizontalOverflow.slice(0, 3).every(value => value <= 1), 'Files must scroll inside their viewport without widening the sidebar')
    assert(after.viewport.bottom <= after.nav.bottom + 1, 'Files viewport exceeds navigation bounds')
    assert(after.viewport.y >= Math.max(...after.fixed.filter(Boolean).map(r => r.bottom)) - 1, 'Controls overlap files viewport')
  }
  try {
    if (artifacts) await mkdir(artifacts, { recursive: true })
    await win.loadURL(process.env.GB_LAYOUT_URL)
    await wait(`typeof window.showFilesLayout === 'function'`)
    for (const git of [false, true]) for (const theme of ['light', 'dark']) {
      for (const [width, height, sidebar] of [[1280, 800, 560], [960, 720, 420], [720, 640, 320], [640, 420, 300]]) {
        const name = `${git ? 'git' : 'non-git'}-${theme}-${width}x${height}`
        win.setContentSize(width, height)
        win.show(); win.focus(); win.webContents.focus()
        await wait(`document.hasFocus() && innerWidth === ${width} && innerHeight === ${height}`)
        await js(`window.showFilesLayout(${JSON.stringify({ name, git, theme, sidebar })})`)
        // Wait for rows in the new panel, not rows left over from the preceding scenario.
        await wait(`!!document.querySelector('[data-files-scenario="${name}"] .workspace-files__files-view .workspace-files__row')`)
        await settle()
        assert(await js(`document.querySelectorAll('.workspace-files__row').length<121`), 'Long files tree must be windowed')
        await wait(`Array.from(document.querySelectorAll('.workspace-files__row .workspace-file-icon img')).every(img => img.complete && img.naturalWidth > 0)`)
        assert(await js(`Array.from(document.querySelectorAll('.workspace-files__row')).every(row => {
          const icons = Array.from(row.querySelectorAll('.workspace-file-icon img')).filter(img => getComputedStyle(img).display !== 'none');
          return icons.length === 1 && icons[0].getBoundingClientRect().width === 16 && icons[0].getBoundingClientRect().height === 16;
        })`), 'Each file row needs one loaded 16px icon in either theme')
        assert(await js(`(() => {
          const row = document.querySelector('.workspace-files__row[title$=".toml"]');
          const icon = Array.from(row.querySelectorAll('img')).find(img => getComputedStyle(img).display !== 'none');
          return icon.src.includes(${JSON.stringify(theme === 'light' ? '/toml_light.svg' : '/toml.svg')});
        })()`), 'File icons must follow the selected application theme')
        await js('document.fonts.ready')
        await settle()
        assert.equal(await js('document.querySelectorAll(".workspace-files__view-switch button").length'), git ? 2 : 1)
        assert.equal(await js('document.querySelector(".workspace-files__view-switch button").textContent'), 'Files')
        assert.equal(await js('document.querySelector(".workspace-files__view-switch [role=tab]").getAttribute("aria-selected")'), 'true')
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
        await wait('!!document.querySelector(".workspace-files__breadcrumbs [aria-current=location]") && document.querySelectorAll(".workspace-files__row").length>0')
        const before = await geometry()
        assert.equal(await js('document.querySelector(".workspace-files__breadcrumbs [aria-current=location]").textContent'), 'documents')
        const last = '.workspace-files__entry:last-child .workspace-files__row'
        // Scrolling to the end re-windows; the measured row heights may grow the
        // list, so keep scrolling until the last file is mounted at the bottom.
        for (let i = 0; i < 10; i++) {
          await js(`${viewport}.scrollTop=${viewport}.scrollHeight`)
          await settle()
          if (await js(`document.querySelector(${JSON.stringify(last)})?.title==='documents/file-120-workspace-notes.md' && Math.abs(${viewport}.scrollHeight-${viewport}.clientHeight-${viewport}.scrollTop)<=1`)) break
        }
        const after = await geometry()
        assert(after.scrollTop > 0)
        docked(before, after)
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
          const motion = await js(`(async () => {
            const root = document.querySelector('.workspace-files__view-switch .page-tabs');
            const indicator = root.querySelector('.segmented-indicator');
            const target = root.querySelector('button:last-child');
            const start = indicator.getBoundingClientRect().x;
            target.click();
            const frames = [];
            for (let i = 0; i < 24; i++) {
              await new Promise(requestAnimationFrame);
              const r = indicator.getBoundingClientRect();
              frames.push({ x: r.x, width: r.width });
            }
            const end = target.getBoundingClientRect();
            return { start, frames, end: { x: end.x, width: end.width } };
          })()`)
          assert(motion.frames.some(frame => frame.x > motion.start + 1 && frame.x < motion.end.x - 1), 'Selection must slide through intermediate frames')
          assert(Math.abs(motion.frames.at(-1).x - motion.end.x) < 1, 'Selection must align with the target')
          assert(Math.abs(motion.frames.at(-1).width - motion.end.width) < 1, 'Selection must match the target width')
          assert.equal(await js(`getComputedStyle(${viewport}).display`), 'none')
          await click('.workspace-files__view-switch button:first-of-type')
          assert.equal(await js(`${viewport}.scrollTop`), after.scrollTop, 'Git view return must retain files scroll')
          docked(before, await geometry())
        }
         await js(`${viewport}.scrollLeft=0`)
         for (const label of ['New file', 'New directory']) {
           await click(`.workspace-files__actions button[aria-label="${label}"]`)
          await wait('!!document.querySelector("[role=dialog]")')
          win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' })
          win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' })
          await wait('!document.querySelector("[role=dialog]")')
        }
        observations.push({ name, git, theme, sidebar, root, before, after, previewRetention: true, gitRetention: git, createDialogs: 2 })
      }
    }
    await js('window.showSegmentedMotion()')
    await wait('!!document.querySelector("#motion-tab-files")')
    win.webContents.debugger.attach('1.3')
    for (const layout of ['classic', 'workbench']) for (const theme of ['light', 'dark']) {
      await js(`document.documentElement.dataset.layout=${JSON.stringify(layout)}; document.documentElement.dataset.theme=${JSON.stringify(theme)}`)
      await settle()
      for (const reduced of [false, true]) {
        await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', {
          features: [{ name: 'prefers-reduced-motion', value: reduced ? 'reduce' : 'no-preference' }]
        })
        const result = await js(`(async () => {
          const roots = [...document.querySelectorAll('.page-tabs--segmented,.segmented-control')];
          const indicators = roots.map(root => root.querySelector('.segmented-indicator'));
          roots[0].querySelector('button:first-of-type').click();
          await new Promise(resolve => setTimeout(resolve, 220));
          const starts = indicators.map(e => e.getBoundingClientRect().x);
          roots[1].querySelector('button:last-child').click();
          const frames = [];
          for (let i = 0; i < 24; i++) {
            await new Promise(requestAnimationFrame);
            frames.push(indicators.map(e => ({x:e.getBoundingClientRect().x,width:e.getBoundingClientRect().width})));
          }
          return roots.map((root,index) => {
            const target = root.querySelector('button:last-child').getBoundingClientRect();
            const style = getComputedStyle(indicators[index]);
            return { start:starts[index], frames:frames.map(frame=>frame[index]), end:{x:target.x,width:target.width},
              duration:style.transitionDuration, background:style.backgroundColor, radius:style.borderRadius };
          });
        })()`)
        for (const item of result) {
          assert(Math.abs(item.frames.at(-1).x - item.end.x) < 1)
          assert(Math.abs(item.frames.at(-1).width - item.end.width) < 1)
          assert.notEqual(item.background, 'rgba(0, 0, 0, 0)')
          if (reduced) {
            assert(Number.parseFloat(item.duration) <= 0.00001, 'Reduced motion must disable visible transitions')
            assert(item.frames.every(frame => Math.abs(frame.x - item.end.x) < 1), 'Reduced motion must switch immediately')
          } else {
            assert(item.frames.some(frame => frame.x > item.start + 1 && frame.x < item.end.x - 1), 'Both shared controls must slide')
          }
        }
        assert.equal(result[0].background, result[1].background, 'Shared selection surfaces must match')
        assert.equal(result[0].radius, result[1].radius, 'Shared selection radii must match')
      }
    }
    win.webContents.debugger.detach()
    assert.equal(documentLoads, 1, 'Layout changes must not reload the test page')
    assert.deepEqual(errors, [])
    await report({ passed: true })
    app.exit(0)
  } catch (error) {
    await screenshot('failure')
    await report({ passed: false, error: String(error.stack) })
    app.exit(1)
  }
})

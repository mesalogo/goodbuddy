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
app.commandLine.appendSwitch('force-device-scale-factor', '1')
// Keep test frames advancing during native window resize/focus transitions.
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion')
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: true, width: 1000, height: 720, useContentSize: true,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } })
  const errors = [], observations = []
  let pending = 'startup'
  startTimeout(async () => {
    await writeFile(join(directory, 'result.json'), JSON.stringify({ passed: false, pending, observations, errors }))
    app.exit(1)
  }, 80000)
  win.webContents.on('console-message', event => { if (event.level === 'error') errors.push(event.message) })
  const js = code => { pending = code; return win.webContents.executeJavaScript(code) }
  const wait = async code => {
    for (let i = 0; i < 400; i++) { if (await js(code)) return; await setTimeout(25) }
    throw new Error(`Timeout: ${code}\n${errors.join('\n')}`)
  }
  const settle = () => js('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
  const point = selector => js(`(() => {
    const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw new Error('Missing control: '+${JSON.stringify(selector)});const r=e.getBoundingClientRect();
    return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2),hit:e.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2))};
  })()`)
  const click = async selector => {
    win.focus(); win.webContents.focus()
    await wait('document.hasFocus()')
    await settle()
    const p = await point(selector)
    win.webContents.sendInputEvent({ type: 'mouseMove', x: 0, y: 0 })
    win.webContents.sendInputEvent({ type: 'mouseMove', x: p.x, y: p.y })
    await wait(`(() => { const e=document.querySelector(${JSON.stringify(selector)}),r=e.getBoundingClientRect();return e.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)) })()`)
    win.webContents.sendInputEvent({ type: 'mouseDown', x: p.x, y: p.y, button: 'left', clickCount: 1 })
    win.webContents.sendInputEvent({ type: 'mouseUp', x: p.x, y: p.y, button: 'left', clickCount: 1 })
    await settle()
  }
  const key = async keyCode => {
    win.focus(); win.webContents.focus()
    await wait('document.hasFocus()')
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode })
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode })
    await settle()
  }
  const screenshot = async name => {
    if (artifacts) {
      await writeFile(join(artifacts, name + '.png'), (await win.webContents.capturePage()).toPNG())
    }
  }
  const addVisible = async () => {
    assert(await js(`(() => { const e=document.querySelector('.workbar-shell__add'),r=e.getBoundingClientRect(),s=e.closest('.assistant-sidebar').getBoundingClientRect();
      return !e.closest('.workbar-shell__tab-scroll') && r.left>=s.left && r.right<=s.right && e.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)); })()`), 'Add must remain visible and hit-testable outside the scroll viewport')
  }
  try {
    if (artifacts) await mkdir(artifacts, { recursive: true })
    for (const locale of ['zh-CN', 'en-US']) {
      for (const theme of ['light', 'dark']) {
        win.setContentSize(1000, 720)
        if (process.env.GB_LAYOUT_MODE === 'source') {
          await win.loadURL(`${process.env.GB_LAYOUT_URL}?surface=settings&locale=${locale}&theme=${theme}`)
          await wait('!!document.querySelector(".model-download-source-control small") && !document.querySelector(".model-download-source-control [role=status]")')
          await js('document.fonts.ready')
          for (const [width, height] of [[640, 420], [960, 720], [1280, 800]]) {
            win.setContentSize(width, height)
            await wait(`innerWidth === ${width} && innerHeight === ${height}`)
            await js("document.querySelector('.settings-panel__content').scrollTop=0")
            await settle()
            const layout = await js(`(() => {
              const row=document.querySelector('.model-connections-navigation'),tabs=row.querySelector('.segmented-control'),button=row.querySelector('.model-download-source-control button');
              const r=row.getBoundingClientRect(),t=tabs.getBoundingClientRect(),b=button.getBoundingClientRect();
              return {rightAligned:Math.abs(r.right-b.right)<1,sameRow:Math.abs(t.y+t.height/2-b.y-b.height/2)<1,
                noOverlap:t.right<=b.left,overflow:row.scrollWidth>row.clientWidth+1,hit:button.contains(document.elementFromPoint(b.x+b.width/2,b.y+b.height/2))};
            })()`)
            assert.deepEqual(layout, {rightAligned:true,sameRow:true,noOverlap:true,overflow:false,hit:true}, JSON.stringify({locale,theme,width,layout}))
            const trigger = '.model-download-source-control button'
            const dialog = '[aria-labelledby="model-download-source-title"]'
            await click(trigger)
            await wait(`!!document.querySelector('${dialog}') && document.activeElement.matches('${dialog} .icon-button')`)
            await click(`${dialog} input[value="hugging-face"]`)
            assert.equal(await js('window.sourceFixture.writes.length'), 0)
            await click(`${dialog} .custom-task-dialog__actions .secondary-button`)
            await wait(`!document.querySelector('${dialog}') && document.activeElement.matches('${trigger}')`)
            assert.equal(await js('window.sourceFixture.source'), 'modelscope')
            await click(trigger)
            await wait(`!!document.querySelector('${dialog} input[value="modelscope"]:checked')`)
            await click(`${dialog} input[value="hugging-face"]`)
            await click(`${dialog} .custom-task-dialog__actions .primary-button`)
            await wait(`!document.querySelector('${dialog}') && document.activeElement.matches('${trigger}') && document.querySelector('.model-download-source-control small').textContent.includes('Hugging Face')`)
            assert.deepEqual(await js('window.sourceFixture.writes'), [{modelDownloadSource:'hugging-face'}])
            await click(trigger)
            await wait(`!!document.querySelector('${dialog} input[value="hugging-face"]:checked')`)
            await key('Escape')
            await wait(`!document.querySelector('${dialog}') && document.activeElement.matches('${trigger}')`)
            await screenshot(`${locale}-${theme}-source-${width}`)
            observations.push({locale,theme,width,height,layout,dialog:'native selection, cancel without write, confirm, reopen, Escape and focus restoration'})
            // Reload the fixture to reset its in-memory settings and write log.
            await win.loadURL(`${process.env.GB_LAYOUT_URL}?surface=settings&locale=${locale}&theme=${theme}`)
            await wait('!!document.querySelector(".model-download-source-control small") && !document.querySelector(".model-download-source-control [role=status]")')
            await js('document.fonts.ready')
          }
          continue
        }
        await win.loadURL(`${process.env.GB_LAYOUT_URL}?locale=${locale}&theme=${theme}`)
        await wait('!!document.querySelector(".workbar-shell__scroll-button")')
        await js('document.fonts.ready')
        await settle()
        const scroll = "document.querySelector('.workbar-shell__tab-scroll')"
        for (const many of [false, true]) {
          if (many) { await click('#many-tabs'); await wait('document.querySelectorAll("[role=tab]").length===16') }
          await addVisible()
          await click('.workbar-shell__add')
          await wait('!!document.querySelector(".workbar-shell__catalog") && document.activeElement.matches("[data-workbar-app-choice]")')
          await key('Escape')
          await wait('!document.querySelector(".workbar-shell__catalog") && document.activeElement.matches(".workbar-shell__add")')
          const active = await js('document.querySelector("[role=tab][aria-selected=true]").id')
          await click('.workbar-shell__scroll-button:last-child')
          await wait(`${scroll}.scrollLeft > 0`)
          assert.equal(await js('document.querySelector("[role=tab][aria-selected=true]").id'), active)
          await addVisible()
          await js('document.querySelector("[role=tab][aria-selected=true]").focus()')
          await key('End')
          await wait('document.activeElement === document.querySelector(".workbar-shell__tab-item:last-child [role=tab][aria-selected=true]")')
          assert(await js(`(() => {const r=document.activeElement.parentElement.getBoundingClientRect(),s=${scroll}.getBoundingClientRect();return r.left>=s.left-1 && r.right<=s.right+1})()`), 'End must reveal the last tab')
          await addVisible()
          await screenshot(`${locale}-${theme}-workbar-${many ? 'many' : 'default'}`)
          await key('Home')
          await wait(`${scroll}.scrollLeft === 0 && document.activeElement === document.querySelector('.workbar-shell__tab-item:first-child [role=tab][aria-selected=true]')`)
          if (!many) {
            await js("document.querySelector('.assistant-sidebar').style.width='900px';document.querySelector('.assistant-sidebar').style.flexBasis='900px'")
            await wait('!document.querySelector(".workbar-shell__scroll-button")')
            await addVisible()
            await js("document.querySelector('.assistant-sidebar').style.width='300px';document.querySelector('.assistant-sidebar').style.flexBasis='300px'")
            await wait('!!document.querySelector(".workbar-shell__scroll-button")')
          }
        }
        await click('.workbar-shell__add')
        await wait('!!document.querySelector(".workbar-shell__catalog")')
        await click('.workbar-shell__catalog-choice:has(.workbar-shell__app-icon--browser)')
        await wait('document.querySelectorAll("[role=tab]").length===17 && !document.querySelector(".workbar-shell__catalog")')
        await addVisible()
        observations.push({ locale, theme, workbar: 'default and 16 long tabs; native add/catalog/create, arrows, Home/End' })

        await win.loadURL(`${process.env.GB_LAYOUT_URL}?surface=settings&locale=${locale}&theme=${theme}`)
        await wait('!!document.querySelector(".model-connection-detail select")')
        await js('document.fonts.ready')
        const navigation = await js(`(() => {
          const nav = document.querySelector('.settings-tabs');
          return { ids: [...nav.querySelectorAll('[role=tab]')].map(e => e.id),
            groups: nav.querySelectorAll('.settings-tabs__group-label').length,
            descriptions: nav.querySelectorAll('small').length,
            font: getComputedStyle(nav.querySelector('strong')).fontSize };
        })()`)
        assert.deepEqual(navigation.ids, ['appearance', 'platform-features', 'model', 'context-control', 'runtime',
          'document-parsing', 'channels', 'roles', 'capabilities', 'security', 'about'].map(id => `settings-tab-${id}`))
        assert.equal(navigation.groups, 4)
        assert.equal(navigation.descriptions, 0)
        assert.equal(navigation.font, '13px')
        await js('document.querySelector("#settings-tab-model").focus()')
        await key('Down')
        await wait('document.activeElement.id === "settings-tab-context-control"')
        await key('Up')
        await wait('document.activeElement.id === "settings-tab-model" && !!document.querySelector(".model-connection-detail select")')
        observations.push({ locale, theme, navigation })
        for (const [width, height, panelWidth] of [[640, 420], [680, 560], [720, 640], [721, 560], [740, 560], [960, 720], [1280, 800], [1180, 560, 740]]) {
          win.setContentSize(width, height)
          await wait(`innerWidth === ${width} && innerHeight === ${height}`)
          await settle()
          await js(`document.querySelector('.settings-panel').style.width=${JSON.stringify(panelWidth ? `${panelWidth}px` : '')}`)
          if (width === 1280 || width === 640) {
            await js("document.querySelector('.settings-panel__content').scrollTop=0")
            await settle()
            await screenshot(`${locale}-${theme}-settings-overview-${width}`)
          }
          await js("document.querySelector('.model-connection-detail select').scrollIntoView({block:'center'})")
          const result = await js(`(() => {
            const e=document.querySelector('.model-connection-detail select'),s=getComputedStyle(e),r=e.getBoundingClientRect();
            const c=document.createElement('canvas').getContext('2d');c.font=s.font;
            const manager=document.querySelector('.model-connection-manager'),list=manager.querySelector('.model-connection-list').getBoundingClientRect(),detail=manager.querySelector('.model-connection-detail').getBoundingClientRect();
            return {containerWidth:manager.clientWidth,stacked:detail.top>=list.bottom-1,selectWidth:e.clientWidth,
              textWidth:c.measureText(e.selectedOptions[0].textContent).width,available:e.clientWidth-parseFloat(s.paddingLeft)-parseFloat(s.paddingRight)-20,
              overflow:['.settings-panel__content','.model-connection-manager','.model-connection-detail'].filter(sel=>{const n=document.querySelector(sel);return n.scrollWidth>n.clientWidth+1}),
              hit:e.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)),value:e.value,
              bounds:r.toJSON(),cover:document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)?.outerHTML.slice(0,500)};
          })()`)
          assert.equal(result.stacked, result.containerWidth <= 640, JSON.stringify(result))
          assert.deepEqual(result.overflow, [], JSON.stringify(result))
          assert(result.textWidth <= result.available, 'Protocol truncated: ' + JSON.stringify(result))
          assert(result.hit, 'Protocol is occluded: ' + JSON.stringify({width,height,...result}))
          await js("document.querySelector('.model-connection-detail select').closest('.field').previousElementSibling.querySelector('input').focus()")
          await key('Tab')
          await wait('document.activeElement.matches(".model-connection-detail select")')
          await key('Home'); await key('Down')
          await wait('document.querySelector(".model-connection-detail select").value!=="openai-chat-completions"')
          await key('Home')
          await wait('document.querySelector(".model-connection-detail select").value==="openai-chat-completions"')
          observations.push({ locale, theme, width, height, panelWidth, ...result })
          await screenshot(`${locale}-${theme}-settings-${width}${panelWidth ? '-narrow-container' : ''}`)
          const switchSelector = '.model-connection-detail .toggle-row input[role="switch"]'
          await js(`document.querySelector(${JSON.stringify(switchSelector)}).scrollIntoView({block:'center'})`)
          await settle()
          const switchLayout = await js(`(() => {
            const input=document.querySelector(${JSON.stringify(switchSelector)}),row=input.closest('.toggle-row'),
              control=input.getBoundingClientRect(),label=row.querySelector('span').getBoundingClientRect(),bounds=row.getBoundingClientRect();
            return {labelBeforeSwitch:label.right<=control.left,rightAligned:Math.abs(control.right-bounds.right)<1,
              width:control.width,height:control.height};
          })()`)
          assert.deepEqual(switchLayout, { labelBeforeSwitch: true, rightAligned: true, width: 38, height: 22 })
          await click(`${switchSelector} + span`)
          await wait(`document.querySelector(${JSON.stringify(switchSelector)}).checked`)
          await js(`document.querySelector(${JSON.stringify(switchSelector)}).focus()`)
          await key('Space')
          await wait(`!document.querySelector(${JSON.stringify(switchSelector)}).checked`)
          observations.push({ locale, theme, width, height, panelWidth, switchLayout })
          if (width === 640 || width === 1280) await screenshot(`${locale}-${theme}-settings-switch-${width}`)
          if (width === 1280 || width === 640) {
            await js("document.querySelector('.model-connection-detail details.settings-section > summary').scrollIntoView({block:'center'})")
            await click('.model-connection-detail details.settings-section > summary')
            await wait('document.querySelector(".model-connection-detail details.settings-section").open')
            const nested = await js(`(() => {
              const e=document.querySelector('.model-connection-detail details.settings-section'),s=getComputedStyle(e);
              return {borderLeft:s.borderLeftWidth,background:s.backgroundColor,radius:s.borderRadius,
                overflow:e.scrollWidth>e.clientWidth+1};
            })()`)
            assert.deepEqual(nested, { borderLeft: '0px', background: 'rgba(0, 0, 0, 0)', radius: '0px', overflow: false })
            await screenshot(`${locale}-${theme}-settings-nested-${width}`)
            await click('.model-connection-detail details.settings-section > summary')
            observations.push({ locale, theme, width, nested })
          }
        }
      }
    }
    assert.deepEqual(errors, [])
    const result = { passed: true, observations, errors, modelCalls: 0 }
    await writeFile(join(directory, 'result.json'), JSON.stringify(result))
    if (artifacts) await writeFile(join(artifacts, 'result.json'), JSON.stringify(result, null, 2))
    app.exit(0)
  } catch (error) {
    const result = JSON.stringify({ passed: false, error: String(error.stack), observations, errors })
    await writeFile(join(directory, 'result.json'), result)
    if (artifacts) { await screenshot('failure'); await writeFile(join(artifacts, 'result.json'), result) }
    app.exit(1)
  }
})

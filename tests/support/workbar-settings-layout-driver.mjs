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
  const scrollSettingsControl = async selector => {
    await js(`(() => {
      const e=document.querySelector(${JSON.stringify(selector)});
      e.scrollIntoView({block:'center'});
      const pane=e.closest('.settings-panel__content'),p=pane.getBoundingClientRect();
      const header=pane.querySelector('.settings-category-header--sticky');
      const top=Math.max(p.top,header?.getBoundingClientRect().bottom??p.top),bottom=Math.min(p.bottom,innerHeight);
      const r=e.getBoundingClientRect();
      if(bottom-top<r.height)throw new Error('No unobscured space for settings control');
      pane.scrollTop+=r.top+r.height/2-(top+bottom)/2;
    })()`)
    await settle()
  }
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
        if (process.env.GB_LAYOUT_MODE === 'recognition') {
          for (const [width, height] of [[640, 600], [960, 720], [1280, 800]]) {
            win.setContentSize(width, height)
            await win.loadURL(`${process.env.GB_LAYOUT_URL}?surface=settings&locale=${locale}&theme=${theme}`)
            await wait('document.querySelectorAll(".model-type-navigation .segmented-control__option").length===5')
            await js('document.querySelectorAll(".model-type-navigation .segmented-control__option")[4].click()')
            await wait('!!document.querySelector(".document-ocr-model")')
            await js('document.fonts.ready')
            await settle()
            const measure = () => js(`(() => {
              const pane=document.querySelector('.settings-panel__content'), source=document.querySelector('.document-ocr-provider');
              const note=source.querySelector('small'), n=note.getBoundingClientRect(), s=source.getBoundingClientRect();
              const label=source.querySelector('strong').getBoundingClientRect(), toggle=source.querySelector('.segmented-control').getBoundingClientRect();
              return {overflow:pane.scrollWidth>pane.clientWidth+1, sourceHeight:s.height,
                sourceSameRow:Math.abs(label.top+label.height/2-toggle.top-toggle.height/2)<1,
                sourceNoOverlap:label.right<=toggle.left,
                noteLeft:n.left-s.left, noteTop:n.top-s.top,
                headers:pane.querySelectorAll('.settings-category-header').length,
                saveButtons:pane.querySelectorAll('.settings-category-header__actions .primary-button').length};
            })()`)
            const local = await measure()
            assert.equal(local.overflow, false, JSON.stringify({locale,theme,width,local}))
            assert.equal(local.headers, 1)
            assert.equal(local.saveButtons, 1)
            assert.equal(local.sourceSameRow, true, JSON.stringify({locale,theme,width,local}))
            assert.equal(local.sourceNoOverlap, true)
            if (width <= 720) assert(local.noteLeft < 24, JSON.stringify(local))
            await screenshot(`${locale}-${theme}-ocr-local-${width}`)
            await scrollSettingsControl('.document-ocr-model__actions')
            const card = await js(`(() => {
              const card=document.querySelector('.document-ocr-model').getBoundingClientRect();
              const buttons=[...document.querySelectorAll('.document-ocr-model__actions button')];
              return buttons.every(button=>{const r=button.getBoundingClientRect();
                return r.left>=card.left && r.right<=card.right && button.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2));});
            })()`)
            assert(card, 'Model actions must fit the card and remain reachable')
            await screenshot(`${locale}-${theme}-ocr-card-${width}`)
            await scrollSettingsControl('.document-ocr-provider')
            await click('.document-ocr-provider .segmented-control__option:last-child')
            await wait('!!document.querySelector(".http-ocr-settings")')
            const remote = await measure()
            assert.equal(remote.overflow, false, JSON.stringify({locale,theme,width,remote}))
            await screenshot(`${locale}-${theme}-ocr-remote-${width}`)
            await scrollSettingsControl('.http-ocr-settings details > summary')
            await click('.http-ocr-settings details > summary')
            await settle()
            const advanced = await js(`(() => {
              const details=document.querySelector('.http-ocr-settings details');
              const summary=details.querySelector('summary').getBoundingClientRect();
              const p=details.querySelector('p').getBoundingClientRect();
              const grid=details.querySelector('.document-parsing-grid').getBoundingClientRect();
              const filters=details.querySelector('.document-parsing-filter-list').getBoundingClientRect();
              return {summaryGap:p.top-summary.bottom, gridGap:grid.top-filters.bottom,
                overflow:details.scrollWidth>details.clientWidth+1};
            })()`)
            const notice = await js(`(() => {
              const e=document.getElementById('document-parsing-unsaved-notice'), r=e.getBoundingClientRect();
              const header=e.closest('.settings-category-header--sticky'), h=header?.getBoundingClientRect();
              return {count:document.querySelectorAll('#document-parsing-unsaved-notice').length,
                inHeader:!!header, visible:!!h && r.top>=h.top && r.bottom<=h.bottom && r.bottom<innerHeight};
            })()`)
            assert.deepEqual(notice, {count:1,inHeader:true,visible:true}, JSON.stringify({locale,theme,width,notice}))
            await screenshot(`${locale}-${theme}-ocr-advanced-${width}`)
            await scrollSettingsControl('.http-ocr-settings details .document-parsing-grid .field')
            await screenshot(`${locale}-${theme}-ocr-parameters-${width}`)
            observations.push({locale,theme,width,local,remote,advanced})
            assert.equal(advanced.overflow, false)
            assert(advanced.summaryGap >= 8 && advanced.gridGap >= 8, JSON.stringify({locale,theme,width,advanced}))
            await js('document.querySelector(".document-ocr-provider .segmented-control__option:first-child").click()')
            await wait('!!document.querySelector(".document-ocr-model") && document.querySelector(".settings-category-header__actions .primary-button").disabled')
            assert.equal(await js('!!document.getElementById("document-parsing-unsaved-notice")'), false)
          }
          continue
        }
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
          if (many) { await click('#many-tabs'); await wait('document.querySelectorAll("[role=tab]").length===15') }
          await addVisible()
          assert(await js(`(() => {
            const s=${scroll}.getBoundingClientRect(),buttons=[...document.querySelectorAll('.workbar-shell__scroll-button')];
            return buttons.length===2 && buttons[0].getBoundingClientRect().right<=s.left && buttons[1].getBoundingClientRect().left>=s.right;
          })()`), 'Scroll arrows must reserve space outside the tab viewport')
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
        await wait('document.querySelectorAll("[role=tab]").length===16 && !document.querySelector(".workbar-shell__catalog")')
        await addVisible()
        await key('Left')
        await wait('document.querySelector(".workbar-shell__tab-item:nth-last-child(2) [role=tab]").getAttribute("aria-selected")==="true"')
        await js(`${scroll}.scrollLeft=0`)
        await settle()
        await js(`(() => {
          const tab=document.querySelector('.workbar-shell__tab-item--active'),s=${scroll};
          s.scrollLeft+=tab.getBoundingClientRect().right-s.getBoundingClientRect().right;
        })()`)
        await wait('!document.querySelector(".workbar-shell__scroll-button:last-child").disabled')
        const closingId = await js('document.querySelector(".workbar-shell__tab-item--active [role=tab]").id')
        await click('.workbar-shell__tab-item--active .workbar-shell__tab-close')
        await wait(`document.querySelectorAll('[role=tab]').length===15 && !document.getElementById(${JSON.stringify(closingId)})`)
        observations.push({ locale, theme, workbar: 'default and 15 long tabs; native add/catalog/create, arrows, Home/End, close at right viewport edge with right arrow enabled' })

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
        assert.deepEqual(navigation.ids, ['appearance', 'platform-features', 'model', 'context-control', 'runtime', 'tool-environment',
          'document-parsing', 'roles', 'capabilities', 'about'].map(id => `settings-tab-${id}`))
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
          await scrollSettingsControl('.model-connection-detail select')
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
          await scrollSettingsControl(switchSelector)
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
            await scrollSettingsControl('.model-connection-detail details.settings-section > summary')
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

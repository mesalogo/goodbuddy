import { app, BrowserWindow } from 'electron'
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import process from 'node:process'
import console from 'node:console'
import { setTimeout } from 'node:timers/promises'

const directory = process.env.GOODBUDDY_SUPERVISOR_DIRECTORY
const artifacts = process.env.GOODBUDDY_SUPERVISOR_ARTIFACTS || directory
app.setPath('userData', join(directory, 'profile'))
app.commandLine.appendSwitch('force-device-scale-factor', '1')
app
  .whenReady()
  .then(async () => {
    await mkdir(artifacts, { recursive: true })
    const win = new BrowserWindow({
      show: false,
      width: 1440,
      height: 1100,
      useContentSize: true,
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false
      }
    })
    const errors = []
    win.webContents.on('console-message', (event) => {
      if (event.level === 'error') errors.push(event.message)
    })
    const js = async (code) => {
      try {
        return await win.webContents.executeJavaScript(code)
      } catch (error) {
        throw new Error(`${code}\n${errors.join('\n')}`, { cause: error })
      }
    }
    const settle = async () => {
      await js(
        'new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))'
      )
      await setTimeout(250)
    }
    const wait = async (code) => {
      for (let i = 0; i < 600; i++) {
        if (await js(code)) return
        await setTimeout(25)
      }
      throw new Error(`Timeout: ${code}\n${errors.join('\n')}`)
    }
    const open = async (dense) => {
      await win.loadURL(
        process.env.GOODBUDDY_SUPERVISOR_URL + (dense ? '?dense=1' : '')
      )
      await wait('!!document.querySelector("#supervisor-tab-graph")')
      await js('document.querySelector("#supervisor-tab-graph").click()')
      await wait('!!document.querySelector(".supervisor-workspace__map")')
      await js('document.fonts.ready')
      await settle()
    }
    const reports = []
    if (process.env.GOODBUDDY_SUPERVISOR_CONTENT_LAYOUT) {
      win.show()
      for (const view of ['recap', 'empty', 'activity', 'pending', 'failure']) {
        await win.loadURL(process.env.GOODBUDDY_SUPERVISOR_URL + (view === 'activity' ? '?activity=1' : '?recap=1&long-summary=1' + (view === 'failure' ? '&fail-run=1' : view === 'empty' ? '&state=empty' : '')))
        await wait('document.querySelector(".supervisor-workspace")?.getAttribute("aria-busy") === "false"')
        if (view === 'activity') {
          await js('document.querySelector("#supervisor-tab-activity").click()')
          await wait('document.querySelectorAll(".supervisor-activity__item").length === 3')
        } else if (view === 'pending' || view === 'failure') {
          await js('document.querySelector(".supervisor-workspace__toolbar .primary-button").click()')
          await wait(view === 'pending' ? '!!document.querySelector(".supervisor-workspace [role=status]")' : '!!document.querySelector(".supervisor-workspace [role=alert]")')
        }
        await js('document.fonts.ready')
        for (const theme of ['light', 'dark']) {
          await js(`document.documentElement.dataset.theme = '${theme}'`)
          for (const width of [2000, 1440, 1024, 390]) {
            win.setContentSize(width, 1100)
            await js('document.querySelector(".page-shell").scrollTop = 0')
            await settle()
            const report = await js(`(() => {
              const box = selector => { const r = document.querySelector(selector)?.getBoundingClientRect(); return r && { left:r.left, right:r.right, width:r.width, height:r.height, top:r.top, bottom:r.bottom }; };
              return { width:innerWidth, pageWidth:document.documentElement.scrollWidth,
                panel:box('.heartbeat-center > [role=tabpanel]:not([hidden])'), toolbar:box('.supervisor-workspace__toolbar'), history:box('.supervisor-workspace__result-navigation'), recap:box('.supervisor-workspace__recap'),
                prose:box('.supervisor-workspace__prose'), activity:box('.supervisor-activity'),
                steps:box('.supervisor-activity__steps'),
                empty:box('.supervisor-workspace > .empty-state'), emptyTitle:box('.supervisor-workspace > .empty-state strong'),
                stageConnectors:[...document.querySelectorAll('.supervisor-activity__steps li:not(:last-child)')].map(e=>getComputedStyle(e,'::after').borderTopWidth),
                summaryLength:[...document.querySelectorAll('.supervisor-workspace__summary')].map(e=>e.textContent).join('').length,
                tail:document.querySelector('.supervisor-workspace__prose')?.textContent.includes('长摘要末尾'),
                controls:[...document.querySelectorAll('.supervisor-activity > .supervisor-workspace__action-bar > *')].map(e=>{const r=e.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top};}) };
            })()`)
            assert(report.pageWidth <= width, 'No page overflow')
            if (view === 'empty') {
              assert(Math.abs(report.empty.width - report.panel.width) < 1, 'Empty state fills panel');
              assert(Math.abs((report.emptyTitle.left + report.emptyTitle.right) / 2 - (report.panel.left + report.panel.right) / 2) < 1, 'Empty state title centered');
              assert(report.empty.top >= report.toolbar.bottom, 'Empty state below toolbar');
            } else if (view !== 'activity') {
              assert(report.summaryLength > 2000 && report.tail, 'Long summary retained')
              assert(Math.abs(report.recap.width - report.panel.width) < 1, 'Recap fills the page panel')
              for (const control of [report.toolbar, report.history]) {
                assert(Math.abs(control.left - report.recap.left) < 1 && Math.abs(control.right - report.recap.right) < 1, 'Toolbar, history and result share edges')
              }
              assert(report.prose.left - report.recap.left <= 25, 'No separately centered inner body')
            } else {
              assert(Math.abs(report.activity.width - report.panel.width) < 1, 'Activity fills the page panel')
              if (width >= 1024) {
                assert(report.steps.height < 40, 'Compact stage row')
                assert(report.stageConnectors.every(value => value === '1px'), 'Connected stages')
                assert(report.controls[2].left - report.controls[1].right <= 24, 'Refresh grouped with filter')
              }
            }
            reports.push({ view, theme, ...report })
            await writeFile(join(artifacts, `${view}-${theme}-${width}.png`), (await win.webContents.capturePage()).toPNG())
            if (view === 'recap') {
              await js('document.querySelector(".supervisor-workspace__prose").lastElementChild.scrollIntoView({block:"end"})')
              await settle()
              await writeFile(join(artifacts, `${view}-tail-${theme}-${width}.png`), (await win.webContents.capturePage()).toPNG())
            }
          }
        }
      }
      assert.deepEqual(errors, [])
      await writeFile(join(artifacts, 'content-layout-measurements.json'), JSON.stringify(reports, null, 2))
      console.log(JSON.stringify({ artifacts, cases: reports.length, errors }))
      win.destroy()
      app.quit()
      return
    }
    if (process.env.GOODBUDDY_SUPERVISOR_ACTIVITY) {
      await win.loadURL(process.env.GOODBUDDY_SUPERVISOR_URL + '?activity=1')
      await wait('!!document.querySelector("#supervisor-tab-activity")')
      await js('document.querySelector("#supervisor-tab-activity").click()')
      await wait('document.querySelectorAll(".supervisor-activity__item").length === 3')
      await js('document.fonts.ready')
      win.show()
      win.focus()
      for (const theme of ['light', 'dark']) {
        await js(`document.documentElement.dataset.theme = '${theme}'`)
        for (const width of [1440, 390]) {
          win.setContentSize(width, 1000)
          await js('document.querySelectorAll(".supervisor-activity__item details").forEach(e => e.open = false); document.querySelector(".page-shell").scrollTop = 0')
          await settle()
          const report = await js(`(() => {
            const root = document.querySelector('.supervisor-activity');
            const item = root.querySelector('.supervisor-activity__item');
            return { width: innerWidth, pageWidth: document.documentElement.scrollWidth, clientWidth: root.clientWidth, scrollWidth: root.scrollWidth,
              itemHeight: item.getBoundingClientRect().height,
              states: [...item.querySelectorAll('[data-phase]')].map(e => e.dataset.state),
              diagnosticOpen: item.querySelector('.supervisor-activity__diagnostics').open,
              advancedOpen: item.querySelector('.supervisor-activity__advanced').open };
          })()`)
          assert(report.pageWidth <= width && report.scrollWidth <= report.clientWidth, 'Activity overflow')
          assert.deepEqual(report.states, ['completed', 'completed', 'failed', 'pending'])
          assert(!report.diagnosticOpen && !report.advancedOpen, 'Details collapsed by default')
          assert(report.itemHeight < (width === 390 ? 650 : 440), 'Compact run summary')
          reports.push({ theme, ...report })
          await writeFile(join(artifacts, `review-activity-${theme}-${width}.png`), (await win.webContents.capturePage()).toPNG())
          await js('document.querySelector(".supervisor-activity__diagnostics summary").focus()')
          win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' })
          win.webContents.sendInputEvent({ type: 'char', keyCode: '\r' })
          win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' })
          await settle()
          assert(await js('document.querySelector(".supervisor-activity__diagnostics").open'), 'Native keyboard disclosure')
          const error = await js(`(() => { const e = document.querySelector('.supervisor-activity__diagnostics pre'); return { height: e.clientHeight, scrollHeight: e.scrollHeight, selectable: getComputedStyle(e).userSelect, text: e.textContent }; })()`)
          assert(error.height <= 240 && error.scrollHeight > error.height && error.selectable === 'text' && error.text.includes('relations'), 'Full bounded selectable error')
          await js('document.querySelector(".supervisor-activity__diagnostics").scrollIntoView({block:"center"})')
          await settle()
          await writeFile(join(artifacts, `review-error-${theme}-${width}.png`), (await win.webContents.capturePage()).toPNG())
          await js('document.querySelector(".supervisor-activity__diagnostics").open = false; document.querySelector(".supervisor-activity__item button[aria-expanded=false]")?.click()')
          await wait('!!document.querySelector(".supervisor-activity__batch")')
          await js('document.querySelectorAll(".supervisor-activity__project, .supervisor-activity__conversation").forEach(e => e.open = true); document.querySelector(".supervisor-activity__tree").scrollIntoView({block:"start"})')
          await settle()
          assert(await js('document.querySelectorAll(".supervisor-activity__batch").length === 6'), 'All six saved leaves')
          assert(await js('document.documentElement.scrollWidth <= innerWidth'), 'Hierarchy overflow')
          await writeFile(join(artifacts, `review-tree-${theme}-${width}.png`), (await win.webContents.capturePage()).toPNG())
          await js('document.querySelector(".supervisor-activity__item button[aria-expanded=true]").click()')
        }
      }
      await js('document.querySelectorAll(".supervisor-activity__item")[1].querySelector("button[aria-expanded]").click()')
      await wait('document.querySelectorAll(".supervisor-activity__batch").length === 10')
      await js('[...document.querySelectorAll(".supervisor-activity__tree button")].find(e => e.textContent === "下一页").click()')
      await wait('document.querySelectorAll(".supervisor-activity__batch").length === 2')
      assert(await js('[...document.querySelectorAll(".supervisor-activity__tree button")].find(e => e.textContent === "下一页").disabled'), 'Paging ends at persisted batch count')
      assert.deepEqual(errors, [])
      await writeFile(join(artifacts, 'review-activity-measurements.json'), JSON.stringify(reports, null, 2))
      console.log(JSON.stringify({ artifacts, cases: reports.length, errors }))
      win.destroy()
      app.quit()
      return
    }
    if (process.env.GOODBUDDY_SUPERVISOR_RECAP) {
      for (const scenario of ['populated', 'automatic-empty', 'empty']) {
        await win.loadURL(process.env.GOODBUDDY_SUPERVISOR_URL + '?recap=1' + (scenario === 'populated' ? '&menu=1' : scenario === 'empty' ? '&state=empty' : ''))
        await wait('document.querySelector(".supervisor-workspace")?.getAttribute("aria-busy") === "false"')
        await js('document.fonts.ready')
        for (const width of [1440, 390]) {
          win.setContentSize(width, 1100)
          for (const tab of ['overview', 'plans']) {
            await js(`document.querySelector('#supervisor-tab-${tab}').click(); document.querySelector('.page-shell').scrollTop = 0`)
            await settle()
            const report = await js(`(() => {
              const panel = document.querySelector('#supervisor-panel-${tab}');
              const recap = panel.querySelector('.supervisor-workspace__recap');
              return { width: innerWidth, pageWidth: document.documentElement.scrollWidth,
                clientWidth: panel.clientWidth, scrollWidth: panel.scrollWidth,
                reports: !!panel.querySelector('#heartbeat-reports-title'),
                suggestions: !!panel.querySelector('#heartbeat-panel-suggestions'),
                refresh: [...panel.querySelectorAll('button')].filter(b => b.getClientRects().length && b.textContent.includes('刷新')).length,
                recap: !!recap && !!recap.getClientRects().length,
                paragraphs: recap?.querySelectorAll('.supervisor-workspace__summary').length ?? 0,
                proseWidth: recap?.querySelector('.supervisor-workspace__prose').getBoundingClientRect().width,
                text: panel.innerText };
            })()`)
            assert(report.pageWidth <= width && report.scrollWidth <= report.clientWidth, 'Recap/automatic overflow')
            assert.equal(report.refresh, 1, 'One refresh owner per panel')
            assert.equal(report.reports, tab === 'plans')
            assert.equal(report.suggestions, tab === 'plans')
            assert.equal(report.recap, tab === 'overview' && scenario !== 'empty')
            if (tab === 'overview') {
              assert(!report.text.includes('暂无自动监督报告') && !report.text.includes('待确认记忆'))
              if (scenario !== 'empty') {
                assert.equal(report.paragraphs, 4)
                assert(report.text.includes('外部评审时间') && report.text.includes('未解决事项'))
                assert(report.clientWidth - report.proseWidth <= 50, 'Prose fills the panel within card padding')
              } else assert(report.text.includes('还没有成功回顾'))
            } else {
              assert.equal(report.text.includes('暂无自动监督报告'), scenario !== 'populated')
              assert(report.text.includes('自动监督报告'))
            }
            reports.push({ scenario, tab, ...report })
            const prefix = `recap-${scenario}-${tab}-${width}`
            await writeFile(join(artifacts, `${prefix}.png`), (await win.webContents.capturePage()).toPNG())
            if (tab === 'plans') {
              for (const anchor of ['heartbeat-memory-title', 'heartbeat-reports-title', 'heartbeat-runs-title']) {
                await js(`document.getElementById('${anchor}').scrollIntoView({block:'start'})`)
                if (anchor === 'heartbeat-reports-title' && scenario === 'populated') await js(`document.querySelector('#heartbeat-panel-history button[aria-expanded=false]')?.click()`)
                await settle()
                await writeFile(join(artifacts, `${prefix}-${anchor}.png`), (await win.webContents.capturePage()).toPNG())
              }
            }
          }
        }
        if (scenario === 'populated') {
          await js('document.querySelector("#supervisor-tab-overview").click()')
          await js(`(() => { const s = document.querySelector('.supervisor-workspace__result-navigation select'); s.value = 'older-result'; s.dispatchEvent(new Event('change', {bubbles:true})); })()`)
          await wait('document.querySelector(".supervisor-workspace")?.getAttribute("aria-busy") === "false"')
          await js('document.querySelector(".supervisor-workspace__toolbar .primary-button").click(); document.querySelector(".page-shell").scrollTop = 0')
          await settle()
          assert(await js('document.querySelector(".supervisor-workspace__recap").textContent.includes("上期结果")'))
          assert(await js('document.querySelector(".supervisor-workspace [role=status]").textContent.includes("新回顾正在整理")'))
          await writeFile(join(artifacts, 'recap-running-history-390.png'), (await win.webContents.capturePage()).toPNG())
          await js('document.querySelector(".supervisor-workspace [role=status] button").click()')
          await wait('document.querySelector("#supervisor-tab-activity").getAttribute("aria-selected") === "true"')
        }
      }
      assert.deepEqual(errors, [])
      await writeFile(join(artifacts, 'recap-measurements.json'), JSON.stringify(reports, null, 2))
      console.log(JSON.stringify({ artifacts, cases: reports.length, errors }))
      win.destroy()
      app.quit()
      return
    }
    if (process.env.GOODBUDDY_SUPERVISOR_AUTOMATIC_OVERVIEW) {
      for (const empty of [false, true]) {
        await win.loadURL(process.env.GOODBUDDY_SUPERVISOR_URL + (empty ? '' : '?menu=1'))
        await wait('!!document.querySelector("#supervisor-tab-plans")')
        await js('document.fonts.ready')
        await js('document.documentElement.dataset.theme = "light"')
        for (const width of [1440, 390]) {
          win.setContentSize(width, 1100)
          for (const tab of ['plans', 'activity']) {
            await js(`document.querySelector('#supervisor-tab-${tab}').click(); document.querySelector('.page-shell').scrollTop = 0`)
            if (tab === 'activity') await wait('document.querySelector(".supervisor-activity")?.getAttribute("aria-busy") === "false"')
            await settle()
            const report = await js(`(() => {
              const panel = document.querySelector('#supervisor-panel-${tab}');
              return { width: innerWidth, pageWidth: document.documentElement.scrollWidth,
                panelWidth: panel.clientWidth, scrollWidth: panel.scrollWidth,
                overview: !!panel.querySelector('#heartbeat-panel-overview'),
                metrics: !!panel.querySelector('.heartbeat-center__metrics'),
                trend: !!panel.querySelector('#heartbeat-trend-title'),
                audit: !!panel.querySelector('#heartbeat-runs-title'),
                plans: !!panel.querySelector('#heartbeat-panel-plans'),
                create: [...panel.querySelectorAll('button')].filter(b => b.textContent === '创建自动监督计划').length,
                emptyStates: panel.querySelectorAll('#heartbeat-panel-overview .empty-state').length,
                activity: panel.querySelectorAll('.supervisor-activity__item').length };
            })()`)
            assert(report.pageWidth <= width && report.scrollWidth <= report.panelWidth, 'Automatic panel overflow')
            for (const key of ['overview', 'metrics', 'trend', 'audit', 'plans']) assert.equal(report[key], tab === 'plans', key)
            assert.equal(report.create, tab === 'plans' ? 1 : 0)
            assert.equal(report.emptyStates, 0)
            if (tab === 'activity') assert.equal(report.activity, 3)
            reports.push({ empty, tab, ...report })
            const prefix = `automatic-${empty ? 'empty' : 'populated'}-${tab}-light-${width}`
            await writeFile(join(artifacts, `${prefix}.png`), (await win.webContents.capturePage()).toPNG())
            if (tab === 'plans') {
              for (const anchor of ['heartbeat-trend-title', 'heartbeat-runs-title']) {
                await js(`document.getElementById('${anchor}').scrollIntoView({block:'start'})`)
                await settle()
                await writeFile(join(artifacts, `${prefix}-${anchor}.png`), (await win.webContents.capturePage()).toPNG())
              }
              await js('document.querySelector(".heartbeat-settings__intro button").click()')
              await wait('!!document.querySelector("[role=dialog]")')
              assert(await js('document.querySelector("[role=dialog] > header button").getAttribute("aria-label") === "关闭自动监督计划"'))
              assert.equal(await js('document.querySelector("[role=dialog] > footer").textContent'), '取消保存并启用计划')
              await js('document.querySelector("[role=dialog] > header button").click()')
              await wait('!document.querySelector("[role=dialog]")')
            }
          }
        }
        if (!empty) {
          await js('document.querySelector("#supervisor-tab-plans").click()')
          await js('[...document.querySelectorAll(".heartbeat-settings__actions button")].find(b => b.textContent === "执行记录").click()')
          await wait('document.querySelector(".supervisor-activity select")?.value === "plan" && document.querySelectorAll(".supervisor-activity__item").length === 2')
          assert(await js('!document.querySelector("#heartbeat-panel-overview, #heartbeat-runs-title")'))
          await js('[...document.querySelectorAll(".supervisor-activity button")].find(b => b.textContent === "清除筛选").click()')
          await wait('document.querySelectorAll(".supervisor-activity__item").length === 3')
        }
      }
      assert.deepEqual(errors, [])
      await writeFile(join(artifacts, 'automatic-overview-measurements.json'), JSON.stringify(reports, null, 2))
      console.log(JSON.stringify({ artifacts, cases: reports.length, errors }))
      win.destroy()
      app.quit()
      return
    }
    if (process.env.GOODBUDDY_SUPERVISOR_SIDEBAR) {
      await win.loadURL(process.env.GOODBUDDY_SUPERVISOR_URL)
      await wait('!!document.querySelector(".supervision-card")')
      await js('document.fonts.ready')
      win.show()
      win.focus()
      for (const theme of ['light', 'dark']) {
        await js(`document.documentElement.dataset.theme = '${theme}'`)
        for (const width of [480, 300, 200]) {
          win.setContentSize(width, 640)
          await js('document.querySelector(".supervision-card__header button").focus()')
          win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Tab' })
          win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Tab' })
          await settle()
          const report = await js(`(() => {
            const card = document.querySelector('.supervision-card');
            const header = card.querySelector('.supervision-card__header');
            const buttons = [...header.querySelectorAll('button')];
            return {
              width: innerWidth, scrollWidth: document.documentElement.scrollWidth,
              cardWidth: card.clientWidth, cardScrollWidth: card.scrollWidth,
              headerHeight: header.getBoundingClientRect().height,
              buttons: buttons.map(b => ({ width: b.getBoundingClientRect().width,
                height: b.getBoundingClientRect().height, background: getComputedStyle(b).backgroundColor })),
              focus: getComputedStyle(document.activeElement).outlineStyle,
              text: card.textContent
            };
          })()`)
          assert(report.scrollWidth <= report.width, `Page overflow: ${JSON.stringify(report)}`)
          assert(report.cardScrollWidth <= report.cardWidth, 'Card overflow')
          assert.equal(report.headerHeight, 34)
          assert(report.buttons.every(b => b.width === 34 && b.height === 34), 'Compact shared buttons')
          assert.equal(report.focus, 'solid')
          assert(!report.text.includes('simulated-conversation-uuid'), 'Raw UUID visible')
          reports.push({ theme, ...report })
          await writeFile(join(artifacts, `sidebar-${theme}-${width}.png`), (await win.webContents.capturePage()).toPNG())
        }
      }
      assert.deepEqual(errors, [])
      await writeFile(join(artifacts, 'sidebar-measurements.json'), JSON.stringify(reports, null, 2))
      console.log(JSON.stringify({ artifacts, cases: reports.length, errors }))
      win.destroy()
      app.quit()
      return
    }
    if (process.env.GOODBUDDY_SUPERVISOR_PLAN_MODAL) {
      await win.loadURL(process.env.GOODBUDDY_SUPERVISOR_URL + '?menu=1')
      await wait('!!document.querySelector("#supervisor-tab-plans")')
      await js('document.fonts.ready')
      await js('document.querySelector("#supervisor-tab-plans").click()')
      assert.equal(await js('document.querySelectorAll("[role=tab]").length'), 5)
      win.show()
      win.focus()
      for (const mode of ['create', 'edit']) {
        const opener = mode === 'create' ? '.heartbeat-settings__intro button' : '.heartbeat-settings__actions button[aria-label^="编辑"]'
        await js(`document.querySelector('${opener}').focus(); document.querySelector('${opener}').click()`)
        await wait('!!document.querySelector("[role=dialog]")')
        assert(await js('document.activeElement === document.querySelector("[role=dialog] input")'), 'Name initial focus')
        await js(`(() => {
          const select = document.querySelector('[aria-label="监督频率"]');
          select.value = 'weekly'; select.dispatchEvent(new Event('change', { bubbles: true }));
        })()`)
        await wait('!!document.querySelector("[aria-label=监督星期]")')
        for (const theme of ['light', 'dark']) {
          await js(`document.documentElement.dataset.theme = '${theme}'`)
          for (const [width, height] of [[1440, 1100], [390, 1100], [390, 480]]) {
            win.setContentSize(width, height)
            await settle()
            const measure = () => js(`(() => {
              const dialog = document.querySelector('[role=dialog]');
              const header = dialog.querySelector(':scope > header'), footer = dialog.querySelector(':scope > footer');
              const body = dialog.querySelector(':scope > .custom-task-dialog__content');
              const box = e => { const r = e.getBoundingClientRect(); return { left:r.left, right:r.right, top:r.top, bottom:r.bottom, width:r.width, height:r.height }; };
              const close = header.querySelector('button'), buttons = [...footer.querySelectorAll('button')];
              const hit = e => { const r = e.getBoundingClientRect(); return e.contains(document.elementFromPoint(r.x+r.width/2, r.y+r.height/2)); };
              return { width:innerWidth, height:innerHeight, pageWidth:document.documentElement.scrollWidth,
                dialog:box(dialog), header:box(header), title:box(header.querySelector('h2')), close:box(close),
                footer:box(footer), buttons:buttons.map(box), hit:[close,...buttons].every(hit),
                headerButtons:header.querySelectorAll('button').length, closeLabel:close.getAttribute('aria-label'),
                tooltip:close.title, bodyWidth:body.clientWidth, bodyScrollWidth:body.scrollWidth,
                bodyHeight:body.clientHeight, bodyScrollHeight:body.scrollHeight, bodyTop:body.scrollTop,
                footerAlign:getComputedStyle(footer).justifyContent, text:buttons.map(e=>e.textContent) };
            })()`)
            const before = await measure()
            assert(before.pageWidth <= width && before.bodyScrollWidth <= before.bodyWidth, 'No horizontal overflow')
            assert(before.dialog.top >= 0 && before.dialog.bottom <= height, 'Dialog fits viewport')
            assert(before.headerButtons === 1 && before.closeLabel === '关闭自动监督计划' && before.tooltip === before.closeLabel, 'Accessible header X only')
            assert(before.title.right <= before.close.left && before.close.right > (before.dialog.left + before.dialog.right) / 2, 'Title left, close right')
            assert.equal(before.footerAlign, 'flex-end')
            assert.equal(before.text[0], '取消')
            assert(before.buttons[0].right <= before.buttons[1].left && before.buttons[0].top === before.buttons[1].top, 'Cancel then save on same row')
            assert(before.buttons[1].right > (before.dialog.left + before.dialog.right) / 2 && before.hit, 'Footer right and controls hittable')
            await js('document.querySelector("[role=dialog] > .custom-task-dialog__content").scrollTop = 10000')
            await settle()
            const after = await measure()
            assert.deepEqual(after.header, before.header, 'Header stays visible when body scrolls')
            assert.deepEqual(after.footer, before.footer, 'Footer stays visible when body scrolls')
            assert(after.hit, 'Scrolled controls hittable')
            if (height === 480) assert(after.bodyTop > 0 && after.bodyScrollHeight > after.bodyHeight, 'Short body scrolls')
            reports.push({ mode, theme, before, after })
            await writeFile(join(artifacts, `plan-${mode}-${theme}-${width}x${height}.png`), (await win.webContents.capturePage()).toPNG())
          }
        }
        win.focus()
        win.webContents.focus()
        await js('document.querySelector("[role=dialog] > header button").focus()')
        const key = async (keyCode, modifiers = []) => {
          win.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers })
          if (keyCode === 'Enter') win.webContents.sendInputEvent({ type: 'char', keyCode: '\r' })
          win.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers })
          await settle()
        }
        await key('Tab', ['shift'])
        assert(await js('document.activeElement.matches("footer .primary-button")'), 'Shift Tab wraps to save')
        await key('Tab', ['shift'])
        assert(await js('document.activeElement.matches("footer .secondary-button")'), 'Footer cancel keyboard reachable')
        const focus = await js('({ focused: document.hasFocus(), visible: document.activeElement.matches(":focus-visible"), outline: getComputedStyle(document.activeElement).outlineStyle })')
        assert(focus.visible && focus.outline === 'solid', `Visible keyboard focus: ${JSON.stringify(focus)}`)
        await key('Enter')
        await wait('document.querySelector("[role=dialog]").textContent.includes("放弃未保存")')
        assert(await js('document.activeElement.textContent === "继续编辑"'), 'Confirmation initial focus')
        await key('Escape')
        assert(await js('document.activeElement === document.querySelector("[role=dialog] input")'), 'Escape returns to editing')
        await js('document.querySelector("[role=dialog] > header button").click()')
        await wait('!!document.querySelector("[role=dialog] .danger-solid")')
        await js('document.querySelector("[role=dialog] .danger-solid").click()')
        await wait('!document.querySelector("[role=dialog]")')
        assert(await js(`document.activeElement === document.querySelector('${opener}')`), 'Opener focus restored')
      }
      assert.deepEqual(errors, [])
      await writeFile(join(artifacts, 'plan-modal-measurements.json'), JSON.stringify(reports, null, 2))
      console.log(JSON.stringify({ artifacts, cases: reports.length, errors }))
      win.destroy()
      app.quit()
      return
    }
    await open(false)
    await js(
      'document.querySelector(".supervisor-workspace__legend .link-button").click()'
    )
    await wait(
      '!document.querySelector(".supervisor-workspace__map.has-selection")'
    )
    assert(await js(`(() => {
      const ring = document.querySelector('.supervisor-workspace__timeline-ring');
      const start = ring.getPointAtLength(0), next = ring.getPointAtLength(20), end = ring.getPointAtLength(ring.getTotalLength());
      return next.x > start.x && next.y < start.y && end.x < start.x && end.y > 490;
    })()`), 'Time must run counter-clockwise and leave a bottom gap')
    for (const theme of ['light', 'dark']) {
      await js(`document.documentElement.dataset.theme = '${theme}'`)
      for (const width of [1440, 1024, 390]) {
        win.setContentSize(width, 1100)
        await settle()
        const report = await js(`(() => {
        const q = s => document.querySelector('.supervisor-workspace' + s);
        const box = e => { const r = e.getBoundingClientRect(); return { width: r.width, height: r.height, top: r.top, bottom: r.bottom, clientWidth: e.clientWidth, scrollWidth: e.scrollWidth }; };
        const svg = q('__map'), scroller = q('__map-scroll');
        const texts = [...svg.querySelectorAll('text')].map(e => {
          const b = e.getBBox(), c = getComputedStyle(e), r = e.getBoundingClientRect();
          return { text: e.textContent, width: b.width, height: b.height, fontSize: c.fontSize,
            screenFontSize: parseFloat(c.fontSize) * e.getScreenCTM().a, fill: c.fill,
             inSvg: b.x >= 0 && b.y >= 0 && b.x + b.width <= 760 && b.y + b.height <= 620,
            painted: c.display !== 'none' && c.visibility === 'visible' && c.fill !== 'none' && Number(c.opacity) > 0 && r.width > 0,
            x: b.x, y: b.y };
        });
        const tokens = Object.fromEntries(${process.env.GOODBUDDY_SUPERVISOR_TOKENS}.map(t => [t, getComputedStyle(q('')).getPropertyValue(t).trim()]));
        return { viewport: innerWidth, page: box(document.documentElement), shell: box(document.querySelector('.page-shell')),
          container: box(q('')), grid: getComputedStyle(q('__graph-layout')).gridTemplateColumns,
          list: box(q('__graph-list')), canvas: box(q('__graph-canvas')), detail: box(q('__detail')), svg: box(svg), scroller: box(scroller), texts, tokens };
      })()`)
        reports.push({ theme, ...report })
        await writeFile(
          join(artifacts, `${theme}-${width}.png`),
          (await win.webContents.capturePage()).toPNG()
        )
        assert(report.page.scrollWidth <= width, JSON.stringify(report))
        if (width >= 1024) {
          assert(Math.abs(report.list.top - report.canvas.top) < 1, 'Sidebar top alignment')
          assert(Math.abs(report.list.bottom - report.canvas.bottom) < 1,
            `Sidebar must fill canvas height: ${JSON.stringify({ list: report.list, canvas: report.canvas })}`)
          if (width === 1440)
            assert(Math.abs(report.list.bottom - report.detail.bottom) < 1, 'Sidebar/detail height alignment')
        }
        assert(
          report.shell.scrollWidth <= report.shell.clientWidth,
          'Shell overflow'
        )
        assert(
          report.container.scrollWidth <= report.container.clientWidth,
          'Container overflow'
        )
        assert(
          report.texts.every(
            (text) => text.inSvg && text.painted && text.screenFontSize >= 11
          ),
          'Clipped or invisible SVG text'
        )
        for (const [index, a] of report.texts.entries()) {
          for (const b of report.texts.slice(index + 1)) {
            assert(
              !(
                a.x < b.x + b.width &&
                a.x + a.width > b.x &&
                a.y < b.y + b.height &&
                a.y + a.height > b.y
              ),
              `Overlapping labels: ${a.text} / ${b.text}`
            )
          }
        }
        assert(
          Object.values(report.tokens).every(Boolean),
          'Unresolved CSS variable'
        )
        assert(
          report.texts.some((text) => text.text === '工作过程'),
          'Missing real entity label'
        )
        if (width === 1440)
          assert(
            report.canvas.width > report.list.width + report.detail.width,
            'Canvas must take priority'
          )
        if (width === 1440) {
          await js('document.querySelector(".supervisor-workspace__graph-layout").scrollIntoView({block:"end"})')
          await settle()
          await writeFile(join(artifacts, `${theme}-1440-aligned-bottom.png`), (await win.webContents.capturePage()).toPNG())
          await js('document.querySelector(".page-shell").scrollTop = 0')
        }
        if (width >= 1024)
          assert.equal(
            report.scroller.scrollWidth,
            report.scroller.clientWidth,
            'Desktop canvas must fit'
          )
        if (width === 390) {
          assert(
            report.scroller.scrollWidth > report.scroller.clientWidth,
            'Keep mobile labels readable with local scrolling'
          )
          await js(
            'document.querySelector(".supervisor-workspace__map-scroll").scrollLeft = 600'
          )
          assert(
            await js(
              'document.querySelector(".supervisor-workspace__map-scroll").scrollLeft > 0'
            )
          )
          await writeFile(
            join(artifacts, `${theme}-${width}-scrolled.png`),
            (await win.webContents.capturePage()).toPNG()
          )
        }
      }
    }
    // The viewport stays wide while the actual workspace is constrained.
    win.setContentSize(1440, 1100)
    await js(
      `document.documentElement.dataset.theme = 'light'; document.querySelector('.supervisor-workspace__map [aria-label="观察工作过程"]').dispatchEvent(new MouseEvent('click', {bubbles:true}))`
    )
    await settle()
    await js(
      'document.querySelector(".supervisor-workspace__detail > .link-button").click()'
    )
    await wait('!!document.querySelector(".supervisor-workspace__source")')
    assert(
      await js(
        'document.querySelector(".supervisor-workspace__source").textContent.includes("不是真实用户数据")'
      )
    )
    await settle()
    await writeFile(
      join(artifacts, 'selected-source-1440.png'),
      (await win.webContents.capturePage()).toPNG()
    )
    win.setContentSize(390, 1100)
    await js(
      'document.querySelector(".supervisor-workspace__detail").scrollIntoView({block:"start"})'
    )
    await settle()
    await writeFile(
      join(artifacts, 'selected-source-390.png'),
      (await win.webContents.capturePage()).toPNG()
    )
    assert(
      await js('document.documentElement.scrollWidth <= innerWidth'),
      'Mobile source overflow'
    )
    win.setContentSize(1440, 1100)
    for (const width of [800, 860, 861, 980, 1000, 1010, 1110, 1190, 1191]) {
      await js(
        `document.querySelector('.supervisor-workspace').style.width = '${width}px'`
      )
      await settle()
      const result = await js(
        `(() => { const e = document.querySelector('.supervisor-workspace'); return { width: e.clientWidth, scrollWidth: e.scrollWidth, columns: getComputedStyle(e.querySelector('.supervisor-workspace__graph-layout')).gridTemplateColumns }; })()`
      )
      assert.equal(result.width, result.scrollWidth, 'Breakpoint overflow')
      reports.push({ constrainedContainer: result })
    }
    await win.loadURL(process.env.GOODBUDDY_SUPERVISOR_URL + '?short=1')
    await wait('!!document.querySelector("#supervisor-tab-graph")')
    await js('document.querySelector("#supervisor-tab-graph").click()')
    await wait('!!document.querySelector(".supervisor-workspace__map")')
    for (const width of [1440, 390]) {
      win.setContentSize(width, 1100)
      await settle()
      const short = await js(`(() => {
        const list = document.querySelector('.supervisor-workspace__graph-list');
        const r = list.getBoundingClientRect();
        return { width: innerWidth, height: r.height, clientHeight: list.clientHeight, scrollHeight: list.scrollHeight,
          canvasHeight: document.querySelector('.supervisor-workspace__graph-canvas').getBoundingClientRect().height,
          buttonHeights: [...list.querySelectorAll('button')].map(e => e.getBoundingClientRect().height) };
      })()`)
      assert(short.buttonHeights.every(height => height < 80), 'Short rows must not stretch to fill space')
      assert.equal(short.scrollHeight, short.clientHeight, 'Short list must not acquire artificial overflow')
      if (width === 1440) assert(Math.abs(short.height - short.canvasHeight) < 1, 'Short sidebar must still fill its row')
      else assert(short.height <= 320, 'Short mobile list must use its natural height')
      reports.push({ shortList: short })
      await js('document.querySelector(".supervisor-workspace__graph-list").scrollIntoView({block:"end"})')
      await settle()
      await writeFile(join(artifacts, `short-${width}.png`), (await win.webContents.capturePage()).toPNG())
    }
    win.setContentSize(1440, 1100)
    await open(true)
    for (const width of [1440, 1024, 390]) {
      win.setContentSize(width, 1100)
      await settle()
      const scrolling = await js(`(() => {
        const list = document.querySelector('.supervisor-workspace__graph-list');
        const canvas = document.querySelector('.supervisor-workspace__graph-canvas');
        const shell = document.querySelector('.page-shell');
        list.scrollIntoView({block:'end'});
        const pageHeight = shell.scrollHeight, pageTop = shell.scrollTop;
        list.scrollTop = list.scrollHeight;
        const last = list.lastElementChild.getBoundingClientRect();
        const button = list.querySelector('button:last-of-type');
        const b = button.getBoundingClientRect(), r = list.getBoundingClientRect();
        return { width: innerWidth, height: r.height, canvasHeight: canvas.getBoundingClientRect().height,
          clientHeight: list.clientHeight, scrollHeight: list.scrollHeight, scrollTop: list.scrollTop,
          bottomGap: r.bottom - last.bottom,
          paddingBottom: parseFloat(getComputedStyle(list).paddingBottom),
          bottomVisible: last.bottom <= r.bottom && last.top >= r.top,
          lastButtonHit: button.contains(document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2)),
          pageStable: pageHeight === shell.scrollHeight && pageTop === shell.scrollTop,
          pageHeight };
      })()`)
      assert(scrolling.scrollHeight > scrolling.clientHeight, 'Dense list must scroll locally')
      assert(Math.abs(scrolling.scrollTop + scrolling.clientHeight - scrolling.scrollHeight) <= 1, 'List bottom unreachable')
      assert(scrolling.bottomVisible && scrolling.lastButtonHit, 'Last relation and trailing copy must be visible')
      assert(Math.abs(scrolling.bottomGap - scrolling.paddingBottom) <= 1,
        `List must use the full scroll area, leaving only its padding: ${JSON.stringify(scrolling)}`)
      assert(scrolling.pageStable, 'List scrolling must not move or grow the page')
      if (width >= 1024)
        assert(Math.abs(scrolling.height - scrolling.canvasHeight) < 1, 'Dense list must follow canvas height')
      else
        assert(scrolling.height <= 320, 'Single-column list must remain bounded')
      reports.push({ denseScrolling: scrolling })
      await settle()
      await writeFile(join(artifacts, `dense-bottom-${width}.png`), (await win.webContents.capturePage()).toPNG())
    }
    win.setContentSize(1440, 1100)
    await js(
      'document.querySelector(".supervisor-workspace__graph-list button:last-of-type").click()'
    )
    await settle()
    assert(
      await js('document.querySelectorAll("[data-relation]").length === 1'),
      'Selected relation endpoints must remain visible'
    )
    const target = await js(
      `(() => { const e = document.querySelectorAll('.supervisor-workspace__graph-list button')[79]; e.scrollIntoView({block:'center'}); const r = e.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), hit: e.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)) }; })()`
    )
    assert(target.hit, 'Last event is not reachable')
    win.webContents.sendInputEvent({
      type: 'mouseDown',
      x: target.x,
      y: target.y,
      button: 'left',
      clickCount: 1
    })
    win.webContents.sendInputEvent({
      type: 'mouseUp',
      x: target.x,
      y: target.y,
      button: 'left',
      clickCount: 1
    })
    await settle()
    assert(
      await js(
        `!!document.querySelector('.supervisor-workspace__map [aria-label="模拟事件 80"][aria-pressed=true]')`
      )
    )
    assert.equal(
      await js(
        'document.querySelectorAll(".supervisor-workspace__graph-list button").length'
      ),
      121
    )
    const positions = await js(
      '[...document.querySelectorAll(".supervisor-workspace__node:not(.supervisor-workspace__entity) circle")].map(e => [e.getAttribute("cx"), e.getAttribute("cy")].join())'
    )
    assert.equal(new Set(positions).size, 8)
    assert(await js(`(() => {
      return [...document.querySelectorAll('.supervisor-workspace__event-index')].every(e => {
        const range = document.createRange(); range.selectNodeContents(e);
        const tops = [...range.getClientRects()].map(r => r.top);
        return Math.max(...tops) - Math.min(...tops) < 1;
      });
    })()`), 'Dense event numbers must not wrap')
    await js(
      'document.querySelector(".supervisor-workspace__graph-canvas").scrollIntoView({block:"start"})'
    )
    await settle()
    await writeFile(
      join(artifacts, 'dense-selected.png'),
      (await win.webContents.capturePage()).toPNG()
    )
    await js('document.querySelector("#supervisor-tab-settings").click()')
    await settle()
    assert.equal(
      await js('document.querySelectorAll("h1").length'),
      1,
      'Duplicate settings h1'
    )
    await writeFile(
      join(artifacts, 'settings.png'),
      (await win.webContents.capturePage()).toPNG()
    )
    assert.equal(await js('document.querySelectorAll("[role=tablist]").length'), 1, 'No nested settings menu')
    for (const width of [1440, 1024, 390]) {
      win.setContentSize(width, 1100)
      await js('document.querySelector(".page-shell").scrollTop = 0')
      await settle()
      const sizes = await js(`(() => {
        const shell = document.querySelector('.page-shell');
        return { viewport: innerWidth, page: document.documentElement.scrollWidth,
          clientWidth: shell.clientWidth, scrollWidth: shell.scrollWidth, headings: document.querySelectorAll('h1').length };
      })()`)
      assert(
        sizes.page <= width && sizes.scrollWidth <= sizes.clientWidth,
        'Settings overflow'
      )
      assert.equal(sizes.headings, 1)
      reports.push({ settings: sizes })
      await writeFile(
        join(artifacts, `settings-plans-${width}.png`),
        (await win.webContents.capturePage()).toPNG()
      )
    }
    for (const query of [
      'story=1',
      'story=2',
      'long=1',
      'state=loading',
      'state=error',
      'state=unavailable',
      'state=empty'
    ]) {
      await win.loadURL(process.env.GOODBUDDY_SUPERVISOR_URL + '?' + query)
      await wait('!!document.querySelector("#supervisor-tab-graph")')
      await js('document.querySelector("#supervisor-tab-graph").click()')
      await wait(
        query === 'state=loading'
          ? '!!document.querySelector(".empty-state")'
          : '!document.querySelector(".supervisor-workspace[aria-busy=true]")'
      )
      for (const width of [1440, 1024, 390]) {
        win.setContentSize(width, 1100)
        await settle()
        assert(
          await js('document.documentElement.scrollWidth <= innerWidth'),
          `Overflow: ${query}/${width}`
        )
        if (!query.startsWith('state=')) {
          const labels = await js(
            '[...document.querySelectorAll(".supervisor-workspace__map text")].map(e => { const b = e.getBBox(); return { text:e.textContent, x:b.x, y:b.y, width:b.width, height:b.height } })'
          )
          for (const [index, a] of labels.entries()) {
            for (const b of labels.slice(index + 1)) {
              assert(
                !(
                  a.x < b.x + b.width &&
                  a.x + a.width > b.x &&
                  a.y < b.y + b.height &&
                  a.y + a.height > b.y
                ),
                `Overlapping ${query}: ${a.text} / ${b.text}`
              )
            }
          }
          reports.push({ scenario: query, viewport: width, labels })
        }
        await writeFile(
          join(artifacts, `${query.replace('=', '-')}-${width}.png`),
          (await win.webContents.capturePage()).toPNG()
        )
      }
    }
    await js('document.querySelector("#supervisor-tab-overview").click()')
    await settle()
    await js(
      'document.querySelector(".supervisor-workspace__toolbar .primary-button").click()'
    )
    await wait(
      '!!document.querySelector(".supervisor-workspace__inline-error")'
    )
    assert(
      await js(
        'document.querySelector("[role=alert]").textContent.includes("模型暂时不可用")'
      )
    )
    await writeFile(
      join(artifacts, 'manual-review-error-390.png'),
      (await win.webContents.capturePage()).toPNG()
    )
    await js('document.querySelector("#supervisor-tab-settings").click()')
    await wait('!!document.querySelector(".heartbeat-settings")')
    assert(await js('!document.querySelector("#supervisor-panel-settings [role=tablist], #supervisor-panel-settings .scope-badge")'))
    assert(await js('!document.querySelector("#heartbeat-panel-plans")'), 'Plans must not live in settings')
    await js('document.querySelector("#supervisor-tab-plans").click()')
    await js('document.querySelector(".heartbeat-settings__intro button").focus(); document.querySelector(".heartbeat-settings__intro button").click()')
    await wait('!!document.querySelector("[role=dialog]")')
    assert(await js('document.activeElement === document.querySelector("[role=dialog] input")'), 'Plan initial focus')
    await js(`(() => {
      const select = document.querySelector('[aria-label="监督频率"]');
      select.value = 'weekly'; select.dispatchEvent(new Event('change', { bubbles: true }));
    })()`)
    await wait('!!document.querySelector("[aria-label=监督星期]")')
    for (const theme of ['light', 'dark']) {
      await js(`document.documentElement.dataset.theme = '${theme}'`)
      for (const width of [1440, 1024, 390]) {
        win.setContentSize(width, 1100)
        await settle()
        const settings = await js(`(() => {
          const root = document.querySelector('[role=dialog]');
          return { width: innerWidth, pageWidth: document.documentElement.scrollWidth,
            clientWidth: root.clientWidth, scrollWidth: root.scrollWidth,
            fields: [...root.querySelectorAll('input, select')].filter(e => e.getClientRects().length).map(e => {
              const r = e.getBoundingClientRect();
              return { left: r.left, right: r.right, height: r.height };
            }), text: root.textContent };
        })()`)
        assert(settings.pageWidth <= width && settings.scrollWidth <= settings.clientWidth, 'Settings overflow')
        assert(settings.fields.every(r => r.left >= 0 && r.right <= width && r.height >= 28), 'Clipped settings fields')
        reports.push({ scenario: 'automatic-supervision-modal', theme, ...settings })
        await writeFile(join(artifacts, `plan-modal-${theme}-${width}.png`), (await win.webContents.capturePage()).toPNG())
        if (width === 390) {
          win.setContentSize(390, 720)
          await js('document.querySelector("[role=dialog] .heartbeat-settings__submit").scrollIntoView({block:"end"})')
          await settle()
          assert(await js(`(() => {
            const button = document.querySelector('[role=dialog] .heartbeat-settings__submit');
            const r = button.getBoundingClientRect();
            return r.left >= 16 && r.right <= innerWidth - 16 && r.bottom <= innerHeight && button.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2));
          })()`), 'Short modal save button must be reachable')
          await writeFile(join(artifacts, `plan-modal-${theme}-390-short.png`), (await win.webContents.capturePage()).toPNG())
        }
      }
    }
    await js('document.querySelector("[role=dialog]").dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))')
    await wait('document.querySelector("[role=dialog]").textContent.includes("放弃未保存")')
    await js('document.querySelector("[role=dialog] .danger-solid").click()')
    await wait('!document.querySelector("[role=dialog]")')
    assert(await js('document.activeElement === document.querySelector(".heartbeat-settings__intro button")'), 'Plan focus restored')
    await js('document.querySelector("#supervisor-tab-activity").click()')
    await wait('document.querySelectorAll(".supervisor-activity__item").length === 3')
    for (const theme of ['light', 'dark']) {
      await js(`document.documentElement.dataset.theme = '${theme}'`)
      for (const width of [1440, 1024, 390]) {
        win.setContentSize(width, width === 390 ? 720 : 1100)
        await settle()
        const activity = await js(`(() => {
          const root = document.querySelector('.supervisor-activity');
          const tabs = document.querySelector('#supervisor-tab-activity').closest('[role=tablist]');
          return { width: innerWidth, pageWidth: document.documentElement.scrollWidth,
            clientWidth: root.clientWidth, scrollWidth: root.scrollWidth,
            tabsHeight: tabs.getBoundingClientRect().height,
            fields: [...root.querySelectorAll('dd, button')].map(e => {
              const r = e.getBoundingClientRect(); return { left: r.left, right: r.right };
            }), text: root.textContent };
        })()`)
        assert(activity.pageWidth <= width && activity.scrollWidth <= activity.clientWidth, 'Activity overflow')
        assert(activity.tabsHeight >= 32, 'Activity tabs must not collapse')
        assert(activity.fields.every(r => r.left >= 0 && r.right <= width), 'Clipped activity metadata or actions')
        assert(activity.text.includes('运行中') && activity.text.includes('失败') && activity.text.includes('已完成'), 'Missing execution states')
        reports.push({ scenario: 'supervisor-activity', theme, ...activity })
        await writeFile(join(artifacts, `activity-${theme}-${width}.png`), (await win.webContents.capturePage()).toPNG())
      }
    }
    await win.loadURL(process.env.GOODBUDDY_SUPERVISOR_URL + '?menu=1')
    await wait('!!document.querySelector(".supervisor-workspace__recap")')
    win.show()
    win.focus()
    for (const theme of ['light', 'dark']) {
      await js(`document.documentElement.dataset.theme = '${theme}'`)
      for (const width of [1440, 390]) {
        win.setContentSize(width, width === 390 ? 720 : 1100)
        for (const tab of ['overview', 'graph', 'plans', 'settings', 'activity']) {
          await js(`document.querySelector('#supervisor-tab-${tab}').click(); document.querySelector('.page-shell').scrollTop = 0`)
          await settle()
          const menuLayout = await js(`(() => {
            const panel = document.querySelector('#supervisor-panel-${tab}');
            return { width: innerWidth, pageWidth: document.documentElement.scrollWidth,
              panelWidth: panel.clientWidth, scrollWidth: panel.scrollWidth,
              tabs: [...document.querySelectorAll('[role=tab]')].map(e => e.textContent),
              nestedMenus: panel.querySelectorAll('[role=tablist]').length,
              reports: !!panel.querySelector('#heartbeat-reports-title'),
              reportWidth: panel.querySelector('#heartbeat-panel-history > section')?.getBoundingClientRect().width,
              suggestions: !!panel.querySelector('#heartbeat-memory-title'),
              audit: !!panel.querySelector('#heartbeat-runs-title'),
              plans: !!panel.querySelector('#heartbeat-panel-plans'),
              settingsBadge: !!panel.querySelector('.scope-badge'),
              headings: [...panel.querySelectorAll('h2')].map(e => e.textContent),
              refresh: [...panel.querySelectorAll('button')].some(e => e.textContent.includes('刷新')) };
          })()`)
          assert.deepEqual(menuLayout.tabs, ['工作回顾', '故事线图谱', '自动监督', '活动记录', '设置'])
          assert.equal(menuLayout.nestedMenus, 0)
          assert(menuLayout.pageWidth <= width && menuLayout.scrollWidth <= menuLayout.panelWidth, 'Menu panel overflow')
           assert.equal(menuLayout.reports, tab === 'plans')
           if (tab === 'plans') assert(Math.abs(menuLayout.reportWidth - menuLayout.panelWidth) <= 1, 'Reports must use full reading width')
           assert.equal(menuLayout.suggestions, tab === 'plans')
          assert.equal(menuLayout.audit, tab === 'plans')
          assert.equal(menuLayout.plans, tab === 'plans')
          if (tab === 'settings') {
            assert(!menuLayout.settingsBadge && !menuLayout.refresh, 'Redundant settings badge/refresh')
            assert(menuLayout.headings.includes('回顾算法') && menuLayout.headings.includes('模型超时与并发'))
          }
          reports.push({ scenario: 'menu-placement', theme, tab, ...menuLayout })
          await writeFile(join(artifacts, `menu-${tab}-${theme}-${width}.png`), (await win.webContents.capturePage()).toPNG())
          const anchors = tab === 'settings' ? ['.heartbeat-settings__editor:last-child']
             : tab === 'plans' ? ['#heartbeat-panel-overview', '#heartbeat-panel-suggestions', '#heartbeat-panel-history', '[aria-labelledby=heartbeat-runs-title]'] : []
          for (const [index, anchor] of anchors.entries()) {
            await js(`document.querySelector('${anchor}').scrollIntoView({block:'start'})`)
            await settle()
            await writeFile(join(artifacts, `menu-${tab}-${theme}-${width}-section-${index}.png`), (await win.webContents.capturePage()).toPNG())
          }
        }
      }
    }
    await js('document.querySelector("#supervisor-tab-plans").click()')
    await js('[...document.querySelectorAll(".heartbeat-settings__actions button")].find(b => b.textContent === "执行记录").click()')
    await wait('document.querySelector(".supervisor-activity select")?.value === "plan" && document.querySelectorAll(".supervisor-activity__item").length === 2')
    await js('document.querySelector(".page-shell").scrollTop = 0')
    await settle()
    await writeFile(join(artifacts, 'activity-exact-plan.png'), (await win.webContents.capturePage()).toPNG())
    await js('document.querySelector("#supervisor-tab-settings").focus()')
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Left' })
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Left' })
    await settle()
    assert(await js('document.activeElement.id === "supervisor-tab-activity" && document.activeElement.getAttribute("aria-selected") === "true"'), 'Native keyboard tab navigation')
    assert.deepEqual(errors, [])
    await writeFile(
      join(artifacts, 'measurements.json'),
      JSON.stringify(reports, null, 2)
    )
    console.log(
      JSON.stringify(
        {
          artifacts,
          cases: reports.map(({ texts, tokens, ...report }) => ({
            ...report,
            svgTexts: texts?.length,
            resolvedTokens: tokens && Object.keys(tokens).length
          })),
          errors
        },
        null,
        2
      )
    )
    win.destroy()
    app.quit()
  })
  .catch((error) => {
    console.error(error)
    app.exit(1)
  })

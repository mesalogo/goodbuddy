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
    await js('document.querySelector("#heartbeat-tab-plans").click()')
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
    assert(await js('document.querySelector("#heartbeat-tab-plans").getAttribute("aria-selected") === "true"'))
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
          const root = document.querySelector('.heartbeat-settings');
          return { width: innerWidth, pageWidth: document.documentElement.scrollWidth,
            clientWidth: root.clientWidth, scrollWidth: root.scrollWidth,
            fields: [...root.querySelectorAll('input, select')].map(e => {
              const r = e.getBoundingClientRect();
              return { left: r.left, right: r.right, height: r.height };
            }), text: root.textContent };
        })()`)
        assert(settings.pageWidth <= width && settings.scrollWidth <= settings.clientWidth, 'Settings overflow')
        assert(settings.fields.every(r => r.left >= 0 && r.right <= width && r.height >= 28), 'Clipped settings fields')
        assert(settings.text.includes('尚未配置自动监督，目前仅支持手动回顾'), 'Missing unconfigured state')
        reports.push({ scenario: 'automatic-supervision-settings', theme, ...settings })
        await writeFile(join(artifacts, `settings-${theme}-${width}.png`), (await win.webContents.capturePage()).toPNG())
      }
    }
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

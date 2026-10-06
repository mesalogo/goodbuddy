import { app, BrowserWindow } from 'electron'
import assert from 'node:assert/strict'
import { mkdir, writeFile as writeArtifact } from 'node:fs/promises'
import { join } from 'node:path'
import process from 'node:process'
import console from 'node:console'
import { setTimeout } from 'node:timers/promises'
import { validateSupervisorSelection } from './supervisor-selection-driver.mjs'
import { validateStoryGraphFocus } from './story-graph-focus-driver.mjs'

const directory = process.env.GOODBUDDY_SUPERVISOR_DIRECTORY
const artifacts = process.env.GOODBUDDY_SUPERVISOR_ARTIFACTS || directory
const writeFile = (path, data) => process.env.GOODBUDDY_SUPERVISOR_NO_SCREENSHOT && path.endsWith('.png') ? Promise.resolve() : writeArtifact(path, data)
app.setPath('userData', join(directory, 'profile'))
app.commandLine.appendSwitch('force-device-scale-factor', '1')
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion')
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
    if (process.env.GOODBUDDY_STORY_GRAPH_FOCUS) {
      await validateStoryGraphFocus(win, js, wait, process.env.GOODBUDDY_SUPERVISOR_URL)
      assert.deepEqual(errors, [])
      win.destroy(); app.quit(); return
    }
    if (process.env.GOODBUDDY_SUPERVISOR_WINDOWING) {
      await validateSupervisorSelection(win, js, wait, process.env.GOODBUDDY_SUPERVISOR_URL)
      assert.deepEqual(errors, [])
      console.log('Supervisor source Electron selection, history, source and edit interactions passed')
      win.destroy(); app.quit(); return
    }
    const selectHistory = async (id) => {
      await js('document.querySelector(".supervisor-workspace__result-navigation button").click()')
      await wait('!!document.querySelector(".supervisor-workspace__history-menu")')
      await js(`[...document.querySelectorAll('.supervisor-workspace__history-menu button')].find(item => item.value === ${JSON.stringify(id)}).click()`)
    }
    if (process.env.GOODBUDDY_SUPERVISOR_HISTORY) {
      await win.loadURL(process.env.GOODBUDDY_SUPERVISOR_URL + '?recap=1')
      await wait('document.querySelector(".supervisor-workspace")?.getAttribute("aria-busy") === "false"')
      for (const width of [1440, 390]) for (const theme of ['light', 'dark']) {
        win.setContentSize(width, 800)
        await wait(`innerWidth === ${width}`)
        await js(`document.documentElement.dataset.theme = '${theme}'`)
        await js('document.querySelector(".supervisor-workspace__result-navigation button").click()')
        await wait('!!document.querySelector(".supervisor-workspace__history-menu")')
        await settle()
        const report = await js(`(() => {
          const menu = document.querySelector('.supervisor-workspace__history-menu');
          const context = document.querySelector('.supervisor-workspace__review-context');
          const r = menu.getBoundingClientRect();
          return { left:r.left, right:r.right, bottom:r.bottom, top:r.top,
            overflow:menu.scrollWidth > menu.clientWidth + 1 || context.scrollWidth > context.clientWidth + 1,
            options:[...menu.querySelectorAll('[role=menuitemradio]')].map(e => e.textContent),
            duplicate:!!context.querySelector('.supervisor-workspace__review-meta') };
        })()`)
        assert(report.left >= 16 && report.right <= width - 16 && report.top >= 16 && report.bottom <= 784)
        assert(!report.overflow && !report.duplicate)
        assert.equal(report.options.length, 2)
        assert(report.options.every(text => text.includes('生成于') && text.includes('全局') && text.includes('时间范围')))
        await js('document.activeElement.dispatchEvent(new KeyboardEvent("keydown", {key:"Escape",bubbles:true}))')
        reports.push({ width, theme, ...report })
      }
      await selectHistory('older-result')
      await wait('document.querySelector(".supervisor-workspace")?.getAttribute("aria-busy") === "false"')
      await js('document.querySelector("#supervisor-tab-graph").click()')
      assert.equal(await js('document.querySelector(".supervisor-workspace__result-navigation button").value'), 'older-result')
      assert.deepEqual(errors, [])
      console.log(JSON.stringify({ history: 'passed', reports }))
      win.destroy(); app.quit(); return
    }
    const checkSpiral = async () => {
      const report = await js(`(() => {
        const heading = document.querySelector('.story-graph-3d__toolbar');
        const viewport = document.querySelector('.story-graph-3d__viewport');
        const picker = document.querySelector('.story-graph-3d__picker');
        const info = heading.querySelector('button[title="图例"]');
        const h = heading.getBoundingClientRect(), v = viewport.getBoundingClientRect(), p = picker.getBoundingClientRect();
        return {scene:JSON.parse(document.documentElement.dataset.helix),
          levels:heading.parentElement.children.length, headingBottom:h.bottom, canvasTop:v.top,
          pickerInHeading:heading.contains(picker), pickerTop:p.top, headingTop:h.top,
          rootFont:getComputedStyle(heading.querySelector('strong')).fontSize,
          iconOnly:info.textContent === '', infoLabel:info.getAttribute('aria-label'),
          presets:document.querySelectorAll('.story-graph-3d__views,[aria-label="视角"]').length,
          caption:document.querySelectorAll('.story-graph-3d__scale').length};
      })()`)
      assert.equal(report.levels, 2, 'Only heading controls and canvas')
      assert.equal(report.canvasTop, report.headingBottom, 'No inner toolbar row between title and canvas')
      assert(report.pickerInHeading && report.pickerTop >= report.headingTop)
      assert.equal(report.rootFont, '13px')
      assert(report.iconOnly && report.infoLabel === '图例')
      assert.equal(report.presets, 0); assert.equal(report.caption, 0)
      const { timeline, marks, staves } = report.scene
      for (const mark of marks) assert(mark.storyId ? mark.color !== timeline.colors[0] : mark.color === timeline.colors[0], 'Assigned and unassigned marks keep their color semantics')
      assert.equal(timeline.groups.reduce((total, group) => total + group.count, 0), timeline.indices, 'Every face belongs to the single helix')
      assert(timeline.groups.some(group => group.materialIndex === 0), 'Sparse events leave neutral gaps')
      const assignedIntervals = timeline.intervals.filter(interval => interval.event?.storyId)
      if (assignedIntervals.length) assert(timeline.groups.some(group => group.materialIndex > 0), 'Saved intervals produce colored tube faces')
      for (const interval of assignedIntervals) {
        const mark = marks.find(mark => mark.ids.includes(interval.event.id))
        assert(mark && mark.storyId === interval.event.storyId)
        assert(timeline.colors.includes(mark.color), 'Event mark and interval share story palette')
        assert(interval.from >= interval.event.t && interval.to <= interval.event.end)
      }
      for (const group of timeline.groups.filter(group => group.materialIndex > 0)) {
        const covered = assignedIntervals.filter(interval => interval.from < group.to && interval.to > group.from)
        const duration = covered.reduce((sum, interval) => sum + Math.max(0, Math.min(interval.to, group.to) - Math.max(interval.from, group.from)), 0)
        assert(Math.abs(duration - (group.to - group.from)) < 200, 'Actual colored vertices never cover a gap (Float32 geometry tolerance)')
        for (const interval of covered.filter(interval => Math.min(interval.to, group.to) - Math.max(interval.from, group.from) > 200)) {
          assert.equal(timeline.colors[group.materialIndex], marks.find(mark => mark.ids.includes(interval.event.id))?.color)
        }
      }
      for (const stave of staves) for (const mark of marks.filter(mark => mark.storyId === stave.id)) assert.equal(stave.color, mark.color)
      await js(`document.querySelector('.story-graph-3d__toolbar button[title="图例"]').focus(); document.activeElement.click()`)
      await wait('!!document.querySelector(".inline-help__content")')
      assert(await js('document.activeElement.getAttribute("aria-expanded") === "true"'))
      await js('document.activeElement.dispatchEvent(new KeyboardEvent("keydown", {key:"Escape",bubbles:true}))')
      await wait('!document.querySelector(".inline-help__content")')
      assert(await js('document.activeElement.getAttribute("title") === "图例"'), 'Info Escape retains trigger focus')
      return { coloredIntervals: assignedIntervals.length, coloredGroups: timeline.groups.filter(group => group.materialIndex > 0).length,
        marks: marks.length, assignedEvents: marks.filter(mark => mark.storyId).flatMap(mark => mark.ids).length,
        unassignedEvents: marks.filter(mark => !mark.storyId).flatMap(mark => mark.ids).length }
    }
    const capturePage = async () => process.env.GOODBUDDY_SUPERVISOR_NO_SCREENSHOT
      ? { toPNG: () => new Uint8Array() }
      : win.webContents.capturePage()
    if (process.env.GOODBUDDY_SUPERVISOR_BACKUP) {
      const resultId = process.env.GOODBUDDY_SUPERVISOR_RESULT
      assert(resultId, 'Specify the historical result to measure')
      await win.loadURL(process.env.GOODBUDDY_SUPERVISOR_URL + '?spiral=1&portable=1')
      await wait('document.querySelector(".supervisor-workspace")?.getAttribute("aria-busy") === "false"')
      await js('document.querySelector("#supervisor-tab-graph").click()')
      await selectHistory(resultId)
      await wait('document.querySelector(".supervisor-workspace")?.getAttribute("aria-busy") === "false" && document.querySelectorAll(".supervisor-workspace__list-panel button").length === 21')
      await js('[...document.querySelectorAll("button")].find(b => b.textContent === "时间螺旋").click()')
      await wait('JSON.parse(document.documentElement.dataset.helix || "null")?.dots.length === 21')
      await js('document.fonts.ready')
      await settle()
      const geometry = await js('JSON.parse(document.documentElement.dataset.helix)')
      const initialCamera = await js('JSON.parse(document.documentElement.dataset.camera)')
      assert(Math.abs(initialCamera[1] / 900 - Math.sin(0.38)) < 1e-6, 'Default oblique camera')
      const expected = await js(`fetch('/portable-review.json').then(r=>r.json()).then(data=>data.graphs[${JSON.stringify(resultId)}].events.map(e=>e.id))`)
      assert.deepEqual([...geometry.events].sort(), [...expected].sort())
      assert.deepEqual([...geometry.dots].sort(), [...expected].sort(), 'Real event clusters on the helix, not just empty staves')
      assert.equal(geometry.points.length, 2801, 'Actual rings of one continuous tube for point-only history')
      assert(geometry.clusters > 1 && geometry.clusters <= 21, 'Events occupy multiple real time positions after layout')
      const radii = geometry.points.map(point => point[0])
      assert(Math.max(...radii) - Math.min(...radii) > 40)
      for (const [width, theme] of [[1440, 'light'], [1440, 'dark'], [1024, 'light'], [390, 'light'], [390, 'dark']]) {
        win.setContentSize(width, 1000)
        await wait(`innerWidth === ${width} && innerHeight === 1000`)
        await js(`document.documentElement.dataset.theme = '${theme}'`)
        await settle()
        const boxes = await js(`(() => {
          const box = e => { const r=e.getBoundingClientRect(); return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height}; };
          const column=document.querySelector('.supervisor-workspace__graph-canvas');
          const selector=document.querySelector('.supervisor-workspace__result-navigation button');
          const toolbar=document.querySelector('.story-graph-3d__toolbar');
          const views=toolbar.querySelector('button[title="图例"]');
          const segment=toolbar.querySelector('.segmented-control');
          const buttons=[...segment.querySelectorAll('button')].map(box);
          return {width:innerWidth,pageWidth:document.documentElement.scrollWidth,column:box(column),selector:box(selector),
            context:box(document.querySelector('.supervisor-workspace__review-context')),toolbar:box(toolbar),views:box(views),
            canvas:box(document.querySelector('.story-graph-3d__gl')),gaps:buttons.slice(1).map((b,i)=>b.left-buttons[i].right),
            segmentPadding:getComputedStyle(segment).paddingTop,
            events:document.querySelectorAll('.supervisor-workspace__list-panel button').length,
            bounds:JSON.parse(document.documentElement.dataset.sceneBounds),
            scene:JSON.parse(document.documentElement.dataset.helix).dots.length,
            clusters:JSON.parse(document.documentElement.dataset.helix).clusters};
        })()`)
        assert(boxes.selector.top >= boxes.context.top && boxes.selector.bottom <= boxes.context.bottom, 'History inside shared context')
        assert(boxes.context.bottom <= boxes.column.top, 'Review context above graph columns')
        assert(boxes.gaps.every(gap => gap >= 2), 'Shared camera segment gaps')
        assert.equal(boxes.segmentPadding, '3px')
        assert(boxes.views.right <= boxes.column.right - 16 && boxes.pageWidth <= width, `Controls fit without overflow: ${JSON.stringify(boxes)}`)
        assert(boxes.canvas.width > 0 && boxes.canvas.height > 0)
        assert.equal(boxes.events, 21); assert.equal(boxes.scene, 21)
        assert(Object.values(boxes.bounds).every(value => Math.abs(value) < 1), 'All root scene vertices fit within the camera viewport')
        reports.push({ theme, ...boxes, colors: await checkSpiral() })
        if (width === 1440 && !process.env.GOODBUDDY_SUPERVISOR_NO_SCREENSHOT) await writeFile(join(artifacts, 'portable-spiral.png'), (await win.webContents.capturePage()).toPNG())
      }
      await js('document.querySelector(".supervisor-workspace__list-panel button").click()')
      await wait('document.querySelector(".supervisor-workspace__list-panel button")?.getAttribute("aria-pressed") === "true"')
      // The pre-assignment case uses the same real events with an explicitly empty membership response.
      await js(`window.goodbuddy.supervision.stories = async () => ({stories:[],experiences:[],unassigned:21,canUndo:false}); document.querySelector('.supervisor-workspace__review-context > .secondary-button').click()`)
      await wait('JSON.parse(document.documentElement.dataset.helix || "null")?.dots.length === 21 && document.querySelector(".supervisor-workspace")?.getAttribute("aria-busy") === "false"')
      await js('document.querySelector(".story-graph-3d__picker").click()')
      await wait('document.querySelectorAll(".story-graph-3d__menu [role=menuitem]").length === 1')
      await js('document.querySelector(".story-graph-3d__menu [role=menuitem]").click()')
      await wait('document.querySelector(".story-graph-3d__picker")?.textContent.includes("未归属事件")')
      assert.equal(await js('JSON.parse(document.documentElement.dataset.helix).dots.length'), 21)
      assert(await js('JSON.parse(document.documentElement.dataset.helix).marks.every(mark => !mark.storyId)'), 'Empty membership keeps neutral event marks')
      assert.deepEqual(errors, [])
      await writeFile(join(artifacts, 'portable-measurements.json'), JSON.stringify({ resultId, reports, clusters: geometry.clusters, radiusRange: [Math.min(...radii), Math.max(...radii)], errors }, null, 2))
      console.log(JSON.stringify({ resultId, reports, clusters: geometry.clusters, radiusRange: [Math.min(...radii), Math.max(...radii)], emptyMembershipEvents: 21, errors }))
      win.destroy(); app.quit(); return
    }
    if (process.env.GOODBUDDY_SUPERVISOR_SPIRAL) {
      await win.loadURL(process.env.GOODBUDDY_SUPERVISOR_URL + '?spiral=1&recap=1')
      await wait('document.querySelector(".supervisor-workspace")?.getAttribute("aria-busy") === "false"')
      await js('document.querySelector("#supervisor-tab-graph").click()')
      await wait('[...document.querySelectorAll("button")].some(b => b.textContent === "时间螺旋")')
      await js('[...document.querySelectorAll("button")].find(b => b.textContent === "时间螺旋").click()')
      await wait('JSON.parse(document.documentElement.dataset.helix || "null")?.events.length === 8')
      const geometry = await js('JSON.parse(document.documentElement.dataset.helix)')
      const palettes = new Map()
      assert(new Set(geometry.timeline.groups.filter(group => group.materialIndex > 0).map(group => group.materialIndex)).size >= 2, 'Different primary stories paint distinct interval materials in this fixture')
      assert(geometry.points.length >= 2801, 'One continuous helix with exact interval boundaries')
      const radii = geometry.points.map(p => p[0])
      assert(Math.max(...radii) - Math.min(...radii) > 40, 'Actual rendered geometry reflects uneven attention')
      geometry.points.forEach((point, i) => { if (i) assert(point[1] > geometry.points[i - 1][1], 'Actual tube advances monotonically in time') })
      assert(!geometry.events.includes('outside-review'), 'Aggregate story events outside this review are not plotted')
      for (const [width, theme] of [[1440, 'light'], [1440, 'dark'], [1024, 'light'], [390, 'light'], [390, 'dark']]) {
        win.setContentSize(width, 1000)
        await wait(`innerWidth === ${width} && innerHeight === 1000`)
        await js(`document.documentElement.dataset.theme = '${theme}'`)
        await settle()
        const boxes = await js(`(() => {
          const selector = document.querySelector('.supervisor-workspace__result-navigation button');
          const r = selector.getBoundingClientRect(), gl = document.querySelector('.story-graph-3d__gl').getBoundingClientRect();
          const toolbar = document.querySelector('.story-graph-3d__toolbar').getBoundingClientRect();
          const breadcrumb = document.querySelector('.story-graph-3d__breadcrumb');
          const context = document.querySelector('.supervisor-workspace__review-context').getBoundingClientRect();
          return { value: selector.value, left: r.left, right: r.right, top: r.top, bottom: r.bottom,
            toolbar: { left: toolbar.left, top: toolbar.top, bottom: toolbar.bottom },
            atRoot: breadcrumb.textContent === '全部', context: {top:context.top,bottom:context.bottom},
            pickers: document.querySelectorAll('.story-graph-3d__picker').length,
            headingSelectors: document.querySelectorAll('.supervisor-workspace__canvas-heading select').length,
            selectors: document.querySelectorAll('.supervisor-workspace__result-navigation button').length,
            width: innerWidth, canvasWidth: gl.width, canvasHeight: gl.height, pageWidth: document.documentElement.scrollWidth };
        })()`)
        assert.equal(boxes.value, 'fixture-result')
        assert.equal(boxes.selectors, 1)
        assert.equal(boxes.headingSelectors, 0)
        assert(boxes.atRoot, 'Root All breadcrumb stays independent of review history')
        assert.equal(boxes.pickers, 1, 'Only the hierarchy drill picker remains')
        assert(boxes.top >= boxes.context.top && boxes.bottom <= boxes.context.bottom, 'History is inside shared review context')
        assert(boxes.context.bottom <= boxes.toolbar.top, 'Context precedes graph tools')
        assert(boxes.left >= 0 && boxes.right <= boxes.width && boxes.pageWidth <= boxes.width, 'History selector fits without horizontal overflow')
        assert(boxes.canvasWidth > 0 && boxes.canvasHeight > 0, 'WebGL canvas is laid out')
        assert((await checkSpiral()).coloredGroups > 0, 'Interval fixture paints the actual tube in both themes and all sizes')
        palettes.set(theme, await js('JSON.parse(document.documentElement.dataset.helix).timeline.colors'))
        await js('[...document.querySelectorAll(".supervisor-workspace__graph-mode button")].find(b => b.getAttribute("aria-pressed") === "false").click()')
        await wait('!!document.querySelector(".supervisor-workspace__map")')
        assert.equal(await js('getComputedStyle(document.querySelector(".supervisor-workspace__canvas-heading > strong")).fontSize'), '13px', 'Flat and spiral All use identical typography')
        await js('document.querySelector(".supervisor-workspace__canvas-heading button[title=图例]").click()')
        await wait('!!document.querySelector(".inline-help__content")')
        await js('window.dispatchEvent(new KeyboardEvent("keydown", {key:"Escape",bubbles:true}))')
        await wait('!document.querySelector(".inline-help__content")')
        await js('[...document.querySelectorAll(".supervisor-workspace__graph-mode button")].find(b => b.textContent === "时间螺旋").click()')
        await wait('!!document.querySelector(".story-graph-3d__gl")')
        await js('document.querySelector("#supervisor-tab-overview").click(); document.querySelector(".page-shell").scrollTop = 0')
        await settle()
        const overview = await js(`(() => { const r = document.querySelector('.supervisor-workspace__review-context').getBoundingClientRect();
          return {top:r.top,bottom:r.bottom,forms:document.querySelectorAll('.supervisor-workspace__toolbar').length}; })()`)
        assert.equal(overview.top, boxes.context.top, 'Review bar keeps its top across tabs')
        assert.equal(overview.bottom, boxes.context.bottom, 'Review bar keeps its height across tabs')
        assert.equal(overview.forms, 0, 'New review inputs collapsed by default')
        await js('document.querySelector("#supervisor-tab-graph").click()')
        await wait('!!document.querySelector(".story-graph-3d__gl")')
      }
      assert.notDeepEqual(palettes.get('light'), palettes.get('dark'), 'WebGL palette follows theme tokens')
      await js('[...document.querySelectorAll(".supervisor-workspace__graph-mode button")].find(b => b.textContent === "时间螺旋").click()')
      await wait('!!document.querySelector(".story-graph-3d__gl")')
      const cameraBefore = await js('document.documentElement.dataset.camera')
      await js('document.querySelector(".story-graph-3d__viewport canvas[tabindex]").dispatchEvent(new KeyboardEvent("keydown", {key:"ArrowLeft",bubbles:true}))')
      await wait(`document.documentElement.dataset.camera !== ${JSON.stringify(cameraBefore)}`)
      win.show(); win.focus(); win.webContents.focus()
      await wait('document.hasFocus()')
      await js('document.querySelector(".story-graph-3d__toolbar button[title=图例]").focus()')
      win.webContents.sendInputEvent({type:'keyDown', keyCode:'Space'})
      win.webContents.sendInputEvent({type:'keyUp', keyCode:'Space'})
      await wait('document.activeElement.getAttribute("aria-expanded") === "true"')
      win.webContents.sendInputEvent({type:'keyDown', keyCode:'Escape'})
      win.webContents.sendInputEvent({type:'keyUp', keyCode:'Escape'})
      await wait('!document.querySelector(".inline-help__content")')
      const dragAt = await js(`(() => { const c = document.querySelector('.story-graph-3d__viewport canvas[tabindex]'); c.scrollIntoView();
        const r = c.getBoundingClientRect(); return {x:Math.round(r.left+r.width/2), y:Math.round(r.top+r.height/2)}; })()`)
      const beforeDrag = await js('document.documentElement.dataset.camera')
      win.webContents.sendInputEvent({type:'mouseDown',button:'left',clickCount:1,...dragAt})
      win.webContents.sendInputEvent({type:'mouseMove',button:'left',modifiers:['leftButtonDown'],x:dragAt.x+30,y:dragAt.y+12})
      win.webContents.sendInputEvent({type:'mouseUp',button:'left',clickCount:1,x:dragAt.x+30,y:dragAt.y+12})
      await wait(`document.documentElement.dataset.camera !== ${JSON.stringify(beforeDrag)}`)
      win.setContentSize(1024, 900)
      await settle()
      assert(await js('!document.querySelector(".supervisor-workspace__detail").getClientRects().length'), 'Medium details closed by default')
      await js('document.querySelector(".supervisor-workspace__list-panel button").click()')
      await wait('document.activeElement === document.querySelector(".supervisor-workspace__detail")')
      assert(await js(`(() => { const panel = document.querySelector('.supervisor-workspace__detail').getBoundingClientRect();
        const graph = document.querySelector('.supervisor-workspace__graph-layout').getBoundingClientRect();
        return panel.top >= graph.top && panel.bottom <= graph.bottom + 1; })()`), 'Medium details stay inside graph row')
      await js('document.activeElement.dispatchEvent(new KeyboardEvent("keydown", {key:"Escape",bubbles:true}))')
      await wait('!document.querySelector(".supervisor-workspace__detail").getClientRects().length')
      assert(await js('document.activeElement.matches(".supervisor-workspace__detail-toggle")'), 'Details restore toggle focus')
      win.setContentSize(1440, 700)
      await settle()
      assert(await js('document.querySelector(".supervisor-workspace__graph-layout").getBoundingClientRect().height < 660'), 'Short spiral does not inherit flat graph minimum')
      for (const name of ['Fixture project', 'Fixture story']) {
        await js('document.querySelector(".story-graph-3d__picker").click()')
        await wait('!!document.querySelector(".story-graph-3d__menu [role=menuitem]")')
        await js('document.activeElement.dispatchEvent(new KeyboardEvent("keydown", {key:"End",bubbles:true}))')
        assert(await js('document.activeElement === [...document.querySelectorAll(".story-graph-3d__menu [role=menuitem]")].at(-1)'), 'Hierarchy menu keyboard End')
        await js(`([...document.querySelectorAll('.story-graph-3d__menu [role=menuitem]')].find(e => e.textContent.includes('${name}'))).click()`)
        await wait(`document.querySelector('.story-graph-3d__breadcrumb strong')?.textContent === '${name}'`)
        if (name === 'Fixture project') await checkSpiral()
        assert.equal(await js('document.querySelectorAll(".story-graph-3d__breadcrumb select").length'), 0)
      }
      await js('[...document.querySelectorAll(".story-graph-3d__breadcrumb button")].find(b => b.textContent === "Fixture project").click()')
      await wait('document.querySelector(".story-graph-3d__breadcrumb strong")?.textContent === "Fixture project"')
      await js('document.querySelector(".story-graph-3d__breadcrumb button").click()')
      await wait('document.querySelector(".story-graph-3d__breadcrumb strong")?.textContent === "全部"')
      assert.equal(await js('document.querySelectorAll(".story-graph-3d__breadcrumb > span").length'), 1)
      await js('[...document.querySelectorAll(".supervisor-workspace__graph-mode button")].find(b => b.getAttribute("aria-pressed") === "false").click()')
      await wait('!!document.querySelector(".supervisor-workspace__map")')
      assert.equal(await js('document.querySelector(".supervisor-workspace__result-navigation button").value'), 'fixture-result')
      assert.equal(await js('document.querySelectorAll(".supervisor-workspace__result-navigation button").length'), 1)
      await js('[...document.querySelectorAll(".supervisor-workspace__graph-mode button")].find(b => b.getAttribute("aria-pressed") === "false").click()')
      await wait('!!document.querySelector(".story-graph-3d__gl")')
      await selectHistory('older-result')
      await wait('document.querySelector(".supervisor-workspace")?.getAttribute("aria-busy") === "false" && JSON.parse(document.documentElement.dataset.helix || "null")?.events.length === 1')
      await js('document.querySelector("#supervisor-tab-overview").click()')
      await wait('document.querySelector(".supervisor-workspace__result-navigation button")?.value === "older-result"')
      assert.deepEqual(errors, [])
      console.log(JSON.stringify({ spiral: 'passed', vertices: geometry.points.length, radiusRange: [Math.min(...radii), Math.max(...radii)], widths: [1440, 390], errors }))
      win.destroy(); app.quit(); return
    }
    const checkDiscussion = async () => {
      const report = await js(`(() => {
        const editor = document.querySelector('.supervision-discussion-editor');
        const box = e => { const r = e.getBoundingClientRect(); return {left:r.left, right:r.right, top:r.top, bottom:r.bottom}; };
        const target = editor.querySelector('.supervision-discussion-editor__target');
        const field = editor.querySelector('.field'), label = field.querySelector('span'), input = field.querySelector('textarea');
        const footer = editor.querySelector('footer');
        return { target:box(target), field:box(field), label:box(label), input:box(input), footer:box(footer),
          buttons:[...footer.querySelectorAll('button')].map(box), align:getComputedStyle(footer).justifyContent,
          clientWidth:editor.clientWidth, scrollWidth:editor.scrollWidth, value:input.value,
          border:getComputedStyle(target).borderBottomWidth, disclosures:editor.querySelectorAll('details').length };
      })()`)
      assert(report.value.includes('本周已核对交付清单') && report.value.includes('原始依据：模拟会议记录'), 'Actual reference content is editable')
      assert.equal(report.field.top - report.target.bottom, 16, 'Target to message spacing')
      assert.equal(report.input.top - report.label.bottom, 8, 'Label to input spacing')
      assert.equal(report.footer.top - report.field.bottom, 16, 'Message to footer spacing')
      assert.equal(report.border, '1px', 'Destination is separated')
      assert.equal(report.align, 'flex-end', 'Shared right aligned footer')
      assert(Math.abs(report.buttons[1].right - report.footer.right) < 1, 'Send at right edge')
      assert(report.buttons[0].right < report.buttons[1].left && report.buttons[0].top === report.buttons[1].top, 'Cancel then send')
      assert(report.scrollWidth <= report.clientWidth && report.disclosures === 0, 'No overflow or redundant disclosure')
      return report
    }
    if (process.env.GOODBUDDY_SUPERVISOR_SETTINGS) {
      await win.loadURL(process.env.GOODBUDDY_SUPERVISOR_URL)
      await wait('!!document.querySelector("#supervisor-tab-settings")')
      await js('document.querySelector("#supervisor-tab-settings").click()')
      await wait('!!document.querySelector(".supervisor-settings")')
      await js('document.fonts.ready')
      for (const theme of ['light', 'dark']) {
        await js(`document.documentElement.dataset.theme = '${theme}'`)
        for (const [width, height] of [[1440, 1100], [1024, 768], [390, 480]]) {
          win.setContentSize(width, height)
          for (const tab of ['model', 'review', 'stories', 'suggestions']) {
            await js(`document.querySelector('#supervisor-settings-tab-${tab}').click(); document.querySelector('.page-shell').scrollTop = 0`)
            await wait(`document.querySelector('#supervisor-settings-tab-${tab}').getAttribute('aria-selected') === 'true' && innerWidth === ${width}`)
            await settle()
            const report = await js(`(() => {
              const root = document.querySelector('.supervisor-settings');
              const nav = root.querySelector('.page-tabs');
              const panel = root.querySelector('[role=tabpanel]:not([hidden])');
              const form = panel.querySelector('form');
              const box = e => { const r = e.getBoundingClientRect(); return {left:r.left, right:r.right, top:r.top, bottom:r.bottom, height:r.height}; };
              return { root:box(root), nav:box(nav), form:box(form), heading:form.querySelector('h2').textContent,
                primaryTabs:document.querySelectorAll('.heartbeat-center > .page-tabs [role=tab]').length,
                settingsTabs:nav.querySelectorAll('[role=tab]').length,
                visiblePanels:root.querySelectorAll('[role=tabpanel]:not([hidden])').length,
                navFlex:getComputedStyle(nav).flexShrink, rootFlex:getComputedStyle(root).flexShrink,
                formBorder:getComputedStyle(form).borderTopWidth, formBackground:getComputedStyle(form).backgroundColor,
                pageWidth:document.documentElement.scrollWidth, rootWidth:root.clientWidth, rootScrollWidth:root.scrollWidth,
                controls:[...form.querySelectorAll('input,select,button')].map(box) };
            })()`)
            assert.equal(report.primaryTabs, 5)
            assert.equal(report.settingsTabs, 4)
            assert.equal(report.visiblePanels, 1)
            assert.equal(report.nav.top - report.root.top, 17, 'Tabs inset from the card border')
            assert.equal(report.form.top - report.nav.bottom, 24, 'Tabs separated from section content')
            assert.equal(report.form.left, report.nav.left, 'Section and tabs share the content edge')
            assert.equal(report.navFlex, '0')
            assert.equal(report.rootFlex, '0')
            assert(report.nav.height >= 36, 'Short windows do not compress tabs')
            assert.equal(report.formBorder, '0px', 'No nested form border')
            assert.equal(report.formBackground, 'rgba(0, 0, 0, 0)', 'One settings surface')
            assert(report.pageWidth <= width && report.rootScrollWidth <= report.rootWidth, 'No horizontal page or card overflow')
            assert(report.controls.every(control => control.left >= report.form.left && control.right <= report.form.right + 1), 'Fields fit the section')
            if (tab === 'model') assert.equal(report.heading, '模型与运行限制')
            reports.push({ theme, width, height, tab, ...report })
            await writeFile(join(artifacts, `settings-${theme}-${width}-${tab}.png`), (await win.webContents.capturePage()).toPNG())
          }
        }
      }
      assert.deepEqual(errors, [])
      await writeFile(join(artifacts, 'settings-measurements.json'), JSON.stringify(reports, null, 2))
      console.log(JSON.stringify({ settingsCases: reports.length, tabInset: 17, contentGap: 24, errors }))
      win.destroy()
      app.quit()
      return
    }
    if (process.env.GOODBUDDY_SUPERVISOR_CONTENT_LAYOUT) {
      win.show()
      const controlsOnly = process.env.GOODBUDDY_SUPERVISOR_CONTENT_LAYOUT === 'controls'
      for (const view of controlsOnly ? ['activity', 'pending'] : ['recap', 'empty', 'activity', 'pending', 'failure']) {
        console.log(`Checking content layout: ${view}`)
        await win.loadURL(process.env.GOODBUDDY_SUPERVISOR_URL + (view === 'activity' ? '?activity=1' : '?recap=1&long-summary=1' + (view === 'failure' ? '&fail-run=1' : view === 'empty' ? '&state=empty' : '')))
        await wait('document.querySelector(".supervisor-workspace")?.getAttribute("aria-busy") === "false"')
        if (view === 'activity') {
          await js('document.querySelector("#supervisor-tab-activity").click()')
          await wait('document.querySelectorAll(".supervisor-activity__item").length === 3')
        } else if (view === 'pending' || view === 'failure') {
          await js('document.querySelector(".supervisor-workspace__review-context .primary-button").click()')
          await wait('!!document.querySelector(".supervisor-workspace__toolbar .primary-button")')
          await js('document.querySelector(".supervisor-workspace__toolbar .primary-button").click()')
          await wait(`document.documentElement.dataset.reviewNoticeTone === '${view === 'pending' ? 'info' : 'error'}'`)
        }
        await js('document.fonts.ready')
        for (const theme of ['light', 'dark']) {
          await js(`document.documentElement.dataset.theme = '${theme}'`)
          for (const width of controlsOnly ? [1440, 1024, 390] : [2000, 1440, 1024, 390]) {
            win.setContentSize(width, 1100)
            await js('document.querySelector(".page-shell").scrollTop = 0')
            await settle()
            const report = await js(`(() => {
              const box = selector => { const r = document.querySelector(selector)?.getBoundingClientRect(); return r && { left:r.left, right:r.right, width:r.width, height:r.height, top:r.top, bottom:r.bottom }; };
              return { width:innerWidth, pageWidth:document.documentElement.scrollWidth,
                panel:box('.heartbeat-center > [role=tabpanel]:not([hidden])'), toolbar:box('.supervisor-workspace__review-context'), recap:box('.supervisor-workspace__recap'),
                prose:box('.supervisor-workspace__prose'), activity:box('.supervisor-activity'),
                readingColumns:document.querySelector('.supervisor-workspace__recap') && getComputedStyle(document.querySelector('.supervisor-workspace__recap')).gridTemplateColumns.split(' ').map(parseFloat),
                sidebar:box('.supervisor-workspace__recap-sidebar'),
                steps:box('.supervisor-activity__steps'),
                empty:box('.supervisor-workspace > .empty-state'), emptyTitle:box('.supervisor-workspace > .empty-state strong'),
                stageConnectors:[...document.querySelectorAll('.supervisor-activity__steps li:not(:last-child)')].map(e=>getComputedStyle(e,'::after').borderTopWidth),
                summaryLength:[...document.querySelectorAll('.supervisor-workspace__summary')].map(e=>e.textContent).join('').length,
                tail:document.querySelector('.supervisor-workspace__prose')?.textContent.includes('长摘要末尾'),
                 controls:[...document.querySelectorAll('.supervisor-activity > .supervisor-workspace__action-bar > *')].map(e=>{const r=e.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top};}),
                 toolbarControls:[...document.querySelectorAll('.supervisor-workspace__toolbar select, .supervisor-workspace__toolbar button')].map(e=>({disabled:e.disabled,text:e.textContent,top:e.getBoundingClientRect().top,bottom:e.getBoundingClientRect().bottom})),
                  notice:box('.supervisor-workspace__run-status'),
                 cancel:box('.supervisor-activity__item .danger-ghost') };
            })()`)
            assert(report.pageWidth <= width, 'No page overflow')
            if (view === 'empty') {
              assert(Math.abs(report.empty.width - report.panel.width) < 1, 'Empty state fills panel');
              assert(Math.abs((report.emptyTitle.left + report.emptyTitle.right) / 2 - (report.panel.left + report.panel.right) / 2) < 1, 'Empty state title centered');
              assert(report.empty.top >= report.toolbar.bottom, 'Empty state below toolbar');
            } else if (view !== 'activity') {
              assert(report.summaryLength > 2000 && report.tail, 'Long summary retained')
              assert(Math.abs(report.recap.width - report.panel.width) < 1, 'Recap fills the page panel')
              if (width >= 1024) assert(Math.abs(report.readingColumns[0] / report.readingColumns[1] - 2) < 0.02, 'Overview uses a 2:1 reading layout')
              else assert(report.sidebar.top >= report.prose.bottom, 'Narrow overview puts supporting content after summary')
              for (const control of [report.toolbar]) {
                assert(Math.abs(control.left - report.recap.left) < 1 && Math.abs(control.right - report.recap.right) < 1, 'Toolbar, history and result share edges')
              }
               assert(report.prose.left - report.recap.left <= 25, 'No separately centered inner body')
               if (view === 'pending') {
                 assert(report.toolbarControls.every(control => !control.disabled), 'Long review keeps toolbar enabled')
                  assert.equal(report.toolbarControls[2].text, '回顾', 'Start name remains stable')
                  assert.equal(report.notice, undefined, 'Operation feedback does not occupy workspace layout')
                 if (width >= 1024) assert(Math.max(...report.toolbarControls.map(control => control.top)) - Math.min(...report.toolbarControls.map(control => control.top)) <= 4, 'Toolbar stays on one aligned row')
               }
            } else {
               assert(Math.abs(report.activity.width - report.panel.width) < 1, 'Activity fills the page panel')
               assert(report.cancel.width >= 28 && report.cancel.right <= report.panel.right, 'Cancel fits activity panel')
              if (width >= 1024) {
                assert(report.steps.height < 40, 'Compact stage row')
                assert(report.stageConnectors.every(value => value === '1px'), 'Connected stages')
                assert(report.controls[2].left - report.controls[1].right <= 24, 'Refresh grouped with filter')
              }
            }
            reports.push({ view, theme, ...report })
            await writeFile(join(artifacts, `${view}-${theme}-${width}.png`), (await capturePage()).toPNG())
            if (view === 'recap') {
              await js('document.querySelector(".supervisor-workspace__prose").lastElementChild.scrollIntoView({block:"end"})')
              await settle()
              await writeFile(join(artifacts, `${view}-tail-${theme}-${width}.png`), (await capturePage()).toPNG())
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
                suggestions: !!panel.querySelector('#supervision-suggestions-title'),
                refresh: [...panel.querySelectorAll('button')].filter(b => b.getClientRects().length && b.textContent.includes('刷新')).length,
                recap: !!recap && !!recap.getClientRects().length,
                paragraphs: recap?.querySelectorAll('.supervisor-workspace__summary').length ?? 0,
                proseWidth: recap?.querySelector('.supervisor-workspace__prose').getBoundingClientRect().width,
                text: panel.innerText };
            })()`)
            assert(report.pageWidth <= width && report.scrollWidth <= report.clientWidth, 'Recap/automatic overflow')
            assert.equal(report.refresh, 1, 'One refresh owner per panel')
            assert.equal(report.reports, tab === 'plans' && scenario === 'populated')
            assert.equal(report.suggestions, tab === 'plans' && scenario === 'populated')
            assert.equal(report.recap, tab === 'overview' && scenario !== 'empty')
            if (tab === 'overview') {
              assert(!report.text.includes('暂无历史心跳报告') && !report.text.includes('待确认记忆') && !report.text.includes('监督建议'))
              if (scenario !== 'empty') {
                assert.equal(report.paragraphs, 4)
                assert(report.text.includes('外部评审时间') && report.text.includes('未解决事项'))
                assert(report.proseWidth > report.clientWidth * (width > 1000 ? 0.55 : 0.8), 'Prose uses the primary reading column')
              } else assert(report.text.includes('还没有成功回顾'))
            } else {
              assert(!report.text.includes('暂无历史心跳报告'))
              assert.equal(report.text.includes('历史心跳报告'), scenario === 'populated')
            }
            reports.push({ scenario, tab, ...report })
            const prefix = `recap-${scenario}-${tab}-${width}`
            await writeFile(join(artifacts, `${prefix}.png`), (await win.webContents.capturePage()).toPNG())
            if (tab === 'plans' && scenario === 'populated') {
              for (const anchor of ['supervision-suggestions-title', 'heartbeat-reports-title']) {
                await js(`document.getElementById('${anchor}').scrollIntoView({block:'start'})`)
                if (anchor === 'heartbeat-reports-title' && scenario === 'populated') await js(`document.querySelector('#heartbeat-panel-history button[aria-expanded=false]')?.click()`)
                await settle()
                await writeFile(join(artifacts, `${prefix}-${anchor}.png`), (await win.webContents.capturePage()).toPNG())
              }
            }
          }
        }
        if (scenario === 'empty') {
          // Without a graph, the empty state fills the visible height and its message sits in the middle.
          for (const [width, height] of [[1440, 900], [390, 800]]) {
            win.setContentSize(width, height)
            await js(`document.querySelector('#supervisor-tab-graph').click(); document.querySelector('.page-shell').scrollTop = 0`)
            await wait('!!document.querySelector(".supervisor-workspace__graph-empty .empty-state strong")')
            await settle()
            const empty = await js(`(() => {
              const box = document.querySelector('.supervisor-workspace__graph-empty');
              const shell = document.querySelector('.page-shell');
              const title = box.querySelector('.empty-state strong').getBoundingClientRect();
              const r = box.getBoundingClientRect(); const s = shell.getBoundingClientRect();
              return { boxCenterX: r.left + r.width / 2, titleCenterX: title.left + title.width / 2,
                boxTop: r.top, boxBottom: r.bottom, titleTop: title.top, shellBottom: s.bottom,
                pageScroll: shell.scrollHeight > shell.clientHeight + 1,
                buttons: [...box.querySelectorAll('button')].map(b => b.textContent),
                outsideRefresh: [...document.querySelectorAll('#supervisor-panel-graph button')].filter(b => !box.contains(b) && b.textContent.includes('刷新')).length };
            })()`)
            assert(Math.abs(empty.boxCenterX - empty.titleCenterX) <= 2, 'Graph empty state is horizontally centred')
            const middle = (empty.boxTop + empty.boxBottom) / 2
            assert(empty.titleTop > empty.boxTop + 60 && Math.abs(empty.titleTop - middle) < (empty.boxBottom - empty.boxTop) / 4, 'Graph empty state is vertically centred')
            assert(empty.shellBottom - empty.boxBottom <= 48, 'Graph empty state reaches the bottom margin')
            assert.equal(empty.pageScroll, false, 'Graph empty state does not scroll the page')
            assert.deepEqual(empty.buttons, ['工作回顾'])
            assert.equal(empty.outsideRefresh, 1)
            reports.push({ scenario: 'graph-empty', width, height, ...empty })
            await writeFile(join(artifacts, `graph-empty-${width}x${height}.png`), (await win.webContents.capturePage()).toPNG())
          }
        }
        if (scenario === 'populated') {
          await js('document.querySelector("#supervisor-tab-overview").click()')
          await js('document.querySelector(".supervisor-workspace__review-context .primary-button").click()')
          // Toolbar: incremental review button, refresh, and the more menu holding re-analysis.
          const toolbar = await js(`(() => {
            const bar = document.querySelector('.supervisor-workspace__toolbar');
            const rect = bar.getBoundingClientRect();
            const more = bar.querySelector('[aria-haspopup=menu]');
            // Rows are groups of items whose vertical ranges overlap.
            const items = [...bar.children].filter(el => el.getClientRects().length).map(el => el.getBoundingClientRect()).sort((a, b) => a.top - b.top);
            const tops = items.reduce((rows, rect) => { const last = rows.at(-1); if (last && rect.top < last.bottom) last.bottom = Math.max(last.bottom, rect.bottom); else rows.push({ top: Math.round(rect.top), bottom: rect.bottom }); return rows }, []).map(row => row.top);
            return { primary: bar.querySelector('.primary-button').textContent, more: more?.getAttribute('aria-label'),
              overflow: bar.scrollWidth > rect.width + 1, rows: new Set(tops).size };
          })()`)
          assert.equal(toolbar.primary, '回顾')
          assert.equal(toolbar.more, '更多回顾操作')
          assert.equal(toolbar.overflow, false, 'Recap toolbar overflows')
          assert(toolbar.rows <= 2, `Recap toolbar wraps into ${toolbar.rows} rows`)
          await js('document.querySelector(".supervisor-workspace__toolbar [aria-haspopup=menu]").click()')
          await wait('!!document.querySelector("[role=menu] [role=menuitem]")')
          assert.equal(await js('document.querySelector("[role=menu] [role=menuitem]").textContent'), '重新整理…')
          await js('document.querySelector("[role=menu] [role=menuitem]").click()')
          await wait('!!document.querySelector(".supervisor-workspace__confirm")')
          const confirm = await js(`(() => { const el = document.querySelector('.supervisor-workspace__confirm'); const r = el.getBoundingClientRect();
            return { width: r.width, overflow: el.scrollWidth > el.clientWidth + 1, text: el.textContent, buttons: [...el.querySelectorAll('button')].map(b => b.textContent) } })()`)
          assert.equal(confirm.overflow, false, 'Re-analysis confirmation overflows')
          assert.deepEqual(confirm.buttons, ['取消', '重新整理'])
          assert(confirm.text.includes('可能产生较多模型用量'))
          await settle()
          await writeFile(join(artifacts, `recap-reanalyze-confirm-${win.getContentSize()[0]}.png`), (await win.webContents.capturePage()).toPNG())
          await js('document.querySelector(".supervisor-workspace__confirm .secondary-button").click()')
          await wait('!document.querySelector(".supervisor-workspace__confirm")')
          await selectHistory('older-result')
          await wait('document.querySelector(".supervisor-workspace")?.getAttribute("aria-busy") === "false"')
          await js('document.querySelector(".supervisor-workspace__toolbar .primary-button").click(); document.querySelector(".page-shell").scrollTop = 0')
          await settle()
          assert(await js('document.querySelector(".supervisor-workspace__recap").textContent.includes("上期结果")'))
          assert(await js('!document.querySelector(".supervisor-workspace__run-status")'))
          await writeFile(join(artifacts, 'recap-running-history-390.png'), (await win.webContents.capturePage()).toPNG())
          await js('document.querySelector("#supervisor-tab-activity").click()')
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
    if (process.env.GOODBUDDY_SUPERVISOR_AUTOMATIC_OVERVIEW || process.env.GOODBUDDY_SUPERVISOR_DISCUSSION) {
      for (const scenario of process.env.GOODBUDDY_SUPERVISOR_DISCUSSION ? [] : ['populated', 'empty', 'plan-only']) {
        const empty = scenario !== 'populated'
        await win.loadURL(process.env.GOODBUDDY_SUPERVISOR_URL + (scenario === 'populated' ? '?menu=1' : scenario === 'plan-only' ? '?plan-only=1' : ''))
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
                 reports: !!panel.querySelector('#heartbeat-reports-title'),
                 suggestions: !!panel.querySelector('#supervision-suggestions-title'),
                 suggestionItems: panel.querySelectorAll('.supervision-suggestions__list > li').length,
                 emptyReports: panel.textContent.includes('暂无历史心跳报告'),
                plans: !!panel.querySelector('#heartbeat-panel-plans'),
                create: [...panel.querySelectorAll('button')].filter(b => b.textContent === '创建心跳计划').length,
                emptyStates: panel.querySelectorAll('#heartbeat-panel-overview .empty-state').length,
                activity: panel.querySelectorAll('.supervisor-activity__item').length };
            })()`)
            assert(report.pageWidth <= width && report.scrollWidth <= report.panelWidth, 'Automatic panel overflow')
            for (const key of ['overview', 'plans']) assert.equal(report[key], tab === 'plans', key)
            // Statistics, the trend and the run audit are gone; earlier reports stay readable.
            for (const key of ['metrics', 'trend', 'audit']) assert.equal(report[key], false, key)
            for (const key of ['reports', 'suggestions']) assert.equal(report[key], tab === 'plans' && !empty, key)
            assert.equal(report.suggestionItems, tab === 'plans' && !empty ? 2 : 0)
            assert.equal(report.emptyReports, false)
            assert.equal(report.create, tab === 'plans' ? 1 : 0)
            assert.equal(report.emptyStates, 0)
            if (tab === 'activity') assert.equal(report.activity, 3)
            reports.push({ scenario, empty, tab, ...report })
            const prefix = `automatic-${scenario}-${tab}-light-${width}`
            await writeFile(join(artifacts, `${prefix}.png`), (await win.webContents.capturePage()).toPNG())
            if (tab === 'plans') {
              for (const anchor of empty ? [] : ['supervision-suggestions-title', 'heartbeat-reports-title']) {
                await js(`document.getElementById('${anchor}').scrollIntoView({block:'start'})`)
                await settle()
                await writeFile(join(artifacts, `${prefix}-${anchor}.png`), (await win.webContents.capturePage()).toPNG())
              }
              await js('document.querySelector(".heartbeat-settings__intro button").click()')
              await wait('!!document.querySelector("[role=dialog]")')
              assert(await js('document.querySelector("[role=dialog] > header button").getAttribute("aria-label") === "关闭心跳计划"'))
              assert.equal(await js('document.querySelector("[role=dialog] > footer").textContent'), '取消保存并启用计划')
              const intervention = await js(`(() => {
                const dialog = document.querySelector('[role=dialog]');
                const group = [...dialog.querySelectorAll('fieldset')].find(f => f.textContent.includes('介入方式'));
                const buttons = group ? [...group.querySelectorAll('button')].filter(b => b.textContent === '生成建议' || b.textContent === '仅更新记忆') : [];
                const body = dialog.querySelector('.custom-task-dialog__body, [class*=body]') || dialog;
                return { present: !!group, options: buttons.map(b => b.textContent), pressed: buttons.find(b => b.getAttribute('aria-pressed') === 'true' || b.getAttribute('aria-checked') === 'true')?.textContent,
                  overflow: body.scrollWidth > body.clientWidth + 1 };
              })()`)
              assert.equal(intervention.present, true, 'Intervention field missing')
              assert.deepEqual(intervention.options, ['生成建议', '仅更新记忆'])
              assert.equal(intervention.overflow, false, 'Plan modal overflows horizontally')
              if (width === 390) await writeFile(join(artifacts, `plan-modal-intervention-${scenario}-390.png`), (await win.webContents.capturePage()).toPNG())
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
      await win.loadURL(process.env.GOODBUDDY_SUPERVISOR_URL + '?preview=1')
      await wait('document.querySelector(".supervisor-workspace")?.getAttribute("aria-busy") === "false"')
      await js('document.querySelector("#supervisor-tab-graph").click()')
      await wait('!!document.querySelector(".supervisor-workspace__map")')
      await js(`document.querySelector('.supervisor-workspace__map [aria-label="观察工作过程"]').dispatchEvent(new MouseEvent('click', {bubbles:true}))`)
      await settle()
      await js('document.querySelector(".supervisor-workspace__detail > .link-button").click()')
      await wait('!!document.querySelector(".supervisor-discussion > button")')
      await js('document.querySelector(".supervisor-discussion > button").click()')
      await wait('!!document.querySelector(".supervisor-discussion textarea")')
      await js('document.fonts.ready')
      const previews = []
      for (const theme of ['light', 'dark']) {
        await js(`document.documentElement.dataset.theme = '${theme}'`)
        for (const width of [1440, 390]) {
          win.setContentSize(width, 1100)
            await js(`document.querySelector('.supervisor-discussion').scrollIntoView({block:'center'})`)
            await settle()
            const report = await js(`(() => {
              const preview = document.querySelector('.supervisor-discussion');
              const box = e => { const r = e.getBoundingClientRect(); return {left:r.left, right:r.right, top:r.top, bottom:r.bottom}; };
              return { width:innerWidth, pageWidth:document.documentElement.scrollWidth,
                clientWidth:preview.clientWidth, scrollWidth:preview.scrollWidth,
                question:preview.querySelector('textarea').value, text:preview.textContent,
                controls:[...preview.querySelectorAll('textarea, button')].map(box) };
            })()`)
            assert(report.pageWidth <= width && report.scrollWidth <= report.clientWidth, 'Discussion preview overflow')
            assert(report.question.trim() && report.text.includes('模拟会议记录'), 'Discussion question and destination visible')
            assert(report.controls.every(box => box.left >= 0 && box.right <= width && box.top >= 0 && box.bottom <= 1100), 'Preview controls fit viewport')
            assert(await js('!document.querySelector(".supervisor-discussion [role=alert]")'), 'Preview loads without error')
            assert(await js('!document.querySelector(".supervisor-discussion details")'), 'No redundant context disclosure')
            previews.push({ theme, ...report, editor: await checkDiscussion() })
            await writeFile(join(artifacts, `discussion-preview-${theme}-${width}.png`), (await win.webContents.capturePage()).toPNG())
        }
      }
      await js('document.querySelector(".supervisor-discussion .secondary-button").click()')
      await wait('!document.querySelector(".supervisor-discussion textarea")')
      assert.deepEqual(errors, [])
      await writeFile(join(artifacts, 'discussion-preview-measurements.json'), JSON.stringify(previews, null, 2))
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
      await wait('[...document.querySelectorAll(".supervision-card button")].some(b => b.textContent === "继续讨论" && !b.disabled)')
      await js('[...document.querySelectorAll(".supervision-card button")].find(b => b.textContent === "继续讨论").click()')
      await wait('!!document.querySelector(".supervision-discussion-editor textarea")')
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
          reports.push({ theme, ...report, editor: await checkDiscussion() })
          await js('document.querySelector(".supervision-discussion-editor footer").scrollIntoView({block:"end"})')
          await settle()
          assert(await js(`([...document.querySelectorAll('.supervision-discussion-editor footer button')].every(e => {
            const r = e.getBoundingClientRect();
            return r.top >= 0 && r.bottom <= innerHeight && e.contains(document.elementFromPoint(r.x+r.width/2, r.y+r.height/2));
          }))`), 'Sidebar footer reachable and hittable after scrolling')
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
            assert(before.headerButtons === 1 && before.closeLabel === '关闭心跳计划' && before.tooltip === before.closeLabel, 'Accessible header X only')
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
    await validateSupervisorSelection(win, js, wait, process.env.GOODBUDDY_SUPERVISOR_URL)
    await open(false)
    await js(
      'document.querySelector(".supervisor-workspace__canvas-tools .link-button").click()'
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
            (text) => text.inSvg && text.painted && (width < 1024 || text.screenFontSize >= 11)
          ),
          `Clipped or invisible SVG text at ${width}: ${JSON.stringify(report.texts.filter(text => !(text.inSvg && text.painted && text.screenFontSize >= 11)).slice(0, 3))} svg=${JSON.stringify(report.svg)}`
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
            report.scroller.scrollWidth === report.scroller.clientWidth,
            'Mobile canvas fits without internal scrolling; full labels remain in the list'
          )
          await js(
            'document.querySelector(".supervisor-workspace__map-scroll").scrollLeft = 600'
          )
          assert(
            await js(
              'document.querySelector(".supervisor-workspace__map-scroll").scrollLeft === 0'
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
      await js(`(() => {const list=document.querySelector('.supervisor-workspace__list-panel'); list.scrollIntoView({block:'end'}); list.scrollTop=list.scrollHeight;list.dispatchEvent(new Event('scroll'))})()`)
      await wait('!!document.querySelector("[data-list-window-row=event-79] button")')
      await settle()
      const scrolling = await js(`(() => {
        const sidebar = document.querySelector('.supervisor-workspace__graph-list');
        const list = sidebar.querySelector('[role=tabpanel]');
        const canvas = document.querySelector('.supervisor-workspace__graph-canvas');
        const shell = document.querySelector('.page-shell');
        list.scrollIntoView({block:'end'});
        const pageHeight = shell.scrollHeight, pageTop = shell.scrollTop;
        list.scrollTop = list.scrollHeight;
        const last = list.lastElementChild.getBoundingClientRect();
        const button = list.querySelector('[data-list-window-row="event-79"] button');
        const b = button.getBoundingClientRect(), r = list.getBoundingClientRect();
        return { width: innerWidth, height: sidebar.getBoundingClientRect().height, canvasHeight: canvas.getBoundingClientRect().height,
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
    // The graph row fills the window down to a steady bottom margin; each column scrolls on its own.
    for (const [width, height] of [[1440, 1200], [1440, 900], [1440, 700], [1024, 1100]]) {
      win.setContentSize(width, height)
      await settle()
      const fill = await js(`(() => {
        const shell = document.querySelector('.page-shell');
        shell.scrollTop = 0;
        const layout = document.querySelector('.supervisor-workspace__graph-layout');
        const shellBox = shell.getBoundingClientRect(), box = layout.getBoundingClientRect();
          const columns = [...layout.children].filter(column => column.getClientRects().length).map(column => {
          const scroller = column.matches('.supervisor-workspace__graph-list') ? column.querySelector('[role=tabpanel]') : column;
          const r = column.getBoundingClientRect();
          return { name: column.className.split(' ')[0], canvas: column.matches('.supervisor-workspace__graph-canvas'), top: r.top, bottom: r.bottom,
            scrolls: getComputedStyle(scroller).overflowY, clientHeight: scroller.clientHeight, scrollHeight: scroller.scrollHeight };
        });
        const canvas = layout.querySelector('.supervisor-workspace__graph-canvas'), map = layout.querySelector('.supervisor-workspace__map').getBoundingClientRect();
        const playback = layout.querySelector('.supervisor-workspace__playback')?.getBoundingClientRect();
        const graphArea = { map: { top: map.top, bottom: map.bottom, height: map.height }, playbackBottom: playback?.bottom, canvasBottom: canvas.getBoundingClientRect().bottom };
        // Bottom of the first grid row (the side-by-side columns), measured from the window bottom.
        const rowBottom = Math.max(...columns.filter(column => Math.abs(column.top - columns[0].top) < 1).map(column => column.bottom));
        return { bottomGap: shellBox.bottom - rowBottom, wrapped: columns.length - columns.filter(column => Math.abs(column.top - columns[0].top) < 1).length,
          height: box.height, pageScroll: shell.scrollHeight - shell.clientHeight, columns, graphArea };
      })()`)
      reports.push({ fill: { width, height, ...fill } })
      await writeFile(join(artifacts, `fill-${width}x${height}.json`), JSON.stringify({ width, height, bottomGap: Math.round(fill.bottomGap), wrapped: fill.wrapped, pageScroll: fill.pageScroll, rowHeight: Math.round(fill.columns[0].bottom - fill.columns[0].top), mapHeight: Math.round(fill.graphArea.map.height) }))
      // At the 660px minimum (labels stay ≥ 11px) a short window scrolls the page; otherwise the row ends at the bottom margin.
      const atMinimum = Math.abs(fill.columns[0].bottom - fill.columns[0].top - 660) < 1
      if (!atMinimum) {
        assert(fill.bottomGap >= 20 && fill.bottomGap <= 40, `Graph must stop above the window bottom: ${JSON.stringify(fill)}`)
        // Three columns fit the window with no page scroll; at two columns only the wrapped detail extends the page.
        if (!fill.wrapped) assert(fill.pageScroll <= 1, `Page must not scroll at three columns: ${JSON.stringify(fill)}`)
      }
      const sideBySide = fill.columns.filter(column => Math.abs(column.top - fill.columns[0].top) < 1)
      for (const column of sideBySide) {
        assert(Math.abs(column.bottom - sideBySide[0].bottom) < 1, `Columns must share the row height: ${JSON.stringify(fill)}`)
        // The graph column has no scroll bar: the graph takes the height left after the heading and event bar.
        if (column.canvas) assert(column.scrollHeight <= column.clientHeight + 1 && column.scrolls === 'hidden', `Graph column must not scroll: ${JSON.stringify(column)}`)
        else assert(['auto', 'scroll'].includes(column.scrolls), `Column must scroll on its own: ${JSON.stringify(column)}`)
      }
      if (width === 1440) {
        const heading = await js(`(() => {
          const context = document.querySelector('.supervisor-workspace__review-context');
          return { meta: context.querySelector('.sr-only').textContent,
            above: context.getBoundingClientRect().bottom <= document.querySelector('.supervisor-workspace__graph-layout').getBoundingClientRect().top,
            heading: document.querySelector('.supervisor-workspace__canvas-heading').textContent };
        })()`)
        assert(heading.above && heading.meta.includes('全局') && !heading.heading.includes('事件与知识'), `Review context shared above graph: ${JSON.stringify(heading)}`)
        reports.push({ heading })
      }
      assert(Math.abs((fill.graphArea.playbackBottom ?? fill.graphArea.map.bottom) - fill.graphArea.canvasBottom) <= 1,
        `Graph area must reach the column bottom: ${JSON.stringify(fill.graphArea)}`)
      await writeFile(join(artifacts, `fill-${width}x${height}.png`), (await win.webContents.capturePage()).toPNG())
    }
    win.setContentSize(1440, 1100)
    await js(
       'document.querySelectorAll(".supervisor-workspace__graph-list [role=tab]")[2].click()'
     )
     await settle()
     await js('document.querySelector(".supervisor-workspace__list-panel button:last-of-type").click()')
    await settle()
    assert(
      await js('document.querySelectorAll("[data-relation]").length === 1'),
      'Selected relation endpoints must remain visible'
    )
    await js('document.querySelectorAll(".supervisor-workspace__graph-list [role=tab]")[0].click()')
    await js(`document.querySelector('.supervisor-workspace__list-panel').dispatchEvent(new KeyboardEvent('keydown',{key:'End',bubbles:true}))`)
    await settle()
    const target = await js(
      `(() => { const e = document.querySelector('[data-list-window-row="event-79"] button'); e.scrollIntoView({block:'center'}); const r = e.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), hit: e.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)) }; })()`
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
    assert(await js('document.querySelectorAll(".supervisor-workspace__list-panel button").length < 80'), 'Dense list is windowed without losing the last event')
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
    // Settings are grouped into one row of section tabs, with one visible form at a time.
    assert.deepEqual(await js('[...document.querySelectorAll("#supervisor-panel-settings [role=tablist] [role=tab]")].map(t => t.textContent)'),
      ['模型', '回顾整理', '故事与经验', '建议'])
    assert.equal(await js('document.querySelectorAll("[role=tablist]").length'), 2, 'Page tabs plus one settings section row')
    for (const section of ['model', 'review', 'stories', 'suggestions']) {
      await js(`document.querySelector('#supervisor-settings-tab-${section}').click()`)
      for (const width of [1440, 1024, 390]) {
        win.setContentSize(width, 1100)
        await js('document.querySelector(".page-shell").scrollTop = 0')
        await settle()
        const sizes = await js(`(() => {
          const shell = document.querySelector('.page-shell');
          const forms = [...document.querySelectorAll('#supervisor-panel-settings form')].filter(f => f.getClientRects().length);
          return { viewport: innerWidth, page: document.documentElement.scrollWidth,
            clientWidth: shell.clientWidth, scrollWidth: shell.scrollWidth, headings: document.querySelectorAll('h1').length,
            visibleForms: forms.length, title: forms[0]?.querySelector('h2')?.textContent };
        })()`)
        assert(
          sizes.page <= width && sizes.scrollWidth <= sizes.clientWidth,
          `Settings overflow: ${section}/${width}`
        )
        assert.equal(sizes.headings, 1)
        assert.equal(sizes.visibleForms, 1, `One settings form per section: ${section}`)
        reports.push({ settings: section, ...sizes })
        await writeFile(
          join(artifacts, `settings-${section}-${width}.png`),
          (await win.webContents.capturePage()).toPNG()
        )
      }
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
    await js('document.querySelector(".supervisor-workspace__review-context .primary-button").click()')
    await wait('!!document.querySelector(".supervisor-workspace__toolbar .primary-button")')
    await js(
      'document.querySelector(".supervisor-workspace__toolbar .primary-button").click()'
    )
    await wait(
      'document.documentElement.dataset.reviewNoticeTone === "error"'
    )
    assert(
      await js(
        'document.documentElement.dataset.reviewNoticeMessage.includes("回顾未能完成")'
      )
    )
    await writeFile(
      join(artifacts, 'manual-review-error-390.png'),
      (await win.webContents.capturePage()).toPNG()
    )
    await js('document.querySelector("#supervisor-tab-settings").click()')
    await wait('!!document.querySelector(".heartbeat-settings")')
    assert(await js('!document.querySelector("#supervisor-panel-settings .scope-badge")'))
    assert.equal(await js('document.querySelectorAll("#supervisor-panel-settings [role=tablist]").length'), 1, 'Only the settings section tabs')
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
              tabs: [...document.querySelectorAll('[role=tab][id^="supervisor-tab-"]')].map(e => e.textContent),
              nestedMenus: panel.querySelectorAll('[role=tablist]').length,
              reports: !!panel.querySelector('#heartbeat-reports-title'),
              reportWidth: panel.querySelector('#heartbeat-panel-history > section')?.getBoundingClientRect().width,
              suggestions: !!panel.querySelector('#supervision-suggestions-title'),
              suggestionItems: panel.querySelectorAll('.supervision-suggestions__list > li').length,
              audit: !!panel.querySelector('#heartbeat-runs-title'),
              plans: !!panel.querySelector('#heartbeat-panel-plans'),
              settingsBadge: !!panel.querySelector('.scope-badge'),
              headings: [...panel.querySelectorAll('h2')].map(e => e.textContent),
              refresh: [...panel.querySelectorAll('button')].some(e => e.textContent.includes('刷新')) };
          })()`)
          assert.deepEqual(menuLayout.tabs, ['工作回顾', '故事线图谱', '智能心跳', '活动记录', '设置'])
           assert.equal(menuLayout.nestedMenus, tab === 'graph' || tab === 'settings' ? 1 : 0)
          assert(menuLayout.pageWidth <= width && menuLayout.scrollWidth <= menuLayout.panelWidth, 'Menu panel overflow')
           assert.equal(menuLayout.reports, tab === 'plans')
           if (tab === 'plans') assert(Math.abs(menuLayout.reportWidth - menuLayout.panelWidth) <= 1, 'Reports must use full reading width')
           assert.equal(menuLayout.suggestions, tab === 'plans')
          assert.equal(menuLayout.suggestionItems, tab === 'plans' ? 2 : 0)
          assert.equal(menuLayout.audit, false, 'Run audit belongs to Activity, not Smart heartbeat')
          assert.equal(menuLayout.plans, tab === 'plans')
          if (tab === 'settings') {
            assert(!menuLayout.settingsBadge && !menuLayout.refresh, 'Redundant settings badge/refresh')
            assert(menuLayout.headings.includes('回顾算法') && menuLayout.headings.includes('模型与运行限制'))
          }
          reports.push({ scenario: 'menu-placement', theme, tab, ...menuLayout })
          await writeFile(join(artifacts, `menu-${tab}-${theme}-${width}.png`), (await win.webContents.capturePage()).toPNG())
          const anchors = tab === 'settings' ? ['.supervisor-settings [role=tabpanel]:not([hidden]) form']
             : tab === 'plans' ? ['#heartbeat-panel-overview', '.supervision-suggestions', '#heartbeat-panel-history'] : []
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

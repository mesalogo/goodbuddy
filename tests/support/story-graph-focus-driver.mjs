import assert from 'node:assert/strict'
import console from 'node:console'

export async function validateStoryGraphFocus(win, js, wait, url) {
  await win.loadURL(url + '?spiral=1&recap=1&focus=1')
  await wait('document.querySelector(".supervisor-workspace")?.getAttribute("aria-busy") === "false"')
  await js('document.querySelector("#supervisor-tab-graph").click()')
  await wait('[...document.querySelectorAll("button")].some(b => b.textContent === "时间螺旋")')
  await js('[...document.querySelectorAll("button")].find(b => b.textContent === "时间螺旋").click()')
  await wait('window.focusFrames?.length > 0')
  win.show(); win.focus(); win.webContents.focus()
  await wait('document.hasFocus()')
  const canvas = 'document.querySelector(".story-graph-3d__viewport canvas[tabindex]")'
  const frame = () => js('window.focusFrames.at(-1)')
  const sample = () => js(`new Promise(resolve => {
    const start = performance.now(); const samples = [];
    function tick(now) { samples.push({...window.focusFrames.at(-1)}); if (now-start < 650) requestAnimationFrame(tick); else resolve(samples); }
    requestAnimationFrame(tick);
  })`)
  const changed = (a, b) => Math.hypot(...a.position.map((v, i) => v - b.position[i]))
  const stable = samples => {
    const tail = samples.filter(s => s.at === samples.at(-1).at)
    assert(tail.length > 2, 'Animation finishes and stops requesting frames')
  }
  const pick = async name => {
    await js('document.querySelector(".story-graph-3d__picker").click()')
    await wait('!!document.querySelector(".story-graph-3d__menu [role=menuitem]")')
    await js(`[...document.querySelectorAll('.story-graph-3d__menu [role=menuitem]')].find(b => b.textContent.includes(${JSON.stringify(name)})).click()`)
  }
  const clickTarget = async id => {
    await js(`${canvas}.scrollIntoView()`)
    await js('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
    const at = await js(`(() => { const r=${canvas}.getBoundingClientRect(); const p=window.focusTargets.find(t=>t.id===${JSON.stringify(id)});
      return {x:Math.round(r.left+(p.x+1)*r.width/2),y:Math.round(r.top+(1-p.y)*r.height/2)} })()`)
    assert(await js(`document.elementFromPoint(${at.x},${at.y}) === ${canvas}`), 'Native target is on the visible canvas')
    win.webContents.sendInputEvent({ type: 'mouseMove', ...at })
    win.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...at })
    win.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...at })
  }
  const list = async kind => {
    await js(`(() => { const s=document.querySelector('.supervisor-workspace__category');
      if(s) { s.value='${kind}'; s.dispatchEvent(new Event('change',{bubbles:true})); }
      else document.querySelector('[id$="-list-tab-${kind}"]').click(); })()`)
  }
  const reports = []
  const before = await frame()
  await pick('Fixture project')
  const flight = await sample()
  assert(changed(before, flight.at(-1)) > 100, 'Hierarchy selection moves the actual Three camera')
  assert(new Set(flight.map(s => s.at)).size > 4, 'Focus is animated over multiple rendered frames')
  stable(flight)
  for (let i = 1; i < flight.length; i++) {
    const delta = Math.atan2(Math.sin(flight[i].yaw-flight[i-1].yaw), Math.cos(flight[i].yaw-flight[i-1].yaw))
    assert(Math.abs(delta) < 0.8, 'No discontinuous camera turn')
  }
  reports.push({ hierarchyDistance: changed(before, flight.at(-1)), renderedFrames: new Set(flight.map(s => s.at)).size })
  await js(`for(let i=0;i<55;i++) ${canvas}.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true}))`)
  const turned = await frame()
  await pick('Fixture story')
  const shortFlight = [turned, ...await sample()]
  const rotation = shortFlight.slice(1).reduce((sum, f, i) => sum + Math.abs(Math.atan2(Math.sin(f.yaw-shortFlight[i].yaw), Math.cos(f.yaw-shortFlight[i].yaw))), 0)
  assert(rotation <= Math.PI + 1e-6, 'Focus after a full manual revolution takes the shortest angular path')
  reports.push({ shortestRotation: rotation })
  await list('story')
  await wait('!!document.querySelector(".supervisor-workspace__story-group button")')
  await js('[...document.querySelectorAll(".supervisor-workspace__story-group button")].find(b => b.textContent.includes("Secondary story")).click()')
  await wait('document.querySelector(".story-graph-3d__breadcrumb strong")?.textContent === "Secondary story"')
  stable(await sample())
  await js(`${canvas}.dispatchEvent(new KeyboardEvent('keydown',{key:'2',bubbles:true}))`)
  await sample()
  await clickTarget('feature')
  await wait('document.querySelector(".story-graph-3d__breadcrumb strong")?.textContent === "Fixture story"')
  stable(await sample())
  assert(await js('[...document.querySelectorAll(".supervisor-workspace__story-group button")].find(b=>b.textContent.includes("Fixture story")).getAttribute("aria-pressed") === "true"'))
  await list('experience')
  await wait('!!document.querySelector("[id$=list-panel-experience] button")')
  await js('document.querySelector("[id$=list-panel-experience] button").click()')
  stable(await sample())
  let target = await js('window.focusTargets.find(t => t.id === "focus-experience")')
  assert(target && Math.abs(target.x) < 0.01 && Math.abs(target.y) < 0.01, 'External experience selection centers its actual diamond')
  await js(`${canvas}.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true}))`)
  await clickTarget('focus-experience')
  stable(await sample())
  target = await js('window.focusTargets.find(t => t.id === "focus-experience")')
  assert(Math.abs(target.x) < 0.01 && Math.abs(target.y) < 0.01, 'Native diamond pick refocuses the experience')
  // Root has no within-project experience link. Selecting it must expose the project level.
  await js('document.querySelector(".story-graph-3d__breadcrumb button").click()')
  await sample()
  await list('event')
  await wait('!!document.querySelector(".supervisor-workspace__list-panel button")')
  await js('document.querySelector(".supervisor-workspace__list-panel button").click()')
  stable(await sample())
  await list('experience')
  await js('document.querySelector("[id$=list-panel-experience] button").click()')
  stable(await sample())
  assert.equal(await js('document.querySelector(".story-graph-3d__breadcrumb strong").textContent'), 'Fixture project')
  for (const width of [1440, 390]) {
    win.setContentSize(width, 1000)
    await wait(`innerWidth === ${width}`)
    await list('event')
    await js('document.querySelectorAll(".supervisor-workspace__list-panel button")[1].click()')
    stable(await sample())
    target = await js('window.focusTargets.find(t => t.id === "event-1")')
    assert(target && Math.abs(target.x) < 0.01 && Math.abs(target.y) < 0.01, 'External event centers at both viewport widths')
    reports.push({ width, eventProjection: target })
    await js('document.querySelector(".supervisor-workspace__list-panel button").click()')
    await sample()
  }
  win.setContentSize(1440, 1000)
  await wait('innerWidth === 1440')
  await js('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
  // A native canvas click must select the dot through its translucent stave and refocus it.
  await js(`${canvas}.focus(); ${canvas}.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true}))`)
  const dot = await js(`(() => { const c=${canvas}; c.scrollIntoView(); const r=c.getBoundingClientRect();
    const p=window.focusTargets.find(t=>t.id==='event-0'); return {x:Math.round(r.left+(p.x+1)*r.width/2),y:Math.round(r.top+(1-p.y)*r.height/2)} })()`)
  const hitElement = await js(`document.elementFromPoint(${dot.x},${dot.y})?.outerHTML.slice(0,300)`)
  assert(await js(`document.elementFromPoint(${dot.x},${dot.y}) === ${canvas}`), `Canvas hit point: ${JSON.stringify({ dot, hitElement })}`)
  win.webContents.sendInputEvent({ type: 'mouseMove', ...dot })
  win.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...dot })
  win.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...dot })
  await sample()
  target = await js('window.focusTargets.find(t=>t.id==="event-0")')
  assert(Math.abs(target.x) < 0.01 && Math.abs(target.y) < 0.01, `Native canvas dot click recenters the selected event: ${JSON.stringify({target, dot, hitElement, current:await frame()})}`)
  assert(await js('document.querySelector(".supervisor-workspace__list-panel button").getAttribute("aria-pressed") === "true"'))
  for (const input of ['keyboard', 'wheel', 'drag']) {
    await pick('Secondary story')
    await wait('window.focusFrames.at(-1).zoom > 0')
    await js(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`)
    const pre = await frame()
    if (input === 'keyboard') {
      await js(`${canvas}.focus()`)
      win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Left' })
      win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Left' })
    } else {
      const at = await js(`(() => { const c=${canvas}; c.scrollIntoView(); const r=c.getBoundingClientRect(); return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)} })()`)
      if (input === 'wheel') win.webContents.sendInputEvent({ type: 'mouseWheel', ...at, deltaY: 70, deltaX: 0 })
      else {
        win.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...at })
        win.webContents.sendInputEvent({ type: 'mouseMove', button: 'left', modifiers: ['leftButtonDown'], x: at.x+30, y: at.y+10 })
        win.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, x: at.x+30, y: at.y+10 })
      }
    }
    await wait(`window.focusFrames.at(-1).at > ${pre.at}`)
    const interrupted = await frame(), samples = await sample()
    assert.deepEqual(samples.at(-1).position, interrupted.position, `${input} cancels the in-flight focus`)
    assert.equal(samples.at(-1).zoom, interrupted.zoom)
    reports.push({ interruption: input, position: interrupted.position, zoom: interrupted.zoom })
  }
  const manual = await frame()
  for (let i = 0; i < 3; i++) {
    await js('document.querySelector(".supervisor-workspace__review-context > .secondary-button").click()')
    await wait('document.querySelector(".supervisor-workspace")?.getAttribute("aria-busy") === "false"')
    await sample()
    assert.deepEqual((await frame()).position, manual.position, 'Equal-content refresh does not refocus')
  }
  win.webContents.debugger.attach('1.3')
  await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] })
  await wait('matchMedia("(prefers-reduced-motion: reduce)").matches')
  await js('window.focusFrames = []')
  await pick('Fixture story')
  await sample()
  const reduced = await js('window.focusFrames')
  assert(new Set(reduced.map(s => JSON.stringify(s.position))).size <= 2, 'Reduced motion applies a single camera jump')
  win.webContents.debugger.detach()
  await pick('Secondary story')
  await wait('window.focusRafs.size > 0')
  await js('[...document.querySelectorAll(".supervisor-workspace__graph-mode button")].find(b=>b.getAttribute("aria-pressed")==="false").click()')
  await wait('!document.querySelector(".story-graph-3d__gl")')
  assert.equal(await js('window.focusRafs.size'), 0, 'Unmount cancels the owned camera RAF')
  await win.loadURL(url + '?spiral=1&recap=1&focus=1&real-export=1')
  await wait('document.querySelector(".supervisor-workspace")?.getAttribute("aria-busy") === "false"')
  await js('document.querySelector("#supervisor-tab-graph").click()')
  await wait('[...document.querySelectorAll("button")].some(b => b.textContent === "时间螺旋")')
  await js('[...document.querySelectorAll("button")].find(b => b.textContent === "时间螺旋").click()')
  await wait('window.focusFrames?.length > 0')
  await sample()
  const realBefore = await frame()
  await list('story')
  await wait('!!document.querySelector(".supervisor-workspace__story-group button")')
  await js('document.querySelector(".supervisor-workspace__story-group button").click()')
  const realFlight = await sample()
  assert(changed(realBefore, realFlight.at(-1)) > 5, 'Checked-in real export selection moves the production camera')
  stable(realFlight)
  await js(`${canvas}.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true}))`)
  const realManual = await frame()
  await js('document.querySelector(".supervisor-workspace__review-context > .secondary-button").click()')
  await wait('document.querySelector(".supervisor-workspace")?.getAttribute("aria-busy") === "false"')
  await sample()
  assert.deepEqual((await frame()).position, realManual.position)
  const realExport = { ...await js('JSON.parse(document.documentElement.dataset.exportCounts)'), cameraDistance: changed(realBefore, realFlight.at(-1)) }
  console.log(JSON.stringify({ storyGraphFocus: 'passed', reports, refreshes: 4, reducedMotionFrames: reduced.length, canvasClick: true, unmountPendingRafs: 0, realExport, modelCalls: 0 }))
}

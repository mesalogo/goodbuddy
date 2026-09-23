import { app, BrowserWindow, nativeImage } from 'electron'
import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { URLSearchParams } from 'node:url'
import process from 'node:process'
import console from 'node:console'
import { setTimeout } from 'node:timers/promises'

const directory = process.env.GOODBUDDY_MERMAID_DIRECTORY
const artifacts = process.env.GOODBUDDY_MERMAID_ARTIFACTS || directory
app.setPath('userData', join(directory, 'profile'))
app.commandLine.appendSwitch('force-device-scale-factor', '1')

app.whenReady().then(async () => {
  await mkdir(artifacts, { recursive: true })
  const win = new BrowserWindow({
    show: false, width: 1440, height: 1000, useContentSize: true,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false }
  })
  const errors = []
  win.webContents.on('console-message', event => {
    if (event.level === 'error') errors.push(event.message)
  })
  const js = code => win.webContents.executeJavaScript(code)
  const wait = async code => {
    for (let attempt = 0; attempt < 600; attempt++) {
      if (await js(code)) return
      await setTimeout(25)
    }
    throw new Error(`Timeout: ${code}\n${errors.join('\n')}`)
  }
  // Hidden Chromium windows can throttle animation frames even with backgroundThrottling disabled.
  const settle = () => setTimeout(25)
  const click = async selector => {
    const point = await js(`(() => {
      const e = document.querySelector(${JSON.stringify(selector)});
      if (!e || e.disabled) throw new Error('Missing/disabled control: ' + ${JSON.stringify(selector)});
      const r = e.getBoundingClientRect(), x = r.x + r.width / 2, y = r.y + r.height / 2;
      if (!e.contains(document.elementFromPoint(x, y))) throw new Error('Control not mouse reachable: ' + ${JSON.stringify(selector)});
      return { x: Math.round(x), y: Math.round(y) };
    })()`)
    win.webContents.sendInputEvent({ type: 'mouseDown', ...point, button: 'left', clickCount: 1 })
    win.webContents.sendInputEvent({ type: 'mouseUp', ...point, button: 'left', clickCount: 1 })
    await settle()
  }
  const download = async (name, label, dimensions) => {
    assert(await js(`!!document.querySelector('.mermaid-viewer button[aria-label="${label}"]')`), `Missing export button: ${label}`)
    const path = join(artifacts, `${name}.png`)
    let listener
    let timer
    const completed = new Promise((resolve, reject) => {
      timer = globalThis.setTimeout(() => reject(new Error(`No completed PNG download: ${name}`)), 15_000)
      listener = (_event, item) => {
        try {
          assert.match(item.getFilename(), /\.png$/iu)
          assert.equal(item.getMimeType(), 'image/png')
          item.setSavePath(path)
          item.once('done', (_event, state) => {
            if (state === 'completed') resolve()
            else reject(new Error(`Download ${state}: ${name}`))
          })
        } catch (error) { reject(error) }
      }
      win.webContents.session.once('will-download', listener)
    })
    try {
      await Promise.all([completed, click(`.mermaid-viewer button[aria-label="${label}"]`)])
    } finally {
      globalThis.clearTimeout(timer)
      win.webContents.session.removeListener('will-download', listener)
    }
    const bytes = await readFile(path)
    assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a')
    const image = nativeImage.createFromBuffer(bytes)
    const { width, height } = image.getSize()
    const scale = Math.min(2, 4096 / (dimensions.width + 32), 4096 / (dimensions.height + 32))
    assert(Math.abs(width - (dimensions.width + 32) * scale) <= 1, `PNG width ${width}: ${JSON.stringify(dimensions)}`)
    assert(Math.abs(height - (dimensions.height + 32) * scale) <= 1, `PNG height ${height}: ${JSON.stringify(dimensions)}`)
    assert(width <= 4096 && height <= 4096)
    // NativeImage decodes the actual saved PNG to BGRA, independent of the export canvas.
    const bitmap = image.toBitmap()
    const colors = { red: 0, green: 0, blue: 0 }
    const bounds = { left: width, top: height, right: 0, bottom: 0 }
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const offset = (y * width + x) * 4
        const [b, g, r, a] = bitmap.subarray(offset, offset + 4)
        const color = a > 240 && (r > 220 && g < 35 && b < 35 ? 'red'
          : g > 220 && r < 35 && b < 35 ? 'green'
            : b > 220 && r < 35 && g < 35 ? 'blue' : undefined)
        if (color) {
          colors[color]++
          bounds.left = Math.min(bounds.left, x)
          bounds.top = Math.min(bounds.top, y)
          bounds.right = Math.max(bounds.right, x)
          bounds.bottom = Math.max(bounds.bottom, y)
        }
      }
    }
    assert(Object.values(colors).every(count => count > 30), `Missing start/middle/end content: ${JSON.stringify(colors)}`)
    const padding = Math.floor(16 * scale) - 1
    assert(bounds.left >= padding && bounds.top >= padding && bounds.right < width - padding && bounds.bottom < height - padding,
      `Missing PNG padding: ${JSON.stringify({ bounds, padding, width, height })}`)
    return { width, height, colors, bitmap }
  }
  const reports = []
  const failures = []
  const scenarios = ['light', 'dark'].flatMap(theme => [1440, 390].flatMap(width =>
    ['wide', 'tall'].map(shape => ({ theme, width, shape, locale: width === 390 ? 'zh-CN' : 'en-US' }))))
  scenarios.push({ theme: 'light', width: 1440, shape: 'small', locale: 'en-US' })
  for (const scenario of scenarios) {
    const { theme, width, shape, locale } = scenario
    const name = `${theme}-${width}-${shape}`
    win.setContentSize(width, width === 390 ? 740 : 1000)
    await win.loadURL(`${process.env.GOODBUDDY_MERMAID_URL}?${new URLSearchParams({ theme, shape, locale })}`)
    await wait('!!document.querySelector(".mermaid-diagram[aria-busy=false] .mermaid-diagram__viewport > svg")')
    await js('document.fonts.ready')
    await click('.mermaid-diagram__actions button:last-child')
    await wait('!!document.querySelector(".mermaid-viewer__diagram > svg")')
    const dimensions = await js(`(() => {
      const svg = document.querySelector('.mermaid-viewer__diagram > svg');
      return { width: Number(svg.getAttribute('width')), height: Number(svg.getAttribute('height')), nodes: svg.querySelectorAll('.node').length,
        themeFill: getComputedStyle(svg.querySelector('.node[id*="-N1-"] rect')).fill };
    })()`)
    assert.equal(dimensions.nodes, shape === 'small' ? 3 : 24, 'Must render the real Mermaid graph')
    const label = locale === 'en-US' ? 'Export PNG' : '\u5bfc\u51fa PNG'
    let before
    if (shape === 'small') {
      try { before = await download(`${name}-100`, label, dimensions) }
      catch (error) { failures.push(`${name}-100: ${error.message}`) }
    }
    for (let step = 0; step < 8; step++) {
      await click('.mermaid-viewer button:has(.lucide-zoom-in)')
      await wait(`document.querySelector('.mermaid-viewer__zoom').textContent === '${125 + step * 25}%'`)
    }
    assert.equal(await js('document.querySelector(".mermaid-viewer__zoom").textContent'), '300%')
    const corners = []
    for (const [horizontal, vertical] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
      await js(`(() => { const e = document.querySelector('.mermaid-viewer__canvas'); e.scrollLeft = ${horizontal} * e.scrollWidth; e.scrollTop = ${vertical} * e.scrollHeight; })()`)
      await settle()
      const corner = await js(`(() => {
        const e = document.querySelector('.mermaid-viewer__canvas'), c = e.getBoundingClientRect();
        const s = document.querySelector('.mermaid-viewer__diagram > svg').getBoundingClientRect();
        const m = document.querySelector('.mermaid-viewer').getBoundingClientRect();
        const b = document.querySelector('.mermaid-viewer-backdrop').getBoundingClientRect();
        return { left: s.left - c.left - e.clientLeft, top: s.top - c.top - e.clientTop,
          right: c.left + e.clientLeft + e.clientWidth - s.right, bottom: c.top + e.clientTop + e.clientHeight - s.bottom,
          scrollX: e.scrollLeft, scrollY: e.scrollTop, overflowX: e.scrollWidth - e.clientWidth, overflowY: e.scrollHeight - e.clientHeight,
          modalFits: m.left >= 0 && m.right <= innerWidth && m.top >= 0 && m.bottom <= innerHeight,
          backdropFits: b.top === 0 && b.left === 0 && b.right === innerWidth && b.bottom === innerHeight };
      })()`)
      if (!corner.modalFits || !corner.backdropFits) failures.push(`${name}: modal/backdrop outside viewport ${JSON.stringify(corner)}`)
      if (corner[horizontal ? 'right' : 'left'] < -1) failures.push(`${name}: unreachable horizontal edge ${JSON.stringify(corner)}`)
      if (corner[vertical ? 'bottom' : 'top'] < -1) failures.push(`${name}: unreachable vertical edge ${JSON.stringify(corner)}`)
      if (shape !== 'small') assert(corner[shape === 'wide' ? 'overflowX' : 'overflowY'] > 1000, 'Fixture must overflow substantially at 300%')
      corners.push(corner)
      await writeFile(join(artifacts, `${name}-corner-${horizontal}-${vertical}.png`), (await win.webContents.capturePage()).toPNG())
    }
    let png
    try {
      const result = await download(`${name}-300`, label, dimensions)
      if (before) assert(result.bitmap.equals(before.bitmap), 'PNG content must not depend on modal zoom or scroll position')
      png = { width: result.width, height: result.height, colors: result.colors }
    } catch (error) {
      failures.push(`${name}-300: ${error.message}`)
      console.log(`Mermaid ${name}: ${error.message}`)
    }
    reports.push({ ...scenario, dimensions, corners, png })
    await writeFile(join(artifacts, 'mermaid-measurements.json'), JSON.stringify({ reports, failures }, null, 2))
    console.log(`Mermaid ${name}: measured four corners at 300%; ${png ? `downloaded ${png.width}x${png.height} PNG with start/middle/end content` : 'PNG FAILED'}`)
  }
  assert.deepEqual(errors, [], 'Renderer console errors')
  for (const shape of ['wide', 'tall']) {
    const fills = reports.filter(report => report.width === 1440 && report.shape === shape).map(report => report.dimensions.themeFill)
    assert.notEqual(fills[0], fills[1], 'Real Mermaid rendering must follow the selected theme')
  }
  await writeFile(join(artifacts, 'mermaid-measurements.json'), JSON.stringify({ reports, failures }, null, 2))
  assert.deepEqual(failures, [], 'Mermaid modal/download regression')
  console.log(`Mermaid PASS: ${reports.length} scenarios; 10 real PNG downloads; artifacts ${artifacts}`)
  win.destroy()
  app.quit()
}).catch(error => {
  console.error(error)
  app.exit(1)
})

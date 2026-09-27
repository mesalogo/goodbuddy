import { app, BrowserWindow } from 'electron'
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import process from 'node:process'
import console from 'node:console'
import { setTimeout } from 'node:timers/promises'

app.setPath('userData', join(process.env.GB_CONTROLS_DIRECTORY, 'profile'))
app.commandLine.appendSwitch('force-device-scale-factor', '1')
const artifacts = process.env.GB_SHARED_CONTROLS_ARTIFACTS
const observations = []
const errors = []
const contrast = (a, b) => {
  const luminance = color => color.match(/[\d.]+/g).slice(0, 3).map(Number)
    .map(v => v / 255).map(v => v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)
    .reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i], 0)
  const values = [luminance(a), luminance(b)].sort((a, b) => a - b)
  return (values[1] + 0.05) / (values[0] + 0.05)
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: true, width: 1280, height: 800, useContentSize: true,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } })
  win.webContents.on('console-message', event => { if (event.level === 'error') errors.push(event.message) })
  const js = code => win.webContents.executeJavaScript(code)
  const wait = async code => {
    for (let i = 0; i < 200; i++) {
      if (await js(code)) return
      await setTimeout(25)
    }
    throw new Error(`Timeout: ${code}`)
  }
  const settle = () => js(`Promise.all(document.getAnimations().filter(a => a.effect.getTiming().iterations !== Infinity)
    .map(a => a.finished.catch(() => {}))).then(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))`)
  const measure = async (selector, state) => {
    await settle()
    const style = await js(`(() => {
      const e = document.querySelector(${JSON.stringify(selector)}), s = getComputedStyle(e), r = e.getBoundingClientRect();
      const rgb = name => { const span = document.createElement('span'); span.style.color = s.getPropertyValue(name); e.parentElement.append(span);
        const value = getComputedStyle(span).color; span.remove(); return value };
      return { color:s.color, background:s.backgroundColor, border:s.borderTopColor, borderStyle:s.borderTopStyle,
        radius:s.borderRadius, padding:s.padding, minHeight:s.minHeight, width:r.width, height:r.height,
        font:s.fontFamily, opacity:s.opacity, cursor:s.cursor, outline:s.outlineStyle, outlineWidth:s.outlineWidth,
        outlineColor:s.outlineColor, focusVisible:e.matches(':focus-visible'), disabled:e.matches(':disabled'),
        tokens:Object.fromEntries(['--accent','--accent-solid','--accent-solid-hover','--text-on-accent','--text-secondary',
          '--text-muted','--danger','--danger-solid','--danger-solid-hover','--danger-subtle','--border-control','--surface-raised']
          .map(name=>[name,rgb(name)])) };
    })()`)
    observations.push({ theme: await js('document.documentElement.dataset.theme'), selector, state, ...style })
    return style
  }
  const hover = async (selector, enabled) => {
    const { root } = await win.webContents.debugger.sendCommand('DOM.getDocument')
    const { nodeId } = await win.webContents.debugger.sendCommand('DOM.querySelector', { nodeId: root.nodeId, selector })
    await win.webContents.debugger.sendCommand('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: enabled ? ['hover'] : [] })
  }
  const disabled = (selector, value) => js(`document.querySelector(${JSON.stringify(selector)}).disabled = ${value}`)
  const focus = async selector => {
    await js(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); e.scrollIntoView({block:'center'});
      const start = document.createElement('button'); start.id='focus-start'; start.textContent='Focus start'; e.before(start); start.focus(); })()`)
    win.focus(); win.webContents.focus()
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Tab' })
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Tab' })
    await wait(`document.activeElement === document.querySelector(${JSON.stringify(selector)})`)
    await js('document.getElementById("focus-start").remove()')
    const s = await measure(selector, 'native-tab-focus')
    assert.equal(s.focusVisible, true, selector)
    assert.equal(s.outline, 'solid', selector)
    assert.equal(s.outlineWidth, '2px', selector)
    assert.equal(s.outlineColor, s.tokens['--accent'], selector)
  }
  const screenshot = async name => {
    await settle()
    if (artifacts) await writeFile(join(artifacts, `${name}.png`), (await win.webContents.capturePage()).toPNG())
  }
  try {
    if (artifacts) await mkdir(artifacts, { recursive: true })
    await win.loadURL(process.env.GB_CONTROLS_URL)
    await wait('!!document.querySelector(".runtime-customization-item textarea")')
    await js('document.fonts.ready')
    win.webContents.debugger.attach('1.3')
    await win.webContents.debugger.sendCommand('DOM.enable')
    await win.webContents.debugger.sendCommand('CSS.enable')
    for (const theme of ['light', 'dark']) {
      await js(`document.getElementById('theme-${theme}').click()`)
      for (const container of ['settings', 'portal']) {
        await js(`document.getElementById('portal-controls').style.display = '${container === 'portal' ? 'block' : 'none'}'`)
        const base = `[data-controls="${container}"]`
        const classes = ['primary-button', 'secondary-button', 'danger-solid', 'danger-button', 'danger-button danger-button--quiet',
          'danger-ghost', 'icon-button', 'danger-ghost icon-button', 'icon-button icon-button--active']
        for (const className of classes) {
          const selector = `${base} [data-button="${className}"]`
          const normal = await measure(selector, 'default')
          if (className === 'secondary-button') assert.equal(normal.border, normal.tokens['--border-control'])
          if (className.includes('danger-ghost')) assert.equal(normal.color, normal.tokens['--danger'])
          if (className === 'icon-button icon-button--active') assert.equal(normal.color, normal.tokens['--accent'])
          await hover(selector, true)
          const hovered = await measure(selector, 'hover')
          if (className.includes('danger-ghost')) {
            assert.equal(hovered.color, hovered.tokens['--danger'])
            assert.equal(hovered.background, hovered.tokens['--danger-subtle'])
          }
          if (['primary-button', 'danger-solid'].includes(className)) {
            for (const s of [normal, hovered]) assert(contrast(s.color, s.background) >= 4.5, `${theme} ${className} contrast`)
          }
          await hover(selector, false)
          await disabled(selector, true)
          const inactive = await measure(selector, 'disabled')
          assert.equal(inactive.cursor, 'not-allowed', selector)
          assert(Number(inactive.opacity) < 1, selector)
          await hover(selector, true)
          const inactiveHover = await measure(selector, 'disabled-hover')
          assert.equal(inactiveHover.background, inactive.background, selector)
          assert.equal(inactiveHover.color, inactive.color, selector)
          await hover(selector, false)
          await disabled(selector, false)
          await focus(selector)
        }
        for (const kind of ['text', 'select', 'textarea', 'switch', 'radio', 'checkbox', 'address', 'dialog']) {
          const selector = `${base} [data-input="${kind}"]`
          const s = await measure(selector, 'default')
          if (['text', 'select', 'textarea', 'address', 'dialog'].includes(kind)) {
            assert.equal(s.border, s.tokens['--border-control'], selector)
            assert(contrast(s.border, s.background) >= 3, selector)
          } else {
            assert.equal(s.height, kind === 'switch' ? 22 : 15, selector)
            assert.equal(s.width, kind === 'switch' ? 38 : 15, selector)
          }
          await focus(selector)
        }
        for (const variant of ['default', 'segmented']) {
          const tab = `${base} .page-tabs--${variant} .page-tabs__tab--active`
          const selected = await measure(tab, 'active')
          await hover(tab, true)
          const selectedHover = await measure(tab, 'active-hover')
          assert.equal(selectedHover.background, selected.background)
          assert.equal(selectedHover.color, selected.color)
          await hover(tab, false)
          await focus(tab)
        }
        for (const suffix of ['--active', ':not(.segmented-control__option--active)']) {
          const selector = `${base} .segmented-control__option${suffix}`
          await disabled(selector, true)
          const s = await measure(selector, 'disabled-segment')
          assert.equal(s.cursor, 'not-allowed')
          assert(Number(s.opacity) < 1)
          await disabled(selector, false)
          await focus(selector)
        }
        for (const menu of ['conversation-actions', 'workspace-files__menu']) {
          const menuGhost = `${base} .${menu} [data-menu-ghost]`
          await disabled(menuGhost, true)
          await hover(menuGhost, true)
          const disabledGhost = await measure(menuGhost, 'menu-disabled-danger-hover')
          assert.equal(disabledGhost.color, disabledGhost.tokens['--text-muted'])
          assert.equal(disabledGhost.background, 'rgba(0, 0, 0, 0)')
          await hover(menuGhost, false)
          await disabled(menuGhost, false)
          const trigger = `${base} .${menu} .danger-button--quiet`
          const triggerStyle = await measure(trigger, 'menu-danger-trigger')
          assert.equal(triggerStyle.color, triggerStyle.tokens['--danger'])
          await js(`document.querySelector(${JSON.stringify(trigger)}).click()`)
          const confirm = `${base} .${menu} .danger-confirm .danger-button`
          await wait(`!!document.querySelector(${JSON.stringify(confirm)})`)
          const confirmStyle = await measure(confirm, 'menu-danger-confirm')
          assert.equal(confirmStyle.color, confirmStyle.tokens['--text-on-accent'])
          assert.equal(confirmStyle.background, confirmStyle.tokens['--danger-solid'])
          await hover(confirm, true)
          const confirmHover = await measure(confirm, 'menu-danger-confirm-hover')
          assert.equal(confirmHover.background, confirmStyle.background)
          assert.equal(confirmHover.color, confirmStyle.color)
          await hover(confirm, false)
          await js(`document.querySelector('${base} .${menu} .danger-confirm .secondary-button').click()`)
          await wait(`!document.querySelector(${JSON.stringify(confirm)})`)
        }
        await screenshot(`${theme}-${container}`)
      }
      await js("document.getElementById('portal-controls').style.display='none'")
      const controls = await js(`Array.from(document.querySelectorAll('.runtime-customization-item .field-control')).map((e,i)=>{e.dataset.actualControl=i;return '[data-actual-control="'+i+'"]'})`)
      assert.equal(controls.length, 5)
      for (const selector of controls) {
        const s = await measure(selector, 'actual-continue-field')
        assert.equal(s.borderStyle, 'solid')
        assert.equal(s.border, s.tokens['--border-control'])
        assert.equal(s.radius, '9px')
        assert(s.height >= 38)
        assert(s.font.includes('Inter Variable'))
        await focus(selector)
      }
      const danger = '.runtime-customization-item .danger-ghost.icon-button'
      await hover(danger, true)
      const s = await measure(danger, 'actual-continue-danger-hover')
      assert.equal(s.color, s.tokens['--danger'])
      assert.equal(s.background, s.tokens['--danger-subtle'])
      await hover(danger, false)
      await js("document.querySelector('.runtime-preset-editor').scrollIntoView({block:'start'})")
      await screenshot(`${theme}-continue`)
    }
    assert.deepEqual(errors, [])
    if (artifacts) await writeFile(join(artifacts, 'computed.json'), JSON.stringify({ observations, errors, modelCalls: 0 }, null, 2))
    console.log(`Shared controls: ${observations.length} computed observations; light/dark, settings/body Portal, native Tab, actual Continue; model calls: 0`)
    app.exit(0)
  } catch (error) {
    console.error(error)
    if (artifacts) {
      await screenshot('failure')
      await writeFile(join(artifacts, 'failure.json'), JSON.stringify({ observations, errors, failure: String(error.stack) }, null, 2))
    }
    app.exit(1)
  }
})

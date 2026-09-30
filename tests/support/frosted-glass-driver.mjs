import { app, BrowserWindow, screen } from 'electron'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import process from 'node:process'
import console from 'node:console'
import { createRequire } from 'node:module'
import { setTimeout } from 'node:timers/promises'

app.setPath('userData', join(process.env.GB_GLASS_DIRECTORY, 'profile'))
app.commandLine.appendSwitch('force-device-scale-factor', '1')

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: true, frame: false, width: 1280, height: 800, useContentSize: true,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, spellcheck: false, backgroundThrottling: false } })
  win.webContents.on('console-message', event => console.log('Renderer:', event.message))
  win.webContents.on('preload-error', (_event, _path, error) => console.error(error))
  await win.loadURL(process.env.GB_GLASS_URL)
   await win.webContents.executeJavaScript(`new Promise((resolve, reject) => {
     setTimeout(() => reject(new Error('Fixture did not mount: ' + document.body.innerText)), 15000);
    const ready = () => {
      const toggle = document.querySelector('.runtime-checklist__toggle');
      if (!toggle) return requestAnimationFrame(ready);
      toggle.click();
      const expanded = () => document.querySelector('.runtime-checklist__content')
        ? resolve(true) : requestAnimationFrame(expanded);
      expanded();
    };
    ready();
  })`)
  await win.webContents.executeJavaScript('document.fonts.ready.then(() => true)')
  let baselineLayout
  for (const theme of ['light', 'dark']) {
    let off
    for (const state of [null, 'true', null, 'false']) {
      const label = `${theme}/${state ?? 'absent'}`
      const result = await win.webContents.executeJavaScript(`(async () => {
        document.documentElement.dataset.theme = ${JSON.stringify(theme)};
        const shell = document.querySelector('.app-shell');
        const state = ${JSON.stringify(state)};
        for (const node of [shell, document.documentElement]) {
          if (state === null) node.removeAttribute('data-frosted-glass');
          else node.dataset.frostedGlass = state;
        }
        await Promise.all(document.getAnimations()
          .filter(animation => animation instanceof CSSTransition)
          .map(animation => animation.finished));
        const panel = document.querySelector('.runtime-checklist__content');
        if (shell.contains(panel) || !panel.closest('.floating-portal').matches(':popover-open'))
          throw new Error('Checklist must render outside app-shell in the top layer');
        const selectors = ['.app-shell', '.app-frame', '.topbar', '.workspace',
          '.runtime-checklist', '.runtime-checklist__content', '[data-ordinary-menu]',
          '.topbar button', '.topbar input', '.topbar select', '.topbar__actions', '.window-controls', '.window-control'];
        return Object.fromEntries(selectors.map(selector => {
          const e = document.querySelector(selector), s = getComputedStyle(e), r = e.getBoundingClientRect();
          return [selector, { background: s.backgroundColor, image: s.backgroundImage,
            blur: s.backdropFilter, color: s.color, opacity: s.opacity, region: s.getPropertyValue('-webkit-app-region'),
            layout: [r.x, r.y, r.width, r.height, s.display, s.gridTemplateRows, s.padding, s.gap] }];
        }));
      })()`)
      const topbar = result['.topbar']
      assert.equal(topbar.region, 'drag', label)
      for (const selector of ['.topbar button', '.topbar input', '.topbar select', '.topbar__actions', '.window-controls', '.window-control']) {
        assert.equal(result[selector].region, 'no-drag', `${label} ${selector}`)
      }
      const layout = Object.fromEntries(Object.entries(result).filter(([selector]) => selector !== '.workspace').map(([selector, value]) => [selector, value.layout]))
      baselineLayout ??= layout
      assert.deepEqual(layout, baselineLayout, `${label} layout`)
      assert.equal(topbar.layout[3], 58, `${label} topbar height`)
      assert.ok(result['.workspace'].layout[3] > 0, `${label} workspace is visible`)
      const alpha = Number(topbar.background.match(/^rgba?\((.*)\)$/)[1].split(',')[3] ?? 1)
      if (state === 'true') {
        assert.equal(alpha, theme === 'light' ? 0.65 : 0.7, `${label} alpha`)
        assert.equal(topbar.background, theme === 'light' ? 'rgba(255, 255, 255, 0.65)' : 'rgba(7, 16, 31, 0.7)', label)
        assert.equal(topbar.blur, 'blur(18px)', label)
        assert.equal(result['.app-frame'].image, 'none', label)
        assert.equal(result['.workspace'].layout[1], off['.workspace'].layout[1] - 58, `${label} chat extends behind topbar`)
        assert.deepEqual(result['.runtime-checklist'], off['.runtime-checklist'], `${label} solid strip unchanged`)
        assert.deepEqual(result['[data-ordinary-menu]'], off['[data-ordinary-menu]'], `${label} other menus unchanged`)
        const panel = result['.runtime-checklist__content']
        assert.equal(panel.background, theme === 'light' ? 'rgba(255, 255, 255, 0.75)' : 'rgba(7, 16, 31, 0.75)', label)
        assert.equal(panel.blur, 'blur(18px)', label)
        assert.equal(panel.opacity, '1', `${label} text stays opaque`)
        const rgb = value => value.match(/[\d.]+/g).map(Number)
        const luminance = values => values.map(value => {
          const channel = value / 255
          return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
        }).reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index], 0)
        const text = luminance(rgb(panel.color))
        const background = luminance(rgb(panel.background).slice(0, 3).map(value => value * 0.75 + (theme === 'light' ? 0 : 255) * 0.25))
        assert.ok((Math.max(text, background) + 0.05) / (Math.min(text, background) + 0.05) >= 4.5, `${label} checklist text contrast`)
      } else {
        assert.equal(alpha, 1, `${label} opaque background`)
        assert.equal(topbar.blur, 'none', label)
        assert.equal(result['.app-frame'].image, 'none', label)
        off ??= result
        assert.deepEqual(result, off, `${label} restores original styles`)
      }
      console.log(`FrostedGlass ${label}: alpha=${alpha}, backdrop-filter=${topbar.blur}, drag regions and surrounding layout preserved`)
    }
  }

  const evaluate = source => win.webContents.executeJavaScript(source)
  const waitFor = source => evaluate(`new Promise((resolve, reject) => {
    const deadline = performance.now() + 5000;
    const check = () => { if (${source}) resolve(true);
      else if (performance.now() > deadline) reject(new Error(${JSON.stringify(source)}));
      else requestAnimationFrame(check); }; check(); })`)
  const click = async selector => {
    const point = await evaluate(`(() => { const e = document.querySelector(${JSON.stringify(selector)});
      const r = e.getBoundingClientRect(); const x = r.x + r.width / 2, y = r.y + r.height / 2;
      if (!e.contains(document.elementFromPoint(x, y))) throw new Error('Click target obscured: ' + ${JSON.stringify(selector)});
      return { x: Math.round(x), y: Math.round(y) }; })()`)
    win.webContents.sendInputEvent({ type: 'mouseDown', ...point, button: 'left', clickCount: 1 })
    win.webContents.sendInputEvent({ type: 'mouseUp', ...point, button: 'left', clickCount: 1 })
  }
  win.focus()
  console.log('FrostedGlass starting native interaction checks')
  await waitFor('document.hasFocus()')
  await click('.runtime-checklist__toggle')
  await waitFor("!document.querySelector('.runtime-checklist__content')")
  await evaluate(`document.querySelector('.chat-history-pane[data-active="true"] .chat').scrollTop = 400`)
  await waitFor("document.querySelector('.chat-scroll-to-bottom') !== null")
  const toggleAnchor = await evaluate(`document.querySelector('.chat-history-pane[data-active="true"] article').getBoundingClientRect().top`)
  for (const enabled of [true, false]) {
    await evaluate(`for (const e of [document.documentElement, document.querySelector('.app-shell')]) e.dataset.frostedGlass = '${enabled}'`)
    await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
    assert.equal(await evaluate(`document.querySelector('.chat-history-pane[data-active="true"] article').getBoundingClientRect().top`), toggleAnchor, 'toggle preserves reader position')
  }
  for (const theme of ['light', 'dark']) {
    await evaluate(`document.documentElement.dataset.theme = '${theme}'`)
    for (const enabled of [false, true, false]) {
      await evaluate(`for (const e of [document.documentElement, document.querySelector('.app-shell')]) e.dataset.frostedGlass = '${enabled}';
        document.querySelector('.chat-history-pane[data-active="true"] .chat').scrollTop = 0;`)
      await waitFor("document.querySelector('.chat-scroll-to-bottom') !== null")
      const geometry = await evaluate(`(() => {
        const rect = selector => { const r = document.querySelector(selector).getBoundingClientRect(); return { top:r.top, bottom:r.bottom, height:r.height }; };
        return { topbar:rect('.topbar'), viewport:rect('.chat-history-pane[data-active="true"] .chat'),
          first:rect('.chat-history-pane[data-active="true"] article'), strip:rect('.runtime-checklist'),
          composer:rect('.composer-wrap'), workbar:rect('[data-workbar]'), padding:getComputedStyle(document.querySelector('.chat')).paddingTop };
      })()`)
      assert.ok(geometry.first.top >= geometry.strip.bottom, 'initial message clears both headers')
      assert.equal(geometry.strip.top, 58, 'context strip stays below topbar')
      assert.equal(geometry.workbar.top, 58, 'workbar stays in original row')
      assert.equal(geometry.viewport.top, enabled ? 0 : geometry.strip.bottom, 'actual viewport extension')
      assert.equal(geometry.padding, '0px', 'inset belongs to scrolling content')
      await evaluate(`(() => { const chat = document.querySelector('.chat-history-pane[data-active="true"] .chat');
        const message = chat.querySelector('article'); chat.scrollTop += message.getBoundingClientRect().top - 20; })()`)
      const overlap = await evaluate(`(() => { const chat = document.querySelector('.chat-history-pane[data-active="true"] .chat');
        const r = chat.querySelector('article').getBoundingClientRect(), v = chat.getBoundingClientRect(), t = document.querySelector('.topbar').getBoundingClientRect();
        return Math.min(r.bottom, v.bottom, t.bottom) - Math.max(r.top, v.top, t.top); })()`)
      assert.equal(overlap > 0, enabled, `${theme}/${enabled}: actual visible message/topbar intersection`)
      const clicks = await evaluate(`Number(document.querySelector('[data-clicks]').dataset.clicks)`)
      await click('.topbar button')
      await waitFor(`Number(document.querySelector('[data-clicks]').dataset.clicks) === ${clicks + 1}`)
      await click('.chat-scroll-to-bottom')
      await waitFor(`(() => { const e = document.querySelector('.chat-history-pane[data-active="true"] .chat'); return e.scrollHeight - e.clientHeight - e.scrollTop < 1; })()`)
      const bottom = await evaluate(`document.querySelector('.chat-history-pane[data-active="true"] article:last-child').getBoundingClientRect().bottom`)
      assert.ok(bottom <= geometry.composer.top, 'last message is above composer')
      assert.equal(await evaluate(`document.querySelector('[aria-label="Composer"]').value`), 'Draft')
      console.log(`FrostedGlass ${theme}/${enabled}: initial clearance, real message overlap=${overlap}, native click and jump-to-bottom passed`)
    }
  }
  await evaluate(`for (const e of [document.documentElement, document.querySelector('.app-shell')]) e.dataset.frostedGlass = 'true';
    document.querySelector('.chat-history-pane[data-active="true"] .chat').scrollTop = 400;`)
  await waitFor("document.querySelector('.chat-scroll-to-bottom') !== null")
  await click('#switch-conversation')
  await waitFor(`document.querySelector('.chat-history-pane[data-active="true"]').dataset.conversationId === 'b'`)
  await click('#switch-conversation')
  await waitFor(`document.querySelector('.chat-history-pane[data-active="true"]').dataset.conversationId === 'a'`)
  assert.equal(await evaluate(`document.querySelector('.chat-history-pane[data-active="true"] .chat').scrollTop`), 400, 'keep-alive scroll position')
  await evaluate(`document.querySelector('.chat-history-pane[data-active="true"] .chat').scrollTop = 0`)
  const anchor = await evaluate(`document.querySelector('.chat-history-pane[data-active="true"] article').getBoundingClientRect().top`)
  await click('.load-earlier-messages')
  await waitFor(`document.querySelectorAll('.chat-history-pane[data-active="true"] article').length === 100`)
  const restoredAnchor = await evaluate(`document.querySelectorAll('.chat-history-pane[data-active="true"] article')[20].getBoundingClientRect().top`)
  assert.ok(Math.abs(restoredAnchor - anchor) < 1, 'prepend preserves message anchor')
  await click('.runtime-checklist__toggle')
  await waitFor(`!!document.querySelector('.runtime-checklist__content')`)
  assert.equal(await evaluate(`(() => { const e = document.querySelector('.runtime-checklist__content'), r = e.getBoundingClientRect();
    return e.closest('.floating-portal').matches(':popover-open') && e.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)); })()`), true, 'checklist top layer remains above the overlay')
  await click('.runtime-checklist__toggle')
  await waitFor(`!document.querySelector('.runtime-checklist__content')`)
  await click('#switch-context')
  await waitFor(`!document.querySelector('.runtime-checklist')`)
  await evaluate(`document.querySelector('.chat-history-pane[data-active="true"] .chat').scrollTop = 0`)
  await waitFor(`document.querySelector('.chat-history-pane[data-active="true"] article').getBoundingClientRect().top >= 58`)
  await click('#switch-route')
  await waitFor(`!document.querySelector('[data-route="activity"]').hidden`)
  assert.equal(await evaluate(`document.querySelector('.workspace').getBoundingClientRect().top`), 58, 'non-chat route keeps original layout')
  await click('#switch-route')
  await waitFor(`!document.querySelector('[data-route="chat"]').hidden`)
  assert.equal(await evaluate(`document.querySelector('.workspace').getBoundingClientRect().top`), 0, 'chat overlay restored on route return')
  if (process.platform === 'win32') {
    const koffi = createRequire(join(process.cwd(), 'package.json'))('koffi')
    const send = koffi.load('user32.dll').func('intptr_t __stdcall SendMessageW(void *hWnd, uint32_t Msg, uintptr_t wParam, intptr_t lParam)')
    const hwnd = koffi.decode(win.getNativeWindowHandle(), 'void *')
    const points = await evaluate(`(() => { const button = document.querySelector('.topbar button').getBoundingClientRect();
      const last = document.querySelector('#short-chat').getBoundingClientRect(), actions = document.querySelector('.topbar__actions').getBoundingClientRect();
      return { button: { x: button.x + button.width / 2, y: button.y + button.height / 2 },
        caption: { x: (last.right + actions.left) / 2, y: 25 } }; })()`)
    const hit = point => {
      const bounds = win.getContentBounds()
      const physical = screen.dipToScreenPoint({ x: Math.round(bounds.x + point.x), y: Math.round(bounds.y + point.y) })
      return Number(send(hwnd, 0x84, 0, (physical.y << 16) | (physical.x & 0xffff)))
    }
    for (let i = 0; i < 40 && hit(points.caption) !== 2; i++) await setTimeout(25)
    assert.equal(hit(points.caption), 2, 'native caption remains draggable')
    assert.equal(hit(points.button), 1, 'native button remains HTCLIENT')
    console.log('FrostedGlass Windows native hit test: HTCAPTION on titlebar, HTCLIENT on button')
  }
  await click('#short-chat')
  await waitFor(`document.querySelector('.chat-history-pane[data-active="true"]').dataset.conversationId === 'short'`)
  for (const theme of ['light', 'dark']) {
    for (const enabled of [true, false]) {
      win.setContentSize(960, 540)
      await evaluate(`document.documentElement.dataset.theme = '${theme}';
        for (const e of [document.documentElement, document.querySelector('.app-shell')]) e.dataset.frostedGlass = '${enabled}'`)
      await waitFor(`(() => { const chat = document.querySelector('.chat-history-pane[data-active="true"] .chat');
        const first = chat.querySelector('article').getBoundingClientRect(), footer = document.querySelector('.composer-wrap').getBoundingClientRect();
        return innerHeight === 540 && first.top >= 58 && first.bottom <= footer.top && footer.bottom <= innerHeight && chat.scrollTop === 0; })()`)
    }
  }
  console.log('FrostedGlass toggle anchor, keep-alive, prepend, top-layer hit, no-context, route isolation and short chat at 960x540 passed')
  app.exit(0)
}).catch(error => {
  console.error(error)
  app.exit(1)
})

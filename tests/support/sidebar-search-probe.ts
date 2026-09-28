import type { BrowserWindow } from 'electron'
import assert from 'node:assert/strict'
import { setTimeout } from 'node:timers/promises'

export async function verifySidebarSearch(win: BrowserWindow): Promise<number> {
  const run = <T = unknown>(code: string): Promise<T> => win.webContents.executeJavaScript(code)
  const wait = async (code: string): Promise<void> => {
    for (let i = 0; i < 200; i++) {
      if (await run(code)) return
      await setTimeout(25)
    }
    throw new Error(`Sidebar search timeout: ${code}`)
  }
  const click = async (selector: string): Promise<void> => {
    const point = await run<{ x: number; y: number }>(`(() => {
      const e = document.querySelector(${JSON.stringify(selector)}), r = e.getBoundingClientRect();
      if (!e.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2))) throw new Error('Control obscured: ' + ${JSON.stringify(selector)});
      return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
    })()`)
    win.webContents.sendInputEvent({ type: 'mouseDown', ...point, button: 'left', clickCount: 1 })
    win.webContents.sendInputEvent({ type: 'mouseUp', ...point, button: 'left', clickCount: 1 })
  }
  const measure = `(() => {
    const row = document.querySelector('.sidebar-conversation-controls').getBoundingClientRect();
    const slot = document.querySelector('.sidebar-search-slot').getBoundingClientRect();
    const create = document.querySelector('.new-chat');
    return { top: document.querySelector('.conversation-list').getBoundingClientRect().top,
      right: slot.right, width: slot.width, height: row.height, overflow: create.scrollWidth - create.clientWidth,
      createWidth: create.getBoundingClientRect().width };
  })()`
  type Bounds = { top: number; right: number; width: number; height: number; overflow: number; createWidth: number }
  let observations = 0
  const originalWidth = await run<string>('document.querySelector(".sidebar").style.getPropertyValue("--primary-sidebar-width")')
  win.webContents.debugger.attach('1.3')
  try {
    await run('document.fonts.ready')
    await wait('document.querySelector(".composer textarea")?.matches(":placeholder-shown")')
    assert.equal(await run(`(async () => {
      const input = document.querySelector('.composer textarea');
      const info = await window.goodbuddy.app.getInfo();
      return input.placeholder.split('\\n').length === 3 &&
        input.placeholder.includes((info.platform === 'darwin' ? 'Command' : 'Ctrl') + '+N for a new conversation') &&
        (!info.shortcut || input.placeholder.includes(info.shortcut + ' for quick access')) &&
        !document.querySelector('.composer-meta__shortcut');
    })()`), true)
    win.show()
    win.focus()
    win.webContents.focus()
    await wait('document.hasFocus()')
    await click('.composer textarea')
    await wait('document.activeElement?.matches(".composer textarea")')
    await win.webContents.insertText('Placeholder visibility check')
    await wait('document.querySelector(".composer textarea").value === "Placeholder visibility check"')
    assert.equal(await run('document.querySelector(".composer textarea").matches(":placeholder-shown")'), false)
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'A', modifiers: [process.platform === 'darwin' ? 'meta' : 'control'] })
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'A', modifiers: [process.platform === 'darwin' ? 'meta' : 'control'] })
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Backspace' })
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Backspace' })
    await wait('document.querySelector(".composer textarea").matches(":placeholder-shown")')
    for (const theme of ['light', 'dark']) {
      for (const width of [220, 420, 280]) {
        win.setSize(width === 280 ? 760 : 1280, width === 280 ? 560 : 900)
        await wait(width === 280 ? 'window.innerWidth < 900' : 'window.innerWidth >= 900')
        await run('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
        if (await run('document.querySelector(".sidebar").classList.contains("sidebar--closed")')) {
          await click('.sidebar-toggle')
        }
        await run(`document.documentElement.dataset.theme = '${theme}'; document.querySelector('.sidebar').style.setProperty('--primary-sidebar-width', '${width}px')`)
        await wait('!document.querySelector(".sidebar").classList.contains("sidebar--closed")')
        await run('Promise.all(document.querySelector(".sidebar").getAnimations().map(animation => animation.finished))')
        const before = await run<Bounds>(measure)
        assert.equal(await run(`(() => {
          const button = document.querySelector('.new-chat');
          const label = getComputedStyle(button.querySelector('span'));
          return !!button.querySelector('.lucide-message-square-plus') &&
            getComputedStyle(button).justifyContent === 'flex-start' &&
            label.fontSize === '13px' && label.fontWeight === '600';
        })()`), true)
        assert.ok(before.overflow <= 1, `New conversation text overflow at ${width}: ${JSON.stringify(before)}`)
        await click('.sidebar-search-trigger')
        await wait('document.activeElement?.matches(".sidebar-search input")')
        await run(`new Promise((resolve, reject) => {
          const sample = () => {
            const search = document.querySelector('.sidebar-search').getBoundingClientRect();
            const top = document.querySelector('.conversation-list').getBoundingClientRect().top;
            if (Math.abs(search.right - ${before.right}) >= 0.01 || top !== ${before.top}) {
              reject(new Error('Search edge or list moved during expansion')); return;
            }
            if (document.querySelector('.sidebar-search-slot').getAnimations().length) requestAnimationFrame(sample);
            else resolve(true);
          };
          requestAnimationFrame(sample);
        })`)
        await run('Promise.all(document.querySelector(".sidebar-search-slot").getAnimations().map(animation => animation.finished))')
        const after = await run<Bounds>(measure)
        assert.equal(await run(`(() => {
          const button = document.querySelector('.new-chat');
          const icon = button.querySelector('.lucide-message-square-plus').getBoundingClientRect();
          const bounds = button.getBoundingClientRect();
          return Math.abs(icon.x + icon.width / 2 - bounds.x - bounds.width / 2) < 1;
        })()`), true)
        assert.ok(Math.abs(after.right - before.right) < 0.01, 'stable right edge within floating-point rounding')
        assert.equal(after.top, before.top)
        assert.equal(after.height, before.height)
        assert.ok(after.width > before.width)
        await win.webContents.insertText('Capture discussion')
        await click('.conversation-item')
        await run('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
        if (await run('document.querySelector(".sidebar").classList.contains("sidebar--closed")')) {
          await click('.sidebar-toggle')
          await wait('!document.querySelector(".sidebar").classList.contains("sidebar--closed")')
          await run('Promise.all(document.querySelector(".sidebar").getAnimations().map(animation => animation.finished))')
        }
        assert.equal(await run('document.querySelector(".sidebar-search input").value'), 'Capture discussion')
        await click('.sidebar-search input')
        win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' })
        win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' })
        await wait('document.activeElement?.matches(".sidebar-search-trigger")')
        await run('Promise.all(document.querySelector(".sidebar-search-slot").getAnimations().map(animation => animation.finished))')
        assert.equal((await run<Bounds>(measure)).top, before.top)
        await click('.sidebar-search-trigger')
        await wait('document.activeElement?.matches(".sidebar-search input")')
        await run('Promise.all(document.querySelector(".sidebar-search-slot").getAnimations().map(animation => animation.finished))')
        assert.equal(await run('document.querySelector(".sidebar-search input").value'), '')
        await click('.sidebar-search__clear')
        await wait('document.activeElement?.matches(".sidebar-search-trigger")')
        await run('Promise.all(document.querySelector(".sidebar-search-slot").getAnimations().map(animation => animation.finished))')
        observations++
      }
    }
    await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] })
    assert.equal(await run('getComputedStyle(document.querySelector(".sidebar-search-slot")).transitionProperty'), 'none')
    return observations
  } finally {
    await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [] })
    win.webContents.debugger.detach()
    win.setSize(1280, 900)
    await run(`document.querySelector('.sidebar').style.setProperty('--primary-sidebar-width', ${JSON.stringify(originalWidth)}); document.documentElement.dataset.theme = 'light'`)
  }
}

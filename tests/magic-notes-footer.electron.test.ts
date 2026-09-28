// @vitest-environment node
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createServer } from 'vite'
import react from '@vitejs/plugin-react'
import { expect, it } from 'vitest'

it('renders compact capture footers and responsive save errors in Electron across locales and themes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'goodbuddy-notes-footer-'))
  const server = await createServer({
    configFile: false, root: resolve('.'), cacheDir: join(directory, 'vite'),
    plugins: [react(), { name: 'notes-footer', configureServer(server) {
      server.middlewares.use('/footer.html', async (_request, response) => {
        response.setHeader('Content-Type', 'text/html')
        response.end(await server.transformIndexHtml('/footer.html',
          '<html><body><script type="module" src="/tests/support/magic-notes-footer-regression.tsx"></script></body></html>'))
      })
    } }],
    server: { host: '127.0.0.1', port: 0, watch: null },
    optimizeDeps: { entries: ['tests/support/magic-notes-footer-regression.tsx'] }
  })
  try {
    await server.listen()
    const driver = join(directory, 'driver.cjs')
    await writeFile(driver, `
      const { app, BrowserWindow } = require('electron');
      const fs = require('node:fs');
      const assert = require('node:assert/strict');
      const trace = message => fs.appendFileSync(${JSON.stringify(join(directory, 'driver.log'))}, message + '\\n');
      trace('Starting Electron');
      app.commandLine.appendSwitch('force-device-scale-factor', '1');
      // Keep animation-frame measurements running when other test windows cover this one.
      app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
      app.setPath('userData', ${JSON.stringify(join(directory, 'profile'))});
      app.whenReady().then(async () => {
        trace('Electron ready');
        const win = new BrowserWindow({ show: true, width: 900, height: 720, useContentSize: true,
          webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
        const js = async code => {
          let timeout;
          try {
            return await Promise.race([win.webContents.executeJavaScript(code), new Promise((_, reject) => {
              timeout = setTimeout(() => reject(new Error('Renderer timeout: ' + code)), 15000);
            })]);
          } catch (error) { throw new Error(code + ': ' + error.message); }
          finally { clearTimeout(timeout); }
        };
        const settle = () => js('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
        const wait = async code => { for (let i = 0; i < 400; i++) {
          if (await js(code)) return;
          await new Promise(resolve => setTimeout(resolve, 25));
        } throw new Error('Timeout: ' + code); };
        const click = async selector => {
          const r = await js('document.querySelector(' + JSON.stringify(selector) + ').getBoundingClientRect().toJSON()');
          win.focus(); win.webContents.focus();
          const x = Math.round(r.x + r.width / 2), y = Math.round(r.y + r.height / 2);
          win.webContents.sendInputEvent({ type: 'mouseMove', x, y });
          win.webContents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
          win.webContents.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
          await settle();
        };
        const resize = async width => {
          win.show(); win.focus();
          win.setContentSize(width, 720);
          await wait('innerWidth === ' + width); await settle();
        };
        const measure = () => js(
          '(() => {' +
          'const footer = document.querySelector(".magic-note-panel__footer"), style = getComputedStyle(footer);' +
          'const rect = selector => document.querySelector(selector)?.getBoundingClientRect().toJSON();' +
          'return { footer: footer.getBoundingClientRect().toJSON(), actions: rect(".magic-note-panel__footer .magic-note-panel__actions"),' +
          'cancel: rect(".magic-note-panel__footer .secondary-button"), save: rect(".magic-note-panel__footer .primary-button"),' +
          'error: rect("#compact-note-save-error"), paddingRight: parseFloat(style.paddingRight),' +
          'chrome: parseFloat(style.paddingTop) + parseFloat(style.paddingBottom) + parseFloat(style.borderTopWidth),' +
          'background: style.backgroundColor, overflow: document.documentElement.scrollWidth > innerWidth }; })()');
        const aligned = (m, context) => {
          assert(Math.abs(m.save.right - (m.footer.right - m.paddingRight)) <= 1, context + ': right alignment ' + JSON.stringify(m));
          assert(Math.abs(m.cancel.y - m.save.y) <= 1, context + ': buttons stay on one row');
          assert(m.cancel.right <= m.save.x && m.cancel.x >= m.footer.x, context + ': buttons fit without overlap');
          assert(m.save.bottom <= m.footer.bottom && m.footer.bottom <= 720, context + ': footer remains visible');
          assert(!m.overflow, context + ': no horizontal overflow');
        };
        const screenshot = async name => {
          if (process.env.GOODBUDDY_NOTES_SCREENSHOT_DIR) {
            fs.writeFileSync(require('node:path').join(process.env.GOODBUDDY_NOTES_SCREENSHOT_DIR, name + '.png'), (await win.webContents.capturePage()).toPNG());
          }
        };
        const results = [];
        for (const locale of ['en-US', 'zh-CN']) for (const theme of ['light', 'dark']) for (const kind of ['message', 'conversation']) {
          const context = locale + '/' + theme + '/' + kind;
          trace(context + ': navigating');
          await win.loadURL(${JSON.stringify(server.resolvedUrls!.local[0] + 'footer.html')} + '?locale=' + locale + '&theme=' + theme + '&kind=' + kind);
          trace(context + ': loaded');
          await resize(900);
          trace(context + ': resized');
          await wait('!!document.querySelector("#compact-note-text") && !document.querySelector(".magic-note-panel__scroll [role=status]")');
          trace(context + ': rendered');
          await js('document.fonts.ready'); await settle();
          trace(context + ': fonts ready');
          assert.equal(await js('document.querySelector("#compact-note-text").value'), 'Captured text', context);
          assert.equal(await js('document.body.dataset.saveCount'), '0', context);
          assert(await js('document.querySelector(".magic-note-panel__footer .primary-button").disabled'), context);
          assert.equal(await js('document.querySelector(".magic-note-panel__footer p")'), null, context + ': no initial footer paragraph');
          const initial = [];
          for (const width of [900, 300]) {
            trace(context + ': initial ' + width);
            await resize(width);
            const m = await measure(); aligned(m, context + '/' + width);
            assert.equal(m.footer.width, width, context + ': actual panel width');
            assert(Math.abs(m.footer.height - m.chrome - m.actions.height) <= 1, context + ': compact footer ' + JSON.stringify(m));
            assert(m.footer.height <= 65, context + ': bounded initial footer height');
            assert.equal(await js('document.body.innerText.includes(document.body.dataset.scope)'), false, context + ': scope hidden');
            await click('.magic-note-panel__source-heading .inline-help');
            await wait('!!document.querySelector("[role=tooltip]")');
            assert(await js('document.querySelector("[role=tooltip]").checkVisibility()'), context);
            assert.equal(await js('document.querySelector("[role=tooltip]").textContent'), await js('document.body.dataset.scope'), context + ': correct capture scope');
            win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
            win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
            await wait('!document.querySelector("[role=tooltip]")');
            assert.equal(await js('document.body.innerText.includes(document.body.dataset.scope)'), false, context);
            assert.equal((await measure()).footer.height, m.footer.height, context + ': help does not expand footer');
            initial.push({ width, height: m.footer.height, saveWidth: m.save.width });
            await screenshot('magic-notes-footer-' + locale + '-' + theme + '-' + kind + '-initial-' + width);
          }
          assert(Math.abs(initial[0].saveWidth - initial[1].saveWidth) <= 1, context + ': content-sized button');
          await resize(900);
          trace(context + ': saving');
          await click('.magic-note-panel__scroll .segmented-control button:last-child');
          await wait('!!document.querySelector("#compact-note-title")');
          await click('.magic-note-panel__footer .primary-button');
          await wait('!!document.querySelector("#compact-note-save-error") && !document.querySelector(".magic-note-panel__footer .primary-button").disabled');
          assert.equal(await js('document.body.dataset.saveCount'), '1', context + ': real save handler reaches storage');
          assert.equal(await js('document.querySelector("#compact-note-save-error").textContent'), 'Storage unavailable. Please try again.', context);
          assert.equal(await js('document.querySelector("#compact-note-save-error").getAttribute("role")'), 'alert', context);
          assert.equal(await js('document.querySelector("#compact-note-text").value'), 'Captured text', context + ': failed save preserves draft');
          const wide = await measure(); aligned(wide, context + '/wide-error');
          assert(Math.abs((wide.error.y + wide.error.height / 2) - (wide.actions.y + wide.actions.height / 2)) <= 1, context + ': error and actions share row');
          assert(wide.error.right <= wide.actions.x, context + ': error does not overlap actions');
          assert.equal(wide.footer.height, initial[0].height, context + ': wide error adds no footer height');
          await screenshot('magic-notes-footer-' + locale + '-' + theme + '-' + kind + '-error-900');
          await resize(300);
          const narrow = await measure(); aligned(narrow, context + '/narrow-error');
          trace(context + ': narrow error measured');
          assert(narrow.actions.y >= narrow.error.bottom + 7, context + ': error wraps above buttons ' + JSON.stringify(narrow));
          assert(narrow.footer.height > wide.footer.height, context + ': wrapped footer grows');
          assert(Math.abs(narrow.save.width - wide.save.width) <= 1, context + ': error does not stretch button');
          assert(await js('(() => { const e = document.querySelector("#compact-note-save-error"); return e.checkVisibility() && e.scrollWidth <= e.clientWidth && e.scrollHeight <= e.clientHeight; })()'), context + ': error is not clipped');
          await screenshot('magic-notes-footer-' + locale + '-' + theme + '-' + kind + '-error-300');
          results.push({ locale, theme, kind, initial, wideHeight: wide.footer.height, narrowHeight: narrow.footer.height,
            wideErrorY: wide.error.y, wideActionsY: wide.actions.y, narrowErrorBottom: narrow.error.bottom,
            narrowActionsY: narrow.actions.y, rightInset: narrow.footer.right - narrow.save.right, background: wide.background });
        }
        assert.notEqual(results[0].background, results[2].background, 'Real theme styles applied');
        fs.writeFileSync(${JSON.stringify(join(directory, 'result.json'))}, JSON.stringify(results));
        app.exit(0);
      }).catch(error => { trace(error.stack || String(error)); console.error(error); app.exit(1); });
    `)
    const env = { ...process.env }
    delete env.ELECTRON_RUN_AS_NODE
    const child = spawn(createRequire(import.meta.url)('electron'), [driver], { env, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    child.stdout.on('data', data => { output += data })
    child.stderr.on('data', data => { output += data })
    let timedOut = false
    const timeout = setTimeout(() => { timedOut = true; child.kill() }, 90000)
    try {
      const { code, signal } = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
        child.once('close', (code, signal) => resolve({ code, signal }))
        child.once('error', reject)
      })
      output += await readFile(join(directory, 'driver.log'), 'utf8').catch(() => '')
      expect(timedOut, `Electron footer exceeded 90s (exit=${code}, signal=${signal}).\n${output}`).toBe(false)
      expect(signal, output).toBeNull()
      expect(code, output).toBe(0)
    } finally { clearTimeout(timeout) }
    const results = JSON.parse(await readFile(join(directory, 'result.json'), 'utf8'))
    console.info('Notes footer Electron geometry:', JSON.stringify(results, null, 2))
    expect(results).toHaveLength(8)
  } finally {
    await server.close()
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
}, 120000)

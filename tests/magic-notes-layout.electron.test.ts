// @vitest-environment node
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createServer } from 'vite'
import react from '@vitejs/plugin-react'
import { expect, it } from 'vitest'

it('resizes record columns with native Electron input and preserves desktop widths across narrow layouts', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'goodbuddy-notes-layout-'))
  const server = await createServer({
    configFile: false, root: resolve('.'), cacheDir: join(directory, 'vite'),
    plugins: [react(), { name: 'notes-layout', configureServer(server) {
      server.middlewares.use('/layout.html', async (_request, response) => {
        response.setHeader('Content-Type', 'text/html')
        response.end(await server.transformIndexHtml('/layout.html',
          '<html><body><script type="module" src="/tests/support/magic-notes-layout-regression.tsx"></script></body></html>'))
      })
    } }],
    server: { host: '127.0.0.1', port: 0, watch: null }
  })
  try {
    await server.listen()
    const driver = join(directory, 'driver.cjs')
    await writeFile(driver, `
      const { app, BrowserWindow } = require('electron');
      const fs = require('node:fs');
      const assert = require('node:assert/strict');
      app.commandLine.appendSwitch('force-device-scale-factor', '1');
      app.setPath('userData', ${JSON.stringify(join(directory, 'profile'))});
      app.whenReady().then(async () => {
        const win = new BrowserWindow({ show: false, width: 1280, height: 800, useContentSize: true,
          webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
        const js = code => win.webContents.executeJavaScript(code).catch(error => { throw new Error(code + ': ' + error.message); });
        const settle = () => js('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
        const screenshot = async name => {
          if (process.env.GOODBUDDY_NOTES_SCREENSHOT_DIR) {
            fs.writeFileSync(require('node:path').join(process.env.GOODBUDDY_NOTES_SCREENSHOT_DIR, name + '.png'), (await win.webContents.capturePage()).toPNG());
          }
        };
        const wait = async code => { for (let i = 0; i < 400; i++) {
          if (await js(code)) return;
          await new Promise(resolve => setTimeout(resolve, 25));
        } throw new Error('Timeout: ' + code); };
        const click = async selector => { await js('document.querySelector(' + JSON.stringify(selector) + ').click()'); await settle(); };
        const rect = selector => js('(() => { const r = document.querySelector(' + JSON.stringify(selector) + ').getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; })()');
        const drag = async (selector, delta) => {
          const r = await rect(selector); const x = Math.round(r.x + r.width / 2), y = Math.round(r.y + 80);
          win.webContents.sendInputEvent({ type: 'mouseMove', x, y });
          win.webContents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
          await settle();
          win.webContents.sendInputEvent({ type: 'mouseMove', x: x + delta, y, button: 'left' });
          await settle();
          await new Promise(resolve => setTimeout(resolve, 80));
          win.webContents.sendInputEvent({ type: 'mouseUp', x: x + delta, y, button: 'left', clickCount: 1 });
          await settle();
        };
        const key = async (selector, keyCode) => {
          await js('document.querySelector(' + JSON.stringify(selector) + ').focus()');
          win.webContents.sendInputEvent({ type: 'keyDown', keyCode });
          win.webContents.sendInputEvent({ type: 'keyUp', keyCode }); await settle();
        };
        const open = async () => { await wait('!!document.querySelector("[id^=magic-note-select-]")');
          await click('[id^=magic-note-select-]'); await wait('!!document.querySelector(".magic-note-record")'); await settle(); };
        await win.loadURL(${JSON.stringify(server.resolvedUrls!.local[0] + 'layout.html')});
        await open(); await js('document.fonts.ready'); win.focus(); win.webContents.focus();
        const editor = '.magic-note-composer .magic-note-editor__content .ql-editor';
        const emptyHeight = (await rect(editor)).height;
        assert(emptyHeight >= 110 && emptyHeight <= 125, 'Empty composer height: ' + emptyHeight);
        assert.equal(await js('document.querySelector("#magic-notes-title").textContent'), 'Layout note');
        assert.equal(await js('document.querySelector(".page-header__description")'), null);
        await screenshot('magic-notes-light');
        await js('document.documentElement.dataset.theme = "dark"'); await settle();
        assert.equal((await rect(editor)).height, emptyHeight);
        await screenshot('magic-notes-dark');
        await js('document.documentElement.dataset.theme = "light"'); await settle();
        const index = '.magic-notes-index-pane', handle = '.magic-notes-index-resize-handle', stream = '.magic-notes-stream-pane';
        assert.equal((await rect(index)).width, 168);
        await drag(handle, 80); const dragged = (await rect(index)).width; assert(dragged > 240 && dragged < 260, 'Dragged index width: ' + dragged);
        await key(handle, 'Home'); assert.equal((await rect(index)).width, 140);
        await key(handle, 'Right'); assert.equal((await rect(index)).width, 156);
        await key(handle, 'End'); assert.equal((await rect(index)).width, 320);
        await drag('.magic-notes-ai-resize-handle', -100);
        assert((await rect('.magic-notes-ai-pane')).width > 350, JSON.stringify({ ai: await rect('.magic-notes-ai-pane'), handle: await rect('.magic-notes-ai-resize-handle'), layout: await rect('.magic-notes-layout') }));
        const before = (await rect(stream)).width;
        await click('#magic-notes-index-toggle'); assert.equal((await rect(index)).width, 0);
        assert.equal((await rect(stream)).width - before, 329);
        assert.equal(await js('document.querySelector(".magic-notes-index-resize-handle")'), null);
        await click('#magic-notes-index-toggle');
        await click('button[aria-controls="magic-notes-ai-pane"]'); await drag(handle, -80);
        const withoutAi = (await rect(index)).width; assert(withoutAi < 250 && withoutAi > 230);
        await click('button[aria-controls="magic-notes-ai-pane"]'); assert.equal((await rect(index)).width, withoutAi);
        await win.loadURL(${JSON.stringify(server.resolvedUrls!.local[0] + 'layout.html')}); await open(); assert.equal((await rect(index)).width, withoutAi);
        win.setContentSize(820, 720); await settle(); await settle();
        assert((await rect(stream)).width >= 299);
        const constrained = { index: (await rect(index)).width, editor: (await rect(stream)).width, ai: (await rect('.magic-notes-ai-pane')).width };
        win.setContentSize(720, 640); await settle(); await settle();
        assert.equal((await rect(index)).width, 0);
        await click('#magic-notes-index-toggle'); assert.equal((await rect(index)).width, 168);
        assert.equal(await js('document.querySelector(".magic-notes-index-resize-handle")'), null);
        assert.equal(await js('getComputedStyle(document.querySelector(".magic-notes-ai-resize-handle")).display'), 'none');
        assert(await js('document.documentElement.scrollWidth <= innerWidth'));
        const narrowStream = (await rect(stream)).width;
        await click('#magic-notes-index-toggle'); assert.equal((await rect(stream)).width, narrowStream);
        await screenshot('magic-notes-narrow');
        win.setContentSize(1280, 800); await settle(); await settle();
        assert.equal((await rect(index)).width, withoutAi);
        await js('document.querySelector(' + JSON.stringify(editor) + ').focus()');
        await win.webContents.insertText('Composer growth check\\n'.repeat(30)); await settle();
        const grownHeight = (await rect(editor)).height;
        assert(grownHeight > emptyHeight + 400, 'Composer must grow with content');
        assert(await js('(() => { const el = document.querySelector(' + JSON.stringify(editor) + '); return el.scrollHeight <= el.clientHeight + 1; })()'), 'Quill content must not be clipped');
        assert(await js('(() => { const el = document.querySelector(".magic-notes-stream-pane"); el.scrollTop = el.scrollHeight; return el.scrollTop > 0; })()'), 'Long draft must remain reachable through the note stream');
        await settle();
        await screenshot('magic-notes-long-draft');
        win.webContents.debugger.attach('1.3');
        await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'forced-colors', value: 'active' }] });
        assert.equal(await js('getComputedStyle(document.querySelector(".magic-notes-stream-pane")).scrollbarWidth'), 'auto');
        assert.equal(await js('getComputedStyle(document.querySelector(".magic-notes-stream-pane")).scrollbarColor'), 'auto');
        win.webContents.debugger.detach();
        fs.writeFileSync(${JSON.stringify(join(directory, 'result.json'))}, JSON.stringify({ emptyHeight, grownHeight, dragged, withoutAi, constrained, narrowStream, persisted: true }));
        app.exit(0);
      }).catch(error => { console.error(error); app.exit(1); });
    `)
    const env = { ...process.env }
    delete env.ELECTRON_RUN_AS_NODE
    const child = spawn(createRequire(import.meta.url)('electron'), [driver], { env, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    child.stdout.on('data', data => { output += data })
    child.stderr.on('data', data => { output += data })
    const timeout = setTimeout(() => child.kill(), 60000)
    try {
      const code = await new Promise((resolve, reject) => { child.once('exit', resolve); child.once('error', reject) })
      expect(code, output).toBe(0)
    } finally { clearTimeout(timeout) }
    const result = JSON.parse(await readFile(join(directory, 'result.json'), 'utf8'))
    console.info('Notes layout Electron geometry:', result)
    expect(result.persisted).toBe(true)
  } finally {
    await server.close()
    await rm(directory, { recursive: true, force: true })
  }
}, 90000)

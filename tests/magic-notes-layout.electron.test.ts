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
    server: { host: '127.0.0.1', port: 0, watch: null },
    optimizeDeps: { entries: ['tests/support/magic-notes-layout-regression.tsx'] }
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
        const win = new BrowserWindow({ show: true, width: 1280, height: 800, useContentSize: true,
          webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
        let lastCommand = 'startup';
        const watchdog = setTimeout(() => { console.error('Electron stalled at: ' + lastCommand); app.exit(1); }, 75000);
        const js = code => { lastCommand = code; return win.webContents.executeJavaScript(code).catch(error => { throw new Error(code + ': ' + error.message); }); };
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
          win.focus(); win.webContents.focus();
          await wait('document.hasFocus()');
          const r = await rect(selector); const x = Math.round(r.x + r.width / 2), y = Math.round(r.y + 80);
          const target = 'document.querySelector(' + JSON.stringify(selector) + ')';
          const before = await js(target + '.getAttribute("aria-valuenow")');
          win.webContents.sendInputEvent({ type: 'mouseMove', x, y });
          await settle();
          win.webContents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
          await wait('!!document.querySelector(".magic-notes-layout--resizing, .magic-todo-workspace--resizing")');
          win.webContents.sendInputEvent({ type: 'mouseMove', x: x + delta, y, button: 'left', modifiers: ['leftButtonDown'] });
          await wait(target + '.getAttribute("aria-valuenow") !== ' + JSON.stringify(before));
          win.webContents.sendInputEvent({ type: 'mouseUp', x: x + delta, y, button: 'left', clickCount: 1 });
          await wait('!document.querySelector(".magic-notes-layout--resizing, .magic-todo-workspace--resizing")');
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
        await wait('!!document.querySelector(".magic-note-tag-filter")'); await js('document.fonts.ready'); await settle();
        // Overview: the tag filter row fits the page and cards cap chips at three plus a count.
        assert(await js('document.documentElement.scrollWidth <= innerWidth'));
        assert.equal(await js('document.querySelectorAll("#magic-note-select-layout-note .magic-note-tag-chip").length'), 4);
        assert.equal(await js('document.querySelector("#magic-note-select-layout-note .magic-note-tag-chip--more").textContent'), '+1');
        const card = await rect('#magic-note-select-layout-note'), chips = await rect('#magic-note-select-layout-note .magic-note-tag-chips');
        assert(chips.x + chips.width <= card.x + card.width + 0.5, 'Card chips stay inside the card');
        await screenshot('magic-notes-overview-tags');
        await click('#magic-note-tag-manager');
        await wait('!!document.querySelector(".magic-note-tag-manager")');
        await screenshot('magic-notes-tag-manager');
        await key('.magic-note-tag-manager', 'Escape');
        await wait('!document.querySelector(".magic-note-tag-manager")');
        await open(); await js('document.fonts.ready'); win.focus(); win.webContents.focus();
        assert.equal(await js('document.querySelectorAll(".magic-note-tag-editor .magic-note-tag-chip--removable").length'), 4);
        assert.equal(await js('getComputedStyle(document.querySelector("#magic-note-tag-manager")).width'), '28px', 'Split list uses the compact icon');
        // The sticky toolbar spans the full stream width even though content is capped at 880px.
        const toolbarBox = await rect('.magic-note-detail-toolbar'), streamBox = await rect('.magic-notes-stream-pane');
        const streamClient = await js('document.querySelector(".magic-notes-stream-pane").clientWidth');
        assert(Math.abs(toolbarBox.x - streamBox.x) <= 1 && Math.abs(toolbarBox.width - streamClient) <= 1, 'Toolbar spans the stream: ' + JSON.stringify({ toolbarBox, streamBox, streamClient }));
        assert.equal((await rect('.magic-notes-overview')).width, 280);
        assert(await js('document.querySelector(".magic-notes-overview").checkVisibility()'));
        await js('document.querySelector(".magic-notes-card-grid").scrollTop = 300; document.querySelector(".magic-notes-stream-pane").scrollTop = 420');
        await wait('document.querySelector(".magic-notes-stream-pane").scrollTop === 420');
        await settle();
        await click('#magic-note-select-other-note-3');
        await wait('document.querySelector(".magic-note-detail-title").value === "Other note 3"');
        assert.equal(await js('document.querySelector(".magic-notes-card-grid").scrollTop'), 300);
        assert.equal(await js('document.querySelector(".magic-notes-stream-pane").scrollTop'), 0);
        await click('#magic-note-select-layout-note');
        await wait('document.querySelector(".magic-notes-stream-pane").scrollTop === 420');
        assert.equal(await js('document.querySelector("#magic-note-select-layout-note").getAttribute("aria-current")'), 'true');
        await drag('.magic-notes-notes-resize-handle', 40);
        const notesWidth = (await rect('.magic-notes-overview')).width;
        assert(notesWidth >= 320 && notesWidth <= 325);
        await key('.magic-notes-notes-resize-handle', 'Left');
        assert.equal((await rect('.magic-notes-overview')).width, notesWidth - 16);
        await click('button[aria-controls="magic-library-panel-notes"]');
        assert.equal((await rect('.magic-notes-overview')).width, 0);
        await click('button[aria-controls="magic-library-panel-notes"]');
        assert.equal((await rect('.magic-notes-overview')).width, notesWidth - 16);
        assert.equal(await js('document.querySelector(".magic-notes-card-grid").scrollTop'), 300);
        await key('.magic-notes-notes-resize-handle', 'Home');
        assert.equal((await rect('.magic-notes-overview')).width, 240);
        await js('document.querySelector(".magic-notes-stream-pane").scrollTop = 0');
        const editor = '.magic-note-composer .magic-note-editor__content .ql-editor';
        const saveButton = '.magic-note-composer > footer > .primary-button';
        // Idle composer is a single prompt line without toolbar or footer.
        const idleHeight = (await rect('.magic-note-composer')).height;
        assert(idleHeight <= 60, 'Idle composer height: ' + idleHeight);
        assert.equal((await rect(saveButton)).width, 0);
        assert.equal(await js('document.querySelector(".magic-notes-ai-pane")?.checkVisibility() ?? false'), false, 'AI stays closed for notes without comments');
        assert.equal((await rect('.magic-notes-index-pane')).width, 0, 'Record index starts collapsed');
        const focusComposer = async () => { await js('document.querySelector(' + JSON.stringify(editor) + ').focus()'); await settle(); };
        await focusComposer();
        const emptyHeight = (await rect(editor)).height;
        const desktopSaveWidth = (await rect(saveButton)).width;
        assert(emptyHeight >= 110 && emptyHeight <= 125, 'Empty composer height: ' + emptyHeight);
        assert.equal(await js('document.querySelector(".magic-note-detail-title").value'), 'Layout note');
        assert.equal(await js('document.querySelector("#magic-notes-title").textContent'), 'Magic Notes');
        await screenshot('magic-notes-light');
        await js('document.documentElement.dataset.theme = "dark"'); await settle();
        assert.equal((await rect(editor)).height, emptyHeight);
        await screenshot('magic-notes-dark');
        await js('document.documentElement.dataset.theme = "light"'); await settle();
        const index = '.magic-notes-index-pane', handle = '.magic-notes-index-resize-handle', stream = '.magic-notes-stream-pane';
        await click('#magic-notes-index-toggle');
        await click('button[aria-controls="magic-notes-ai-pane"]');
        assert.equal((await rect(index)).width, 168);
        const firstRecord = await rect('.magic-note-record');
        assert.equal(firstRecord.x, (await rect(index)).x, 'Thumbnails align with the left pane edge');
        assert.equal(firstRecord.y, (await rect(stream)).y, 'Thumbnails align with the top of the note content');
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
        assert.equal((await rect('.magic-notes-overview')).width, 240);
        await js('document.querySelector(".magic-notes-card-grid").scrollTop = 300');
        win.setContentSize(1000, 720); await settle(); await settle();
        assert.equal((await rect('.magic-notes-overview')).width, 240);
        assert.equal((await rect(index)).width, 0, 'Record drawer follows detail width, not the outer page');
        const assertSideBySide = async () => {
          const s = await rect(stream), ai = await rect('.magic-notes-ai-pane'), list = await rect('.magic-notes-overview');
          assert(s.x >= list.x + list.width, 'Note stream must not overlap the notes list');
          assert(ai.x >= s.x + s.width && ai.y === s.y, 'AI pane sits beside the note stream: ' + JSON.stringify({ s, ai }));
          assert(s.width >= 300, 'Note stream keeps its minimum width: ' + s.width);
        };
        await assertSideBySide();
        win.setContentSize(930, 720); await settle(); await settle();
        await assertSideBySide();
        win.setContentSize(1000, 720); await settle(); await settle();
        assert(await js('document.documentElement.scrollWidth <= innerWidth'));
        win.setContentSize(820, 720); await settle(); await settle();
        assert((await rect(stream)).width >= 299);
        const constrained = { index: (await rect(index)).width, editor: (await rect(stream)).width, ai: (await rect('.magic-notes-ai-pane')).width };
        win.setContentSize(720, 640); await settle(); await settle();
        assert.equal((await rect('.magic-notes-overview')).width, 0);
        await click('#magic-notes-back');
        assert(await js('document.querySelector(".magic-notes-overview").checkVisibility()'));
        assert.equal(await js('document.querySelector(".magic-notes-card-grid").scrollTop'), 300);
        await open();
        assert.equal((await rect(index)).width, 0);
        await click('#magic-notes-index-toggle'); assert.equal((await rect(index)).width, 168);
        assert.equal(await js('document.querySelector(".magic-notes-index-resize-handle")'), null);
        assert.equal(await js('getComputedStyle(document.querySelector(".magic-notes-ai-resize-handle")).display'), 'block');
        assert((await rect('.magic-notes-ai-pane')).x >= (await rect(stream)).x + (await rect(stream)).width);
        assert(await js('document.documentElement.scrollWidth <= innerWidth'));
        const narrowStream = (await rect(stream)).width;
        await click('#magic-notes-index-toggle'); assert.equal((await rect(stream)).width, narrowStream);
        await focusComposer();
        const narrowSave = await rect(saveButton), narrowFooter = await rect('.magic-note-composer > footer');
        const footerPaddingRight = await js('parseFloat(getComputedStyle(document.querySelector(".magic-note-composer > footer")).paddingRight)');
        assert(Math.abs(narrowSave.width - desktopSaveWidth) <= 1, 'Narrow Save button retains its content width: ' + JSON.stringify({ desktopSaveWidth, narrowSave, narrowFooter }));
        assert(Math.abs(narrowFooter.x + narrowFooter.width - footerPaddingRight - narrowSave.x - narrowSave.width) <= 1, 'Narrow Save button stays right-aligned within footer padding');
        await screenshot('magic-notes-narrow');
        win.setContentSize(560, 640); await settle(); await settle();
        assert((await rect('.magic-notes-ai-pane')).y >= (await rect(stream)).y + (await rect(stream)).height, 'AI pane stacks below the stream on very narrow widths');
        assert.equal(await js('getComputedStyle(document.querySelector(".magic-notes-ai-resize-handle")).display'), 'none');
        win.setContentSize(1280, 800); await settle(); await settle();
        assert.equal((await rect('.magic-notes-overview')).width, 240);
        assert.equal((await rect(index)).width, withoutAi);
        await key('.magic-note-record', 'Tab');
        await js('document.querySelector(".magic-note-record").focus()');
        assert(await js('document.querySelector(".magic-note-record").matches(":focus-visible")'));
        assert.equal(await js('getComputedStyle(document.querySelector(".magic-note-record")).outlineOffset'), '-2px', 'Focus outline stays inside the scroll viewport');
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
        await win.loadURL(${JSON.stringify(server.resolvedUrls!.local[0] + 'layout.html')});
        await wait('!!document.querySelector("#magic-library-switch")');
        await click('#magic-library-switch');
        await wait('!!document.querySelector("#magic-todo-select-layout-todo")');
        await click('#magic-todo-select-layout-todo');
        const todoHandle = '.magic-notes-todo-resize-handle';
        assert.equal(await js('getComputedStyle(document.querySelector(".magic-todo-workspace")).gridTemplateColumns.split(" ")[1]'), '1px');
        assert.equal((await rect(todoHandle)).width, 9, 'Transparent hit area remains easy to drag');
        await drag(todoHandle, 100);
        const todoWidth = (await rect('#magic-todo-list')).width;
        assert(todoWidth > 410 && todoWidth < 430, 'Todo drag width: ' + todoWidth);
        await click('.magic-todo-directory__heading');
        assert.equal(await js('document.querySelector(".magic-todo-directory__items").checkVisibility()'), false);
        assert.equal(await js('document.querySelector(".magic-todo-detail").checkVisibility()'), true);
        win.focus(); win.webContents.focus();
        await key('.magic-todo-directory__heading', 'Space');
        assert.equal(await js('document.querySelector(".magic-todo-directory__items").checkVisibility()'), true);
        win.setContentSize(760, 640); await settle(); await settle();
        assert.equal(await js('getComputedStyle(document.querySelector(".magic-notes-todo-resize-handle")).display'), 'block');
        win.setContentSize(600, 640); await settle(); await settle();
        assert.equal(await js('document.querySelector(".magic-notes-todo-resize-handle").checkVisibility()'), false);
        assert(await js('document.documentElement.scrollWidth <= innerWidth'));
        win.setContentSize(1280, 800); await settle(); await settle();
        assert.equal((await rect('#magic-todo-list')).width, todoWidth);
        await win.loadURL(${JSON.stringify(server.resolvedUrls!.local[0] + 'layout.html')});
        await wait('!!document.querySelector("#magic-library-switch")');
        await click('#magic-library-switch');
        assert.equal((await rect('#magic-todo-list')).width, todoWidth);
        fs.writeFileSync(${JSON.stringify(join(directory, 'result.json'))}, JSON.stringify({ emptyHeight, grownHeight, dragged, withoutAi, constrained, narrowStream, desktopSaveWidth, narrowSave, narrowFooter, footerPaddingRight, persisted: true }));
        clearTimeout(watchdog);
        app.exit(0);
      }).catch(error => { console.error(error); app.exit(1); });
    `)
    const env = { ...process.env }
    delete env.ELECTRON_RUN_AS_NODE
    const child = spawn(createRequire(import.meta.url)('electron'), [driver], { env, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    child.stdout.on('data', data => { output += data })
    child.stderr.on('data', data => { output += data })
    // Native input and animation frames need a visible window, including under Xvfb.
    let timedOut = false
    const timeout = setTimeout(() => { timedOut = true; child.kill() }, 90000)
    try {
      const { code, signal } = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
        child.once('close', (code, signal) => resolve({ code, signal }))
        child.once('error', reject)
      })
      expect(timedOut, `Electron layout exceeded 90s (exit=${code}, signal=${signal}).\n${output}`).toBe(false)
      expect(signal, output).toBeNull()
      expect(code, output).toBe(0)
    } finally { clearTimeout(timeout) }
    const result = JSON.parse(await readFile(join(directory, 'result.json'), 'utf8'))
    console.info('Notes layout Electron geometry:', result)
    expect(result.persisted).toBe(true)
  } finally {
    await server.close()
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
}, 120000)

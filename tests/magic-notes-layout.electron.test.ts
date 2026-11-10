// @vitest-environment node
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { createServer } from 'vite'
import react from '@vitejs/plugin-react'
import { expect, it } from 'vitest'

it('resizes record columns with native Electron input and preserves desktop widths across narrow layouts', async () => {
  await mkdir(resolve('temp'), { recursive: true })
  const directory = await mkdtemp(join(resolve('temp'), 'goodbuddy-notes-layout-'))
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
      app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
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
        const assertViewportHeight = async () => {
          const workspace = await rect('.magic-notes-workspace');
          const viewportHeight = await js('innerHeight');
          const selectors = await js('Array.from(document.querySelectorAll(".magic-notes-pane-resize-handle")).filter(el => el.checkVisibility()).map(el => "." + Array.from(el.classList).find(name => name !== "magic-notes-pane-resize-handle"))');
          for (const selector of ['.magic-notes-detail-container', '.magic-notes-layout', ...selectors]) {
            const box = await rect(selector);
            assert(Math.abs(box.height - workspace.height) <= 1, selector + ' fills workspace: ' + JSON.stringify({ box, workspace }));
            assert(box.y + box.height <= viewportHeight, selector + ' stays within viewport: ' + JSON.stringify(box));
          }
          return (await rect('.magic-notes-layout')).height;
        };
        const longNoteHeight = await assertViewportHeight();
        assert.equal(await js('document.querySelectorAll(".magic-note-tag-editor .magic-note-tag-chip--removable").length'), 4);
        assert.equal(await js('getComputedStyle(document.querySelector("#magic-note-tag-manager")).width'), '28px', 'Split list uses the compact icon');
        // The sticky toolbar spans the full stream width even though content is capped at 880px.
        const toolbarBox = await rect('.magic-note-detail-toolbar'), streamBox = await rect('.magic-notes-stream-pane');
        const streamClient = await js('document.querySelector(".magic-notes-stream-pane").clientWidth');
        assert(Math.abs(toolbarBox.x - streamBox.x) <= 1 && Math.abs(toolbarBox.width - streamClient) <= 1, 'Toolbar spans the stream: ' + JSON.stringify({ toolbarBox, streamBox, streamClient }));
        assert.equal((await rect('.magic-notes-overview')).width, 200);
        assert(await js('document.querySelector(".magic-notes-overview").checkVisibility()'));
        await js('document.querySelector(".magic-notes-card-grid").scrollTop = 300; document.querySelector(".magic-notes-stream-pane").scrollTop = 420');
        await wait('document.querySelector(".magic-notes-stream-pane").scrollTop === 420');
        await settle();
        await click('#magic-note-select-other-note-3');
        await wait('document.querySelector(".magic-note-detail-title").value === "Other note 3"');
        await settle();
        assert.equal(await assertViewportHeight(), longNoteHeight, 'Short and long notes keep the same divider height');
        assert.equal(await js('document.querySelector(".magic-notes-card-grid").scrollTop'), 300);
        assert.equal(await js('document.querySelector(".magic-notes-stream-pane").scrollTop'), 0);
        await click('#magic-note-select-layout-note');
        await wait('document.querySelector(".magic-notes-stream-pane").scrollTop === 420');
        assert.equal(await js('document.querySelector("#magic-note-select-layout-note").getAttribute("aria-current")'), 'true');
        await drag('.magic-notes-notes-resize-handle', 40);
        const notesWidth = (await rect('.magic-notes-overview')).width;
        assert(notesWidth >= 240 && notesWidth <= 245);
        await key('.magic-notes-notes-resize-handle', 'Left');
        assert.equal((await rect('.magic-notes-overview')).width, notesWidth - 16);
        await click('button[aria-controls="magic-library-panel-notes"]');
        assert.equal((await rect('.magic-notes-overview')).width, 0);
        await click('button[aria-controls="magic-library-panel-notes"]');
        assert.equal((await rect('.magic-notes-overview')).width, notesWidth - 16);
        assert.equal(await js('document.querySelector(".magic-notes-card-grid").scrollTop'), 300);
        await key('.magic-notes-notes-resize-handle', 'Home');
        assert.equal((await rect('.magic-notes-overview')).width, 160);
        await js('document.querySelector(".magic-notes-stream-pane").scrollTop = 0');
        const editor = '.magic-note-composer .magic-note-editor__content .ql-editor';
        const saveButton = '.magic-note-composer__header .primary-button';
        await settle();
        await js('document.querySelector(".magic-notes-stream-pane").scrollTop = 0'); await settle();
        // Idle stays collapsed; starting a new entry reveals options immediately after its title.
        const idleHeight = (await rect('.magic-note-composer')).height;
        assert(idleHeight <= 60, 'Idle prompt stays compact: ' + idleHeight);
        assert.equal((await rect('.magic-note-composer__header')).height, 0);
        assert.equal((await rect(saveButton)).width, 0);
        await js('document.querySelector(' + JSON.stringify(editor) + ').focus()'); await settle();
        const newTitle = await rect('.magic-note-composer__title'), typeSwitch = await rect('.magic-note-entry-type');
        assert(newTitle.y >= 0 && typeSwitch.y >= 0 && typeSwitch.y + typeSwitch.height <= 800, 'Type options are visible in the initial viewport');
        assert(Math.abs(typeSwitch.x - newTitle.x - newTitle.width - 8) <= 1 && Math.abs(typeSwitch.y + typeSwitch.height/2 - newTitle.y - newTitle.height/2) <= 1, 'Type options immediately follow the title');
        assert(await js('document.querySelector(".magic-note-entry-type .segmented-control").checkVisibility()'));
        await screenshot('magic-notes-new-entry-types');
        await key('.magic-note-entry-type button:first-child', 'Right');
        await wait('document.querySelector(".magic-note-composer [data-tool=flow-text]")?.disabled === false');
        assert.equal(await js('document.querySelector(".magic-note-entry-type button:last-child").getAttribute("aria-pressed")'), 'true');
        const toolStyle = '.magic-note-composer .canvas-note-color';
        assert.equal(await js('document.querySelector(' + JSON.stringify(toolStyle) + ').checkVisibility()'), false, 'Selection without objects has no drawing attributes');
        for (const tool of ['pen', 'highlight', 'text', 'eraser', 'flow-text', 'select']) {
          await click('.magic-note-composer [data-tool="' + tool + '"]');
          assert.equal(await js('document.querySelector(' + JSON.stringify(toolStyle) + ').checkVisibility()'), ['pen', 'highlight', 'text'].includes(tool), 'Color follows the tool');
          assert.equal(await js('document.querySelector(".magic-note-composer .canvas-note-width").checkVisibility()'), ['pen', 'highlight'].includes(tool), 'Width is only shown for strokes');
        }
        for (const theme of ['light', 'dark']) {
          await js('document.documentElement.dataset.theme = ' + JSON.stringify(theme));
          for (const width of [1280, 960, 520, 360]) {
            win.setContentSize(width, 800); await settle(); await settle();
            const canvasRoot = '.magic-note-composer .canvas-note-root';
            const canvasBox = await rect(canvasRoot), canvasToolbar = await rect(canvasRoot + ' > .canvas-note-toolbar');
            assert(await js('document.querySelector(' + JSON.stringify(canvasRoot) + ').scrollWidth <= document.querySelector(' + JSON.stringify(canvasRoot) + ').clientWidth'), 'Canvas tools do not widen the editor');
            assert((await rect(canvasRoot + ' .canvas-note-viewport')).height >= 150, 'Canvas retains usable writing height');
            const controls = await js('Array.from(document.querySelectorAll(' + JSON.stringify(canvasRoot + ' > .canvas-note-toolbar button, ' + canvasRoot + ' > .canvas-note-toolbar select, ' + canvasRoot + ' > .canvas-note-toolbar input') + ')).filter(el => el.checkVisibility()).map(el => { const r = el.getBoundingClientRect(); return {x:r.x, y:r.y, width:r.width, height:r.height}; })');
            for (const control of controls) {
              assert(control.x >= canvasBox.x && control.x + control.width <= canvasBox.x + canvasBox.width + 1, 'Every canvas control fits the column');
              assert(control.y >= canvasToolbar.y && control.y + control.height <= canvasToolbar.y + canvasToolbar.height, 'Every canvas control fits the toolbar');
              assert(control.width >= 24 && control.height >= 24, 'Compact tools retain usable targets');
            }
            const save = await rect(saveButton);
            const cancel = await rect('.magic-note-composer__header .secondary-button:not(.magic-note-entry-focus__analyze)');
            for (const action of [save, cancel]) {
              assert(action.x >= canvasBox.x && action.x + action.width <= canvasBox.x + canvasBox.width + 1, 'Save and cancel stay visible without scrolling the header');
            }
            assert.equal(await js('document.querySelector(".magic-note-composer__header").scrollWidth <= document.querySelector(".magic-note-composer__header").clientWidth'), true);
            await screenshot('magic-notes-canvas-' + theme + '-' + width);
            await js('(() => { const select = document.querySelector(".magic-note-composer .canvas-note-layout"); select.value = "continuous"; select.dispatchEvent(new Event("change", {bubbles:true})); })()');
            await settle();
            await wait('(() => { const c = document.querySelector(".magic-note-composer .canvas-note-background"); const p = c.getContext("2d").getImageData(c.width - 1, c.height - 1, 1, 1).data; return p[0] === 255 && p[1] === 255 && p[2] === 255; })()');
            const continuousViewport = await rect(canvasRoot + ' .canvas-note-viewport');
            assert(continuousViewport.height >= 150 && continuousViewport.y + continuousViewport.height <= canvasBox.y + canvasBox.height + 1, 'Continuous pages stay within the editor');
            assert(await js('document.querySelector(".magic-note-composer .canvas-note-current-page .canvas-note-interaction-canvas") !== null'), 'Continuous mode retains the live editor');
            await screenshot('magic-notes-continuous-' + theme + '-' + width);
            await js('(() => { const select = document.querySelector(".magic-note-composer .canvas-note-layout"); select.value = "paged"; select.dispatchEvent(new Event("change", {bubbles:true})); })()');
          }
        }
        win.setContentSize(1280, 800); await js('document.documentElement.dataset.theme = "light"'); await settle(); await settle();
        await click('.magic-note-entry-type button:first-child');
        await wait('!!document.querySelector(' + JSON.stringify(editor) + ')');
        await click('.magic-note-composer__header .secondary-button');
        await wait('!document.querySelector(".magic-note-composer--active")');
        assert.equal((await rect('.magic-note-composer__header')).height, 0, 'Cancelling an empty new entry restores the collapsed prompt');
        assert.equal(await js('document.querySelector(".magic-notes-ai-pane")?.checkVisibility() ?? false'), false, 'AI stays closed for notes without comments');
        assert.equal((await rect('.magic-notes-index-pane')).width, 0, 'Record index starts collapsed');
        await click('.magic-note-entry button[aria-label="Edit"]');
        await wait('!!document.querySelector(".magic-note-entry__editor .ql-editor")');
        const entryBox = await rect('.magic-note-entry-focus');
        const entryHeader = await rect('.magic-note-entry-focus__header');
        const editToolbar = await rect('.magic-note-entry__editor .ql-toolbar');
        const editInput = await rect('.magic-note-entry__editor .ql-container');
        assert.deepEqual(entryBox, await rect('.magic-notes-stream-container'), 'Editing fills only the record column');
        assert(entryBox.x > 0 && entryBox.y > 0 && entryBox.width < 1280, 'Application header and note list remain outside the editor');
        for (const box of [editToolbar, editInput]) {
          assert(Math.abs(box.x - entryBox.x) <= 1 && Math.abs(box.width - entryBox.width) <= 1, 'Editor spans the record column without card padding: ' + JSON.stringify({ box, entryBox }));
        }
        assert.equal(editInput.y + editInput.height, entryBox.y + entryBox.height, 'Text area fills remaining column height');
        assert.equal(await js('getComputedStyle(document.querySelector(".magic-note-entry-focus .ql-container")).resize'), 'none', 'Column height is owned by the layout');
        assert(Math.abs(editToolbar.y - entryHeader.y - entryHeader.height) <= 1, 'Toolbar directly follows the entry header');
        assert(Math.abs(editInput.y - editToolbar.y - editToolbar.height) <= 1, 'Input directly follows the toolbar');
        assert(await js('document.querySelector(".magic-note-entry-focus").parentElement.id === "magic-note-entry-focus-host"'));
        assert(await js('!document.querySelector(".magic-notes-overview").closest("[inert]") && !document.querySelector(".magic-note-entry-focus").hasAttribute("aria-modal")'));
        assert(await js('!document.querySelector(".magic-note-entry-stream").checkVisibility({visibilityProperty:true})'));
        await key('.magic-note-entry-focus__header .secondary-button', 'Tab');
        assert(await js('document.activeElement.matches(".magic-note-entry-focus__header .primary-button")'));
        for (const theme of ['light', 'dark']) {
          await js('document.documentElement.dataset.theme = ' + JSON.stringify(theme));
          win.setContentSize(520, 480); await settle(); await settle();
          assert.deepEqual(await rect('.magic-note-entry-focus'), await rect('.magic-notes-stream-container'));
          const save = await rect('.magic-note-entry-focus__header .primary-button');
          assert(save.x >= 0 && save.x + save.width <= 520 && save.y + save.height < 480);
          assert(await js('document.querySelector(".magic-note-entry-focus").scrollWidth <= innerWidth'));
        }
        win.setContentSize(1280, 800); await js('document.documentElement.dataset.theme = "light"'); await settle();
        await screenshot('magic-notes-entry-editor');
        await click('.magic-note-entry__editor-actions .secondary-button');
        await wait('!document.querySelector(".magic-note-entry__editor")');
        assert(await js('document.activeElement.matches("[data-entry-edit]")'));
        // Escape guards the draft, and dismissing that guard keeps this editor mounted.
        await js('document.querySelector(".magic-notes-stream-pane").scrollTop = 420'); await settle();
        await click('.magic-note-entry [data-entry-edit]');
        await wait('!!document.querySelector(".magic-note-entry-focus .ql-editor")');
        await js('document.querySelector(".magic-note-entry-focus .ql-editor").focus()');
        await win.webContents.insertText('Unsaved focused edit');
        await key('.magic-note-entry-focus .ql-editor', 'Escape');
        await wait('!!document.querySelector(".magic-note-entry-focus .magic-note-draft-confirmation")');
        for (const theme of ['light', 'dark']) {
          await js('document.documentElement.dataset.theme = ' + JSON.stringify(theme));
          for (const width of [1280, 520]) {
            win.setContentSize(width, 600); await settle(); await settle();
            const card = await rect('.magic-note-draft-confirmation'), column = await rect('.magic-note-entry-focus');
            assert(card.x >= column.x + 15 && card.x + card.width <= column.x + column.width - 15, 'Confirmation keeps side margins');
            const style = await js('(() => { const s=getComputedStyle(document.querySelector(".magic-note-draft-confirmation")); return { borders: [s.borderTop,s.borderRight,s.borderBottom,s.borderLeft], radius:s.borderRadius,shadow:s.boxShadow }; })()');
            assert(style.borders.every(border => border === style.borders[0] && border.startsWith('1px solid')), 'Four uniform card borders');
            assert.notEqual(style.radius, '0px'); assert.notEqual(style.shadow, 'none');
            const discard = await rect('.magic-note-draft-confirmation .danger-solid');
            assert(discard.x + discard.width <= card.x + card.width - 16 && discard.y + discard.height <= card.y + card.height - 16, 'Actions have safe padding');
            assert(await js('document.querySelector(".magic-note-draft-confirmation").scrollWidth <= document.querySelector(".magic-note-draft-confirmation").clientWidth'));
            await screenshot('magic-notes-confirm-' + theme + '-' + width);
          }
        }
        win.setContentSize(1280, 800); await js('document.documentElement.dataset.theme = "light"'); await settle();
        await key('.magic-note-draft-confirmation .secondary-button', 'Escape');
        await wait('!document.querySelector(".magic-note-draft-confirmation")');
        assert(await js('document.querySelector(".magic-note-entry-focus .ql-editor").textContent.includes("Unsaved focused edit")'));
        await key('.magic-note-entry-focus .ql-editor', 'Escape');
        await wait('!!document.querySelector(".magic-note-draft-confirmation")');
        await click('.magic-note-draft-confirmation .danger-solid');
        await wait('!document.querySelector(".magic-note-entry-focus")'); await settle();
        assert.equal(await js('document.querySelector(".magic-notes-stream-pane").scrollTop'), 420);
        assert(await js('!document.querySelector(".magic-notes-page").closest("[inert]")'));
        // All surrounding columns remain visible, focusable and stationary while editing.
        await click('#magic-notes-index-toggle');
        await click('button[aria-controls="magic-notes-ai-pane"]');
        const surrounding = ['.magic-notes-overview', '.magic-notes-index-pane', '.magic-notes-ai-pane'];
        const beforeEdit = await Promise.all(surrounding.map(rect));
        await click('.magic-note-entry [data-entry-edit]');
        await wait('!!document.querySelector(".magic-note-entry-focus .ql-editor")');
        assert.deepEqual(await Promise.all(surrounding.map(rect)), beforeEdit);
        for (const selector of surrounding) assert(await js('document.querySelector(' + JSON.stringify(selector) + ').checkVisibility()'));
        await js('document.querySelector(".magic-notes-ai-controls select").focus()');
        assert(await js('document.activeElement.matches(".magic-notes-ai-controls select")'), 'Editing does not trap focus away from AI controls');
        await click('.magic-note-entry-focus__header .secondary-button');
        await wait('!document.querySelector(".magic-note-entry-focus")');
        await click('#magic-notes-index-toggle');
        await click('button[aria-controls="magic-notes-ai-pane"]');
        await js('document.querySelector(".magic-notes-stream-pane").scrollTop = 0');
        const focusComposer = async () => { await js('document.querySelector(' + JSON.stringify(editor) + ').focus()'); await settle(); };
        await focusComposer();
        const emptyHeight = (await rect(editor)).height;
        const desktopSaveWidth = (await rect(saveButton)).width;
        assert.deepEqual(await rect('.magic-note-composer'), await rect('.magic-notes-stream-container'), 'New entry fills the same column as editing');
        const newHeader = await rect('.magic-note-composer__header');
        const newBody = await rect(editor);
        assert.equal(newBody.y + newBody.height, (await rect('.magic-note-composer')).y + (await rect('.magic-note-composer')).height);
        for (const selector of ['.magic-note-composer__title', '.magic-note-entry-type', saveButton, '.magic-note-composer__header .secondary-button']) {
          const box = await rect(selector);
          assert(Math.abs(box.y + box.height/2 - newHeader.y - newHeader.height/2) <= 1, 'New entry header shares one row');
        }
        assert.equal(await js('document.querySelector(".magic-note-detail-title").value'), 'Layout note');
        assert.equal(await js('document.querySelector("#magic-notes-title").textContent'), 'Magic Notes');
        await screenshot('magic-notes-light');
        await js('document.documentElement.dataset.theme = "dark"'); await settle();
        assert.equal((await rect(editor)).height, emptyHeight);
        await screenshot('magic-notes-dark');
        await js('document.documentElement.dataset.theme = "light"'); await settle();
        await click('.magic-note-composer__header .secondary-button');
        await wait('!document.querySelector(".magic-note-composer--active")');
        const index = '.magic-notes-index-pane', handle = '.magic-notes-index-resize-handle', stream = '.magic-notes-stream-pane';
        await click('#magic-notes-index-toggle');
        await click('button[aria-controls="magic-notes-ai-pane"]');
        assert.equal(await assertViewportHeight(), longNoteHeight, 'Open panels and dividers fill the viewport');
        const listHeading = await rect('#magic-library-panel-notes > .magic-notes-pane-heading');
        const detailToolbar = await rect('.magic-note-detail-toolbar');
        const aiHeading = await rect('.magic-notes-ai-pane .inline-help-label');
        for (const heading of [listHeading, aiHeading]) {
          assert(Math.abs(heading.y - detailToolbar.y) <= 1, 'Pane headings share a top edge: ' + JSON.stringify({ heading, detailToolbar }));
          assert(Math.abs(heading.height - detailToolbar.height) <= 1, 'Pane headings share a row height: ' + JSON.stringify({ heading, detailToolbar }));
        }
        await screenshot('magic-notes-aligned-headings');
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
        assert.equal((await rect('.magic-notes-overview')).width, 160);
        await js('document.querySelector(".magic-notes-card-grid").scrollTop = 300');
        win.setContentSize(960, 720); await settle(); await settle();
        assert.equal((await rect('.magic-notes-overview')).width, 160);
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
        win.setContentSize(960, 720); await settle(); await settle();
        assert(await js('document.documentElement.scrollWidth <= innerWidth'));
        win.setContentSize(820, 720); await settle(); await settle();
        assert((await rect(stream)).width >= 299);
        const constrained = { index: (await rect(index)).width, editor: (await rect(stream)).width, ai: (await rect('.magic-notes-ai-pane')).width };
        win.setContentSize(720, 640); await settle(); await settle();
        assert.equal((await rect('.magic-notes-overview')).width, 160);
        await click('#magic-notes-list-toggle');
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
        await js('document.querySelector(".magic-note-composer__header").scrollLeft = 10000'); await settle();
        const narrowSave = await rect(saveButton), narrowFooter = await rect('.magic-note-composer__header');
        const footerPaddingRight = await js('parseFloat(getComputedStyle(document.querySelector(".magic-note-composer__header")).paddingRight)');
        assert(Math.abs(narrowSave.width - desktopSaveWidth) <= 1, 'Narrow Save button retains its content width: ' + JSON.stringify({ desktopSaveWidth, narrowSave, narrowFooter }));
        assert(Math.abs(narrowFooter.x + narrowFooter.width - footerPaddingRight - narrowSave.x - narrowSave.width) <= 1, 'Narrow Save button stays right-aligned within footer padding');
        await screenshot('magic-notes-narrow');
        await click('.magic-note-composer__header .secondary-button');
        await wait('!document.querySelector(".magic-note-composer--active")');
        win.setContentSize(560, 640); await settle(); await settle();
        assert(await js('document.querySelector("#magic-notes-list-toggle").checkVisibility()'));
        const detailBeforeDrawer = await rect('.magic-notes-detail-container');
        await click('#magic-notes-list-toggle');
        assert(await js('document.querySelector(".magic-notes-workspace--drawer") !== null'));
        assert.equal((await rect('.magic-notes-overview')).width, 160);
        assert.deepEqual(await rect('.magic-notes-detail-container'), detailBeforeDrawer);
        assert(await js('document.querySelector(".magic-notes-overview").scrollWidth <= document.querySelector(".magic-notes-overview").clientWidth'));
        await key('#magic-library-panel-notes input', 'Escape');
        assert.equal((await rect('.magic-notes-overview')).width, 0);
        assert(await js('document.activeElement.id === "magic-notes-list-toggle"'));
        await click('#magic-notes-list-toggle');
        await click('#magic-note-select-other-note-3');
        await wait('document.querySelector(".magic-note-detail-title").value === "Other note 3"');
        assert.equal((await rect('.magic-notes-overview')).width, 0);
        await click('#magic-notes-list-toggle');
        await click('#magic-note-select-layout-note');
        await wait('document.querySelector(".magic-note-detail-title").value === "Layout note"');
        assert((await rect('.magic-notes-ai-pane')).y >= (await rect(stream)).y + (await rect(stream)).height, 'AI pane stacks below the stream on very narrow widths');
        assert.equal(await js('getComputedStyle(document.querySelector(".magic-notes-ai-resize-handle")).display'), 'none');
        win.setContentSize(1280, 800); await settle(); await settle();
        await click('#magic-notes-list-toggle');
        assert.equal((await rect('.magic-notes-overview')).width, 160);
        assert.equal((await rect(index)).width, withoutAi);
        await key('.magic-note-record', 'Tab');
        await js('document.querySelector(".magic-note-record").focus()');
        assert(await js('document.querySelector(".magic-note-record").matches(":focus-visible")'));
        assert.equal(await js('getComputedStyle(document.querySelector(".magic-note-record")).outlineOffset'), '-2px', 'Focus outline stays inside the scroll viewport');
        await js('document.querySelector(' + JSON.stringify(editor) + ').focus()');
        await win.webContents.insertText('Composer growth check\\n'.repeat(30)); await settle();
        const grownHeight = (await rect(editor)).height;
        assert.equal(await assertViewportHeight(), longNoteHeight, 'Growing drafts keep the same divider height');
        assert.deepEqual(await rect('.magic-note-composer'), await rect('.magic-notes-stream-container'), 'Long drafts stay inside the record column');
        assert(await js('(() => { const el = document.querySelector(' + JSON.stringify(editor) + '); el.scrollTop = el.scrollHeight; return el.scrollTop > 0; })()'), 'Long drafts scroll inside the editor');
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
        win.setContentSize(1600, 900);
        await win.loadURL(${JSON.stringify(server.resolvedUrls!.local[0] + 'layout.html?shell')});
        await open(); await js('document.fonts.ready'); await settle();
        const shellGeometry = [];
        const shellLongHeight = await assertViewportHeight();
        const assertShellPanels = async () => {
          const workspace = await rect('.magic-notes-workspace');
          const page = await rect('.magic-notes-page');
          const shell = await rect('.page-shell');
          const route = await rect('.application-page-content');
          assert.equal(shell.height, route.height, 'PageShell fills application content: ' + JSON.stringify({shell, route}));
          assert.equal(workspace.y + workspace.height, page.y + page.height, 'Workspace fills remaining page height');
          for (const selector of ['.magic-notes-notes-resize-handle', '.magic-notes-stream-pane', '.magic-notes-ai-resize-handle', '.magic-notes-ai-pane']) {
            const box = await rect(selector);
            assert.equal(box.y, workspace.y, selector + ' top');
            assert.equal(box.height, workspace.height, selector + ' height');
          }
          const ai = await rect('.magic-notes-ai-pane'), question = await rect('.magic-notes-question');
          const padding = await js('parseFloat(getComputedStyle(document.querySelector(".magic-notes-ai-pane")).paddingBottom)');
          assert(Math.abs(question.y + question.height - (ai.y + ai.height - padding)) <= 1, 'Question stays at panel bottom: ' + JSON.stringify({ai, question, padding}));
          assert(await js('document.querySelector(".page-shell").scrollHeight <= document.querySelector(".page-shell").clientHeight'), 'Only panels scroll, not PageShell');
          shellGeometry.push({ top: workspace.y, height: workspace.height, bottom: workspace.y + workspace.height, composerBottom: question.y + question.height });
          return workspace.height;
        };
        await assertShellPanels();
        const shellBeforeEdit = await Promise.all(['.sidebar', '.topbar', '.magic-notes-overview', '.magic-notes-ai-pane'].map(rect));
        await click('.magic-note-entry [data-entry-edit]');
        await wait('!!document.querySelector(".magic-note-entry-focus .ql-editor")');
        assert.deepEqual(await rect('.magic-note-entry-focus'), await rect('.magic-notes-stream-container'));
        assert.deepEqual(await Promise.all(['.sidebar', '.topbar', '.magic-notes-overview', '.magic-notes-ai-pane'].map(rect)), shellBeforeEdit);
        assert(await js('!document.querySelector(".app-shell").inert'));
        for (const selector of ['.sidebar', '.topbar', '.magic-notes-overview', '.magic-notes-ai-pane']) {
          assert(await js('(() => { const el = document.querySelector(' + JSON.stringify(selector) + '); const r=el.getBoundingClientRect(); return el.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)); })()'), selector + ' stays uncovered');
        }
        await screenshot('magic-notes-column-editor');
        await click('.magic-note-entry-focus__header .secondary-button');
        await wait('!document.querySelector(".magic-note-entry-focus")');
        await click('#magic-note-select-other-note-3');
        await wait('document.querySelector(".magic-note-detail-title").value === "Other note 3"');
        await settle();
        assert.equal(await assertViewportHeight(), shellLongHeight, 'Production page shell keeps divider height independent of note content');
        await assertShellPanels();
        await click('#magic-note-select-layout-note'); await settle();
        assert.equal(await assertShellPanels(), shellLongHeight, 'Switching back to the long note keeps panel height');
        await click('#magic-note-select-other-note-3'); await settle();
        await click('.magic-note-entry-type button:nth-child(2)');
        await wait('document.querySelector(".magic-note-composer [data-tool=flow-text]")?.disabled === false');
        assert.equal(await assertShellPanels(), shellLongHeight, 'Canvas minimum height stays inside the note stream');
        await click('.magic-note-entry-type button:first-child');
        await wait('!!document.querySelector(' + JSON.stringify(editor) + ')');
        await js('window.dispatchEvent(new Event("layout-comments"))');
        await wait('!!document.querySelector(".magic-notes-ai-feed")'); await settle();
        assert.equal(await assertShellPanels(), shellLongHeight, 'Growing AI comments keep panel height');
        await js('document.querySelector(' + JSON.stringify(editor) + ').focus()');
        await win.webContents.insertText('Shell draft growth\\n'.repeat(80)); await settle();
        assert.equal(await assertShellPanels(), shellLongHeight, 'Typing keeps shell panel height');
        await click('.magic-note-entry button[aria-label="Analyze with AI"]');
        await wait('!!document.querySelector(".magic-notes-ai-live")');
        for (let chunk = 0; chunk < 3; chunk++) {
          await js('window.dispatchEvent(new Event("layout-stream"))'); await settle();
          assert.equal(await assertShellPanels(), shellLongHeight, 'Streaming keeps shell panel height');
        }
        for (const theme of ['light', 'dark']) {
          await js('document.documentElement.dataset.theme = ' + JSON.stringify(theme));
          for (const height of [900, 600]) {
            win.setContentSize(1600, height); await settle(); await settle();
            for (const bottom of [false, true]) {
              await js('(() => { const el = document.querySelector(".magic-notes-ai-content"); el.scrollTop = ' + (bottom ? 'el.scrollHeight' : '0') + '; })()');
              await settle();
              const content = await rect('.magic-notes-ai-content');
              const question = await rect('.magic-notes-question');
              const pane = await rect('.magic-notes-ai-pane');
              assert(Math.abs(content.y + content.height - question.y) <= 1, 'Comments stop above the question area');
              assert(Math.abs(question.y + question.height - pane.y - pane.height) <= 1, 'Question background closes the panel bottom');
              assert.equal(await js('document.querySelector(".magic-notes-ai-pane").scrollTop'), 0, 'Outer pane never scrolls behind the question');
              assert(await js('(() => { const p = document.querySelector(".magic-notes-question"), r = p.getBoundingClientRect(); return p.contains(document.elementFromPoint(r.x + r.width / 2, r.bottom - 2)); })()'), 'Bottom edge belongs to the question surface');
            }
          }
        }
        win.setContentSize(1600, 900); await settle(); await settle();
        for (const selector of [editor, '.magic-notes-ai-content']) {
          assert(await js('(() => { const el = document.querySelector(' + JSON.stringify(selector) + '); el.scrollTop = el.scrollHeight; return el.scrollTop > 0; })()'), selector + ' scrolls internally');
        }
        await settle();
        assert.equal(await assertShellPanels(), shellLongHeight, 'Scrolling keeps composer at panel bottom');
        win.setContentSize(1280, 720); await settle(); await settle();
        await assertShellPanels();
        fs.writeFileSync(${JSON.stringify(join(directory, 'result.json'))}, JSON.stringify({ emptyHeight, grownHeight, dragged, withoutAi, constrained, narrowStream, desktopSaveWidth, narrowSave, narrowFooter, footerPaddingRight, shellGeometry, persisted: true }));
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

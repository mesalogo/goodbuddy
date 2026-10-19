// @vitest-environment node
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { build } from 'esbuild'
import { createServer } from 'vite'
import react from '@vitejs/plugin-react'
import { expect, it } from 'vitest'

it('asks through real IPC, analyzer and utility-process SQLite with page, crop, follow-up and usage settlement', async () => {
  await mkdir(resolve('temp'), { recursive: true })
  const directory = await mkdtemp(join(resolve('temp'), 'magic-note-questions-'))
  const server = await createServer({ configFile: false, root: resolve('.'), cacheDir: join(directory, 'vite'),
    plugins: [react(), { name: 'questions', configureServer(server) { server.middlewares.use('/questions.html', async (_request, response) => {
      response.setHeader('Content-Type', 'text/html')
      response.end(await server.transformIndexHtml('/questions.html', '<html><body><script type="module" src="/tests/support/magic-note-questions-regression.tsx"></script></body></html>'))
    }) } }], server: { host: '127.0.0.1', port: 0, watch: null }, optimizeDeps: { entries: ['tests/support/magic-note-questions-regression.tsx'] } })
  try {
    await build({ entryPoints: ['src/main/magic-notes/magic-notes-analysis-ipc.ts'], outfile: join(directory, 'analysis.cjs'), bundle: true, platform: 'node', format: 'cjs', external: ['electron'],
      plugins: [{ name: 'deterministic-model', setup(build) {
        build.onResolve({ filter: /agent\/create-runtime$/ }, () => ({ path: 'model', namespace: 'fixture' }))
        build.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: `export function createDefaultModelRuntime() { return {
          async *run(request) {
            globalThis.questionRequests.push(request);
            if ((await globalThis.questionStorage.getTask(request.requestId)).status !== 'running') throw new Error('Question task must exist before model execution');
            yield { type: 'text', requestId: request.requestId, delta: 'Answer ' + globalThis.questionRequests.length };
            yield { type: 'model-usage', requestId: request.requestId, callId: 'call-1', runtime: 'model', provider: 'fixture', model: 'fixture', inputTokens: 17, outputTokens: 5, cacheReadTokens: 2, cacheWriteTokens: 0 };
            if (globalThis.failQuestion) yield { type: 'error', requestId: request.requestId, message: 'Fixture failure after usage' };
            else yield { type: 'done', requestId: request.requestId };
          },
          async releaseConversation() {}, async dispose() {}
        }; }` }))
      } }] })
    for (const [entry, output, format] of [
      ['desktop-storage-entry', 'desktop-storage-entry.mjs', 'esm'],
      ['desktop-storage-client', 'storage-client.mjs', 'esm'],
      ['assistant-storage-port', 'storage-port.cjs', 'cjs'],
      ['readonly-query-worker', 'readonly-query-worker.cjs', 'cjs'],
      ['assistant-storage-worker', 'assistant-storage-worker.cjs', 'cjs']
    ] as const) await build({ entryPoints: [resolve(`src/main/${entry}.ts`)], outfile: join(directory, output), bundle: true,
      platform: 'node', format, external: ['electron', '@napi-rs/canvas'], logLevel: 'silent' })
    await server.listen()
    await writeFile(join(directory, 'preload.cjs'), `const { contextBridge, ipcRenderer } = require('electron'); contextBridge.exposeInMainWorld('goodbuddy', {
      magicNotes: { get: () => ipcRenderer.invoke('fixture-note'), ask: input => ipcRenderer.invoke('magic-notes:ask', input) },
      settings: { getRuntime: () => ipcRenderer.invoke('fixture-runtime') }
    });`)
    await writeFile(join(directory, 'driver.cjs'), `
      const { app, BrowserWindow, ipcMain } = require('electron');
      const assert = require('node:assert/strict');
      const { join } = require('node:path');
      const root = ${JSON.stringify(directory)};
      let storage;
      app.setPath('userData', ${JSON.stringify(join(directory, 'profile'))});
      globalThis.questionRequests = [];
      const noteId = '00000000-0000-4000-8000-000000000601', entryId = '00000000-0000-4000-8000-000000000602';
      const fixture = { id: noteId, title: 'Question fixture', entries: [{ id: entryId, noteId, revision: 1, plainText: 'FULL RECORD MUST NOT LEAK',
        content: { version: 2, kind: 'paged-canvas', assets: [], pages: [1,2].map(i => ({ id: 'page-' + i, width: 794, height: 1123,
          background: { type: 'template', template: 'blank' }, objects: [{ type: 'Rect', canvasKind: 'rectangle', originX: 'left', originY: 'top', left: 200, top: 200, width: 100, height: 100, fill: i === 1 ? '#ff0000' : '#0000ff' }] })),
          flow: { version: 1, ops: [{ insert: 'FIRST PAGE\\n' }, { insert: { canvasPageBreak: 'page-2' } }, { insert: 'SECOND PAGE\\n' }] } } }] };
      app.whenReady().then(async () => {
        const { DesktopStorageClient } = await import('./storage-client.mjs');
        storage = new DesktopStorageClient({ assistantPath: join(root, 'assistant.sqlite'), knowledgePath: join(root, 'knowledge.sqlite'),
          defaultRootPath: root, userDataPath: root, entryPath: join(root, 'desktop-storage-entry.mjs'),
          readerWorkerPath: join(root, 'readonly-query-worker.cjs'), upgradeWorkerPath: join(root, 'assistant-storage-worker.cjs') });
        await storage.ready;
        const database = require('./storage-port.cjs').createAssistantStoragePort(storage);
        globalThis.questionStorage = database;
        const note = await database.createMagicNote({ title: fixture.title, content: fixture.entries[0].content });
        const win = new BrowserWindow({ show: true, width: 1200, height: 900, useContentSize: true,
          webPreferences: { preload: ${JSON.stringify(join(directory, 'preload.cjs'))}, sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
        require('./analysis.cjs').registerMagicNotesAnalysisIpcHandlers(ipcMain.handle.bind(ipcMain), {
          window: win, assistantDatabase: database, settingsStore: { getResolvedSettings: async () => ({ workspacePath: root, supportsImageInput: true }) },
          persistModelUsage: event => database.upsertModelUsageCall({ requestId: event.requestId, callId: event.callId, runtime: event.runtime, provider: event.provider, model: event.model,
            input: event.inputTokens, output: event.outputTokens, cacheRead: event.cacheReadTokens, cacheWrite: event.cacheWriteTokens }),
          safeRuntimeError: error => String(error)
        });
        ipcMain.handle('fixture-note', () => note);
        ipcMain.handle('fixture-runtime', () => ({ supportsImageInput: true, modelProfiles: [] }));
        const js = code => win.webContents.executeJavaScript(code);
        const wait = async code => { for (let i = 0; i < 400; i++) { if (await js(code)) return; await new Promise(r => setTimeout(r,25)); } throw new Error('Timeout: ' + code); };
        const button = text => 'Array.from(document.querySelectorAll("button")).find(el => el.textContent === ' + JSON.stringify(text) + ')';
        const click = async text => { await wait(button(text) + ' && !' + button(text) + '.disabled'); await js(button(text) + '.click()'); };
        const ask = async text => { await js('document.querySelector("textarea").focus()'); await win.webContents.insertText(text); await click('Ask'); };
        await win.loadURL(${JSON.stringify(server.resolvedUrls!.local[0] + 'questions.html')});
        await wait('document.querySelector(".canvas-note-next-page") && !document.querySelector(".canvas-note-next-page").disabled');
        await js('document.querySelector(".canvas-note-next-page").click()');
        await wait('document.querySelector(".canvas-note-page-counter").textContent.includes("2 / 2")');
        assert.deepEqual(await js('window.compareQuestionCaptures()'), { image: true, text: true, distinct: true });
        await ask('What is on this page?');
        await wait('document.querySelector(".magic-notes-question__history")?.textContent.includes("Answer 1")');
        assert(questionRequests[0].prompt.includes('SECOND PAGE'));
        assert(!questionRequests[0].prompt.includes('FIRST PAGE'));
        assert(!questionRequests[0].prompt.includes('FULL RECORD'));
        assert.equal(questionRequests[0].images.length, 1);
        const clearLayout = await js('(() => {'
          + 'const clear = document.querySelector(".magic-notes-question__history-clear");'
          + 'const range = document.createRange(); range.selectNodeContents(document.querySelector(".magic-notes-question__history strong"));'
          + 'const a = clear.getBoundingClientRect(), b = range.getBoundingClientRect();'
          + 'return { label: clear.getAttribute("aria-label"), border: getComputedStyle(clear).borderTopWidth,'
          + 'overlaps: a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom,'
          + 'limitsVisible: document.querySelector(".magic-notes-question").textContent.includes("50 images") };'
          + '})()');
        assert.deepEqual(clearLayout, { label: 'Clear question history', border: '0px', overlaps: false, limitsVisible: false });
        const regionButton = 'document.querySelector(".magic-notes-question__actions .icon-button")';
        await wait(regionButton + ' && !' + regionButton + '.disabled');
        assert.equal(await js(regionButton + '.getAttribute("aria-label")'), 'Select page region');
        assert.equal(await js('getComputedStyle(' + regionButton + ').borderTopWidth'), '0px', 'The region trigger is a borderless icon button');
        await js(regionButton + '.click()');
        // The overlay covers the visible canvas page itself, not a copy in the side panel.
        await wait('!!document.querySelector(".canvas-note-page > .magic-canvas-region")');
        assert(!(await js('!!document.querySelector(".magic-notes-question input[type=number]:not([aria-label])")')), 'No percentage fields');
        await js('document.querySelector(".canvas-note-page").scrollIntoView({block:"center"})');
        await js('new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))');
        win.focus(); win.webContents.focus(); await wait('document.hasFocus()');
        const box = await js('(() => {const b=document.querySelector(".magic-canvas-region").getBoundingClientRect();return {x:b.x,y:b.y,w:b.width,h:b.height}})()');
        const x = Math.round(box.x + box.w * .2), y = Math.round(box.y + box.h * .2);
        win.webContents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
        win.webContents.sendInputEvent({ type: 'mouseMove', x: Math.round(box.x + box.w * .6), y: Math.round(box.y + box.h * .6), modifiers: ['leftButtonDown'] });
        win.webContents.sendInputEvent({ type: 'mouseUp', x: Math.round(box.x + box.w * .6), y: Math.round(box.y + box.h * .6), button: 'left', clickCount: 1 });
        // Releasing the mouse produces the thumbnail directly; there is no confirmation step.
        await wait('!!document.querySelector(".magic-notes-question__region img")');
        assert(!(await js('!!document.querySelector(".magic-canvas-region")')), 'Overlay closes after selection');
        const crop = await js('(async () => { const img=document.querySelector(".magic-notes-question__region img"); await img.decode(); return {w:img.naturalWidth,h:img.naturalHeight}; })()');
        assert(crop.w > 300 && crop.w < 330 && crop.h > 430 && crop.h < 470, JSON.stringify(crop));
        const color = await js('(() => { const img=document.querySelector(".magic-notes-question__region img"); const c=document.createElement("canvas"); c.width=img.naturalWidth;c.height=img.naturalHeight;const ctx=c.getContext("2d");ctx.drawImage(img,0,0);return Array.from(ctx.getImageData(60,30,1,1).data); })()');
        assert.deepEqual(color, [0, 0, 255, 255], 'The crop contains page two blue ink, not page one red ink');
        await ask('Explain the blue rectangle');
        await wait('document.querySelector(".magic-notes-question__history").textContent.includes("Answer 2")');
        assert.equal(questionRequests[1].images.length, 1);
        assert(!questionRequests[1].prompt.includes('SECOND PAGE'));
        assert.equal(questionRequests[1].history.length, 2);
        await ask('What about its size?');
        await wait('document.querySelector(".magic-notes-question__history").textContent.includes("Answer 3")');
        assert.equal(questionRequests[2].history.length, 4);
        await js('document.querySelector(".magic-notes-question__region-remove").click()');
        await wait('!document.querySelector(".magic-notes-question__region img")');
        assert.equal(await js('document.querySelector("#magic-note-question-scope").value'), 'page');
        await js(regionButton + '.click()');
        await wait('document.activeElement?.classList.contains("magic-canvas-region")');
        win.webContents.sendInputEvent({type:'keyDown',keyCode:'Escape'}); win.webContents.sendInputEvent({type:'keyUp',keyCode:'Escape'});
        await wait('!document.querySelector(".magic-canvas-region")');
        await wait('document.activeElement === ' + regionButton);
        assert(!(await js('!!document.querySelector(".magic-notes-question__region img")')), 'Escape adds no region');
        // Enter selects the whole current page from the keyboard.
        await js(regionButton + '.click()');
        await wait('document.activeElement?.classList.contains("magic-canvas-region")');
        win.webContents.sendInputEvent({type:'keyDown',keyCode:'Return'}); win.webContents.sendInputEvent({type:'keyUp',keyCode:'Return'});
        await wait('!!document.querySelector(".magic-notes-question__region img")');
        const full = await js('(async () => { const img=document.querySelector(".magic-notes-question__region img"); await img.decode(); return {w:img.naturalWidth,h:img.naturalHeight}; })()');
        assert(full.w > 780 && full.h > 1100, JSON.stringify(full));
        await js('document.querySelector(".magic-notes-question__region-remove").click()');
        await wait('!document.querySelector(".magic-notes-question__region img")');
        assert.equal(await js('document.querySelector("#errors").textContent'), '');
        for (const request of questionRequests) assert.equal((await database.getTask(request.requestId)).status, 'completed');
        globalThis.failQuestion = true;
        await ask('Fail after usage');
        await wait('document.querySelector("#errors").textContent.includes("Fixture failure after usage")');
        assert.equal((await database.getTask(questionRequests[3].requestId)).status, 'failed');
        assert.equal(await js('document.querySelector("textarea").value'), 'Fail after usage');
        const usage = await database.getTokenUsageSummary();
        assert.equal(usage.records.length, 4);
        assert(usage.records.every(record => record.systemSource === 'magic-notes'));
        assert.equal(usage.systemTotals.callCount, 4);
        assert.equal(usage.systemTotals.totalTokens, 88);
        assert.equal(usage.conversationTotals.callCount, 0);
        await storage.close();
        const sql = new (require('node:sqlite').DatabaseSync)(join(root, 'assistant.sqlite'), { readOnly: true });
        try {
          assert.equal(sql.prepare('SELECT count(*) AS n FROM model_usage_calls').get().n, 4);
          assert.equal(sql.prepare('SELECT sum(input_tokens) AS n FROM model_usage_calls').get().n, 68);
          assert.equal(sql.prepare('SELECT count(*) AS n FROM tasks WHERE visible = 0').get().n, 4);
          assert.equal(sql.prepare("SELECT count(*) AS n FROM tasks WHERE origin = 'magic-notes'").get().n, 4);
          assert.deepEqual(sql.prepare('PRAGMA foreign_key_check').all(), []);
        } finally { sql.close(); }
        console.log('Question IPC/Electron: 4 deterministic model requests; real storage usage, completion/failure, current page, crop, history and cancel passed.');
        app.exit(0);
      }).catch(async error => { console.error(error); await storage?.close(); app.exit(1); });
    `)
    const env = { ...process.env }
    delete env.ELECTRON_RUN_AS_NODE
    const child = spawn(createRequire(import.meta.url)('electron'), [join(directory, 'driver.cjs')], { env, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    child.stdout.on('data', data => { output += data })
    child.stderr.on('data', data => { output += data })
    const timeout = setTimeout(() => child.kill(), 60000)
    try { expect(await new Promise((resolve, reject) => { child.once('exit', resolve); child.once('error', reject) }), output).toBe(0) }
    finally { clearTimeout(timeout) }
  } finally { await server.close(); await rm(directory, { recursive: true, force: true }) }
}, 90000)

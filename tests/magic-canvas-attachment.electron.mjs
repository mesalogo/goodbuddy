// Run with: node tests/magic-canvas-attachment.electron.mjs
// Real Electron regression for pasting/adding file attachments to a canvas note.
import assert from 'node:assert/strict';
import console from 'node:console';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import process from 'node:process';
import { clearTimeout, setTimeout } from 'node:timers';
import { fileURLToPath, URL } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

if (!process.env.CANVAS_ATTACHMENT_DRIVER) {
  console.log('Starting canvas attachment Electron regression');
  const { createServer } = await import('vite');
  const electron = join(root, 'node_modules/electron/dist',
    (await readFile(join(root, 'node_modules/electron/path.txt'), 'utf8')).trim());
  const profile = await mkdtemp(join(process.env.CANVAS_ATTACHMENT_TMP || tmpdir(), 'goodbuddy-canvas-attachment-'));
  const server = await createServer({
    configFile: false, root, cacheDir: join(profile, 'vite'),
    server: { host: '127.0.0.1', port: 0, watch: null },
    optimizeDeps: { noDiscovery: true, include: ['fabric', 'quill', 'jspdf'] },
    plugins: [{
      name: 'canvas-attachment-fixture',
      configureServer(vite) {
        vite.middlewares.use('/attachment.html', async (_request, response) => {
          response.setHeader('Content-Type', 'text/html');
          response.end(await vite.transformIndexHtml('/attachment.html', `<!doctype html>
            <html><head><meta charset="utf-8"></head><body>
            <div id="host" class="magic-canvas-editor" style="width:900px;height:800px"></div>
            <script type="module">
              import '/src/renderer/src/styles.css';
              import '/node_modules/quill/dist/quill.snow.css';
              import '/src/renderer/src/magic-canvas.css';
              import { mountCanvasNote } from '/src/renderer/src/magic-canvas/canvas-note.mjs';
              window.mount = async (content) => {
                await window.editor?.destroy();
                document.querySelector('#host').textContent = '';
                window.errors = [];
                window.editor = mountCanvasNote(document.querySelector('#host'), content || {
                  version: 2, pages: [{ id: 'p1', width: 794, height: 1123, objects: [] }]
                }, { onError: (message) => window.errors.push(message) });
                await window.editor.flush();
              };
              const target = (selector) => document.querySelector(selector);
              window.pasteFile = (name, type, text, selector) => {
                const data = new DataTransfer();
                data.items.add(new File([text], name, { type }));
                const event = new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true });
                target(selector || '.canvas-note-viewport').dispatchEvent(event);
                return event.defaultPrevented;
              };
              window.chooseFile = (name, type, text) => {
                const input = target('.canvas-note-attachment-input');
                const data = new DataTransfer();
                data.items.add(new File([text], name, { type }));
                input.files = data.files;
                input.dispatchEvent(new Event('change', { bubbles: true }));
              };
              window.activeTool = () => target('.canvas-note-tool-group .canvas-note-active')?.dataset.tool || null;
              window.pickTool = (name) => target('[data-tool="' + name + '"]').click();
              window.cardCount = () => document.querySelectorAll('.canvas-flow-attachment').length;
              window.cardCentre = () => {
                const rect = target('.canvas-flow-attachment')?.getBoundingClientRect();
                return rect ? { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) } : null;
              };
              window.cardIcon = () => {
                const icon = target('.canvas-flow-attachment img');
                return icon ? { src: icon.getAttribute('src') || icon.src, width: icon.naturalWidth } : null;
              };
            </script></body></html>`));
        });
      }
    }]
  });
  try {
    await server.listen();
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    env.CANVAS_ATTACHMENT_DRIVER = import.meta.url;
    env.CANVAS_ATTACHMENT_PROFILE = profile;
    const bootstrap = join(profile, 'canvas-attachment-electron.cjs');
    await writeFile(bootstrap, `const { app } = require('electron');
      app.setPath('userData', process.env.CANVAS_ATTACHMENT_PROFILE);
      import(process.env.CANVAS_ATTACHMENT_DRIVER).catch((error) => { console.error(error); app.exit(1); });`);
    const child = spawn(electron, [bootstrap, server.resolvedUrls.local[0] + 'attachment.html'], { env, stdio: 'inherit' });
    const timeout = setTimeout(() => child.kill(), 90000);
    process.exitCode = await new Promise((done, reject) => {
      child.once('error', reject);
      child.once('exit', (code) => done(code ?? 1));
    });
    clearTimeout(timeout);
    console.log('Electron exit', process.exitCode);
  } finally {
    await server.close();
    await rm(profile, { recursive: true, force: true });
  }
} else {
  const { app, BrowserWindow } = await import('electron');
  await app.whenReady();
  const profile = process.env.CANVAS_ATTACHMENT_PROFILE;
  const downloadDirectory = join(profile, 'downloads');
  await mkdir(downloadDirectory, { recursive: true });
  const win = new BrowserWindow({ width: 1100, height: 1000, show: true,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  const run = (code) => win.webContents.executeJavaScript(code);
  const downloads = [];
  win.webContents.session.on('will-download', (_event, item) => {
    downloads.push(item.getFilename());
    item.setSavePath(join(downloadDirectory, item.getFilename()));
  });
  win.webContents.on('console-message', (event) => {
    if (event.level === 'error') console.error('Renderer:', event.message);
  });
  const failures = [];
  let passed = 0;
  async function check(name, action) {
    try { await action(); passed++; console.log('PASS', name); }
    catch (error) { failures.push(name); console.error('FAIL', name, error.message); }
  }
  async function click(point) {
    win.webContents.sendInputEvent({ type: 'mouseMove', ...point });
    win.webContents.sendInputEvent({ type: 'mouseDown', ...point, button: 'left', clickCount: 1 });
    win.webContents.sendInputEvent({ type: 'mouseUp', ...point, button: 'left', clickCount: 1 });
    await sleep(400);
  }
  const mount = async (content) => { await run(`mount(${content ? JSON.stringify(content) : ''})`); await sleep(150); };
  const settleCard = async () => {
    for (let i = 0; i < 40 && !await run('cardCount()'); i++) await sleep(50);
  };
  try {
    await win.loadURL(process.argv[2]);
    for (let i = 0; i < 200 && !await run('typeof mount === "function"'); i++) await sleep(50);

    for (const tool of ['select', 'pen', 'flow-text']) {
      await check(`${tool}: pasted file becomes a card and keeps the current tool`, async () => {
        await mount();
        await run(`pickTool('${tool}')`);
        await sleep(200);
        assert.equal(await run('pasteFile("hello.txt", "text/plain", "hello world")'), true);
        await settleCard();
        assert.equal(await run('cardCount()'), 1);
        assert.equal(await run('activeTool()'), tool);
        assert.deepEqual(await run('errors'), []);
        for (let i = 0; i < 40 && !(await run('cardIcon()')).width; i++) await sleep(50);
        const icon = await run('cardIcon()');
        assert.match(icon.src, /document\.svg/);
        assert.ok(icon.width > 0, 'workspace icon must load');
      });
    }

    await check('pasted file with focus inside the text editor is handled by the canvas', async () => {
      await mount();
      await run('pickTool("flow-text")');
      await sleep(200);
      await run('pasteFile("a.md", "text/markdown", "# hi", ".canvas-flow-surface")');
      await sleep(300);
      // Text mode accepts text only; the paste must not silently create a file card.
      assert.equal(await run('activeTool()'), 'flow-text');
      assert.deepEqual(await run('errors'), []);
    });

    await check('toolbar attachment button keeps the tool and adds a card (also in text mode)', async () => {
      for (const tool of ['pen', 'flow-text']) {
        await mount();
        await run(`pickTool('${tool}')`);
        await sleep(200);
        await run('chooseFile("sheet.xlsx", "application/vnd.ms-excel", "x")');
        await settleCard();
        assert.equal(await run('cardCount()'), 1, tool);
        assert.equal(await run('activeTool()'), tool);
        assert.match((await run('cardIcon()')).src, /table\.svg/);
      }
    });

    await check('attachment-only note counts as content', async () => {
      await mount();
      await run('chooseFile("a.zip", "application/zip", "zz")');
      await settleCard();
      assert.equal(await run('editor.hasContent()'), true);
    });

    await check('attachment survives save and reopen', async () => {
      await mount();
      await run('chooseFile("keep.custom", "application/x-custom", "payload")');
      await settleCard();
      const saved = await run('editor.flush()');
      await mount(saved);
      assert.equal(await run('cardCount()'), 1);
      assert.deepEqual(await run('errors'), []);
    });

    for (const tool of ['select', 'flow-text']) {
      await check(`${tool}: real click downloads the original bytes`, async () => {
        await mount();
        await run(`pickTool('${tool}')`);
        await sleep(200);
        const name = `real-${tool}.txt`;
        await run(`chooseFile("${name}", "text/plain", "content for ${tool}")`);
        await settleCard();
        const before = downloads.length;
        await click(await run('cardCentre()'));
        assert.equal(downloads.length, before + 1, 'exactly one download per click');
        assert.equal(downloads.at(-1), name);
        await sleep(200);
        assert.equal(await readFile(join(downloadDirectory, name), 'utf8'), `content for ${tool}`);
      });
    }

    await check('clicking empty paper in select mode does not download', async () => {
      await mount();
      await run('chooseFile("idle.txt", "text/plain", "x")');
      await settleCard();
      const before = downloads.length;
      await click({ x: 600, y: 700 });
      assert.equal(downloads.length, before);
    });

    console.log(JSON.stringify({ electron: process.versions.electron, passed, failures }));
    win.destroy();
    app.exit(failures.length ? 1 : 0);
  } catch (error) {
    console.error(error);
    win.destroy();
    app.exit(1);
  }
}

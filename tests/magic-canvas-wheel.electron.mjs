// Run with: node tests/magic-canvas-wheel.electron.mjs
import assert from 'node:assert/strict';
import console from 'node:console';
import { spawn } from 'node:child_process';
import { copyFile, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import process from 'node:process';
import { clearTimeout, setTimeout } from 'node:timers';
import { fileURLToPath, URL } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

if (!process.env.CANVAS_WHEEL_DRIVER) {
  console.log('Starting canvas wheel Electron regression');
  const { createServer } = await import('vite');
  const electron = join(root, 'node_modules/electron/dist',
    (await readFile(join(root, 'node_modules/electron/path.txt'), 'utf8')).trim());
  const profile = await mkdtemp(join(process.env.CANVAS_WHEEL_TMP || tmpdir(), 'goodbuddy-canvas-wheel-'));
  const server = await createServer({
    configFile: false, root, cacheDir: join(profile, 'vite'),
    server: { host: '127.0.0.1', port: 0, watch: null },
    optimizeDeps: { noDiscovery: true, include: ['fabric', 'quill', 'jspdf'] },
    plugins: [{
      name: 'canvas-wheel-fixture',
      configureServer(server) {
        server.middlewares.use('/wheel.html', async (_request, response) => {
          response.setHeader('Content-Type', 'text/html');
          response.end(await server.transformIndexHtml('/wheel.html', `<!doctype html>
            <html><head><meta charset="utf-8"><style>
              /* Constrain only the wheel fixture to exercise both scroll axes. */
              #host > .canvas-note-root { height: 500px; }
              #host .canvas-note-viewport { flex: 1 1 0; }
            </style></head><body>
            <div id="outer" style="width:700px;height:650px;overflow:auto">
              <div style="width:1600px;height:1800px">
                <div id="host" class="magic-canvas-editor" style="width:540px;height:500px"></div>
              </div>
            </div>
            <div id="layout" style="display:none;height:650px;overflow:auto"></div>
            <script type="module">
              import '/src/renderer/src/styles.css';
              import '/node_modules/quill/dist/quill.snow.css';
              import '/src/renderer/src/magic-canvas.css';
              import { mountCanvasNote } from '/src/renderer/src/magic-canvas/canvas-note.mjs';
              import { setupZoom } from '/tests/support/canvas-zoom-regression.mjs';
              window.setupZoom = setupZoom;
              window.setupLayout = async (width, saved) => {
                await window.editor?.destroy();
                document.querySelector('#outer').style.display = 'none';
                const layout = document.querySelector('#layout');
                layout.style.display = 'block';
                layout.style.width = width + 'px';
                layout.innerHTML = saved
                  ? '<div class="magic-note-entry-stream"><article class="magic-note-entry"><div class="magic-canvas-content"><button class="magic-canvas-open">Edit</button><div class="magic-canvas-editor"></div></div></article></div>'
                  : '<div class="magic-note-composer"><div class="magic-canvas-editor"></div></div>';
                window.editor = mountCanvasNote(layout.querySelector('.magic-canvas-editor'), {
                  version: 2, pages: [
                    { id: 'portrait', width: 794, height: 1123, objects: [] },
                    { id: 'landscape', width: 1123, height: 794, objects: [] }
                  ]
                }, { disabled: saved });
                await window.editor.flush();
                window.viewport = layout.querySelector('.canvas-note-viewport');
                window.geometry = () => {
                  const page = layout.querySelector('.canvas-note-page').getBoundingClientRect();
                  const view = viewport.getBoundingClientRect();
                  const root = layout.querySelector('.canvas-note-root').getBoundingClientRect();
                  return { pageHeight: page.height, pageBottom: page.bottom, viewBottom: view.bottom,
                    rootHeight: root.height, maxY: viewport.scrollHeight - viewport.clientHeight,
                    maxX: viewport.scrollWidth - viewport.clientWidth,
                    outerMaxX: layout.scrollWidth - layout.clientWidth,
                    outerMaxY: layout.scrollHeight - layout.clientHeight };
                };
              };
              window.setup = async (mode, small = false) => {
                await window.editor?.destroy();
                document.querySelector('#outer').scrollTo(0, 0);
                window.changes = 0;
                window.editor = mountCanvasNote(document.querySelector('#host'), {
                  version: 2,
                  pages: [{ id: 'wheel-page', width: small ? 300 : 1200, height: small ? 200 : 1400, objects: [] }],
                  flow: { version: 1, ops: [{ insert: 'Wheel regression body text\\n' }] }
                }, { disabled: mode === 'readonly', onChange: () => window.changes++ });
                await window.editor.flush();
                if (mode !== 'readonly') document.querySelector('[data-tool="' + (mode === 'flow' ? 'flow-text' : 'pen') + '"]').click();
                window.viewport = document.querySelector('.canvas-note-viewport');
                window.beforeContent = JSON.stringify(window.editor.content());
                window.wheels = [];
                viewport.addEventListener('wheel', e => window.wheels.push({
                  x: e.deltaX, y: e.deltaY, shift: e.shiftKey, ctrl: e.ctrlKey,
                  prevented: e.defaultPrevented, trusted: e.isTrusted, target: e.target.className
                }));
                viewport.scrollTo(0, 0);
              };
              window.snapshot = () => ({ x: viewport.scrollLeft, y: viewport.scrollTop,
                maxX: viewport.scrollWidth - viewport.clientWidth, maxY: viewport.scrollHeight - viewport.clientHeight,
                outerX: document.querySelector('#outer').scrollLeft, outerY: document.querySelector('#outer').scrollTop,
                wheels: window.wheels });
            </script></body></html>`));
        });
      }
    }]
  });
  try {
    await server.listen();
    console.log('Fixture ready', server.resolvedUrls.local[0]);
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    env.CANVAS_WHEEL_DRIVER = import.meta.url;
    env.CANVAS_WHEEL_PROFILE = profile;
    const bootstrap = join(profile, 'canvas-wheel-electron.cjs');
    await copyFile(join(root, 'tests/support/canvas-wheel-electron.cjs'), bootstrap);
    const child = spawn(electron, [bootstrap, server.resolvedUrls.local[0] + 'wheel.html'], { env, stdio: 'inherit' });
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
  const win = new BrowserWindow({ width: 1000, height: 800, show: true,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  const run = (code) => win.webContents.executeJavaScript(code);
  win.webContents.on('console-message', (event) => {
    if (event.level === 'error') console.error('Renderer:', event.message);
  });
  const failures = [];
  let passed = 0;
  async function check(name, action) {
    try { await action(); passed++; console.log('PASS', name); }
    catch (error) { failures.push(name); console.error('FAIL', name, error.message); }
  }
  async function wheel(deltaX, deltaY, modifiers = []) {
    const point = await run(`(() => {
      const r = viewport.getBoundingClientRect();
      return { x: Math.round(r.x + 160), y: Math.round(r.y + 110) };
    })()`);
    win.webContents.sendInputEvent({ type: 'mouseMove', ...point });
    win.webContents.sendInputEvent({ type: 'mouseWheel', ...point, deltaX: -deltaX, deltaY: -deltaY,
      canScroll: true, modifiers });
    await sleep(220);
    return run('snapshot()');
  }
  try {
    await win.loadURL(process.argv[2]);
    for (let i = 0; i < 200 && !await run('typeof setup === "function"'); i++) await sleep(50);
    for (const mode of ['drawing', 'flow', 'readonly']) {
      await run(`setup('${mode}')`);
      await check(`${mode}: native deltaX forward/backward`, async () => {
        const right = await wheel(100, 0);
        assert.ok(right.x > 0 && right.y === 0, JSON.stringify(right));
        assert.ok(Math.abs(right.x - 100) < 2, 'Wheel must not scroll twice');
        const left = await wheel(-60, 0);
        assert.ok(left.x < right.x && left.y === 0, JSON.stringify(left));
        assert.ok(left.wheels.every(e => e.trusted));
      });
      await run('viewport.scrollTo(0, 0)');
      await sleep(100);
      await check(`${mode}: Shift+deltaY horizontal only`, async () => {
        const state = await wheel(0, 100, ['shift']);
        assert.ok(state.x > 0 && state.y === 0, JSON.stringify(state));
      });
      await check(`${mode}: Shift with native deltaX retains its axis`, async () => {
        const before = await run('snapshot()');
        const state = await wheel(-50, 0, ['shift']);
        assert.ok(state.x < before.x && state.y === 0, JSON.stringify(state));
      });
      await run('viewport.scrollTo(0, 0)');
      await sleep(100);
      await check(`${mode}: vertical and diagonal trackpad deltas`, async () => {
        const vertical = await wheel(0, 80);
        assert.ok(vertical.y > 0 && vertical.x === 0, JSON.stringify(vertical));
        const diagonal = await wheel(70, 60);
        assert.ok(diagonal.x > 0 && diagonal.y > vertical.y, JSON.stringify(diagonal));
      });
      await check(`${mode}: Ctrl wheel zooms without scrolling or editing`, async () => {
        const before = await run('snapshot()');
        const state = await wheel(0, 60, ['control']);
        assert.equal(state.wheels.at(-1).ctrl, true);
        assert.equal(state.wheels.at(-1).prevented, true);
        assert.equal(state.x, before.x);
        assert.equal(state.y, before.y);
        assert.ok(await run('parseFloat(document.querySelector(".canvas-note-zoom-reset").textContent) < 100'));
        await run('document.querySelector(".canvas-note-zoom-reset").click()');
      });
      await check(`${mode}: right edge chains to outer page`, async () => {
        await run('viewport.scrollLeft = viewport.scrollWidth');
        await sleep(100);
        const state = await wheel(100, 0);
        assert.ok(state.outerX > 0, JSON.stringify(state));
        assert.equal(state.wheels.at(-1).prevented, false);
        await run('document.querySelector("#outer").scrollTo(0, 0)');
        await sleep(100);
      });
      await check(`${mode}: bottom edge chains to outer page`, async () => {
        await run('viewport.scrollTop = viewport.scrollHeight');
        await sleep(100);
        const state = await wheel(0, 100);
        assert.ok(state.outerY > 0, JSON.stringify(state));
      });
      await check(`${mode}: scrolling does not edit content`, async () => {
        assert.equal(await run('JSON.stringify(editor.content()) === beforeContent && changes === 0'), true);
      });
      await run(`setup('${mode}', true)`);
      await check(`${mode}: no horizontal range leaves horizontal page scrolling available`, async () => {
        const state = await wheel(100, 0);
        assert.equal(state.maxX, 0);
        assert.ok(state.outerX > 0, JSON.stringify(state));
        assert.equal(state.wheels.at(-1).prevented, false);
        await run('document.querySelector("#outer").scrollTo(0, 0)');
        await sleep(100);
      });
      await check(`${mode}: no scroll range leaves page scrolling available`, async () => {
        const state = await wheel(0, 100);
        assert.equal(state.maxY, 0);
        assert.ok(state.outerY > 0, JSON.stringify(state));
        assert.equal(state.wheels.at(-1).prevented, false);
      });
    }
    for (const saved of [false, true]) {
      for (const width of [900, 360]) {
        await check(`${saved ? 'saved' : 'editor'}: full current page at ${width}px`, async () => {
          await run(`setupLayout(${width}, ${saved})`);
          const portrait = await run('geometry()');
          assert.ok(Math.abs(portrait.pageHeight - 1123) < 1);
          assert.equal(portrait.maxY, 0, JSON.stringify(portrait));
          assert.equal(portrait.outerMaxX, 0, JSON.stringify(portrait));
          assert.ok(portrait.outerMaxY > 0 && portrait.rootHeight > 1123);
          assert.ok(portrait.pageBottom <= portrait.viewBottom);
          if (width === 360) assert.ok(portrait.maxX > 0);
          await wheel(0, 100);
          assert.ok(await run('document.querySelector("#layout").scrollTop > 0'));
          await run('document.querySelector("#layout").scrollTop = 0; document.querySelector("#layout [title=下一页]").click(); editor.flush()');
          const landscape = await run('geometry()');
          assert.ok(Math.abs(landscape.pageHeight - 794) < 1);
          assert.equal(landscape.maxY, 0, JSON.stringify(landscape));
          assert.equal(landscape.outerMaxX, 0, JSON.stringify(landscape));
          assert.ok(landscape.rootHeight < portrait.rootHeight);
          assert.equal(await run('document.querySelectorAll("#layout .canvas-note-page").length'), 1);
        });
      }
    }
    for (const scale of [0.5, 2]) {
      await run(`setupZoom(${scale})`);
      await check(`zoom ${scale}: native pen coordinates and selection transforms`, async () => {
        const point = async (x, y) => run(`zoomFixture.point(${x}, ${y})`);
        const drag = async (from, to) => {
          win.webContents.sendInputEvent({ type: 'mouseMove', ...from });
          win.webContents.sendInputEvent({ type: 'mouseDown', ...from, button: 'left', clickCount: 1 });
          for (let step = 1; step <= 5; step++) {
            win.webContents.sendInputEvent({ type: 'mouseMove', x: Math.round(from.x + (to.x - from.x) * step / 5),
              y: Math.round(from.y + (to.y - from.y) * step / 5), button: 'left' });
            await sleep(20);
          }
          win.webContents.sendInputEvent({ type: 'mouseUp', ...to, button: 'left', clickCount: 1 });
          await sleep(80);
        };
        await drag(await point(50, 50), await point(100, 80));
        const pen = await run('editor.flush().then(content => content.pages[0].objects.at(-1))');
        assert.equal(pen.canvasKind, 'pen');
        assert.ok(Math.abs(pen.path[0][1] - 50) < 2 && Math.abs(pen.path[0][2] - 50) < 2, JSON.stringify(pen));
        assert.ok(Math.abs(pen.width - 50) < 2 && Math.abs(pen.height - 30) < 2, JSON.stringify(pen));
        await run('zoomFixture.tool("select")');
        await drag(await point(200, 130), await point(220, 150));
        const moved = await run('editor.flush().then(content => content.pages[0].objects[0])');
        assert.ok(Math.abs(moved.left - 180) < 2 && Math.abs(moved.top - 120) < 2, JSON.stringify(moved));
        await drag(await point(261, 181), await point(281, 201));
        const resized = await run('editor.flush().then(content => content.pages[0].objects[0])');
        assert.ok(resized.scaleX > moved.scaleX && resized.scaleY > moved.scaleY, JSON.stringify(resized));
      });
      await check(`zoom ${scale}: PDF, flow, export, pagination and no dirty`, async () => {
        const result = await run('zoomFixture.verify()');
        assert.deepEqual(result.errors, []);
        assert.equal(result.sameContent, true, JSON.stringify(result));
        assert.equal(result.changes, 0);
        assert.equal(result.samePng, true, JSON.stringify(result));
        assert.deepEqual(result.pngSize, [794, 1123]);
        assert.equal(result.pdfInk, true, JSON.stringify(result));
        assert.equal(result.maxY, 0);
        assert.ok(Math.abs(result.pageHeight - 1123 * scale) < 1);
        assert.equal(result.pageCount, 2);
        assert.equal(result.followedPage, '2 / 2');
        assert.equal(result.retainedZoom, true, JSON.stringify(result));
      });
      await check(`zoom ${scale}: native flow click and typing on page two`, async () => {
        const point = await run('zoomFixture.flowPoint()');
        win.webContents.sendInputEvent({ type: 'mouseMove', ...point });
        win.webContents.sendInputEvent({ type: 'mouseDown', ...point, button: 'left', clickCount: 1 });
        win.webContents.sendInputEvent({ type: 'mouseUp', ...point, button: 'left', clickCount: 1 });
        await win.webContents.insertText('Typed zoom ');
        await run('editor.flush()');
        await sleep(100);
        assert.equal(await run('editor.content().flow.ops.some(op => typeof op.insert === "string" && op.insert.includes("Typed zoom "))'), true);
        assert.equal(await run('document.querySelector("#layout .canvas-note-page-counter").textContent'), '2 / 2');
      });
    }
    await check('zoom: readonly, fit resize, different page widths, narrow dark and full height', async () => {
      const result = await run('zoomFixture.verifyLayout()');
      assert.deepEqual(result.errors, []);
      for (const state of result.states) {
        assert.equal(state.maxY, 0, JSON.stringify(state));
        assert.equal(state.maxX, 0, JSON.stringify(state));
        assert.equal(state.outerX, 0, JSON.stringify(state));
        assert.ok(Math.abs(state.pageWidth - state.available) < 1, JSON.stringify(state));
        assert.ok(Math.abs(state.pageHeight - state.logicalHeight * state.scale) < 1, JSON.stringify(state));
        assert.equal(state.enabled, true);
        assert.equal(state.visible, true);
      }
      assert.equal(result.sameContent, true);
      assert.equal(result.changes, 0);
      win.setSize(560, 800);
      await sleep(220);
      assert.equal(await run('zoomFixture.resizeCheck()'), true, 'Fit must follow responsive padding even at an unchanged host width');
      await run('editor.destroy()');
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

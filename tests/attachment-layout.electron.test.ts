// @vitest-environment node
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createServer } from 'vite'
import react from '@vitejs/plugin-react'
import { expect, it } from 'vitest'

it('keeps real conversation attachment actions compact at narrow widths and keyboard accessible', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'goodbuddy-attachment-layout-'))
  const server = await createServer({ configFile: false, root: resolve('.'), cacheDir: join(directory, 'vite'),
    plugins: [react(), { name: 'attachment-layout', configureServer(server) {
      server.middlewares.use('/attachment.html', async (_request, response) => {
        response.setHeader('Content-Type', 'text/html')
        response.end(await server.transformIndexHtml('/attachment.html',
          '<html><body><div id="root"></div><script type="module" src="/tests/support/attachment-layout-regression.tsx"></script></body></html>'))
      })
    } }], server: { host: '127.0.0.1', port: 0, watch: null } })
  try {
    await server.listen()
    const driver = join(directory, 'driver.cjs')
    await writeFile(driver, `
      const { app, BrowserWindow } = require('electron');
      const assert = require('node:assert/strict');
      app.commandLine.appendSwitch('force-device-scale-factor', '1');
      app.setPath('userData', ${JSON.stringify(join(directory, 'profile'))});
      app.whenReady().then(async () => {
        const win = new BrowserWindow({ show: false, width: 1000, height: 720, useContentSize: true,
          webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
        win.webContents.on('console-message', (_event, details) => console.log(details.message));
        const js = code => win.webContents.executeJavaScript(code);
        const settle = () => js('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
        const wait = async code => { for (let i = 0; i < 800; i++) {
          if (await js(code)) return; await new Promise(resolve => setTimeout(resolve, 25));
        } throw new Error('Timeout: ' + code); };
        await win.loadURL(${JSON.stringify(server.resolvedUrls!.local[0] + 'attachment.html')});
        await wait('document.querySelectorAll(".attachment-action").length === 2');
        for (const theme of ['light', 'dark']) {
          await js('document.documentElement.dataset.theme = ' + JSON.stringify(theme));
          for (const width of [1000, 720, 360]) {
            win.setContentSize(width, 720); await settle();
            const geometry = await js(
              '(() => { const card = document.querySelector(".message-attachment");' +
              'const buttons = [...card.querySelectorAll(".attachment-action")];' +
              'return { overflow: document.documentElement.scrollWidth > innerWidth,' +
              'card: card.getBoundingClientRect().toJSON(),' +
              'buttons: buttons.map(b => b.getBoundingClientRect().toJSON()),' +
              'nameClipped: card.querySelector("strong").scrollWidth > card.querySelector("strong").clientWidth }; })()');
            assert.equal(geometry.overflow, false, JSON.stringify(geometry));
            assert(geometry.card.height < 110, JSON.stringify(geometry));
            assert.equal(geometry.buttons[0].y, geometry.buttons[1].y);
            for (const button of geometry.buttons) {
              assert.equal(button.width, 32); assert.equal(button.height, 32);
              assert(button.right <= geometry.card.right && button.left >= geometry.card.left);
            }
            assert(geometry.nameClipped);
          }
        }
        win.webContents.setZoomFactor(2); win.setContentSize(720, 720); await settle();
        await wait('innerWidth === 360'); await settle();
        assert(await js('document.documentElement.scrollWidth <= innerWidth'), await js('JSON.stringify({width: innerWidth, scroll: document.documentElement.scrollWidth, overflowing: [...document.querySelectorAll("body *")].filter(e => e.getBoundingClientRect().right > innerWidth).map(e => [e.className, e.getBoundingClientRect().right])})'));
        win.focus(); win.webContents.focus();
        await js('document.querySelector(".attachment-action").focus()');
        win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Tab' });
        win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Tab' }); await settle();
        assert(await js('document.activeElement.matches(".attachment-action[aria-haspopup=menu]")'));
        assert(await js('getComputedStyle(document.activeElement, "::after").content.includes(document.activeElement.dataset.tooltip)'));
        win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Space' });
        win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Space' });
        await wait('!!document.querySelector("[role=menu]")');
        assert(await js('document.activeElement.matches("[role=menuitem]")'));
        win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
        win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' }); await settle();
        assert(await js('!document.querySelector("[role=menu]") && document.activeElement.matches(".attachment-action[aria-haspopup=menu]")'));
        console.log('Attachment layout: light/dark, 1000/720/360px, 200% zoom, 32px actions, native keyboard passed');
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
  } finally { await server.close(); await rm(directory, { recursive: true, force: true }) }
}, 90000)

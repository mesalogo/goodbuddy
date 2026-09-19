// @vitest-environment node
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createServer } from 'vite'
import react from '@vitejs/plugin-react'
import { expect, it } from 'vitest'

it('guards real canvas input and preserves titles during AI in Electron', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'goodbuddy-notes-navigation-'))
  const server = await createServer({
    configFile: false, root: resolve('.'), cacheDir: join(directory, 'vite'),
    plugins: [react(), { name: 'notes-navigation-regression', configureServer(server) {
      server.middlewares.use('/notes-regression.html', async (_request, response) => {
        response.setHeader('Content-Type', 'text/html')
        response.end(await server.transformIndexHtml('/notes-regression.html',
          '<html><body><script type="module" src="/tests/support/magic-notes-navigation-regression.tsx"></script></body></html>'))
      })
    } }],
    server: { host: '127.0.0.1', port: 0, watch: null },
    optimizeDeps: { include: ['fabric', 'quill', 'quill-delta', 'jspdf', 'react', 'react-dom/client', 'react-i18next'] },
  })
  try {
    await server.listen()
    const driver = join(directory, 'driver.cjs')
    await writeFile(driver, `
      const { app, BrowserWindow } = require('electron');
      const fs = require('node:fs');
      app.setPath('userData', ${JSON.stringify(join(directory, 'profile'))});
      app.whenReady().then(async () => {
        const win = new BrowserWindow({ show: false, width: 1400, height: 1000,
          webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
        win.webContents.on('console-message', event => console.log(event.message));
        await win.loadURL(${JSON.stringify(server.resolvedUrls!.local[0] + 'notes-regression.html')});
        for (let i = 0; i < 400; i++) {
          if (await win.webContents.executeJavaScript('typeof window.notesNavigationRegression === "function"')) break;
          await new Promise(resolve => setTimeout(resolve, 50));
        }
        const result = await win.webContents.executeJavaScript('window.notesNavigationRegression().catch(error => ({ error: error.stack, body: document.body.innerText }))');
        fs.writeFileSync(${JSON.stringify(join(directory, 'result.json'))}, JSON.stringify(result));
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
    console.info('Notes navigation Electron regression:', JSON.stringify(result))
    expect(result).toEqual({ errors: [], titlePreserved: true, continuedTitle: 'Title during AI', canvasGuarded: true, canvasPreserved: true, leaves: 1 })
  } finally {
    await server.close()
    await rm(directory, { recursive: true, force: true })
  }
}, 90000)

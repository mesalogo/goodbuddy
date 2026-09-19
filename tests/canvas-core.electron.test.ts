// @vitest-environment node
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createServer } from 'vite'
import react from '@vitejs/plugin-react'
import { expect, it } from 'vitest'
import { AssistantDatabase } from '../src/main/assistant/assistant-database'
import type { MagicNoteCanvasContent } from '../src/shared/magic-notes-contracts'

it('preserves annotations when flow removes the active page and renders scoped thumbnails', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'goodbuddy-canvas-core-'))
  const server = await createServer({
    configFile: false, root: resolve('.'), cacheDir: join(directory, 'vite'),
    plugins: [react(), { name: 'canvas-regression', configureServer(server) {
      server.middlewares.use('/canvas-regression.html', async (_request, response) => {
        response.setHeader('Content-Type', 'text/html')
        response.end(await server.transformIndexHtml('/canvas-regression.html',
          '<html><body><script type="module" src="/tests/support/canvas-core-regression.tsx"></script></body></html>'))
      })
    } }],
    server: { host: '127.0.0.1', port: 0, watch: null },
    optimizeDeps: { noDiscovery: true, include: ['fabric', 'quill', 'jspdf', 'react', 'react-dom/client', 'react-i18next'] }
  })
  try {
    await server.listen()
    const driver = join(directory, 'driver.cjs')
    await writeFile(driver, `
      const { app, BrowserWindow } = require('electron');
      const fs = require('node:fs');
      app.setPath('userData', ${JSON.stringify(join(directory, 'profile'))});
      app.whenReady().then(async () => {
        const win = new BrowserWindow({ show: false, width: 1200, height: 950,
          webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
        await win.loadURL(${JSON.stringify(server.resolvedUrls!.local[0] + 'canvas-regression.html')});
        for (let i = 0; i < 400; i++) {
          if (await win.webContents.executeJavaScript('typeof window.canvasRegression === "function"')) break;
          await new Promise(resolve => setTimeout(resolve, 50));
        }
        const result = await win.webContents.executeJavaScript('window.canvasRegression()');
        fs.writeFileSync(${JSON.stringify(join(directory, 'result.json'))}, JSON.stringify(result));
        app.exit(0);
      }).catch(error => { console.error(error); app.exit(1); });
    `)
    const env = { ...process.env }
    delete env.ELECTRON_RUN_AS_NODE
    const child = spawn(createRequire(import.meta.url)('electron'), [driver], { env, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    child.stdout.on('data', (data) => { output += data })
    child.stderr.on('data', (data) => { output += data })
    const timeout = setTimeout(() => child.kill(), 60000)
    try {
      const code = await new Promise((resolve, reject) => { child.once('exit', resolve); child.once('error', reject) })
      expect(code, output).toBe(0)
    } finally { clearTimeout(timeout) }
    const result = JSON.parse(await readFile(join(directory, 'result.json'), 'utf8'))
    expect(result.checklistAfter).toEqual(result.checklistBefore)
    expect(result.overflowErrors).toHaveLength(2)
    expect(result.selectionAfterRejection).toEqual({ index: 20000, length: 0 })
    expect(result.selectionWithRedo).toEqual({ index: 3, length: 4 })
    expect(result.acceptedLength).toBe(20000)
    expect(result.undoneLength).toBe(19995)
    expect(result.retainedRedo).toBe(true)
    expect(result.redoneLength).toBe(20000)
    const database = new AssistantDatabase(join(directory, 'assistant.sqlite'))
    try {
      database.initialize(directory)
      const content: MagicNoteCanvasContent = {
        version: 2, kind: 'paged-canvas', assets: [], flow: result.checklistBefore,
        pages: [{ id: 'page-1', width: 794, height: 1123, objects: [],
          background: { type: 'template', template: 'blank' } }]
      }
      const entry = database.createMagicNote({ title: 'Checklist preservation', content }).entries[0]!
      const todos = database.listMagicTodos()
      expect(todos).toHaveLength(1)
      database.updateMagicNoteEntry({ entryId: entry.id, expectedRevision: entry.revision,
        content: { ...content, flow: result.checklistAfter }, plainText: '' })
      expect(database.listMagicTodos()).toEqual(todos)
      database.close()
      database.initialize(directory)
      expect(database.listMagicTodos()).toEqual(todos)
      expect(database.getMagicNoteEntry(entry.id).content).toEqual({ ...content, flow: result.checklistAfter })
    } finally { database.close() }
    console.info('Canvas Electron regression:', JSON.stringify(result))
    expect(result.errors).toEqual([])
    expect(result.initialPages).toBe(2)
    expect(result.beforeShrink).toBe('2 / 2')
    expect(result.afterShrink).toBe('1 / 1')
    expect(result.savedPages).toBe(1)
    expect(result.savedObjects).toEqual(result.initialObjects)
    expect(result.reopenedObjects).toEqual(result.initialObjects)
    expect(result.visibleInkAfter).toBe(result.visibleInkBefore)
    expect(result.reopenedInk).toBe(result.visibleInkBefore)
    expect(result.visibleInkBefore).toBeGreaterThan(0)
    expect(result.flowTransform).toBe('translateX(0px)')
    expect(result.thumbnailStyles).toEqual(result.editorStyles)
    expect(result.thumbnailMatchesEditor).toBe(true)
    expect(result.imageImports).toEqual([
      { size: 2 * 1024 * 1024 + 1, imported: 1, restored: 1, errors: [] },
      { size: 20 * 1024 * 1024, imported: 1, restored: 1, errors: [] },
      { size: 20 * 1024 * 1024 + 1, imported: 0, restored: 0, errors: ['单张图片不能超过 20 MB'] }
    ])
  } finally {
    await server.close()
    await rm(directory, { recursive: true, force: true })
  }
}, 90000)

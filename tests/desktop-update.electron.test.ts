// @vitest-environment node
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { createServer as createHttpServer } from 'node:http'
import { build } from 'esbuild'
import { createServer } from 'vite'
import react from '@vitejs/plugin-react'
import { expect, it } from 'vitest'

it('downloads through the real Electron settings, preload, IPC and worker', async () => {
  await mkdir(resolve('temp'), { recursive: true })
  const directory = await mkdtemp(resolve('temp/desktop-update-electron-'))
  const bytes = Buffer.alloc(512 * 1024, 65)
  const http = createHttpServer((_request, response) => {
    response.writeHead(200, { 'Content-Length': bytes.length })
    let offset = 0
    const timer = setInterval(() => {
      response.write(bytes.subarray(offset, offset + 8192))
      offset += 8192
      if (offset >= bytes.length) { clearInterval(timer); response.end() }
    }, 10)
    response.once('close', () => clearInterval(timer))
  })
  await new Promise<void>(done => http.listen(0, '127.0.0.1', done))
  const downloadUrl = `http://127.0.0.1:${(http.address() as { port: number }).port}/package`
  const server = await createServer({ configFile: false, root: resolve('.'), cacheDir: join(directory, 'vite'),
    optimizeDeps: { entries: ['tests/support/desktop-update-renderer.tsx'] }, plugins: [react(), {
      name: 'desktop-update-test', configureServer(server) {
        server.middlewares.use('/update.html', async (_request, response) => {
          response.setHeader('Content-Type', 'text/html')
          response.end(await server.transformIndexHtml('/update.html', '<html><body><div id="root"></div><script type="module" src="/tests/support/desktop-update-renderer.tsx"></script></body></html>'))
        })
      }
    }], server: { host: '127.0.0.1', port: 0, watch: null } })
  try {
    await Promise.all([
      build({ entryPoints: ['tests/support/desktop-update-main.ts'], outfile: join(directory, 'main.cjs'), bundle: true, platform: 'node', format: 'cjs', external: ['electron'] }),
      build({ entryPoints: ['src/preload/index.ts'], outfile: join(directory, 'preload.cjs'), bundle: true, platform: 'node', format: 'cjs', external: ['electron'] }),
      // Only the release host is redirected in this fixture; production transport/stream/hash code is bundled unchanged.
      build({ entryPoints: ['src/main/desktop-update-worker.ts'], outfile: join(directory, 'worker.cjs'), bundle: true, platform: 'node', format: 'cjs',
        banner: { js: `const originalFetch = globalThis.fetch; globalThis.fetch = (url, options) => { if (!String(url).startsWith('https://github.com/mesalogo/goodbuddy/releases/download/')) throw new Error('Unexpected test URL'); return originalFetch(${JSON.stringify(downloadUrl)}, options); };` } })
    ])
    await server.listen()
    const env: NodeJS.ProcessEnv = { ...process.env, GB_UPDATE_DIRECTORY: directory, GB_UPDATE_RENDERER: server.resolvedUrls!.local[0] + 'update.html' }
    delete env.ELECTRON_RUN_AS_NODE
    const child = spawn(createRequire(import.meta.url)('electron'), [...(process.getuid?.() === 0 ? ['--no-sandbox'] : []), join(directory, 'main.cjs')], { env, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    child.stdout.on('data', chunk => { output += chunk })
    child.stderr.on('data', chunk => { output += chunk })
    const timer = setTimeout(() => child.kill(), 55_000)
    try {
      const code = await new Promise((done, reject) => { child.once('exit', done); child.once('error', reject) })
      expect(code, output).toBe(0)
      expect(output).toContain('DESKTOP_UPDATE_ELECTRON_OK')
    } finally { clearTimeout(timer) }
  } finally {
    await server.close()
    http.closeAllConnections()
    await new Promise<void>(done => http.close(() => done()))
    await rm(directory, { recursive: true, force: true })
  }
}, 60_000)

// @vitest-environment node
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createServer as createHttpServer } from 'node:http'
import { build } from 'esbuild'
import { createServer } from 'vite'
import react from '@vitejs/plugin-react'
import { expect, it } from 'vitest'

it.skipIf(!process.env.GOODBUDDY_SHARING_SERVER_ROOT)('uses the real ShareServer through Electron preload and trusted Main IPC', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'goodbuddy-sharing-electron-'))
  const portProbe = createHttpServer()
  await new Promise<void>(resolve => portProbe.listen(0, '127.0.0.1', resolve))
  const port = (portProbe.address() as { port: number }).port
  await new Promise<void>(resolve => portProbe.close(() => resolve()))
  const backend = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], {
    cwd: process.env.GOODBUDDY_SHARING_SERVER_ROOT,
    env: { ...process.env, SHARESERVER_PORT: String(port), SHARESERVER_DATA_DIR: join(directory, 'server-data') },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  let backendOutput = ''
  backend.stdout.on('data', data => { backendOutput += data })
  backend.stderr.on('data', data => { backendOutput += data })
  const server = await createServer({ configFile: false, root: resolve('.'), cacheDir: join(directory, 'vite'),
    plugins: [react(), { name: 'sharing-smoke', configureServer(server) {
      server.middlewares.use('/sharing.html', async (_request, response) => {
        response.setHeader('Content-Type', 'text/html')
        response.end(await server.transformIndexHtml('/sharing.html', '<html><body><div id="root"></div><script type="module" src="/tests/support/device-sharing-renderer.tsx"></script></body></html>'))
      })
    } }], server: { host: '127.0.0.1', port: 0, watch: null } })
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(backendOutput || 'ShareServer startup timed out')), 15000)
      backend.once('error', reject)
      backend.once('exit', code => { clearTimeout(timer); reject(new Error(`ShareServer exit ${code}: ${backendOutput}`)) })
      backend.stdout.on('data', () => { if (backendOutput.includes('listening on')) { clearTimeout(timer); resolve() } })
    })
    await build({ entryPoints: ['tests/support/device-sharing-main.ts'], outfile: join(directory, 'main.cjs'), bundle: true, platform: 'node', format: 'cjs', external: ['electron'] })
    await build({ entryPoints: ['src/preload/index.ts'], outfile: join(directory, 'preload.cjs'), bundle: true, platform: 'node', format: 'cjs', external: ['electron'] })
    await server.listen()
    const env: NodeJS.ProcessEnv = { ...process.env, GB_SHARING_DIRECTORY: directory, GB_SHARING_URL: `http://127.0.0.1:${port}`,
      GB_SHARING_RENDERER: server.resolvedUrls!.local[0] + 'sharing.html' }
    delete env.ELECTRON_RUN_AS_NODE
    const child = spawn(createRequire(import.meta.url)('electron'), [join(directory, 'main.cjs')], { env, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    child.stdout.on('data', data => { output += data })
    child.stderr.on('data', data => { output += data })
    const timer = setTimeout(() => child.kill(), 60000)
    try {
      expect(await new Promise((resolve, reject) => { child.once('exit', resolve); child.once('error', reject) }), output).toBe(0)
      process.stdout.write(output)
    } finally { clearTimeout(timer) }
  } finally {
    const stopped = new Promise(resolve => backend.once('exit', resolve))
    if (backend.exitCode === null) { backend.kill(); await stopped }
    await server.close()
    await rm(directory, { recursive: true, force: true })
  }
}, 90000)

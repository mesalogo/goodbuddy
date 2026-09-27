// @vitest-environment node
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { copyFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createServer } from 'vite'
import react from '@vitejs/plugin-react'
import { expect, it } from 'vitest'

it('preserves shared control states in real Chromium across themes and containers', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'goodbuddy-shared-controls-'))
  const server = await createServer({
    configFile: false, root: resolve('.'), cacheDir: join(directory, 'vite'),
    plugins: [react(), { name: 'shared-controls', configureServer(server) {
      server.middlewares.use('/controls.html', async (_request, response) => {
        response.setHeader('Content-Type', 'text/html')
        response.end(await server.transformIndexHtml('/controls.html',
          '<html><body><div id="root"></div><script type="module" src="/tests/support/shared-controls-regression.tsx"></script></body></html>'))
      })
    } }],
    optimizeDeps: { entries: ['tests/support/shared-controls-regression.tsx'] },
    server: { host: '127.0.0.1', port: 0, watch: null }
  })
  try {
    await server.listen()
    const driver = join(directory, 'driver.mjs')
    await copyFile(resolve('tests/support/shared-controls-driver.mjs'), driver)
    const env: NodeJS.ProcessEnv = { ...process.env, GB_CONTROLS_DIRECTORY: directory,
      GB_CONTROLS_URL: server.resolvedUrls!.local[0] + 'controls.html' }
    delete env.ELECTRON_RUN_AS_NODE
    const child = spawn(createRequire(import.meta.url)('electron'), [driver], { env, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    child.stdout.on('data', data => { output += data })
    child.stderr.on('data', data => { output += data })
    const timeout = setTimeout(() => child.kill(), 90000)
    try {
      expect(await new Promise((resolve, reject) => {
        child.once('exit', resolve)
        child.once('error', reject)
      }), output).toBe(0)
      process.stdout.write(output)
    } finally { clearTimeout(timeout) }
  } finally {
    await server.close()
    await rm(directory, { recursive: true, force: true })
  }
}, 120000)

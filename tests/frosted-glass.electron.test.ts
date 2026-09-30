// @vitest-environment node
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { copyFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createServer } from 'vite'
import react from '@vitejs/plugin-react'
import { expect, it } from 'vitest'

it('scrolls real chat messages behind frosted glass while preserving controls, anchors and other routes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'goodbuddy-frosted-glass-'))
  const server = await createServer({
    configFile: false, root: resolve('.'), cacheDir: join(directory, 'vite'),
    plugins: [react(), { name: 'frosted-glass', configureServer(server) {
      server.middlewares.use('/glass.html', async (_request, response) => {
        response.setHeader('Content-Type', 'text/html')
        response.end(await server.transformIndexHtml('/glass.html', `<!doctype html>
          <html><body><div id="root"></div>
          <script type="module" src="/tests/support/frosted-glass-regression.tsx"></script></body></html>`))
      })
    } }],
    optimizeDeps: { entries: ['tests/support/frosted-glass-regression.tsx'] },
    server: { host: '127.0.0.1', port: 0, watch: null }
  })
  try {
    await server.listen()
    const driver = join(directory, 'driver.mjs')
    await copyFile(resolve('tests/support/frosted-glass-driver.mjs'), driver)
    const env: NodeJS.ProcessEnv = { ...process.env, GB_GLASS_DIRECTORY: directory,
      GB_GLASS_URL: server.resolvedUrls!.local[0] + 'glass.html' }
    delete env.ELECTRON_RUN_AS_NODE
    const child = spawn(createRequire(import.meta.url)('electron'), [driver], { env, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    child.stdout.on('data', data => { output += data })
    child.stderr.on('data', data => { output += data })
    const timeout = setTimeout(() => child.kill(), 60000)
    try {
      const code = await new Promise((resolve, reject) => { child.once('exit', resolve); child.once('error', reject) })
      expect(code, output).toBe(0)
      process.stdout.write(output.split(/\r?\n/).filter(line => line.startsWith('FrostedGlass')).join('\n') + '\n')
    } finally { clearTimeout(timeout) }
  } finally {
    await server.close()
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }
}, 90000)

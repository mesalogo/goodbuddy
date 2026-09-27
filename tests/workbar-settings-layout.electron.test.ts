// @vitest-environment node
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { copyFile, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createServer } from 'vite'
import react from '@vitejs/plugin-react'
import { expect, it } from 'vitest'

it('keeps workbar add reachable and model protocols readable at narrow container widths', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'goodbuddy-responsive-controls-'))
  const server = await createServer({
    configFile: false, root: resolve('.'), cacheDir: join(directory, 'vite'),
    plugins: [react(), { name: 'responsive-controls', configureServer(server) {
      server.middlewares.use('/responsive.html', async (_request, response) => {
        response.setHeader('Content-Type', 'text/html')
        response.end(await server.transformIndexHtml('/responsive.html',
          '<html><body><div id="root"></div><script type="module" src="/tests/support/workbar-settings-layout.tsx"></script></body></html>'))
      })
    } }],
    optimizeDeps: { entries: ['tests/support/workbar-settings-layout.tsx'] },
    server: { host: '127.0.0.1', port: 0, watch: null }
  })
  try {
    await server.listen()
    const driver = join(directory, 'driver.mjs')
    await copyFile(resolve('tests/support/workbar-settings-layout-driver.mjs'), driver)
    const env: NodeJS.ProcessEnv = { ...process.env, GB_LAYOUT_DIRECTORY: directory,
      GB_LAYOUT_URL: server.resolvedUrls!.local[0] + 'responsive.html' }
    delete env.ELECTRON_RUN_AS_NODE
    const child = spawn(createRequire(import.meta.url)('electron'), [driver], { env, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    child.stdout.on('data', data => { output += data })
    child.stderr.on('data', data => { output += data })
    const timeout = setTimeout(() => child.kill(), 90000)
    try {
      const code = await new Promise((resolve, reject) => { child.once('exit', resolve); child.once('error', reject) })
      const result = await readFile(join(directory, 'result.json'), 'utf8').catch(() => output)
      expect(code, result).toBe(0)
      const parsed = JSON.parse(result)
      expect(parsed.passed).toBe(true)
      process.stdout.write(`Responsive controls: ${parsed.observations.length} observations; Chinese/English, light/dark, native mouse and keyboard; model calls: 0\n`)
    } finally { clearTimeout(timeout) }
  } finally {
    await server.close()
    await rm(directory, { recursive: true, force: true })
  }
}, 120000)

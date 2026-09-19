// @vitest-environment node
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { copyFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createServer } from 'vite'
import react from '@vitejs/plugin-react'
import { expect, it } from 'vitest'

it('keeps inline help usable in real modals with mouse, keyboard and narrow windows', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'goodbuddy-inline-help-'))
  const server = await createServer({ configFile: false, root: resolve('.'), cacheDir: join(directory, 'vite'),
    plugins: [react(), { name: 'inline-help', configureServer(server) {
      server.middlewares.use('/inline-help.html', async (_request, response) => {
        response.setHeader('Content-Type', 'text/html')
        response.end(await server.transformIndexHtml('/inline-help.html',
          '<html><body><div id="root"></div><script type="module" src="/tests/support/inline-help-regression.tsx"></script></body></html>'))
      })
    } }], server: { host: '127.0.0.1', port: 0, watch: null } })
  try {
    await server.listen()
    const env: NodeJS.ProcessEnv = { ...process.env, GOODBUDDY_HELP_URL: server.resolvedUrls!.local[0] + 'inline-help.html',
      GOODBUDDY_HELP_DIRECTORY: directory }
    delete env.ELECTRON_RUN_AS_NODE
    const driver = join(directory, 'driver.mjs')
    await copyFile(resolve('tests/support/inline-help-driver.mjs'), driver)
    const child = spawn(createRequire(import.meta.url)('electron'), [driver], { env, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    child.stdout.on('data', data => { output += data })
    child.stderr.on('data', data => { output += data })
    const timeout = setTimeout(() => child.kill(), 60000)
    try {
      const code = await new Promise((resolve, reject) => { child.once('exit', resolve); child.once('error', reject) })
      expect(code, output).toBe(0)
      process.stdout.write(output.split(/\r?\n/).filter(line => line.startsWith('InlineHelp')).join('\n') + '\n')
    } finally { clearTimeout(timeout) }
  } finally { await server.close(); await rm(directory, { recursive: true, force: true }) }
}, 90000)

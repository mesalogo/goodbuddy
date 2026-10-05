// @vitest-environment node
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { copyFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { createServer } from 'vite'
import react from '@vitejs/plugin-react'
import { expect, it } from 'vitest'

it('preserves virtualized disclosures with native Electron input and bounded large-history DOM', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'goodbuddy-expansion-'))
  const require = createRequire(import.meta.url)
  const source = process.env.GB_HISTORY_SOURCE
  const denseSource = process.env.GB_EXPANSION_DENSE_SOURCE
  const server = await createServer({
    configFile: false, root: resolve('.'), cacheDir: join(directory, 'vite'),
    resolve: { dedupe: Object.keys({ ...require('../package.json').dependencies, ...require('../package.json').devDependencies }) },
    plugins: [react(), { name: 'message-expansion-fixture', enforce: 'pre',
      resolveId(id, importer) {
        if (denseSource && id.endsWith('/message-expansion')) return this.resolve(denseSource, importer, { skipSelf: true })
        if (source && importer?.endsWith('/tests/support/message-expansion-regression.tsx') && id.startsWith('../../src/')) {
          return this.resolve(resolve(source, id.slice(6)), importer, { skipSelf: true })
        }
      },
      configureServer(server) {
        server.middlewares.use('/expansion.html', async (_request, response) => {
          response.setHeader('Content-Type', 'text/html')
          response.end(await server.transformIndexHtml('/expansion.html', '<!doctype html><html><body><div id="root"></div><script type="module" src="/tests/support/message-expansion-regression.tsx"></script></body></html>'))
        })
      }
    }],
    server: { host: '127.0.0.1', port: 0, watch: null, fs: { allow: [resolve('.'), ...(source ? [source] : []), ...(denseSource ? [dirname(denseSource)] : [])] } }
  })
  try {
    await server.listen()
    const driver = join(directory, 'driver.mjs')
    await copyFile(resolve('tests/support/message-expansion-driver.mjs'), driver)
    const env: NodeJS.ProcessEnv = { ...process.env, GB_EXPANSION_DIRECTORY: directory,
      GB_EXPANSION_URL: server.resolvedUrls!.local[0] + 'expansion.html' }
    delete env.ELECTRON_RUN_AS_NODE
    const child = spawn(require('electron'), [driver], { env, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    child.stdout.on('data', data => { output += data })
    child.stderr.on('data', data => { output += data })
    const timer = setTimeout(() => child.kill(), 90000)
    try {
      const code = await new Promise((resolve, reject) => { child.once('exit', resolve); child.once('error', reject) })
      process.stdout.write(output.split(/\r?\n/).filter(line => line.startsWith('MessageExpansion')).join('\n') + '\n')
      expect(code, output).toBe(0)
    } finally { clearTimeout(timer) }
  } finally {
    await server.close()
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }
}, 120000)

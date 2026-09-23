// @vitest-environment node
import { spawn } from 'node:child_process'
import { copyFile, mkdtemp, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import react from '@vitejs/plugin-react'
import { createServer } from 'vite'
import { expect, it } from 'vitest'

it('keeps real Mermaid modal edges reachable and downloads complete PNGs', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'goodbuddy-mermaid-'))
  const server = await createServer({
    configFile: false,
    root: resolve('.'),
    cacheDir: join(directory, 'vite'),
    plugins: [react(), {
      name: 'mermaid-regression',
      configureServer(server) {
        server.middlewares.use('/mermaid.html', async (_request, response) => {
          response.setHeader('Content-Type', 'text/html; charset=utf-8')
          response.end(await server.transformIndexHtml('/mermaid.html',
            '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="root"></div><script type="module" src="/tests/support/mermaid-viewer-regression.tsx"></script></body></html>'))
        })
      }
    }],
    server: { host: '127.0.0.1', port: 0, watch: null }
  })
  try {
    await server.listen()
    const env: NodeJS.ProcessEnv = { ...process.env,
      GOODBUDDY_MERMAID_URL: server.resolvedUrls!.local[0] + 'mermaid.html',
      GOODBUDDY_MERMAID_DIRECTORY: directory }
    delete env.ELECTRON_RUN_AS_NODE
    const driver = join(directory, 'driver.mjs')
    await copyFile(resolve('tests/support/mermaid-viewer-driver.mjs'), driver)
    const child = spawn(createRequire(import.meta.url)('electron'), [driver], {
      env, stdio: ['ignore', 'pipe', 'pipe']
    })
    let output = ''
    child.stdout.on('data', data => { output += data })
    child.stderr.on('data', data => { output += data })
    const timeout = setTimeout(() => child.kill(), 240_000)
    try {
      const code = await new Promise((resolve, reject) => {
        child.once('exit', resolve)
        child.once('error', reject)
      })
      expect(code, output).toBe(0)
      process.stdout.write(output.split(/\r?\n/u).filter(line => line.startsWith('Mermaid')).join('\n') + '\n')
    } finally {
      clearTimeout(timeout)
      if (child.exitCode === null) child.kill()
    }
  } finally {
    await server.close()
    await rm(directory, { recursive: true, force: true })
  }
}, 270_000)

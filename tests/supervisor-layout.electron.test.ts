// @vitest-environment node
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { copyFile, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createServer } from 'vite'
import react from '@vitejs/plugin-react'
import { expect, it } from 'vitest'

it('renders the production supervisor at desktop, narrow, and mobile widths', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'goodbuddy-supervisor-'))
  const css = await readFile(
    'src/renderer/src/supervisor-workspace.css',
    'utf8'
  )
  const server = await createServer({
    configFile: false,
    root: resolve('.'),
    cacheDir: join(directory, 'vite'),
    plugins: [
      react(),
      {
        name: 'supervisor-fixture',
        configureServer(server) {
          server.middlewares.use(
            '/supervisor.html',
            async (_request, response) => {
              response.setHeader('Content-Type', 'text/html; charset=utf-8')
              response.end(
                await server.transformIndexHtml(
                  '/supervisor.html',
                  '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>SIMULATED Supervisor validation</title><body><div id="root"></div><script type="module" src="/tests/support/supervisor-layout-regression.tsx"></script></body></html>'
                )
              )
            }
          )
        }
      }
    ],
    server: { host: '127.0.0.1', port: 0, watch: null }
  })
  try {
    await server.listen()
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      GOODBUDDY_SUPERVISOR_URL:
        server.resolvedUrls!.local[0] + 'supervisor.html',
      GOODBUDDY_SUPERVISOR_DIRECTORY: directory,
      GOODBUDDY_SUPERVISOR_TOKENS: JSON.stringify([
        ...new Set(
          [...css.matchAll(/var\((--[\w-]+)\)/g)].map((match) => match[1])
        )
      ])
    }
    delete env.ELECTRON_RUN_AS_NODE
    const driver = join(directory, 'driver.mjs')
    await copyFile(
      resolve('tests/support/supervisor-layout-driver.mjs'),
      driver
    )
    const child = spawn(createRequire(import.meta.url)('electron'), [driver], {
      env,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let output = ''
    child.stdout.on('data', (data) => {
      output += data
    })
    child.stderr.on('data', (data) => {
      output += data
    })
    const timeout = setTimeout(() => child.kill(), 90000)
    try {
      const code = await new Promise((resolve, reject) => {
        child.once('exit', resolve)
        child.once('error', reject)
      })
      expect(code, output).toBe(0)
      console.log(output)
    } finally {
      clearTimeout(timeout)
    }
  } finally {
    await server.close()
    await rm(directory, { recursive: true, force: true })
  }
}, 120000)

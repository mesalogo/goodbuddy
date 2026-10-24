// @vitest-environment node
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { build } from 'esbuild'
import { createServer } from 'vite'
import react from '@vitejs/plugin-react'
import { expect, it } from 'vitest'

it('runs HTML interactions and network resources under the production application CSP', async () => {
  const temp = resolve('temp')
  await mkdir(temp, { recursive: true })
  const directory = await mkdtemp(join(temp, 'html-preview-'))
  const index = await readFile(resolve('src/renderer/index.html'), 'utf8')
  const server = await createServer({ configFile: false, root: resolve('.'), cacheDir: join(directory, 'vite'),
    plugins: [react(), { name: 'html-preview-test', configureServer(server) {
      server.middlewares.use(async (request, response, next) => {
        response.setHeader('Access-Control-Allow-Origin', '*')
        const path = request.url?.split('?')[0]
        if (path === '/preview.html') {
          response.setHeader('Content-Type', 'text/html')
          response.end(await server.transformIndexHtml('/preview.html', index.replace('/src/main.tsx', '/tests/support/html-preview-renderer.tsx')))
        } else if (path === '/script.js') {
          response.setHeader('Content-Type', 'text/javascript')
          response.end('document.body.dataset.external="yes"')
        } else if (path === '/style.css') {
          response.setHeader('Content-Type', 'text/css')
          response.end('body { color: rgb(1, 2, 3) }')
        } else if (path === '/image.svg') {
          response.setHeader('Content-Type', 'image/svg+xml')
          response.end('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>')
        } else if (path === '/api') response.end('connected')
        else next()
      })
    } }], server: { host: '127.0.0.1', port: 0, watch: null } })
  try {
    await server.listen()
    const origin = server.resolvedUrls!.local[0]!.replace(/\/$/u, '')
    const driver = join(directory, 'driver.cjs')
    await build({ entryPoints: ['tests/support/html-preview-main.ts'], outfile: driver, bundle: true, platform: 'node', format: 'cjs', external: ['electron'] })
    const env: NodeJS.ProcessEnv = { ...process.env, GB_HTML_URL: `${origin}/preview.html?origin=${encodeURIComponent(origin)}`, GB_HTML_DIRECTORY: join(directory, 'profile') }
    delete env.ELECTRON_RUN_AS_NODE
    const child = spawn(createRequire(import.meta.url)('electron'), [driver], { env, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    child.stdout.on('data', data => { output += data })
    child.stderr.on('data', data => { output += data })
    const timeout = setTimeout(() => child.kill(), 45000)
    try {
      expect(await new Promise((resolve, reject) => { child.once('exit', resolve); child.once('error', reject) }), output).toBe(0)
    } finally { clearTimeout(timeout) }
  } finally { await server.close(); await rm(directory, { recursive: true, force: true }) }
}, 60000)

// Local, simulated fixture only. Run: node tests/support/supervisor-preview.mjs
import { createServer } from 'vite'
import react from '@vitejs/plugin-react'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import process from 'node:process'
import console from 'node:console'

const cacheDir = await mkdtemp(join(tmpdir(), 'goodbuddy-supervisor-preview-'))
const server = await createServer({
  configFile: false,
  root: resolve('.'),
  cacheDir,
  plugins: [react(), {
    name: 'supervisor-preview',
    configureServer(server) {
      server.middlewares.use('/supervisor.html', async (_request, response) => {
        response.setHeader('Content-Type', 'text/html; charset=utf-8')
        response.end(await server.transformIndexHtml('/supervisor.html',
          '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>SIMULATED Supervisor validation</title><body><div id="root"></div><script type="module" src="/tests/support/supervisor-layout-regression.tsx"></script></body></html>'))
      })
    }
  }],
  server: { host: '127.0.0.1', port: 4179, strictPort: true }
})
await server.listen()
console.log(`${server.resolvedUrls.local[0]}supervisor.html`)
console.log('Fixed simulated data. Scenarios: ?story=1, ?story=2, ?long=1, ?dense=1, ?state=loading, ?state=error, ?state=empty')
const close = async () => {
  await server.close()
  await rm(cacheDir, { recursive: true, force: true })
  process.exit(0)
}
process.on('SIGINT', close)
process.on('SIGTERM', close)

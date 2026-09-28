// @vitest-environment node
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { createServer } from 'vite'
import react from '@vitejs/plugin-react'
import { expect, it } from 'vitest'

it('compacts direct model context from App through preload, IPC, HTTP and SQLite', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'goodbuddy-compaction-'))
  const server = await createServer({ configFile: false, root: resolve('.'), cacheDir: join(directory, 'vite'),
    plugins: [react(), { name: 'compaction', configureServer(server) {
      server.middlewares.use('/compact.html', async (_request, response) => {
        response.setHeader('Content-Type', 'text/html')
        response.end(await server.transformIndexHtml('/compact.html', '<html><body><div id="root"></div><script type="module" src="/tests/support/magic-notes-capture-renderer.tsx"></script></body></html>'))
      })
    } }], server: { host: '127.0.0.1', port: 0, watch: null },
    optimizeDeps: { entries: ['tests/support/magic-notes-capture-renderer.tsx'], include: ['fabric', 'quill', 'quill/blots/block', 'quill-delta', 'jspdf', 'pdfjs-dist', 'react', 'react-dom/client', 'react-i18next'] }
  })
  try {
    const driver = join(directory, 'main.mjs')
    await build({ entryPoints: ['tests/support/manual-compaction-main.ts'], outfile: driver,
      bundle: true, platform: 'node', format: 'esm', external: ['electron'], plugins: [
        { name: 'external-packages', setup(builder) {
          builder.onResolve({ filter: /^[^./]/ }, async args => {
            if (args.pluginData?.resolved || /^[A-Za-z]:/.test(args.path) || args.path.startsWith('node:') || args.path === 'electron') return
            const result = await builder.resolve(args.path, { resolveDir: resolve('.'), kind: 'import-statement', pluginData: { resolved: true } })
            return result.errors.length ? { errors: result.errors } : { path: result.external ? result.path : pathToFileURL(result.path).href, external: true }
          })
        } }
      ] })
    await build({ entryPoints: ['src/preload/index.ts'], outfile: join(directory, 'preload.cjs'), bundle: true, platform: 'node', format: 'cjs', external: ['electron'] })
    await build({ entryPoints: ['src/main/execution-stats-worker.ts'], outfile: join(directory, 'out/main/execution-stats-worker.js'), bundle: true, platform: 'node', format: 'cjs' })
    await server.listen()
    const bootstrap = join(directory, 'bootstrap.cjs')
    await writeFile(bootstrap, `import(${JSON.stringify(pathToFileURL(driver).href)}).catch(error => { console.error(error); require('electron').app.exit(1) })`)
    const env: NodeJS.ProcessEnv = { ...process.env, GB_COMPACT_DIRECTORY: directory, GB_COMPACT_URL: server.resolvedUrls!.local[0] + 'compact.html' }
    delete env.ELECTRON_RUN_AS_NODE
    const child = spawn(createRequire(import.meta.url)('electron'), [bootstrap], { env, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    child.stdout.on('data', data => { output += data })
    child.stderr.on('data', data => { output += data })
    const timeout = setTimeout(() => child.kill(), 100000)
    try {
      const code = await new Promise((resolve, reject) => { child.once('exit', resolve); child.once('error', reject) })
      expect(code, output).toBe(0)
      expect(output).toContain('"summaryRestored":true')
      process.stdout.write(output)
    } finally { clearTimeout(timeout) }
  } finally {
    await server.close()
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }
}, 120000)

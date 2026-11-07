// @vitest-environment node
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { createServer } from 'vite'
import react from '@vitejs/plugin-react'
import { expect, it } from 'vitest'

it('selects a local @ document in App and reads it through preload, storage and model tools', async () => {
  const parent = resolve('temp/local-knowledge-reference')
  await mkdir(parent, { recursive: true })
  const directory = await mkdtemp(join(parent, 'run-'))
  const renderer = 'tests/support/magic-notes-capture-renderer.tsx'
  const server = await createServer({ configFile: false, root: resolve('.'), cacheDir: join(directory, 'vite'),
    plugins: [react(), { name: 'local-reference', configureServer(server) {
      server.middlewares.use('/reference.html', async (_request, response) => {
        response.setHeader('Content-Type', 'text/html')
        response.end(await server.transformIndexHtml('/reference.html', `<html><body><div id="root"></div><script type="module" src="/${renderer}"></script></body></html>`))
      })
    } }], server: { host: '127.0.0.1', port: 0, watch: null },
    optimizeDeps: { entries: [renderer], include: ['fabric', 'quill', 'quill/blots/block', 'quill-delta', 'jspdf', 'pdfjs-dist', 'react', 'react-dom/client', 'react-i18next'] }
  })
  try {
    for (const [entry, name] of [
      ['tests/support/local-knowledge-reference-main.ts', 'main.mjs'],
      ['src/main/desktop-storage-entry.ts', 'desktop-storage-entry.mjs'],
      ['src/main/readonly-query-worker.ts', 'readonly-query-worker.mjs'],
      ['src/main/assistant-storage-worker.ts', 'assistant-storage-worker.mjs'],
      ['src/main/document-parse-worker.ts', 'document-parse-worker.mjs']
    ]) await build({ entryPoints: [entry!], outfile: join(directory, name!), bundle: true, platform: 'node', format: 'esm', external: ['electron'], plugins: [
      { name: 'external-packages', setup(builder) {
        builder.onResolve({ filter: /^[^./]/ }, async args => {
          if (args.pluginData?.resolved || /^[A-Za-z]:/.test(args.path) || args.path.startsWith('node:') || args.path === 'electron') return
          const result = await builder.resolve(args.path, { resolveDir: resolve('.'), kind: 'import-statement', pluginData: { resolved: true } })
          return result.errors.length ? { errors: result.errors } : { path: result.external ? result.path : pathToFileURL(result.path).href, external: true }
        })
      } }
    ] })
    await build({ entryPoints: ['src/preload/index.ts'], outfile: join(directory, 'preload.cjs'), bundle: true, platform: 'node', format: 'cjs', external: ['electron'] })
    await server.listen()
    const bootstrap = join(directory, 'bootstrap.cjs')
    await writeFile(bootstrap, `import(${JSON.stringify(pathToFileURL(join(directory, 'main.mjs')).href)}).catch(error => { console.error(error); require('electron').app.exit(1) })`)
    const env: NodeJS.ProcessEnv = { ...process.env, GB_REFERENCE_DIRECTORY: directory, GB_REFERENCE_URL: server.resolvedUrls!.local[0] + 'reference.html' }
    delete env.ELECTRON_RUN_AS_NODE
    const child = spawn(createRequire(import.meta.url)('electron'), [bootstrap], { env, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = '', timedOut = false
    child.stdout.on('data', data => { output += data })
    child.stderr.on('data', data => { output += data })
    const timer = setTimeout(() => { timedOut = true; child.kill() }, 100000)
    try {
      const code = await new Promise((resolve, reject) => { child.once('close', resolve); child.once('error', reject) })
      expect(timedOut, output).toBe(false)
      expect(code, output).toBe(0)
      expect(output).toContain('"localReferencePassed":true')
      process.stdout.write(output)
    } finally { clearTimeout(timer) }
  } finally {
    await server.close()
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }
}, 120000)

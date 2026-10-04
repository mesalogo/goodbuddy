// @vitest-environment node
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { createServer } from 'vite'
import react from '@vitejs/plugin-react'
import { expect, it } from 'vitest'

it('imports from App through production preload and IPC without copying conversation images into the project', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'goodbuddy-workspace-import-app-'))
  const server = await createServer({ configFile: false, root: resolve('.'), cacheDir: join(directory, 'vite'),
    plugins: [react(), { name: 'workspace-import', configureServer(server) {
      server.middlewares.use('/import.html', async (_request, response) => {
        response.setHeader('Content-Type', 'text/html')
        response.end(await server.transformIndexHtml('/import.html', '<html><body><div id="root"></div><script type="module" src="/tests/support/magic-notes-capture-renderer.tsx"></script></body></html>'))
      })
    } }], server: { host: '127.0.0.1', port: 0, watch: null },
    optimizeDeps: { entries: ['tests/support/magic-notes-capture-renderer.tsx'], include: ['fabric', 'quill', 'quill/blots/block', 'quill-delta', 'jspdf', 'pdfjs-dist', 'react', 'react-dom/client', 'react-i18next'] }
  })
  try {
    const driver = join(directory, 'main.mjs')
    await build({ entryPoints: ['tests/support/workspace-import-main.ts'], outfile: driver, bundle: true, platform: 'node', format: 'esm', external: ['electron'], plugins: [
      { name: 'isolated-external-services', setup(build) {
        build.onResolve({ filter: /channels\/channel-env$/ }, () => ({ path: 'channels', namespace: 'import-test' }))
        build.onResolve({ filter: /agent\/create-runtime$/ }, () => ({ path: 'runtime', namespace: 'import-test' }))
        build.onLoad({ filter: /.*/, namespace: 'import-test' }, ({ path }) => ({ contents: path === 'channels' ? 'export const startEnvironmentChannels=()=>[];' : 'export const createDefaultModelRuntime=()=>{throw new Error("Model calls forbidden")}; export const createModelProfileRuntime=createDefaultModelRuntime;' }))
      } },
      { name: 'external-packages', setup(build) {
        build.onResolve({ filter: /^[^./]/ }, async args => {
          if (args.pluginData?.resolved || /^[A-Za-z]:/.test(args.path) || args.path.startsWith('node:') || args.path === 'electron') return
          const result = await build.resolve(args.path, { resolveDir: resolve('.'), kind: 'import-statement', pluginData: { resolved: true } })
          return result.errors.length ? { errors: result.errors } : { path: result.external ? result.path : pathToFileURL(result.path).href, external: true }
        })
      } }
    ] })
    await build({ entryPoints: ['src/preload/index.ts'], outfile: join(directory, 'preload.cjs'), bundle: true, platform: 'node', format: 'cjs', external: ['electron'] })
    await server.listen()
    const bootstrap = join(directory, 'bootstrap.cjs')
    await writeFile(bootstrap, `import(${JSON.stringify(pathToFileURL(driver).href)}).catch(error=>{console.error(error);require('electron').app.exit(1)})`)
    const env = { ...process.env, GB_IMPORT_DIRECTORY: directory, GB_IMPORT_URL: server.resolvedUrls!.local[0] + 'import.html' }
    delete (env as NodeJS.ProcessEnv).ELECTRON_RUN_AS_NODE
    const child = spawn(createRequire(import.meta.url)('electron'), [bootstrap], { env, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    child.stdout.on('data', data => { output += data }); child.stderr.on('data', data => { output += data })
    const timeout = setTimeout(() => child.kill(), 90000)
    try { expect(await new Promise((resolve, reject) => { child.once('exit', resolve); child.once('error', reject) }), output).toBe(0) }
    finally { clearTimeout(timeout) }
    const result = JSON.parse(await readFile(join(directory, 'result.json'), 'utf8'))
    expect(result).toMatchObject({ passed: true, picks: 3, bytes: 700001, imageAfterReload: true, artifactCount: 1, modelCalls: 0 })
    process.stdout.write(`Workspace import App evidence: ${JSON.stringify(result)}\n`)
  } finally { await server.close(); await rm(directory, { recursive: true, force: true }) }
}, 120000)

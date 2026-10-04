// @vitest-environment node
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { copyFile, mkdtemp, rm, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { createServer } from 'vite'
import react from '@vitejs/plugin-react'
import { expect, it } from 'vitest'

it('keeps menus and notifications interactive above real Electron modals', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'goodbuddy-overlay-layering-'))
  const server = await createServer({ configFile: false, root: resolve('.'), cacheDir: join(directory, 'vite'),
    plugins: [react(), { name: 'overlay-layering', configureServer(server) {
      server.middlewares.use('/overlays.html', async (_request, response) => {
        response.setHeader('Content-Type', 'text/html')
        response.end(await server.transformIndexHtml('/overlays.html',
          '<html><body><div id="root"></div><script type="module" src="/tests/support/overlay-layering-regression.tsx"></script></body></html>'))
      })
    } }], server: { host: '127.0.0.1', port: 0, watch: null } })
  try {
    await server.listen()
    const env: NodeJS.ProcessEnv = { ...process.env, GOODBUDDY_OVERLAY_URL: server.resolvedUrls!.local[0] + 'overlays.html',
      GOODBUDDY_OVERLAY_DIRECTORY: directory }
    delete env.ELECTRON_RUN_AS_NODE
    const driver = join(directory, 'driver.mjs')
    await copyFile(resolve('tests/support/overlay-layering-driver.mjs'), driver)
    const child = spawn(createRequire(import.meta.url)('electron'), [driver], { env, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    child.stdout.on('data', data => { output += data })
    child.stderr.on('data', data => { output += data })
    const timeout = setTimeout(() => child.kill(), 90000)
    try {
      const code = await new Promise((resolve, reject) => { child.once('exit', resolve); child.once('error', reject) })
      expect(code, output).toBe(0)
    } finally { clearTimeout(timeout) }
  } finally { await server.close(); await rm(directory, { recursive: true, force: true }) }
}, 120000)

it.each([
  ['saves the conversation story graph switch from App through production IPC and revokes existing tools', 'story-graph-switch-main.ts'],
  ['opens the MCP editor from App settings with native browser isolation and real persistence', 'mcp-overlay-main.ts'],
  ['keeps nested previews, sandbox keyboard, project modals and native overlays usable', 'overlay-paths-main.ts']
])('%s', async (_name, entry) => {
  const directory = await mkdtemp(join(tmpdir(), 'goodbuddy-mcp-overlay-'))
  const server = await createServer({ configFile: false, root: resolve('.'), cacheDir: join(directory, 'vite'),
    plugins: [react({ include: /\/(src|tests)\/.*\.[jt]sx?$/ }), { name: 'mcp-app', configureServer(server) {
      server.middlewares.use('/mcp.html', async (_request, response) => {
        response.setHeader('Content-Type', 'text/html')
        response.end(await server.transformIndexHtml('/mcp.html',
          '<html><body><div id="root"></div><script type="module" src="/tests/support/magic-notes-capture-renderer.tsx"></script></body></html>'))
      })
    } }], server: { host: '127.0.0.1', port: 0, watch: null },
    optimizeDeps: { entries: ['tests/support/magic-notes-capture-renderer.tsx'], include: ['fabric', 'quill', 'quill/blots/block', 'quill-delta', 'jspdf', 'pdfjs-dist', 'react', 'react-dom/client', 'react-i18next'] } })
  try {
    const driver = join(directory, 'main.mjs')
    await build({ entryPoints: [`tests/support/${entry}`], outfile: driver,
      bundle: true, platform: 'node', format: 'esm', external: ['electron'], plugins: [
        { name: 'isolated-external-services', setup(build) {
          build.onResolve({ filter: /channels\/channel-env$/ }, () => ({ path: 'channels', namespace: 'mcp' }))
          build.onResolve({ filter: /agent\/create-runtime$/ }, () => ({ path: 'runtime', namespace: 'mcp' }))
          build.onLoad({ filter: /.*/, namespace: 'mcp' }, ({ path }) => ({ contents: path === 'channels'
            ? 'export const startEnvironmentChannels=()=>[];'
            : 'export const createDefaultModelRuntime=()=>{globalThis.overlayModelAttempts=(globalThis.overlayModelAttempts??0)+1;throw new Error("Model calls forbidden")}; export const createModelProfileRuntime=createDefaultModelRuntime;' }))
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
    const env: NodeJS.ProcessEnv = { ...process.env, GB_MCP_DIRECTORY: directory, GB_MCP_URL: server.resolvedUrls!.local[0] + 'mcp.html' }
    delete env.ELECTRON_RUN_AS_NODE
    const bootstrap = join(directory, 'bootstrap.cjs')
    await writeFile(bootstrap, `import(${JSON.stringify(pathToFileURL(driver).href)}).catch(error => { console.error(error); require('electron').app.exit(1) })`)
    const child = spawn(createRequire(import.meta.url)('electron'), [bootstrap], { env, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    child.stdout.on('data', data => { output += data })
    child.stderr.on('data', data => { output += data })
    const timeout = setTimeout(() => child.kill(), 90000)
    try {
      expect(await new Promise((resolve, reject) => { child.once('exit', resolve); child.once('error', reject) }), output).toBe(0)
    } finally { clearTimeout(timeout) }
    const result = JSON.parse(await readFile(join(directory, 'result.json'), 'utf8'))
    process.stdout.write(`${entry} Electron evidence: ${JSON.stringify(result)}\n`)
    expect(result).toMatchObject({ modelAttempts: 0 })
    if (entry === 'mcp-overlay-main.ts') {
      expect(result.persistedAfterReload).toBe(true)
      expect(result.scenarios).toHaveLength(4)
    } else if (entry === 'story-graph-switch-main.ts') {
      expect(result).toMatchObject({ persistedAfterReload: true, revokedExistingBinding: true, hiddenWhenDisabled: true })
      expect(result.scenarios).toHaveLength(4)
    } else {
      expect(result).toMatchObject({ image: true, iframe: true, project: true, tooltip: true, citation: true })
    }
  } finally { await server.close(); await rm(directory, { recursive: true, force: true }) }
}, 180000)

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

it('validates terminal UI through production model HTTP, IPC, persistence and reload', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'goodbuddy-terminal-probe-'))
  const server = await createServer({ configFile: false, root: resolve('.'), cacheDir: join(directory, 'vite'), plugins: [react(), {
    name: 'terminal-probe', configureServer(server) { server.middlewares.use('/capture.html', async (_req, res) => {
      res.setHeader('Content-Type', 'text/html'); res.end(await server.transformIndexHtml('/capture.html', '<html><body><div id="root"></div><script type="module" src="/tests/support/magic-notes-capture-renderer.tsx"></script></body></html>'))
    }) }
  }], server: { host: '127.0.0.1', port: 0, watch: null }, optimizeDeps: { entries: ['tests/support/magic-notes-capture-renderer.tsx'] } })
  try {
    const driver = join(directory, 'main.mjs')
    await build({ entryPoints: ['tests/support/terminal-status-probe-main.ts'], outfile: driver, bundle: true, platform: 'node', format: 'esm', external: ['electron'], plugins: [
      { name: 'no-channels', setup(build) {
        build.onResolve({ filter: /channels\/channel-env$/ }, () => ({ path: 'channels', namespace: 'probe' }))
        build.onLoad({ filter: /.*/, namespace: 'probe' }, () => ({ contents: 'export const startEnvironmentChannels=()=>[];' }))
      } },
      { name: 'external-packages', setup(build) { build.onResolve({ filter: /^[^./]/ }, async args => {
        if (args.pluginData?.resolved || /^[A-Za-z]:/.test(args.path) || args.path.startsWith('node:') || args.path === 'electron') return
        const result = await build.resolve(args.path, { resolveDir: resolve('.'), kind: 'import-statement', pluginData: { resolved: true } })
        return result.errors.length ? { errors: result.errors } : { path: result.external ? result.path : pathToFileURL(result.path).href, external: true }
      }) } }
    ] })
    await build({ entryPoints: ['src/preload/index.ts'], outfile: join(directory, 'preload.cjs'), bundle: true, platform: 'node', format: 'cjs', external: ['electron'] })
    await build({ entryPoints: ['src/main/execution-stats-worker.ts'], outfile: join(directory, 'out/main/execution-stats-worker.js'), bundle: true, platform: 'node', format: 'cjs' })
    await server.listen()
    const bootstrap = join(directory, 'bootstrap.cjs')
    await writeFile(bootstrap, `import(${JSON.stringify(pathToFileURL(driver).href)}).catch(e=>{console.error(e);require('electron').app.exit(1)})`)
    const env = { ...process.env, GB_CAPTURE_DIRECTORY: directory, GB_CAPTURE_URL: server.resolvedUrls!.local[0] + 'capture.html' }
    delete (env as NodeJS.ProcessEnv).ELECTRON_RUN_AS_NODE
    const child = spawn(createRequire(import.meta.url)('electron'), [bootstrap], { env, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''; child.stdout.on('data', data => { output += data }); child.stderr.on('data', data => { output += data })
    const timeout = setTimeout(() => child.kill(), 100000)
    try { expect(await new Promise(resolve => child.once('exit', resolve)), output).toBe(0); console.log(output) }
    finally { clearTimeout(timeout) }
  } finally { await server.close(); await rm(directory, { recursive: true, force: true }) }
}, 120000)

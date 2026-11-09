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

it('scans through the actual connection UI, preload, IPC and encrypted channel store', async () => {
  await mkdir(resolve('temp'), { recursive: true })
  const directory = await mkdtemp(resolve('temp/dingtalk-registration-'))
  const server = await createServer({ configFile: false, root: resolve('.'), cacheDir: join(directory, 'vite'),
    plugins: [react({ exclude: [/node_modules/, /[\\/]temp[\\/]/] }), { name: 'dingtalk-registration-fixture', configureServer(server) {
      server.middlewares.use('/dingtalk.html', async (_request, response) => {
        response.setHeader('Content-Type', 'text/html')
        response.end(await server.transformIndexHtml('/dingtalk.html', '<html><body><div id="root"></div><script type="module" src="/tests/support/dingtalk-registration-renderer.tsx"></script></body></html>'))
      })
    } }], server: { host: '127.0.0.1', port: 0, watch: null }, optimizeDeps: { entries: ['tests/support/dingtalk-registration-renderer.tsx'] }
  })
  try {
    const main = join(directory, 'main.mjs')
    await build({ entryPoints: ['tests/support/dingtalk-registration-main.ts'], outfile: main, bundle: true, platform: 'node', format: 'esm', external: ['electron'], plugins: [{
      name: 'external-packages', setup(builder) {
        builder.onResolve({ filter: /^[^./]/ }, async args => {
          if (args.pluginData?.resolved || /^[A-Za-z]:/.test(args.path) || args.path.startsWith('node:') || args.path === 'electron') return
          const result = await builder.resolve(args.path, { resolveDir: resolve('.'), kind: 'import-statement', pluginData: { resolved: true } })
          return result.errors.length ? { errors: result.errors } : { path: result.external ? result.path : pathToFileURL(result.path).href, external: true }
        })
      }
    }] })
    await build({ entryPoints: ['src/preload/index.ts'], outfile: join(directory, 'preload.cjs'), bundle: true, platform: 'node', format: 'cjs', external: ['electron'] })
    await server.listen()
    const bootstrap = join(directory, 'bootstrap.cjs')
    await writeFile(bootstrap, `import(${JSON.stringify(pathToFileURL(main).href)}).catch(e => { console.error(e); require('electron').app.exit(1) })`)
    const env: NodeJS.ProcessEnv = { ...process.env, GB_DINGTALK_DIRECTORY: directory, GB_DINGTALK_RENDERER: server.resolvedUrls!.local[0] + 'dingtalk.html', TEMP: directory, TMP: directory }
    delete env.ELECTRON_RUN_AS_NODE
    const child = spawn(createRequire(import.meta.url)('electron'), [bootstrap], { env, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    child.stdout.on('data', data => { output += data })
    child.stderr.on('data', data => { output += data })
    let timedOut = false
    const timer = setTimeout(() => { timedOut = true; child.kill() }, 55_000)
    try {
      const code = await new Promise((resolve, reject) => { child.once('close', resolve); child.once('error', reject) })
      expect(timedOut, output).toBe(false)
      expect(code, output).toBe(0)
      expect(output).toContain('"dingtalkRegistrationSmoke":"passed"')
    } finally { clearTimeout(timer) }
  } finally {
    await server.close()
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }
}, 90_000)

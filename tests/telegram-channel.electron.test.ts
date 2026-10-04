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

// Run: npx vitest run tests/telegram-channel.electron.test.ts
it('routes Telegram settings and private text through production Electron IPC, executor, model and SQLite', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'goodbuddy-telegram-'))
  const server = await createServer({ configFile: false, root: resolve('.'), cacheDir: join(directory, 'vite'),
    plugins: [react(), { name: 'telegram-smoke', configureServer(server) {
      server.middlewares.use('/telegram.html', async (_request, response) => {
        response.setHeader('Content-Type', 'text/html')
        response.end(await server.transformIndexHtml('/telegram.html', '<html><body><div id="root"></div><script type="module" src="/tests/support/telegram-renderer.tsx"></script></body></html>'))
      })
    } }], server: { host: '127.0.0.1', port: 0, watch: null },
    optimizeDeps: { entries: ['tests/support/telegram-renderer.tsx'] }
  })
  try {
    const driver = join(directory, 'main.mjs')
    await build({ entryPoints: ['tests/support/telegram-main.ts'], outfile: driver,
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
    await server.listen()
    const bootstrap = join(directory, 'bootstrap.cjs')
    await writeFile(bootstrap, `import(${JSON.stringify(pathToFileURL(driver).href)}).catch(error => { console.error(error); require('electron').app.exit(1) })`)
    const env: NodeJS.ProcessEnv = { ...process.env, GB_TELEGRAM_DIRECTORY: directory,
      GB_TELEGRAM_RENDERER: server.resolvedUrls!.local[0] + 'telegram.html' }
    delete env.ELECTRON_RUN_AS_NODE
    // No inherited channel/provider credentials or proxy configuration in this process.
    for (const key of Object.keys(env)) {
      if (/TOKEN|SECRET|API_KEY|PROXY|^GOODBUDDY_|^TELEGRAM_|^WECOM_|^DINGTALK_|^WEIXIN_/i.test(key)) delete env[key]
    }
    const child = spawn(createRequire(import.meta.url)('electron'), [bootstrap], { env, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    child.stdout.on('data', data => { output += data })
    child.stderr.on('data', data => { output += data })
    const timer = setTimeout(() => child.kill(), 90000)
    try {
      const code = await new Promise((resolve, reject) => { child.once('exit', resolve); child.once('error', reject) })
      expect(code, output).toBe(0)
      expect(output).toContain('"telegramSmoke":"passed"')
      process.stdout.write(output)
    } finally { clearTimeout(timer) }
  } finally {
    await server.close()
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }
}, 120000)

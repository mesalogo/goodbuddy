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

it.each([true, false])('analyzes selected canvas pages through production Electron UI and IPC (vision=%s)', async (supportsImageInput) => {
  const directory = await mkdtemp(join(tmpdir(), 'goodbuddy-notes-analysis-'))
  const server = await createServer({ configFile: false, root: resolve('.'), cacheDir: join(directory, 'vite'),
    plugins: [react(), { name: 'notes-analysis', configureServer(server) {
      server.middlewares.use('/analysis.html', async (_request, response) => {
        response.setHeader('Content-Type', 'text/html')
        response.end(await server.transformIndexHtml('/analysis.html', '<html><body><script type="module" src="/tests/support/magic-notes-analysis-regression.tsx"></script></body></html>'))
      })
    } }], server: { host: '127.0.0.1', port: 0, watch: null },
    optimizeDeps: { include: ['fabric', 'quill', 'quill-delta', 'jspdf', 'react', 'react-dom/client', 'react-i18next'] }
  })
  try {
    const driver = join(directory, 'main.mjs'), preload = join(directory, 'preload.cjs')
    await build({ entryPoints: ['tests/support/magic-notes-analysis-main.ts'], outfile: driver, bundle: true, platform: 'node', format: 'esm', external: ['electron'],
      plugins: [{ name: 'isolated-services', setup(build) {
        build.onResolve({ filter: /channels\/channel-env$/ }, () => ({ path: 'channels', namespace: 'probe' }))
        build.onResolve({ filter: /agent\/create-runtime$/ }, () => ({ path: 'runtime', namespace: 'probe' }))
        build.onLoad({ filter: /.*/, namespace: 'probe' }, ({ path }) => ({ contents: path === 'channels'
          ? 'export const startEnvironmentChannels=()=>[]; export const isReadOnlyChannelMessage=()=>true;'
          : `export const createDefaultModelRuntime=()=>({ dispose:async()=>{}, releaseConversation:async()=>{}, async *run(request) {
              (globalThis.analysisRequests ??= []).push({ prompt: request.prompt, imageCount: request.images?.length ?? 0 });
              yield {requestId:request.requestId,type:'text',delta:'{"comments":[{"kind":"summary","content":"Canvas reviewed."}]}'};
              yield {requestId:request.requestId,type:'done'};
            }}); export const createModelProfileRuntime=createDefaultModelRuntime;` }))
      } }, { name: 'external-packages', setup(build) {
        build.onResolve({ filter: /^[^./]/ }, async args => {
          if (args.pluginData?.resolved || /^[A-Za-z]:/.test(args.path) || args.path.startsWith('node:') || args.path === 'electron') return
          const result = await build.resolve(args.path, { resolveDir: resolve('.'), kind: 'import-statement', pluginData: { resolved: true } })
          return result.errors.length ? { errors: result.errors } : { path: result.external ? result.path : pathToFileURL(result.path).href, external: true }
        })
      } }] })
    await build({ entryPoints: ['src/preload/index.ts'], outfile: preload, bundle: true, platform: 'node', format: 'cjs', external: ['electron'] })
    await server.listen()
    const bootstrap = join(directory, 'bootstrap.cjs')
    await writeFile(bootstrap, `import(${JSON.stringify(pathToFileURL(driver).href)}).catch(error => { console.error(error); require('electron').app.exit(1) })`)
    const env: NodeJS.ProcessEnv = { ...process.env, GB_NOTES_PROBE_VISION: String(supportsImageInput), GB_NOTES_PROBE_DIRECTORY: directory, GB_NOTES_PROBE_URL: server.resolvedUrls!.local[0] + 'analysis.html' }
    delete env.ELECTRON_RUN_AS_NODE
    const child = spawn(createRequire(import.meta.url)('electron'), [bootstrap], { env, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    child.stdout.on('data', data => { output += data })
    child.stderr.on('data', data => { output += data })
    const timeout = setTimeout(() => child.kill(), 60000)
    try {
      expect(await new Promise((resolve, reject) => { child.once('exit', resolve); child.once('error', reject) }), output).toBe(0)
    } finally { clearTimeout(timeout) }
    const result = JSON.parse(await readFile(join(directory, 'result.json'), 'utf8'))
    expect(result).toMatchObject({ errors: [], manualRevision: 1, editedRevision: 3, createdAnalyzed: true, todoAnalyzed: supportsImageInput ? 'canvas-images' : 'text-fallback' })
    expect(result.requests).toHaveLength(6)
    for (const request of result.requests.slice(0, 5)) {
      expect(request.imageCount).toBe(supportsImageInput ? 2 : 0)
      expect(request.prompt).toContain('Included second')
      expect(request.prompt).not.toContain('Excluded third')
    }
    expect(result.requests[5].prompt).toContain('Automatic start')
    expect(result.requests[5].prompt).not.toContain('Automatic excluded tail')
    expect(result.requests[5].imageCount).toBe(supportsImageInput ? 2 : 0)
  } finally {
    await server.close()
    await rm(directory, { recursive: true, force: true })
  }
}, 90000)

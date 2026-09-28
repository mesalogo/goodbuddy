// @vitest-environment node
import { spawn } from 'node:child_process'
import { copyFile, mkdtemp, readFile, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import react from '@vitejs/plugin-react'
import { createServer } from 'vite'
import { expect, it } from 'vitest'

it('measures real streaming Markdown and preserves every prefix against the original normalizer', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'goodbuddy-streaming-markdown-'))
  const server = await createServer({
    configFile: false, root: resolve('.'), cacheDir: join(directory, 'vite'),
    plugins: [{
      name: 'streaming-markdown-instrumentation', enforce: 'pre',
      async load(id) {
        if (!id.endsWith('MarkdownRenderer.tsx?streaming-original')) return
        const source = await readFile(id.split('?')[0]!, 'utf8')
        return source.replace(/(?:export )?function replaceLatexDelimiters[\s\S]*?(?=function unwrapMarkdownFence)/u,
          'import { originalNormalize as normalizeLatexDelimiters } from "/tests/support/streaming-markdown-corpus.ts"\n\n')
      },
      transform(source, id) {
        if (id.split('?')[0]!.endsWith('/MarkdownRenderer.tsx')) {
          return source + '\nexport { normalizeLatexDelimiters as benchmarkNormalize }\n'
        }
      },
      configureServer(server) {
        server.middlewares.use('/streaming-markdown.html', async (_request, response) => {
          response.setHeader('Content-Type', 'text/html; charset=utf-8')
          response.end(await server.transformIndexHtml('/streaming-markdown.html',
            '<!doctype html><html><head><meta charset="utf-8"></head><body><div id="root"></div><script type="module" src="/tests/support/streaming-markdown-perf.tsx"></script></body></html>'))
        })
      }
    }, react()],
    server: { host: '127.0.0.1', port: 0, watch: null }
  })
  try {
    await server.listen()
    const env: NodeJS.ProcessEnv = { ...process.env, GOODBUDDY_MARKDOWN_URL: server.resolvedUrls!.local[0] + 'streaming-markdown.html',
      GOODBUDDY_MARKDOWN_DIRECTORY: directory }
    delete env.ELECTRON_RUN_AS_NODE
    const driver = join(directory, 'driver.mjs')
    await copyFile(resolve('tests/support/streaming-markdown-driver.mjs'), driver)
    const child = spawn(createRequire(import.meta.url)('electron'), [driver], { env, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    child.stdout.on('data', data => { output += data })
    child.stderr.on('data', data => { output += data })
    const timeout = setTimeout(() => child.kill(), 150_000)
    try {
      const code = await new Promise((resolve, reject) => {
        child.once('exit', resolve)
        child.once('error', reject)
      })
      expect(code, output).toBe(0)
      process.stdout.write(output.split(/\r?\n/u).filter(line => line.startsWith('Markdown ')).join('\n') + '\n')
    } finally {
      clearTimeout(timeout)
      if (child.exitCode === null) child.kill()
    }
  } finally {
    await server.close()
    await rm(directory, { recursive: true, force: true })
  }
}, 180_000)

// @vitest-environment node
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { build } from 'esbuild'
import { expect, it } from 'vitest'

it.skipIf(!process.env.GB_REVIEW_LIVE_SETTINGS)('validates incremental production services with at most three real text requests', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'opencode', 'goodbuddy-review-live-'))
  try {
    const main = join(directory, 'main.cjs')
    await build({ entryPoints: ['tests/support/incremental-review-live.ts'], outfile: main, bundle: true,
      platform: 'node', format: 'cjs', external: ['electron'], plugins: [{ name: 'external-packages', setup(builder) {
        builder.onResolve({ filter: /^[^./]/ }, async (args) => {
          if (args.pluginData?.resolved || /^[A-Za-z]:/.test(args.path) || args.path.startsWith('node:') || args.path === 'electron') return
          const result = await builder.resolve(args.path, { resolveDir: resolve('.'), kind: 'import-statement', pluginData: { resolved: true } })
          return result.errors.length ? { errors: result.errors } : { path: result.path, external: true }
        })
      } }] })
    const env: NodeJS.ProcessEnv = { ...process.env, GB_REVIEW_LIVE_DIRECTORY: directory }
    delete env.ELECTRON_RUN_AS_NODE
    const child = spawn(createRequire(import.meta.url)('electron'), [main], { env, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    child.stdout.on('data', (data) => { output += String(data) })
    child.stderr.on('data', (data) => { output += String(data) })
    const timeout = setTimeout(() => child.kill(), 285000)
    try {
      const code = await new Promise((resolve, reject) => { child.once('exit', resolve); child.once('error', reject) })
      process.stdout.write(output)
      expect(code, output).toBe(0)
    } finally { clearTimeout(timeout) }
  } finally { await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }) }
}, 300000)

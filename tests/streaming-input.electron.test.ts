// @vitest-environment node
import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import react from '@vitejs/plugin-react'
import { build as bundle } from 'esbuild'
import { build } from 'vite'
import { expect, it } from 'vitest'

it('benchmarks native input during main-driven streaming at 16/32/50/80ms', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'goodbuddy-streaming-input-'))
  try {
    await build({
      configFile: false, root: resolve('tests/support'), base: './',
      plugins: [react()], logLevel: 'error',
      build: { outDir: join(directory, 'renderer'), emptyOutDir: true,
        rollupOptions: { input: resolve('tests/support/streaming-input-page.html') } }
    })
    await bundle({ entryPoints: [resolve('tests/support/streaming-input-driver.ts')],
      outfile: join(directory, 'driver.mjs'), bundle: true, platform: 'node', format: 'esm',
      external: ['electron'] })
    await bundle({ entryPoints: [resolve('tests/support/streaming-input-preload.ts')],
      outfile: join(directory, 'preload.cjs'), bundle: true, platform: 'node', format: 'cjs',
      external: ['electron'] })
    const env: NodeJS.ProcessEnv = { ...process.env, GOODBUDDY_STREAMING_INPUT_DIRECTORY: directory }
    delete env.ELECTRON_RUN_AS_NODE
    const child = spawn(createRequire(import.meta.url)('electron'), [join(directory, 'driver.mjs')],
      { env, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    child.stdout.on('data', data => { output += data })
    child.stderr.on('data', data => { output += data })
    const timeout = setTimeout(() => child.kill(), 100_000)
    try {
      const code = await new Promise((resolve, reject) => {
        child.once('exit', resolve)
        child.once('error', reject)
      })
      process.stdout.write(output.split(/\r?\n/u).filter(line => line.startsWith('Streaming input ')).join('\n') + '\n')
      expect(code, output).toBe(0)
    } finally {
      clearTimeout(timeout)
      if (child.exitCode === null) child.kill()
    }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}, 120_000)

// @vitest-environment node
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { build } from 'esbuild'
import { expect, it } from 'vitest'

it('settles C05 storage loss, preserves committed data, and retries after confirmed exit', async () => {
  const parent = resolve('temp/goodbuddy-storage-fault-acceptance')
  await mkdir(parent, { recursive: true })
  const directory = await mkdtemp(join(parent, 'electron-'))
  try {
    for (const [entry, output, format] of [
      ['src/main/desktop-storage-entry.ts', 'desktop-storage-entry.mjs', 'esm'],
      ['src/main/readonly-query-worker.ts', 'readonly-query-worker.cjs', 'cjs'],
      ['src/main/assistant-storage-worker.ts', 'assistant-storage-worker.cjs', 'cjs'],
      ['tests/support/desktop-storage-fault-electron-fixture.ts', 'main.mjs', 'esm']
    ] as const) {
      await build({ entryPoints: [resolve(entry)], outfile: join(directory, output), bundle: true, platform: 'node', format, external: ['electron', '@napi-rs/canvas'], logLevel: 'silent' })
    }
    const env: NodeJS.ProcessEnv = { ...process.env, GB_STORAGE_FAULT_ROOT: directory, TEMP: directory, TMP: directory, TMPDIR: directory }
    delete env.ELECTRON_RUN_AS_NODE
    const child = spawn(createRequire(import.meta.url)('electron'), [join(directory, 'main.mjs')], { env, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    child.stdout.on('data', data => { output += data })
    child.stderr.on('data', data => { output += data })
    const timer = setTimeout(() => child.kill(), 90_000)
    try {
      const code = await new Promise<number | null>((resolveExit, reject) => { child.once('exit', resolveExit); child.once('error', reject) })
      if (code !== 0) throw new Error(output || `fixture exited with ${code}`)
      expect(output).toContain('"status":"passed"')
      console.log(output.trim())
    } finally { clearTimeout(timer) }
  } finally { await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) }
}, 120_000)

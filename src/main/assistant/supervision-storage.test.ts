// @vitest-environment node
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { build } from 'esbuild'
import { expect, it } from 'vitest'

it('runs heartbeat, review, stories, experiences, suggestions, usage and cancellation through real storage IPC', async () => {
  const parent = resolve('temp/goodbuddy-supervision-storage')
  await mkdir(parent, { recursive: true })
  const directory = await mkdtemp(join(parent, 'electron-'))
  try {
    for (const [entry, output, format] of [
      ['src/main/desktop-storage-entry.ts', 'desktop-storage-entry.mjs', 'esm'],
      ['tests/support/supervision-storage-fixture.ts', 'main.mjs', 'esm'],
      ['src/main/readonly-query-worker.ts', 'readonly-query-worker.cjs', 'cjs'],
      ['src/main/assistant-storage-worker.ts', 'assistant-storage-worker.cjs', 'cjs']
    ] as const) await build({ entryPoints: [resolve(entry)], outfile: join(directory, output), bundle: true,
      platform: 'node', format, external: ['electron', '@napi-rs/canvas'], logLevel: 'silent' })
    const env: NodeJS.ProcessEnv = { ...process.env, GB_SUPERVISION_STORAGE_ROOT: directory, TEMP: directory, TMP: directory, TMPDIR: directory }
    delete env.ELECTRON_RUN_AS_NODE
    const child = spawn(createRequire(import.meta.url)('electron'), [join(directory, 'main.mjs')], { env, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    child.stdout.on('data', data => { output += data })
    child.stderr.on('data', data => { output += data })
    const timer = setTimeout(() => child.kill(), 60_000)
    try {
      const code = await new Promise<number | null>((resolve, reject) => { child.once('exit', resolve); child.once('error', reject) })
      expect(code, output).toBe(0)
      expect(output).toContain('supervision-storage: passed')
    } finally { clearTimeout(timer) }
  } finally { await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) }
}, 90_000)

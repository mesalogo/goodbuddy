/* global require, process, __dirname, console, setTimeout, clearTimeout */
/* eslint-disable @typescript-eslint/no-require-imports */
// node scripts/supervision-storage-live.cjs <current-runtime-settings.json>
const { build } = require('esbuild')
const { spawn } = require('node:child_process')
const { mkdir, mkdtemp, rm } = require('node:fs/promises')
const { join, resolve } = require('node:path')
async function main() {
  const repo = resolve(__dirname, '..')
  if (!process.argv[2]) throw new Error('Runtime settings path required')
  const parent = join(repo, 'temp', 'supervision-storage-live')
  await mkdir(parent, { recursive: true })
  const root = await mkdtemp(join(parent, 'probe-'))
  try {
    for (const [entry, output, format] of [
      ['scripts/supervision-storage-live.ts', 'main.mjs', 'esm'],
      ['src/main/desktop-storage-entry.ts', 'desktop-storage-entry.mjs', 'esm'],
      ['src/main/readonly-query-worker.ts', 'readonly-query-worker.cjs', 'cjs'],
      ['src/main/assistant-storage-worker.ts', 'assistant-storage-worker.cjs', 'cjs']
    ]) await build({ entryPoints: [join(repo, entry)], outfile: join(root, output), bundle: true,
      platform: 'node', format, packages: 'external', logLevel: 'silent' })
    const env = { ...process.env, GB_SUPERVISION_STORAGE_ROOT: root, GB_SUPERVISION_SETTINGS: resolve(process.argv[2]), TEMP: root, TMP: root, TMPDIR: root }
    delete env.ELECTRON_RUN_AS_NODE
    const child = spawn(require('electron'), [join(root, 'main.mjs')], { env, stdio: ['ignore', 'pipe', 'pipe'] })
    child.stdout.on('data', data => process.stdout.write(data))
    // The probe prints only bounded metrics; native stderr is not a credential-safe report.
    child.stderr.resume()
    const timer = setTimeout(() => child.kill(), 300_000)
    try { process.exitCode = (await new Promise((resolve, reject) => { child.once('exit', resolve); child.once('error', reject) })) ?? 1 }
    finally { clearTimeout(timer) }
  } finally { await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) }
}
main().catch(() => { console.error('Supervision storage probe failed before completion'); process.exitCode = 1 })

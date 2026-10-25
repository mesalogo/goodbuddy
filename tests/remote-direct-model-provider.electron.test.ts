// @vitest-environment node
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { build } from 'esbuild'
import { expect, it } from 'vitest'

it.skipIf(!process.env.GB_DIRECT_MODEL_SETTINGS || !process.env.GB_DIRECT_MODEL_HOST)('reads a real remote file with the configured direct model and retains its answer', async () => {
  const parent = resolve('temp/remote-direct-model')
  await mkdir(parent, { recursive: true })
  const root = await mkdtemp(join(parent, 'electron-'))
  try {
    const entry = join(root, 'main.cjs')
    await build({ entryPoints: ['tests/support/remote-direct-model-provider-live.ts'], outfile: entry, bundle: true, platform: 'node', format: 'cjs', packages: 'external' })
    const env = { ...process.env }
    delete env.ELECTRON_RUN_AS_NODE
    const child = spawn(createRequire(import.meta.url)('electron'), [entry], { env, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    child.stdout.on('data', data => { output += String(data); console.log(String(data)) })
    child.stderr.on('data', data => { output += String(data) })
    const timer = setTimeout(() => child.kill(), 170000)
    try {
      const code = await new Promise((resolve, reject) => { child.once('exit', resolve); child.once('error', reject) })
      console.log(output)
      expect(code, output).toBe(0)
    } finally { clearTimeout(timer) }
  } finally { await rm(root, { recursive: true, force: true }) }
}, 180000)

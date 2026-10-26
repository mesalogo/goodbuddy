// @vitest-environment node
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { expect, it } from 'vitest'
import { build } from 'esbuild'

it.each(['exit', 'quit', 'update-success', 'update-cleanup-failed', 'update-spawn-failed'])('measures Electron shutdown and production update handoff: %s', async mode => {
  await mkdir(resolve('temp'), { recursive: true })
  const directory = await mkdtemp(resolve('temp/desktop-update-lifecycle-'))
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  try {
    await build({ entryPoints: ['src/main/desktop-update-install.ts'], outfile: join(directory, 'install.cjs'), bundle: true, platform: 'node', format: 'cjs' })
    const child = spawn(createRequire(import.meta.url)('electron'), [
      ...(process.getuid?.() === 0 ? ['--no-sandbox'] : []),
      resolve('tests/support/desktop-update-lifecycle-main.mjs'), mode, directory
    ], { env, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    child.stdout.on('data', chunk => { output += chunk })
    child.stderr.on('data', chunk => { output += chunk })
    const timer = setTimeout(() => child.kill(), 10_000)
    try {
      const code = await new Promise((done, reject) => { child.once('exit', done); child.once('error', reject) })
      expect(code, output).toBe(mode.endsWith('failed') ? 1 : 0)
      const events = JSON.parse(await readFile(join(directory, 'events.json'), 'utf8'))
      expect(events).toEqual(mode === 'exit'
        ? ['before-quit', 'cleanup-complete', 'quit']
        : mode === 'quit' ? ['before-quit', 'cleanup-complete', 'before-quit', 'will-quit', 'quit']
        : ['before-quit', 'cleanup-complete', mode === 'update-success' ? 'installer-started' : 'update-failed', 'quit'])
    } finally { clearTimeout(timer) }
  } finally { await rm(directory, { recursive: true, force: true }) }
}, 15_000)

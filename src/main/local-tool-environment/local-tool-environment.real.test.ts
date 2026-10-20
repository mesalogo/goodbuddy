// @vitest-environment node
import { spawnSync } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import spawn from 'cross-spawn'
import { afterEach, expect, it } from 'vitest'
import { createLocalToolEnvironment, resolveLocalTool } from './local-tool-environment'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

/**
 * Runs the real wrappers through the operating system's PATH lookup. The
 * current Node.js stands in for the Electron binary because both honor
 * ELECTRON_RUN_AS_NODE harmlessly.
 */
it('falls back to the built-in node only when PATH has none', async () => {
  const root = await mkdtemp(join(tmpdir(), 'goodbuddy-real-tools-'))
  roots.push(root)
  const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT
  const minimalPath =
    process.platform === 'win32' ? join(systemRoot!, 'System32') : '/usr/bin:/bin'
  const base: NodeJS.ProcessEnv = {
    ...(process.platform === 'win32'
      ? {
          SystemRoot: systemRoot,
          COMSPEC: join(systemRoot!, 'System32', 'cmd.exe'),
          PATHEXT: '.COM;.EXE;.BAT;.CMD'
        }
      : {}),
    PATH: minimalPath
  }
  const hasSystemNode =
    spawnSync(process.platform === 'win32' ? 'where' : 'which', ['node'], {
      env: base,
      windowsHide: true
    }).status === 0
  const environment = await createLocalToolEnvironment(
    {
      binDirectory: join(root, 'bin'),
      nodeSelection: { source: 'auto' },
      pythonSelection: { source: 'auto' },
      packagedNpmCliPath: join(root, 'absent-npm-cli.js'),
      packagedNpxCliPath: join(root, 'absent-npx-cli.js'),
      baseEnvironment: base
    },
    { electronExecutablePath: process.execPath }
  )
  const result = spawn.sync('node', ['-p', 'process.execPath'], {
    env: { ...base, ...environment.environment },
    encoding: 'utf8',
    timeout: 10_000,
    windowsHide: true
  })
  expect(result.status, result.stderr).toBe(0)
  const resolved = await resolveLocalTool('node', environment, base)
  expect(resolved?.origin).toBe(hasSystemNode ? 'system' : 'managed')
  if (!hasSystemNode) {
    expect(result.stdout.trim().toLowerCase()).toBe(process.execPath.toLowerCase())
  }
}, 30_000)

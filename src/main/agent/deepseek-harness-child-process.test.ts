import type childProcess from 'node:child_process'
import { describe, expect, it, vi } from 'vitest'
import { installHarnessChildProcessWindowGuard } from './deepseek-harness-child-process'

type HarnessChildProcessModule = Pick<
  typeof childProcess,
  'execFileSync' | 'spawn' | 'spawnSync'
>

function fakeChildProcessModule(): {
  target: HarnessChildProcessModule
  execFileSync: ReturnType<typeof vi.fn>
  spawn: ReturnType<typeof vi.fn>
  spawnSync: ReturnType<typeof vi.fn>
} {
  const execFileSync = vi.fn(() => 'output')
  const spawn = vi.fn(() => ({ pid: 1 }))
  const spawnSync = vi.fn(() => ({ status: 0 }))
  return {
    target: {
      execFileSync:
        execFileSync as unknown as HarnessChildProcessModule['execFileSync'],
      spawn: spawn as unknown as HarnessChildProcessModule['spawn'],
      spawnSync:
        spawnSync as unknown as HarnessChildProcessModule['spawnSync']
    },
    execFileSync,
    spawn,
    spawnSync
  }
}

describe('DeepSeek Harness child process window guard', () => {
  it('does not alter child process launches outside Windows', () => {
    const { target, spawn } = fakeChildProcessModule()
    const originalSpawn = target.spawn
    const syncExports = vi.fn()

    const restore = installHarnessChildProcessWindowGuard(
      'linux',
      target,
      syncExports
    )

    expect(target.spawn).toBe(originalSpawn)
    expect(syncExports).not.toHaveBeenCalled()
    restore()
    expect(spawn).not.toHaveBeenCalled()
    expect(syncExports).not.toHaveBeenCalled()
  })

  it('forces hidden Windows launches and restores the original functions', () => {
    const { target, execFileSync, spawn, spawnSync } =
      fakeChildProcessModule()
    const originals = { ...target }
    const syncExports = vi.fn()

    const restore = installHarnessChildProcessWindowGuard(
      'win32',
      target,
      syncExports
    )

    target.spawn('runner.exe', ['--probe'], {
      cwd: 'C:\\workspace',
      windowsHide: false
    })
    target.spawnSync('taskkill.exe', {
      stdio: 'ignore'
    })
    target.spawnSync('where.exe', undefined, {
      encoding: 'utf8'
    })
    target.execFileSync('where.exe', ['pwsh.exe'], {
      encoding: 'utf8',
      windowsHide: false
    })

    expect(spawn).toHaveBeenCalledWith(
      'runner.exe',
      ['--probe'],
      expect.objectContaining({
        cwd: 'C:\\workspace',
        windowsHide: true
      })
    )
    expect(spawnSync).toHaveBeenCalledWith(
      'where.exe',
      undefined,
      expect.objectContaining({
        encoding: 'utf8',
        windowsHide: true
      })
    )
    expect(spawnSync).toHaveBeenCalledWith(
      'taskkill.exe',
      expect.objectContaining({
        stdio: 'ignore',
        windowsHide: true
      })
    )
    expect(execFileSync).toHaveBeenCalledWith(
      'where.exe',
      ['pwsh.exe'],
      expect.objectContaining({
        encoding: 'utf8',
        windowsHide: true
      })
    )
    expect(syncExports).toHaveBeenCalledTimes(1)

    restore()
    restore()

    expect(target).toMatchObject(originals)
    expect(syncExports).toHaveBeenCalledTimes(2)
  })
})

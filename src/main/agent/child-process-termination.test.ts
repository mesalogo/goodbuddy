import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import {
  requestProcessTreeTermination,
  terminateProcessTreeAndWait,
  waitForProcessExit,
  type WaitableProcessTreeChild
} from './child-process-termination'

function fakeChild(
  pid = 42
): WaitableProcessTreeChild & EventEmitter {
  const child =
    new EventEmitter() as WaitableProcessTreeChild & EventEmitter
  child.exitCode = null
  child.pid = pid
  child.kill = vi.fn()
  return child
}

describe('child process tree termination', () => {
  it('uses taskkill /T /F on Windows and bounds both exit waits', async () => {
    vi.useFakeTimers()
    try {
      const child = fakeChild(314)
      const killer = fakeChild(315)
      killer.unref = vi.fn()
      const spawnMock = vi.fn(() => killer)

      const termination = terminateProcessTreeAndWait(child, {
        platform: 'win32',
        spawn: spawnMock,
        waitMs: 25
      })
      await vi.advanceTimersByTimeAsync(25)
      await vi.advanceTimersByTimeAsync(25)
      await expect(termination).resolves.toBeUndefined()

      expect(spawnMock).toHaveBeenCalledWith(
        'taskkill.exe',
        ['/PID', '314', '/T', '/F'],
        {
          shell: false,
          stdio: 'ignore',
          windowsHide: true
        }
      )
      expect(killer.unref).toHaveBeenCalledOnce()
      expect(child.kill).toHaveBeenCalledWith('SIGTERM')
    } finally {
      vi.useRealTimers()
    }
  })

  it('falls back to direct termination when Windows taskkill fails', async () => {
    const child = fakeChild(314)
    const killer = fakeChild(315)
    const spawnMock = vi.fn(() => killer)
    const termination = terminateProcessTreeAndWait(child, {
      platform: 'win32',
      spawn: spawnMock,
      waitMs: 1_000
    })

    killer.exitCode = 1
    killer.emit('close', 1, null)
    await Promise.resolve()
    expect(child.kill).toHaveBeenCalledWith('SIGTERM')
    child.exitCode = 0
    child.emit('close', 0, null)

    await expect(termination).resolves.toBeUndefined()
  })

  it('terminates a detached POSIX process group with the requested signal', () => {
    const child = fakeChild(2718)
    const killProcess = vi.fn()

    requestProcessTreeTermination(child, {
      platform: 'linux',
      processGroup: true,
      signal: 'SIGKILL',
      killProcess
    })

    expect(killProcess).toHaveBeenCalledWith(-2718, 'SIGKILL')
    expect(child.kill).toHaveBeenCalledWith('SIGKILL')
  })

  it('falls back to the direct child when POSIX group termination fails', () => {
    const child = fakeChild(2718)

    requestProcessTreeTermination(child, {
      platform: 'linux',
      processGroup: true,
      killProcess: vi.fn(() => {
        throw new Error('not a group leader')
      })
    })

    expect(child.kill).toHaveBeenCalledWith('SIGTERM')
  })

  it('resolves exit waiting immediately on close', async () => {
    const child = fakeChild()
    const waiting = waitForProcessExit(child, 1_000)
    child.emit('close', 0, null)
    await expect(waiting).resolves.toBeUndefined()
  })

  it('does not terminate a child already marked as killed', () => {
    const child = fakeChild()
    child.killed = true
    const spawnMock = vi.fn()
    const killProcess = vi.fn()

    expect(
      requestProcessTreeTermination(child, {
        platform: 'win32',
        spawn: spawnMock,
        killProcess
      })
    ).toBeUndefined()
    expect(spawnMock).not.toHaveBeenCalled()
    expect(killProcess).not.toHaveBeenCalled()
    expect(child.kill).not.toHaveBeenCalled()
  })

  it('supports utility-process handles without an exitCode', () => {
    const child = {
      killed: false,
      pid: 99,
      kill: vi.fn()
    }
    const killer = fakeChild(100)
    const spawnMock = vi.fn(() => killer)

    expect(
      requestProcessTreeTermination(child, {
        platform: 'win32',
        spawn: spawnMock
      })
    ).toBe(killer)
    expect(spawnMock).toHaveBeenCalledWith(
      'taskkill.exe',
      ['/PID', '99', '/T', '/F'],
      {
        shell: false,
        stdio: 'ignore',
        windowsHide: true
      }
    )
  })

  it('falls back asynchronously for a synchronous Windows caller', async () => {
    vi.useFakeTimers()
    try {
      const child = {
        pid: 99,
        kill: vi.fn()
      }
      const killer = fakeChild(100)

      requestProcessTreeTermination(child, {
        platform: 'win32',
        spawn: vi.fn(() => killer),
        signal: 'SIGKILL',
        waitMs: 25
      })

      await vi.advanceTimersByTimeAsync(25)
      expect(child.kill).toHaveBeenCalledOnce()
      expect(child.kill).toHaveBeenCalledWith('SIGKILL')
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not directly kill after successful Windows tree termination', () => {
    const child = {
      pid: 99,
      kill: vi.fn()
    }
    const killer = fakeChild(100)

    requestProcessTreeTermination(child, {
      platform: 'win32',
      spawn: vi.fn(() => killer)
    })
    killer.exitCode = 0
    killer.emit('close', 0, null)

    expect(child.kill).not.toHaveBeenCalled()
  })
})

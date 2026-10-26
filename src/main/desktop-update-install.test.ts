import { describe, expect, it, vi } from 'vitest'
import { desktopUpdateInstallArguments, finishDesktopUpdateShutdown } from './desktop-update-install'

describe('desktop update shutdown handoff', () => {
  it('uses the existing install scope and path and requests launch after installation', () => {
    expect(desktopUpdateInstallArguments).toEqual(['/S', '--updated', '--force-run'])
  })
  it('exits only after the installer launch succeeds', async () => {
    const events: string[] = []
    let launched!: () => void
    const completion = finishDesktopUpdateShutdown({
      installerPath: 'update.exe', cleanupFailed: false,
      install: async () => { events.push('launch'); await new Promise<void>(done => { launched = done }) },
      reportFailure: () => events.push('error'), exit: code => events.push(`exit:${code}`)
    })
    expect(events).toEqual(['launch'])
    launched()
    await completion
    expect(events).toEqual(['launch', 'exit:0'])
  })
  it('does not start installation when cleanup failed or timed out', async () => {
    const install = vi.fn()
    const reportFailure = vi.fn()
    const exit = vi.fn()
    await finishDesktopUpdateShutdown({ installerPath: 'update.exe', cleanupFailed: true, install, reportFailure, exit })
    expect(install).not.toHaveBeenCalled()
    expect(reportFailure).toHaveBeenCalledOnce()
    expect(exit).toHaveBeenCalledWith(1)
  })
  it('reports launch failure and never reports a successful update', async () => {
    const reportFailure = vi.fn()
    const exit = vi.fn()
    await finishDesktopUpdateShutdown({ installerPath: 'update.exe', cleanupFailed: false,
      install: async () => { throw new Error('EACCES') }, reportFailure, exit })
    expect(reportFailure).toHaveBeenCalledWith(expect.stringContaining('EACCES'))
    expect(exit).toHaveBeenCalledWith(1)
  })
  it('preserves normal quit behavior when no update was requested', async () => {
    const install = vi.fn()
    const exit = vi.fn()
    await finishDesktopUpdateShutdown({ cleanupFailed: false, install, reportFailure: vi.fn(), exit })
    expect(install).not.toHaveBeenCalled()
    expect(exit).toHaveBeenCalledWith(0)
  })
})

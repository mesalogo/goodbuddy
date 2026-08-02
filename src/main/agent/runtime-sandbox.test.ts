import { describe, expect, it, vi } from 'vitest'
import {
  buildBubblewrapLaunch,
  resolveRuntimeSandbox
} from './runtime-sandbox'

describe('resolveRuntimeSandbox', () => {
  it('reports bubblewrap enforcement only after a successful Linux probe', () => {
    const probe = vi.fn(() => true)

    expect(resolveRuntimeSandbox('auto', 'linux', probe)).toEqual({
      binaryPath: 'bwrap',
      status: {
        mode: 'auto',
        enforcement: 'bubblewrap',
        available: true,
        detail:
          'Linux bubblewrap 文件系统沙箱已启用，网络仍按模型连接配置开放'
      }
    })
    expect(probe).toHaveBeenCalledWith('bwrap')
  })

  it('fails closed when strict mode is unavailable', () => {
    expect(
      resolveRuntimeSandbox('strict', 'linux', () => false)
    ).toMatchObject({
      status: {
        mode: 'strict',
        enforcement: 'unavailable',
        available: false
      }
    })
    expect(
      resolveRuntimeSandbox('strict', 'win32', () => true).status.detail
    ).toContain('仅支持')
  })

  it('does not probe when sandboxing is disabled', () => {
    const probe = vi.fn(() => true)

    expect(resolveRuntimeSandbox('off', 'linux', probe).status).toMatchObject({
      enforcement: 'disabled',
      available: false
    })
    expect(probe).not.toHaveBeenCalled()
  })
})

describe('buildBubblewrapLaunch', () => {
  it('mounts only system roots, explicit runtime paths, and writable workspace paths', () => {
    const launch = buildBubblewrapLaunch({
      binaryPath: 'bwrap',
      command: '/opt/goodbuddy/node',
      args: ['/data/runtime/index.js', 'serve'],
      workspace: '/work/project',
      readOnlyPaths: ['/data/runtime/index.js'],
      writablePaths: ['/data/runtime/cache'],
      platform: 'linux'
    })

    expect(launch.command).toBe('bwrap')
    expect(launch.args).toContain('--unshare-all')
    expect(launch.args).toContain('--share-net')
    expect(launch.args).toContain('/opt/goodbuddy/node')
    expect(launch.args).toContain('/data/runtime/index.js')
    expect(launch.args).toContain('/data/runtime/cache')
    expect(launch.args).toContain('/work/project')
    expect(launch.args.slice(-3)).toEqual([
      '/opt/goodbuddy/node',
      '/data/runtime/index.js',
      'serve'
    ])
  })

  it('rejects relative mounts and non-Linux use', () => {
    expect(() =>
      buildBubblewrapLaunch({
        binaryPath: 'bwrap',
        command: 'node',
        args: [],
        workspace: 'relative',
        platform: 'linux'
      })
    ).toThrow('绝对路径')
    expect(() =>
      buildBubblewrapLaunch({
        binaryPath: 'bwrap',
        command: 'node',
        args: [],
        workspace: 'C:\\work',
        platform: 'win32'
      })
    ).toThrow('仅支持 Linux')
  })

  it('rejects writable system mounts', () => {
    expect(() =>
      buildBubblewrapLaunch({
        binaryPath: 'bwrap',
        command: '/usr/bin/opencode',
        args: [],
        workspace: '/etc',
        platform: 'linux'
      })
    ).toThrow('系统路径')
  })
})

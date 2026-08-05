import { describe, expect, it } from 'vitest'
import {
  buildDesktopHelperEnvironment,
  type SecurePathMetadata,
  type SessionEnvironmentFileSystem
} from './session-environment'

const safeMetadata = (
  canonicalPath: string,
  kind: 'file' | 'directory'
): SecurePathMetadata => ({
  canonicalPath,
  uid: 1000,
  mode: kind === 'file' ? 0o600 : 0o700,
  isDirectory: kind === 'directory',
  isFile: kind === 'file',
  isSymbolicLink: false
})

const fileSystem = (
  overrides: Partial<SecurePathMetadata> = {}
): SessionEnvironmentFileSystem => ({
  inspect: async (path) => ({
    ...safeMetadata(
      path,
      path.endsWith('.Xauthority') ? 'file' : 'directory'
    ),
    ...overrides
  })
})

describe('buildDesktopHelperEnvironment', () => {
  it('constructs a minimal fresh helper environment', async () => {
    const environment = await buildDesktopHelperEnvironment({
      uid: 1000,
      fileSystem: fileSystem(),
      source: {
        PATH: '/usr/bin:/bin',
        LANG: 'zh_CN.UTF-8',
        DISPLAY: ':0.0',
        WAYLAND_DISPLAY: 'wayland-1',
        XDG_RUNTIME_DIR: '/run/user/1000',
        DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus',
        XAUTHORITY: '/home/user/.Xauthority',
        NO_AT_BRIDGE: '1',
        LD_PRELOAD: '/tmp/inject.so',
        NODE_OPTIONS: '--require /tmp/inject.js',
        GTK_MODULES: 'inject',
        QT_PLUGIN_PATH: '/tmp/plugins',
        HTTPS_PROXY: 'http://proxy.invalid',
        API_KEY: 'secret'
      }
    })

    expect(environment).toEqual({
      PATH: '/usr/bin:/bin',
      LANG: 'zh_CN.UTF-8',
      DISPLAY: ':0.0',
      WAYLAND_DISPLAY: 'wayland-1',
      XDG_RUNTIME_DIR: '/run/user/1000',
      DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus',
      XAUTHORITY: '/home/user/.Xauthority',
      NO_AT_BRIDGE: '1'
    })
  })

  it.each([
    ['symbolic link', { isSymbolicLink: true }],
    ['world writable', { mode: 0o707 }],
    ['group writable', { mode: 0o720 }],
    ['wrong owner', { uid: 1001 }],
    ['non-canonical path', { canonicalPath: '/different' }]
  ])('rejects an unsafe %s runtime path', async (_name, override) => {
    await expect(
      buildDesktopHelperEnvironment({
        uid: 1000,
        fileSystem: fileSystem(override),
        source: { XDG_RUNTIME_DIR: '/run/user/1000' }
      })
    ).rejects.toThrow('Unsafe directory path')
  })

  it.each([
    { DISPLAY: 'host:abc' },
    { WAYLAND_DISPLAY: '../wayland-0', XDG_RUNTIME_DIR: '/run/user/1000' },
    { WAYLAND_DISPLAY: 'wayland-0' },
    { DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus,bad' },
    { DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus;tcp:' },
    { LANG: 'en_US.UTF-8\nINJECTED=1' },
    { PATH: '/usr/bin:relative/bin' },
    { PATH: '/usr/bin::/bin' }
  ])('rejects malformed desktop environment input', async (source) => {
    await expect(
      buildDesktopHelperEnvironment({
        uid: 1000,
        fileSystem: fileSystem(),
        source
      })
    ).rejects.toThrow()
  })

  it('does not forward values that merely resemble safe opt-ins', async () => {
    await expect(
      buildDesktopHelperEnvironment({
        uid: 1000,
        fileSystem: fileSystem(),
        source: { NO_AT_BRIDGE: '0', LD_LIBRARY_PATH: '/tmp' }
      })
    ).resolves.toEqual({})
  })
})

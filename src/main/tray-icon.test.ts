import { describe, expect, it } from 'vitest'
import { resolveTrayIconPath } from './tray-icon'

describe('resolveTrayIconPath', () => {
  it('uses the packaged notification-area PNG on Windows', () => {
    expect(
      resolveTrayIconPath({
        platform: 'win32',
        isPackaged: true,
        appPath: 'C:\\app',
        resourcesPath: 'C:\\app\\resources'
      })
    ).toBe('C:\\app\\resources\\tray-icon.png')
  })

  it('uses the generated taskbar asset during development', () => {
    expect(
      resolveTrayIconPath({
        platform: 'linux',
        isPackaged: false,
        appPath: '/opt/goodbuddy',
        resourcesPath: '/opt/goodbuddy/resources'
      })
    ).toBe('/opt/goodbuddy/build/icon-tray.png')
  })
})

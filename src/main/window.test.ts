import { describe, expect, it } from 'vitest'
import { resolveWindowIcon } from './window'

describe('resolveWindowIcon', () => {
  it('uses the packaged Windows taskbar icon', () => {
    expect(
      resolveWindowIcon({
        platform: 'win32',
        isPackaged: true,
        appPath: 'C:\\app',
        resourcesPath: 'C:\\app\\resources'
      })
    ).toBe('C:\\app\\resources\\icon.ico')
  })

  it('uses build assets during development and leaves macOS unset', () => {
    expect(
      resolveWindowIcon({
        platform: 'linux',
        isPackaged: false,
        appPath: '/opt/goodbuddy',
        resourcesPath: '/opt/goodbuddy/resources'
      })
    ).toBe('/opt/goodbuddy/build/icon.png')
    expect(
      resolveWindowIcon({
        platform: 'darwin',
        isPackaged: true,
        appPath: '/Applications/GoodBuddy.app',
        resourcesPath: '/Applications/GoodBuddy.app/Contents/Resources'
      })
    ).toBeUndefined()
  })
})

import { afterEach, describe, expect, it, vi } from 'vitest'
import { nativeImage, nativeTheme, type Tray } from 'electron'
import { createTrayIcon, followTraySystemTheme, resolveTrayIconPath } from './tray-icon'

vi.mock('electron', () => ({
  app: { isPackaged: false, getAppPath: () => 'C:\\source' },
  nativeTheme: {
    shouldUseDarkColorsForSystemIntegratedUI: false,
    shouldUseDarkColors: false,
    on: vi.fn(), removeListener: vi.fn()
  },
  nativeImage: {
    createFromPath: vi.fn(() => ({
      isEmpty: () => false,
      resize: () => ({ isEmpty: () => false })
    }))
  }
}))

afterEach(() => {
  vi.clearAllMocks()
  Object.assign(nativeTheme, { shouldUseDarkColorsForSystemIntegratedUI: false, shouldUseDarkColors: false })
})

it.runIf(process.platform === 'win32')('updates the tray for the shell theme, ignores destroyed trays and removes its listener', () => {
  Object.assign(nativeTheme, { shouldUseDarkColorsForSystemIntegratedUI: true, shouldUseDarkColors: false })
  createTrayIcon()
  expect(nativeImage.createFromPath).toHaveBeenLastCalledWith('C:\\source\\build\\icon-tray-dark.png')
  const tray = { isDestroyed: vi.fn(() => false), setImage: vi.fn() }
  const dispose = followTraySystemTheme(tray as unknown as Tray)
  const update = vi.mocked(nativeTheme.on).mock.calls.at(-1)![1] as () => void
  Object.assign(nativeTheme, { shouldUseDarkColorsForSystemIntegratedUI: false, shouldUseDarkColors: true })
  update()
  expect(nativeImage.createFromPath).toHaveBeenLastCalledWith('C:\\source\\build\\icon-tray.png')
  expect(tray.setImage).toHaveBeenCalledOnce()
  tray.isDestroyed.mockReturnValue(true)
  update()
  expect(tray.setImage).toHaveBeenCalledOnce()
  dispose()
  expect(nativeTheme.removeListener).toHaveBeenCalledWith('updated', update)
})

describe('resolveTrayIconPath', () => {
  it.each([true, false])('uses the bright G for a dark Windows shell (packaged=%s)', isPackaged => {
    expect(resolveTrayIconPath({
      platform: 'win32', isPackaged, appPath: 'C:\\app', resourcesPath: 'C:\\app\\resources', darkSystemTheme: true
    })).toBe(isPackaged ? 'C:\\app\\resources\\tray-icon-dark.png' : 'C:\\app\\build\\icon-tray-dark.png')
  })
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

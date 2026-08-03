import { describe, expect, it, vi } from 'vitest'
import { createMainWindow, resolveWindowIcon } from './window'

const electronMocks = vi.hoisted(() => ({
  options: [] as Array<Record<string, unknown>>,
  closeListeners: [] as Array<(event: { preventDefault: () => void }) => void>
}))

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getAppPath: vi.fn(() => 'C:\\source')
  },
  BrowserWindow: class {
    webContents = {
      on: vi.fn(),
      setWindowOpenHandler: vi.fn()
    }

    constructor(options: Record<string, unknown>) {
      electronMocks.options.push(options)
    }

    setIcon = vi.fn()
    once = vi.fn()
    hide = vi.fn()
    on = vi.fn(
      (
        event: string,
        listener: (event: { preventDefault: () => void }) => void
      ) => {
        if (event === 'close') {
          electronMocks.closeListeners.push(listener)
        }
      }
    )
  },
  nativeImage: {
    createFromPath: vi.fn(() => ({
      isEmpty: vi.fn(() => false)
    }))
  },
  shell: {
    openExternal: vi.fn()
  }
}))

describe('createMainWindow', () => {
  it('disables the system frame while preserving renderer isolation', () => {
    createMainWindow(() => false)

    expect(electronMocks.options.at(-1)).toMatchObject({
      frame: false,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true
      }
    })
  })

  it('keeps the custom close control aligned with close-to-tray behavior', () => {
    const window = createMainWindow(() => false) as unknown as {
      hide: () => void
    }
    const event = { preventDefault: vi.fn() }

    electronMocks.closeListeners.at(-1)?.(event)

    expect(event.preventDefault).toHaveBeenCalledOnce()
    expect(window.hide).toHaveBeenCalledOnce()
  })
})

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
        platform: 'win32',
        isPackaged: false,
        appPath: 'C:\\source',
        resourcesPath: 'C:\\source\\resources'
      })
    ).toBe('C:\\source\\build\\icon-taskbar.ico')
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

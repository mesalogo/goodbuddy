import { afterEach, describe, expect, it, vi } from 'vitest'
import { createMainWindow, loadMainWindow, resolveWindowIcon } from './window'
import { dialog } from 'electron'

const electronMocks = vi.hoisted(() => ({
  options: [] as Array<Record<string, unknown>>,
  closeListeners: [] as Array<(event: { preventDefault: () => void }) => void>
}))

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getLocale: vi.fn(() => 'en-US'),
    getAppPath: vi.fn(() => 'C:\\source')
  },
  BrowserWindow: class {
    webContents = {
      on: vi.fn(),
      reload: vi.fn(),
      isDestroyed: vi.fn(() => false),
      setWindowOpenHandler: vi.fn()
    }

    constructor(options: Record<string, unknown>) {
      electronMocks.options.push(options)
    }

    setIcon = vi.fn()
    isDestroyed = vi.fn(() => false)
    loadURL = vi.fn(async () => undefined)
    loadFile = vi.fn(async () => undefined)
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
  dialog: { showMessageBox: vi.fn(async () => ({ response: 1 })) },
  shell: {
    openExternal: vi.fn()
  }
}))

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

describe('window recovery', () => {
  function setup(shouldQuit = () => false) {
    const observe = vi.fn()
    const observedWindow = createMainWindow(shouldQuit, observe)
    const listeners = vi.mocked(observedWindow.webContents.on).mock.calls as unknown as Array<[string, unknown]>
    const gone = listeners.find(([event]) => event === 'render-process-gone')![1] as
      (event: unknown, details: { reason: string; exitCode: number }) => void
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    return { window: observedWindow, gone, observe, listeners }
  }

  it('logs a crash and reloads only after explicit confirmation, without duplicate dialogs', async () => {
    let respond!: (value: { response: number; checkboxChecked: boolean }) => void
    vi.mocked(dialog.showMessageBox).mockReturnValueOnce(new Promise(resolve => { respond = resolve }))
    const { window, gone, observe } = setup()
    const before = vi.mocked(dialog.showMessageBox).mock.calls.length
    gone({}, { reason: 'oom', exitCode: 9 })
    gone({}, { reason: 'crashed', exitCode: 1 })
    expect(dialog.showMessageBox).toHaveBeenCalledTimes(before + 1)
    expect(window.webContents.reload).not.toHaveBeenCalled()
    expect(observe).toHaveBeenCalledWith(expect.objectContaining({ code: 'desktop.renderer.gone' }))
    respond({ response: 0, checkboxChecked: false })
    await vi.waitFor(() => expect(window.webContents.reload).toHaveBeenCalledOnce())
    gone({}, { reason: 'crashed', exitCode: 1 })
    await Promise.resolve()
    expect(window.webContents.reload).toHaveBeenCalledOnce()
  })

  it('does not recover clean exits or shutdown, or reload a window destroyed during the dialog', async () => {
    let quitting = false
    const { window, gone, observe } = setup(() => quitting)
    gone({}, { reason: 'clean-exit', exitCode: 0 })
    quitting = true
    gone({}, { reason: 'crashed', exitCode: 1 })
    expect(observe).not.toHaveBeenCalled()
    quitting = false
    vi.mocked(dialog.showMessageBox).mockResolvedValueOnce({ response: 0, checkboxChecked: false })
    gone({}, { reason: 'crashed', exitCode: 1 })
    vi.mocked(window.isDestroyed).mockReturnValue(true)
    await Promise.resolve()
    expect(window.webContents.reload).not.toHaveBeenCalled()
  })

  it('handles dialog rejection and allows a later user-driven recovery', async () => {
    const { window, gone } = setup()
    vi.mocked(dialog.showMessageBox).mockRejectedValueOnce(new Error('dialog unavailable'))
    gone({}, { reason: 'crashed', exitCode: 1 })
    await vi.waitFor(() => expect(console.error).toHaveBeenCalledWith('GoodBuddy renderer recovery failed', expect.any(Error)))
    vi.mocked(dialog.showMessageBox).mockResolvedValueOnce({ response: 0, checkboxChecked: false })
    gone({}, { reason: 'crashed', exitCode: 1 })
    await vi.waitFor(() => expect(window.webContents.reload).toHaveBeenCalledOnce())
  })

  it('records main-frame load failures but ignores aborted navigation and subframes', () => {
    const { listeners, observe } = setup()
    const failed = listeners.find(([event]) => event === 'did-fail-load')![1] as
      (event: unknown, code: number, description: string, url: string, main: boolean) => void
    failed({}, -3, 'aborted', '', true)
    failed({}, -6, 'missing', '', false)
    expect(observe).not.toHaveBeenCalled()
    failed({}, -6, 'missing', '', true)
    expect(observe).toHaveBeenCalledWith(expect.objectContaining({ code: 'desktop.renderer.load-failed' }))
  })

  it.each([true, false])('consumes rejected load promises (development=%s)', async development => {
    vi.stubEnv('ELECTRON_RENDERER_URL', development ? 'http://localhost:5173' : '')
    const { window } = setup()
    vi.mocked(development ? window.loadURL : window.loadFile).mockRejectedValueOnce(new Error('load failed'))
    loadMainWindow(window, true)
    await vi.waitFor(() => expect(console.error).toHaveBeenCalledWith('GoodBuddy window load rejected', expect.any(Error)))
    if (development) expect(window.loadURL).toHaveBeenCalledWith('http://localhost:5173/?storageUpgrade=1')
    else expect(window.loadFile).toHaveBeenCalledWith(expect.any(String), { query: { storageUpgrade: '1' } })
  })
})

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

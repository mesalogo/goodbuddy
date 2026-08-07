import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { BrowserUrlPolicy } from './browser-url-policy'
import {
  ElectronBrowserSession,
  type BrowserPartitionSession,
  type BrowserWebContents,
  type BrowserWindowHandle,
  type FilteringProxyLike
} from './electron-browser-session'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

function createHarness() {
  const debuggerEvents = new EventEmitter()
  const contentEvents = new EventEmitter()
  const partitionEvents = new EventEmitter()
  let currentUrl = ''
  let openHandler: ((details: { url: string }) => { action: 'deny' }) | undefined
  const sendCommand = vi.fn(async () => ({}))
  const capturedImage = {
    getSize: () => ({ width: 1_280, height: 800 }),
    resize: vi.fn(),
    toJPEG: () => Buffer.from([0xff, 0xd8, 0xff, 0xd9])
  }
  capturedImage.resize.mockReturnValue(capturedImage)
  const webContents: BrowserWebContents = {
    debugger: {
      attach: vi.fn(),
      detach: vi.fn(),
      isAttached: vi.fn(() => true),
      sendCommand,
      on: (event, listener) =>
        debuggerEvents.on(
          event,
          listener as (...argumentsValue: unknown[]) => void
        ),
      off: (event, listener) =>
        debuggerEvents.off(
          event,
          listener as (...argumentsValue: unknown[]) => void
        )
    },
    on: (event, listener) =>
      contentEvents.on(
        event,
        listener as (...argumentsValue: unknown[]) => void
      ),
    off: (event, listener) =>
      contentEvents.off(
        event,
        listener as (...argumentsValue: unknown[]) => void
      ),
    setWindowOpenHandler: vi.fn((handler) => {
      openHandler = handler
    }),
    capturePage: vi.fn(async () => capturedImage),
    getURL: vi.fn(() => currentUrl),
    stop: vi.fn(),
    destroy: vi.fn(),
    isDestroyed: vi.fn(() => false)
  }
  const window: BrowserWindowHandle = {
    webContents,
    loadURL: vi.fn(async (url: string) => {
      currentUrl = url
    }),
    destroy: vi.fn(),
    isDestroyed: vi.fn(() => false)
  }
  let permissionCheck: ((...values: unknown[]) => boolean) | undefined
  let permissionRequest:
    | ((
        contents: unknown,
        permission: string,
        callback: (granted: boolean) => void,
        details: unknown
      ) => void)
    | undefined
  let displayMedia:
    | ((
        request: unknown,
        callback: (streams: Record<string, never>) => void
      ) => void)
    | undefined
  const partition: BrowserPartitionSession = {
    setPermissionCheckHandler: vi.fn((handler) => {
      permissionCheck = handler
    }),
    setPermissionRequestHandler: vi.fn((handler) => {
      permissionRequest = handler
    }),
    setDisplayMediaRequestHandler: vi.fn((handler) => {
      displayMedia = handler
    }),
    setProxy: vi.fn(async () => undefined),
    setUserAgent: vi.fn(),
    on: (event, listener) =>
      partitionEvents.on(
        event,
        listener as (...argumentsValue: unknown[]) => void
      ),
    off: (event, listener) =>
      partitionEvents.off(
        event,
        listener as (...argumentsValue: unknown[]) => void
      ),
    clearData: vi.fn(async () => undefined),
    closeAllConnections: vi.fn(async () => undefined)
  }
  const proxy: FilteringProxyLike = {
    start: vi.fn(async () => 'http://127.0.0.1:12345'),
    dispose: vi.fn(async () => undefined)
  }
  const policy = new BrowserUrlPolicy(async () => [
    { address: '93.184.216.34', family: 4 }
  ])
  return {
    contentEvents,
    debuggerEvents,
    partitionEvents,
    partition,
    proxy,
    policy,
    sendCommand,
    webContents,
    window,
    setCurrentUrl(value: string) {
      currentUrl = value
    },
    getOpenHandler: () => openHandler,
    getPermissionCheck: () => permissionCheck,
    getPermissionRequest: () => permissionRequest,
    getDisplayMedia: () => displayMedia
  }
}

describe('ElectronBrowserSession', () => {
  it('creates an isolated sandboxed partition and denies privileged capabilities', async () => {
    const harness = createHarness()
    const createWindow = vi.fn(async (options: Record<string, unknown>) => {
      const preferences = options.webPreferences as Record<string, unknown>
      expect(preferences).toMatchObject({
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
        allowRunningInsecureContent: false,
        devTools: false
      })
      return harness.window
    })
    const session = await ElectronBrowserSession.create({
      policy: harness.policy,
      createPartition: vi.fn(async () => harness.partition),
      createWindow,
      createProxy: () => harness.proxy
    })

    expect(session.partition).toMatch(/^browser-/u)
    expect(harness.partition.setProxy).toHaveBeenCalledWith({
      mode: 'fixed_servers',
      proxyRules: 'http://127.0.0.1:12345',
      proxyBypassRules: '<-loopback>'
    })
    expect(harness.partition.setUserAgent).toHaveBeenCalledWith(
      expect.stringMatching(/ Chrome\/.+ Safari\/537\.36$/u),
      'zh-CN,zh,en'
    )
    expect(
      vi.mocked(harness.partition.setUserAgent!).mock.calls[0]?.[0]
    ).not.toContain('Electron')
    expect(harness.getPermissionCheck()?.()).toBe(false)
    const permissionCallback = vi.fn()
    harness.getPermissionRequest()?.({}, 'geolocation', permissionCallback, {})
    expect(permissionCallback).toHaveBeenCalledWith(false)
    const mediaCallback = vi.fn()
    harness.getDisplayMedia()?.({}, mediaCallback)
    expect(mediaCallback).toHaveBeenCalledWith({})
    expect(harness.getOpenHandler()?.({ url: 'https://example.com' })).toEqual({
      action: 'deny'
    })
    expect(harness.window.loadURL).toHaveBeenCalledWith('about:blank')
    expect(
      vi.mocked(harness.window.loadURL).mock.invocationCallOrder[0]
    ).toBeLessThan(
      vi.mocked(harness.webContents.debugger.attach).mock
        .invocationCallOrder[0] ?? Number.POSITIVE_INFINITY
    )
    expect(harness.webContents.debugger.attach).toHaveBeenCalledWith('1.3')
    expect(harness.sendCommand).toHaveBeenCalledWith('Page.enable')
    expect(harness.sendCommand).toHaveBeenCalledWith(
      'Page.setInterceptFileChooserDialog',
      { enabled: true }
    )
    await expect(
      session.captureScreenshot(new AbortController().signal)
    ).resolves.toEqual({
      type: 'image',
      mimeType: 'image/jpeg',
      data: '/9j/2Q=='
    })

    const downloadEvent = { preventDefault: vi.fn() }
    const item = { cancel: vi.fn() }
    harness.partitionEvents.emit('will-download', downloadEvent, item)
    expect(downloadEvent.preventDefault).toHaveBeenCalled()
    expect(item.cancel).toHaveBeenCalled()
    harness.debuggerEvents.emit(
      'message',
      {},
      'Page.fileChooserOpened',
      {}
    )
    await vi.waitFor(() =>
      expect(harness.sendCommand).toHaveBeenCalledWith(
        'Page.handleFileChooser',
        { action: 'cancel' }
      )
    )
    await session.dispose()
  })

  it('allows HTTP(S) top-level navigation and cross-origin redirects', async () => {
    const harness = createHarness()
    const session = await ElectronBrowserSession.create({
      policy: harness.policy,
      createPartition: async () => harness.partition,
      createWindow: async () => harness.window,
      createProxy: () => harness.proxy
    })
    const target = await harness.policy.validate(
      'https://example.com/start',
      new AbortController().signal
    )
    session.approveNavigation(target)
    harness.setCurrentUrl('https://example.com/page')
    expect(session.getCurrentOrigin()).toBe('https://example.com')

    const sameOriginEvent = { preventDefault: vi.fn() }
    harness.contentEvents.emit(
      'will-navigate',
      sameOriginEvent,
      'https://example.com/next'
    )
    expect(sameOriginEvent.preventDefault).not.toHaveBeenCalled()
    const foreignEvent = { preventDefault: vi.fn() }
    harness.contentEvents.emit(
      'will-redirect',
      foreignEvent,
      'https://attacker.example/'
    )
    expect(foreignEvent.preventDefault).not.toHaveBeenCalled()

    harness.setCurrentUrl('https://attacker.example/')
    harness.contentEvents.emit(
      'did-navigate',
      {},
      'https://attacker.example/'
    )
    expect(harness.webContents.stop).not.toHaveBeenCalled()
    expect(session.getCurrentOrigin()).toBe('https://attacker.example')
    await expect(
      session.validateRedirect(
        'http://10.0.0.25/admin',
        new AbortController().signal
      )
    ).resolves.toBeUndefined()
    expect(session.getApprovedOrigin()).toBe('http://10.0.0.25')
    await session.dispose()
  })

  it('detaches listeners and clears isolated data on idempotent disposal', async () => {
    const harness = createHarness()
    const session = await ElectronBrowserSession.create({
      policy: harness.policy,
      createPartition: async () => harness.partition,
      createWindow: async () => harness.window,
      createProxy: () => harness.proxy
    })
    await session.dispose()
    await session.dispose()

    expect(harness.webContents.debugger.detach).toHaveBeenCalledOnce()
    expect(harness.window.destroy).toHaveBeenCalledOnce()
    expect(harness.partition.closeAllConnections).toHaveBeenCalledOnce()
    expect(harness.partition.clearData).toHaveBeenCalledOnce()
    expect(harness.proxy.dispose).toHaveBeenCalledOnce()
    expect(harness.contentEvents.listenerCount('will-navigate')).toBe(0)
    expect(harness.debuggerEvents.listenerCount('message')).toBe(0)
  })

  it('cleans up partially created resources when debugger setup fails', async () => {
    const harness = createHarness()
    harness.sendCommand.mockRejectedValueOnce(new Error('debugger failed'))
    await expect(
      ElectronBrowserSession.create({
        policy: harness.policy,
        createPartition: async () => harness.partition,
        createWindow: async () => harness.window,
        createProxy: () => harness.proxy
      })
    ).rejects.toThrow('无法创建安全浏览器会话')
    expect(harness.window.destroy).toHaveBeenCalled()
    expect(harness.partition.clearData).toHaveBeenCalled()
    expect(harness.proxy.dispose).toHaveBeenCalled()
  })

  it('reclaims a partition that resolves after setup times out', async () => {
    const harness = createHarness()
    const partitionGate = deferred<BrowserPartitionSession>()
    const creation = ElectronBrowserSession.create({
      policy: harness.policy,
      setupTimeoutMs: 5,
      createPartition: () => partitionGate.promise,
      createWindow: async () => harness.window,
      createProxy: () => harness.proxy
    })

    await expect(creation).rejects.toThrow('无法创建安全浏览器会话')
    partitionGate.resolve(harness.partition)
    await vi.waitFor(() =>
      expect(harness.partition.clearData).toHaveBeenCalledOnce()
    )
    expect(harness.partition.closeAllConnections).toHaveBeenCalledOnce()
  })

  it('destroys a hidden window that resolves after setup times out', async () => {
    const harness = createHarness()
    const windowGate = deferred<BrowserWindowHandle>()
    const creation = ElectronBrowserSession.create({
      policy: harness.policy,
      setupTimeoutMs: 5,
      createPartition: async () => harness.partition,
      createWindow: () => windowGate.promise,
      createProxy: () => harness.proxy
    })

    await expect(creation).rejects.toThrow('无法创建安全浏览器会话')
    windowGate.resolve(harness.window)
    await vi.waitFor(() => expect(harness.window.destroy).toHaveBeenCalledOnce())
    expect(harness.partition.clearData).toHaveBeenCalledOnce()
    expect(harness.proxy.dispose).toHaveBeenCalledOnce()
  })

  it('disposes a proxy whose start resolves after setup times out', async () => {
    const harness = createHarness()
    const proxyGate = deferred<string>()
    const proxy: FilteringProxyLike = {
      start: vi.fn(() => proxyGate.promise),
      dispose: vi.fn(async () => undefined)
    }
    const creation = ElectronBrowserSession.create({
      policy: harness.policy,
      setupTimeoutMs: 5,
      createPartition: async () => harness.partition,
      createWindow: async () => harness.window,
      createProxy: () => proxy
    })

    await expect(creation).rejects.toThrow('无法创建安全浏览器会话')
    proxyGate.resolve('http://127.0.0.1:12345')
    await vi.waitFor(() => expect(proxy.dispose).toHaveBeenCalledOnce())
  })
})

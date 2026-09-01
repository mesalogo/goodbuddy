import { randomUUID } from 'node:crypto'
import {
  BrowserUrlPolicy,
  canonicalizeBrowserUrl,
  type ValidatedBrowserUrl
} from './browser-url-policy'
import { FilteringProxy } from './filtering-proxy'
import type { BrowserScreenshot } from './browser-screenshot'
import { encodeBoundedJpeg } from '../bounded-jpeg'

export type BrowserEventListener = (...argumentsValue: never[]) => void

export type BrowserDebugger = {
  attach(protocolVersion?: string): void
  detach(): void
  isAttached(): boolean
  sendCommand(
    method: string,
    commandParams?: Record<string, unknown>
  ): Promise<unknown>
  on(event: string, listener: BrowserEventListener): unknown
  off(event: string, listener: BrowserEventListener): unknown
}

export type BrowserCapturedImage = {
  getSize(): { width: number; height: number }
  resize(options: {
    width: number
    quality: 'good'
  }): BrowserCapturedImage
  toJPEG(quality: number): Buffer
}

export type BrowserWebContents = {
  debugger: BrowserDebugger
  on(event: string, listener: BrowserEventListener): unknown
  off(event: string, listener: BrowserEventListener): unknown
  setWindowOpenHandler(
    handler: (details: { url: string }) => { action: 'deny' }
  ): void
  capturePage?(): Promise<BrowserCapturedImage>
  getURL(): string
  isLoadingMainFrame?(): boolean
  stop(): void
  close?(options?: { waitForBeforeUnload?: boolean }): void
  destroy(): void
  isDestroyed(): boolean
}

export type BrowserWindowHandle = {
  webContents: BrowserWebContents
  loadURL(url: string): Promise<unknown>
  show(): void
  minimize(): void
  restore(): void
  isMinimized(): boolean
  focus(): void
  on(event: string, listener: BrowserEventListener): unknown
  off(event: string, listener: BrowserEventListener): unknown
  destroy(): void
  isDestroyed(): boolean
}

export type BrowserParentWindowHandle = {
  setEnabled?(enabled: boolean): void
  focus?(): void
  isDestroyed?(): boolean
}

export type BrowserPartitionSession = {
  setPermissionCheckHandler(
    handler: (...argumentsValue: never[]) => boolean
  ): void
  setPermissionRequestHandler(
    handler: (
      webContents: unknown,
      permission: string,
      callback: (granted: boolean) => void,
      details: unknown
    ) => void
  ): void
  setDisplayMediaRequestHandler(
    handler: (
      request: unknown,
      callback: (streams: Record<string, never>) => void
    ) => void
  ): void
  setProxy(configuration: {
    mode: 'fixed_servers'
    proxyRules: string
    proxyBypassRules: string
  }): Promise<void>
  setUserAgent?(
    userAgent: string,
    acceptLanguages?: string
  ): void
  on(event: string, listener: BrowserEventListener): unknown
  off(event: string, listener: BrowserEventListener): unknown
  clearData(): Promise<void>
  closeAllConnections(): Promise<void>
}

export type FilteringProxyLike = {
  start(): Promise<string>
  dispose(): Promise<void>
}

export type ElectronBrowserSessionOptions = {
  policy: BrowserUrlPolicy
  cleanupTimeoutMs?: number
  setupTimeoutMs?: number
  createPartition?: (partition: string) => Promise<BrowserPartitionSession>
  createWindow?: (
    options: Record<string, unknown>
  ) => Promise<BrowserWindowHandle>
  createProxy?: (policy: BrowserUrlPolicy) => FilteringProxyLike
  parentWindow?: BrowserParentWindowHandle
}

type Listener = {
  target: { off(event: string, listener: BrowserEventListener): unknown }
  event: string
  listener: BrowserEventListener
}

function managedBrowserUserAgent(): string {
  const platform =
    process.platform === 'win32'
      ? 'Windows NT 10.0; Win64; x64'
      : process.platform === 'darwin'
        ? 'Macintosh; Intel Mac OS X 10_15_7'
        : `X11; Linux ${process.arch === 'arm64' ? 'aarch64' : 'x86_64'}`
  return `Mozilla/5.0 (${platform}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${process.versions.chrome ?? '136.0.0.0'} Safari/537.36`
}

async function cleanupIsolatedState(
  partitionSession: BrowserPartitionSession | undefined,
  proxy: FilteringProxyLike,
  timeoutMs: number
): Promise<void> {
  const cleanup = Promise.allSettled([
    partitionSession?.closeAllConnections() ?? Promise.resolve(),
    partitionSession?.clearData() ?? Promise.resolve(),
    proxy.dispose()
  ])
  let timer: ReturnType<typeof setTimeout> | undefined
  const results = await Promise.race([
    cleanup,
    new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () => reject(new Error('浏览器隔离数据清理超时')),
        timeoutMs
      )
    })
  ]).finally(() => {
    if (timer) {
      clearTimeout(timer)
    }
  })
  const failure = results.find((result) => result.status === 'rejected')
  if (failure?.status === 'rejected') {
    throw new Error('浏览器隔离数据清理失败', { cause: failure.reason })
  }
}

async function boundedSetup<T>(
  operation: Promise<T>,
  signal: AbortSignal,
  timeoutMs: number,
  cleanupLateValue?: (value: T) => void | Promise<void>
): Promise<T> {
  signal.throwIfAborted()
  const timeout = AbortSignal.timeout(timeoutMs)
  const effectiveSignal = AbortSignal.any([signal, timeout])
  return new Promise<T>((resolve, reject) => {
    const abort = (): void => {
      reject(
        signal.aborted
          ? signal.reason
          : new Error(`浏览器会话创建超时（${timeoutMs}ms）`)
      )
    }
    effectiveSignal.addEventListener('abort', abort, { once: true })
    void operation.then(
      (value) => {
        effectiveSignal.removeEventListener('abort', abort)
        if (effectiveSignal.aborted) {
          try {
            void Promise.resolve(cleanupLateValue?.(value)).catch(
              () => undefined
            )
          } catch {
            // Cleanup is best-effort after the caller has already timed out.
          }
          abort()
        } else {
          resolve(value)
        }
      },
      (error: unknown) => {
        effectiveSignal.removeEventListener('abort', abort)
        reject(error)
      }
    )
  })
}

async function defaultCreatePartition(
  partition: string
): Promise<BrowserPartitionSession> {
  const electron = await import('electron')
  return electron.session.fromPartition(
    partition
  ) as unknown as BrowserPartitionSession
}

async function defaultCreateWindow(
  options: Record<string, unknown>
): Promise<BrowserWindowHandle> {
  const electron = await import('electron')
  return new electron.BrowserWindow(options) as unknown as BrowserWindowHandle
}

export class ElectronBrowserSession {
  readonly partition: string
  readonly webContents: BrowserWebContents
  private approvedOrigin?: string
  private readonly listeners: Listener[] = []
  private interaction?: {
    promise: Promise<BrowserScreenshot | undefined>
    resolve(frame?: BrowserScreenshot): void
  }
  private interactionClosing?: Promise<void>
  private readonly loadingListeners = new Set<(isLoading: boolean) => void>()
  private loading = false
  private disposed = false

  private constructor(
    private readonly policy: BrowserUrlPolicy,
    private readonly partitionSession: BrowserPartitionSession,
    private readonly window: BrowserWindowHandle,
    private readonly proxy: FilteringProxyLike,
    partition: string,
    private readonly cleanupTimeoutMs: number,
    private readonly parentWindow?: BrowserParentWindowHandle
  ) {
    this.partition = partition
    this.webContents = window.webContents
  }

  static async create(
    options: ElectronBrowserSessionOptions,
    signal: AbortSignal = new AbortController().signal
  ): Promise<ElectronBrowserSession> {
    const partition = `browser-${randomUUID()}`
    const createPartition = options.createPartition ?? defaultCreatePartition
    const createWindow = options.createWindow ?? defaultCreateWindow
    const cleanupTimeoutMs = options.cleanupTimeoutMs ?? 5_000
    const setupTimeoutMs = options.setupTimeoutMs ?? 15_000
    if (!Number.isSafeInteger(cleanupTimeoutMs) || cleanupTimeoutMs < 1) {
      throw new Error('浏览器会话清理期限无效')
    }
    if (!Number.isSafeInteger(setupTimeoutMs) || setupTimeoutMs < 1) {
      throw new Error('浏览器会话创建期限无效')
    }
    const proxy =
      options.createProxy?.(options.policy) ??
      new FilteringProxy({ policy: options.policy })
    let proxyDisposal: Promise<void> | undefined
    const managedProxy: FilteringProxyLike = {
      start: () => proxy.start(),
      dispose: () => {
        proxyDisposal ??= proxy.dispose()
        return proxyDisposal
      }
    }
    let partitionSession: BrowserPartitionSession | undefined
    let window: BrowserWindowHandle | undefined
    let result: ElectronBrowserSession | undefined
    let setupStage = '启动代理'
    try {
      const proxyUrl = await boundedSetup(
        managedProxy.start(),
        signal,
        setupTimeoutMs,
        async () => managedProxy.dispose()
      )
      setupStage = '创建隔离会话'
      partitionSession = await boundedSetup(
        createPartition(partition),
        signal,
        setupTimeoutMs,
        async (latePartition) =>
          cleanupIsolatedState(
            latePartition,
            managedProxy,
            cleanupTimeoutMs
          )
      )
      partitionSession.setPermissionCheckHandler(() => false)
      partitionSession.setPermissionRequestHandler(
        (_contents, _permission, callback) => callback(false)
      )
      partitionSession.setDisplayMediaRequestHandler(
        (_request, callback) => callback({})
      )
      partitionSession.setUserAgent?.(
        managedBrowserUserAgent(),
        'zh-CN,zh,en'
      )
      setupStage = '配置网络代理'
      await boundedSetup(
        partitionSession.setProxy({
          mode: 'fixed_servers',
          proxyRules: proxyUrl,
          proxyBypassRules: '<-loopback>'
        }),
        signal,
        setupTimeoutMs
      )
      setupStage = '创建浏览器窗口'
      window = await boundedSetup(
        createWindow({
          show: false,
          width: 1280,
          height: 900,
          title: 'GoodBuddy 浏览器交互',
          autoHideMenuBar: true,
          ...(options.parentWindow
            ? {
                parent: options.parentWindow
              }
            : {}),
          webPreferences: {
            partition,
            sandbox: true,
            contextIsolation: true,
            nodeIntegration: false,
            nodeIntegrationInSubFrames: false,
            nodeIntegrationInWorker: false,
            backgroundThrottling: false,
            webSecurity: true,
            allowRunningInsecureContent: false,
            plugins: false,
            devTools: false,
            safeDialogs: true
          }
        }),
        signal,
        setupTimeoutMs,
        (lateWindow) => {
          if (!lateWindow.isDestroyed()) {
            lateWindow.destroy()
          } else if (!lateWindow.webContents.isDestroyed()) {
            lateWindow.webContents.destroy()
          }
        }
      )
      setupStage = '加载初始页面'
      await boundedSetup(
        window.loadURL('about:blank'),
        signal,
        setupTimeoutMs
      )
      result = new ElectronBrowserSession(
        options.policy,
        partitionSession,
        window,
        managedProxy,
        partition,
        cleanupTimeoutMs,
        options.parentWindow
      )
      setupStage = '初始化浏览器协议'
      await boundedSetup(result.initialize(), signal, setupTimeoutMs)
      return result
    } catch (error) {
      if (result) {
        await result.dispose().catch(() => undefined)
      } else if (window && !window.isDestroyed()) {
        window.destroy()
        await cleanupIsolatedState(
          partitionSession,
          managedProxy,
          cleanupTimeoutMs
        ).catch(() => undefined)
      } else {
        await cleanupIsolatedState(
          partitionSession,
          managedProxy,
          cleanupTimeoutMs
        ).catch(() => undefined)
      }
      const detail =
        error instanceof Error && error.message
          ? error.message.slice(0, 160)
          : '未知错误'
      throw new Error(
        `无法创建安全浏览器会话：${setupStage}失败（${detail}）`,
        { cause: error }
      )
    }
  }

  private listen(
    target: Listener['target'] & {
      on(event: string, listener: BrowserEventListener): unknown
    },
    event: string,
    listener: BrowserEventListener
  ): void {
    target.on(event, listener)
    this.listeners.push({ target, event, listener })
  }

  private async initialize(): Promise<void> {
    const contents = this.webContents
    this.loading = contents.isLoadingMainFrame?.() ?? false
    this.listen(contents, 'did-start-loading', () => {
      this.setLoading(true)
    })
    this.listen(contents, 'did-stop-loading', () => {
      this.setLoading(contents.isLoadingMainFrame?.() ?? false)
    })
    this.listen(
      this.window,
      'close',
      (event: { preventDefault(): void }) => {
        if (this.disposed) {
          return
        }
        event.preventDefault()
        if (this.interaction) {
          void this.captureAndFinishInteraction()
        } else {
          this.window.minimize()
        }
      }
    )
    contents.setWindowOpenHandler(() => ({ action: 'deny' }))
    this.listen(contents, 'will-navigate', (event: { preventDefault(): void }, details: { url?: string } | string) => {
      const url = typeof details === 'string' ? details : details.url
      if (!url || !this.updateOriginFromUrl(url)) {
        event.preventDefault()
      }
    })
    this.listen(contents, 'will-redirect', (event: { preventDefault(): void }, details: { url?: string } | string) => {
      const url = typeof details === 'string' ? details : details.url
      if (!url || !this.updateOriginFromUrl(url)) {
        event.preventDefault()
      }
    })
    this.listen(contents, 'login', (
      event: { preventDefault(): void },
      _details: unknown,
      _authInfo: unknown,
      callback: () => void
    ) => {
      event.preventDefault()
      callback()
    })
    this.listen(contents, 'select-client-certificate', (
      event: { preventDefault(): void },
      _url: string,
      _certificates: unknown[],
      callback: (certificate?: unknown) => void
    ) => {
      event.preventDefault()
      callback()
    })
    this.listen(contents, 'did-navigate', (_event: unknown, url: string) => {
      if (url && !this.updateOriginFromUrl(url)) {
        contents.stop()
      }
    })
    this.listen(
      this.partitionSession,
      'will-download',
      (event: { preventDefault(): void }, item: { cancel?(): void }) => {
        event.preventDefault()
        item.cancel?.()
      }
    )
    contents.debugger.attach('1.3')
    await contents.debugger.sendCommand('Page.enable')
    this.assertOpen()
    await contents.debugger.sendCommand('Accessibility.enable')
    this.assertOpen()
    await contents.debugger.sendCommand('Page.setInterceptFileChooserDialog', {
      enabled: true
    })
    this.assertOpen()
    this.listen(
      contents.debugger,
      'message',
      (_event: unknown, method: string) => {
        if (method === 'Page.fileChooserOpened') {
          void contents.debugger
            .sendCommand('Page.handleFileChooser', { action: 'cancel' })
            .catch(() => undefined)
        }
      }
    )
  }

  private assertOpen(): void {
    if (this.disposed) {
      throw new Error('浏览器会话已关闭')
    }
  }

  private updateOriginFromUrl(input: string): boolean {
    try {
      this.approvedOrigin = canonicalizeBrowserUrl(input).origin
      return true
    } catch {
      return false
    }
  }

  approveNavigation(target: ValidatedBrowserUrl): void {
    if (this.disposed) {
      throw new Error('浏览器会话已关闭')
    }
    this.approvedOrigin = target.origin
  }

  getApprovedOrigin(): string | undefined {
    return this.approvedOrigin
  }

  getCurrentOrigin(): string | undefined {
    const current = this.webContents.getURL()
    if (!current) {
      return undefined
    }
    try {
      return canonicalizeBrowserUrl(current).origin
    } catch {
      return undefined
    }
  }

  isLoading(): boolean {
    return this.loading
  }

  onLoadingChange(listener: (isLoading: boolean) => void): () => void {
    this.assertOpen()
    this.loadingListeners.add(listener)
    return () => {
      this.loadingListeners.delete(listener)
    }
  }

  private setLoading(isLoading: boolean): void {
    if (this.loading === isLoading) {
      return
    }
    this.loading = isLoading
    for (const listener of this.loadingListeners) {
      listener(isLoading)
    }
  }

  stopLoading(): void {
    this.assertOpen()
    this.webContents.stop()
  }

  async captureScreenshot(
    signal: AbortSignal
  ): Promise<BrowserScreenshot> {
    this.assertOpen()
    if (!this.webContents.capturePage) {
      throw new Error('浏览器原生画面捕获不可用')
    }
    const image = await boundedSetup(
      this.webContents.capturePage(),
      signal,
      2_000
    )
    this.assertOpen()
    const data = encodeBoundedJpeg(image)
    return {
      type: 'image',
      mimeType: 'image/jpeg',
      data: data.toString('base64')
    }
  }

  async validateRedirect(url: string, signal: AbortSignal): Promise<void> {
    const target = await this.policy.validateRedirect(url, signal)
    this.approvedOrigin = target.origin
  }

  openInteraction(): Promise<BrowserScreenshot | undefined> {
    this.assertOpen()
    if (this.interaction) {
      this.setParentEnabled(false)
      if (this.window.isMinimized()) {
        this.window.restore()
      }
      this.window.show()
      this.window.focus()
      return this.interaction.promise
    }
    let resolve!: (frame?: BrowserScreenshot) => void
    const promise = new Promise<BrowserScreenshot | undefined>(
      (resolvePromise) => {
        resolve = resolvePromise
      }
    )
    this.interaction = { promise, resolve }
    this.setParentEnabled(false)
    try {
      if (this.window.isMinimized()) {
        this.window.restore()
      }
      this.window.show()
      this.window.focus()
    } catch (error) {
      this.finishInteraction()
      throw error
    }
    return promise
  }

  private captureAndFinishInteraction(): Promise<void> {
    if (this.interactionClosing) {
      return this.interactionClosing
    }
    const operation = (async (): Promise<void> => {
      let frame: BrowserScreenshot | undefined
      try {
        frame = await this.captureScreenshot(AbortSignal.timeout(2_000))
      } catch {
        // The session remains usable even if the final visible frame fails.
      }
      try {
        if (!this.disposed && !this.window.isDestroyed()) {
          this.window.minimize()
        }
      } catch {
        // Resolving interaction must not depend on native minimize success.
      }
      this.finishInteraction(frame)
    })()
    this.interactionClosing = operation
    void operation.finally(() => {
      if (this.interactionClosing === operation) {
        this.interactionClosing = undefined
      }
    })
    return operation
  }

  private finishInteraction(frame?: BrowserScreenshot): void {
    const interaction = this.interaction
    this.interaction = undefined
    this.setParentEnabled(true)
    interaction?.resolve(frame)
  }

  private setParentEnabled(enabled: boolean): void {
    try {
      if (
        !this.parentWindow ||
        this.parentWindow.isDestroyed?.() === true
      ) {
        return
      }
      this.parentWindow.setEnabled?.(enabled)
      if (enabled) {
        this.parentWindow.focus?.()
      }
    } catch {
      // Parent-window state must not break browser-session cleanup.
    }
  }

  async dispose(): Promise<void> {
    if (this.disposed) {
      return
    }
    this.disposed = true
    this.approvedOrigin = undefined
    this.loadingListeners.clear()
    this.finishInteraction()
    for (const { target, event, listener } of this.listeners.splice(0)) {
      target.off(event, listener)
    }
    if (this.webContents.debugger.isAttached()) {
      this.webContents.debugger.detach()
    }
    this.webContents.stop()
    if (!this.window.isDestroyed()) {
      this.window.destroy()
    } else if (!this.webContents.isDestroyed()) {
      this.webContents.destroy()
    }
    await cleanupIsolatedState(
      this.partitionSession,
      this.proxy,
      this.cleanupTimeoutMs
    )
  }
}

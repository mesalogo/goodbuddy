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
  loadURL?(url: string): Promise<unknown>
  getURL(): string
  isLoadingMainFrame?(): boolean
  stop(): void
  close?(options?: { waitForBeforeUnload?: boolean }): void
  destroy(): void
  isDestroyed(): boolean
}

export type BrowserViewHandle = {
  webContents: BrowserWebContents
  nativeView?: unknown
  setVisible(visible: boolean): void
  setBounds(bounds: BrowserWindowBounds): void
}

export type BrowserParentWindowHandle = {
  contentView?: {
    addChildView(view: unknown): void
    removeChildView(view: unknown): void
  }
  isDestroyed?(): boolean
}

export type BrowserWindowBounds = {
  x: number
  y: number
  width: number
  height: number
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
  createView?: (
    options: Record<string, unknown>
  ) => Promise<BrowserViewHandle>
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

async function defaultCreateView(
  options: Record<string, unknown>
): Promise<BrowserViewHandle> {
  const electron = await import('electron')
  const view = new electron.WebContentsView(options)
  view.setVisible(false)
  return {
    nativeView: view,
    webContents: view.webContents as unknown as BrowserWebContents,
    setVisible: (visible) => view.setVisible(visible),
    setBounds: (bounds) => view.setBounds(bounds)
  }
}

export class ElectronBrowserSession {
  readonly partition: string
  readonly webContents: BrowserWebContents
  private approvedOrigin?: string
  private readonly listeners: Listener[] = []
  private readonly loadingListeners = new Set<(isLoading: boolean) => void>()
  private readonly navigationListeners = new Set<(url: string) => void>()
  private loading = false
  private disposed = false

  private constructor(
    private readonly policy: BrowserUrlPolicy,
    private readonly partitionSession: BrowserPartitionSession,
    private readonly view: BrowserViewHandle,
    private readonly proxy: FilteringProxyLike,
    partition: string,
    private readonly cleanupTimeoutMs: number,
    private readonly parentWindow?: BrowserParentWindowHandle
  ) {
    this.partition = partition
    this.webContents = view.webContents
  }

  static async create(
    options: ElectronBrowserSessionOptions,
    signal: AbortSignal = new AbortController().signal
  ): Promise<ElectronBrowserSession> {
    const partition = `browser-${randomUUID()}`
    const createPartition = options.createPartition ?? defaultCreatePartition
    const createView = options.createView ?? defaultCreateView
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
    let view: BrowserViewHandle | undefined
    let viewAttached = false
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
      setupStage = '创建浏览器视图'
      view = await boundedSetup(
        createView({
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
        (lateView) => {
          if (!lateView.webContents.isDestroyed()) {
            lateView.webContents.close?.({ waitForBeforeUnload: false })
            if (!lateView.webContents.isDestroyed()) {
              lateView.webContents.destroy()
            }
          }
        }
      )
      if (options.parentWindow?.contentView && view.nativeView) {
        options.parentWindow.contentView.addChildView(view.nativeView)
        viewAttached = true
      }
      setupStage = '加载初始页面'
      if (!view.webContents.loadURL) {
        throw new Error('浏览器视图导航不可用')
      }
      await boundedSetup(
        view.webContents.loadURL('about:blank'),
        signal,
        setupTimeoutMs
      )
      result = new ElectronBrowserSession(
        options.policy,
        partitionSession,
        view,
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
      } else if (view) {
        if (viewAttached && view.nativeView) {
          options.parentWindow?.contentView?.removeChildView(view.nativeView)
        }
        if (!view.webContents.isDestroyed()) {
          view.webContents.close?.({ waitForBeforeUnload: false })
          if (!view.webContents.isDestroyed()) {
            view.webContents.destroy()
          }
        }
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
        return
      }
      if (url) {
        this.emitNavigation(url)
      }
    })
    this.listen(contents, 'did-navigate-in-page', (_event: unknown, url: string) => {
      if (url) {
        this.emitNavigation(url)
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

  onNavigationChange(listener: (url: string) => void): () => void {
    this.assertOpen()
    this.navigationListeners.add(listener)
    return () => {
      this.navigationListeners.delete(listener)
    }
  }

  private emitNavigation(url: string): void {
    for (const listener of this.navigationListeners) {
      listener(url)
    }
  }

  setViewport(bounds?: BrowserWindowBounds): void {
    this.assertOpen()
    if (!bounds) {
      this.view.setVisible(false)
      return
    }
    this.view.setBounds(bounds)
    this.view.setVisible(true)
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

  async dispose(): Promise<void> {
    if (this.disposed) {
      return
    }
    this.disposed = true
    this.approvedOrigin = undefined
    this.loadingListeners.clear()
    this.navigationListeners.clear()
    for (const { target, event, listener } of this.listeners.splice(0)) {
      target.off(event, listener)
    }
    if (this.webContents.debugger.isAttached()) {
      this.webContents.debugger.detach()
    }
    this.webContents.stop()
    this.view.setVisible(false)
    if (this.view.nativeView) {
      this.parentWindow?.contentView?.removeChildView(this.view.nativeView)
    }
    if (!this.webContents.isDestroyed()) {
      this.webContents.close?.({ waitForBeforeUnload: false })
      if (!this.webContents.isDestroyed()) {
        this.webContents.destroy()
      }
    }
    await cleanupIsolatedState(
      this.partitionSession,
      this.proxy,
      this.cleanupTimeoutMs
    )
  }
}

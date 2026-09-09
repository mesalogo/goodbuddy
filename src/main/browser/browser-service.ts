import { randomUUID } from 'node:crypto'
import { BrowserUrlPolicy, canonicalizeBrowserUrl } from './browser-url-policy'
import {
  CdpBrowserDriver,
  type BrowserHistoryTarget,
  type BrowserNavigationMetadata,
  type BrowserSnapshot
} from './cdp-browser-driver'
import type { BrowserScreenshot } from './browser-screenshot'
import {
  ElectronBrowserSession,
  type BrowserParentWindowHandle,
  type BrowserWindowBounds,
  type BrowserWebContents
} from './electron-browser-session'
import type {
  BrowserLiveState,
  BrowserTabId,
  BrowserTabSummary
} from '../../shared/contracts'

const DEFAULT_IDLE_TIMEOUT_MS = 10 * 60_000
const DEFAULT_CLEANUP_TIMEOUT_MS = 5_000
const DEFAULT_MAXIMUM_TABS_PER_CONVERSATION = 8
const DEFAULT_MAXIMUM_TABS_PER_WINDOW = 16

export class BrowserNavigationStoppedError extends Error {
  constructor() {
    super('浏览器导航已停止，可继续使用当前页面')
    this.name = 'BrowserNavigationStoppedError'
  }
}

export const BROWSER_TAB_IN_USE_ERROR =
  '浏览器标签页正在被活动请求使用，无法关闭'

export type BrowserTabUsageLease = {
  readonly conversationId: string
  readonly tabId: BrowserTabId
  readonly owner: string
  readonly signal: AbortSignal
  release(): void
}

export type BrowserSessionLike = {
  readonly webContents: BrowserWebContents
  approveNavigation(
    target: Awaited<ReturnType<BrowserUrlPolicy['validate']>>
  ): void
  createTab?(signal: AbortSignal): Promise<BrowserSessionLike>
  getCurrentOrigin(): string | undefined
  isLoading(): boolean
  onLoadingChange(listener: (isLoading: boolean) => void): () => void
  onNavigationChange?(listener: (url: string) => void): () => void
  setViewport?(bounds?: BrowserWindowBounds): void
  stopLoading(): void
  captureScreenshot?(signal: AbortSignal): Promise<BrowserScreenshot>
  dispose(): Promise<void>
}

export type BrowserDriverLike = {
  navigate(url: string, signal: AbortSignal): Promise<{ url: string }>
  reload(signal: AbortSignal): Promise<{ url: string }>
  snapshot(signal: AbortSignal): Promise<BrowserSnapshot>
  click(ref: string, signal: AbortSignal): Promise<void>
  type(ref: string, text: string, signal: AbortSignal): Promise<void>
  select(ref: string, value: string, signal: AbortSignal): Promise<void>
  getBackTarget(signal: AbortSignal): Promise<BrowserHistoryTarget>
  backTo(
    target: BrowserHistoryTarget,
    signal: AbortSignal
  ): Promise<{ url: string }>
  getNavigationMetadata(
    signal: AbortSignal
  ): Promise<BrowserNavigationMetadata>
  screenshot(signal: AbortSignal): Promise<BrowserScreenshot>
  dispose(): void
}

export type BrowserServiceOptions = {
  policy?: BrowserUrlPolicy
  maximumSessions?: number
  maximumTabsPerConversation?: number
  maximumTabsPerWindow?: number
  idleTimeoutMs?: number
  cleanupTimeoutMs?: number
  liveFrameDelayMs?: number
  parentWindow?: BrowserParentWindowHandle
  createSession?: (
    policy: BrowserUrlPolicy,
    signal: AbortSignal
  ) => Promise<BrowserSessionLike>
  createDriver?: (webContents: BrowserWebContents) => BrowserDriverLike
}

type ActiveOperation = {
  controller: AbortController
  stopLoadingAllowed: boolean
  status: 'loading' | 'acting' | 'interactive'
}

type BrowserTabSlot = {
  conversationId: string
  tabId: BrowserTabId
  session: BrowserSessionLike
  driver: BrowserDriverLike
  createdAt: number
  origin?: string
  tail: Promise<void>
  active?: ActiveOperation
  isLoading: boolean
  stopLoadingRequested: boolean
  removeLoadingListener: () => void
  removeNavigationListener: () => void
  released: boolean
  workbarInstanceId?: string
  usageLeases: Map<symbol, {
    owner: string
    controller: AbortController
  }>
}

type BrowserConversationSlot = {
  conversationId: string
  ownerWindowId?: number
  tabs: Map<BrowserTabId, BrowserTabSlot>
  primaryTabId: BrowserTabId
  tabCreationTail: Promise<void>
  lifecycle: AbortController
  ownedTabs: Map<string, BrowserTabId>
  idleTimer?: ReturnType<typeof setTimeout>
  lastUsedAt: number
  released: boolean
}

type ConversationCreation = {
  controller: AbortController
  promise: Promise<BrowserConversationSlot>
  waiters: Set<symbol>
  ownerWindowId?: number
}

type ViewportLease = {
  leaseToken: string
  ownerWindowId?: number
  conversationId?: string
  tabId?: BrowserTabId
  bounds?: BrowserWindowBounds
}

type OwnedTabCreation = {
  conversationId: string
  controller: AbortController
  promise: Promise<BrowserTabSummary>
  waiters: Set<symbol>
}

function waitFor<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted()
  return new Promise<T>((resolve, reject) => {
    const abort = (): void => reject(signal.reason)
    signal.addEventListener('abort', abort, { once: true })
    void promise.then(
      (value) => {
        signal.removeEventListener('abort', abort)
        resolve(value)
      },
      (error: unknown) => {
        signal.removeEventListener('abort', abort)
        reject(error)
      }
    )
  })
}

async function boundedCleanup(
  cleanup: Promise<void>,
  timeoutMs: number
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      cleanup,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error('浏览器会话清理超时')),
          timeoutMs
        )
      })
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

async function defaultCreateSession(
  policy: BrowserUrlPolicy,
  signal: AbortSignal,
  parentWindow?: BrowserParentWindowHandle
): Promise<BrowserSessionLike> {
  return ElectronBrowserSession.create(
    { policy, ...(parentWindow ? { parentWindow } : {}) },
    signal
  )
}

function defaultCreateDriver(webContents: BrowserWebContents): BrowserDriverLike {
  return new CdpBrowserDriver(webContents)
}

function createTabId(): BrowserTabId {
  return randomUUID() as BrowserTabId
}

function stateKey(conversationId: string, tabId: BrowserTabId): string {
  return `${conversationId}\u0000${tabId}`
}

function ownershipKey(conversationId: string, workbarInstanceId: string): string {
  return `${conversationId}\u0000${workbarInstanceId}`
}

export class BrowserService {
  private readonly policy: BrowserUrlPolicy
  private readonly maximumSessions: number
  private readonly maximumTabsPerConversation: number
  private readonly maximumTabsPerWindow: number
  private readonly idleTimeoutMs: number
  private readonly cleanupTimeoutMs: number
  private readonly liveFrameDelayMs: number
  private readonly createSession: NonNullable<BrowserServiceOptions['createSession']>
  private readonly createDriver: NonNullable<BrowserServiceOptions['createDriver']>
  private readonly conversations = new Map<string, BrowserConversationSlot>()
  private readonly creations = new Map<string, ConversationCreation>()
  private readonly releaseRequests = new Set<string>()
  private readonly pendingConversationTabs = new Map<string, number>()
  private readonly pendingWindowTabs = new Map<number, number>()
  private readonly stateListeners = new Set<(state: BrowserLiveState) => void>()
  private readonly liveStates = new Map<string, BrowserLiveState>()
  private readonly ownedTabCreations = new Map<string, OwnedTabCreation>()
  private viewport?: ViewportLease
  private lifecycle = new AbortController()
  private clearOperation?: Promise<void>
  private clearing = false
  private disposed = false

  constructor(options: BrowserServiceOptions = {}) {
    this.policy = options.policy ?? new BrowserUrlPolicy()
    this.maximumSessions = options.maximumSessions ?? 3
    this.maximumTabsPerConversation =
      options.maximumTabsPerConversation ?? DEFAULT_MAXIMUM_TABS_PER_CONVERSATION
    this.maximumTabsPerWindow =
      options.maximumTabsPerWindow ?? DEFAULT_MAXIMUM_TABS_PER_WINDOW
    this.idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS
    this.cleanupTimeoutMs = options.cleanupTimeoutMs ?? DEFAULT_CLEANUP_TIMEOUT_MS
    this.liveFrameDelayMs = options.liveFrameDelayMs ?? 100
    this.createSession =
      options.createSession ??
      ((policy, signal) => defaultCreateSession(policy, signal, options.parentWindow))
    this.createDriver = options.createDriver ?? defaultCreateDriver
    for (const value of [
      this.maximumSessions,
      this.maximumTabsPerConversation,
      this.maximumTabsPerWindow,
      this.idleTimeoutMs,
      this.cleanupTimeoutMs
    ]) {
      if (!Number.isSafeInteger(value) || value < 1) {
        throw new Error('浏览器服务限制配置无效')
      }
    }
    if (!Number.isSafeInteger(this.liveFrameDelayMs) || this.liveFrameDelayMs < 0) {
      throw new Error('浏览器服务限制配置无效')
    }
  }

  getOrigin(conversationId: string, tabId?: BrowserTabId): string | undefined {
    const conversation = this.conversations.get(conversationId)
    return conversation?.tabs.get(tabId ?? conversation.primaryTabId)?.origin
  }

  getSessionCount(): number {
    return this.conversations.size
  }

  getTabCount(conversationId?: string): number {
    if (conversationId) return this.conversations.get(conversationId)?.tabs.size ?? 0
    let count = 0
    for (const conversation of this.conversations.values()) count += conversation.tabs.size
    return count
  }

  getOwnerWindowId(conversationId: string): number | undefined {
    return this.conversations.get(conversationId)?.ownerWindowId ??
      this.creations.get(conversationId)?.ownerWindowId
  }

  onState(listener: (state: BrowserLiveState) => void): () => void {
    this.stateListeners.add(listener)
    for (const state of this.liveStates.values()) listener(state)
    return () => this.stateListeners.delete(listener)
  }

  setViewport(
    conversationId?: string,
    bounds?: BrowserWindowBounds,
    tabId?: BrowserTabId,
    leaseToken?: string,
    ownerWindowId?: number
  ): boolean {
    if (!leaseToken) {
      throw new Error('浏览器视口租约无效')
    }
    if (!conversationId && this.viewport?.leaseToken !== leaseToken) return false
    if (!conversationId && ownerWindowId !== undefined && this.viewport?.ownerWindowId !== ownerWindowId) return false
    let effectiveTabId = tabId
    if (conversationId && bounds) {
      const conversation = this.conversations.get(conversationId)
      if (conversation) {
        this.assertWindowOwner(conversation, ownerWindowId)
        effectiveTabId ??= conversation.primaryTabId
        if (!conversation.tabs.has(effectiveTabId)) {
          throw new Error('浏览器标签页不存在或不属于当前对话')
        }
      }
    } else if (conversationId || bounds || tabId) {
      throw new Error('浏览器视口参数不完整')
    }
    this.viewport = {
      leaseToken,
      ...(ownerWindowId !== undefined ? { ownerWindowId } : {}),
      ...(conversationId ? { conversationId } : {}),
      ...(effectiveTabId ? { tabId: effectiveTabId } : {}),
      ...(bounds ? { bounds } : {})
    }
    this.applyViewport()
    return true
  }

  private applyViewport(): void {
    for (const conversation of this.conversations.values()) {
      for (const tab of conversation.tabs.values()) {
        const visible =
          this.viewport?.conversationId === conversation.conversationId &&
          (this.viewport.tabId ?? conversation.primaryTabId) === tab.tabId
        tab.session.setViewport?.(visible ? this.viewport?.bounds : undefined)
      }
    }
  }

  private emitState(
    tab: Pick<BrowserTabSlot, 'conversationId' | 'tabId'>,
    status: BrowserLiveState['status'],
    update: Partial<Pick<BrowserLiveState, 'url' | 'frameDataUrl' | 'error' | 'canGoBack' | 'isLoading'>> = {}
  ): void {
    const key = stateKey(tab.conversationId, tab.tabId)
    const previous = this.liveStates.get(key)
    const current = this.conversations.get(tab.conversationId)?.tabs.get(tab.tabId)
    const state: BrowserLiveState = {
      conversationId: tab.conversationId,
      tabId: tab.tabId,
      ...(current
        ? this.conversations.get(tab.conversationId)?.ownerWindowId !== undefined
          ? { ownerWindowId: this.conversations.get(tab.conversationId)!.ownerWindowId }
          : {}
        : previous?.ownerWindowId !== undefined
          ? { ownerWindowId: previous.ownerWindowId }
          : this.creations.get(tab.conversationId)?.ownerWindowId !== undefined
            ? { ownerWindowId: this.creations.get(tab.conversationId)!.ownerWindowId }
            : {}),
      status,
      sessionActive: status !== 'creating' && status !== 'stopped' && Boolean(current && !current.released),
      isLoading:
        update.isLoading ??
        (status === 'creating' ? true : status === 'stopped' ? false : current?.isLoading ?? false),
      canGoBack: update.canGoBack ?? previous?.canGoBack ?? false,
      ...(previous?.url ? { url: previous.url } : {}),
      ...(status !== 'stopped' && previous?.frameDataUrl ? { frameDataUrl: previous.frameDataUrl } : {}),
      ...update,
      updatedAt: Date.now()
    }
    if (status !== 'failed') delete state.error
    if (status === 'stopped') this.liveStates.delete(key)
    else this.liveStates.set(key, state)
    for (const listener of this.stateListeners) {
      try {
        listener(state)
      } catch {
        // UI observers cannot interrupt browser control.
      }
    }
  }

  private assertWindowOwner(
    conversation: BrowserConversationSlot,
    ownerWindowId?: number
  ): void {
    if (ownerWindowId === undefined) return
    if (conversation.ownerWindowId === undefined) {
      conversation.ownerWindowId = ownerWindowId
      return
    }
    if (conversation.ownerWindowId !== ownerWindowId) {
      throw new Error('浏览器对话不属于当前窗口')
    }
  }

  private countWindowTabs(ownerWindowId: number): number {
    let count = 0
    for (const conversation of this.conversations.values()) {
      if (conversation.ownerWindowId === ownerWindowId) count += conversation.tabs.size
    }
    return count
  }

  private assertTabCapacity(
    conversation: BrowserConversationSlot | undefined,
    ownerWindowId?: number
  ): void {
    if (
      conversation &&
      conversation.tabs.size +
        (this.pendingConversationTabs.get(conversation.conversationId) ?? 0) >=
        this.maximumTabsPerConversation
    ) {
      throw new Error(`当前对话的浏览器标签页已达到 ${this.maximumTabsPerConversation} 个上限`)
    }
    if (
      ownerWindowId !== undefined &&
      this.countWindowTabs(ownerWindowId) +
        (this.pendingWindowTabs.get(ownerWindowId) ?? 0) >=
        this.maximumTabsPerWindow
    ) {
      throw new Error(`当前窗口的浏览器标签页已达到 ${this.maximumTabsPerWindow} 个上限`)
    }
  }

  private reserveTab(conversationId: string, ownerWindowId?: number): () => void {
    const conversation = this.conversations.get(conversationId)
    this.assertTabCapacity(conversation, ownerWindowId)
    this.pendingConversationTabs.set(
      conversationId,
      (this.pendingConversationTabs.get(conversationId) ?? 0) + 1
    )
    if (ownerWindowId !== undefined) {
      this.pendingWindowTabs.set(
        ownerWindowId,
        (this.pendingWindowTabs.get(ownerWindowId) ?? 0) + 1
      )
    }
    return () => {
      const conversationPending =
        (this.pendingConversationTabs.get(conversationId) ?? 1) - 1
      if (conversationPending > 0) {
        this.pendingConversationTabs.set(conversationId, conversationPending)
      } else {
        this.pendingConversationTabs.delete(conversationId)
      }
      if (ownerWindowId !== undefined) {
        const windowPending =
          (this.pendingWindowTabs.get(ownerWindowId) ?? 1) - 1
        if (windowPending > 0) {
          this.pendingWindowTabs.set(ownerWindowId, windowPending)
        } else {
          this.pendingWindowTabs.delete(ownerWindowId)
        }
      }
    }
  }

  private async createTabSlot(
    conversation: BrowserConversationSlot | undefined,
    conversationId: string,
    session: BrowserSessionLike,
    tabId: BrowserTabId,
    workbarInstanceId?: string
  ): Promise<BrowserTabSlot> {
    let driver: BrowserDriverLike
    try {
      driver = this.createDriver(session.webContents)
    } catch (error) {
      await boundedCleanup(session.dispose(), this.cleanupTimeoutMs).catch(() => undefined)
      throw error
    }
    const tab: BrowserTabSlot = {
      conversationId,
      tabId,
      session,
      driver,
      createdAt: Date.now(),
      tail: Promise.resolve(),
      isLoading: session.isLoading(),
      stopLoadingRequested: false,
      removeLoadingListener: () => undefined,
      removeNavigationListener: () => undefined,
      released: false,
      usageLeases: new Map(),
      ...(workbarInstanceId ? { workbarInstanceId } : {})
    }
    tab.removeLoadingListener = session.onLoadingChange((isLoading) => {
      if (!isLoading) tab.stopLoadingRequested = false
      if (tab.released || tab.isLoading === isLoading || !this.hasTab(tab)) return
      tab.isLoading = isLoading
      const current = this.liveStates.get(stateKey(conversationId, tabId))
      if (current) {
        const status = tab.active?.status ?? (isLoading ? 'loading' : current.status === 'loading' ? 'ready' : current.status)
        this.emitState(tab, status, { isLoading })
      }
    })
    tab.removeNavigationListener =
      session.onNavigationChange?.((url) => {
        if (!this.hasTab(tab)) return
        try {
          const target = canonicalizeBrowserUrl(url)
          tab.origin = target.origin
          this.touchConversation(conversationId)
          this.emitState(tab, tab.active?.status ?? 'ready', { url: target.href })
          void tab.driver
            .getNavigationMetadata(AbortSignal.timeout(2_000))
            .then((metadata) => {
              if (!this.hasTab(tab) || canonicalizeBrowserUrl(metadata.url).href !== target.href) return
              this.emitState(tab, tab.active?.status ?? 'ready', {
                url: target.href,
                canGoBack: metadata.canGoBack
              })
            })
            .catch(() => undefined)
        } catch {
          // Unsupported top-level URLs are rejected by the session.
        }
      }) ?? (() => undefined)
    if (conversation) conversation.tabs.set(tabId, tab)
    return tab
  }

  private hasTab(tab: BrowserTabSlot): boolean {
    return !tab.released && this.conversations.get(tab.conversationId)?.tabs.get(tab.tabId) === tab
  }

  private async getOrCreateConversation(
    conversationId: string,
    signal: AbortSignal,
    ownerWindowId?: number
  ): Promise<BrowserConversationSlot> {
    if (this.disposed || this.clearing || this.lifecycle.signal.aborted) {
      throw new Error('浏览器服务已关闭')
    }
    const existing = this.conversations.get(conversationId)
    if (existing && !existing.released) {
      this.assertWindowOwner(existing, ownerWindowId)
      return existing
    }
    let creation = this.creations.get(conversationId)
    const pendingCreations = [...this.creations.keys()].filter((id) => !this.conversations.has(id)).length
    if (!creation && this.conversations.size + pendingCreations >= this.maximumSessions) {
      throw new Error(`浏览器会话已达到 ${this.maximumSessions} 个上限`)
    }
    if (creation && ownerWindowId !== undefined && creation.ownerWindowId !== undefined && creation.ownerWindowId !== ownerWindowId) {
      throw new Error('浏览器对话不属于当前窗口')
    }
    if (!creation) {
      const releaseReservation = this.reserveTab(conversationId, ownerWindowId)
      const controller = new AbortController()
      const waiters = new Set<symbol>()
      const tabId = createTabId()
      const promise = this.createConversation(
        conversationId,
        tabId,
        ownerWindowId,
        AbortSignal.any([this.lifecycle.signal, controller.signal]),
        () => waiters.size > 0
      )
      void promise.finally(releaseReservation).catch(() => undefined)
      creation = { controller, promise, waiters, ownerWindowId }
      this.creations.set(conversationId, creation)
      this.emitState({ conversationId, tabId }, 'creating')
      const current = creation
      const remove = (): void => {
        if (this.creations.get(conversationId) === current) this.creations.delete(conversationId)
      }
      void promise.then(remove, remove)
    }
    const waiter = Symbol(conversationId)
    creation.waiters.add(waiter)
    try {
      const result = await waitFor(creation.promise, signal)
      this.assertWindowOwner(result, ownerWindowId)
      return result
    } finally {
      creation.waiters.delete(waiter)
      if (creation.waiters.size === 0 && this.creations.get(conversationId) === creation) {
        this.creations.delete(conversationId)
        creation.controller.abort(new Error('浏览器会话创建已取消'))
      }
    }
  }

  private async createConversation(
    conversationId: string,
    tabId: BrowserTabId,
    ownerWindowId: number | undefined,
    signal: AbortSignal,
    hasWaiters: () => boolean
  ): Promise<BrowserConversationSlot> {
    const session = await this.createSession(this.policy, signal)
    if (this.disposed || signal.aborted || !hasWaiters() || this.releaseRequests.has(conversationId)) {
      await boundedCleanup(session.dispose(), this.cleanupTimeoutMs)
      throw new Error('浏览器服务已关闭')
    }
    const conversation: BrowserConversationSlot = {
      conversationId,
      ...(ownerWindowId !== undefined ? { ownerWindowId } : {}),
      tabs: new Map(),
      primaryTabId: tabId,
      tabCreationTail: Promise.resolve(),
      lifecycle: new AbortController(),
      ownedTabs: new Map(),
      lastUsedAt: Date.now(),
      released: false
    }
    const tab = await this.createTabSlot(undefined, conversationId, session, tabId)
    conversation.tabs.set(tabId, tab)
    this.conversations.set(conversationId, conversation)
    this.emitState(tab, 'ready')
    this.scheduleIdleExpiry(conversation)
    this.applyViewport()
    return conversation
  }

  async createTab(
    conversationId: string,
    ownerWindowId?: number,
    signal: AbortSignal = new AbortController().signal,
    workbarInstanceId?: string
  ): Promise<BrowserTabSummary> {
    if (workbarInstanceId) {
      const key = ownershipKey(conversationId, workbarInstanceId)
      const existingConversation = this.conversations.get(conversationId)
      const existingTabId = existingConversation?.ownedTabs.get(workbarInstanceId)
      const existingTab = existingTabId ? existingConversation?.tabs.get(existingTabId) : undefined
      if (existingTab && !existingTab.released) return this.summarizeTab(existingTab)
      let creation = this.ownedTabCreations.get(key)
      if (!creation) {
        const controller = new AbortController()
        const waiters = new Set<symbol>()
        const promise = this.createTabInternal(
          conversationId,
          ownerWindowId,
          AbortSignal.any([this.lifecycle.signal, controller.signal]),
          workbarInstanceId
        )
        creation = { conversationId, controller, promise, waiters }
        this.ownedTabCreations.set(key, creation)
        const current = creation
        void promise.finally(() => {
          if (this.ownedTabCreations.get(key) === current) this.ownedTabCreations.delete(key)
        }).catch(() => undefined)
      }
      const waiter = Symbol(workbarInstanceId)
      creation.waiters.add(waiter)
      try {
        return await waitFor(creation.promise, signal)
      } finally {
        creation.waiters.delete(waiter)
        if (creation.waiters.size === 0 && this.ownedTabCreations.get(key) === creation) {
          creation.controller.abort(new Error('浏览器标签页创建已取消'))
        }
      }
    }
    return this.createTabInternal(conversationId, ownerWindowId, signal)
  }

  private async createTabInternal(
    conversationId: string,
    ownerWindowId: number | undefined,
    signal: AbortSignal,
    workbarInstanceId?: string
  ): Promise<BrowserTabSummary> {
    const existed = this.conversations.has(conversationId) || this.creations.has(conversationId)
    const conversation = await this.getOrCreateConversation(conversationId, signal, ownerWindowId)
    if (workbarInstanceId) {
      const ownedTabId = conversation.ownedTabs.get(workbarInstanceId)
      const ownedTab = ownedTabId ? conversation.tabs.get(ownedTabId) : undefined
      if (ownedTab && !ownedTab.released) return this.summarizeTab(ownedTab)
      const primary = conversation.tabs.get(conversation.primaryTabId)
      if (primary && !primary.workbarInstanceId && !existed) {
        primary.workbarInstanceId = workbarInstanceId
        conversation.ownedTabs.set(workbarInstanceId, primary.tabId)
        return this.summarizeTab(primary)
      }
    } else if (!existed) {
      return this.summarizeTab(conversation.tabs.get(conversation.primaryTabId)!)
    }
    this.assertWindowOwner(conversation, ownerWindowId)
    const releaseReservation = this.reserveTab(conversationId, ownerWindowId)
    let releaseGate!: () => void
    const gate = new Promise<void>((resolve) => { releaseGate = resolve })
    const predecessor = conversation.tabCreationTail.catch(() => undefined)
    conversation.tabCreationTail = predecessor.then(() => gate)
    try {
      await waitFor(predecessor, signal)
      const primary = conversation.tabs.get(conversation.primaryTabId)
      if (!primary || conversation.released) throw new Error('浏览器会话已关闭')
      const effectiveSignal = AbortSignal.any([signal, this.lifecycle.signal, conversation.lifecycle.signal])
      const session = primary.session.createTab
        ? await primary.session.createTab(effectiveSignal)
        : await this.createSession(this.policy, effectiveSignal)
      if (effectiveSignal.aborted || conversation.released || this.conversations.get(conversationId) !== conversation) {
        await boundedCleanup(session.dispose(), this.cleanupTimeoutMs)
        throw effectiveSignal.reason ?? new Error('浏览器会话已关闭')
      }
      const tabId = createTabId()
      this.emitState({ conversationId, tabId }, 'creating')
      const tab = await this.createTabSlot(conversation, conversationId, session, tabId, workbarInstanceId)
      if (workbarInstanceId) conversation.ownedTabs.set(workbarInstanceId, tabId)
      this.touchConversation(conversationId)
      this.emitState(tab, 'ready')
      this.applyViewport()
      return this.summarizeTab(tab)
    } finally {
      releaseGate()
      releaseReservation()
    }
  }

  listTabs(conversationId: string, ownerWindowId?: number): BrowserTabSummary[] {
    const conversation = this.conversations.get(conversationId)
    if (!conversation || conversation.released) return []
    this.assertWindowOwner(conversation, ownerWindowId)
    return [...conversation.tabs.values()].map((tab) => this.summarizeTab(tab))
  }

  getVisibleTabId(
    conversationId: string,
    ownerWindowId?: number
  ): BrowserTabId | undefined {
    const conversation = this.conversations.get(conversationId)
    if (!conversation || conversation.released) return undefined
    this.assertWindowOwner(conversation, ownerWindowId)
    if (
      this.viewport?.conversationId !== conversationId ||
      (ownerWindowId !== undefined &&
        this.viewport.ownerWindowId !== ownerWindowId)
    ) {
      return undefined
    }
    const tabId = this.viewport.tabId ?? conversation.primaryTabId
    return conversation.tabs.has(tabId) ? tabId : undefined
  }

  acquireTabUsage(
    conversationId: string,
    tabId: BrowserTabId,
    owner: string,
    ownerWindowId?: number
  ): BrowserTabUsageLease {
    if (!owner || owner.length > 500) {
      throw new Error('浏览器标签页使用租约所有者无效')
    }
    const conversation = this.conversations.get(conversationId)
    if (!conversation || conversation.released) {
      throw new Error('浏览器标签页不存在或不属于当前对话')
    }
    this.assertWindowOwner(conversation, ownerWindowId)
    const tab = conversation.tabs.get(tabId)
    if (!tab || tab.released) {
      throw new Error('浏览器标签页不存在或不属于当前对话')
    }
    const token = Symbol(owner)
    const controller = new AbortController()
    tab.usageLeases.set(token, { owner, controller })
    if (conversation.idleTimer) {
      clearTimeout(conversation.idleTimer)
      conversation.idleTimer = undefined
    }
    let released = false
    return {
      conversationId,
      tabId,
      owner,
      signal: controller.signal,
      release: (): void => {
        if (released) return
        released = true
        if (tab.usageLeases.delete(token) && this.hasTab(tab)) {
          this.touchConversation(conversationId)
        }
      }
    }
  }

  private summarizeTab(tab: BrowserTabSlot): BrowserTabSummary {
    const state = this.liveStates.get(stateKey(tab.conversationId, tab.tabId))
    return {
      conversationId: tab.conversationId,
      tabId: tab.tabId,
      primary: this.conversations.get(tab.conversationId)?.primaryTabId === tab.tabId,
      status:
        state?.status && state.status !== 'stopped' ? state.status : 'ready',
      isLoading: tab.isLoading,
      canGoBack: state?.canGoBack ?? false,
      ...(state?.url ? { url: state.url } : {}),
      createdAt: tab.createdAt,
      updatedAt: state?.updatedAt ?? tab.createdAt
    }
  }

  async closeTab(conversationId: string, tabId: BrowserTabId, ownerWindowId?: number): Promise<void> {
    const conversation = this.conversations.get(conversationId)
    if (!conversation || conversation.released) throw new Error('浏览器标签页不存在或不属于当前对话')
    this.assertWindowOwner(conversation, ownerWindowId)
    const tab = conversation.tabs.get(tabId)
    if (!tab) throw new Error('浏览器标签页不存在或不属于当前对话')
    if (tab.usageLeases.size > 0) throw new Error(BROWSER_TAB_IN_USE_ERROR)
    await this.releaseTab(conversation, tab)
  }

  private requireTab(conversationId: string, tabId?: BrowserTabId, ownerWindowId?: number): BrowserTabSlot {
    if (this.disposed) throw new Error('浏览器服务已关闭')
    const conversation = this.conversations.get(conversationId)
    if (!conversation || conversation.released) throw new Error('当前对话尚未建立浏览器会话，请先导航')
    this.assertWindowOwner(conversation, ownerWindowId)
    const tab = conversation.tabs.get(tabId ?? conversation.primaryTabId)
    if (!tab || tab.released || !tab.origin) throw new Error('当前浏览器标签页尚未导航')
    return tab
  }

  private scheduleIdleExpiry(conversation: BrowserConversationSlot): void {
    if (conversation.idleTimer) clearTimeout(conversation.idleTimer)
    if (conversation.released || this.disposed) return
    conversation.idleTimer = setTimeout(() => {
      if (Date.now() - conversation.lastUsedAt < this.idleTimeoutMs) {
        this.scheduleIdleExpiry(conversation)
        return
      }
      if (
        [...conversation.tabs.values()].some(
          (tab) => tab.usageLeases.size > 0
        )
      ) {
        this.scheduleIdleExpiry(conversation)
        return
      }
      void this.releaseConversationSlot(conversation).catch(() => undefined)
    }, this.idleTimeoutMs)
  }

  private touchConversation(conversationId: string): void {
    const conversation = this.conversations.get(conversationId)
    if (!conversation) return
    conversation.lastUsedAt = Date.now()
    if ([...conversation.tabs.values()].some((tab) => tab.active)) {
      if (conversation.idleTimer) clearTimeout(conversation.idleTimer)
      conversation.idleTimer = undefined
      return
    }
    this.scheduleIdleExpiry(conversation)
  }

  private async serialize<T>(
    tab: BrowserTabSlot,
    signal: AbortSignal,
    operation: (effectiveSignal: AbortSignal) => Promise<T>,
    status: ActiveOperation['status'],
    stopLoadingAllowed: boolean
  ): Promise<T> {
    signal.throwIfAborted()
    if (!this.hasTab(tab) || this.disposed) throw new Error('浏览器会话已关闭')
    let releaseGate!: () => void
    const gate = new Promise<void>((resolve) => { releaseGate = resolve })
    const predecessor = tab.tail.catch(() => undefined)
    tab.tail = predecessor.then(() => gate)
    let operationController: AbortController | undefined
    try {
      await waitFor(predecessor, signal)
      if (!this.hasTab(tab) || this.disposed) throw new Error('浏览器会话已关闭')
      const conversation = this.conversations.get(tab.conversationId)
      if (conversation?.idleTimer) {
        clearTimeout(conversation.idleTimer)
        conversation.idleTimer = undefined
      }
      this.emitState(tab, status)
      tab.stopLoadingRequested = false
      operationController = new AbortController()
      tab.active = { controller: operationController, stopLoadingAllowed, status }
      return await operation(AbortSignal.any([signal, this.lifecycle.signal, operationController.signal]))
    } finally {
      if (operationController && tab.active?.controller === operationController) tab.active = undefined
      releaseGate()
      if (operationController) this.touchConversation(tab.conversationId)
    }
  }

  private verifyCurrentOrigin(tab: BrowserTabSlot): string {
    const current = tab.session.getCurrentOrigin()
    if (!tab.origin || current !== tab.origin) throw new Error('浏览器页面来源已改变，会话已被拒绝')
    return current
  }

  private async verifyCurrentOriginOrRelease(tab: BrowserTabSlot): Promise<string> {
    try {
      return this.verifyCurrentOrigin(tab)
    } catch (error) {
      const conversation = this.conversations.get(tab.conversationId)
      if (conversation) await this.releaseTab(conversation, tab).catch(() => undefined)
      throw error
    }
  }

  private shouldEmitFailure(conversationId: string, signal: AbortSignal, error: unknown): boolean {
    if (error instanceof BrowserNavigationStoppedError || signal.aborted || this.releaseRequests.has(conversationId)) return false
    const message = error instanceof Error ? error.message : ''
    return !['浏览器会话已释放', '浏览器会话已清除', '浏览器会话已关闭', '浏览器服务已关闭'].some((reason) => message.includes(reason))
  }

  private emitFailure(tab: Pick<BrowserTabSlot, 'conversationId' | 'tabId'>, stage: string, error: unknown): void {
    const detail = error instanceof Error && error.message ? error.message.slice(0, 180) : '未知错误'
    this.emitState(tab, 'failed', { error: `${stage}失败：${detail}`.slice(0, 240) })
  }

  private async runInTab<T>(
    conversationId: string,
    signal: AbortSignal,
    status: ActiveOperation['status'],
    stopLoadingAllowed: boolean,
    failureStage: string,
    operation: (tab: BrowserTabSlot, effectiveSignal: AbortSignal) => Promise<T>,
    tabId?: BrowserTabId,
    ownerWindowId?: number
  ): Promise<T> {
    let tab: BrowserTabSlot | undefined
    try {
      tab = this.requireTab(conversationId, tabId, ownerWindowId)
      return await this.serialize(tab, signal, (effectiveSignal) => operation(tab!, effectiveSignal), status, stopLoadingAllowed)
    } catch (error) {
      if (error instanceof BrowserNavigationStoppedError && tab && status !== 'loading') this.recoverStoppedNavigation(tab)
      if (tab && this.shouldEmitFailure(conversationId, signal, error)) this.emitFailure(tab, failureStage, error)
      throw error
    }
  }

  async navigate(
    conversationId: string,
    url: string,
    signal: AbortSignal,
    tabId?: BrowserTabId,
    ownerWindowId?: number
  ): Promise<{ url: string; origin: string }> {
    let tab: BrowserTabSlot | undefined
    try {
      const conversation = await this.getOrCreateConversation(conversationId, signal, ownerWindowId)
      tab = conversation.tabs.get(tabId ?? conversation.primaryTabId)
      if (!tab || tab.released) throw new Error('浏览器标签页不存在或不属于当前对话')
      return await this.serialize(tab, signal, async (effectiveSignal) => {
        const target = await this.policy.validate(url, effectiveSignal)
        tab!.session.approveNavigation(target)
        return this.completeNavigation(tab!, effectiveSignal, () => tab!.driver.navigate(target.url.href, effectiveSignal), '浏览器导航结果来源不一致')
      }, 'loading', true)
    } catch (error) {
      if (tab && this.shouldEmitFailure(conversationId, signal, error)) this.emitFailure(tab, '浏览器导航', error)
      throw error
    }
  }

  async snapshot(conversationId: string, signal: AbortSignal, tabId?: BrowserTabId, ownerWindowId?: number): Promise<BrowserSnapshot> {
    return this.runInTab(conversationId, signal, 'acting', false, '读取浏览器页面', async (tab, effectiveSignal) => {
      await this.verifyCurrentOriginOrRelease(tab)
      const snapshot = await tab.driver.snapshot(effectiveSignal)
      const target = canonicalizeBrowserUrl(snapshot.url)
      if (target.origin !== tab.origin) {
        const conversation = this.conversations.get(conversationId)
        if (conversation) await this.releaseTab(conversation, tab).catch(() => undefined)
        throw new Error('浏览器快照来源与当前会话不一致')
      }
      await this.captureFrame(tab, effectiveSignal, target.href)
      return { ...snapshot, url: target.href }
    }, tabId, ownerWindowId)
  }

  async click(conversationId: string, ref: string, signal: AbortSignal, tabId?: BrowserTabId, ownerWindowId?: number): Promise<void> {
    await this.runInTab(conversationId, signal, 'acting', true, '浏览器点击', async (tab, effectiveSignal) => {
      await this.verifyCurrentOriginOrRelease(tab)
      await tab.driver.click(ref, effectiveSignal)
      await this.captureFrame(tab, effectiveSignal)
    }, tabId, ownerWindowId)
  }

  async type(conversationId: string, ref: string, text: string, signal: AbortSignal, tabId?: BrowserTabId, ownerWindowId?: number): Promise<void> {
    await this.runInTab(conversationId, signal, 'acting', false, '浏览器输入', async (tab, effectiveSignal) => {
      await this.verifyCurrentOriginOrRelease(tab)
      await tab.driver.type(ref, text, effectiveSignal)
      await this.captureFrame(tab, effectiveSignal)
    }, tabId, ownerWindowId)
  }

  async select(conversationId: string, ref: string, value: string, signal: AbortSignal, tabId?: BrowserTabId, ownerWindowId?: number): Promise<void> {
    await this.runInTab(conversationId, signal, 'acting', false, '浏览器选择', async (tab, effectiveSignal) => {
      await this.verifyCurrentOriginOrRelease(tab)
      await tab.driver.select(ref, value, effectiveSignal)
      await this.captureFrame(tab, effectiveSignal)
    }, tabId, ownerWindowId)
  }

  async back(conversationId: string, signal: AbortSignal, tabId?: BrowserTabId, ownerWindowId?: number): Promise<{ url: string; origin: string }> {
    return this.runInTab(conversationId, signal, 'loading', true, '浏览器返回', async (tab, effectiveSignal) => {
      await this.verifyCurrentOriginOrRelease(tab)
      const historyTarget = await tab.driver.getBackTarget(effectiveSignal)
      const target = await this.policy.validate(historyTarget.url, effectiveSignal)
      tab.session.approveNavigation(target)
      return this.completeNavigation(tab, effectiveSignal, () => tab.driver.backTo(historyTarget, effectiveSignal), '浏览器返回结果来源不一致')
    }, tabId, ownerWindowId)
  }

  async reload(conversationId: string, signal: AbortSignal, tabId?: BrowserTabId, ownerWindowId?: number): Promise<{ url: string; origin: string }> {
    return this.runInTab(conversationId, signal, 'loading', true, '浏览器刷新', async (tab, effectiveSignal) => {
      await this.verifyCurrentOriginOrRelease(tab)
      return this.completeNavigation(tab, effectiveSignal, () => tab.driver.reload(effectiveSignal), '浏览器刷新结果来源不一致')
    }, tabId, ownerWindowId)
  }

  async screenshot(conversationId: string, signal: AbortSignal, tabId?: BrowserTabId, ownerWindowId?: number): Promise<BrowserScreenshot> {
    return this.runInTab(conversationId, signal, 'acting', false, '浏览器截图', async (tab, effectiveSignal) => {
      await this.verifyCurrentOriginOrRelease(tab)
      let screenshot: BrowserScreenshot | undefined
      if (tab.session.captureScreenshot) {
        try {
          screenshot = await tab.session.captureScreenshot(effectiveSignal)
        } catch {
          effectiveSignal.throwIfAborted()
        }
      }
      screenshot ??= await tab.driver.screenshot(effectiveSignal)
      await this.captureFrame(tab, effectiveSignal, undefined, screenshot)
      return screenshot
    }, tabId, ownerWindowId)
  }

  async stopLoading(conversationId: string, tabId?: BrowserTabId, ownerWindowId?: number): Promise<boolean> {
    const conversation = this.conversations.get(conversationId)
    if (!conversation) return false
    this.assertWindowOwner(conversation, ownerWindowId)
    const tab = conversation.tabs.get(tabId ?? conversation.primaryTabId)
    const active = tab?.active
    if (!tab || tab.released || tab.stopLoadingRequested) return false
    if (active) {
      if (!active.stopLoadingAllowed || active.controller.signal.aborted || (active.status !== 'loading' && !tab.isLoading && !tab.session.isLoading())) return false
      tab.isLoading = false
      tab.stopLoadingRequested = true
      tab.session.stopLoading()
      active.controller.abort(new BrowserNavigationStoppedError())
      return true
    }
    if (!tab.isLoading && !tab.session.isLoading()) return false
    tab.isLoading = false
    tab.stopLoadingRequested = true
    tab.session.stopLoading()
    this.recoverStoppedNavigation(tab)
    return true
  }

  private recoverStoppedNavigation(tab: BrowserTabSlot): void {
    if (!this.hasTab(tab)) return
    tab.isLoading = false
    try {
      const target = canonicalizeBrowserUrl(tab.session.webContents.getURL())
      if (tab.session.getCurrentOrigin() !== target.origin) throw new Error('浏览器停止导航后的页面来源不一致')
      tab.origin = target.origin
      this.emitState(tab, 'ready', { url: target.href, isLoading: false })
    } catch {
      if (this.hasTab(tab)) this.emitState(tab, 'ready', { isLoading: false })
    }
  }

  private async completeNavigation(
    tab: BrowserTabSlot,
    signal: AbortSignal,
    operation: () => Promise<{ url: string }>,
    originMismatchMessage: string
  ): Promise<{ url: string; origin: string }> {
    try {
      const result = await operation()
      const finalTarget = await this.policy.validateRedirect(result.url, signal)
      if (tab.session.getCurrentOrigin() !== finalTarget.origin) throw new Error(originMismatchMessage)
      tab.origin = finalTarget.origin
      await this.captureFrame(tab, signal, finalTarget.url.href)
      return { url: finalTarget.url.href, origin: finalTarget.origin }
    } catch (error) {
      if (error instanceof BrowserNavigationStoppedError) {
        this.recoverStoppedNavigation(tab)
        throw error
      }
      const conversation = this.conversations.get(tab.conversationId)
      if (conversation) await this.releaseTab(conversation, tab).catch(() => undefined)
      throw error
    }
  }

  private async captureFrame(
    tab: BrowserTabSlot,
    signal: AbortSignal,
    url?: string,
    screenshot?: BrowserScreenshot
  ): Promise<void> {
    let committedUrl = url
    const previous = this.liveStates.get(stateKey(tab.conversationId, tab.tabId))
    let canGoBack = previous?.canGoBack ?? false
    try {
      const metadata = await tab.driver.getNavigationMetadata(signal)
      const target = canonicalizeBrowserUrl(metadata.url)
      if (tab.session.getCurrentOrigin() !== target.origin) throw new Error('浏览器当前页面来源不一致')
      tab.origin = target.origin
      committedUrl = target.href
      canGoBack = metadata.canGoBack
    } catch {
      signal.throwIfAborted()
    }
    let frame = screenshot
    if (!frame) {
      if (this.liveFrameDelayMs > 0) {
        await waitFor(new Promise<void>((resolve) => setTimeout(resolve, this.liveFrameDelayMs)), signal)
      }
      const deadline = AbortSignal.any([signal, AbortSignal.timeout(6_000)])
      for (let attempt = 0; attempt < 3 && !frame; attempt += 1) {
        if (attempt > 0) {
          try {
            await waitFor(new Promise<void>((resolve) => setTimeout(resolve, attempt * 150)), deadline)
          } catch {
            signal.throwIfAborted()
            break
          }
        }
        if (tab.session.captureScreenshot) {
          try {
            frame = await tab.session.captureScreenshot(AbortSignal.any([deadline, AbortSignal.timeout(1_500)]))
          } catch {
            signal.throwIfAborted()
          }
        }
        if (!frame && !deadline.aborted) {
          try {
            frame = await tab.driver.screenshot(AbortSignal.any([deadline, AbortSignal.timeout(1_500)]))
          } catch {
            signal.throwIfAborted()
          }
        }
      }
    }
    signal.throwIfAborted()
    if (!this.hasTab(tab)) return
    if (!frame) {
      if (previous?.frameDataUrl) {
        this.emitState(tab, 'ready', {
          ...(committedUrl ? { url: committedUrl } : {}),
          canGoBack,
          frameDataUrl: previous.frameDataUrl
        })
      } else {
        this.emitState(tab, 'failed', {
          ...(committedUrl ? { url: committedUrl } : {}),
          canGoBack,
          error: '页面已就绪，但实时画面捕获失败，请重试浏览器操作'
        })
      }
      return
    }
    this.emitState(tab, 'ready', {
      ...(committedUrl ? { url: committedUrl } : {}),
      canGoBack,
      frameDataUrl: `data:${frame.mimeType};base64,${frame.data}`
    })
  }

  async releaseConversation(conversationId: string, ownerWindowId?: number): Promise<void> {
    const ownedConversation = this.conversations.get(conversationId)
    if (ownedConversation) this.assertWindowOwner(ownedConversation, ownerWindowId)
    const creation = this.creations.get(conversationId)
    if (
      ownerWindowId !== undefined &&
      creation?.ownerWindowId !== undefined &&
      creation.ownerWindowId !== ownerWindowId
    ) {
      throw new Error('浏览器对话不属于当前窗口')
    }
    this.releaseRequests.add(conversationId)
    let emitted = false
    try {
      const pendingCreation = this.creations.get(conversationId)
      if (pendingCreation) {
        pendingCreation.controller.abort(new Error('浏览器会话已释放'))
        const created = await pendingCreation.promise.catch(() => undefined)
        if (created) {
          await this.releaseConversationSlot(created)
          emitted = true
        }
      }
      const conversation = this.conversations.get(conversationId)
      if (conversation) {
        await this.releaseConversationSlot(conversation)
        emitted = true
      }
      const ownedCreations = [...this.ownedTabCreations.values()].filter(
        (creation) => creation.conversationId === conversationId
      )
      for (const creation of ownedCreations) {
        creation.controller.abort(new Error('浏览器会话已释放'))
      }
      await Promise.allSettled(ownedCreations.map((creation) => creation.promise))
      if (!emitted) {
        for (const state of [...this.liveStates.values()].filter((item) => item.conversationId === conversationId)) {
          if (state.tabId) this.emitState({ ...state, tabId: state.tabId }, 'stopped')
        }
      }
    } finally {
      if (!this.disposed) this.releaseRequests.delete(conversationId)
    }
  }

  private async releaseTab(conversation: BrowserConversationSlot, tab: BrowserTabSlot): Promise<void> {
    if (tab.released) return
    tab.released = true
    conversation.tabs.delete(tab.tabId)
    tab.removeLoadingListener()
    tab.removeNavigationListener()
    tab.active?.controller.abort(new Error('浏览器会话已释放'))
    for (const lease of tab.usageLeases.values()) {
      lease.controller.abort(new Error('浏览器标签页使用租约已终止'))
    }
    tab.usageLeases.clear()
    if (tab.workbarInstanceId) conversation.ownedTabs.delete(tab.workbarInstanceId)
    if (conversation.tabs.size === 0) {
      conversation.released = true
      conversation.lifecycle.abort(new Error('浏览器会话已释放'))
      if (conversation.idleTimer) clearTimeout(conversation.idleTimer)
      this.conversations.delete(conversation.conversationId)
    } else if (conversation.primaryTabId === tab.tabId) {
      conversation.primaryTabId = conversation.tabs.keys().next().value!
    }
    if (this.viewport?.conversationId === conversation.conversationId && this.viewport.tabId === tab.tabId) {
      try {
        tab.session.setViewport?.(undefined)
      } catch {
        // The service state is still cleared when the native view is already gone.
      }
      this.viewport = undefined
      this.applyViewport()
    }
    let disposalError: unknown
    try {
      tab.driver.dispose()
    } catch (error) {
      disposalError = error
    }
    try {
      await boundedCleanup(tab.session.dispose(), this.cleanupTimeoutMs)
    } catch (error) {
      disposalError ??= error
    } finally {
      this.emitState(tab, 'stopped')
    }
    if (disposalError) throw disposalError
  }

  private async releaseConversationSlot(conversation: BrowserConversationSlot): Promise<void> {
    if (conversation.released) return
    conversation.released = true
    conversation.lifecycle.abort(new Error('浏览器会话已释放'))
    this.conversations.delete(conversation.conversationId)
    if (conversation.idleTimer) clearTimeout(conversation.idleTimer)
    const tabs = [...conversation.tabs.values()]
    await Promise.allSettled(tabs.map((tab) => this.releaseTab(conversation, tab))).then((results) => {
      const failure = results.find((result) => result.status === 'rejected')
      if (failure?.status === 'rejected') throw failure.reason
    })
  }

  clearSessions(): Promise<void> {
    if (this.disposed) return Promise.resolve()
    if (this.clearOperation) return this.clearOperation
    const operation = this.performClearSessions()
    this.clearOperation = operation
    void operation.finally(() => {
      if (this.clearOperation === operation) this.clearOperation = undefined
    }).catch(() => undefined)
    return operation
  }

  private async performClearSessions(): Promise<void> {
    this.clearing = true
    this.lifecycle.abort(new Error('浏览器会话已清除'))
    const requested = new Set(this.creations.keys())
    for (const id of requested) this.releaseRequests.add(id)
    try {
      await Promise.allSettled([...this.creations.values()].map((creation) => creation.promise))
      await Promise.allSettled([...this.ownedTabCreations.values()].map((creation) => creation.promise))
      await Promise.allSettled([...this.conversations.values()].map((conversation) => this.releaseConversationSlot(conversation)))
      this.conversations.clear()
    } finally {
      if (!this.disposed) {
        for (const id of requested) this.releaseRequests.delete(id)
        this.lifecycle = new AbortController()
        this.clearing = false
      }
    }
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    this.clearing = true
    this.lifecycle.abort(new Error('浏览器服务已关闭'))
    for (const [id, creation] of this.creations) {
      this.releaseRequests.add(id)
      creation.controller.abort(new Error('浏览器服务已关闭'))
    }
    await Promise.allSettled([...this.creations.values()].map((creation) => creation.promise))
    await Promise.allSettled([...this.ownedTabCreations.values()].map((creation) => creation.promise))
    await Promise.allSettled([...this.conversations.values()].map((conversation) => this.releaseConversationSlot(conversation)))
    this.conversations.clear()
    this.stateListeners.clear()
    this.liveStates.clear()
  }
}

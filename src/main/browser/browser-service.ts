import { BrowserUrlPolicy, canonicalizeBrowserUrl } from './browser-url-policy'
import {
  CdpBrowserDriver,
  type BrowserHistoryTarget,
  type BrowserSnapshot
} from './cdp-browser-driver'
import type { BrowserScreenshot } from './browser-screenshot'
import {
  ElectronBrowserSession,
  type BrowserWebContents
} from './electron-browser-session'
import type { BrowserLiveState } from '../../shared/contracts'

const DEFAULT_IDLE_TIMEOUT_MS = 10 * 60_000
const DEFAULT_CLEANUP_TIMEOUT_MS = 5_000

export type BrowserSessionLike = {
  readonly webContents: BrowserWebContents
  approveNavigation(
    target: Awaited<ReturnType<BrowserUrlPolicy['validate']>>
  ): void
  getCurrentOrigin(): string | undefined
  captureScreenshot?(signal: AbortSignal): Promise<BrowserScreenshot>
  dispose(): Promise<void>
}

export type BrowserDriverLike = {
  navigate(url: string, signal: AbortSignal): Promise<{ url: string }>
  snapshot(signal: AbortSignal): Promise<BrowserSnapshot>
  click(ref: string, signal: AbortSignal): Promise<void>
  type(ref: string, text: string, signal: AbortSignal): Promise<void>
  select(ref: string, value: string, signal: AbortSignal): Promise<void>
  getBackTarget(signal: AbortSignal): Promise<BrowserHistoryTarget>
  backTo(
    target: BrowserHistoryTarget,
    signal: AbortSignal
  ): Promise<{ url: string }>
  screenshot(signal: AbortSignal): Promise<BrowserScreenshot>
  dispose(): void
}

export type BrowserServiceOptions = {
  policy?: BrowserUrlPolicy
  maximumSessions?: number
  idleTimeoutMs?: number
  cleanupTimeoutMs?: number
  liveFrameDelayMs?: number
  createSession?: (
    policy: BrowserUrlPolicy,
    signal: AbortSignal
  ) => Promise<BrowserSessionLike>
  createDriver?: (webContents: BrowserWebContents) => BrowserDriverLike
}

type BrowserSlot = {
  conversationId: string
  session: BrowserSessionLike
  driver: BrowserDriverLike
  origin?: string
  tail: Promise<void>
  active?: AbortController
  idleTimer?: ReturnType<typeof setTimeout>
  lastUsedAt: number
  released: boolean
}

type SlotCreation = {
  controller: AbortController
  promise: Promise<BrowserSlot>
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
    if (timer) {
      clearTimeout(timer)
    }
  }
}

async function defaultCreateSession(
  policy: BrowserUrlPolicy,
  signal: AbortSignal
): Promise<BrowserSessionLike> {
  return ElectronBrowserSession.create({ policy }, signal)
}

function defaultCreateDriver(webContents: BrowserWebContents): BrowserDriverLike {
  return new CdpBrowserDriver(webContents)
}

export class BrowserService {
  private readonly policy: BrowserUrlPolicy
  private readonly maximumSessions: number
  private readonly idleTimeoutMs: number
  private readonly cleanupTimeoutMs: number
  private readonly liveFrameDelayMs: number
  private readonly createSession: NonNullable<
    BrowserServiceOptions['createSession']
  >
  private readonly createDriver: NonNullable<
    BrowserServiceOptions['createDriver']
  >
  private readonly slots = new Map<string, BrowserSlot>()
  private readonly creations = new Map<string, SlotCreation>()
  private readonly releaseRequests = new Set<string>()
  private readonly stateListeners = new Set<
    (state: BrowserLiveState) => void
  >()
  private readonly liveStates = new Map<string, BrowserLiveState>()
  private lifecycle = new AbortController()
  private clearOperation?: Promise<void>
  private clearing = false
  private disposed = false

  constructor(options: BrowserServiceOptions = {}) {
    this.policy = options.policy ?? new BrowserUrlPolicy()
    this.maximumSessions = options.maximumSessions ?? 3
    this.idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS
    this.cleanupTimeoutMs =
      options.cleanupTimeoutMs ?? DEFAULT_CLEANUP_TIMEOUT_MS
    this.liveFrameDelayMs = options.liveFrameDelayMs ?? 100
    this.createSession = options.createSession ?? defaultCreateSession
    this.createDriver = options.createDriver ?? defaultCreateDriver
    if (
      !Number.isSafeInteger(this.maximumSessions) ||
      this.maximumSessions < 1 ||
      !Number.isSafeInteger(this.idleTimeoutMs) ||
      this.idleTimeoutMs < 1 ||
      !Number.isSafeInteger(this.cleanupTimeoutMs) ||
      this.cleanupTimeoutMs < 1 ||
      !Number.isSafeInteger(this.liveFrameDelayMs) ||
      this.liveFrameDelayMs < 0
    ) {
      throw new Error('浏览器服务限制配置无效')
    }
  }

  getOrigin(conversationId: string): string | undefined {
    return this.slots.get(conversationId)?.origin
  }

  getSessionCount(): number {
    return this.slots.size
  }

  onState(listener: (state: BrowserLiveState) => void): () => void {
    this.stateListeners.add(listener)
    for (const state of this.liveStates.values()) {
      listener(state)
    }
    return () => {
      this.stateListeners.delete(listener)
    }
  }

  private emitState(
    conversationId: string,
    status: BrowserLiveState['status'],
    update: Partial<
      Pick<BrowserLiveState, 'url' | 'frameDataUrl' | 'error'>
    > = {}
  ): void {
    const previous = this.liveStates.get(conversationId)
    const state: BrowserLiveState = {
      conversationId,
      status,
      ...(previous?.url ? { url: previous.url } : {}),
      ...update,
      updatedAt: Date.now()
    }
    if (status !== 'failed') {
      delete state.error
    }
    if (status === 'stopped') {
      this.liveStates.delete(conversationId)
    } else {
      this.liveStates.set(conversationId, state)
    }
    for (const listener of this.stateListeners) {
      try {
        listener(state)
      } catch {
        // A UI observer must not interrupt browser control.
      }
    }
  }

  private async captureFrame(
    conversationId: string,
    slot: BrowserSlot,
    signal: AbortSignal,
    url?: string,
    screenshot?: BrowserScreenshot
  ): Promise<void> {
    let frame = screenshot
    if (!frame) {
      if (this.liveFrameDelayMs > 0) {
        await waitFor(
          new Promise<void>((resolve) =>
            setTimeout(resolve, this.liveFrameDelayMs)
          ),
          signal
        )
      }
      const previewController = new AbortController()
      const timeout = setTimeout(
        () =>
          previewController.abort(
            new Error('浏览器实时画面捕获超时')
          ),
        2_000
      )
      try {
        const previewSignal = AbortSignal.any([
          signal,
          previewController.signal
        ])
        frame = slot.session.captureScreenshot
          ? await slot.session.captureScreenshot(previewSignal)
          : await slot.driver.screenshot(previewSignal)
      } catch {
        signal.throwIfAborted()
        // Browser control succeeds even when the optional live frame fails.
      } finally {
        clearTimeout(timeout)
      }
    }
    signal.throwIfAborted()
    if (slot.released || this.slots.get(conversationId) !== slot) {
      return
    }
    this.emitState(conversationId, 'ready', {
      ...(url ? { url } : {}),
      ...(frame
        ? {
            frameDataUrl: `data:${frame.mimeType};base64,${frame.data}`
          }
        : {})
    })
  }

  private emitFailure(
    conversationId: string,
    stage: string,
    error: unknown
  ): void {
    const detail =
      error instanceof Error && error.message
        ? error.message.slice(0, 180)
        : '未知错误'
    this.emitState(conversationId, 'failed', {
      error: `${stage}失败：${detail}`.slice(0, 240)
    })
  }

  private shouldEmitFailure(
    conversationId: string,
    signal: AbortSignal,
    error: unknown
  ): boolean {
    if (signal.aborted || this.releaseRequests.has(conversationId)) {
      return false
    }
    const message = error instanceof Error ? error.message : ''
    return ![
      '浏览器会话已释放',
      '浏览器会话已清除',
      '浏览器会话已关闭',
      '浏览器服务已关闭'
    ].some((reason) => message.includes(reason))
  }

  private async getOrCreateSlot(
    conversationId: string,
    signal: AbortSignal
  ): Promise<BrowserSlot> {
    if (this.disposed || this.clearing || this.lifecycle.signal.aborted) {
      throw new Error('浏览器服务已关闭')
    }
    const existing = this.slots.get(conversationId)
    if (existing && !existing.released) {
      return existing
    }
    let creation = this.creations.get(conversationId)
    const pendingCreations = [...this.creations.keys()].filter(
      (id) => !this.slots.has(id)
    ).length
    if (
      !creation &&
      this.slots.size + pendingCreations >= this.maximumSessions
    ) {
      throw new Error(`浏览器会话已达到 ${this.maximumSessions} 个上限`)
    }
    if (!creation) {
      const controller = new AbortController()
      const waiters = new Set<symbol>()
      const promise = this.createSlot(
        conversationId,
        AbortSignal.any([this.lifecycle.signal, controller.signal]),
        () => waiters.size > 0
      )
      const currentCreation = { controller, promise, waiters }
      creation = currentCreation
      this.creations.set(conversationId, creation)
      const removeCreation = (): void => {
        if (this.creations.get(conversationId) === creation) {
          this.creations.delete(conversationId)
        }
      }
      void promise.then(removeCreation, removeCreation)
    }
    const waiter = Symbol(conversationId)
    creation.waiters.add(waiter)
    try {
      return await waitFor(creation.promise, signal)
    } finally {
      creation.waiters.delete(waiter)
      if (
        creation.waiters.size === 0 &&
        this.creations.get(conversationId) === creation
      ) {
        this.creations.delete(conversationId)
        creation.controller.abort(new Error('浏览器会话创建已取消'))
      }
    }
  }

  private async createSlot(
    conversationId: string,
    signal: AbortSignal,
    hasWaiters: () => boolean
  ): Promise<BrowserSlot> {
    const session = await this.createSession(
      this.policy,
      signal
    )
    if (
      this.disposed ||
      signal.aborted ||
      !hasWaiters() ||
      this.releaseRequests.has(conversationId)
    ) {
      await boundedCleanup(session.dispose(), this.cleanupTimeoutMs)
      throw new Error('浏览器服务已关闭')
    }
    let driver: BrowserDriverLike
    try {
      driver = this.createDriver(session.webContents)
    } catch (error) {
      await boundedCleanup(session.dispose(), this.cleanupTimeoutMs).catch(
        () => undefined
      )
      throw error
    }
    const slot: BrowserSlot = {
      conversationId,
      session,
      driver,
      tail: Promise.resolve(),
      lastUsedAt: Date.now(),
      released: false
    }
    this.slots.set(conversationId, slot)
    this.scheduleIdleExpiry(slot)
    return slot
  }

  private requireSlot(conversationId: string): BrowserSlot {
    if (this.disposed) {
      throw new Error('浏览器服务已关闭')
    }
    const slot = this.slots.get(conversationId)
    if (!slot || slot.released || !slot.origin) {
      throw new Error('当前对话尚未建立浏览器会话，请先导航')
    }
    return slot
  }

  private scheduleIdleExpiry(slot: BrowserSlot): void {
    if (slot.idleTimer) {
      clearTimeout(slot.idleTimer)
    }
    if (slot.released || this.disposed) {
      return
    }
    slot.idleTimer = setTimeout(() => {
      if (Date.now() - slot.lastUsedAt < this.idleTimeoutMs) {
        this.scheduleIdleExpiry(slot)
        return
      }
      void this.releaseSlot(slot).catch(() => undefined)
    }, this.idleTimeoutMs)
  }

  private async serialize<T>(
    slot: BrowserSlot,
    signal: AbortSignal,
    operation: (effectiveSignal: AbortSignal) => Promise<T>,
    status?: 'loading' | 'acting'
  ): Promise<T> {
    signal.throwIfAborted()
    if (slot.released || this.disposed) {
      throw new Error('浏览器会话已关闭')
    }
    let releaseGate!: () => void
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve
    })
    const predecessor = slot.tail.catch(() => undefined)
    slot.tail = predecessor.then(() => gate)
    let operationController: AbortController | undefined
    try {
      await waitFor(predecessor, signal)
      if (slot.released || this.disposed) {
        throw new Error('浏览器会话已关闭')
      }
      if (status) {
        this.emitState(slot.conversationId, status)
      }
      if (slot.idleTimer) {
        clearTimeout(slot.idleTimer)
        slot.idleTimer = undefined
      }
      operationController = new AbortController()
      slot.active = operationController
      const effectiveSignal = AbortSignal.any([
        signal,
        this.lifecycle.signal,
        operationController.signal
      ])
      return await operation(effectiveSignal)
    } finally {
      if (operationController && slot.active === operationController) {
        slot.active = undefined
      }
      releaseGate()
      if (operationController) {
        slot.lastUsedAt = Date.now()
        this.scheduleIdleExpiry(slot)
      }
    }
  }

  private verifyCurrentOrigin(slot: BrowserSlot): string {
    const current = slot.session.getCurrentOrigin()
    if (!slot.origin || current !== slot.origin) {
      throw new Error('浏览器页面来源已改变，会话已被拒绝')
    }
    return current
  }

  private async verifyCurrentOriginOrRelease(
    slot: BrowserSlot
  ): Promise<string> {
    try {
      return this.verifyCurrentOrigin(slot)
    } catch (error) {
      await this.releaseSlot(slot).catch(() => undefined)
      throw error
    }
  }

  private async runInSession<T>(
    conversationId: string,
    signal: AbortSignal,
    status: 'loading' | 'acting',
    failureStage: string,
    operation: (
      slot: BrowserSlot,
      effectiveSignal: AbortSignal
    ) => Promise<T>
  ): Promise<T> {
    try {
      const slot = this.requireSlot(conversationId)
      return await this.serialize(
        slot,
        signal,
        (effectiveSignal) => operation(slot, effectiveSignal),
        status
      )
    } catch (error) {
      if (this.shouldEmitFailure(conversationId, signal, error)) {
        this.emitFailure(conversationId, failureStage, error)
      }
      throw error
    }
  }

  async navigate(
    conversationId: string,
    url: string,
    signal: AbortSignal
  ): Promise<{ url: string; origin: string }> {
    if (
      !this.slots.has(conversationId) &&
      !this.creations.has(conversationId)
    ) {
      this.emitState(conversationId, 'creating', { url })
    }
    try {
      const slot = await this.getOrCreateSlot(conversationId, signal)
      return await this.serialize(slot, signal, async (effectiveSignal) => {
        const target = await this.policy.validate(url, effectiveSignal)
        slot.session.approveNavigation(target)
        try {
          const result = await slot.driver.navigate(
            target.url.href,
            effectiveSignal
          )
          const finalTarget = await this.policy.validateRedirect(
            result.url,
            target.origin,
            effectiveSignal
          )
          if (slot.session.getCurrentOrigin() !== finalTarget.origin) {
            throw new Error('浏览器导航结果来源不一致')
          }
          slot.origin = finalTarget.origin
          await this.captureFrame(
            conversationId,
            slot,
            effectiveSignal,
            finalTarget.url.href
          )
          return {
            url: finalTarget.url.href,
            origin: finalTarget.origin
          }
        } catch (error) {
          await this.releaseSlot(slot).catch(() => undefined)
          throw error
        }
      }, 'loading')
    } catch (error) {
      if (this.shouldEmitFailure(conversationId, signal, error)) {
        this.emitFailure(conversationId, '浏览器导航', error)
      }
      throw error
    }
  }

  async snapshot(
    conversationId: string,
    signal: AbortSignal
  ): Promise<BrowserSnapshot> {
    return this.runInSession(
      conversationId,
      signal,
      'acting',
      '读取浏览器页面',
      async (slot, effectiveSignal) => {
        await this.verifyCurrentOriginOrRelease(slot)
        const snapshot = await slot.driver.snapshot(effectiveSignal)
        const target = canonicalizeBrowserUrl(snapshot.url)
        if (target.origin !== slot.origin) {
          await this.releaseSlot(slot).catch(() => undefined)
          throw new Error('浏览器快照来源与当前会话不一致')
        }
        await this.captureFrame(
          conversationId,
          slot,
          effectiveSignal,
          target.href
        )
        return { ...snapshot, url: target.href }
      }
    )
  }

  async click(
    conversationId: string,
    ref: string,
    signal: AbortSignal
  ): Promise<void> {
    await this.runInSession(
      conversationId,
      signal,
      'acting',
      '浏览器点击',
      async (slot, effectiveSignal) => {
        await this.verifyCurrentOriginOrRelease(slot)
        await slot.driver.click(ref, effectiveSignal)
        await this.captureFrame(conversationId, slot, effectiveSignal)
      }
    )
  }

  async type(
    conversationId: string,
    ref: string,
    text: string,
    signal: AbortSignal
  ): Promise<void> {
    await this.runInSession(
      conversationId,
      signal,
      'acting',
      '浏览器输入',
      async (slot, effectiveSignal) => {
        await this.verifyCurrentOriginOrRelease(slot)
        await slot.driver.type(ref, text, effectiveSignal)
        await this.captureFrame(conversationId, slot, effectiveSignal)
      }
    )
  }

  async select(
    conversationId: string,
    ref: string,
    value: string,
    signal: AbortSignal
  ): Promise<void> {
    await this.runInSession(
      conversationId,
      signal,
      'acting',
      '浏览器选择',
      async (slot, effectiveSignal) => {
        await this.verifyCurrentOriginOrRelease(slot)
        await slot.driver.select(ref, value, effectiveSignal)
        await this.captureFrame(conversationId, slot, effectiveSignal)
      }
    )
  }

  async back(
    conversationId: string,
    signal: AbortSignal
  ): Promise<{ url: string; origin: string }> {
    return this.runInSession(
      conversationId,
      signal,
      'loading',
      '浏览器返回',
      async (slot, effectiveSignal) => {
        await this.verifyCurrentOriginOrRelease(slot)
        const historyTarget =
          await slot.driver.getBackTarget(effectiveSignal)
        const target = await this.policy.validate(
          historyTarget.url,
          effectiveSignal
        )
        slot.session.approveNavigation(target)
        try {
          const result = await slot.driver.backTo(
            historyTarget,
            effectiveSignal
          )
          const finalTarget = await this.policy.validateRedirect(
            result.url,
            target.origin,
            effectiveSignal
          )
          if (slot.session.getCurrentOrigin() !== finalTarget.origin) {
            throw new Error('浏览器返回结果来源不一致')
          }
          slot.origin = finalTarget.origin
          await this.captureFrame(
            conversationId,
            slot,
            effectiveSignal,
            finalTarget.url.href
          )
          return {
            url: finalTarget.url.href,
            origin: finalTarget.origin
          }
        } catch (error) {
          await this.releaseSlot(slot).catch(() => undefined)
          throw error
        }
      }
    )
  }

  async screenshot(
    conversationId: string,
    signal: AbortSignal
  ): Promise<BrowserScreenshot> {
    return this.runInSession(
      conversationId,
      signal,
      'acting',
      '浏览器截图',
      async (slot, effectiveSignal) => {
        await this.verifyCurrentOriginOrRelease(slot)
        const screenshot =
          slot.session.captureScreenshot
            ? await slot.session.captureScreenshot(effectiveSignal)
            : await slot.driver.screenshot(effectiveSignal)
        await this.captureFrame(
          conversationId,
          slot,
          effectiveSignal,
          undefined,
          screenshot
        )
        return screenshot
      }
    )
  }

  async releaseConversation(conversationId: string): Promise<void> {
    this.releaseRequests.add(conversationId)
    let releasedSlot = false
    try {
      const creation = this.creations.get(conversationId)
      if (creation) {
        creation.controller.abort(new Error('浏览器会话已释放'))
        const slot = await creation.promise.catch(() => undefined)
        if (slot) {
          await this.releaseSlot(slot)
          releasedSlot = true
        }
      }
      const slot = this.slots.get(conversationId)
      if (slot) {
        await this.releaseSlot(slot)
        releasedSlot = true
      }
      if (!releasedSlot) {
        this.emitState(conversationId, 'stopped')
      }
    } finally {
      if (!this.disposed) {
        this.releaseRequests.delete(conversationId)
      }
    }
  }

  private async releaseSlot(slot: BrowserSlot): Promise<void> {
    if (slot.released) {
      return
    }
    slot.released = true
    this.slots.delete(slot.conversationId)
    if (slot.idleTimer) {
      clearTimeout(slot.idleTimer)
      slot.idleTimer = undefined
    }
    slot.active?.abort(new Error('浏览器会话已释放'))
    try {
      slot.driver.dispose()
    } finally {
      try {
        await boundedCleanup(slot.session.dispose(), this.cleanupTimeoutMs)
      } finally {
        this.emitState(slot.conversationId, 'stopped')
      }
    }
  }

  clearSessions(): Promise<void> {
    if (this.disposed) {
      return Promise.resolve()
    }
    if (this.clearOperation) {
      return this.clearOperation
    }
    const operation = this.performClearSessions()
    this.clearOperation = operation
    void operation.then(
      () => {
        if (this.clearOperation === operation) {
          this.clearOperation = undefined
        }
      },
      () => {
        if (this.clearOperation === operation) {
          this.clearOperation = undefined
        }
      }
    )
    return operation
  }

  private async performClearSessions(): Promise<void> {
    this.clearing = true
    const lifecycle = this.lifecycle
    lifecycle.abort(new Error('浏览器会话已清除'))
    const requestedReleases = new Set(this.creations.keys())
    for (const conversationId of requestedReleases) {
      this.releaseRequests.add(conversationId)
    }
    const slots = new Set(this.slots.values())
    try {
      await Promise.allSettled(
        [...this.creations.values()].map((creation) => creation.promise)
      )
      for (const slot of this.slots.values()) {
        slots.add(slot)
      }
      await Promise.allSettled(
        [...slots].map((slot) => this.releaseSlot(slot))
      )
      this.slots.clear()
    } finally {
      if (!this.disposed) {
        for (const conversationId of requestedReleases) {
          this.releaseRequests.delete(conversationId)
        }
        this.lifecycle = new AbortController()
        this.clearing = false
      }
    }
  }

  async dispose(): Promise<void> {
    if (this.disposed) {
      return
    }
    this.disposed = true
    this.clearing = true
    this.lifecycle.abort(new Error('浏览器服务已关闭'))
    const slots = new Set(this.slots.values())
    for (const [conversationId, creation] of this.creations) {
      this.releaseRequests.add(conversationId)
      creation.controller.abort(new Error('浏览器服务已关闭'))
      const created = await creation.promise.catch(() => undefined)
      if (created) {
        slots.add(created)
      }
    }
    for (const slot of this.slots.values()) {
      slots.add(slot)
    }
    await Promise.allSettled([...slots].map((slot) => this.releaseSlot(slot)))
    this.slots.clear()
    this.stateListeners.clear()
    this.liveStates.clear()
  }
}

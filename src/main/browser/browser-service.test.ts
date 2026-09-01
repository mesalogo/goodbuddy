import { afterEach, describe, expect, it, vi } from 'vitest'
import { BrowserUrlPolicy, canonicalizeBrowserUrl } from './browser-url-policy'
import {
  BrowserNavigationStoppedError,
  BrowserService,
  type BrowserDriverLike,
  type BrowserSessionLike
} from './browser-service'
import type { BrowserWebContents } from './electron-browser-session'
import type { BrowserLiveState } from '../../shared/contracts'

type HarnessSlot = {
  currentOrigin?: string
  currentUrl?: string
  approvedOrigin?: string
  emitLoading(isLoading: boolean): void
  session: BrowserSessionLike
  driver: BrowserDriverLike
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function createHarness(options: {
  maximumSessions?: number
  idleTimeoutMs?: number
  cleanupTimeoutMs?: number
  dispose?: () => Promise<void>
  sessionGate?: Promise<void>
  captureScreenshot?: (
    signal: AbortSignal
  ) => Promise<{
    type: 'image'
    mimeType: 'image/jpeg'
    data: string
  }>
  driverScreenshot?: BrowserDriverLike['screenshot']
} = {}) {
  const slots: HarnessSlot[] = []
  const byContents = new Map<BrowserWebContents, HarnessSlot>()
  const dnsResolver = vi.fn(async () => [
    { address: '93.184.216.34', family: 4 as const }
  ])
  const createSession = vi.fn(async (): Promise<BrowserSessionLike> => {
    await options.sessionGate
    const slot = {} as HarnessSlot
    const webContents = {
      getURL: () => slot.currentUrl ?? `${slot.currentOrigin}/page`
    } as BrowserWebContents
    const loadingListeners = new Set<(isLoading: boolean) => void>()
    let isLoading = false
    const session: BrowserSessionLike = {
      webContents,
      approveNavigation: vi.fn((target) => {
        slot.approvedOrigin = target.origin
      }),
      getCurrentOrigin: vi.fn(() => slot.currentOrigin),
      isLoading: vi.fn(() => isLoading),
      onLoadingChange: vi.fn((listener) => {
        loadingListeners.add(listener)
        return () => loadingListeners.delete(listener)
      }),
      openInteraction: vi.fn(async () => undefined),
      stopLoading: vi.fn(),
      ...(options.captureScreenshot
        ? { captureScreenshot: vi.fn(options.captureScreenshot) }
        : {}),
      dispose: vi.fn(options.dispose ?? (async () => undefined))
    }
    const driver: BrowserDriverLike = {
      navigate: vi.fn(async (url) => {
        slot.currentOrigin = canonicalizeBrowserUrl(url).origin
        slot.currentUrl = url
        return { url }
      }),
      reload: vi.fn(async () => ({
        url: slot.currentUrl ?? `${slot.currentOrigin}/page`
      })),
      snapshot: vi.fn(async () => ({
        url: `${slot.currentOrigin}/page`,
        title: 'Page',
        nodes: [],
        truncated: false
      })),
      click: vi.fn(async () => undefined),
      type: vi.fn(async () => undefined),
      select: vi.fn(async () => undefined),
      getBackTarget: vi.fn(async () => ({
        entryId: 4,
        url: 'https://previous.example/back'
      })),
      backTo: vi.fn(async (target) => {
        slot.currentOrigin = canonicalizeBrowserUrl(target.url).origin
        slot.currentUrl = target.url
        return { url: target.url }
      }),
      getNavigationMetadata: vi.fn(async () => ({
        url: slot.currentUrl ?? `${slot.currentOrigin}/page`,
        canGoBack: false
      })),
      screenshot: vi.fn(
        options.driverScreenshot ??
          (async () => ({
            type: 'image' as const,
            mimeType: 'image/jpeg' as const,
            data: '/9j/2Q=='
          }))
      ),
      dispose: vi.fn()
    }
    Object.assign(slot, {
      session,
      driver,
      emitLoading: (loading: boolean) => {
        isLoading = loading
        for (const listener of loadingListeners) {
          listener(loading)
        }
      }
    })
    slots.push(slot)
    byContents.set(webContents, slot)
    return session
  })
  const service = new BrowserService({
    policy: new BrowserUrlPolicy(dnsResolver),
    maximumSessions: options.maximumSessions,
    idleTimeoutMs: options.idleTimeoutMs,
    cleanupTimeoutMs: options.cleanupTimeoutMs,
    liveFrameDelayMs: 0,
    createSession,
    createDriver: (contents) => {
      const slot = byContents.get(contents)
      if (!slot) {
        throw new Error('unknown contents')
      }
      return slot.driver
    }
  })
  return { createSession, dnsResolver, service, slots }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('BrowserService', () => {
  it('publishes browser status and live frames through session cleanup', async () => {
    const harness = createHarness()
    const states: Array<{
      status: string
      frameDataUrl?: string
    }> = []
    const removeListener = harness.service.onState((state) => {
      states.push(state)
    })
    const signal = new AbortController().signal

    await harness.service.navigate(
      'conversation',
      'https://example.com/',
      signal
    )
    await harness.service.click('conversation', 'button_ref', signal)
    await harness.service.releaseConversation('conversation')

    expect(states.map((state) => state.status)).toEqual([
      'creating',
      'loading',
      'ready',
      'acting',
      'ready',
      'stopped'
    ])
    expect(states[0]).toMatchObject({
      sessionActive: false,
      isLoading: true,
      canGoBack: false
    })
    expect(states.find((state) => state.status === 'ready')).toMatchObject({
      sessionActive: true,
      isLoading: false
    })
    expect(states.at(-1)).toMatchObject({
      sessionActive: false,
      isLoading: false,
      canGoBack: false
    })
    expect(states.find((state) => state.status === 'ready')?.frameDataUrl).toBe(
      'data:image/jpeg;base64,/9j/2Q=='
    )
    expect(states.at(-1)?.frameDataUrl).toBeUndefined()
    const replayed: string[] = []
    const removeReplayListener = harness.service.onState((state) => {
      replayed.push(state.status)
    })
    expect(replayed).toEqual([])
    removeReplayListener()
    removeListener()
    await harness.service.dispose()
  })

  it('does not publish ready after a session is stopped during frame capture', async () => {
    const harness = createHarness()
    const signal = new AbortController().signal
    const states: BrowserLiveState[] = []
    harness.service.onState((state) => states.push(state))
    await harness.service.navigate(
      'conversation',
      'https://example.com/',
      signal
    )
    const slot = harness.slots[0]
    if (!slot) {
      throw new Error('slot missing')
    }
    vi.mocked(slot.driver.screenshot).mockImplementationOnce(
      async (operationSignal) =>
        new Promise<never>((_resolve, reject) => {
          operationSignal.addEventListener(
            'abort',
            () => reject(operationSignal.reason),
            { once: true }
          )
        })
    )

    const click = harness.service.click(
      'conversation',
      'button_ref',
      signal
    )
    await vi.waitFor(() =>
      expect(slot.driver.screenshot).toHaveBeenCalledTimes(2)
    )
    await harness.service.releaseConversation('conversation')

    await expect(click).rejects.toThrow('浏览器会话已释放')
    expect(states.at(-1)?.status).toBe('stopped')
  })

  it('falls back to CDP when native capture cannot produce the live frame', async () => {
    const nativeCapture = vi.fn(async () => {
      throw new Error('native capture unavailable while hidden')
    })
    const harness = createHarness({
      captureScreenshot: nativeCapture
    })
    const states: BrowserLiveState[] = []
    harness.service.onState((state) => states.push(state))

    await harness.service.navigate(
      'conversation',
      'https://example.com/',
      new AbortController().signal
    )

    expect(nativeCapture).toHaveBeenCalledOnce()
    expect(harness.slots[0]?.driver.screenshot).toHaveBeenCalledOnce()
    expect(states.at(-1)).toMatchObject({
      status: 'ready',
      frameDataUrl: 'data:image/jpeg;base64,/9j/2Q=='
    })
    await harness.service.dispose()
  })

  it('retries live capture while a newly committed page starts painting', async () => {
    let attempts = 0
    const harness = createHarness({
      captureScreenshot: async () => {
        attempts += 1
        if (attempts === 1) {
          throw new Error('page has not painted yet')
        }
        return {
          type: 'image',
          mimeType: 'image/jpeg',
          data: '/9j/2Q=='
        }
      },
      driverScreenshot: async () => {
        throw new Error('CDP frame not ready')
      }
    })
    const states: BrowserLiveState[] = []
    harness.service.onState((state) => states.push(state))

    await harness.service.navigate(
      'conversation',
      'https://example.com/',
      new AbortController().signal
    )

    expect(attempts).toBe(2)
    expect(states.at(-1)).toMatchObject({
      status: 'ready',
      frameDataUrl: 'data:image/jpeg;base64,/9j/2Q=='
    })
    await harness.service.dispose()
  })

  it('reports a live-frame failure instead of waiting indefinitely', async () => {
    const harness = createHarness({
      captureScreenshot: async () => {
        throw new Error('native capture failed')
      },
      driverScreenshot: async () => {
        throw new Error('CDP capture failed')
      }
    })
    const states: BrowserLiveState[] = []
    harness.service.onState((state) => states.push(state))

    await harness.service.navigate(
      'conversation',
      'https://example.com/',
      new AbortController().signal
    )

    expect(states.at(-1)).toMatchObject({
      status: 'failed',
      error: '页面已就绪，但实时画面捕获失败，请重试浏览器操作'
    })
    await harness.service.dispose()
  })

  it('keeps the last frame when a later refresh cannot capture a minimized window', async () => {
    let nativeAttempts = 0
    const harness = createHarness({
      captureScreenshot: async () => {
        nativeAttempts += 1
        if (nativeAttempts === 1) {
          return {
            type: 'image',
            mimeType: 'image/jpeg',
            data: '/9j/2Q=='
          }
        }
        throw new Error('minimized native capture unavailable')
      },
      driverScreenshot: async () => {
        throw new Error('minimized CDP capture unavailable')
      }
    })
    const states: BrowserLiveState[] = []
    harness.service.onState((state) => states.push(state))
    const signal = new AbortController().signal
    await harness.service.navigate(
      'conversation',
      'https://example.com/',
      signal
    )

    await harness.service.click('conversation', 'button_ref', signal)

    expect(states.at(-1)).toMatchObject({
      status: 'ready',
      frameDataUrl: 'data:image/jpeg;base64,/9j/2Q=='
    })
    await harness.service.dispose()
  })

  it('isolates browser state and drivers by conversation', async () => {
    const harness = createHarness()
    const signal = new AbortController().signal
    await harness.service.navigate('conversation-a', 'https://a.example/', signal)
    await harness.service.navigate('conversation-b', 'https://b.example/', signal)
    await harness.service.snapshot('conversation-a', signal)

    expect(harness.service.getSessionCount()).toBe(2)
    expect(harness.service.getOrigin('conversation-a')).toBe(
      'https://a.example'
    )
    expect(harness.service.getOrigin('conversation-b')).toBe(
      'https://b.example'
    )
    expect(harness.slots[0]?.driver.snapshot).toHaveBeenCalledOnce()
    expect(harness.slots[1]?.driver.snapshot).not.toHaveBeenCalled()
    await harness.service.dispose()
  })

  it('enforces a hard maximum of three sessions', async () => {
    const harness = createHarness({ maximumSessions: 3 })
    const signal = new AbortController().signal
    for (const id of ['one', 'two', 'three']) {
      await harness.service.navigate(id, `https://${id}.example/`, signal)
    }
    await expect(
      harness.service.navigate('four', 'https://four.example/', signal)
    ).rejects.toThrow('3 个上限')
    expect(harness.createSession).toHaveBeenCalledTimes(3)
    await harness.service.dispose()
  })

  it('serializes operations in one conversation and lets queued callers cancel', async () => {
    const harness = createHarness()
    const signal = new AbortController().signal
    await harness.service.navigate('conversation', 'https://a.example/', signal)
    const clickGate = deferred<void>()
    const slot = harness.slots[0]
    if (!slot) {
      throw new Error('slot missing')
    }
    vi.mocked(slot.driver.click).mockImplementationOnce(async () =>
      clickGate.promise
    )

    const click = harness.service.click('conversation', 'b_ref', signal)
    await vi.waitFor(() => expect(slot.driver.click).toHaveBeenCalled())
    const queuedController = new AbortController()
    const queued = harness.service.snapshot(
      'conversation',
      queuedController.signal
    )
    queuedController.abort(new Error('cancel queued'))
    await expect(queued).rejects.toThrow('cancel queued')
    expect(slot.driver.snapshot).not.toHaveBeenCalled()
    clickGate.resolve()
    await click
    await harness.service.dispose()
  })

  it('serializes user navigation behind an active Agent action', async () => {
    const harness = createHarness()
    const signal = new AbortController().signal
    await harness.service.navigate(
      'conversation',
      'https://a.example/',
      signal
    )
    const clickGate = deferred<void>()
    const slot = harness.slots[0]
    if (!slot) {
      throw new Error('slot missing')
    }
    vi.mocked(slot.driver.click).mockImplementationOnce(async () =>
      clickGate.promise
    )

    const click = harness.service.click('conversation', 'b_ref', signal)
    await vi.waitFor(() => expect(slot.driver.click).toHaveBeenCalled())
    const navigation = harness.service.navigate(
      'conversation',
      'https://b.example/',
      signal
    )
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(slot.driver.navigate).toHaveBeenCalledTimes(1)

    clickGate.resolve()
    await click
    await navigation
    expect(slot.driver.navigate).toHaveBeenLastCalledWith(
      'https://b.example/',
      expect.any(AbortSignal)
    )
    await harness.service.dispose()
  })

  it('pauses agent operations while the user interacts with the same session', async () => {
    const harness = createHarness()
    const signal = new AbortController().signal
    const states: BrowserLiveState[] = []
    harness.service.onState((state) => states.push(state))
    await harness.service.navigate(
      'conversation',
      'https://a.example/',
      signal
    )
    const interactionGate = deferred<
      Awaited<ReturnType<BrowserSessionLike['openInteraction']>>
    >()
    const slot = harness.slots[0]
    if (!slot) {
      throw new Error('slot missing')
    }
    vi.mocked(slot.session.openInteraction).mockReturnValueOnce(
      interactionGate.promise
    )

    const interaction = harness.service.interact(
      'conversation',
      signal
    )
    await vi.waitFor(() =>
      expect(slot.session.openInteraction).toHaveBeenCalledOnce()
    )
    const snapshot = harness.service.snapshot('conversation', signal)
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(slot.driver.snapshot).not.toHaveBeenCalled()

    interactionGate.resolve({
      type: 'image',
      mimeType: 'image/jpeg',
      data: 'closing-frame'
    })
    await interaction
    expect(states.slice(-2).map((state) => state.status)).toEqual([
      'interactive',
      'ready'
    ])
    expect(states.at(-1)?.frameDataUrl).toBe(
      'data:image/jpeg;base64,closing-frame'
    )
    expect(harness.service.getSessionCount()).toBe(1)
    expect(slot.session.dispose).not.toHaveBeenCalled()
    await snapshot
    expect(slot.driver.snapshot).toHaveBeenCalledOnce()
    await harness.service.dispose()
  })

  it('does not let a canceled queued waiter clear the active operation owner', async () => {
    const harness = createHarness()
    const signal = new AbortController().signal
    await harness.service.navigate('conversation', 'https://a.example/', signal)
    const clickGate = deferred<void>()
    const slot = harness.slots[0]
    if (!slot) {
      throw new Error('slot missing')
    }
    let activeSignal: AbortSignal | undefined
    vi.mocked(slot.driver.click).mockImplementationOnce(
      async (_ref, operationSignal) => {
        activeSignal = operationSignal
        await clickGate.promise
      }
    )

    const click = harness.service.click('conversation', 'b_ref', signal)
    await vi.waitFor(() => expect(activeSignal).toBeDefined())
    const queuedController = new AbortController()
    const queued = harness.service.snapshot(
      'conversation',
      queuedController.signal
    )
    queuedController.abort(new Error('cancel queued'))
    await expect(queued).rejects.toThrow('cancel queued')
    const clickResult = expect(click).rejects.toThrow(
      '浏览器会话已释放'
    )
    await harness.service.releaseConversation('conversation')
    expect(activeSignal?.aborted).toBe(true)
    clickGate.resolve()
    await clickResult
    await harness.service.dispose()
  })

  it('abandons a sole canceled creation without retaining or consuming a slot', async () => {
    const creationGate = deferred<void>()
    const harness = createHarness({
      maximumSessions: 1,
      sessionGate: creationGate.promise
    })
    const canceledController = new AbortController()
    const canceled = harness.service.navigate(
      'canceled',
      'https://canceled.example/',
      canceledController.signal
    )
    await vi.waitFor(() => expect(harness.createSession).toHaveBeenCalledOnce())
    canceledController.abort(new Error('cancel creation'))
    await expect(canceled).rejects.toThrow('cancel creation')
    expect(harness.service.getSessionCount()).toBe(0)

    const replacement = harness.service.navigate(
      'replacement',
      'https://replacement.example/',
      new AbortController().signal
    )
    await vi.waitFor(() =>
      expect(harness.createSession).toHaveBeenCalledTimes(2)
    )
    creationGate.resolve()
    await expect(replacement).resolves.toMatchObject({
      origin: 'https://replacement.example'
    })
    expect(harness.service.getSessionCount()).toBe(1)
    expect(harness.slots[0]?.session.dispose).toHaveBeenCalledOnce()
    await harness.service.dispose()
  })

  it('preserves a shared creation while another waiter cancels', async () => {
    const creationGate = deferred<void>()
    const harness = createHarness({ sessionGate: creationGate.promise })
    const canceledController = new AbortController()
    const canceled = harness.service.navigate(
      'conversation',
      'https://example.com/first',
      canceledController.signal
    )
    const shared = harness.service.navigate(
      'conversation',
      'https://example.com/second',
      new AbortController().signal
    )
    await vi.waitFor(() => expect(harness.createSession).toHaveBeenCalledOnce())
    canceledController.abort(new Error('cancel one waiter'))
    await expect(canceled).rejects.toThrow('cancel one waiter')

    creationGate.resolve()
    await expect(shared).resolves.toMatchObject({
      origin: 'https://example.com'
    })
    expect(harness.service.getSessionCount()).toBe(1)
    expect(harness.slots[0]?.session.dispose).not.toHaveBeenCalled()
    await harness.service.dispose()
  })

  it('expires idle sessions and clears their isolated resources', async () => {
    vi.useFakeTimers()
    const harness = createHarness({ idleTimeoutMs: 100 })
    await harness.service.navigate(
      'conversation',
      'https://a.example/',
      new AbortController().signal
    )
    await vi.advanceTimersByTimeAsync(101)
    await vi.waitFor(() => expect(harness.service.getSessionCount()).toBe(0))
    expect(harness.slots[0]?.driver.dispose).toHaveBeenCalledOnce()
    expect(harness.slots[0]?.session.dispose).toHaveBeenCalledOnce()
    await harness.service.dispose()
  })

  it('tracks an approved origin across validated back navigation', async () => {
    const harness = createHarness()
    const signal = new AbortController().signal
    await harness.service.navigate(
      'conversation',
      'https://current.example/',
      signal
    )
    await expect(harness.service.back('conversation', signal)).resolves.toEqual({
      url: 'https://previous.example/back',
      origin: 'https://previous.example'
    })
    expect(harness.service.getOrigin('conversation')).toBe(
      'https://previous.example'
    )
    expect(harness.slots[0]?.approvedOrigin).toBe(
      'https://previous.example'
    )
    await harness.service.dispose()
  })

  it('reloads in the retained session and publishes actual history metadata', async () => {
    const harness = createHarness()
    const states: BrowserLiveState[] = []
    harness.service.onState((state) => states.push(state))
    const signal = new AbortController().signal
    await harness.service.navigate(
      'conversation',
      'https://example.com/first',
      signal
    )
    const slot = harness.slots[0]
    if (!slot) {
      throw new Error('slot missing')
    }
    vi.mocked(slot.driver.getNavigationMetadata).mockResolvedValue({
      url: 'https://example.com/committed',
      canGoBack: true
    })
    slot.currentUrl = 'https://example.com/committed'

    await expect(
      harness.service.reload('conversation', signal)
    ).resolves.toEqual({
      url: 'https://example.com/committed',
      origin: 'https://example.com'
    })
    expect(slot.driver.reload).toHaveBeenCalledOnce()
    expect(states.at(-1)).toMatchObject({
      status: 'ready',
      url: 'https://example.com/committed',
      canGoBack: true,
      sessionActive: true,
      isLoading: false
    })
    await harness.service.dispose()
  })

  it('stops only active navigation and retains the reusable session', async () => {
    const harness = createHarness()
    const states: BrowserLiveState[] = []
    harness.service.onState((state) => states.push(state))
    const signal = new AbortController().signal
    await harness.service.navigate(
      'conversation',
      'https://example.com/first',
      signal
    )
    const slot = harness.slots[0]
    if (!slot) {
      throw new Error('slot missing')
    }
    vi.mocked(slot.driver.navigate).mockImplementationOnce(
      async (_url, operationSignal) =>
        new Promise<never>((_resolve, reject) => {
          operationSignal.addEventListener(
            'abort',
            () => reject(operationSignal.reason),
            { once: true }
          )
        })
    )

    const navigation = harness.service.navigate(
      'conversation',
      'https://example.com/slow',
      signal
    )
    await vi.waitFor(() =>
      expect(slot.driver.navigate).toHaveBeenCalledTimes(2)
    )
    await expect(
      harness.service.stopLoading('conversation')
    ).resolves.toBe(true)
    await expect(
      harness.service.stopLoading('conversation')
    ).resolves.toBe(false)

    await expect(navigation).rejects.toBeInstanceOf(
      BrowserNavigationStoppedError
    )
    expect(slot.session.stopLoading).toHaveBeenCalledOnce()
    expect(slot.session.dispose).not.toHaveBeenCalled()
    expect(harness.service.getSessionCount()).toBe(1)
    expect(states.at(-1)).toMatchObject({
      status: 'ready',
      url: 'https://example.com/first',
      sessionActive: true,
      isLoading: false
    })
    await harness.service.dispose()
  })

  it('stops click-triggered page loading without releasing the session', async () => {
    const harness = createHarness()
    const states: BrowserLiveState[] = []
    harness.service.onState((state) => states.push(state))
    const signal = new AbortController().signal
    await harness.service.navigate(
      'conversation',
      'https://example.com/',
      signal
    )
    const slot = harness.slots[0]
    if (!slot) {
      throw new Error('slot missing')
    }
    vi.mocked(slot.driver.click).mockImplementationOnce(
      async (_ref, operationSignal) =>
        new Promise<never>((_resolve, reject) => {
          slot.emitLoading(true)
          operationSignal.addEventListener(
            'abort',
            () => reject(operationSignal.reason),
            { once: true }
          )
        })
    )
    const click = harness.service.click('conversation', 'b_ref', signal)
    await vi.waitFor(() =>
      expect(states.at(-1)).toMatchObject({
        status: 'acting',
        isLoading: true
      })
    )

    await expect(
      harness.service.stopLoading('conversation')
    ).resolves.toBe(true)
    await expect(click).rejects.toBeInstanceOf(
      BrowserNavigationStoppedError
    )
    expect(slot.session.stopLoading).toHaveBeenCalledOnce()
    expect(slot.session.dispose).not.toHaveBeenCalled()
    expect(states.at(-1)).toMatchObject({
      status: 'ready',
      isLoading: false
    })
    await harness.service.dispose()
  })

  it('stops a page load that outlives the click operation', async () => {
    const harness = createHarness()
    const signal = new AbortController().signal
    await harness.service.navigate(
      'conversation',
      'https://example.com/',
      signal
    )
    const slot = harness.slots[0]
    if (!slot) {
      throw new Error('slot missing')
    }

    await harness.service.click('conversation', 'b_ref', signal)
    slot.emitLoading(true)

    await expect(
      harness.service.stopLoading('conversation')
    ).resolves.toBe(true)
    await expect(
      harness.service.stopLoading('conversation')
    ).resolves.toBe(false)
    expect(slot.session.stopLoading).toHaveBeenCalledOnce()
    expect(slot.session.dispose).not.toHaveBeenCalled()

    slot.emitLoading(false)
    slot.emitLoading(true)
    await expect(
      harness.service.stopLoading('conversation')
    ).resolves.toBe(true)
    expect(slot.session.stopLoading).toHaveBeenCalledTimes(2)
    await harness.service.dispose()
  })

  it('never interrupts noninterruptible operations even when loading events fire', async () => {
    const harness = createHarness()
    const signal = new AbortController().signal
    await harness.service.navigate(
      'conversation',
      'https://example.com/',
      signal
    )
    const slot = harness.slots[0]
    if (!slot) {
      throw new Error('slot missing')
    }
    const typeGate = deferred<void>()
    vi.mocked(slot.driver.type).mockImplementationOnce(async () => {
      slot.emitLoading(true)
      await typeGate.promise
    })

    const typing = harness.service.type(
      'conversation',
      'input_ref',
      'text',
      signal
    )
    await vi.waitFor(() => expect(slot.driver.type).toHaveBeenCalled())

    await expect(
      harness.service.stopLoading('conversation')
    ).resolves.toBe(false)
    expect(slot.session.stopLoading).not.toHaveBeenCalled()
    slot.emitLoading(false)
    typeGate.resolve()
    await expect(typing).resolves.toBeUndefined()
    await harness.service.dispose()
  })

  it('does not resolve DNS again while refreshing frame metadata', async () => {
    const harness = createHarness()
    const signal = new AbortController().signal
    await harness.service.navigate(
      'conversation',
      'https://example.com/',
      signal
    )
    expect(harness.dnsResolver).toHaveBeenCalledTimes(2)

    await harness.service.click('conversation', 'button_ref', signal)

    expect(harness.dnsResolver).toHaveBeenCalledTimes(2)
    await harness.service.dispose()
  })

  it('fails closed and releases a slot when navigation origin does not match', async () => {
    const harness = createHarness()
    await harness.service.navigate(
      'conversation',
      'https://example.com/',
      new AbortController().signal
    )
    const slot = harness.slots[0]
    if (!slot) {
      throw new Error('slot missing')
    }
    slot.currentOrigin = 'https://attacker.example'
    await expect(
      harness.service.snapshot(
        'conversation',
        new AbortController().signal
      )
    ).rejects.toThrow('来源已改变')
    expect(harness.service.getSessionCount()).toBe(0)
    expect(slot.session.dispose).toHaveBeenCalled()
    await harness.service.dispose()
  })

  it('bounds cleanup and makes release and dispose idempotent', async () => {
    const harness = createHarness({
      cleanupTimeoutMs: 5,
      dispose: async () => new Promise(() => undefined)
    })
    await harness.service.navigate(
      'conversation',
      'https://example.com/',
      new AbortController().signal
    )
    await expect(
      harness.service.releaseConversation('conversation')
    ).rejects.toThrow('清理超时')
    expect(harness.service.getSessionCount()).toBe(0)
    await harness.service.releaseConversation('conversation')
    await harness.service.dispose()
    await harness.service.dispose()
  })

  it('settles a creation and release race without blocking later reuse', async () => {
    const creationGate = deferred<void>()
    const harness = createHarness({ sessionGate: creationGate.promise })
    const firstNavigation = harness.service.navigate(
      'conversation',
      'https://example.com/',
      new AbortController().signal
    )
    await vi.waitFor(() => expect(harness.createSession).toHaveBeenCalledOnce())

    const release = harness.service.releaseConversation('conversation')
    creationGate.resolve()
    await release
    await expect(firstNavigation).rejects.toThrow()
    expect(harness.service.getSessionCount()).toBe(0)
    expect(harness.slots[0]?.session.dispose).toHaveBeenCalledOnce()

    await expect(
      harness.service.navigate(
        'conversation',
        'https://example.com/new',
        new AbortController().signal
      )
    ).resolves.toMatchObject({ origin: 'https://example.com' })
    expect(harness.createSession).toHaveBeenCalledTimes(2)
    await harness.service.dispose()
  })

  it('clears current sessions and remains reusable', async () => {
    const harness = createHarness()
    const signal = new AbortController().signal
    await harness.service.navigate(
      'conversation',
      'https://example.com/',
      signal
    )

    await harness.service.clearSessions()
    expect(harness.service.getSessionCount()).toBe(0)
    expect(harness.slots[0]?.session.dispose).toHaveBeenCalledOnce()

    await expect(
      harness.service.navigate(
        'conversation',
        'https://example.com/again',
        signal
      )
    ).resolves.toMatchObject({ origin: 'https://example.com' })
    expect(harness.createSession).toHaveBeenCalledTimes(2)
    await harness.service.dispose()
  })
})

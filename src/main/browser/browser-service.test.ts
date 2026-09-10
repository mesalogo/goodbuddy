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
  emitNavigation(url: string): void
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
  maximumTabsPerConversation?: number
  maximumTabsPerWindow?: number
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
    const navigationListeners = new Set<(url: string) => void>()
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
      onNavigationChange: vi.fn((listener) => {
        navigationListeners.add(listener)
        return () => navigationListeners.delete(listener)
      }),
      setViewport: vi.fn(),
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
      },
      emitNavigation: (url: string) => {
        slot.currentUrl = url
        slot.currentOrigin = canonicalizeBrowserUrl(url).origin
        for (const listener of navigationListeners) {
          listener(url)
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
    maximumTabsPerConversation: options.maximumTabsPerConversation,
    maximumTabsPerWindow: options.maximumTabsPerWindow,
    idleTimeoutMs: options.idleTimeoutMs,
    cleanupTimeoutMs: options.cleanupTimeoutMs,
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
  const firstLeaseToken = '7d201980-0ad4-4670-81d4-dc2bf79f03b2'
  const secondLeaseToken = 'db8a2c28-43a6-4aab-93e0-1c01b9374dca'
  const workbarInstanceId = '0387bd61-3a12-40ce-98d7-ef5d14cc8251'

  it('reserves four unused requests without resources, events, or consuming session capacity', async () => {
    const harness = createHarness({ maximumSessions: 3 })
    const states: BrowserLiveState[] = []
    harness.service.onState((state) => states.push(state))
    const leases = ['one', 'two', 'three', 'four'].map((id) =>
      harness.service.reserveRequestTab(id, `request-${id}`, 21)
    )
    expect(harness.service.getSessionCount()).toBe(0)
    expect(harness.service.getTabCount()).toBe(0)
    expect(harness.createSession).not.toHaveBeenCalled()
    expect(states).toEqual([])
    expect(harness.service.getOwnerWindowId('one')).toBe(21)
    for (const lease of leases) {
      lease.release()
      lease.release()
      expect(lease.signal.aborted).toBe(true)
      expect(harness.service.getOwnerWindowId(lease.conversationId)).toBeUndefined()
    }
    const replacement = harness.service.reserveRequestTab('one', 'replacement', 22)
    expect(replacement.tabId).not.toBe(leases[0]!.tabId)
    await expect(harness.service.navigate('one', 'https://example.com/', new AbortController().signal, leases[0]!.tabId, 22))
      .rejects.toThrow('不属于当前对话')
    expect(harness.createSession).not.toHaveBeenCalled()
    replacement.release()
    await harness.service.dispose()
  })

  it('shares the reserved identity through navigation, workbar lookup, and all usage leases', async () => {
    const harness = createHarness()
    const states: BrowserLiveState[] = []
    harness.service.onState((state) => states.push(state))
    const first = harness.service.reserveRequestTab('conversation', 'first', 21)
    const second = harness.service.reserveRequestTab('conversation', 'second', 21)
    expect(second.tabId).toBe(first.tabId)
    expect(() => harness.service.reserveRequestTab('conversation', 'wrong-window', 22)).toThrow('不属于当前窗口')
    const signal = new AbortController().signal
    await Promise.all([
      harness.service.navigate('conversation', 'https://example.com/first', signal, first.tabId),
      harness.service.navigate('conversation', 'https://example.com/second', signal, second.tabId)
    ])
    expect(harness.createSession).toHaveBeenCalledOnce()
    expect(states[0]).toMatchObject({
      status: 'creating',
      tabId: first.tabId,
      workbarInstanceId: first.tabId,
      ownerWindowId: 21
    })
    expect(states.every((state) => state.workbarInstanceId === first.tabId)).toBe(true)
    expect(harness.service.listTabs('conversation', 21)).toEqual([
      expect.objectContaining({ tabId: first.tabId, workbarInstanceId: first.tabId })
    ])
    const restored = await harness.service.createTab('conversation', 21, signal, first.tabId)
    expect(restored.tabId).toBe(first.tabId)
    expect(harness.service.getTabCount()).toBe(1)
    first.release()
    await expect(harness.service.closeTab('conversation', first.tabId, 21)).rejects.toThrow('正在被活动请求使用')
    second.release()
    await harness.service.closeTab('conversation', first.tabId, 21)
    await harness.service.closeTab('conversation', first.tabId, 21)
    await harness.service.dispose()
  })

  it('keeps a fresh explicit workbar separate from a reserved request target', async () => {
    const harness = createHarness()
    const states: BrowserLiveState[] = []
    harness.service.onState((state) => states.push(state))
    const request = harness.service.reserveRequestTab('conversation', 'request', 21)
    const signal = new AbortController().signal
    const explicit = await harness.service.createTab('conversation', 21, signal, workbarInstanceId)
    expect(explicit.tabId).not.toBe(request.tabId)
    expect(explicit.workbarInstanceId).toBe(workbarInstanceId)
    expect(harness.service.getTabCount()).toBe(1)
    expect(states.every((state) => state.tabId === explicit.tabId)).toBe(true)
    await harness.service.navigate('conversation', 'https://example.com/', signal, request.tabId, 21)
    expect(harness.service.listTabs('conversation', 21)).toHaveLength(2)
    expect(states.find((state) => state.tabId === request.tabId)).toMatchObject({
      status: 'creating',
      workbarInstanceId: request.tabId
    })
    expect(explicit.url).toBeUndefined()
    request.release()
    await harness.service.dispose()
  })

  it('publishes the explicit workbar identity from the first creating event', async () => {
    const harness = createHarness()
    const states: BrowserLiveState[] = []
    harness.service.onState((state) => states.push(state))
    const tab = await harness.service.createTab('conversation', 21, new AbortController().signal, workbarInstanceId)
    expect(states[0]).toMatchObject({ status: 'creating', tabId: tab.tabId, workbarInstanceId })
    expect(states.every((state) => state.workbarInstanceId === workbarInstanceId)).toBe(true)
    expect(tab.workbarInstanceId).toBe(workbarInstanceId)
    await expect(harness.service.createTab('conversation', 22, new AbortController().signal, workbarInstanceId)).rejects.toThrow('不属于当前窗口')
    await harness.service.dispose()
  })

  it('cleans unused reservations on conversation release, service clear, and disposal', async () => {
    const harness = createHarness()
    const first = harness.service.reserveRequestTab('first', 'first', 21)
    await expect(harness.service.releaseConversation('first', 22)).rejects.toThrow('不属于当前窗口')
    expect(first.signal.aborted).toBe(false)
    await harness.service.releaseConversation('first', 21)
    expect(first.signal.aborted).toBe(true)
    expect(harness.service.getOwnerWindowId('first')).toBeUndefined()
    const second = harness.service.reserveRequestTab('second', 'second', 21)
    await harness.service.clearSessions()
    expect(second.signal.aborted).toBe(true)
    const third = harness.service.reserveRequestTab('third', 'third', 21)
    await harness.service.dispose()
    expect(third.signal.aborted).toBe(true)
    expect(harness.createSession).not.toHaveBeenCalled()
    expect(() => harness.service.reserveRequestTab('fourth', 'fourth', 21)).toThrow('已关闭')
  })

  it('abandons materialization when the final request lease is released', async () => {
    const gate = deferred<void>()
    const harness = createHarness({ sessionGate: gate.promise })
    const states: BrowserLiveState[] = []
    harness.service.onState((state) => states.push(state))
    const request = harness.service.reserveRequestTab('conversation', 'request', 21)
    const navigation = harness.service.navigate('conversation', 'https://example.com/', new AbortController().signal, request.tabId)
    const rejection = expect(navigation).rejects.toThrow('已取消')
    await vi.waitFor(() => expect(harness.createSession).toHaveBeenCalledOnce())
    request.release()
    gate.resolve()
    await rejection
    expect(harness.service.getSessionCount()).toBe(0)
    await vi.waitFor(() => expect(harness.slots[0]!.session.dispose).toHaveBeenCalledOnce())
    expect(states.at(-1)?.status).toBe('stopped')
    await harness.service.dispose()
  })

  it('preserves shared reserved materialization when one request cancels', async () => {
    const gate = deferred<void>()
    const harness = createHarness({ sessionGate: gate.promise })
    const first = harness.service.reserveRequestTab('conversation', 'first', 21)
    const second = harness.service.reserveRequestTab('conversation', 'second', 21)
    const firstNavigation = harness.service.navigate('conversation', 'https://example.com/first', first.signal, first.tabId)
    const canceled = expect(firstNavigation).rejects.toThrow('租约已终止')
    const secondNavigation = harness.service.navigate('conversation', 'https://example.com/second', second.signal, second.tabId)
    await vi.waitFor(() => expect(harness.createSession).toHaveBeenCalledOnce())
    first.release()
    await canceled
    gate.resolve()
    await secondNavigation
    expect(harness.service.listTabs('conversation', 21)).toEqual([
      expect.objectContaining({ tabId: second.tabId, workbarInstanceId: second.tabId, url: 'https://example.com/second' })
    ])
    expect(harness.slots[0]!.session.dispose).not.toHaveBeenCalled()
    second.release()
    await harness.service.dispose()
  })

  it('retains a materialized reserved tab until the request lease stops protecting it from idle expiry', async () => {
    vi.useFakeTimers()
    const harness = createHarness({ idleTimeoutMs: 100 })
    const lease = harness.service.reserveRequestTab('conversation', 'request', 21)
    await harness.service.navigate('conversation', 'https://example.com/', lease.signal, lease.tabId)
    await vi.advanceTimersByTimeAsync(500)
    expect(harness.service.getSessionCount()).toBe(1)
    lease.release()
    await vi.advanceTimersByTimeAsync(101)
    expect(harness.service.getSessionCount()).toBe(0)
    await harness.service.dispose()
  })

  it('keeps stale close idempotent but rejects another conversation or window', async () => {
    const harness = createHarness()
    const first = await harness.service.createTab('first', 21)
    const sibling = await harness.service.createTab('first', 21)
    const other = await harness.service.createTab('other', 21)
    await harness.service.closeTab('first', sibling.tabId, 21)
    await harness.service.closeTab('first', sibling.tabId, 21)
    await expect(harness.service.closeTab('first', sibling.tabId, 22)).rejects.toThrow('不属于当前窗口')
    await expect(harness.service.closeTab('first', other.tabId, 21)).rejects.toThrow('不属于当前对话')
    await expect(harness.service.closeTab('missing', first.tabId, 21)).rejects.toThrow('不属于当前对话')
    await harness.service.dispose()
  })

  it('presents one session in the shared viewport and tracks user navigation', async () => {
    const harness = createHarness()
    const bounds = { x: 900, y: 120, width: 420, height: 640 }
    const states: BrowserLiveState[] = []
    harness.service.onState((state) => states.push(state))
    harness.service.setViewport(
      'conversation',
      bounds,
      undefined,
      firstLeaseToken
    )

    await harness.service.navigate(
      'conversation',
      'https://example.com/',
      new AbortController().signal
    )
    const slot = harness.slots[0]
    expect(slot?.session.setViewport).toHaveBeenCalledWith(bounds)

    vi.mocked(slot!.driver.getNavigationMetadata).mockResolvedValueOnce({
      url: 'https://example.com/account',
      canGoBack: true
    })
    slot?.emitNavigation('https://example.com/account')
    await vi.waitFor(() => {
      expect(states.at(-1)).toMatchObject({
        status: 'ready',
        url: 'https://example.com/account',
        canGoBack: true
      })
    })
    expect(harness.service.getOrigin('conversation')).toBe(
      'https://example.com'
    )

    harness.service.setViewport(
      undefined,
      undefined,
      undefined,
      firstLeaseToken
    )
    expect(slot?.session.setViewport).toHaveBeenLastCalledWith(undefined)
    await harness.service.dispose()
  })

  it('publishes lightweight browser status through session cleanup', async () => {
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
      'ready',
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
    expect(states.every((state) => state.frameDataUrl === undefined)).toBe(true)
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

  it('ordinary actions only refresh navigation metadata and never capture images', async () => {
    const nativeCapture = vi.fn(async () => {
      throw new Error('native capture unavailable while hidden')
    })
    const harness = createHarness({ captureScreenshot: nativeCapture })
    const signal = new AbortController().signal
    const states: BrowserLiveState[] = []
    harness.service.onState((state) => states.push(state))
    await harness.service.navigate('conversation', 'https://example.com/', signal)
    await harness.service.snapshot('conversation', signal)
    await harness.service.click('conversation', 'button_ref', signal)
    await harness.service.type('conversation', 'input_ref', 'text', signal)
    await harness.service.select('conversation', 'select_ref', 'value', signal)
    await harness.service.reload('conversation', signal)
    await harness.service.back('conversation', signal)
    const slot = harness.slots[0]!
    expect(nativeCapture).not.toHaveBeenCalled()
    expect(slot.driver.screenshot).not.toHaveBeenCalled()
    expect(slot.driver.getNavigationMetadata).toHaveBeenCalledTimes(7)
    expect(states.at(-1)?.status).toBe('ready')
    expect(states.every((state) => !('frameDataUrl' in state))).toBe(true)

    const screenshot = await harness.service.screenshot('conversation', signal)
    expect(screenshot.data).toBe('/9j/2Q==')
    expect(nativeCapture).toHaveBeenCalledOnce()
    expect(slot.driver.screenshot).toHaveBeenCalledOnce()
    expect(states.at(-1)?.status).toBe('ready')
    expect(states.every((state) => !('frameDataUrl' in state))).toBe(true)
    await harness.service.dispose()
  })

  it('does not publish ready after a session is stopped during metadata refresh', async () => {
    const harness = createHarness()
    const signal = new AbortController().signal
    const states: BrowserLiveState[] = []
    harness.service.onState((state) => states.push(state))
    await harness.service.navigate('conversation', 'https://example.com/', signal)
    const slot = harness.slots[0]!
    vi.mocked(slot.driver.getNavigationMetadata).mockImplementationOnce(
      async (operationSignal) => new Promise<never>((_resolve, reject) => {
        operationSignal.addEventListener('abort', () => reject(operationSignal.reason), { once: true })
      })
    )
    const click = harness.service.click('conversation', 'button_ref', signal)
    const rejected = expect(click).rejects.toThrow('浏览器会话已释放')
    await vi.waitFor(() => expect(slot.driver.getNavigationMetadata).toHaveBeenCalledTimes(2))
    await harness.service.releaseConversation('conversation')
    await rejected
    expect(states.at(-1)?.status).toBe('stopped')
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

  it('owns independent tabs inside one conversation and closes only the requested tab', async () => {
    const harness = createHarness()
    const signal = new AbortController().signal
    await harness.service.navigate('conversation', 'https://first.example/', signal)
    const [primary] = harness.service.listTabs('conversation', 11)
    const sibling = await harness.service.createTab('conversation', 11, signal)

    await harness.service.navigate(
      'conversation',
      'https://second.example/',
      signal,
      sibling.tabId,
      11
    )
    await harness.service.snapshot(
      'conversation',
      signal,
      sibling.tabId,
      11
    )

    expect(harness.service.getSessionCount()).toBe(1)
    expect(harness.service.getTabCount('conversation')).toBe(2)
    expect(harness.slots[0]?.driver.snapshot).not.toHaveBeenCalled()
    expect(harness.slots[1]?.driver.snapshot).toHaveBeenCalledOnce()
    await harness.service.closeTab('conversation', sibling.tabId, 11)
    expect(harness.service.getTabCount('conversation')).toBe(1)
    expect(harness.slots[1]?.session.dispose).toHaveBeenCalledOnce()
    expect(harness.slots[0]?.session.dispose).not.toHaveBeenCalled()
    expect(harness.service.listTabs('conversation', 11)[0]?.tabId).toBe(
      primary?.tabId
    )
    await harness.service.dispose()
  })

  it('blocks closing a leased tab until every request releases it', async () => {
    const harness = createHarness()
    const signal = new AbortController().signal
    const primary = await harness.service.createTab('conversation', 11, signal)
    const sibling = await harness.service.createTab('conversation', 11, signal)
    const first = harness.service.acquireTabUsage(
      'conversation',
      primary.tabId,
      'request-one',
      11
    )
    const second = harness.service.acquireTabUsage(
      'conversation',
      primary.tabId,
      'request-two',
      11
    )

    await expect(
      harness.service.closeTab('conversation', primary.tabId, 11)
    ).rejects.toThrow('浏览器标签页正在被活动请求使用，无法关闭')
    await expect(
      harness.service.closeTab('conversation', sibling.tabId, 11)
    ).resolves.toBeUndefined()
    first.release()
    first.release()
    await expect(
      harness.service.closeTab('conversation', primary.tabId, 11)
    ).rejects.toThrow('浏览器标签页正在被活动请求使用，无法关闭')
    second.release()
    await expect(
      harness.service.closeTab('conversation', primary.tabId, 11)
    ).resolves.toBeUndefined()
    await harness.service.dispose()
  })

  it('reports only the visible tab owned by the requesting window', async () => {
    const harness = createHarness()
    const signal = new AbortController().signal
    const primary = await harness.service.createTab('conversation', 21, signal)
    const sibling = await harness.service.createTab('conversation', 21, signal)

    expect(harness.service.getVisibleTabId('conversation', 21)).toBeUndefined()
    harness.service.setViewport(
      'conversation',
      { x: 0, y: 0, width: 320, height: 480 },
      sibling.tabId,
      firstLeaseToken,
      21
    )
    expect(harness.service.getVisibleTabId('conversation', 21)).toBe(
      sibling.tabId
    )
    expect(primary.tabId).not.toBe(sibling.tabId)
    expect(() => harness.service.getVisibleTabId('conversation', 22)).toThrow(
      '不属于当前窗口'
    )
    await harness.service.dispose()
  })

  it('aborts active tab leases when a conversation is force-released', async () => {
    const harness = createHarness()
    const tab = await harness.service.createTab('conversation', 21)
    const lease = harness.service.acquireTabUsage(
      'conversation',
      tab.tabId,
      'request',
      21
    )

    await harness.service.releaseConversation('conversation', 21)

    expect(lease.signal.aborted).toBe(true)
    expect(harness.service.getTabCount('conversation')).toBe(0)
    lease.release()
    await harness.service.dispose()
  })

  it('enforces conversation/window ownership, tab limits, and opaque viewport leases', async () => {
    const harness = createHarness()
    const signal = new AbortController().signal
    const primary = await harness.service.createTab('conversation', 21, signal)
    const sibling = await harness.service.createTab('conversation', 21, signal)
    const bounds = { x: 10, y: 20, width: 300, height: 400 }

    expect(
      harness.service.setViewport(
        'conversation',
        bounds,
        sibling.tabId,
        firstLeaseToken,
        21
      )
    ).toBe(true)
    expect(harness.slots[1]?.session.setViewport).toHaveBeenLastCalledWith(
      bounds
    )
    expect(
      harness.service.setViewport(
        undefined,
        undefined,
        undefined,
        secondLeaseToken,
        21
      )
    ).toBe(false)
    expect(harness.slots[1]?.session.setViewport).toHaveBeenLastCalledWith(
      bounds
    )
    await expect(
      harness.service.navigate(
        'conversation',
        'https://example.com/',
        signal,
        primary.tabId,
        22
      )
    ).rejects.toThrow('不属于当前窗口')
    await harness.service.dispose()

    const conversationLimited = createHarness({
      maximumTabsPerConversation: 2
    })
    await conversationLimited.service.createTab('limited', 31, signal)
    await conversationLimited.service.createTab('limited', 31, signal)
    await expect(
      conversationLimited.service.createTab('limited', 31, signal)
    ).rejects.toThrow('2 个上限')
    await conversationLimited.service.dispose()

    const windowLimited = createHarness({ maximumTabsPerWindow: 2 })
    await windowLimited.service.createTab('first', 41, signal)
    await windowLimited.service.createTab('second', 41, signal)
    await expect(
      windowLimited.service.createTab('third', 41, signal)
    ).rejects.toThrow('2 个上限')
    await windowLimited.service.dispose()
  })

  it('creates a fresh tab instead of adopting a navigated unowned primary, and restores only the same owner', async () => {
    const harness = createHarness()
    const signal = new AbortController().signal
    try {
      await harness.service.navigate('conversation', 'https://old.example/', signal, undefined, 21)
      const [primary] = harness.service.listTabs('conversation', 21)
      const fresh = await harness.service.createTab('conversation', 21, signal, workbarInstanceId)
      expect(fresh.tabId).not.toBe(primary!.tabId)
      expect(fresh.url).toBeUndefined()
      expect(fresh.canGoBack).toBe(false)
      expect(harness.slots[1]!.driver.navigate).not.toHaveBeenCalled()
      await harness.service.navigate('conversation', 'https://new.example/', signal, fresh.tabId, 21)
      const restored = await harness.service.createTab('conversation', 21, signal, workbarInstanceId)
      expect(restored.tabId).toBe(fresh.tabId)
      expect(restored.url).toBe('https://new.example/')
      expect(harness.service.listTabs('conversation', 21)[0]!.url).toBe('https://old.example/')
      expect(harness.service.getTabCount('conversation')).toBe(2)
    } finally {
      await harness.service.dispose()
    }
  })

  it('returns one live tab for concurrent requests from the same workbar instance', async () => {
    const gate = deferred<void>()
    const harness = createHarness({ sessionGate: gate.promise })
    const signal = new AbortController().signal

    const first = harness.service.createTab(
      'conversation',
      21,
      signal,
      workbarInstanceId
    )
    const duplicate = harness.service.createTab(
      'conversation',
      21,
      signal,
      workbarInstanceId
    )
    await vi.waitFor(() => expect(harness.createSession).toHaveBeenCalledOnce())
    gate.resolve()

    const [firstTab, duplicateTab] = await Promise.all([first, duplicate])
    expect(duplicateTab.tabId).toBe(firstTab.tabId)
    expect(harness.service.getTabCount('conversation')).toBe(1)
    expect(harness.service.getOwnerWindowId('conversation')).toBe(21)
    await harness.service.dispose()
  })

  it('disposes a tab creation that resolves after its context is closed', async () => {
    const harness = createHarness()
    const signal = new AbortController().signal
    const primary = await harness.service.createTab('conversation', 21, signal)
    const gate = deferred<void>()
    const implementation = harness.createSession.getMockImplementation()!
    harness.createSession.mockImplementationOnce(async (...args) => {
      await gate.promise
      return implementation(...args)
    })

    const pending = harness.service.createTab(
      'conversation',
      21,
      signal,
      'c22e845b-4bc8-4246-9543-dd18dbf20782'
    )
    await vi.waitFor(() => expect(harness.createSession).toHaveBeenCalledTimes(2))
    await harness.service.closeTab('conversation', primary.tabId, 21)
    gate.resolve()

    await expect(pending).rejects.toThrow()
    expect(harness.service.getSessionCount()).toBe(0)
    expect(harness.slots[1]?.session.dispose).toHaveBeenCalledOnce()
    await harness.service.dispose()
  })

  it('reserves window capacity while tab contexts are still being created', async () => {
    const gate = deferred<void>()
    const harness = createHarness({
      maximumTabsPerWindow: 1,
      sessionGate: gate.promise
    })
    const signal = new AbortController().signal
    const first = harness.service.createTab('first', 51, signal)
    await vi.waitFor(() => expect(harness.createSession).toHaveBeenCalledOnce())

    await expect(
      harness.service.createTab('second', 51, signal)
    ).rejects.toThrow('1 个上限')
    expect(harness.createSession).toHaveBeenCalledOnce()
    gate.resolve()
    await first
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

  it('does not expire a session while a serialized operation is active', async () => {
    vi.useFakeTimers()
    const harness = createHarness({ idleTimeoutMs: 100 })
    const signal = new AbortController().signal
    await harness.service.navigate('conversation', 'https://a.example/', signal)
    const gate = deferred<void>()
    vi.mocked(harness.slots[0]!.driver.click).mockImplementationOnce(async () => gate.promise)

    const click = harness.service.click('conversation', 'button_ref', signal)
    await vi.advanceTimersByTimeAsync(500)
    expect(harness.service.getSessionCount()).toBe(1)
    gate.resolve()
    await click
    await vi.advanceTimersByTimeAsync(101)
    expect(harness.service.getSessionCount()).toBe(0)
    await harness.service.dispose()
  })

  it('ignores stale viewport cleanup tokens', async () => {
    const harness = createHarness()
    const tab = await harness.service.createTab('conversation', 21)
    const bounds = { x: 1, y: 2, width: 300, height: 400 }
    harness.service.setViewport('conversation', bounds, tab.tabId, firstLeaseToken, 21)
    harness.service.setViewport('conversation', bounds, tab.tabId, secondLeaseToken, 21)

    expect(
      harness.service.setViewport(undefined, undefined, undefined, firstLeaseToken, 21)
    ).toBe(false)
    expect(harness.slots[0]?.session.setViewport).toHaveBeenLastCalledWith(bounds)
    expect(
      harness.service.setViewport(undefined, undefined, undefined, secondLeaseToken, 21)
    ).toBe(true)
    expect(harness.slots[0]?.session.setViewport).toHaveBeenLastCalledWith(undefined)
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

  it('does not resolve DNS again while refreshing navigation metadata', async () => {
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
    const [tab] = harness.service.listTabs('conversation')
    harness.service.setViewport(
      'conversation',
      { x: 1, y: 2, width: 300, height: 400 },
      tab!.tabId,
      firstLeaseToken
    )
    await expect(
      harness.service.releaseConversation('conversation')
    ).rejects.toThrow('清理超时')
    expect(harness.service.getSessionCount()).toBe(0)
    expect(harness.service.listTabs('conversation')).toEqual([])
    expect(harness.slots[0]?.session.setViewport).toHaveBeenLastCalledWith(undefined)
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

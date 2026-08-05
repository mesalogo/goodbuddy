import {
  afterEach,
  describe,
  expect,
  it,
  vi,
  type Mock
} from 'vitest'
import {
  PortalDesktopSession,
  PortalSessionError,
  validatePipeWireFrameMetadata,
  type ClosableResource,
  type PortalResponse,
  type PortalTransport
} from './portal-session'

type MockPortal = {
  transport: PortalTransport
  pipeWireClose: Mock<() => void>
  eisClose: Mock<() => void>
}

const mockPortal = (
  responseOverrides: Record<string, Partial<PortalResponse>> = {}
): MockPortal => {
  const pipeWireClose = vi.fn<() => void>()
  const eisClose = vi.fn<() => void>()
  const resource = (close: Mock<() => void>): ClosableResource => ({
    close: () => close()
  })
  const transport: PortalTransport = {
    createSession: vi.fn(async () => ({ requestHandle: 'create' })),
    selectDevices: vi.fn(async () => ({ requestHandle: 'devices' })),
    selectSources: vi.fn(async () => ({ requestHandle: 'sources' })),
    start: vi.fn(async () => ({ requestHandle: 'start' })),
    waitForResponse: vi.fn(async (requestHandle) => ({
      requestHandle,
      response: 0,
      results:
        requestHandle === 'create'
          ? { session_handle: 'private-session' }
          : {},
      ...responseOverrides[requestHandle]
    })),
    openPipeWireRemote: vi.fn(async () => resource(pipeWireClose)),
    connectEis: vi.fn(async () => resource(eisClose)),
    closeRequest: vi.fn(async () => undefined),
    closeSession: vi.fn(async () => undefined)
  }
  return { transport, pipeWireClose, eisClose }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('PortalDesktopSession', () => {
  it('performs the portal protocol in order and cleans every resource on stop', async () => {
    const mock = mockPortal()
    const session = new PortalDesktopSession(mock.transport)

    await session.open(
      { devices: true, sources: true, parentWindow: 'window-token' },
      new AbortController().signal
    )

    expect(session.state).toBe('active')
    expect(session.hasActiveConsent).toBe(true)
    expect(mock.transport.selectDevices).toHaveBeenCalledWith(
      'private-session',
      expect.any(AbortSignal)
    )
    expect(mock.transport.selectSources).toHaveBeenCalled()
    expect(mock.transport.start).toHaveBeenCalledWith(
      'private-session',
      'window-token',
      expect.any(AbortSignal)
    )

    await session.stop()

    expect(session.state).toBe('stopped')
    expect(session.hasActiveConsent).toBe(false)
    expect(mock.pipeWireClose).toHaveBeenCalledOnce()
    expect(mock.eisClose).toHaveBeenCalledOnce()
    expect(mock.transport.closeRequest).toHaveBeenCalledTimes(4)
    expect(mock.transport.closeSession).toHaveBeenCalledWith('private-session')
  })

  it.each([
    [1, 'cancelled'],
    [2, 'denied']
  ] as const)('handles portal consent response %s as %s', async (code, reason) => {
    const mock = mockPortal({
      sources: { response: code }
    })
    const session = new PortalDesktopSession(mock.transport)

    await expect(
      session.open(
        { devices: false, sources: true },
        new AbortController().signal
      )
    ).rejects.toMatchObject({ reason })
    expect(session.state).toBe('failed')
    expect(mock.transport.closeRequest).toHaveBeenCalledWith('sources')
    expect(mock.transport.closeSession).toHaveBeenCalledWith('private-session')
    expect(mock.transport.openPipeWireRemote).not.toHaveBeenCalled()
  })

  it('rejects mismatched response handles and closes the request', async () => {
    const mock = mockPortal({
      create: { requestHandle: 'unrelated-response' }
    })
    const session = new PortalDesktopSession(mock.transport)

    await expect(
      session.open(
        { devices: true, sources: false },
        new AbortController().signal
      )
    ).rejects.toMatchObject({ reason: 'protocol' })
    expect(mock.transport.closeRequest).toHaveBeenCalledWith('create')
  })

  it('aborts a pending request on timeout and performs cleanup', async () => {
    vi.useFakeTimers()
    const mock = mockPortal()
    mock.transport.waitForResponse = vi.fn(
      async (_handle, signal) =>
        new Promise<PortalResponse>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), {
            once: true
          })
        })
    )
    const session = new PortalDesktopSession(mock.transport)
    const opening = session.open(
      { devices: true, sources: false, timeoutMs: 10 },
      new AbortController().signal
    )
    const rejection = expect(opening).rejects.toMatchObject({
      reason: 'timeout'
    })

    await vi.advanceTimersByTimeAsync(10)

    await rejection
    expect(mock.transport.closeRequest).toHaveBeenCalledWith('create')
  })

  it('cleans active descriptors and revokes consent on portal owner loss', async () => {
    const mock = mockPortal()
    const session = new PortalDesktopSession(mock.transport)
    await session.open(
      { devices: true, sources: true },
      new AbortController().signal
    )

    await session.portalOwnerLost()

    expect(session.state).toBe('failed')
    expect(session.hasActiveConsent).toBe(false)
    expect(mock.pipeWireClose).toHaveBeenCalledOnce()
    expect(mock.eisClose).toHaveBeenCalledOnce()
    expect(mock.transport.closeSession).toHaveBeenCalledOnce()
  })

  it('stops an opening session without leaving requests or consent active', async () => {
    const mock = mockPortal()
    mock.transport.waitForResponse = vi.fn(
      async (_handle, signal) =>
        new Promise<PortalResponse>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), {
            once: true
          })
        })
    )
    const session = new PortalDesktopSession(mock.transport)
    const opening = session.open(
      { devices: true, sources: false },
      new AbortController().signal
    )
    const rejection = expect(opening).rejects.toMatchObject({
      reason: 'aborted'
    })
    await Promise.resolve()

    await session.stop()
    await rejection

    expect(session.state).toBe('stopped')
    expect(session.hasActiveConsent).toBe(false)
    expect(mock.transport.closeRequest).toHaveBeenCalledWith('create')
  })

  it('prevents a late stopped open from mutating a reopened session', async () => {
    const mock = mockPortal()
    let resolveFirst:
      | ((request: { requestHandle: string }) => void)
      | undefined
    const firstCreate = new Promise<{ requestHandle: string }>((resolve) => {
      resolveFirst = resolve
    })
    let createCount = 0
    mock.transport.createSession = vi.fn(async () => {
      createCount += 1
      if (createCount === 1) {
        return firstCreate
      }
      return { requestHandle: 'create-second' }
    })
    mock.transport.waitForResponse = vi.fn(async (requestHandle) => ({
      requestHandle,
      response: 0,
      results:
        requestHandle === 'create-second'
          ? { session_handle: 'session-second' }
          : {}
    }))
    const session = new PortalDesktopSession(mock.transport)
    const firstOpening = session.open(
      { devices: true, sources: false },
      new AbortController().signal
    )
    const firstRejection = expect(firstOpening).rejects.toMatchObject({
      reason: 'aborted'
    })
    await vi.waitFor(() => {
      expect(mock.transport.createSession).toHaveBeenCalledOnce()
    })

    await session.stop()
    await firstRejection
    await session.open(
      { devices: true, sources: false },
      new AbortController().signal
    )
    expect(session.state).toBe('active')

    resolveFirst?.({ requestHandle: 'late-first-create' })
    await vi.waitFor(() => {
      expect(mock.transport.closeRequest).toHaveBeenCalledWith(
        'late-first-create'
      )
    })
    expect(session.state).toBe('active')
    expect(session.hasActiveConsent).toBe(true)
    expect(mock.transport.closeSession).not.toHaveBeenCalledWith(
      'session-second'
    )
  })

  it.each(['stop', 'owner-loss'] as const)(
    'bounds hung cleanup during %s',
    async (lifecycle) => {
      const mock = mockPortal()
      const never = () => new Promise<void>(() => undefined)
      mock.transport.closeRequest = vi.fn(never)
      mock.transport.closeSession = vi.fn(never)
      mock.transport.openPipeWireRemote = vi.fn(async () => ({
        close: never
      }))
      const session = new PortalDesktopSession(mock.transport, {
        cleanupTimeoutMs: 10
      })
      await session.open(
        { devices: false, sources: true },
        new AbortController().signal
      )
      vi.useFakeTimers()

      const cleanup =
        lifecycle === 'stop'
          ? session.stop()
          : session.portalOwnerLost()
      await vi.advanceTimersByTimeAsync(10)
      await expect(cleanup).resolves.toBeUndefined()
      expect(session.state).toBe(
        lifecycle === 'stop' ? 'stopped' : 'failed'
      )
    }
  )

  it('bounds hung cleanup after a failed open', async () => {
    vi.useFakeTimers()
    const mock = mockPortal({
      sources: { response: 2 }
    })
    const never = () => new Promise<void>(() => undefined)
    mock.transport.closeRequest = vi.fn(never)
    mock.transport.closeSession = vi.fn(never)
    const session = new PortalDesktopSession(mock.transport, {
      cleanupTimeoutMs: 10
    })
    const opening = session.open(
      { devices: false, sources: true },
      new AbortController().signal
    )
    const rejection = expect(opening).rejects.toMatchObject({
      reason: 'denied'
    })

    await vi.waitFor(() => {
      expect(mock.transport.closeSession).toHaveBeenCalled()
    })
    await vi.advanceTimersByTimeAsync(10)
    await rejection
    expect(session.state).toBe('failed')
  })

  it('requires at least one consented portal capability', async () => {
    const session = new PortalDesktopSession(mockPortal().transport)
    await expect(
      session.open(
        { devices: false, sources: false },
        new AbortController().signal
      )
    ).rejects.toBeInstanceOf(PortalSessionError)
    await expect(
      session.open(
        { devices: true, sources: false, timeoutMs: 0 },
        new AbortController().signal
      )
    ).rejects.toMatchObject({ reason: 'protocol' })
  })
})

describe('validatePipeWireFrameMetadata', () => {
  const valid = {
    width: 1920,
    height: 1080,
    stride: 7680,
    planes: [{ offset: 0, stride: 7680, bytes: 8_294_400 }],
    byteLength: 8_294_400,
    fpsNumerator: 60,
    fpsDenominator: 1
  }

  it('accepts bounded, internally consistent frame metadata', () => {
    expect(validatePipeWireFrameMetadata(valid)).toEqual(valid)
  })

  it.each([
    { ...valid, width: 0 },
    { ...valid, height: 20_000 },
    { ...valid, stride: 100 },
    { ...valid, fpsDenominator: 0 },
    { ...valid, fpsNumerator: 241 },
    { ...valid, byteLength: 10 },
    {
      ...valid,
      planes: [{ offset: 1, stride: 7680, bytes: 8_294_399 }]
    },
    {
      ...valid,
      planes: [
        { offset: 0, stride: 7680, bytes: 100 },
        { offset: 50, stride: 960, bytes: 8_294_350 }
      ]
    }
  ])('rejects unsafe or inconsistent metadata', (metadata) => {
    expect(() => validatePipeWireFrameMetadata(metadata)).toThrow()
  })
})

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clearOfficeCapabilitiesCache, readOfficeCapabilities } from './office-capabilities'

const config = { enabled: true, formats: ['docx'], maxBytes: 1024, versionedDownload: true }
const ok = (): Response => new Response(JSON.stringify(config), { status: 200, headers: { 'content-type': 'application/json' } })

describe('readOfficeCapabilities', () => {
  const fetchMock = vi.fn<typeof fetch>()
  beforeEach(() => { clearOfficeCapabilitiesCache(); fetchMock.mockReset(); vi.stubGlobal('fetch', fetchMock) })
  afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers() })

  it('shares one request per origin within an open', async () => {
    fetchMock.mockImplementation(async () => ok())
    await Promise.all([
      readOfficeCapabilities('http://10.7.0.23:8088'),
      readOfficeCapabilities('http://10.7.0.23:8088/'),
      readOfficeCapabilities('http://10.7.0.23:8088')
    ])
    expect(fetchMock).toHaveBeenCalledTimes(1)
    await readOfficeCapabilities('http://192.168.0.23:8088')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('bypasses the cache for explicit checks and after expiry', async () => {
    vi.useFakeTimers()
    fetchMock.mockImplementation(async () => ok())
    await readOfficeCapabilities('http://10.7.0.23:8088')
    await readOfficeCapabilities('http://10.7.0.23:8088', { fresh: true })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    vi.advanceTimersByTime(31_000)
    await readOfficeCapabilities('http://10.7.0.23:8088')
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('does not cache failures', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('offline')).mockImplementation(async () => ok())
    await expect(readOfficeCapabilities('http://10.7.0.23:8088')).rejects.toThrow('无法连接 ShareServer')
    await expect(readOfficeCapabilities('http://10.7.0.23:8088')).resolves.toMatchObject({ enabled: true })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})

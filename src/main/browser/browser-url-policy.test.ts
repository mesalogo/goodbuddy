import { describe, expect, it, vi } from 'vitest'
import {
  BrowserUrlPolicy,
  canonicalizeBrowserUrl
} from './browser-url-policy'

const signal = new AbortController().signal

describe('BrowserUrlPolicy', () => {
  it.each([
    'file:///etc/passwd',
    'data:text/html,hello',
    'javascript:alert(1)',
    'ssh://example.com'
  ])('rejects non-HTTP URL %s', (url) => {
    expect(() => canonicalizeBrowserUrl(url)).toThrow()
  })

  it.each([
    'http://localhost:8080/admin',
    'http://printer/status',
    'http://service.local/health',
    'http://10.0.0.1/api',
    'http://192.168.1.20/status',
    'http://[::1]:3000/',
    'https://example.com/'
  ])('accepts intranet and public target %s', (url) => {
    expect(() => canonicalizeBrowserUrl(url)).not.toThrow()
  })

  it('accepts canonical HTTP(S) URLs and strips fragments', async () => {
    const resolver = vi.fn(async () => [
      { address: '93.184.216.34', family: 4 as const }
    ])
    const policy = new BrowserUrlPolicy(resolver)

    await expect(
      policy.validate('https://example.com:8443/docs?q=1#section', signal)
    ).resolves.toMatchObject({
      origin: 'https://example.com:8443',
      url: expect.objectContaining({
        href: 'https://example.com:8443/docs?q=1'
      })
    })
    expect(resolver).toHaveBeenCalledWith(
      'example.com',
      expect.any(AbortSignal)
    )
  })

  it('resolves intranet hostnames to their private addresses', async () => {
    const policy = new BrowserUrlPolicy(async () => [
      { address: '10.20.30.40', family: 4 }
    ])
    await expect(
      policy.validate('http://printer/status', signal)
    ).resolves.toMatchObject({
      origin: 'http://printer',
      addresses: [{ address: '10.20.30.40', family: 4 }]
    })
  })

  it('rejects a host that resolves to no address', async () => {
    const policy = new BrowserUrlPolicy(async () => [])
    await expect(
      policy.validate('https://example.com', signal)
    ).rejects.toThrow('无法解析')
  })

  it('validates redirects without restricting their destination origin', async () => {
    const policy = new BrowserUrlPolicy(async () => [
      { address: '93.184.216.34', family: 4 }
    ])
    await expect(
      policy.validateRedirect(
        'https://example.com/next',
        signal
      )
    ).resolves.toMatchObject({ origin: 'https://example.com' })
    await expect(
      policy.validateRedirect(
        'https://other.example/next',
        signal
      )
    ).resolves.toMatchObject({ origin: 'https://other.example' })
  })

  it('honors cancellation before and after DNS resolution', async () => {
    const before = new AbortController()
    before.abort()
    await expect(
      new BrowserUrlPolicy(vi.fn()).validate('https://example.com', before.signal)
    ).rejects.toHaveProperty('name', 'AbortError')

    const after = new AbortController()
    const policy = new BrowserUrlPolicy(async () => {
      after.abort()
      return [{ address: '93.184.216.34', family: 4 }]
    })
    await expect(
      policy.validate('https://example.com', after.signal)
    ).rejects.toHaveProperty('name', 'AbortError')
  })
})

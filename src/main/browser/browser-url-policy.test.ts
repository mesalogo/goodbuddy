import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setIntranetCompatibilityReader } from '../intranet-compatibility-policy'
import {
  BrowserUrlPolicy,
  canonicalizeBrowserUrl,
  isPublicBrowserAddress
} from './browser-url-policy'

const signal = new AbortController().signal

beforeEach(() => {
  setIntranetCompatibilityReader(() => false)
})

afterEach(() => {
  setIntranetCompatibilityReader(() => true)
})

describe('BrowserUrlPolicy', () => {
  it.each([
    'file:///etc/passwd',
    'data:text/html,hello',
    'javascript:alert(1)',
    'ssh://example.com',
    'https://user:secret@example.com/',
    'http://localhost/',
    'http://printer/',
    'http://service.local/',
    'http://metadata.google.internal/',
    'http://169.254.169.254/latest/meta-data/',
    'http://[::1]/'
  ])('rejects unsafe URL %s', (url) => {
    expect(() => canonicalizeBrowserUrl(url)).toThrow()
  })

  it.each([
    '0.0.0.0',
    '10.0.0.1',
    '100.64.0.1',
    '127.0.0.1',
    '169.254.169.254',
    '172.20.1.1',
    '192.168.1.1',
    '192.0.2.1',
    '224.0.0.1',
    '::',
    '::1',
    '::ffff:127.0.0.1',
    'fc00::1',
    'fe80::1',
    'ff02::1',
    '2001:db8::1'
  ])('classifies %s as non-public', (address) => {
    expect(isPublicBrowserAddress(address)).toBe(false)
  })

  it('accepts canonical public HTTP(S) URLs and strips fragments', async () => {
    const resolver = vi.fn(async () => [
      { address: '93.184.216.34', family: 4 as const },
      { address: '2606:2800:220:1:248:1893:25c8:1946', family: 6 as const }
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

  it('rejects empty, private, malformed, and mixed DNS answers', async () => {
    for (const answers of [
      [],
      [{ address: '10.0.0.2', family: 4 as const }],
      [
        { address: '93.184.216.34', family: 4 as const },
        { address: '127.0.0.1', family: 4 as const }
      ],
      [{ address: 'not-an-address', family: 4 as const }]
    ]) {
      const policy = new BrowserUrlPolicy(async () => answers)
      await expect(policy.validate('https://example.com', signal)).rejects.toThrow(
        '混合地址'
      )
    }
  })

  it('allows intranet names and private addresses only in compatibility mode', async () => {
    setIntranetCompatibilityReader(() => true)
    expect(() => canonicalizeBrowserUrl('http://printer/status')).not.toThrow()
    expect(() =>
      canonicalizeBrowserUrl('https://service.internal/health')
    ).not.toThrow()
    expect(() =>
      canonicalizeBrowserUrl('http://192.168.1.20/status')
    ).not.toThrow()

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

  it('keeps metadata, link-local and mixed DNS answers blocked in compatibility mode', async () => {
    setIntranetCompatibilityReader(() => true)
    expect(() =>
      canonicalizeBrowserUrl('http://metadata.google.internal/latest')
    ).toThrow()
    expect(() =>
      canonicalizeBrowserUrl('http://169.254.169.254/latest/meta-data')
    ).toThrow()
    expect(() =>
      canonicalizeBrowserUrl('http://user:secret@printer/status')
    ).toThrow()

    const mixedPolicy = new BrowserUrlPolicy(async () => [
      { address: '10.20.30.40', family: 4 },
      { address: '93.184.216.34', family: 4 }
    ])
    await expect(
      mixedPolicy.validate('http://printer/status', signal)
    ).rejects.toThrow('混合地址')

    const linkLocalPolicy = new BrowserUrlPolicy(async () => [
      { address: '169.254.10.20', family: 4 }
    ])
    await expect(
      linkLocalPolicy.validate('http://printer/status', signal)
    ).rejects.toThrow('混合地址')
  })

  it('validates redirects and keeps them on the approved origin', async () => {
    const policy = new BrowserUrlPolicy(async () => [
      { address: '93.184.216.34', family: 4 }
    ])
    await expect(
      policy.validateRedirect(
        'https://example.com/next',
        'https://example.com',
        signal
      )
    ).resolves.toMatchObject({ origin: 'https://example.com' })
    await expect(
      policy.validateRedirect(
        'https://other.example/next',
        'https://example.com',
        signal
      )
    ).rejects.toThrow('超出已批准来源')
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

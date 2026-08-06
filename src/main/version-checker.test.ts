import { describe, expect, it, vi } from 'vitest'
import {
  checkForUpdates,
  compareStrictSemVer,
  GOODBUDDY_LATEST_RELEASE_API_URL
} from './version-checker'

const latestVersion = '1.2.3'
const manifestUrl =
  'https://github.com/mesalogo/goodbuddy/releases/download/' +
  `v${latestVersion}/release-manifest.json`
const manifestAssetApiUrl =
  'https://api.github.com/repos/mesalogo/goodbuddy/releases/assets/123'
const releaseAssetUrl =
  'https://release-assets.githubusercontent.com/github-production-release-asset/' +
  '123/release-manifest.json?download=1'

const files = [
  {
    name: `GoodBuddy-${latestVersion}-windows-x64-setup.exe`,
    size: 101,
    sha256: 'a'.repeat(64)
  },
  {
    name: `GoodBuddy-${latestVersion}-windows-x64-portable.exe`,
    size: 102,
    sha256: 'b'.repeat(64)
  }
]

function releasePayload(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    tag_name: `v${latestVersion}`,
    draft: false,
    prerelease: false,
    assets: [
      {
        name: 'release-manifest.json',
        url: manifestAssetApiUrl,
        browser_download_url: manifestUrl
      }
    ],
    ...overrides
  }
}

function manifestPayload(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    formatVersion: 1,
    productName: 'GoodBuddy',
    version: latestVersion,
    targets: [
      {
        platform: 'windows',
        arch: 'x64',
        formats: ['nsis', 'portable'],
        manifest: 'release-manifest-windows-x64.json',
        files
      }
    ],
    files: files.map((file) => ({
      platform: 'windows',
      arch: 'x64',
      ...file
    })),
    ...overrides
  }
}

function jsonResponse(
  value: unknown,
  init: ResponseInit = {}
): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init
  })
}

function successfulFetch(): ReturnType<typeof vi.fn<typeof fetch>> {
  return vi.fn<typeof fetch>(async (input) => {
    const url = String(input)
    if (url === GOODBUDDY_LATEST_RELEASE_API_URL) {
      return jsonResponse(releasePayload())
    }
    if (url === manifestAssetApiUrl) {
      return jsonResponse(manifestPayload())
    }
    throw new Error(`Unexpected request: ${url}`)
  })
}

describe('compareStrictSemVer', () => {
  it('implements SemVer precedence without treating build metadata as newer', () => {
    expect(compareStrictSemVer('1.0.0-alpha.2', '1.0.0-alpha.10')).toBe(-1)
    expect(compareStrictSemVer('1.0.0-rc.1', '1.0.0')).toBe(-1)
    expect(compareStrictSemVer('1.0.0+build.2', '1.0.0+build.1')).toBe(0)
  })

  it.each([
    'v1.2.3',
    '1.2',
    '01.2.3',
    '1.2.3-01',
    '1.2.3-',
    '1.2.3+'
  ])('rejects non-strict version %s', (version) => {
    expect(() => compareStrictSemVer(version, '1.0.0')).toThrow(
      'Invalid semantic version'
    )
  })
})

describe('checkForUpdates', () => {
  it('uses only the official latest release and canonical manifest URLs', async () => {
    const transport = successfulFetch()

    await expect(
      checkForUpdates({
        fetch: transport,
        currentVersion: '1.0.0',
        platform: 'win32',
        arch: 'x64'
      })
    ).resolves.toEqual({
      updateAvailable: true,
      currentVersion: '1.0.0',
      latestVersion,
      releaseUrl:
        `https://github.com/mesalogo/goodbuddy/releases/tag/v${latestVersion}`,
      target: {
        platform: 'windows',
        arch: 'x64',
        formats: ['nsis', 'portable'],
        files
      }
    })

    expect(transport).toHaveBeenCalledTimes(2)
    expect(transport.mock.calls.map(([input]) => String(input))).toEqual([
      GOODBUDDY_LATEST_RELEASE_API_URL,
      manifestAssetApiUrl
    ])
    expect(transport.mock.calls[1]?.[1]?.headers).toMatchObject({
      Accept: 'application/octet-stream'
    })
    for (const [, init] of transport.mock.calls) {
      expect(init).toMatchObject({
        method: 'GET',
        redirect: 'manual',
        credentials: 'omit',
        cache: 'no-store'
      })
    }
  })

  it('follows only the official GitHub release asset redirect', async () => {
    const transport = vi.fn<typeof fetch>(async (input) => {
      const url = String(input)
      if (url === GOODBUDDY_LATEST_RELEASE_API_URL) {
        return jsonResponse(releasePayload())
      }
      if (url === manifestAssetApiUrl) {
        return new Response(null, {
          status: 302,
          headers: { location: releaseAssetUrl }
        })
      }
      if (url === releaseAssetUrl) {
        return jsonResponse(manifestPayload())
      }
      throw new Error(`Unexpected request: ${url}`)
    })

    await expect(
      checkForUpdates({
        fetch: transport,
        currentVersion: '1.0.0',
        platform: 'win32',
        arch: 'x64'
      })
    ).resolves.toMatchObject({ latestVersion })
    expect(transport.mock.calls.map(([input]) => String(input))).toEqual([
      GOODBUDDY_LATEST_RELEASE_API_URL,
      manifestAssetApiUrl,
      releaseAssetUrl
    ])
  })

  it.each([
    'http://release-assets.githubusercontent.com/manifest.json',
    'https://attacker.invalid/manifest.json',
    'https://user:password@release-assets.githubusercontent.com/manifest.json'
  ])('rejects untrusted release redirect %s', async (location) => {
    const transport = vi.fn<typeof fetch>(async (input) =>
      String(input) === GOODBUDDY_LATEST_RELEASE_API_URL
        ? jsonResponse(releasePayload())
        : new Response(null, {
            status: 302,
            headers: { location }
          })
    )

    await expect(
      checkForUpdates({
        fetch: transport,
        currentVersion: '1.0.0',
        platform: 'win32',
        arch: 'x64'
      })
    ).rejects.toThrow('not trusted')
  })

  it('does not consider equal precedence or an older release an update', async () => {
    await expect(
      checkForUpdates({
        fetch: successfulFetch(),
        currentVersion: '1.2.3+local',
        platform: 'win32',
        arch: 'x64'
      })
    ).resolves.toMatchObject({ updateAvailable: false })
    await expect(
      checkForUpdates({
        fetch: successfulFetch(),
        currentVersion: '2.0.0',
        platform: 'win32',
        arch: 'x64'
      })
    ).resolves.toMatchObject({ updateAvailable: false })
  })

  it('rejects invalid tags, prereleases, and mismatched manifest versions', async () => {
    const cases: Array<{
      release: Record<string, unknown>
      manifest?: Record<string, unknown>
    }> = [
      { release: releasePayload({ tag_name: '1.2.3' }) },
      { release: releasePayload({ tag_name: 'v01.2.3' }) },
      { release: releasePayload({ prerelease: true }) },
      {
        release: releasePayload(),
        manifest: manifestPayload({ version: '1.2.4' })
      }
    ]
    for (const testCase of cases) {
      const transport = vi.fn<typeof fetch>(async (input) =>
        String(input) === GOODBUDDY_LATEST_RELEASE_API_URL
          ? jsonResponse(testCase.release)
          : jsonResponse(testCase.manifest ?? manifestPayload())
      )
      await expect(
        checkForUpdates({
          fetch: transport,
          currentVersion: '1.0.0',
          platform: 'win32',
          arch: 'x64'
        })
      ).rejects.toThrow()
    }
  })

  it.each([
    {
      url: manifestAssetApiUrl,
      browser_download_url: 'https://attacker.invalid/manifest.json'
    },
    {
      url: 'https://api.github.com/repos/attacker/repo/releases/assets/123',
      browser_download_url: manifestUrl
    }
  ])('rejects noncanonical release assets without requesting them', async (asset) => {
    const transport = vi.fn<typeof fetch>(async () =>
      jsonResponse(
        releasePayload({
          assets: [
            {
              name: 'release-manifest.json',
              ...asset
            }
          ]
        })
      )
    )

    await expect(
      checkForUpdates({
        fetch: transport,
        currentVersion: '1.0.0',
        platform: 'win32',
        arch: 'x64'
      })
    ).rejects.toThrow('canonical aggregate manifest')
    expect(transport).toHaveBeenCalledTimes(1)
  })

  it('rejects missing, duplicate, incomplete, and inconsistent targets', async () => {
    const invalidManifests = [
      manifestPayload({ targets: [] }),
      manifestPayload({
        targets: [
          manifestPayload().targets,
          manifestPayload().targets
        ].flat()
      }),
      manifestPayload({
        targets: [
          {
            platform: 'windows',
            arch: 'x64',
            formats: ['nsis', 'portable'],
            manifest: 'release-manifest-windows-x64.json',
            files: [files[0]]
          }
        ]
      }),
      manifestPayload({ files: [] })
    ]
    for (const manifest of invalidManifests) {
      const transport = vi.fn<typeof fetch>(async (input) =>
        String(input) === GOODBUDDY_LATEST_RELEASE_API_URL
          ? jsonResponse(releasePayload())
          : jsonResponse(manifest)
      )
      await expect(
        checkForUpdates({
          fetch: transport,
          currentVersion: '1.0.0',
          platform: 'win32',
          arch: 'x64'
        })
      ).rejects.toThrow()
    }
  })

  it('rejects unsafe file metadata and unsupported targets', async () => {
    const unsafeManifest = manifestPayload({
      targets: [
        {
          platform: 'windows',
          arch: 'x64',
          formats: ['nsis', 'portable'],
          manifest: 'release-manifest-windows-x64.json',
          files: [
            { ...files[0], name: '../GoodBuddy.exe' },
            files[1]
          ]
        }
      ]
    })
    const transport = vi.fn<typeof fetch>(async (input) =>
      String(input) === GOODBUDDY_LATEST_RELEASE_API_URL
        ? jsonResponse(releasePayload())
        : jsonResponse(unsafeManifest)
    )
    await expect(
      checkForUpdates({
        fetch: transport,
        currentVersion: '1.0.0',
        platform: 'win32',
        arch: 'x64'
      })
    ).rejects.toThrow()
    await expect(
      checkForUpdates({
        fetch: successfulFetch(),
        currentVersion: '1.0.0',
        platform: 'freebsd',
        arch: 'x64'
      })
    ).rejects.toThrow('Unsupported update platform')
    await expect(
      checkForUpdates({
        fetch: successfulFetch(),
        currentVersion: '1.0.0',
        platform: 'win32',
        arch: 'ia32'
      })
    ).rejects.toThrow('Unsupported update architecture')
  })

  it('rejects HTTP errors, invalid JSON, and bounded oversized bodies', async () => {
    const failedFetch = vi.fn<typeof fetch>(async () =>
      new Response('{}', { status: 503 })
    )
    await expect(
      checkForUpdates({
        fetch: failedFetch,
        currentVersion: '1.0.0',
        platform: 'win32',
        arch: 'x64'
      })
    ).rejects.toThrow('HTTP 503')

    const invalidJsonFetch = vi.fn<typeof fetch>(async () =>
      new Response('{invalid')
    )
    await expect(
      checkForUpdates({
        fetch: invalidJsonFetch,
        currentVersion: '1.0.0',
        platform: 'win32',
        arch: 'x64'
      })
    ).rejects.toThrow('not valid JSON')

    const oversizedFetch = vi.fn<typeof fetch>(async () =>
      new Response('x'.repeat(65), {
        headers: { 'content-length': '65' }
      })
    )
    await expect(
      checkForUpdates({
        fetch: oversizedFetch,
        currentVersion: '1.0.0',
        platform: 'win32',
        arch: 'x64',
        maxJsonBytes: 64
      })
    ).rejects.toThrow('too large')
  })

  it('applies the timeout while reading a stalled response body', async () => {
    const transport = vi.fn<typeof fetch>(async (input) => {
      if (String(input) === GOODBUDDY_LATEST_RELEASE_API_URL) {
        return jsonResponse(releasePayload())
      }
      return new Response(
        new ReadableStream<Uint8Array>({
          start() {
            // Keep the body open without yielding bytes.
          }
        })
      )
    })
    await expect(
      checkForUpdates({
        fetch: transport,
        currentVersion: '1.0.0',
        platform: 'win32',
        arch: 'x64',
        timeoutMs: 5
      })
    ).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('aborts a request at the configured timeout', async () => {
    const transport = vi.fn<typeof fetch>(
      async (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            'abort',
            () =>
              reject(
                new DOMException('The operation was aborted', 'AbortError')
              ),
            { once: true }
          )
        })
    )
    await expect(
      checkForUpdates({
        fetch: transport,
        currentVersion: '1.0.0',
        platform: 'win32',
        arch: 'x64',
        timeoutMs: 5
      })
    ).rejects.toMatchObject({ name: 'AbortError' })
  })
})

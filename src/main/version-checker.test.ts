import { describe, expect, it, vi } from 'vitest'
import {
  checkMirrorForUpdates,
  checkForUpdates,
  compareStrictSemVer,
  getUpdateDownloadPage,
  GOODBUDDY_LATEST_RELEASE_API_URL,
  GOODBUDDY_MIRROR_RELEASE_INDEX_URL,
  VersionChecker
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
    name: `GoodBuddy-${latestVersion}-windows-x64-portable.zip`,
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

type MirrorTestFile = {
  name: string
  size: number
  sha256: string
  url: string
}

type MirrorTestTarget = {
  platform: 'windows' | 'macos' | 'linux'
  arch: 'x64' | 'arm64'
  files: Record<string, MirrorTestFile>
}

type MirrorTestIndex = {
  formatVersion: 1
  productName: 'GoodBuddy'
  version: string
  targets: Record<string, MirrorTestTarget>
  checksumUrl: string
  fallbackUrl: string
}

function mirrorFileName(
  platform: MirrorTestTarget['platform'],
  arch: MirrorTestTarget['arch'],
  format: string
): string {
  const suffixes: Record<string, string> = {
    nsis: 'setup.exe',
    portable: 'portable.zip',
    dmg: 'installer.dmg',
    zip: 'portable.zip',
    AppImage: 'portable.AppImage',
    deb: 'installer.deb'
  }
  return `GoodBuddy-${latestVersion}-${platform}-${arch}-${suffixes[format]}`
}

function mirrorIndexPayload(): MirrorTestIndex {
  const definitions: Array<{
    platform: MirrorTestTarget['platform']
    arch: MirrorTestTarget['arch']
    formats: string[]
  }> = [
    { platform: 'windows', arch: 'x64', formats: ['nsis', 'portable'] },
    { platform: 'windows', arch: 'arm64', formats: ['nsis', 'portable'] },
    { platform: 'macos', arch: 'x64', formats: ['dmg', 'zip'] },
    { platform: 'macos', arch: 'arm64', formats: ['dmg', 'zip'] },
    { platform: 'linux', arch: 'x64', formats: ['AppImage', 'deb'] },
    { platform: 'linux', arch: 'arm64', formats: ['AppImage', 'deb'] }
  ]
  const releaseBase =
    `https://goodbuddy.oss-cn-beijing.aliyuncs.com/releases/` +
    `v${latestVersion}/`
  const targets: Record<string, MirrorTestTarget> = {}
  for (const definition of definitions) {
    const targetFiles: Record<string, MirrorTestFile> = {}
    for (const [index, format] of definition.formats.entries()) {
      const name = mirrorFileName(
        definition.platform,
        definition.arch,
        format
      )
      targetFiles[format] = {
        name,
        size: 100 + index,
        sha256: (index === 0 ? 'a' : 'b').repeat(64),
        url: new URL(encodeURIComponent(name), releaseBase).href
      }
    }
    targets[`${definition.platform}-${definition.arch}`] = {
      platform: definition.platform,
      arch: definition.arch,
      files: targetFiles
    }
  }
  return {
    formatVersion: 1,
    productName: 'GoodBuddy',
    version: latestVersion,
    targets,
    checksumUrl: new URL('SHA256SUMS', releaseBase).href,
    fallbackUrl:
      'https://github.com/mesalogo/goodbuddy/releases/latest'
  }
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

describe('checkMirrorForUpdates', () => {
  it('reads the fixed mirror index and returns the current platform files', async () => {
    const payload = mirrorIndexPayload()
    const transport = vi.fn<typeof fetch>(async () =>
      jsonResponse(payload)
    )

    await expect(
      checkMirrorForUpdates({
        fetch: transport,
        currentVersion: '1.0.0',
        platform: 'win32',
        arch: 'x64'
      })
    ).resolves.toEqual({
      updateAvailable: true,
      currentVersion: '1.0.0',
      latestVersion,
      releaseUrl: 'https://mesalogo.github.io/goodbuddy/#download',
      target: {
        platform: 'windows',
        arch: 'x64',
        formats: ['nsis', 'portable'],
        files: Object.values(
          payload.targets['windows-x64']!.files
        ).map((file) => ({
          name: file.name,
          size: file.size,
          sha256: file.sha256
        }))
      }
    })

    expect(transport).toHaveBeenCalledTimes(1)
    expect(String(transport.mock.calls[0]?.[0])).toBe(
      GOODBUDDY_MIRROR_RELEASE_INDEX_URL
    )
    expect(transport.mock.calls[0]?.[1]).toMatchObject({
      method: 'GET',
      redirect: 'manual',
      credentials: 'omit',
      cache: 'no-store'
    })
  })

  it('rejects redirects, incomplete targets, and untrusted file URLs', async () => {
    const redirecting = vi.fn<typeof fetch>(async () =>
      new Response(null, {
        status: 302,
        headers: { location: 'https://attacker.invalid/latest.json' }
      })
    )
    await expect(
      checkMirrorForUpdates({
        fetch: redirecting,
        currentVersion: '1.0.0',
        platform: 'win32',
        arch: 'x64'
      })
    ).rejects.toThrow('must not redirect')

    const incomplete = mirrorIndexPayload()
    delete incomplete.targets['linux-arm64']
    await expect(
      checkMirrorForUpdates({
        fetch: vi.fn<typeof fetch>(async () => jsonResponse(incomplete)),
        currentVersion: '1.0.0',
        platform: 'win32',
        arch: 'x64'
      })
    ).rejects.toThrow('targets are incomplete')

    const untrusted = mirrorIndexPayload()
    untrusted.targets['windows-x64']!.files.nsis!.url =
      'https://attacker.invalid/GoodBuddy.exe'
    await expect(
      checkMirrorForUpdates({
        fetch: vi.fn<typeof fetch>(async () => jsonResponse(untrusted)),
        currentVersion: '1.0.0',
        platform: 'win32',
        arch: 'x64'
      })
    ).rejects.toThrow('not a trusted mirror URL')
  })

  it('routes VersionChecker and download pages through the selected source', async () => {
    const transport = vi.fn<typeof fetch>(async () =>
      jsonResponse(mirrorIndexPayload())
    )
    const checker = new VersionChecker({
      fetch: transport,
      currentVersion: '1.0.0',
      platform: 'win32',
      arch: 'x64'
    })

    await expect(checker.check('mirror')).resolves.toMatchObject({
      latestVersion
    })
    expect(getUpdateDownloadPage('github')).toBe(
      'https://github.com/mesalogo/goodbuddy/releases'
    )
    expect(getUpdateDownloadPage('mirror')).toBe(
      'https://mesalogo.github.io/goodbuddy/#download'
    )
  })
})

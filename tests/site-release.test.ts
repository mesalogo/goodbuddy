import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

interface ReleaseFile {
  name: string
  size: number
  sha256: string
  url: string
}

interface SiteReleaseModule {
  parseArguments: (argv: string[]) => {
    manifest: string
    baseUrl: string
    output: string
  }
  createSiteRelease: (
    manifest: object,
    baseUrl: string
  ) => {
    version: string
    targets: Record<string, {
      files: Record<string, ReleaseFile>
    }>
    checksumUrl: string
    fallbackUrl: string
  }
}

interface VerifySiteReleaseModule {
  verifySiteRelease: (
    manifest: object,
    request: typeof fetch
  ) => Promise<number>
}

const require = createRequire(import.meta.url)
const siteRelease = require(
  '../build/create-site-release.cjs'
) as SiteReleaseModule
const verifier = require(
  '../build/verify-site-release.cjs'
) as VerifySiteReleaseModule

const targetDefinitions = [
  ['windows', 'x64', ['nsis', 'portable']],
  ['windows', 'arm64', ['nsis', 'portable']],
  ['macos', 'x64', ['dmg', 'zip']],
  ['macos', 'arm64', ['dmg', 'zip']],
  ['linux', 'x64', ['AppImage', 'deb', 'rpm']],
  ['linux', 'arm64', ['AppImage', 'deb', 'rpm']]
] as const

function createAggregateManifest() {
  return {
    formatVersion: 1,
    productName: 'GoodBuddy',
    version: '1.2.3',
    targets: targetDefinitions.map(([platform, arch, formats]) => ({
      platform,
      arch,
      formats,
      files: [...formats].reverse().map((format, index) => ({
        name:
          platform === 'windows'
            ? `GoodBuddy-1.2.3-${platform}-${arch}-${format === 'nsis' ? 'setup.exe' : 'portable.zip'}`
            : `GoodBuddy-1.2.3-${platform}-${arch}.${format}`,
        size: index + 100,
        sha256: 'a'.repeat(64)
      }))
    }))
  }
}

describe('site release manifest', () => {
  it('parses the CLI options used by the release workflow', () => {
    expect(
      siteRelease.parseArguments([
        '--manifest',
        'dist/release-upload/release-manifest.json',
        '--base-url',
        'https://example.com/releases/v1.2.3/',
        '--output',
        'dist/site-release.json'
      ])
    ).toEqual({
      manifest: resolve('dist/release-upload/release-manifest.json'),
      baseUrl: 'https://example.com/releases/v1.2.3/',
      output: resolve('dist/site-release.json')
    })
  })

  it('creates direct HTTPS download entries for all release targets', () => {
    const result = siteRelease.createSiteRelease(
      createAggregateManifest(),
      'https://goodbuddy.oss-cn-beijing.aliyuncs.com/releases/v1.2.3'
    )

    expect(result.version).toBe('1.2.3')
    expect(Object.keys(result.targets)).toHaveLength(6)
    expect(
      result.targets['windows-x64']?.files.nsis?.url
    ).toBe(
      'https://goodbuddy.oss-cn-beijing.aliyuncs.com/releases/v1.2.3/GoodBuddy-1.2.3-windows-x64-setup.exe'
    )
    expect(result.checksumUrl).toMatch(/\/SHA256SUMS$/u)
    expect(result.fallbackUrl).toBe(
      'https://github.com/mesalogo/goodbuddy/releases/latest'
    )
  })

  it('rejects insecure or credentialed OSS base URLs', () => {
    expect(() =>
      siteRelease.createSiteRelease(
        createAggregateManifest(),
        'http://example.com/releases/v1.2.3/'
      )
    ).toThrow('HTTPS')
    expect(() =>
      siteRelease.createSiteRelease(
        createAggregateManifest(),
        'https://user:secret@example.com/releases/v1.2.3/'
      )
    ).toThrow('无凭据')
  })

  it('verifies every public OSS object with HEAD and size checks', async () => {
    const manifest = siteRelease.createSiteRelease(
      createAggregateManifest(),
      'https://goodbuddy.oss-cn-beijing.aliyuncs.com/releases/v1.2.3/'
    )
    const sizes = new Map(
      Object.values(manifest.targets).flatMap((target) =>
        Object.values(target.files).map((file) => [file.url, file.size])
      )
    )
    const request = vi.fn(async (url: string | URL | Request) => {
      const size = sizes.get(String(url))
      return new Response(null, {
        status: size ? 200 : 404,
        headers: size ? { 'content-length': String(size) } : {}
      })
    }) as unknown as typeof fetch

    await expect(
      verifier.verifySiteRelease(manifest, request)
    ).resolves.toBe(14)
    expect(request).toHaveBeenCalledTimes(14)
  })
})

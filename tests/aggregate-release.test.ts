import {
  createHash
} from 'node:crypto'
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

interface TargetDefinition {
  platform: 'windows' | 'macos' | 'linux'
  arch: 'x64' | 'arm64'
  formats: string[]
}

interface AggregateModule {
  aggregateRelease: (
    inputDirectory: string,
    outputDirectory: string
  ) => Promise<{
    version: string
    targets: Array<{
      platform: string
      arch: string
      manifest: string
    }>
  }>
  assertSafeName: (name: string, description: string) => void
  targetDefinitions: TargetDefinition[]
}

const require = createRequire(import.meta.url)
const aggregate = require(
  '../build/aggregate-release.cjs'
) as AggregateModule
const packageVersion = (
  require('../package.json') as { version: string }
).version

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function artifactName(
  target: TargetDefinition,
  format: string
): string {
  const base =
    `GoodBuddy-${packageVersion}-${target.platform}-${target.arch}`
  if (format === 'nsis') {
    return `${base}-setup.exe`
  }
  if (format === 'portable') {
    return `${base}-portable.zip`
  }
  const extension = format === 'zip' ? 'zip' : format
  return `${base}.${extension}`
}

function createDownloadedArtifacts(parent: string): string {
  const input = join(parent, 'downloads')
  mkdirSync(input)
  for (const target of aggregate.targetDefinitions) {
    const key = `${target.platform}-${target.arch}`
    const directory = join(input, `goodbuddy-${key}`)
    mkdirSync(directory)
    const files = target.formats.map((format) => {
      const name = artifactName(target, format)
      const content = `${key}:${format}`
      writeFileSync(join(directory, name), content)
      return {
        name,
        size: Buffer.byteLength(content),
        sha256: sha256(content)
      }
    })
    const debugContent = `${key}:debug`
    writeFileSync(
      join(directory, 'builder-debug.yml'),
      debugContent
    )
    files.push({
      name: 'builder-debug.yml',
      size: Buffer.byteLength(debugContent),
      sha256: sha256(debugContent)
    })
    const metadataName = `metadata-${key}.json`
    const metadataContent = `${key}:metadata`
    writeFileSync(
      join(directory, metadataName),
      metadataContent
    )
    files.push({
      name: metadataName,
      size: Buffer.byteLength(metadataContent),
      sha256: sha256(metadataContent)
    })
    if (target.platform === 'windows') {
      const setupName = artifactName(target, 'nsis')
      const blockmapName = `${setupName}.blockmap`
      const blockmapContent = `${key}:blockmap`
      writeFileSync(
        join(directory, blockmapName),
        blockmapContent
      )
      files.push({
        name: blockmapName,
        size: Buffer.byteLength(blockmapContent),
        sha256: sha256(blockmapContent)
      })
    }
    writeFileSync(
      join(directory, 'release-manifest.json'),
      `${JSON.stringify({
        formatVersion: 1,
        productName: 'GoodBuddy',
        version: packageVersion,
        platform: target.platform,
        arch: target.arch,
        formats: target.formats,
        files
      }, null, 2)}\n`
    )
  }
  return input
}

describe('release asset aggregation', () => {
  it('strictly verifies six targets and writes isolated upload assets', async () => {
    const parent = mkdtempSync(
      join(tmpdir(), 'goodbuddy-release-aggregate-')
    )
    try {
      const input = createDownloadedArtifacts(parent)
      const output = join(parent, 'upload')
      const manifest = await aggregate.aggregateRelease(input, output)

      expect(manifest.version).toBe(packageVersion)
      expect(manifest.targets).toHaveLength(6)
      expect(
        manifest.targets.map((target) => target.manifest)
      ).toEqual([
        'release-manifest-windows-x64.json',
        'release-manifest-windows-arm64.json',
        'release-manifest-macos-x64.json',
        'release-manifest-macos-arm64.json',
        'release-manifest-linux-x64.json',
        'release-manifest-linux-arm64.json'
      ])

      const outputNames = readdirSync(output)
      expect(outputNames).toHaveLength(22)
      expect(outputNames).toContain('release-manifest.json')
      expect(outputNames).toContain('SHA256SUMS')
      expect(outputNames).not.toContain('builder-debug.yml')
      expect(
        outputNames.some((name) => name.startsWith('metadata-'))
      ).toBe(false)
      expect(
        outputNames.some((name) => name.endsWith('.blockmap'))
      ).toBe(false)
      const windowsManifest = JSON.parse(
        readFileSync(
          join(output, 'release-manifest-windows-x64.json'),
          'utf8'
        )
      ) as { files: Array<{ name: string }> }
      expect(windowsManifest.files.map((file) => file.name)).toEqual([
        artifactName(aggregate.targetDefinitions[0]!, 'nsis'),
        artifactName(aggregate.targetDefinitions[0]!, 'portable')
      ])
      const sums = readFileSync(
        join(output, 'SHA256SUMS'),
        'utf8'
      )
      expect(sums.trim().split('\n')).toHaveLength(21)
      expect(sums).toContain(
        'release-manifest-windows-x64.json'
      )
      expect(sums).not.toMatch(/\sSHA256SUMS(?:\r?\n|$)/u)
    } finally {
      rmSync(parent, { recursive: true, force: true })
    }
  })

  it('rejects package hash mismatches', async () => {
    const parent = mkdtempSync(
      join(tmpdir(), 'goodbuddy-release-hash-')
    )
    try {
      const input = createDownloadedArtifacts(parent)
      const file = join(
        input,
        'goodbuddy-windows-x64',
        artifactName(aggregate.targetDefinitions[0]!, 'nsis')
      )
      writeFileSync(file, 'tampered')

      await expect(
        aggregate.aggregateRelease(input, join(parent, 'upload'))
      ).rejects.toThrow('完整性校验失败')
    } finally {
      rmSync(parent, { recursive: true, force: true })
    }
  })

  it('verifies auxiliary files even though they are not published', async () => {
    const parent = mkdtempSync(
      join(tmpdir(), 'goodbuddy-release-auxiliary-')
    )
    try {
      const input = createDownloadedArtifacts(parent)
      writeFileSync(
        join(
          input,
          'goodbuddy-windows-x64',
          'builder-debug.yml'
        ),
        'tampered'
      )

      await expect(
        aggregate.aggregateRelease(input, join(parent, 'upload'))
      ).rejects.toThrow('完整性校验失败')
    } finally {
      rmSync(parent, { recursive: true, force: true })
    }
  })

  it.each([
    '../escape.exe',
    '..\\escape.exe',
    '/tmp/escape.exe',
    'nested/file.exe'
  ])('rejects path traversal in file name %s', (name) => {
    expect(() =>
      aggregate.assertSafeName(name, '测试文件名')
    ).toThrow('不安全路径')
  })

  it('rejects undeclared files', async () => {
    const parent = mkdtempSync(
      join(tmpdir(), 'goodbuddy-release-extra-')
    )
    try {
      const input = createDownloadedArtifacts(parent)
      writeFileSync(
        join(input, 'goodbuddy-linux-x64', 'unknown.rpm'),
        'unknown'
      )
      await expect(
        aggregate.aggregateRelease(input, join(parent, 'upload'))
      ).rejects.toThrow('未声明的文件')
    } finally {
      rmSync(parent, { recursive: true, force: true })
    }
  })
})

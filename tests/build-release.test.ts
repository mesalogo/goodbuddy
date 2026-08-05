import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

interface ReleaseOptions {
  platform: 'windows' | 'macos' | 'linux'
  arch: 'x64' | 'arm64'
  formats: string[]
  skipBuild: boolean
  dryRun: boolean
  help: boolean
}

interface ReleaseBuilderModule {
  assertReplaceableOutput: (
    directory: string,
    options: ReleaseOptions
  ) => void
  buildElectronBuilderArguments: (
    options: ReleaseOptions,
    outputDirectory: string
  ) => string[]
  detectBinaryArchitecture: (
    buffer: Buffer
  ) => 'x64' | 'arm64' | undefined
  parseArguments: (
    arguments_: string[],
    environment?: { platform: string; arch: string }
  ) => ReleaseOptions
  replaceOutput: (
    stagingDirectory: string,
    destination: string,
    options: ReleaseOptions
  ) => void
  verifyArtifacts: (
    directory: string,
    options: ReleaseOptions
  ) => void
  writeManifest: (
    directory: string,
    options: ReleaseOptions
  ) => Promise<{
    files: Array<{
      name: string
      size: number
      sha256: string
    }>
  }>
}

const require = createRequire(import.meta.url)
const packageVersion = (
  require('../package.json') as { version: string }
).version
const releaseBuilder = require(
  '../build/build-release.cjs'
) as ReleaseBuilderModule
const windowsOptions: ReleaseOptions = {
  platform: 'windows',
  arch: 'x64',
  formats: ['nsis', 'portable'],
  skipBuild: false,
  dryRun: false,
  help: false
}

function pe(machine: number): Buffer {
  const buffer = Buffer.alloc(256)
  buffer.write('MZ', 0, 'ascii')
  buffer.writeUInt32LE(128, 0x3c)
  buffer.write('PE\0\0', 128, 'ascii')
  buffer.writeUInt16LE(machine, 132)
  return buffer
}

function elf(machine: number, bigEndian = false): Buffer {
  const buffer = Buffer.alloc(64)
  buffer.set([0x7f, 0x45, 0x4c, 0x46])
  buffer[5] = bigEndian ? 2 : 1
  if (bigEndian) {
    buffer.writeUInt16BE(machine, 18)
  } else {
    buffer.writeUInt16LE(machine, 18)
  }
  return buffer
}

function machO(cpuType: number): Buffer {
  const buffer = Buffer.alloc(8)
  buffer.writeUInt32LE(0xfeedfacf, 0)
  buffer.writeUInt32LE(cpuType, 4)
  return buffer
}

describe('release build arguments', () => {
  it.each([
    ['win32', 'x64', 'windows', ['nsis', 'portable']],
    ['darwin', 'arm64', 'macos', ['dmg', 'zip']],
    ['linux', 'x64', 'linux', ['AppImage', 'deb']]
  ])(
    'uses %s host defaults',
    (host, arch, platform, formats) => {
      expect(
        releaseBuilder.parseArguments([], {
          platform: host,
          arch
        })
      ).toMatchObject({ platform, arch, formats })
    }
  )

  it('normalizes aliases, formats, and duplicate formats', () => {
    expect(
      releaseBuilder.parseArguments(
        [
          '--platform',
          'mac',
          '--arch',
          'arm64',
          '--format',
          'DMG,zip,dmg',
          '--skip-build',
          '--dry-run'
        ],
        { platform: 'win32', arch: 'x64' }
      )
    ).toEqual({
      platform: 'macos',
      arch: 'arm64',
      formats: ['dmg', 'zip'],
      skipBuild: true,
      dryRun: true,
      help: false
    })
  })

  it.each([
    [['--platform', 'freebsd'], '不支持当前系统'],
    [['--arch', 'ia32'], '不支持的架构'],
    [['--format', 'rpm'], '不支持打包格式'],
    [['--unknown'], '未知参数']
  ])('rejects invalid arguments', (arguments_, message) => {
    expect(() =>
      releaseBuilder.parseArguments(arguments_, {
        platform: 'linux',
        arch: 'x64'
      })
    ).toThrow(message)
  })

  it('builds target-specific electron-builder arguments', () => {
    const arguments_ =
      releaseBuilder.buildElectronBuilderArguments(
        {
          platform: 'windows',
          arch: 'arm64',
          formats: ['nsis', 'portable'],
          skipBuild: false,
          dryRun: false,
          help: false
        },
        'C:\\release-stage'
      )

    expect(arguments_).toEqual(
      expect.arrayContaining([
        '--win',
        'nsis',
        'portable',
        '--arm64',
        '--config.directories.output=C:\\release-stage',
        '--publish',
        'never',
        expect.stringContaining('nsis.artifactName='),
        expect.stringContaining('portable.artifactName=')
      ])
    )
  })
})

describe('release binary architecture detection', () => {
  it.each([
    [pe(0x8664), 'x64'],
    [pe(0xaa64), 'arm64'],
    [elf(62), 'x64'],
    [elf(183, true), 'arm64'],
    [machO(0x01000007), 'x64'],
    [machO(0x0100000c), 'arm64'],
    [Buffer.from('not an executable'), undefined]
  ])('detects binary headers', (buffer, expected) => {
    expect(
      releaseBuilder.detectBinaryArchitecture(buffer)
    ).toBe(expected)
  })
})

describe('release output safety', () => {
  it('writes a deterministic artifact manifest with streaming hashes', async () => {
    const directory = mkdtempSync(
      join(tmpdir(), 'goodbuddy-release-manifest-')
    )
    try {
      writeFileSync(join(directory, 'artifact.exe'), 'release')
      const manifest = await releaseBuilder.writeManifest(
        directory,
        windowsOptions
      )

      expect(manifest.files).toEqual([
        {
          name: 'artifact.exe',
          size: 7,
          sha256:
            'a4d451ec23463726f72c43d64c710968f6b602cd653b4de8adee1b556240a829'
        }
      ])
      expect(
        JSON.parse(
          readFileSync(
            join(directory, 'release-manifest.json'),
            'utf8'
          )
        )
      ).toMatchObject({
        productName: 'GoodBuddy',
        platform: 'windows',
        arch: 'x64'
      })
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('refuses to replace an unrecognized non-empty directory', () => {
    const directory = mkdtempSync(
      join(tmpdir(), 'goodbuddy-release-unsafe-')
    )
    try {
      writeFileSync(join(directory, 'user-file.txt'), 'keep')
      expect(() =>
        releaseBuilder.assertReplaceableOutput(
          directory,
          windowsOptions
        )
      ).toThrow('拒绝覆盖未识别的发布目录')
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('atomically replaces a recognized release directory', () => {
    const parent = mkdtempSync(
      join(tmpdir(), 'goodbuddy-release-replace-')
    )
    const destination = join(parent, 'windows-x64')
    const staging = join(parent, 'staging')
    try {
      mkdirSync(destination)
      mkdirSync(staging)
      writeFileSync(
        join(destination, 'release-manifest.json'),
        JSON.stringify({
          formatVersion: 1,
          productName: 'GoodBuddy',
          platform: 'windows',
          arch: 'x64'
        })
      )
      writeFileSync(join(destination, 'old.exe'), 'old')
      writeFileSync(join(staging, 'new.exe'), 'new')

      releaseBuilder.replaceOutput(
        staging,
        destination,
        windowsOptions
      )

      expect(existsSync(join(destination, 'new.exe'))).toBe(true)
      expect(existsSync(join(destination, 'old.exe'))).toBe(false)
      expect(existsSync(staging)).toBe(false)
    } finally {
      rmSync(parent, { recursive: true, force: true })
    }
  })

  it('requires one artifact for every requested format', () => {
    const directory = mkdtempSync(
      join(tmpdir(), 'goodbuddy-release-artifacts-')
    )
    try {
      writeFileSync(
        join(
          directory,
          `GoodBuddy-${packageVersion}-windows-x64-setup.exe`
        ),
        'MZ'
      )
      writeFileSync(
        join(
          directory,
          `GoodBuddy-${packageVersion}-windows-x64-portable.exe`
        ),
        'MZ'
      )
      expect(() =>
        releaseBuilder.verifyArtifacts(
          directory,
          windowsOptions
        )
      ).not.toThrow()
      rmSync(
        join(
          directory,
          `GoodBuddy-${packageVersion}-windows-x64-portable.exe`
        )
      )
      expect(() =>
        releaseBuilder.verifyArtifacts(
          directory,
          windowsOptions
        )
      ).toThrow('portable 产物数量错误')
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})

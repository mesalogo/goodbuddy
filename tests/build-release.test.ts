import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Writable } from 'node:stream'
import { describe, expect, it } from 'vitest'

interface ReleaseOptions {
  platform: 'windows' | 'macos' | 'linux'
  arch: 'x64' | 'arm64'
  formats: string[]
  skipBuild: boolean
  dryRun: boolean
  unsigned: boolean
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
  electronBuilderEnvironment: (
    options: ReleaseOptions,
    environment?: NodeJS.ProcessEnv
  ) => NodeJS.ProcessEnv
  createPortableZip: (
    unpackedDirectory: string,
    zipPath: string,
    dependencies?: {
      openOutput: (filePath: string) => Writable
    }
  ) => Promise<void>
  detectBinaryArchitecture: (
    buffer: Buffer
  ) => 'x64' | 'arm64' | undefined
  parseArguments: (
    arguments_: string[],
    environment?: { platform: string; arch: string }
  ) => ReleaseOptions
  parsePackedPackageMetadata: (
    output: string,
    expected: {
      name: string
      version: string
      integrity: string
    }
  ) => {
    name: string
    version: string
    integrity: string
    filename: string
  }
  lockedTargetRuntimePackage: (
    packageName: string,
    packageJson?: {
      dependencies?: Record<string, string>
      optionalDependencies?: Record<string, string>
    },
    packageLock?: {
      packages?: Record<
        string,
        {
          version?: string
          resolved?: string
          integrity?: string
          optionalDependencies?: Record<string, string>
        }
      >
    }
  ) => {
    name: string
    version: string
    integrity: string
  }
  replaceOutput: (
    stagingDirectory: string,
    destination: string,
    options: ReleaseOptions
  ) => void
  targetRuntimePackageNames: (
    options: ReleaseOptions
  ) => string[]
  stageTargetRuntimeDependencies: (
    options: ReleaseOptions,
    dependencies?: {
      root: string
      packageJson: {
        dependencies?: Record<string, string>
        optionalDependencies?: Record<string, string>
      }
      packageLock: {
        packages?: Record<
          string,
          {
            version?: string
            resolved?: string
            integrity?: string
            optionalDependencies?: Record<string, string>
          }
        >
      }
      npmInvocation: () => {
        command: string
        prefixArgs: string[]
      }
      runCapture: (
        command: string,
        arguments_: string[]
      ) => Promise<string>
      extractArchive: (
        archivePath: string,
        destination: string
      ) => Promise<void>
    }
  ) => Promise<() => void>
  verifyHarnessPackage: (
    resources: string,
    options: ReleaseOptions,
    dependencies?: {
      listPackage: (asarPath: string) => string[]
      statFile: (
        asarPath: string,
        filePath: string
      ) => {
        files?: Record<string, unknown>
        link?: string
        size?: number
      }
      extractFile: (
        asarPath: string,
        filePath: string
      ) => Buffer
    }
  ) => void
  verifyArtifacts: (
    directory: string,
    options: ReleaseOptions
  ) => void
  verifyPortableZip: (filePath: string) => void
  verifyArchiveIntegrity: (
    filePath: string,
    expectedIntegrity: string
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
  unsigned: false,
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

function portableDirectory(parent: string): string {
  const directory = join(parent, 'portable')
  mkdirSync(
    join(directory, 'resources', 'runtimes', 'opencode'),
    { recursive: true }
  )
  mkdirSync(
    join(directory, 'resources', 'runtimes', 'continue'),
    { recursive: true }
  )
  mkdirSync(
    join(
      directory,
      'resources',
      'runtimes',
      'npm',
      'node_modules',
      'graceful-fs'
    ),
    { recursive: true }
  )
  mkdirSync(
    join(
      directory,
      'resources',
      'runtimes',
      'npm',
      'bin'
    ),
    { recursive: true }
  )
  for (const [path, content] of [
    ['GoodBuddy.exe', 'MZ'],
    ['resources/app.asar', 'asar'],
    ['resources/release-notes.json', '{}'],
    ['resources/icon.ico', 'icon'],
    ['resources/tray-icon.png', 'tray'],
    ['resources/runtimes/opencode/opencode.exe', 'MZ'],
    ['resources/runtimes/continue/package.json', '{}'],
    [
      'resources/runtimes/npm/bin/npm-cli.js',
      'require("../lib/cli.js")'
    ],
    [
      'resources/runtimes/npm/package.json',
      '{"version":"11.19.0"}'
    ],
    [
      'resources/runtimes/npm/node_modules/graceful-fs/package.json',
      '{"name":"graceful-fs"}'
    ]
  ] satisfies Array<[string, string]>) {
    writeFileSync(join(directory, ...path.split('/')), content)
  }
  return directory
}

function endOfCentralDirectory(
  entryCount: number,
  centralSize: number,
  centralOffset = 0
): Buffer {
  const buffer = Buffer.alloc(22)
  buffer.writeUInt32LE(0x06054b50, 0)
  buffer.writeUInt16LE(entryCount, 8)
  buffer.writeUInt16LE(entryCount, 10)
  buffer.writeUInt32LE(centralSize, 12)
  buffer.writeUInt32LE(centralOffset, 16)
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
          '--dry-run',
          '--unsigned'
        ],
        { platform: 'win32', arch: 'x64' }
      )
    ).toEqual({
      platform: 'macos',
      arch: 'arm64',
      formats: ['dmg', 'zip'],
      skipBuild: true,
      dryRun: true,
      unsigned: true,
      help: false
    })
  })

  it.each([
    [['--platform', 'freebsd'], '不支持当前系统'],
    [['--arch', 'ia32'], '不支持的架构'],
    [['--format', 'rpm'], '不支持打包格式'],
    [['--platform', 'linux', '--unsigned'], '仅支持 macOS'],
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
          unsigned: false,
          help: false
        },
        'C:\\release-stage'
      )

    expect(arguments_).toEqual(
      expect.arrayContaining([
        '--win',
        'nsis',
        'dir',
        '--arm64',
        '--config.directories.output=C:\\release-stage',
        '--publish',
        'never',
        expect.stringContaining('nsis.artifactName=')
      ])
    )
    expect(arguments_).not.toContain('portable')
    expect(
      arguments_.some((argument) =>
        argument.includes('portable.artifactName=')
      )
    ).toBe(false)
  })

  it('explicitly disables notarization for unsigned macOS packages', () => {
    const arguments_ =
      releaseBuilder.buildElectronBuilderArguments(
        {
          ...windowsOptions,
          platform: 'macos',
          formats: ['dmg', 'zip'],
          unsigned: true
        },
        '/release-stage'
      )

    expect(arguments_).toContain('--config.mac.notarize=false')
  })

  it('removes signing credentials from unsigned macOS builds', () => {
    const environment =
      releaseBuilder.electronBuilderEnvironment(
        {
          ...windowsOptions,
          platform: 'macos',
          formats: ['dmg', 'zip'],
          unsigned: true
        },
        {
          CSC_LINK: 'certificate',
          CSC_KEY_PASSWORD: 'password',
          APPLE_API_KEY: 'api-key',
          APPLE_API_KEY_ID: 'key-id',
          APPLE_API_ISSUER: 'issuer',
          KEEP_ME: 'present'
        }
      )

    expect(environment).toMatchObject({
      CSC_IDENTITY_AUTO_DISCOVERY: 'false',
      KEEP_ME: 'present'
    })
    expect(environment).not.toHaveProperty('CSC_LINK')
    expect(environment).not.toHaveProperty('CSC_KEY_PASSWORD')
    expect(environment).not.toHaveProperty('APPLE_API_KEY')
    expect(environment).not.toHaveProperty('APPLE_API_KEY_ID')
    expect(environment).not.toHaveProperty('APPLE_API_ISSUER')
  })

  it('pins and unpacks only the required Harness native packages', () => {
    const packageJson = require('../package.json') as {
      build: {
        asarUnpack: string[]
        npmRebuild: boolean
      }
      optionalDependencies: Record<string, string>
    }
    expect(packageJson.build.npmRebuild).toBe(false)
    expect(packageJson.build.asarUnpack).toEqual(
      expect.arrayContaining([
        'out/main/package.json',
        'out/main/deepseek-harness-*',
        'out/main/chunks/**/*',
        'node_modules/node-pty/lib/**/*',
        'node_modules/node-pty/package.json',
        'node_modules/node-pty/prebuilds/**/*',
        'node_modules/node-pty/build/Release/**/*',
        'node_modules/koffi/**/*',
        'node_modules/@koromix/koffi-*/**/*',
        'node_modules/@napi-rs/canvas{,/**/*}',
        'node_modules/@napi-rs/canvas-*/**/*'
      ])
    )
    expect(packageJson.build.asarUnpack).not.toContain(
      'node_modules/npm/**/*'
    )
    expect(packageJson.optionalDependencies).toEqual({
      '@koromix/koffi-darwin-arm64': '3.1.4',
      '@koromix/koffi-darwin-x64': '3.1.4',
      '@koromix/koffi-linux-arm64': '3.1.4',
      '@koromix/koffi-linux-x64': '3.1.4',
      '@koromix/koffi-win32-arm64': '3.1.4',
      '@koromix/koffi-win32-x64': '3.1.4'
    })
  })

  it('identifies the native packages required by each release target', () => {
    expect(
      releaseBuilder.targetRuntimePackageNames({
        ...windowsOptions,
        arch: 'arm64'
      })
    ).toEqual([
      '@koromix/koffi-win32-arm64',
      '@napi-rs/canvas-win32-arm64-msvc'
    ])
    expect(
      releaseBuilder.targetRuntimePackageNames({
        ...windowsOptions,
        platform: 'linux',
        formats: ['AppImage', 'deb']
      })
    ).toEqual([
      '@koromix/koffi-linux-x64',
      '@napi-rs/canvas-linux-x64-gnu'
    ])
    expect(
      releaseBuilder.targetRuntimePackageNames({
        ...windowsOptions,
        platform: 'macos',
        arch: 'arm64',
        formats: ['dmg', 'zip']
      })
    ).toEqual([
      '@koromix/koffi-darwin-arm64',
      '@napi-rs/canvas-darwin-arm64'
    ])
  })

  it('stages a missing target Canvas package from locked metadata', async () => {
    const runtimeRoot = mkdtempSync(
      join(tmpdir(), 'goodbuddy-release-canvas-stage-')
    )
    const canvasPackage =
      '@napi-rs/canvas-win32-arm64-msvc'
    const koffiPackage = '@koromix/koffi-win32-arm64'
    const archiveContents = Buffer.from('locked Canvas archive')
    const integrity = `sha512-${createHash('sha512')
      .update(archiveContents)
      .digest('base64')}`
    const packageJson = {
      dependencies: {
        '@napi-rs/canvas': '1.0.3'
      },
      optionalDependencies: {
        [koffiPackage]: '3.1.4'
      }
    }
    const packageLock = {
      packages: {
        'node_modules/@napi-rs/canvas': {
          version: '1.0.3',
          optionalDependencies: {
            [canvasPackage]: '1.0.3'
          }
        },
        [`node_modules/${canvasPackage}`]: {
          version: '1.0.3',
          resolved: 'https://registry.npmjs.org/locked-canvas.tgz',
          integrity
        },
        [`node_modules/${koffiPackage}`]: {
          version: '3.1.4',
          resolved: 'https://registry.npmjs.org/locked-koffi.tgz',
          integrity: 'sha512-locked'
        }
      }
    }
    const koffiDirectory = join(
      runtimeRoot,
      'node_modules',
      ...koffiPackage.split('/')
    )
    const canvasDirectory = join(
      runtimeRoot,
      'node_modules',
      ...canvasPackage.split('/')
    )
    const invocations: string[][] = []
    let cleanup: () => void = () => undefined

    try {
      mkdirSync(koffiDirectory, { recursive: true })
      writeFileSync(
        join(koffiDirectory, 'package.json'),
        JSON.stringify({
          name: koffiPackage,
          version: '3.1.4'
        })
      )

      cleanup =
        await releaseBuilder.stageTargetRuntimeDependencies(
          {
            ...windowsOptions,
            arch: 'arm64'
          },
          {
            root: runtimeRoot,
            packageJson,
            packageLock,
            npmInvocation: () => ({
              command: 'npm-test',
              prefixArgs: []
            }),
            runCapture: async (_command, arguments_) => {
              invocations.push(arguments_)
              const destination = arguments_[
                arguments_.indexOf('--pack-destination') + 1
              ]
              if (!destination) {
                throw new Error('pack destination is missing')
              }
              writeFileSync(
                join(destination, 'locked-canvas.tgz'),
                archiveContents
              )
              return JSON.stringify([
                {
                  name: canvasPackage,
                  version: '1.0.3',
                  integrity,
                  filename: 'locked-canvas.tgz'
                }
              ])
            },
            extractArchive: async (_archive, destination) => {
              writeFileSync(
                join(destination, 'package.json'),
                JSON.stringify({
                  name: canvasPackage,
                  version: '1.0.3'
                })
              )
            }
          }
        )

      expect(invocations).toHaveLength(1)
      expect(invocations[0]).toEqual(
        expect.arrayContaining([
          'pack',
          `${canvasPackage}@1.0.3`,
          '--ignore-scripts',
          '--json'
        ])
      )
      expect(invocations[0]).not.toContain(
        `${canvasPackage}@latest`
      )
      expect(
        JSON.parse(
          readFileSync(
            join(canvasDirectory, 'package.json'),
            'utf8'
          )
        )
      ).toMatchObject({
        name: canvasPackage,
        version: '1.0.3'
      })

      cleanup()
      cleanup = () => undefined
      expect(existsSync(canvasDirectory)).toBe(false)
      expect(existsSync(koffiDirectory)).toBe(true)
    } finally {
      cleanup()
      rmSync(runtimeRoot, { recursive: true, force: true })
    }
  })

  it.each([
    [
      'the target package version differs',
      {
        version: '1.0.4',
        resolved: 'https://registry.npmjs.org/canvas.tgz',
        integrity: 'sha512-locked'
      }
    ],
    [
      'target package integrity is missing',
      {
        version: '1.0.3',
        resolved: 'https://registry.npmjs.org/canvas.tgz'
      }
    ]
  ])('fails closed when %s in the lockfile', (_case, targetLock) => {
    const canvasPackage =
      '@napi-rs/canvas-win32-arm64-msvc'
    expect(() =>
      releaseBuilder.lockedTargetRuntimePackage(
        canvasPackage,
        {
          dependencies: {
            '@napi-rs/canvas': '1.0.3'
          }
        },
        {
          packages: {
            'node_modules/@napi-rs/canvas': {
              version: '1.0.3',
              optionalDependencies: {
                [canvasPackage]: '1.0.3'
              }
            },
            [`node_modules/${canvasPackage}`]: targetLock
          }
        }
      )
    ).toThrow('目标 Runtime 依赖未完整锁定')
  })

  it('validates packed target dependency metadata and archive integrity', () => {
    const directory = mkdtempSync(
      join(tmpdir(), 'goodbuddy-release-dependency-test-')
    )
    const archive = join(directory, 'target.tgz')
    const contents = Buffer.from('locked target dependency')
    writeFileSync(archive, contents)
    const integrity = `sha512-${createHash('sha512')
      .update(contents)
      .digest('base64')}`
    const expected = {
      name: '@koromix/koffi-win32-arm64',
      version: '3.1.4',
      integrity
    }

    try {
      expect(
        releaseBuilder.parsePackedPackageMetadata(
          JSON.stringify([
            {
              ...expected,
              filename: 'koffi-win32-arm64.tgz'
            }
          ]),
          expected
        )
      ).toMatchObject({
        ...expected,
        filename: 'koffi-win32-arm64.tgz'
      })
      releaseBuilder.verifyArchiveIntegrity(archive, integrity)
      expect(() =>
        releaseBuilder.verifyArchiveIntegrity(
          archive,
          `sha512-${Buffer.alloc(64).toString('base64')}`
        )
      ).toThrow('完整性校验失败')
      expect(() =>
        releaseBuilder.parsePackedPackageMetadata(
          JSON.stringify([
            {
              ...expected,
              version: '3.1.5',
              filename: 'koffi-win32-arm64.tgz'
            }
          ]),
          expected
        )
      ).toThrow('元数据不匹配')
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('keeps Web3D test fixtures out of release resources', () => {
    const packageJson = require('../package.json') as {
      build: {
        files: string[]
        extraResources: Array<{
          from: string
          to?: string
          filter?: string[]
        }>
      }
    }
    const resourceSources = packageJson.build.extraResources.map(
      (entry) => entry.from
    )

    expect(packageJson.build.files).toEqual([
      'out/**/*',
      'package.json',
      '!node_modules/npm{,/**/*}'
    ])
    expect(resourceSources).toContain('resources/skills')
    expect(packageJson.build.extraResources).toContainEqual({
      from: 'node_modules',
      to: 'runtimes',
      filter: ['npm{,/**/*}']
    })
    expect(
      resourceSources.some((source) => source.startsWith('tests/'))
    ).toBe(false)
    expect(
      existsSync(join('resources', 'skills', 'web-3d-game'))
    ).toBe(false)
    expect(
      existsSync(join('resources', 'web-3d-game-mcp.mjs'))
    ).toBe(false)
    expect(
      existsSync(
        join(
          'tests',
          'fixtures',
          'web-3d-game-skill',
          'SKILL.md'
        )
      )
    ).toBe(true)
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

describe('release Harness package verification', () => {
  it('fails closed when the packaged Harness Host is missing', () => {
    const directory = mkdtempSync(
      join(tmpdir(), 'goodbuddy-harness-closure-')
    )
    const resources = join(directory, 'resources')
    try {
      mkdirSync(resources, { recursive: true })
      writeFileSync(join(resources, 'app.asar'), 'asar')
      expect(() =>
        releaseBuilder.verifyHarnessPackage(
          resources,
          windowsOptions,
          {
            listPackage: () => [],
            statFile: () => ({ size: 1 }),
            extractFile: () => Buffer.from('{}')
          }
        )
      ).toThrow('DeepSeek Harness Host缺失')
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})

describe('release output safety', () => {
  it('preserves an existing portable ZIP when exclusive creation fails', async () => {
    const directory = mkdtempSync(
      join(tmpdir(), 'goodbuddy-portable-existing-')
    )
    try {
      const unpacked = portableDirectory(directory)
      const zipPath = join(directory, 'portable.zip')
      writeFileSync(zipPath, 'keep-existing-output')

      await expect(
        releaseBuilder.createPortableZip(unpacked, zipPath)
      ).rejects.toMatchObject({ code: 'EEXIST' })
      expect(readFileSync(zipPath, 'utf8')).toBe(
        'keep-existing-output'
      )
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('handles portable ZIP output stream failures without hanging', async () => {
    const directory = mkdtempSync(
      join(tmpdir(), 'goodbuddy-portable-write-error-')
    )
    try {
      const unpacked = portableDirectory(directory)
      const failure = new Error('simulated ZIP write failure')
      const output = new Writable({
        write(_chunk, _encoding, callback) {
          callback(failure)
        }
      })

      await expect(
        releaseBuilder.createPortableZip(
          unpacked,
          join(directory, 'unused.zip'),
          { openOutput: () => output }
        )
      ).rejects.toThrow('simulated ZIP write failure')
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it.each([
    [
      'an excessive entry count',
      endOfCentralDirectory(50_001, 46)
    ],
    [
      'an oversized central directory',
      endOfCentralDirectory(7, 64 * 1024 * 1024 + 1)
    ]
  ])('rejects %s before reading ZIP central data', (_case, bytes) => {
    const directory = mkdtempSync(
      join(tmpdir(), 'goodbuddy-portable-invalid-')
    )
    try {
      const zipPath = join(directory, 'portable.zip')
      writeFileSync(zipPath, bytes)
      expect(() =>
        releaseBuilder.verifyPortableZip(zipPath)
      ).toThrow('中央目录无效')
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

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

  it('requires one artifact for every requested format', async () => {
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
      const unpacked = portableDirectory(directory)
      const portableZip = join(
        directory,
        `GoodBuddy-${packageVersion}-windows-x64-portable.zip`
      )
      await releaseBuilder.createPortableZip(
        unpacked,
        portableZip
      )
      expect(() =>
        releaseBuilder.verifyArtifacts(
          directory,
          windowsOptions
        )
      ).not.toThrow()
      rmSync(portableZip)
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

import {
  createHash,
  createPrivateKey,
  sign,
  type KeyObject
} from 'node:crypto'
import { execFileSync } from 'node:child_process'
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { c as createTar } from 'tar'
import { unzipSync, zipSync } from 'fflate'
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  it,
  vi
} from 'vitest'
import {
  agentPackageCatalogSchema,
  agentPackageDescriptorSchema,
  agentPackageArchiveName,
  type AgentPackageCatalog,
  type AgentPackageCatalogEntry,
  type AgentPackageDescriptor
} from '../src/shared/agent-package-contracts'
import type {
  AgentReleaseKeyRegistry,
  AgentRuntimeLock
} from '../src/shared/agent-installation-contracts'
import type {
  RemoteRuntimeLock
} from '../src/shared/remote-runtime-launch-contracts'
import {
  compareSemanticVersions,
  extractAndVerifyAgentPackage
} from '../src/main/remote-agent/agent-package-verifier'
import {
  AgentPackageManager,
  selectLatestCompatibleEntry
} from '../src/main/remote-agent/agent-package-manager'

type AgentBundleModule = {
  canonicalManifestBytes(manifest: unknown): Buffer
  createManifest(
    directory: string,
    metadata: Record<string, unknown>
  ): AgentPackageDescriptor
  publicKeySpkiBase64(key: KeyObject): string
  signManifestForTest(bytes: Buffer, key: KeyObject): Buffer
}

type RuntimeBundleModule = {
  buildRuntimeBundle(options: {
    projectRoot: string
    architecture: 'x64' | 'arm64'
    runtimeArchive: string
    outputRoot: string
    lock: RemoteRuntimeLock
    registry: AgentReleaseKeyRegistry
    testSigningIdentity: {
      keyId: string
      privateKey: KeyObject
    }
    enforceFilesystemMode: false
  }): {
    bundleDirectory: string
  }
}

type AgentPackageModule = {
  assembleAgentPackage(options: {
    projectRoot: string
    architecture: 'x64' | 'arm64'
    minimumDesktopVersion: string
    output: string
    agentBundle: string
    runtimeBundle: string
    agentLock: AgentRuntimeLock
    runtimeLock: RemoteRuntimeLock
    registry: AgentReleaseKeyRegistry
    testSigningIdentity: {
      keyId: string
      privateKey: KeyObject
    }
  }): {
    descriptor: AgentPackageDescriptor
    archive: string
    size: number
    sha256: string
  }
  descriptorBytes(descriptor: AgentPackageDescriptor): Buffer
  descriptorContentDigest(
    descriptor: AgentPackageDescriptor
  ): string
  signatureDomain: Buffer
}

type AgentCatalogModule = {
  readPackageMetadata(
    archivePath: string,
    registry: AgentReleaseKeyRegistry
  ): {
    descriptor: AgentPackageDescriptor
    size: number
    sha256: string
  }
  createCatalog(options: {
    projectRoot: string
    x64Package: string
    arm64Package: string
    previousCatalog?: string
    previousSignature?: string
    outputCatalog: string
    outputSignature: string
    generatedAt: string
    registry: AgentReleaseKeyRegistry
    signingIdentity: {
      keyId: string
      privateKey: KeyObject
    }
  }): {
    version: string
    catalog: string
    signature: string
    entries: number
  }
  readVerifiedCatalog(
    catalogPath: string,
    signaturePath: string,
    registry: AgentReleaseKeyRegistry
  ): AgentPackageCatalog
}

type PackageInstallerModule = {
  preparePackage(options: {
    operationRoot: string
    archive: string
    expectedSha256: string
    homeDirectory: string
    emit?: (event: unknown) => void
  }): {
    type: 'result'
    command: 'prepare'
    status: 'prepared'
    archiveSha256: string
    agent: {
      installationId: string
      agentVersion: string
      manifestSha256: string
      binaryDigest: string
      platform: 'linux'
      architecture: 'x64' | 'arm64'
      protocol: { major: number; minor: number }
      supervisor: 'detached-on-demand'
    }
    runtime: {
      runtimeId: 'opencode'
      runtimeVersion: string
      bundleDigest: string
      manifestDigest: string
      runtimeAdapterDigest: string
      acpCapabilitiesDigest: string
      platform: 'linux'
      architecture: 'x64' | 'arm64'
      protocol: { major: number; minor: number }
    }
  }
  commitPackage(options: {
    operationRoot: string
    archive: string
    expectedSha256: string
    homeDirectory: string
    emit?: (event: unknown) => void
  }): {
    command: 'commit'
    status: 'committed'
    agent: PackageInstallerModule[
      'preparePackage'
    ] extends (...args: never[]) => infer Result
      ? Result extends { agent: infer Agent }
        ? Agent
        : never
      : never
    runtime: PackageInstallerModule[
      'preparePackage'
    ] extends (...args: never[]) => infer Result
      ? Result extends { runtime: infer Runtime }
        ? Runtime
        : never
      : never
  }
}

const require = createRequire(import.meta.url)
const agentBundle = require(
  '../build/agent-bundle.cjs'
) as AgentBundleModule
const runtimeBundle = require(
  '../build/remote-runtime-bundle.cjs'
) as RuntimeBundleModule
const agentPackage = require(
  '../build/agent-package.cjs'
) as AgentPackageModule
const agentCatalog = require(
  '../build/agent-catalog.cjs'
) as AgentCatalogModule
const catalogSignatureDomain = Buffer.from(
  'GoodBuddy Agent Package Catalog Signature v1\0',
  'utf8'
)

let temporaryRoot = ''
let privateKey: KeyObject
let registry: AgentReleaseKeyRegistry
let agentLock: AgentRuntimeLock
let remoteRuntimeLock: RemoteRuntimeLock
let packagePath = ''
let arm64PackagePath = ''
let packageResult: ReturnType<
  AgentPackageModule['assembleAgentPackage']
>
let arm64PackageResult: ReturnType<
  AgentPackageModule['assembleAgentPackage']
>
let packageInstaller: PackageInstallerModule
let installerBundle = ''

beforeAll(() => {
  temporaryRoot = resolve(
    mkdtempSync(join(tmpdir(), 'goodbuddy-agent-package-test-'))
  )
  installerBundle = join(
    temporaryRoot,
    'package-installer-fixture.cjs'
  )
  execFileSync(process.execPath, [
    '-e',
    [
      "require('esbuild').buildSync({",
      `entryPoints:[${JSON.stringify(
        join(
          process.cwd(),
          'src',
          'main',
          'remote-agent',
          'control-plane-package-installer.ts'
        )
      )}],`,
      `outfile:${JSON.stringify(installerBundle)},`,
      "bundle:true,platform:'node',target:['node24.19'],",
      "format:'cjs',logLevel:'silent'})"
    ].join('')
  ])
  packageInstaller = require(installerBundle) as PackageInstallerModule
  privateKey = createPrivateKey({
    key: Buffer.from(
      '302e020100300506032b657004220420404142434445464748494a4b4c4d4e4f505152535455565758595a5b5c5d5e5f',
      'hex'
    ),
    format: 'der',
    type: 'pkcs8'
  })
  registry = {
    formatVersion: 1,
    keys: [{
      keyId: 'agent-package-fixture',
      publicKeySpkiBase64:
        agentBundle.publicKeySpkiBase64(privateKey),
      environment: 'production'
    }],
    revocations: []
  }
  agentLock = JSON.parse(
    readFileSync(
      join(process.cwd(), 'agent-runtime-lock.json'),
      'utf8'
    )
  ) as AgentRuntimeLock
  const agentDirectory = join(temporaryRoot, 'agent')
  const arm64AgentDirectory = join(temporaryRoot, 'agent-arm64')
  writeAgentBundle(agentDirectory, 'x64')
  writeAgentBundle(arm64AgentDirectory, 'arm64')
  const runtimeInput = createRuntimeInput('x64')
  const arm64RuntimeInput = createRuntimeInput('arm64')
  remoteRuntimeLock = createRemoteRuntimeLock(
    runtimeInput,
    arm64RuntimeInput
  )
  const buildRuntime = (
    architecture: 'x64' | 'arm64',
    archive: string
  ) => runtimeBundle.buildRuntimeBundle({
    projectRoot: process.cwd(),
    architecture,
    runtimeArchive: archive,
    outputRoot: join(temporaryRoot, 'runtime'),
    lock: remoteRuntimeLock,
    registry,
    testSigningIdentity: {
      keyId: 'agent-package-fixture',
      privateKey
    },
    enforceFilesystemMode: false
  })
  const builtRuntime = buildRuntime('x64', runtimeInput)
  const builtArm64Runtime = buildRuntime(
    'arm64',
    arm64RuntimeInput
  )
  packagePath = join(
    temporaryRoot,
    agentPackageArchiveName(agentLock.agentVersion, 'x64')
  )
  packageResult = agentPackage.assembleAgentPackage({
    projectRoot: process.cwd(),
    architecture: 'x64',
    minimumDesktopVersion: '0.11.0',
    output: packagePath,
    agentBundle: agentDirectory,
    runtimeBundle: builtRuntime.bundleDirectory,
    agentLock,
    runtimeLock: remoteRuntimeLock,
    registry,
    testSigningIdentity: {
      keyId: 'agent-package-fixture',
      privateKey
    }
  })
  arm64PackagePath = join(
    temporaryRoot,
    agentPackageArchiveName(agentLock.agentVersion, 'arm64')
  )
  arm64PackageResult = agentPackage.assembleAgentPackage({
    projectRoot: process.cwd(),
    architecture: 'arm64',
    minimumDesktopVersion: '0.11.0',
    output: arm64PackagePath,
    agentBundle: arm64AgentDirectory,
    runtimeBundle: builtArm64Runtime.bundleDirectory,
    agentLock,
    runtimeLock: remoteRuntimeLock,
    registry,
    testSigningIdentity: {
      keyId: 'agent-package-fixture',
      privateKey
    }
  })
})

afterAll(() => {
  rmSync(temporaryRoot, { recursive: true, force: true })
})

describe('compound Agent packages', () => {
  it('assembles deterministic signed archives with private extraction', async () => {
    const secondRoot = join(temporaryRoot, 'second')
    mkdirSync(secondRoot)
    const secondPath = join(
      secondRoot,
      agentPackageArchiveName(agentLock.agentVersion, 'x64')
    )
    const archive = unzipSync(
      new Uint8Array(readFileSync(packagePath))
    )
    expect(Object.keys(archive).sort()).toEqual(
      expect.arrayContaining([
        'agent-package.json',
        'agent-package.sig',
        'agent-release-keys.json',
        'agent-runtime-lock.json',
        'remote-runtime-lock.json'
      ])
    )
    expect(packageResult.descriptor.files).toContainEqual(
      expect.objectContaining({
        path: 'agent/helpers/fixture-helper',
        mode: '0755'
      })
    )
    for (const [result, archivePath] of [
      [packageResult, packagePath],
      [arm64PackageResult, arm64PackagePath]
    ] as const) {
      expect(result.descriptor.files).toContainEqual(
        expect.objectContaining({
          path: 'agent/node',
          mode: '0755'
        })
      )
      expect(result.descriptor.files).not.toContainEqual(
        expect.objectContaining({
          path: 'agent/lib/package-installer.cjs'
        })
      )
      expect(
        Object.keys(
          unzipSync(new Uint8Array(readFileSync(archivePath)))
        )
      ).not.toContain('agent/lib/package-installer.cjs')
    }

    const contentRoot = join(temporaryRoot, 'verified')
    const verified = await extractAndVerifyAgentPackage({
      archivePath: packagePath,
      destinationDirectory: contentRoot,
      architecture: 'x64',
      desktopVersion: '0.11.0',
      trustedRegistry: registry
    })
    expect(verified).toMatchObject({
      descriptor: {
        version: agentLock.agentVersion,
        architecture: 'x64',
        remoteRuntime: {
          version:
            remoteRuntimeLock.runtimes.opencode.version
        }
      }
    })
    if (process.platform !== 'win32') {
      for (const directory of [verified.rootDirectory]) {
        expect(lstatSync(directory).mode & 0o777).toBe(0o700)
      }
    }

    const second = agentPackage.assembleAgentPackage({
      projectRoot: process.cwd(),
      architecture: 'x64',
      minimumDesktopVersion: '0.11.0',
      output: secondPath,
      agentBundle: join(temporaryRoot, 'agent'),
      runtimeBundle: findRuntimeBundleDirectory(),
      agentLock,
      runtimeLock: remoteRuntimeLock,
      registry,
      testSigningIdentity: {
        keyId: 'agent-package-fixture',
        privateKey
      }
    })
    expect(second.archive).toBe(
      agentPackageArchiveName(agentLock.agentVersion, 'x64')
    )
    expect(readFileSync(secondPath)).toEqual(
      readFileSync(packagePath)
    )
  })

  it('prepares and commits a format-v1 package without an embedded installer', () => {
    const operationRoot = join(temporaryRoot, 'remote-operation')
    const homeDirectory = join(temporaryRoot, 'remote-home')
    const globalMetadata = seedGlobalManagedMetadata(
      homeDirectory,
      'a'
    )
    const events: unknown[] = []
    const prepared = packageInstaller.preparePackage({
      operationRoot,
      archive: packagePath,
      expectedSha256: packageResult.sha256,
      homeDirectory,
      emit: (event) => events.push(event)
    })
    expect(prepared).toMatchObject({
      type: 'result',
      command: 'prepare',
      status: 'prepared',
      archiveSha256: packageResult.sha256,
      agent: {
        installationId: expect.stringMatching(/^agent-[a-f0-9]{64}$/u),
        agentVersion: agentLock.agentVersion,
        architecture: 'x64',
        protocol: agentLock.protocol
      },
      runtime: {
        runtimeId: 'opencode',
        runtimeVersion:
          remoteRuntimeLock.runtimes.opencode.version,
        bundleDigest:
          packageResult.descriptor.remoteRuntime.bundleDigest,
        architecture: 'x64'
      }
    })
    expect(events.at(-1)).toEqual(prepared)
    expect(readdirSync(join(operationRoot, 'prepared')))
      .toEqual([
        'agent-package.json',
        'agent-package.sig',
        'agent-release-keys.json',
        'agent-runtime-lock.json',
        'payload',
        'remote-runtime-lock.json',
        'result.json'
      ])
    expectGlobalMetadataUnchanged(globalMetadata)

    const cliOperationRoot = join(temporaryRoot, 'remote-cli-operation')
    const cliLines = execFileSync(
      process.execPath,
      [
        installerBundle,
        'prepare',
        '--operation-root',
        cliOperationRoot,
        '--archive',
        packagePath,
        '--expected-sha256',
        packageResult.sha256
      ],
      { encoding: 'utf8' }
    )
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>)
    expect(cliLines[0]).toMatchObject({
      type: 'progress',
      command: 'prepare',
      phase: 'validating'
    })
    expect(cliLines.at(-1)).toMatchObject({
      type: 'result',
      command: 'prepare',
      status: 'prepared',
      agent: prepared.agent,
      runtime: prepared.runtime
    })

    const commitEvents: Array<Record<string, unknown>> = []
    const committed = packageInstaller.commitPackage({
      operationRoot,
      archive: packagePath,
      expectedSha256: packageResult.sha256,
      homeDirectory,
      emit: (event) => {
        commitEvents.push(event as Record<string, unknown>)
      }
    })
    expect(committed).toMatchObject({
      command: 'commit',
      status: 'committed',
      agent: prepared.agent,
      runtime: prepared.runtime
    })
    const agentDestination = join(
      homeDirectory,
      '.goodbuddy',
      'agent',
      'installations',
      prepared.agent.installationId
    )
    const runtimeDestination = join(
      homeDirectory,
      '.goodbuddy',
      'runtimes',
      'opencode',
      prepared.runtime.bundleDigest.slice('sha256:'.length)
    )
    expect(lstatSync(join(agentDestination, 'lib', 'agent.cjs')).isFile())
      .toBe(true)
    expect(lstatSync(join(runtimeDestination, 'bin', 'opencode')).isFile())
      .toBe(true)
    expect(
      commitEvents.filter(
        (event) =>
          event.type === 'progress' &&
          event.phase === 'publishing-content'
      )
    ).toHaveLength(1)
    expect(readdirSync(join(operationRoot, 'prepared')))
      .toEqual([
        'agent-package.json',
        'agent-package.sig',
        'agent-release-keys.json',
        'agent-runtime-lock.json',
        'payload',
        'remote-runtime-lock.json',
        'result.json'
      ])
    expect(readdirSync(operationRoot)).toEqual(['prepared'])
    expectRegistriesUnchangedAndPackageTrustPublished(
      globalMetadata
    )

    packageInstaller.preparePackage({
      operationRoot,
      archive: packagePath,
      expectedSha256: packageResult.sha256,
      homeDirectory
    })
    expect(() =>
      packageInstaller.commitPackage({
        operationRoot,
        archive: packagePath,
        expectedSha256: packageResult.sha256,
        homeDirectory
      })
    ).not.toThrow()
    expectRegistriesUnchangedAndPackageTrustPublished(
      globalMetadata
    )
  })

  it('resumes commit after an Agent directory was already published', () => {
    const operationRoot = join(
      temporaryRoot,
      'partial-commit-operation'
    )
    const homeDirectory = join(
      temporaryRoot,
      'partial-commit-home'
    )
    const prepared = packageInstaller.preparePackage({
      operationRoot,
      archive: packagePath,
      expectedSha256: packageResult.sha256,
      homeDirectory
    })
    const agentSource = join(
      operationRoot,
      'prepared',
      'payload',
      'agent'
    )
    const agentDestination = join(
      homeDirectory,
      '.goodbuddy',
      'agent',
      'installations',
      prepared.agent.installationId
    )
    mkdirSync(dirname(agentDestination), {
      recursive: true,
      mode: 0o700
    })
    renameSync(agentSource, agentDestination)

    expect(
      packageInstaller.commitPackage({
        operationRoot,
        archive: packagePath,
        expectedSha256: packageResult.sha256,
        homeDirectory
      })
    ).toMatchObject({
      status: 'committed',
      agent: prepared.agent,
      runtime: prepared.runtime
    })
    expect(
      lstatSync(join(agentDestination, 'goodbuddy-agent'))
        .isFile()
    ).toBe(true)
    expect(
      lstatSync(
        join(
          homeDirectory,
          '.goodbuddy',
          'runtimes',
          'opencode',
          prepared.runtime.bundleDigest.slice(
            'sha256:'.length
          ),
          'bin',
          'opencode'
        )
      ).isFile()
    ).toBe(true)
  })

  it('requires untampered prepared state before commit mutation', () => {
    const homeDirectory = join(temporaryRoot, 'prepared-state-home')
    const tamperedOperation = join(
      temporaryRoot,
      'tampered-prepared-state-operation'
    )
    packageInstaller.preparePackage({
      operationRoot: tamperedOperation,
      archive: packagePath,
      expectedSha256: packageResult.sha256,
      homeDirectory
    })
    const statePath = join(tamperedOperation, 'prepared', 'result.json')
    const state = JSON.parse(
      readFileSync(statePath, 'utf8')
    ) as Record<string, unknown>
    const stateAgent = state.agent as Record<string, unknown>
    stateAgent.agentVersion = '99.0.0'
    writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`)
    expect(() =>
      packageInstaller.commitPackage({
        operationRoot: tamperedOperation,
        archive: packagePath,
        expectedSha256: packageResult.sha256,
        homeDirectory
      })
    ).toThrow('does not match the authenticated archive')
    expect(readdirSync(tamperedOperation)).toEqual(['prepared'])

    const missingOperation = join(
      temporaryRoot,
      'missing-prepared-state-operation'
    )
    packageInstaller.preparePackage({
      operationRoot: missingOperation,
      archive: packagePath,
      expectedSha256: packageResult.sha256,
      homeDirectory
    })
    rmSync(join(missingOperation, 'prepared', 'result.json'))
    expect(() =>
      packageInstaller.commitPackage({
        operationRoot: missingOperation,
        archive: packagePath,
        expectedSha256: packageResult.sha256,
        homeDirectory
      })
    ).toThrow()
    expect(readdirSync(missingOperation)).toEqual(['prepared'])
  })

  it('preserves current registries when commit fails', () => {
    const operationRoot = join(temporaryRoot, 'failed-commit-operation')
    const homeDirectory = join(temporaryRoot, 'failed-commit-home')
    const globalMetadata = seedGlobalManagedMetadata(
      homeDirectory,
      'e'
    )
    const prepared = packageInstaller.preparePackage({
      operationRoot,
      archive: packagePath,
      expectedSha256: packageResult.sha256,
      homeDirectory
    })
    const conflictingAgentDestination = join(
      homeDirectory,
      '.goodbuddy',
      'agent',
      'installations',
      prepared.agent.installationId
    )
    mkdirSync(dirname(conflictingAgentDestination), {
      recursive: true,
      mode: 0o700
    })
    writeFileSync(
      conflictingAgentDestination,
      'different'
    )

    expect(() =>
      packageInstaller.commitPackage({
        operationRoot,
        archive: packagePath,
        expectedSha256: packageResult.sha256,
        homeDirectory
      })
    ).toThrow('conflicting content')
    expectGlobalMetadataUnchanged(globalMetadata)
  })

  it.runIf(process.platform !== 'win32')(
    'rejects symbolic-link ancestors before publishing managed payloads',
    () => {
      const cases = [
        {
          name: 'managed-root',
          link(homeDirectory: string, linkTarget: string) {
            symlinkSync(
              linkTarget,
              join(homeDirectory, '.goodbuddy')
            )
          }
        },
        {
          name: 'agent-installations',
          link(homeDirectory: string, linkTarget: string) {
            const agentRoot = join(
              homeDirectory,
              '.goodbuddy',
              'agent'
            )
            mkdirSync(agentRoot, {
              recursive: true,
              mode: 0o700
            })
            symlinkSync(
              linkTarget,
              join(agentRoot, 'installations')
            )
          }
        },
        {
          name: 'runtime-root',
          link(homeDirectory: string, linkTarget: string) {
            const runtimes = join(
              homeDirectory,
              '.goodbuddy',
              'runtimes'
            )
            mkdirSync(runtimes, {
              recursive: true,
              mode: 0o700
            })
            symlinkSync(
              linkTarget,
              join(runtimes, 'opencode')
            )
          }
        }
      ]

      for (const fixture of cases) {
        const operationRoot = join(
          temporaryRoot,
          `symlink-${fixture.name}-operation`
        )
        const homeDirectory = join(
          temporaryRoot,
          `symlink-${fixture.name}-home`
        )
        const linkTarget = join(
          temporaryRoot,
          `symlink-${fixture.name}-target`
        )
        mkdirSync(homeDirectory, { mode: 0o700 })
        mkdirSync(linkTarget, { mode: 0o700 })
        fixture.link(homeDirectory, linkTarget)
        packageInstaller.preparePackage({
          operationRoot,
          archive: packagePath,
          expectedSha256: packageResult.sha256,
          homeDirectory
        })

        expect(() =>
          packageInstaller.commitPackage({
            operationRoot,
            archive: packagePath,
            expectedSha256: packageResult.sha256,
            homeDirectory
          })
        ).toThrow('Managed installation directory is unsafe')
        expect(readdirSync(linkTarget)).toEqual([])
      }
    }
  )

  it('replaces a conflicting managed digest directory during explicit repair', () => {
    const operationRoot = join(temporaryRoot, 'repair-commit-operation')
    const homeDirectory = join(temporaryRoot, 'repair-commit-home')
    const globalMetadata = seedGlobalManagedMetadata(
      homeDirectory,
      'f'
    )
    const prepared = packageInstaller.preparePackage({
      operationRoot,
      archive: packagePath,
      expectedSha256: packageResult.sha256,
      homeDirectory
    })
    const agentDestination = join(
      homeDirectory,
      '.goodbuddy',
      'agent',
      'installations',
      prepared.agent.installationId
    )
    mkdirSync(agentDestination, { recursive: true, mode: 0o700 })
    writeFileSync(
      join(agentDestination, 'conflicting-content'),
      'different'
    )

    expect(
      packageInstaller.commitPackage({
        operationRoot,
        archive: packagePath,
        expectedSha256: packageResult.sha256,
        homeDirectory
      })
    ).toMatchObject({
      status: 'committed',
      agent: prepared.agent,
      runtime: prepared.runtime
    })
    expect(
      readdirSync(agentDestination)
    ).not.toContain('conflicting-content')
    expect(
      readFileSync(join(agentDestination, 'manifest.json'))
    ).toBeTruthy()
    expectRegistriesUnchangedAndPackageTrustPublished(
      globalMetadata
    )
  })

  it('restores a replaced Agent directory when Runtime publication fails', () => {
    const operationRoot = join(temporaryRoot, 'repair-rollback-operation')
    const homeDirectory = join(temporaryRoot, 'repair-rollback-home')
    const prepared = packageInstaller.preparePackage({
      operationRoot,
      archive: packagePath,
      expectedSha256: packageResult.sha256,
      homeDirectory
    })
    const agentDestination = join(
      homeDirectory,
      '.goodbuddy',
      'agent',
      'installations',
      prepared.agent.installationId
    )
    mkdirSync(agentDestination, { recursive: true, mode: 0o700 })
    writeFileSync(join(agentDestination, 'old-marker'), 'old')
    const runtimeDestination = join(
      homeDirectory,
      '.goodbuddy',
      'runtimes',
      'opencode',
      prepared.runtime.bundleDigest.slice('sha256:'.length)
    )
    mkdirSync(dirname(runtimeDestination), {
      recursive: true,
      mode: 0o700
    })
    writeFileSync(runtimeDestination, 'unsafe destination type')

    expect(() =>
      packageInstaller.commitPackage({
        operationRoot,
        archive: packagePath,
        expectedSha256: packageResult.sha256,
        homeDirectory
      })
    ).toThrow('conflicting content')
    expect(readdirSync(agentDestination)).toEqual(['old-marker'])
  })

  it('publishes each Agent payload independently of existing installations', () => {
    const variantAgent = join(temporaryRoot, 'reuse-variant-agent')
    writeAgentBundle(variantAgent, 'x64')
    writeFileSync(
      join(variantAgent, 'lib', 'agent.cjs'),
      'module.exports={variant:true}\n'
    )
    signAgentBundleManifest(variantAgent, 'x64')
    const variantPath = join(
      temporaryRoot,
      'reuse-variant',
      agentPackageArchiveName(agentLock.agentVersion, 'x64')
    )
    mkdirSync(dirname(variantPath), { recursive: true })
    const variant = agentPackage.assembleAgentPackage({
      projectRoot: process.cwd(),
      architecture: 'x64',
      minimumDesktopVersion: '0.11.0',
      output: variantPath,
      agentBundle: variantAgent,
      runtimeBundle: findRuntimeBundleDirectory(),
      agentLock,
      runtimeLock: remoteRuntimeLock,
      registry,
      testSigningIdentity: {
        keyId: 'agent-package-fixture',
        privateKey
      }
    })
    const changedNodeAgent = join(temporaryRoot, 'reuse-changed-node-agent')
    writeAgentBundle(changedNodeAgent, 'x64')
    writeFileSync(
      join(changedNodeAgent, 'node'),
      Buffer.concat([elf('x64'), Buffer.from('different Node payload')])
    )
    chmodSync(join(changedNodeAgent, 'node'), 0o755)
    signAgentBundleManifest(changedNodeAgent, 'x64')
    const changedNodePath = join(
      temporaryRoot,
      'reuse-changed-node',
      agentPackageArchiveName(agentLock.agentVersion, 'x64')
    )
    mkdirSync(dirname(changedNodePath), { recursive: true })
    const changedNodeVariant = agentPackage.assembleAgentPackage({
      projectRoot: process.cwd(),
      architecture: 'x64',
      minimumDesktopVersion: '0.11.0',
      output: changedNodePath,
      agentBundle: changedNodeAgent,
      runtimeBundle: findRuntimeBundleDirectory(),
      agentLock,
      runtimeLock: remoteRuntimeLock,
      registry,
      testSigningIdentity: {
        keyId: 'agent-package-fixture',
        privateKey
      }
    })
    const prepareAndCommit = (
      options: Parameters<PackageInstallerModule['preparePackage']>[0]
    ) => {
      packageInstaller.preparePackage(options)
      return packageInstaller.commitPackage(options)
    }

    const installCurrent = (
      name: string
    ): {
      homeDirectory: string
      currentNode: string
      globalMetadata: Map<string, Buffer>
    } => {
      const homeDirectory = join(temporaryRoot, `reuse-${name}-home`)
      const globalMetadata = seedGlobalManagedMetadata(homeDirectory, 'b')
      const current = prepareAndCommit({
        operationRoot: join(temporaryRoot, `reuse-${name}-current-operation`),
        archive: packagePath,
        expectedSha256: packageResult.sha256,
        homeDirectory
      })
      const registryPath = join(
        homeDirectory,
        '.goodbuddy',
        'agent',
        'registry.json'
      )
      const registryBytes = Buffer.from(
        `${JSON.stringify({
          formatVersion: 1,
          current: {
            installationId: current.agent.installationId,
            agentVersion: current.agent.agentVersion,
            manifestSha256: current.agent.manifestSha256,
            arch: current.agent.architecture
          }
        }, null, 2)}\n`
      )
      writeFileSync(registryPath, registryBytes)
      globalMetadata.set(registryPath, registryBytes)
      return {
        homeDirectory,
        currentNode: join(
          homeDirectory,
          '.goodbuddy',
          'agent',
          'installations',
          current.agent.installationId,
          'node'
        ),
        globalMetadata
      }
    }
    const commitVariant = (name: string, homeDirectory: string) =>
      prepareAndCommit({
        operationRoot: join(temporaryRoot, `reuse-${name}-variant-operation`),
        archive: variantPath,
        expectedSha256: variant.sha256,
        homeDirectory
      })
    const installedVariantNode = (
      homeDirectory: string,
      installationId: string
    ) => join(
      homeDirectory,
      '.goodbuddy',
      'agent',
      'installations',
      installationId,
      'node'
    )

    const identical = installCurrent('identical')
    const identicalResult = commitVariant(
      'identical',
      identical.homeDirectory
    )
    expect(
      lstatSync(identical.currentNode).ino
    ).not.toBe(
      lstatSync(
        installedVariantNode(
          identical.homeDirectory,
          identicalResult.agent.installationId
        )
      ).ino
    )
    expectRegistriesUnchangedAndPackageTrustPublished(
      identical.globalMetadata
    )

    const changed = installCurrent('changed')
    const changedResult = prepareAndCommit({
      operationRoot: join(
        temporaryRoot,
        'reuse-changed-variant-operation'
      ),
      archive: changedNodePath,
      expectedSha256: changedNodeVariant.sha256,
      homeDirectory: changed.homeDirectory
    })
    expect(
      lstatSync(changed.currentNode).ino
    ).not.toBe(
      lstatSync(
        installedVariantNode(
          changed.homeDirectory,
          changedResult.agent.installationId
        )
      ).ino
    )
    expectRegistriesUnchangedAndPackageTrustPublished(
      changed.globalMetadata
    )

    const corrupt = installCurrent('corrupt')
    writeFileSync(corrupt.currentNode, Buffer.from('corrupt Node'))
    const corruptResult = commitVariant('corrupt', corrupt.homeDirectory)
    expect(
      lstatSync(corrupt.currentNode).ino
    ).not.toBe(
      lstatSync(
        installedVariantNode(
          corrupt.homeDirectory,
          corruptResult.agent.installationId
        )
      ).ino
    )
    expectRegistriesUnchangedAndPackageTrustPublished(
      corrupt.globalMetadata
    )

    const untrusted = installCurrent('untrusted')
    const currentRoot = dirname(untrusted.currentNode)
    const signaturePath = join(currentRoot, 'manifest.sig')
    const signature = readFileSync(signaturePath)
    signature[0] = signature[0] === 65 ? 66 : 65
    writeFileSync(signaturePath, signature)
    const untrustedResult = commitVariant('untrusted', untrusted.homeDirectory)
    expect(
      lstatSync(untrusted.currentNode).ino
    ).not.toBe(
      lstatSync(
        installedVariantNode(
          untrusted.homeDirectory,
          untrustedResult.agent.installationId
        )
      ).ino
    )
    expectRegistriesUnchangedAndPackageTrustPublished(
      untrusted.globalMetadata
    )
  })

  it('fails the remote installer closed on traversal, duplicates, corruption, and hash mismatch', () => {
    const run = (archive: string, expectedSha256?: string) =>
      packageInstaller.preparePackage({
        operationRoot: join(
          temporaryRoot,
          `rejected-${basename(archive)}`
        ),
        archive,
        expectedSha256:
          expectedSha256 ??
          createHash('sha256').update(readFileSync(archive)).digest('hex'),
        homeDirectory: join(temporaryRoot, 'rejected-home')
      })

    const traversal = join(temporaryRoot, 'installer-traversal.gbagent')
    writeFileSync(
      traversal,
      renameStoredZipEntry(
        readFileSync(packagePath),
        'agent/node',
        '../outside'
      )
    )
    expect(() => run(traversal)).toThrow(/unsafe|unordered/u)

    const duplicate = join(temporaryRoot, 'installer-duplicate.gbagent')
    const names = Object.keys(
      unzipSync(new Uint8Array(readFileSync(packagePath)))
    )
    const duplicatePair = names
      .flatMap((left) =>
        names.map((right) => [left, right] as const)
      )
      .find(
        ([left, right]) =>
          left !== right && Buffer.byteLength(left) === Buffer.byteLength(right)
      )
    expect(duplicatePair).toBeDefined()
    writeFileSync(
      duplicate,
      renameStoredZipEntry(
        readFileSync(packagePath),
        duplicatePair![0],
        duplicatePair![1]
      )
    )
    expect(() => run(duplicate)).toThrow(/duplicate|unordered/u)

    const corrupt = join(temporaryRoot, 'installer-corrupt.gbagent')
    const corruptBytes = corruptStoredZipEntry(
      readFileSync(packagePath),
      'agent/lib/agent.cjs'
    )
    writeFileSync(corrupt, corruptBytes)
    expect(() => run(corrupt)).toThrow(/checksum|digest|header/u)

    expect(() =>
      run(packagePath, '0'.repeat(64))
    ).toThrow('SHA-256 does not match')
  })

  it('rejects traversal, undeclared payload, and untrusted outer signatures', async () => {
    const traversal = join(temporaryRoot, 'traversal.gbagent')
    writeFileSync(
      traversal,
      Buffer.from(
        zipSync({
          '../escape': new Uint8Array([1])
        })
      )
    )
    await expect(
      extractAndVerifyAgentPackage({
        archivePath: traversal,
        destinationDirectory: join(
          temporaryRoot,
          'traversal-output'
        ),
        desktopVersion: '0.11.0',
        trustedRegistry: registry
      })
    ).rejects.toThrow('unsafe')

    const files = unzipSync(
      new Uint8Array(readFileSync(packagePath))
    )
    files['undeclared.txt'] = new Uint8Array([1])
    const undeclared = join(temporaryRoot, 'undeclared.gbagent')
    writeFileSync(undeclared, Buffer.from(zipSync(files)))
    await expect(
      extractAndVerifyAgentPackage({
        archivePath: undeclared,
        destinationDirectory: join(
          temporaryRoot,
          'undeclared-output'
        ),
        desktopVersion: '0.11.0',
        trustedRegistry: registry
      })
    ).rejects.toThrow('undeclared or missing')

    await expect(
      extractAndVerifyAgentPackage({
        archivePath: packagePath,
        destinationDirectory: join(
          temporaryRoot,
          'untrusted-output'
        ),
        desktopVersion: '0.11.0',
        trustedRegistry: {
          formatVersion: 1,
          keys: [],
          revocations: []
        }
      })
    ).rejects.toThrow('signing key is not trusted')
  })

  it('enforces desktop compatibility and descriptor-to-inner-bundle identity', async () => {
    await expect(
      extractAndVerifyAgentPackage({
        archivePath: packagePath,
        destinationDirectory: join(
          temporaryRoot,
          'old-desktop-output'
        ),
        desktopVersion: '0.10.9',
        trustedRegistry: registry
      })
    ).rejects.toThrow('not compatible')

    const files = unzipSync(
      new Uint8Array(readFileSync(packagePath))
    )
    const descriptor = agentPackageDescriptorSchema.parse(
      JSON.parse(
        Buffer.from(files['agent-package.json']!).toString('utf8')
      )
    )
    const mismatched = {
      ...descriptor,
      version:
        descriptor.version === '999.0.0'
          ? '999.0.1'
          : '999.0.0'
    }
    mismatched.contentDigest =
      agentPackage.descriptorContentDigest(mismatched)
    const descriptorBytes =
      agentPackage.descriptorBytes(mismatched)
    files['agent-package.json'] = new Uint8Array(descriptorBytes)
    files['agent-package.sig'] = new Uint8Array(
      Buffer.from(
        `${sign(
          null,
          Buffer.concat([
            agentPackage.signatureDomain,
            descriptorBytes
          ]),
          privateKey
        ).toString('base64')}\n`
      )
    )
    const mismatchPath = join(temporaryRoot, 'mismatch.gbagent')
    writeFileSync(mismatchPath, Buffer.from(zipSync(files)))
    await expect(
      extractAndVerifyAgentPackage({
        archivePath: mismatchPath,
        destinationDirectory: join(
          temporaryRoot,
          'mismatch-output'
        ),
        desktopVersion: '0.11.0',
        trustedRegistry: registry
      })
    ).rejects.toThrow('does not match its Agent bundle')
  })

  it('accepts a signed package whose key registry uses CRLF', async () => {
    const files = unzipSync(
      new Uint8Array(readFileSync(packagePath))
    )
    const registryBytes = Buffer.from(
      Buffer.from(files['agent-release-keys.json']!)
        .toString('utf8')
        .replace(/\n/gu, '\r\n')
    )
    files['agent-release-keys.json'] =
      new Uint8Array(registryBytes)
    const descriptor = agentPackageDescriptorSchema.parse(
      JSON.parse(
        Buffer.from(files['agent-package.json']!).toString('utf8')
      )
    )
    const updatedDescriptor = {
      ...descriptor,
      files: descriptor.files.map((file) =>
        file.path === 'agent-release-keys.json'
          ? {
              ...file,
              size: registryBytes.byteLength,
              sha256: createHash('sha256')
                .update(registryBytes)
                .digest('hex')
            }
          : file
      )
    }
    updatedDescriptor.contentDigest =
      agentPackage.descriptorContentDigest(updatedDescriptor)
    const descriptorBytes =
      agentPackage.descriptorBytes(updatedDescriptor)
    files['agent-package.json'] = new Uint8Array(descriptorBytes)
    files['agent-package.sig'] = new Uint8Array(
      Buffer.from(
        `${sign(
          null,
          Buffer.concat([
            agentPackage.signatureDomain,
            descriptorBytes
          ]),
          privateKey
        ).toString('base64')}\n`
      )
    )
    const crlfPath = join(
      temporaryRoot,
      'crlf-registry.gbagent'
    )
    writeFileSync(crlfPath, Buffer.from(zipSync(files)))

    await expect(
      extractAndVerifyAgentPackage({
        archivePath: crlfPath,
        destinationDirectory: join(
          temporaryRoot,
          'crlf-registry-output'
        ),
        desktopVersion: '0.11.0',
        trustedRegistry: registry
      })
    ).resolves.toMatchObject({
      descriptor: { architecture: 'x64' }
    })
  })

  it('orders SemVer prereleases and selects the latest compatible protocol', () => {
    expect(compareSemanticVersions('1.0.0-e2e.10', '1.0.0-e2e.9'))
      .toBeGreaterThan(0)
    expect(compareSemanticVersions('1.0.0', '1.0.0-rc.1'))
      .toBeGreaterThan(0)
    expect(compareSemanticVersions('1.0.0-1', '1.0.0-alpha'))
      .toBeLessThan(0)

    const compatible = catalogEntry(packageResult.descriptor, {
      version: '1.1.0',
      minimumDesktopVersion: '0.11.0'
    })
    const tooNew = catalogEntry(packageResult.descriptor, {
      version: '2.0.0',
      minimumDesktopVersion: '0.12.0'
    })
    const incompatibleProtocol = catalogEntry(
      packageResult.descriptor,
      {
        version: '3.0.0',
        minimumDesktopVersion: '0.11.0',
        agentProtocol: {
          ...packageResult.descriptor.agentProtocol,
          major:
            packageResult.descriptor.agentProtocol.major + 1
        }
      }
    )
    const catalog = agentPackageCatalogSchema.parse({
      formatVersion: 1,
      product: 'GoodBuddy',
      component: 'agent',
      signingKeyId: 'agent-package-fixture',
      generatedAt: '2026-08-24T00:00:00.000Z',
      entries: [tooNew, incompatibleProtocol, compatible]
    })
    expect(
      selectLatestCompatibleEntry(catalog, 'x64', '0.11.0')
        .version
    ).toBe('1.1.0')
  })

  it('builds and verifies a cumulative immutable dual-architecture catalog', () => {
    const firstRoot = join(temporaryRoot, 'catalog-first')
    const secondRoot = join(temporaryRoot, 'catalog-second')
    mkdirSync(firstRoot)
    mkdirSync(secondRoot)
    const firstCatalog = join(firstRoot, 'agent-catalog.json')
    const firstSignature = join(firstRoot, 'agent-catalog.sig')
    const result = agentCatalog.createCatalog({
      projectRoot: process.cwd(),
      x64Package: packagePath,
      arm64Package: arm64PackagePath,
      outputCatalog: firstCatalog,
      outputSignature: firstSignature,
      generatedAt: '2026-08-24T00:00:00.000Z',
      registry,
      signingIdentity: {
        keyId: 'agent-package-fixture',
        privateKey
      }
    })
    expect(result).toEqual({
      version: agentLock.agentVersion,
      catalog: 'agent-catalog.json',
      signature: 'agent-catalog.sig',
      entries: 2
    })
    const catalog = agentCatalog.readVerifiedCatalog(
      firstCatalog,
      firstSignature,
      registry
    )
    expect(catalog.entries.map((entry) => entry.architecture))
      .toEqual(['arm64', 'x64'])
    expect(catalog.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          architecture: 'x64',
          sha256: packageResult.sha256
        }),
        expect.objectContaining({
          architecture: 'arm64',
          sha256: arm64PackageResult.sha256
        })
      ])
    )
    const secondCatalog = join(secondRoot, 'agent-catalog.json')
    const secondSignature = join(secondRoot, 'agent-catalog.sig')
    agentCatalog.createCatalog({
      projectRoot: process.cwd(),
      x64Package: packagePath,
      arm64Package: arm64PackagePath,
      previousCatalog: firstCatalog,
      previousSignature: firstSignature,
      outputCatalog: secondCatalog,
      outputSignature: secondSignature,
      generatedAt: '2026-08-24T00:00:00.000Z',
      registry,
      signingIdentity: {
        keyId: 'agent-package-fixture',
        privateKey
      }
    })
    expect(readFileSync(secondCatalog)).toEqual(
      readFileSync(firstCatalog)
    )
    expect(readFileSync(secondSignature)).toEqual(
      readFileSync(firstSignature)
    )

    const changedRoot = join(temporaryRoot, 'changed-package')
    mkdirSync(changedRoot)
    const changedPath = join(
      changedRoot,
      agentPackageArchiveName(agentLock.agentVersion, 'x64')
    )
    const originalPackage = readFileSync(packagePath)
    const changedPackage = Buffer.concat([
      originalPackage,
      Buffer.from([0])
    ])
    changedPackage.writeUInt16LE(1, originalPackage.length - 2)
    writeFileSync(
      changedPath,
      changedPackage
    )
    expect(() =>
      agentCatalog.createCatalog({
        projectRoot: process.cwd(),
        x64Package: changedPath,
        arm64Package: arm64PackagePath,
        previousCatalog: firstCatalog,
        previousSignature: firstSignature,
        outputCatalog: join(
          temporaryRoot,
          'changed-catalog.json'
        ),
        outputSignature: join(
          temporaryRoot,
          'changed-catalog.sig'
        ),
        generatedAt: '2026-08-24T00:00:00.000Z',
        registry,
        signingIdentity: {
          keyId: 'agent-package-fixture',
          privateKey
        }
      })
    ).toThrow('identity is immutable')
  })

  it('verifies stored payload bytes that contain a ZIP descriptor signature', () => {
    expect(
      agentCatalog.readPackageMetadata(packagePath, registry)
    ).toMatchObject({
      descriptor: {
        architecture: 'x64'
      },
      size: packageResult.size,
      sha256: packageResult.sha256
    })
  })

  it('imports and exports a fully verified offline package atomically', async () => {
    const keyRegistryPath = join(
      temporaryRoot,
      'trusted-registry.json'
    )
    writeFileSync(
      keyRegistryPath,
      `${JSON.stringify(registry, null, 2)}\n`
    )
    const manager = new AgentPackageManager({
      userDataPath: join(temporaryRoot, 'user-data'),
      desktopVersion: '0.11.0',
      keyRegistryPath,
      getUpdateSource: vi.fn(async () => 'github' as const)
    })
    expect(
      (await manager.getInventory()).entries.find(
        (entry) => entry.architecture === 'x64'
      )
    ).toMatchObject({
      architecture: 'x64',
      state: 'not-downloaded'
    })
    const invalidArm64 = join(
      temporaryRoot,
      'user-data',
      'remote-components',
      'agent-packages',
      'linux-arm64',
      'broken'
    )
    mkdirSync(invalidArm64, { recursive: true })
    writeFileSync(join(invalidArm64, 'junk'), 'invalid')
    expect(
      (
        await manager.getInventory({ refresh: true })
      ).entries.find(
        (entry) => entry.architecture === 'arm64'
      )
    ).toMatchObject({
      architecture: 'arm64',
      state: 'invalid'
    })
    await manager.importArchive(packagePath)
    expect(
      (await manager.getInventory()).entries.find(
        (entry) => entry.architecture === 'x64'
      )
    ).toMatchObject({
      architecture: 'x64',
      state: 'verified',
      version: agentLock.agentVersion,
      remoteRuntimeVersion:
        remoteRuntimeLock.runtimes.opencode.version
    })

    const exported = join(temporaryRoot, 'offline-export.gbagent')
    writeFileSync(exported, 'previous')
    await manager.exportArchive('x64', exported)
    expect(readFileSync(exported)).toEqual(readFileSync(packagePath))
  })

  it.each(['github', 'mirror'] as const)(
    'checks the selected %s catalog without downloading until requested',
    async (source) => {
      const root = join(temporaryRoot, `online-${source}`)
      mkdirSync(root)
      const keyRegistryPath = join(root, 'registry.json')
      writeFileSync(
        keyRegistryPath,
        `${JSON.stringify(registry, null, 2)}\n`
          .replace(/\n/gu, '\r\n')
      )
      const catalog = signedCatalog()
      const requested: string[] = []
      const transport = vi.fn(async (input: string | URL) => {
        const url = input.toString()
        requested.push(url)
        if (url.includes('/releases?per_page=100')) {
          return jsonResponse([{
            tag_name: `agent-v${agentLock.agentVersion}`,
            draft: false,
            prerelease: false,
            assets: [
              {
                name: 'agent-catalog.json',
                browser_download_url:
                  'https://github.com/mesalogo/goodbuddy/releases/download/' +
                  `agent-v${agentLock.agentVersion}/agent-catalog.json`
              },
              {
                name: 'agent-catalog.sig',
                browser_download_url:
                  'https://github.com/mesalogo/goodbuddy/releases/download/' +
                  `agent-v${agentLock.agentVersion}/agent-catalog.sig`
              }
            ]
          }])
        }
        if (url.endsWith('/latest.json')) {
          return bytesResponse(mirrorPointer())
        }
        if (url.endsWith('/agent-catalog.json')) {
          return bytesResponse(catalog.bytes)
        }
        if (url.endsWith('/agent-catalog.sig')) {
          return bytesResponse(catalog.signature)
        }
        if (url.endsWith(packageResult.archive)) {
          return bytesResponse(readFileSync(packagePath))
        }
        return new Response(null, { status: 404 })
      })
      const manager = new AgentPackageManager({
        userDataPath: join(root, 'user-data'),
        desktopVersion: '0.11.0',
        keyRegistryPath,
        getUpdateSource: vi.fn(async () => source),
        fetch: transport as typeof fetch
      })

      await manager.getInventory()
      expect(requested).toEqual([])
      const snapshot = await manager.getSnapshot()
      expect(snapshot.catalog).toMatchObject({
        state: 'available',
        error: null
      })
      expect(
        snapshot.entries.find(
          (entry) => entry.architecture === 'x64'
        )
      ).toMatchObject({
        state: 'not-downloaded',
        latestVersion: agentLock.agentVersion,
        updateAvailable: false
      })
      expect(requested).toContain(
        source === 'github'
          ? 'https://api.github.com/repos/mesalogo/goodbuddy/releases?per_page=100'
          : 'https://goodbuddy.oss-cn-beijing.aliyuncs.com/agent-releases/latest.json'
      )
      expect(requested).not.toContain(
        source === 'github'
          ? packageEntry().downloads.github.url
          : packageEntry().downloads.mirror.url
      )
      await manager.download('x64')
      const installedSnapshot = await manager.getInventory()
      expect(
        installedSnapshot.entries.find(
          (entry) => entry.architecture === 'x64'
        )
      ).toMatchObject({
        state: 'verified',
        version: agentLock.agentVersion,
        latestVersion: agentLock.agentVersion,
        updateAvailable: false
      })
      await manager.download('x64')
      expect(requested).toContain(
        source === 'github'
          ? 'https://api.github.com/repos/mesalogo/goodbuddy/releases?per_page=100'
          : 'https://goodbuddy.oss-cn-beijing.aliyuncs.com/agent-releases/latest.json'
      )
      expect(requested).toContain(
        source === 'github'
          ? packageEntry().downloads.github.url
          : packageEntry().downloads.mirror.url
      )
      expect(
        requested.filter(
          (url) =>
            url === (
              source === 'github'
                ? packageEntry().downloads.github.url
                : packageEntry().downloads.mirror.url
            )
        )
      ).toHaveLength(1)
    }
  )

  it('rejects a catalog with an invalid signature before package download', async () => {
    const root = join(temporaryRoot, 'invalid-catalog')
    mkdirSync(root)
    const keyRegistryPath = join(root, 'registry.json')
    writeFileSync(
      keyRegistryPath,
      `${JSON.stringify(registry, null, 2)}\n`
    )
    const catalog = signedCatalog()
    let packageRequested = false
    const transport = vi.fn(async (input: string | URL) => {
      const url = input.toString()
      if (url.includes('/releases?per_page=100')) {
        return jsonResponse([{
          tag_name: `agent-v${agentLock.agentVersion}`,
          draft: false,
          prerelease: false,
          assets: [
            {
              name: 'agent-catalog.json',
              browser_download_url:
                'https://github.com/mesalogo/goodbuddy/releases/download/' +
                `agent-v${agentLock.agentVersion}/agent-catalog.json`
            },
            {
              name: 'agent-catalog.sig',
              browser_download_url:
                'https://github.com/mesalogo/goodbuddy/releases/download/' +
                `agent-v${agentLock.agentVersion}/agent-catalog.sig`
            }
          ]
        }])
      }
      if (url.endsWith('/agent-catalog.json')) {
        return bytesResponse(catalog.bytes)
      }
      if (url.endsWith('/agent-catalog.sig')) {
        return bytesResponse(Buffer.from('invalid\n'))
      }
      packageRequested = true
      return bytesResponse(readFileSync(packagePath))
    })
    const manager = new AgentPackageManager({
      userDataPath: join(root, 'user-data'),
      desktopVersion: '0.11.0',
      keyRegistryPath,
      getUpdateSource: vi.fn(async () => 'github' as const),
      fetch: transport as typeof fetch
    })

    await expect(manager.getSnapshot()).resolves.toMatchObject({
      catalog: {
        state: 'unavailable',
        error: 'Agent 发布目录签名校验失败'
      },
      entries: expect.any(Array)
    })
    expect(packageRequested).toBe(false)
    await expect(manager.download('x64')).rejects.toThrow(
      'Agent 发布目录签名校验失败'
    )
    expect(packageRequested).toBe(false)
  })

  it('rejects an online catalog rollback before package download', async () => {
    const root = join(temporaryRoot, 'rollback-catalog')
    mkdirSync(root)
    const keyRegistryPath = join(root, 'registry.json')
    writeFileSync(
      keyRegistryPath,
      `${JSON.stringify(registry, null, 2)}\n`
    )
    const rollback = signedCatalog([
      catalogEntry(packageResult.descriptor, {
        version: '0.11.1',
        minimumDesktopVersion: '0.11.0'
      })
    ])
    let packageRequested = false
    const transport = vi.fn(async (input: string | URL) => {
      const url = input.toString()
      if (url.includes('/releases?per_page=100')) {
        return jsonResponse([{
          tag_name: `agent-v${agentLock.agentVersion}`,
          draft: false,
          prerelease: false,
          assets: [
            {
              name: 'agent-catalog.json',
              browser_download_url:
                'https://github.com/mesalogo/goodbuddy/releases/download/' +
                `agent-v${agentLock.agentVersion}/agent-catalog.json`
            },
            {
              name: 'agent-catalog.sig',
              browser_download_url:
                'https://github.com/mesalogo/goodbuddy/releases/download/' +
                `agent-v${agentLock.agentVersion}/agent-catalog.sig`
            }
          ]
        }])
      }
      if (url.endsWith('/agent-catalog.json')) {
        return bytesResponse(rollback.bytes)
      }
      if (url.endsWith('/agent-catalog.sig')) {
        return bytesResponse(rollback.signature)
      }
      packageRequested = true
      return bytesResponse(readFileSync(packagePath))
    })
    const manager = new AgentPackageManager({
      userDataPath: join(root, 'user-data'),
      desktopVersion: '0.11.0',
      keyRegistryPath,
      getUpdateSource: vi.fn(async () => 'github' as const),
      fetch: transport as typeof fetch
    })
    await manager.importArchive(packagePath)

    await expect(manager.download('x64')).rejects.toThrow(
      'Agent 发布目录不能降级'
    )
    expect(packageRequested).toBe(false)
  })
})

function writeAgentBundle(
  directory: string,
  architecture: 'x64' | 'arm64'
): void {
  mkdirSync(join(directory, 'lib'), { recursive: true })
  mkdirSync(join(directory, 'licenses'), { recursive: true })
  mkdirSync(join(directory, 'helpers'), { recursive: true })
  writeFileSync(join(directory, 'node'), elf(architecture))
  writeFileSync(
    join(directory, 'goodbuddy-agent'),
    '#!/bin/sh\n'
  )
  writeFileSync(
    join(directory, 'lib', 'agent.cjs'),
    'module.exports={}\n'
  )
  writeFileSync(
    join(directory, 'helpers', 'fixture-helper'),
    '#!/bin/sh\n'
  )
  for (const [name, contents] of [
    ['GoodBuddy-0BSD.txt', '0BSD'],
    ['Node.js-MIT.txt', 'MIT'],
    ['zod-MIT.txt', 'MIT'],
    ['koffi-MIT.txt', 'MIT'],
    ['koffi-native-MIT.txt', 'MIT']
  ] as const) {
    writeFileSync(join(directory, 'licenses', name), contents)
  }
  writeKoffiPayload(directory, architecture)
  for (const path of [
    'node',
    'goodbuddy-agent',
    'helpers/fixture-helper'
  ]) {
    chmodSync(join(directory, path), 0o755)
  }
  signAgentBundleManifest(directory, architecture)
}

function signAgentBundleManifest(
  directory: string,
  architecture: 'x64' | 'arm64'
): void {
  const manifest = agentBundle.createManifest(directory, {
    agentVersion: agentLock.agentVersion,
    nodeVersion: agentLock.node.version,
    zodVersion: '4.4.3',
    koffiVersion: agentLock.koffi.version,
    koffiNativePackage:
      `@koromix/koffi-linux-${architecture}`,
    arch: architecture,
    protocol: agentLock.protocol,
    signingKeyId: 'agent-package-fixture'
  })
  const bytes = agentBundle.canonicalManifestBytes(manifest)
  writeFileSync(join(directory, 'manifest.json'), bytes)
  writeFileSync(
    join(directory, 'manifest.sig'),
    `${agentBundle
      .signManifestForTest(bytes, privateKey)
      .toString('base64')}\n`
  )
  chmodSync(join(directory, 'manifest.json'), 0o644)
  chmodSync(join(directory, 'manifest.sig'), 0o644)
}

function writeKoffiPayload(
  directory: string,
  architecture: 'x64' | 'arm64'
): void {
  const packageRoot = join(
    directory,
    'lib',
    'node_modules',
    'koffi'
  )
  const nativePackage = `@koromix/koffi-linux-${architecture}`
  const nativeRoot = join(
    directory,
    'lib',
    'node_modules',
    ...nativePackage.split('/')
  )
  mkdirSync(join(packageRoot, 'src', 'koffi', 'src'), {
    recursive: true
  })
  mkdirSync(join(nativeRoot, `linux_${architecture}`), {
    recursive: true
  })
  mkdirSync(join(nativeRoot, `musl_${architecture}`), {
    recursive: true
  })
  const files = new Map<string, string | Buffer>([
    [
      join(packageRoot, 'package.json'),
      JSON.stringify({
        name: 'koffi',
        version: agentLock.koffi.version,
        type: 'module',
        exports: { '.': { import: './index.js' } }
      })
    ],
    [
      join(packageRoot, 'index.js'),
      'export { default } from "./src/koffi/index.js";\n'
    ],
    [
      join(packageRoot, 'src', 'koffi', 'index.js'),
      'export default {};\n'
    ],
    [
      join(packageRoot, 'src', 'koffi', 'src', 'static.js'),
      'export function loadStatic() { return null }\n'
    ],
    [
      join(nativeRoot, 'package.json'),
      JSON.stringify({
        name: nativePackage,
        version: agentLock.koffi.version,
        main: './index.js',
        os: ['linux'],
        cpu: [architecture]
      })
    ],
    [
      join(nativeRoot, 'index.js'),
      `module.exports = require('./linux_${architecture}/koffi.node');\n`
    ],
    [
      join(nativeRoot, `linux_${architecture}`, 'koffi.node'),
      elf(architecture)
    ],
    [
      join(nativeRoot, `musl_${architecture}`, 'koffi.node'),
      elf(architecture)
    ]
  ])
  for (const [filePath, contents] of files) {
    writeFileSync(filePath, contents)
    chmodSync(filePath, 0o644)
  }
}

function createRuntimeInput(
  architecture: 'x64' | 'arm64'
): string {
  const sourceRoot = join(
    temporaryRoot,
    `runtime-input-${architecture}`
  )
  const packageRoot = join(sourceRoot, 'package')
  mkdirSync(join(packageRoot, 'bin'), { recursive: true })
  writeFileSync(
    join(packageRoot, 'package.json'),
    `${JSON.stringify({
      name:
        architecture === 'x64'
          ? 'opencode-linux-x64-baseline'
          : 'opencode-linux-arm64',
      version: '1.18.9'
    })}\n`
  )
  writeFileSync(
    join(packageRoot, 'bin', 'opencode'),
    Buffer.concat([
      elf(architecture),
      Buffer.from([0x50, 0x4b, 0x07, 0x08]),
      Buffer.from('runtime payload')
    ])
  )
  chmodSync(join(packageRoot, 'bin', 'opencode'), 0o755)
  const archive = join(
    temporaryRoot,
    architecture === 'x64'
      ? 'opencode-linux-x64-baseline-1.18.9.tgz'
      : 'opencode-linux-arm64-1.18.9.tgz'
  )
  createTar(
    {
      cwd: sourceRoot,
      file: archive,
      sync: true,
      portable: true,
      noPax: true,
      gzip: true,
      mtime: new Date(0)
    },
    ['package/package.json', 'package/bin/opencode']
  )
  return archive
}

function createRemoteRuntimeLock(
  runtimeArchive: string,
  arm64RuntimeArchive: string
): RemoteRuntimeLock {
  return {
    formatVersion: 1,
    runtimes: {
      opencode: {
        version: '1.18.9',
        provider: 'opencode',
        entrypoint: 'bin/opencode',
        entrypointIdentity: 'opencode-acp',
        argvPrefix: ['acp'],
        allowedEnvironmentNames: [
          'HOME',
          'LANG',
          'LC_ALL',
          'PATH',
          'TMPDIR',
          'XDG_CACHE_HOME',
          'XDG_CONFIG_HOME',
          'XDG_DATA_HOME',
          'XDG_STATE_HOME'
        ],
        protocol: { major: 1, minor: 0 },
        targets: {
          x64: {
            package: 'opencode-linux-x64-baseline',
            integrity: `sha512-${createHash('sha512')
              .update(readFileSync(runtimeArchive))
              .digest('base64')}`
          },
          arm64: {
            package: 'opencode-linux-arm64',
            integrity: `sha512-${createHash('sha512')
              .update(readFileSync(arm64RuntimeArchive))
              .digest('base64')}`
          }
        }
      }
    }
  }
}

function elf(architecture: 'x64' | 'arm64'): Buffer {
  const contents = Buffer.alloc(64)
  contents.set([0x7f, 0x45, 0x4c, 0x46])
  contents[5] = 1
  contents.writeUInt16LE(architecture === 'x64' ? 62 : 183, 18)
  return contents
}

function findRuntimeBundleDirectory(): string {
  const digest = packageResult.descriptor.remoteRuntime.bundleDigest
    .slice('sha256:'.length)
  return join(
    temporaryRoot,
    'runtime',
    'linux-x64',
    'opencode',
    digest
  )
}

function packageEntry(): AgentPackageCatalogEntry {
  return catalogEntry(packageResult.descriptor, {
    archive: packageResult.archive,
    size: packageResult.size,
    sha256: packageResult.sha256
  })
}

function catalogEntry(
  descriptor: AgentPackageDescriptor,
  overrides: Partial<AgentPackageCatalogEntry> = {}
): AgentPackageCatalogEntry {
  const {
    contentDigest: _contentDigest,
    files: _files,
    signingKeyId: _signingKeyId,
    ...identity
  } = descriptor
  void _contentDigest
  void _files
  void _signingKeyId
  const version = overrides.version ?? identity.version
  const architecture =
    overrides.architecture ?? identity.architecture
  const archive =
    overrides.archive ??
    agentPackageArchiveName(version, architecture)
  return {
    ...identity,
    ...overrides,
    version,
    architecture,
    archive,
    size: overrides.size ?? packageResult.size,
    sha256: overrides.sha256 ?? packageResult.sha256,
    downloads: overrides.downloads ?? {
      github: {
        url:
          'https://github.com/mesalogo/goodbuddy/releases/download/' +
          `agent-v${version}/${archive}`
      },
      mirror: {
        url:
          'https://goodbuddy.oss-cn-beijing.aliyuncs.com/' +
          `agent-releases/v${version}/${archive}`
      }
    }
  }
}

function signedCatalog(
  entries: AgentPackageCatalogEntry[] = [packageEntry()]
): {
  catalog: AgentPackageCatalog
  bytes: Buffer
  signature: Buffer
} {
  const catalog = agentPackageCatalogSchema.parse({
    formatVersion: 1,
    product: 'GoodBuddy',
    component: 'agent',
    signingKeyId: 'agent-package-fixture',
    generatedAt: '2026-08-24T00:00:00.000Z',
    entries
  })
  const bytes = Buffer.from(
    `${JSON.stringify(catalog, null, 2)}\n`
  )
  const signature = Buffer.from(
    `${sign(
      null,
      Buffer.concat([catalogSignatureDomain, bytes]),
      privateKey
    ).toString('base64')}\n`
  )
  return { catalog, bytes, signature }
}

function bytesResponse(bytes: Buffer): Response {
  return new Response(new Uint8Array(bytes), {
    status: 200,
    headers: {
      'content-length': String(bytes.byteLength)
    }
  })
}

function jsonResponse(value: unknown): Response {
  return bytesResponse(Buffer.from(JSON.stringify(value)))
}

function mirrorPointer(): Buffer {
  return Buffer.from(
    `${JSON.stringify({
      formatVersion: 1,
      version: agentLock.agentVersion,
      catalog:
        `v${agentLock.agentVersion}/agent-catalog.json`,
      signature:
        `v${agentLock.agentVersion}/agent-catalog.sig`
    }, null, 2)}\n`
  )
}

function renameStoredZipEntry(
  archive: Buffer,
  oldName: string,
  newName: string
): Buffer {
  const oldBytes = Buffer.from(oldName, 'utf8')
  const newBytes = Buffer.from(newName, 'utf8')
  if (oldBytes.length !== newBytes.length) {
    throw new Error('ZIP fixture names must have equal byte lengths')
  }
  const output = Buffer.from(archive)
  let replacements = 0
  for (let offset = 0; offset <= output.length - 46; offset += 1) {
    const signature = output.readUInt32LE(offset)
    const nameOffset =
      signature === 0x04034b50
        ? offset + 30
        : signature === 0x02014b50
          ? offset + 46
          : -1
    const lengthOffset =
      signature === 0x04034b50
        ? offset + 26
        : signature === 0x02014b50
          ? offset + 28
          : -1
    if (
      nameOffset >= 0 &&
      output.readUInt16LE(lengthOffset) === oldBytes.length &&
      output.subarray(nameOffset, nameOffset + oldBytes.length)
        .equals(oldBytes)
    ) {
      newBytes.copy(output, nameOffset)
      replacements += 1
    }
  }
  if (replacements !== 2) {
    throw new Error(
      `Expected local and central ZIP names, received ${replacements}`
    )
  }
  return output
}

function corruptStoredZipEntry(
  archive: Buffer,
  name: string
): Buffer {
  const output = Buffer.from(archive)
  const nameBytes = Buffer.from(name, 'utf8')
  for (let offset = 0; offset <= output.length - 30; offset += 1) {
    if (output.readUInt32LE(offset) !== 0x04034b50) {
      continue
    }
    const nameLength = output.readUInt16LE(offset + 26)
    const extraLength = output.readUInt16LE(offset + 28)
    if (
      nameLength === nameBytes.length &&
      output.subarray(offset + 30, offset + 30 + nameLength)
        .equals(nameBytes)
    ) {
      const dataOffset = offset + 30 + nameLength + extraLength
      output[dataOffset] = (output[dataOffset] ?? 0) ^ 1
      return output
    }
  }
  throw new Error(`ZIP fixture entry was not found: ${name}`)
}

function seedGlobalManagedMetadata(
  homeDirectory: string,
  digestCharacter: string
): Map<string, Buffer> {
  const managedRoot = join(homeDirectory, '.goodbuddy')
  const files = new Map<string, Buffer>([
    [
      join(managedRoot, 'agent', 'release-keys.json'),
      Buffer.from(`${JSON.stringify(registry, null, 4)}\r\n`)
    ],
    [
      join(managedRoot, 'agent', 'registry.json'),
      Buffer.from(
        `${JSON.stringify({
          formatVersion: 1,
          current: {
            installationId:
              `agent-${digestCharacter.repeat(64)}`,
            agentVersion: '0.10.0',
            manifestSha256: digestCharacter.repeat(64),
            arch: 'x64'
          }
        }, null, 4)}\r\n`
      )
    ],
    [
      join(managedRoot, 'runtimes', 'release-keys.json'),
      Buffer.from(`${JSON.stringify(registry, null, 3)}\r\n`)
    ],
    [
      join(
        managedRoot,
        'runtimes',
        'remote-runtime-lock.json'
      ),
      Buffer.from(`${JSON.stringify(remoteRuntimeLock, null, 3)}\r\n`)
    ],
    [
      join(managedRoot, 'runtimes', 'registry.json'),
      Buffer.from(
        `${JSON.stringify({
          formatVersion: 1,
          current: [{
            runtimeId: 'opencode',
            runtimeVersion: '1.0.0',
            architecture: 'x64',
            bundleDigest:
              `sha256:${digestCharacter.repeat(64)}`,
            manifestDigest: `sha256:${'1'.repeat(64)}`,
            acpCapabilitiesDigest: `sha256:${'2'.repeat(64)}`
          }]
        }, null, 4)}\r\n`
      )
    ]
  ])
  for (const [path, bytes] of files) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    writeFileSync(path, bytes, { mode: 0o600 })
  }
  return files
}

function expectGlobalMetadataUnchanged(
  files: ReadonlyMap<string, Buffer>
): void {
  for (const [path, bytes] of files) {
    expect(readFileSync(path)).toEqual(bytes)
  }
}

function expectRegistriesUnchangedAndPackageTrustPublished(
  files: ReadonlyMap<string, Buffer>
): void {
  for (const [path, bytes] of files) {
    if (path.endsWith('registry.json')) {
      expect(readFileSync(path)).toEqual(bytes)
      continue
    }
    const actual = JSON.parse(readFileSync(path, 'utf8'))
    expect(actual).toEqual(
      path.endsWith('remote-runtime-lock.json')
        ? remoteRuntimeLock
        : registry
    )
  }
}

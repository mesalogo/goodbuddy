import {
  createHash,
  createPrivateKey,
  sign,
  type KeyObject
} from 'node:crypto'
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
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

beforeAll(() => {
  temporaryRoot = resolve(
    mkdtempSync(join(tmpdir(), 'goodbuddy-agent-package-test-'))
  )
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
      for (const directory of [
        verified.rootDirectory,
        verified.agentBundle.bundleDirectory,
        verified.runtimeBundle.bundleDirectory
      ]) {
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
    const changedEntries = unzipSync(
      new Uint8Array(readFileSync(packagePath))
    )
    writeFileSync(
      changedPath,
      Buffer.from(zipSync(changedEntries, { level: 1 }))
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
    const loadedAgent = await manager.loadAgentBundle('x64')
    expect(loadedAgent).toMatchObject({
      bundle: {
        manifest: { agentVersion: agentLock.agentVersion }
      }
    })
    loadedAgent.release?.()
    const loadedRuntime = await manager.loadRuntimeBundle('x64')
    expect(loadedRuntime).toMatchObject({
      manifest: {
        runtimeVersion:
          remoteRuntimeLock.runtimes.opencode.version
      }
    })
    loadedRuntime.release?.()

    const exported = join(temporaryRoot, 'offline-export.gbagent')
    writeFileSync(exported, 'previous')
    await manager.exportArchive('x64', exported)
    expect(readFileSync(exported)).toEqual(readFileSync(packagePath))
  })

  it.each(['github', 'mirror'] as const)(
    'follows the selected %s source only after a manual download',
    async (source) => {
      const root = join(temporaryRoot, `online-${source}`)
      mkdirSync(root)
      const keyRegistryPath = join(root, 'registry.json')
      writeFileSync(
        keyRegistryPath,
        `${JSON.stringify(registry, null, 2)}\n`
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
  writeFileSync(join(directory, 'node'), elf(architecture))
  writeFileSync(
    join(directory, 'goodbuddy-agent'),
    '#!/bin/sh\n'
  )
  writeFileSync(
    join(directory, 'lib', 'agent.cjs'),
    'module.exports={}\n'
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
  for (const path of ['node', 'goodbuddy-agent']) {
    chmodSync(join(directory, path), 0o755)
  }
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
    elf(architecture)
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

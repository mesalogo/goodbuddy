import {
  createHash,
  generateKeyPairSync,
  sign
} from 'node:crypto'
import {
  mkdir,
  lstat,
  mkdtemp,
  readFile,
  rm,
  writeFile
} from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  agentPackageCatalogSchema,
  type AgentPackageCatalog
} from '../../shared/agent-package-contracts'
import {
  AgentPackageManager,
  type VerifiedRemoteAgentInstallCandidate
} from './agent-package-manager'

vi.mock('./agent-package-verifier', async (importOriginal) => {
  const actual = await importOriginal<
    typeof import('./agent-package-verifier')
  >()
  const node = Buffer.from('verified-node')
  const verified = (
    rootDirectory: string,
    version = '2.0.0'
  ) => ({
    rootDirectory,
    descriptor: {
      format: 'goodbuddy-agent-package',
      formatVersion: 1,
      product: 'GoodBuddy',
      component: 'agent',
      version,
      minimumDesktopVersion: '1.0.0',
      platform: 'linux',
      architecture: 'x64',
      agentProtocol: { major: 2, minor: 0 },
      remoteRuntime: {
        runtimeId: 'opencode',
        provider: 'opencode',
        version: '1.2.3',
        bundleDigest: `sha256:${'a'.repeat(64)}`,
        protocol: { major: 1, minor: 0 }
      },
      contentDigest: `sha256:${'b'.repeat(64)}`,
      signingKeyId: 'production-test',
      files: [{
        path: 'agent/node',
        size: node.byteLength,
        sha256: createHash('sha256').update(node).digest('hex'),
        mode: '0755'
      }]
    },
    agentBundle: {},
    runtimeBundle: {},
    runtimeMetadata: {}
  })
  return {
    ...actual,
    extractAndVerifyAgentPackage: vi.fn(
      async (options: {
        archivePath: string
        destinationDirectory: string
      }) => {
        const { readFile: readFixture } =
          await import('node:fs/promises')
        const archive = await readFixture(options.archivePath)
        const archiveVersion = archive.toString('utf8')
        const version =
          archiveVersion === '1.9.0' ||
          archiveVersion === '2.1.0'
            ? archiveVersion
            : '2.0.0'
        await mkdir(join(options.destinationDirectory, 'agent'), {
          recursive: true
        })
        await writeFile(
          join(options.destinationDirectory, 'agent', 'node'),
          node
        )
        await writeFile(
          join(options.destinationDirectory, '.mock-version'),
          version
        )
        return verified(
          options.destinationDirectory,
          version
        ) as never
      }
    ),
    verifyExtractedAgentPackage: vi.fn(
      async (options: { rootDirectory: string }) => {
        const { readFile: readFixture } =
          await import('node:fs/promises')
        const version = (
          await readFixture(
            join(options.rootDirectory, '.mock-version'),
            'utf8'
          )
        ).trim()
        return verified(options.rootDirectory, version) as never
      }
    )
  }
})

const MIRROR_ROOT =
  'https://goodbuddy.oss-cn-beijing.aliyuncs.com/agent-releases/'
const GITHUB_ROOT =
  'https://github.com/mesalogo/goodbuddy/releases/download/'
const SIGNATURE_DOMAIN = Buffer.from(
  'GoodBuddy Agent Package Catalog Signature v1\0',
  'utf8'
)
const SHA256 = 'a'.repeat(64)
const KEY_ID = 'production-test'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })
    )
  )
})

async function createFixture(
  source: 'mirror' | 'github',
  mutateCatalog?: (catalog: AgentPackageCatalog) => void,
  archiveBytes?: Buffer
) {
  const root = await mkdtemp(join(tmpdir(), 'goodbuddy-agent-catalog-'))
  temporaryDirectories.push(root)
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  const keyRegistryPath = join(root, 'registry.json')
  await writeFile(keyRegistryPath, JSON.stringify({
    formatVersion: 1,
    keys: [{
      keyId: KEY_ID,
      publicKeySpkiBase64: publicKey.export({
        format: 'der',
        type: 'spki'
      }).toString('base64'),
      environment: 'production'
    }],
    revocations: []
  }))

  const archive = 'goodbuddy-agent-2.0.0-linux-x64.gbagent'
  const catalog = agentPackageCatalogSchema.parse({
    formatVersion: 1,
    product: 'GoodBuddy',
    component: 'agent',
    signingKeyId: KEY_ID,
    generatedAt: '2026-01-01T00:00:00.000Z',
    entries: [{
      format: 'goodbuddy-agent-package',
      formatVersion: 1,
      product: 'GoodBuddy',
      component: 'agent',
      version: '2.0.0',
      minimumDesktopVersion: '1.0.0',
      platform: 'linux',
      architecture: 'x64',
      agentProtocol: { major: 2, minor: 0 },
      remoteRuntime: {
        runtimeId: 'opencode',
        provider: 'opencode',
        version: '1.2.3',
        bundleDigest: `sha256:${SHA256}`,
        protocol: { major: 1, minor: 0 }
      },
      archive,
      size: archiveBytes?.byteLength ?? 123,
      sha256: archiveBytes
        ? createHash('sha256').update(archiveBytes).digest('hex')
        : SHA256,
      downloads: {
        github: {
          url: `${GITHUB_ROOT}agent-v2.0.0/${archive}`
        },
        mirror: {
          url: `${MIRROR_ROOT}v2.0.0/${archive}`
        }
      }
    }]
  })
  mutateCatalog?.(catalog)
  const catalogBytes = Buffer.from(
    `${JSON.stringify(catalog, null, 2)}\n`
  )
  const signature = sign(
    null,
    Buffer.concat([SIGNATURE_DOMAIN, catalogBytes]),
    privateKey
  ).toString('base64')
  const pointer = Buffer.from(`${JSON.stringify({
    formatVersion: 1,
    version: '2.0.0',
    catalog: 'v2.0.0/agent-catalog.json',
    signature: 'v2.0.0/agent-catalog.sig'
  }, null, 2)}\n`)
  const releases = [{
    tag_name: 'agent-v2.0.0',
    draft: false,
    prerelease: false,
    assets: [
      {
        name: 'agent-catalog.json',
        browser_download_url:
          `${GITHUB_ROOT}agent-v2.0.0/agent-catalog.json`
      },
      {
        name: 'agent-catalog.sig',
        browser_download_url:
          `${GITHUB_ROOT}agent-v2.0.0/agent-catalog.sig`
      }
    ]
  }]

  const manager = (transport: typeof fetch) =>
    new AgentPackageManager({
      userDataPath: root,
      desktopVersion: '9.0.0',
      keyRegistryPath,
      getUpdateSource: async () => source,
      fetch: transport
    })
  return {
    root,
    archive,
    catalog,
    catalogBytes,
    signature,
    pointer,
    releases,
    archiveBytes,
    manager
  }
}

function response(
  body: string | Uint8Array | null,
  init: ResponseInit = {}
): Response {
  return new Response(body as never, init)
}

describe('AgentPackageManager remote install candidates', () => {
  it('removes interrupted manager-owned staging on startup', async () => {
    const fixture = await createFixture('mirror')
    const packageRoot = join(
      fixture.root,
      'remote-components',
      'agent-packages'
    )
    const stage = join(
      packageRoot,
      '.stage-linux-x64-00000000-0000-4000-8000-000000000001'
    )
    const backup = join(
      packageRoot,
      'linux-x64',
      '.backup-00000000-0000-4000-8000-000000000002'
    )
    const unrelated = join(packageRoot, '.keep')
    await Promise.all([
      mkdir(stage, { recursive: true }),
      mkdir(backup, { recursive: true }),
      mkdir(unrelated, { recursive: true })
    ])

    await fixture.manager(vi.fn<typeof fetch>()).getInventory()

    await expect(lstat(stage)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(lstat(backup)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(lstat(unrelated)).resolves.toMatchObject({})
  })

  it('downloads, verifies, publishes, and leases an exact install archive', async () => {
    const archiveBytes = Buffer.alloc(3 * 64 * 1024 + 11, 0x5a)
    const fixture = await createFixture(
      'mirror',
      undefined,
      archiveBytes
    )
    let archiveRequests = 0
    const transport = vi.fn<typeof fetch>(async (input) => {
      const url = input.toString()
      if (url.endsWith('latest.json')) {
        return response(fixture.pointer)
      }
      if (url.endsWith('agent-catalog.json')) {
        return response(fixture.catalogBytes)
      }
      if (url.endsWith('agent-catalog.sig')) {
        return response(fixture.signature)
      }
      if (url.endsWith(fixture.archive)) {
        archiveRequests += 1
        return response(archiveBytes, {
          headers: {
            'content-length': String(archiveBytes.byteLength)
          }
        })
      }
      throw new Error(`Unexpected URL ${url}`)
    })
    const entry = fixture.catalog.entries[0]!
    const expectedCandidate: VerifiedRemoteAgentInstallCandidate = {
      source: 'mirror',
      platform: 'linux',
      architecture: 'x64',
      version: entry.version,
      minimumDesktopVersion: entry.minimumDesktopVersion,
      agentProtocol: { ...entry.agentProtocol },
      remoteRuntime: {
        ...entry.remoteRuntime,
        protocol: { ...entry.remoteRuntime.protocol }
      },
      archive: entry.archive,
      size: entry.size,
      sha256: entry.sha256,
      urls: [entry.downloads.mirror.url]
    }

    const manager = fixture.manager(transport)
    const lease = await manager.acquireInstallArchive(
      'x64',
      expectedCandidate
    )
    expect(lease).toMatchObject({
      size: archiveBytes.byteLength,
      sha256: entry.sha256,
      nodeSize: Buffer.byteLength('verified-node'),
      nodeSha256: createHash('sha256')
        .update('verified-node')
        .digest('hex')
    })
    await expect(readFile(lease.path)).resolves.toEqual(archiveBytes)
    await expect(readFile(lease.nodePath)).resolves.toEqual(
      Buffer.from('verified-node')
    )
    expect(archiveRequests).toBe(1)

    const cachedLease = await manager.acquireInstallArchive(
      'x64',
      expectedCandidate
    )
    expect(cachedLease.path).toBe(lease.path)
    expect(archiveRequests).toBe(1)

    const importDirectory = await mkdtemp(
      join(tmpdir(), 'goodbuddy-agent-import-')
    )
    temporaryDirectories.push(importDirectory)
    const replacementArchive = join(
      importDirectory,
      'goodbuddy-agent-2.1.0-linux-x64.gbagent'
    )
    await writeFile(replacementArchive, '2.1.0')
    await manager.importArchive(replacementArchive)
    await expect(readFile(lease.path)).resolves.toEqual(archiveBytes)

    cachedLease.release()
    cachedLease.release()
    await expect(readFile(lease.path)).resolves.toEqual(archiveBytes)
    lease.release()
    lease.release()
    await vi.waitFor(async () => {
      await expect(readFile(lease.path)).rejects.toBeDefined()
    })
  })

  it('rejects a stale expected candidate before downloading an archive', async () => {
    const archiveBytes = Buffer.from('package')
    const fixture = await createFixture(
      'mirror',
      undefined,
      archiveBytes
    )
    const transport = vi.fn<typeof fetch>(async (input) => {
      const url = input.toString()
      if (url.endsWith('latest.json')) {
        return response(fixture.pointer)
      }
      if (url.endsWith('agent-catalog.json')) {
        return response(fixture.catalogBytes)
      }
      if (url.endsWith('agent-catalog.sig')) {
        return response(fixture.signature)
      }
      throw new Error(`Archive must not be requested: ${url}`)
    })
    const entry = fixture.catalog.entries[0]!

    await expect(
      fixture.manager(transport).acquireInstallArchive(
        'x64',
        {
          source: 'mirror',
          platform: 'linux',
          architecture: 'x64',
          version: entry.version,
          minimumDesktopVersion: entry.minimumDesktopVersion,
          agentProtocol: { ...entry.agentProtocol },
          remoteRuntime: {
            ...entry.remoteRuntime,
            protocol: { ...entry.remoteRuntime.protocol }
          },
          archive: entry.archive,
          size: entry.size + 1,
          sha256: entry.sha256,
          urls: [entry.downloads.mirror.url]
        }
      )
    ).rejects.toThrow('current signed catalog')
    expect(
      transport.mock.calls.some(([input]) =>
        input.toString().endsWith(fixture.archive)
      )
    ).toBe(false)
  })

  it('leases an imported or cached package without an online catalog', async () => {
    const archiveBytes = Buffer.from('offline-package')
    const fixture = await createFixture(
      'mirror',
      undefined,
      archiveBytes
    )
    const online = vi.fn<typeof fetch>(async (input) => {
      const url = input.toString()
      if (url.endsWith('latest.json')) {
        return response(fixture.pointer)
      }
      if (url.endsWith('agent-catalog.json')) {
        return response(fixture.catalogBytes)
      }
      if (url.endsWith('agent-catalog.sig')) {
        return response(fixture.signature)
      }
      if (url.endsWith(fixture.archive)) {
        return response(archiveBytes, {
          headers: {
            'content-length': String(archiveBytes.byteLength)
          }
        })
      }
      throw new Error(`Unexpected URL ${url}`)
    })
    const entry = fixture.catalog.entries[0]!
    const installed = await fixture.manager(online)
      .acquireInstallArchive('x64', {
        source: 'mirror',
        platform: 'linux',
        architecture: entry.architecture,
        version: entry.version,
        minimumDesktopVersion: entry.minimumDesktopVersion,
        agentProtocol: { ...entry.agentProtocol },
        remoteRuntime: {
          ...entry.remoteRuntime,
          protocol: { ...entry.remoteRuntime.protocol }
        },
        archive: entry.archive,
        size: entry.size,
        sha256: entry.sha256,
        urls: [entry.downloads.mirror.url]
      })
    installed.release()

    const offline = vi.fn<typeof fetch>(async () => {
      throw new Error('offline')
    })
    const lease = await fixture.manager(offline)
      .acquireGoodBuddyInstallArchive('x64')

    expect(offline).not.toHaveBeenCalled()
    expect(lease.candidate).toMatchObject({
      architecture: 'x64',
      version: entry.version,
      sha256: entry.sha256,
      urls: []
    })
    await expect(readFile(lease.path)).resolves.toEqual(archiveBytes)
    lease.release()
  })

  it('prefers a verified local package over an older available online catalog for GoodBuddy transfer', async () => {
    const fixture = await createFixture('mirror')
    const transport = vi.fn<typeof fetch>(async (input) => {
      const url = input.toString()
      if (url.endsWith('latest.json')) {
        return response(fixture.pointer)
      }
      if (url.endsWith('agent-catalog.json')) {
        return response(fixture.catalogBytes)
      }
      if (url.endsWith('agent-catalog.sig')) {
        return response(fixture.signature)
      }
      throw new Error(`Archive must not be requested: ${url}`)
    })
    const importDirectory = await mkdtemp(
      join(tmpdir(), 'goodbuddy-agent-local-newer-')
    )
    temporaryDirectories.push(importDirectory)
    const localArchive = join(
      importDirectory,
      'goodbuddy-agent-2.1.0-linux-x64.gbagent'
    )
    await writeFile(localArchive, '2.1.0')

    const manager = fixture.manager(transport)
    await manager.importArchive(localArchive)
    await manager.getSnapshot()
    const lease = await manager.acquireGoodBuddyInstallArchive('x64')

    expect(lease.candidate).toMatchObject({
      architecture: 'x64',
      version: '2.1.0',
      urls: []
    })
    expect(
      transport.mock.calls.some(([input]) =>
        input.toString().endsWith(fixture.archive)
      )
    ).toBe(false)
    await expect(readFile(lease.path)).resolves.toEqual(
      Buffer.from('2.1.0')
    )
    lease.release()
  })

  it('downloads a newer online package instead of transferring a stale local package', async () => {
    const onlineArchive = Buffer.from('online-2.0.0')
    const fixture = await createFixture(
      'mirror',
      undefined,
      onlineArchive
    )
    const entry = fixture.catalog.entries[0]!
    let archiveRequests = 0
    const transport = vi.fn<typeof fetch>(async (input) => {
      const url = input.toString()
      if (url.endsWith('latest.json')) {
        return response(fixture.pointer)
      }
      if (url.endsWith('agent-catalog.json')) {
        return response(fixture.catalogBytes)
      }
      if (url.endsWith('agent-catalog.sig')) {
        return response(fixture.signature)
      }
      if (url.endsWith(entry.archive)) {
        archiveRequests += 1
        return response(onlineArchive, {
          headers: {
            'content-length': String(onlineArchive.byteLength)
          }
        })
      }
      throw new Error(`Unexpected URL ${url}`)
    })
    const importDirectory = await mkdtemp(
      join(tmpdir(), 'goodbuddy-agent-local-stale-')
    )
    temporaryDirectories.push(importDirectory)
    const localArchive = join(
      importDirectory,
      'goodbuddy-agent-1.9.0-linux-x64.gbagent'
    )
    await writeFile(localArchive, '1.9.0')

    const manager = fixture.manager(transport)
    await manager.importArchive(localArchive)
    await manager.getSnapshot()
    const lease = await manager.acquireGoodBuddyInstallArchive('x64')

    expect(lease.candidate).toMatchObject({
      architecture: 'x64',
      version: '2.0.0',
      sha256: entry.sha256
    })
    expect(archiveRequests).toBe(1)
    await expect(readFile(lease.path)).resolves.toEqual(onlineArchive)
    lease.release()
  })

  it('propagates cancellation into an active archive download', async () => {
    const archiveBytes = Buffer.from('package')
    const fixture = await createFixture(
      'mirror',
      undefined,
      archiveBytes
    )
    const transport = vi.fn<typeof fetch>(async (input, init) => {
      const url = input.toString()
      if (url.endsWith('latest.json')) {
        return response(fixture.pointer)
      }
      if (url.endsWith('agent-catalog.json')) {
        return response(fixture.catalogBytes)
      }
      if (url.endsWith('agent-catalog.sig')) {
        return response(fixture.signature)
      }
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          'abort',
          () => reject(init.signal?.reason),
          { once: true }
        )
      })
    })
    const controller = new AbortController()
    const download = fixture.manager(transport).download(
      'x64',
      undefined,
      controller.signal
    )
    await vi.waitFor(() =>
      expect(
        transport.mock.calls.some(([input]) =>
          input.toString().endsWith(fixture.archive)
        )
      ).toBe(true)
    )

    controller.abort()
    await expect(download).rejects.toMatchObject({
      name: 'AbortError'
    })
  })

  it('returns a signed, compatible mirror candidate without a local package', async () => {
    const fixture = await createFixture('mirror')
    const transport = vi.fn<typeof fetch>(async (input, init) => {
      const url = input.toString()
      if (url === `${MIRROR_ROOT}latest.json`) {
        return response(fixture.pointer)
      }
      if (url === `${MIRROR_ROOT}v2.0.0/agent-catalog.json`) {
        return response(fixture.catalogBytes)
      }
      if (url === `${MIRROR_ROOT}v2.0.0/agent-catalog.sig`) {
        return response(fixture.signature)
      }
      expect(init?.method).toBe('HEAD')
      return response(null, {
        status: 200,
        headers: { 'content-length': '123' }
      })
    })

    const manager = fixture.manager(transport)
    await expect(
      manager.getRemoteEnvironmentCatalog('x64')
    ).resolves.toMatchObject({
      expected: {
        agent: { version: '2.0.0' },
        runtimes: [{
          runtimeId: 'opencode',
          provider: 'opencode',
          version: '1.2.3'
        }]
      },
      candidate: {
        source: 'mirror',
        architecture: 'x64',
        version: '2.0.0',
        minimumDesktopVersion: '1.0.0',
        agentProtocol: { major: 2, minor: 0 },
        remoteRuntime: { version: '1.2.3' },
        size: 123,
        sha256: SHA256,
        urls: [`${MIRROR_ROOT}v2.0.0/${fixture.archive}`]
      }
    })
    expect(
      transport.mock.calls.filter(([input]) =>
        input.toString().endsWith('/agent-catalog.json')
      )
    ).toHaveLength(1)
  })

  it('rejects a catalog whose signature does not match its canonical bytes', async () => {
    const fixture = await createFixture('mirror')
    const transport = vi.fn<typeof fetch>(async (input) => {
      const url = input.toString()
      if (url.endsWith('latest.json')) {
        return response(fixture.pointer)
      }
      if (url.endsWith('agent-catalog.json')) {
        return response(fixture.catalogBytes)
      }
      return response(Buffer.from('not-a-signature'))
    })

    await expect(
      fixture.manager(transport).getRemoteInstallCandidate('x64')
    ).rejects.toThrow('签名校验失败')
  })

  it('rejects mirror redirects even when they stay on the mirror host', async () => {
    const fixture = await createFixture('mirror')
    const transport = vi.fn<typeof fetch>(async (input) => {
      const url = input.toString()
      if (url.endsWith('latest.json')) {
        return response(fixture.pointer)
      }
      if (url.endsWith('agent-catalog.json')) {
        return response(fixture.catalogBytes)
      }
      if (url.endsWith('agent-catalog.sig')) {
        return response(fixture.signature)
      }
      return response(null, {
        status: 302,
        headers: { location: `${url}?redirected=1` }
      })
    })

    await expect(
      fixture.manager(transport).getRemoteInstallCandidate('x64')
    ).rejects.toThrow('镜像下载地址不允许重定向')
  })

  it('preserves a candidate source probe failure separately from package absence', async () => {
    const fixture = await createFixture('mirror')
    const transport = vi.fn<typeof fetch>(async (input) => {
      const url = input.toString()
      if (url.endsWith('latest.json')) {
        return response(fixture.pointer)
      }
      if (url.endsWith('agent-catalog.json')) {
        return response(fixture.catalogBytes)
      }
      if (url.endsWith('agent-catalog.sig')) {
        return response(fixture.signature)
      }
      return response(null, { status: 503 })
    })

    await expect(
      fixture.manager(transport).getRemoteEnvironmentCatalog('x64')
    ).resolves.toMatchObject({
      candidate: null,
      candidateFailure: {
        reason: 'probe-failed',
        source: 'mirror',
        packageSize: 123
      }
    })
  })

  it('records only the canonical GitHub URL and approved asset redirects', async () => {
    const fixture = await createFixture('github')
    const assetUrl =
      `https://release-assets.githubusercontent.com/download/${fixture.archive}`
    const transport = vi.fn<typeof fetch>(async (input, init) => {
      const url = input.toString()
      if (url.startsWith('https://api.github.com/')) {
        return response(JSON.stringify(fixture.releases))
      }
      if (url.endsWith('agent-catalog.json')) {
        return response(fixture.catalogBytes)
      }
      if (url.endsWith('agent-catalog.sig')) {
        return response(fixture.signature)
      }
      if (url.startsWith(GITHUB_ROOT)) {
        expect(init?.method).toBe('HEAD')
        return response(null, {
          status: 302,
          headers: { location: assetUrl }
        })
      }
      if (url === assetUrl) {
        return response(null, {
          status: 200,
          headers: { 'content-length': '123' }
        })
      }
      throw new Error(`Unexpected URL ${url}`)
    })

    const candidate = await fixture.manager(transport)
      .getRemoteInstallCandidate('x64')
    expect(candidate.urls).toEqual([
      `${GITHUB_ROOT}agent-v2.0.0/${fixture.archive}`,
      assetUrl
    ])
  })

  it('rejects GitHub redirects to unapproved hosts', async () => {
    const fixture = await createFixture('github')
    const transport = vi.fn<typeof fetch>(async (input) => {
      const url = input.toString()
      if (url.startsWith('https://api.github.com/')) {
        return response(JSON.stringify(fixture.releases))
      }
      if (url.endsWith('agent-catalog.json')) {
        return response(fixture.catalogBytes)
      }
      if (url.endsWith('agent-catalog.sig')) {
        return response(fixture.signature)
      }
      return response(null, {
        status: 302,
        headers: { location: 'https://example.com/package.gbagent' }
      })
    })

    await expect(
      fixture.manager(transport).getRemoteInstallCandidate('x64')
    ).rejects.toThrow('不受信任的主机')
  })

  it('returns and probes the highest compatible signed entry', async () => {
    const fixture = await createFixture('mirror')
    const transport = vi.fn<typeof fetch>(async (input, init) => {
      const url = input.toString()
      if (url.endsWith('latest.json')) {
        return response(fixture.pointer)
      }
      if (url.endsWith('agent-catalog.json')) {
        return response(fixture.catalogBytes)
      }
      if (url.endsWith('agent-catalog.sig')) {
        return response(fixture.signature)
      }
      expect(init?.method).toBe('HEAD')
      return response(null, {
        status: 200,
        headers: { 'content-length': '123' }
      })
    })

    await expect(
      fixture.manager(transport).getRemoteInstallCandidate('x64')
    ).resolves.toMatchObject({
      source: 'mirror',
      architecture: 'x64',
      version: '2.0.0',
      size: 123,
      sha256: SHA256,
      urls: [`${MIRROR_ROOT}v2.0.0/${fixture.archive}`]
    })
  })
})

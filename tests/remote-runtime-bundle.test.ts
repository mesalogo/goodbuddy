import {
  createHash,
  createPrivateKey,
  createPublicKey,
  type KeyObject
} from 'node:crypto'
import {
  chmodSync,
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
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it
} from 'vitest'
import type {
  AgentReleaseKeyRegistry
} from '../src/shared/agent-installation-contracts'
import {
  digestRemoteRuntimeBundleIdentity,
  type RemoteRuntimeBundleManifest,
  type RemoteRuntimeLock
} from '../src/shared/remote-runtime-launch-contracts'

type VerifiedBundle = {
  bundleDirectory: string
  manifest: RemoteRuntimeBundleManifest
  manifestDigest: string
}

type RemoteRuntimeBundleModule = {
  canonicalJson(value: unknown): string
  profileDigests: {
    adapter: string
    acp: string
  }
  buildRuntimeBundle(options: {
    projectRoot: string
    architecture: 'x64' | 'arm64'
    runtimeArchive: string
    outputRoot: string
    lock: RemoteRuntimeLock
    registry: AgentReleaseKeyRegistry
    testSigningIdentity?: {
      keyId: string
      privateKey: KeyObject
    }
    signingIdentity?: {
      keyId: string
      privateKey: KeyObject
    }
    enforceFilesystemMode?: boolean
  }): VerifiedBundle
  createRuntimeArchive(
    bundleDirectory: string,
    archivePath: string
  ): void
  importRuntimeArchive(
    archivePath: string,
    options: {
      projectRoot: string
      architecture: 'x64' | 'arm64'
      outputRoot: string
      lock: RemoteRuntimeLock
      registry: AgentReleaseKeyRegistry
      verificationEnvironment: 'test'
      enforceFilesystemMode?: boolean
    }
  ): VerifiedBundle
  preflightProductionSigningKey(options: {
    projectRoot: string
    environment: NodeJS.ProcessEnv
    registry: AgentReleaseKeyRegistry
  }): unknown
  verifyBundleDirectory(
    bundleDirectory: string,
    options: {
      projectRoot: string
      architecture: 'x64' | 'arm64'
      lock: RemoteRuntimeLock
      registry: AgentReleaseKeyRegistry
      verificationEnvironment: 'test'
      enforceFilesystemMode?: boolean
    }
  ): VerifiedBundle
}

const require = createRequire(import.meta.url)
const runtimeBundle = require(
  '../build/remote-runtime-bundle.cjs'
) as RemoteRuntimeBundleModule

let temporaryRoot = ''
let runtimeArchive = ''
let lock: RemoteRuntimeLock
let registry: AgentReleaseKeyRegistry
let privateKey: KeyObject

beforeEach(() => {
  temporaryRoot = resolve(
    mkdtempSync(join(tmpdir(), 'goodbuddy-runtime-build-'))
  )
  privateKey = createPrivateKey({
    key: Buffer.from(
      '302e020100300506032b657004220420202122232425262728292a2b2c2d2e2f303132333435363738393a3b3c3d3e3f',
      'hex'
    ),
    format: 'der',
    type: 'pkcs8'
  })
  registry = {
    formatVersion: 1,
    keys: [
      {
        keyId: 'runtime-fixture',
        publicKeySpkiBase64: createPublicKey(privateKey)
          .export({ format: 'der', type: 'spki' })
          .toString('base64'),
        environment: 'test'
      }
    ],
    revocations: []
  }
  runtimeArchive = createRuntimeInput()
  const integrity = `sha512-${createHash('sha512')
    .update(readFileSync(runtimeArchive))
    .digest('base64')}`
  lock = {
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
            integrity
          },
          arm64: {
            package: 'opencode-linux-arm64',
            integrity:
              'sha512-2IN4lLjhx2FICcMDnBsKgwrey0AvAM0SlNzzj7L71uakNxWvrhcqPYVpEhrEYUjIn+uQGMY5PjA+uupXigJE2A=='
          }
        }
      }
    }
  }
})

afterEach(() => {
  rmSync(temporaryRoot, { recursive: true, force: true })
})

describe('Remote Runtime bundle tooling', () => {
  it('pins the actual OpenCode 1.18.9 ACP capabilities', () => {
    const capabilities = {
      loadSession: true,
      mcpCapabilities: {
        http: true,
        sse: true
      },
      promptCapabilities: {
        embeddedContext: true,
        image: true
      },
      sessionCapabilities: {
        close: {},
        fork: {},
        list: {},
        resume: {}
      }
    }
    const digest = `sha256:${createHash('sha256')
      .update(
        runtimeBundle.canonicalJson({
          protocolVersion: 1,
          capabilities
        })
      )
      .digest('hex')}`

    expect(runtimeBundle.profileDigests.acp).toBe(digest)
  })

  it('builds a deterministic signed digest-addressed bundle', async () => {
    const first = build(join(temporaryRoot, 'first'))
    const second = build(join(temporaryRoot, 'second'))

    expect(first.manifest).toEqual(second.manifest)
    expect(first.manifest.bundleDigest).toBe(
      await digestRemoteRuntimeBundleIdentity(first.manifest)
    )
    expect(first.bundleDirectory).toMatch(
      new RegExp(
        `${first.manifest.bundleDigest.slice('sha256:'.length)}$`,
        'u'
      )
    )
    expect(first.manifest).toMatchObject({
      runtimeId: 'opencode',
      runtimeVersion: '1.18.9',
      architecture: 'x64',
      sourcePackage: {
        name: 'opencode-linux-x64-baseline',
        integrity:
          lock.runtimes.opencode.targets.x64.integrity
      },
      entrypoint: {
        identity: 'opencode-acp',
        path: 'bin/opencode',
        argvPrefix: ['acp']
      },
      formatVersion: 2,
      limits: {
        maximumPromptRuntimeMilliseconds: 10 * 60 * 1000,
        maximumPromptInputBytes: 16 * 1024 * 1024,
        maximumPromptOutputBytes: 8 * 1024 * 1024
      }
    })
    expect(first.manifest).not.toHaveProperty('quotas')
  })

  it('creates deterministic archives and imports only verified content', () => {
    const built = build(join(temporaryRoot, 'built'))
    const firstArchive = join(temporaryRoot, 'first.tar')
    const secondArchive = join(temporaryRoot, 'second.tar')
    runtimeBundle.createRuntimeArchive(
      built.bundleDirectory,
      firstArchive
    )
    runtimeBundle.createRuntimeArchive(
      built.bundleDirectory,
      secondArchive
    )
    expect(readFileSync(secondArchive)).toEqual(
      readFileSync(firstArchive)
    )

    const imported = runtimeBundle.importRuntimeArchive(
      firstArchive,
      {
        projectRoot: process.cwd(),
        architecture: 'x64',
        outputRoot: join(temporaryRoot, 'imported'),
        lock,
        registry,
        verificationEnvironment: 'test',
        enforceFilesystemMode: false
      }
    )
    expect(imported.manifest).toEqual(built.manifest)
  })

  it('rejects payload mutation and unregistered production signing', () => {
    const built = build(join(temporaryRoot, 'built'))
    writeFileSync(
      join(built.bundleDirectory, 'licenses', 'opencode-MIT.txt'),
      'tampered'
    )
    expect(() =>
      runtimeBundle.verifyBundleDirectory(built.bundleDirectory, {
        projectRoot: process.cwd(),
        architecture: 'x64',
        lock,
        registry,
        verificationEnvironment: 'test',
        enforceFilesystemMode: false
      })
    ).toThrow(/payload (?:size|hash) mismatch/iu)

    expect(() =>
      runtimeBundle.preflightProductionSigningKey({
        projectRoot: process.cwd(),
        environment: {},
        registry
      })
    ).toThrow(/signing key ID before building a release/iu)
  })

  it('preflights a registered production key without reading its private key', () => {
    const productionRegistry: AgentReleaseKeyRegistry = {
      ...registry,
      keys: registry.keys.map((key) => ({
        ...key,
        environment: 'production'
      }))
    }

    expect(
      runtimeBundle.preflightProductionSigningKey({
        projectRoot: process.cwd(),
        environment: {
          GOODBUDDY_SIGNING_KEY_ID:
            'runtime-fixture'
        },
        registry: productionRegistry
      })
    ).toMatchObject({
      keyId: 'runtime-fixture',
      environment: 'production'
    })
  })

  it('signs the bundled Runtime with the shared GoodBuddy identity', () => {
    const productionRegistry: AgentReleaseKeyRegistry = {
      ...registry,
      keys: registry.keys.map((key) => ({
        ...key,
        environment: 'production'
      }))
    }
    const built = runtimeBundle.buildRuntimeBundle({
      projectRoot: process.cwd(),
      architecture: 'x64',
      runtimeArchive,
      outputRoot: join(temporaryRoot, 'production'),
      lock,
      registry: productionRegistry,
      signingIdentity: {
        keyId: 'runtime-fixture',
        privateKey
      },
      enforceFilesystemMode: false
    })

    expect(built.manifest.signingKeyId).toBe('runtime-fixture')
  })
})

function build(outputRoot: string): VerifiedBundle {
  return runtimeBundle.buildRuntimeBundle({
    projectRoot: process.cwd(),
    architecture: 'x64',
    runtimeArchive,
    outputRoot,
    lock,
    registry,
    testSigningIdentity: {
      keyId: 'runtime-fixture',
      privateKey
    },
    enforceFilesystemMode: false
  })
}

function createRuntimeInput(): string {
  const packageRoot = join(temporaryRoot, 'source', 'package')
  mkdirSync(join(packageRoot, 'bin'), { recursive: true })
  writeFileSync(
    join(packageRoot, 'package.json'),
    `${JSON.stringify({
      name: 'opencode-linux-x64-baseline',
      version: '1.18.9'
    })}\n`
  )
  writeFileSync(
    join(packageRoot, 'bin', 'opencode'),
    elf('x64')
  )
  chmodSync(join(packageRoot, 'bin', 'opencode'), 0o755)
  const archive = join(
    temporaryRoot,
    'opencode-linux-x64-baseline-1.18.9.tgz'
  )
  createTar(
    {
      cwd: join(temporaryRoot, 'source'),
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

function elf(architecture: 'x64' | 'arm64'): Buffer {
  const contents = Buffer.alloc(64)
  contents.set([0x7f, 0x45, 0x4c, 0x46])
  contents[5] = 1
  contents.writeUInt16LE(architecture === 'x64' ? 62 : 183, 18)
  return contents
}

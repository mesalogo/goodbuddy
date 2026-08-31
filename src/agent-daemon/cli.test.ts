import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  AGENT_PROTOCOL_FAILURE_RECORD_NAME,
  AGENT_PROTOCOL_FAILURE_STDERR_PREFIX,
  AGENT_PROTOCOL_VERSION
} from '../shared/agent-protocol'
import {
  buildFixedAgentCliArgv,
  verifyAgentInstallationId
} from '../main/ssh/ssh-agent-command'
import {
  deriveManagedInstallationPaths,
  deriveManagedRuntimePaths,
  runAgentCli,
  type AgentCliDependencies,
  type ManagedInstallationPaths
} from './cli'
import { InstallationRegistry } from './installation-registry'
import {
  RegisteredAgentBundleError,
  type VerifiedInstalledAgentBundle
} from './installed-bundle-verifier'
import { RuntimeBundleRegistry } from './runtime-bundle-registry'
import type { VerifiedRuntimeBundle } from './runtime-bundle-verifier'
import type { RemoteRuntimeLock } from '../shared/remote-runtime-launch-contracts'
import { AgentDiagnosticLog } from './diagnostic-log'

const temporaryPaths: string[] = []

afterEach(() => {
  for (const path of temporaryPaths.splice(0)) {
    rmSync(path, { force: true, recursive: true })
  }
})

describe('Agent CLI fixed command contract', () => {
  it('accepts only the fixed model bridge helper argv', async () => {
    const runModelBridgeHelper = vi.fn(async () => 7)
    await expect(
      runAgentCli(
        [
          'model-bridge-helper',
          '--socket-path',
          '/private/bridge/model-bridge.sock',
          '--protocol',
          'openai-responses',
          '--model',
          'private-model',
          '--supports-image-input',
          'false',
          '--opencode-entrypoint',
          '/runtime/bin/opencode'
        ],
        { runModelBridgeHelper, io: cliIo() }
      )
    ).resolves.toBe(7)
    expect(runModelBridgeHelper).toHaveBeenCalledWith({
      socketPath: '/private/bridge/model-bridge.sock',
      protocol: 'openai-responses',
      model: 'private-model',
      supportsImageInput: false,
      opencodeEntrypoint: '/runtime/bin/opencode'
    })
    await expect(
      runAgentCli(
        [
          'model-bridge-helper',
          '--socket-path',
          '/private/bridge/model-bridge.sock',
          '--protocol',
          'openai-responses',
          '--model',
          'private-model',
          '--supports-image-input',
          'false',
          '--opencode-entrypoint',
          '/runtime/bin/opencode',
          '--api-key',
          'secret'
        ],
        { runModelBridgeHelper, io: cliIo() }
      )
    ).resolves.toBe(2)
    expect(runModelBridgeHelper).toHaveBeenCalledOnce()
  })

  it('starts the daemon from Host-managed registry evidence without full verification', async () => {
    const root = privateTemporaryDirectory()
    const paths: ManagedInstallationPaths = {
      executablePath: resolve(root, 'install-1', 'goodbuddy-agent'),
      stateDirectory: resolve(root, 'state'),
      socketPath: resolve(root, 'run', 'agent.sock')
    }
    const releaseKeyRegistry = {
      formatVersion: 1 as const,
      keys: [],
      revocations: []
    }
    const verified = verifiedInstallation(paths, 'install-1')
    const registry = new InstallationRegistry({
      storagePath: resolve(root, 'registry.json')
    })
    registry.stageCandidate(verified)
    const start = vi.fn(async () => undefined)
    const stop = vi.fn(async () => undefined)
    const createDaemon = vi.fn(() => ({
      start,
      stop,
      status: () => ({ daemonBootId: 'daemon-boot-1' })
    }))
    const recordCurrentDaemonReady = vi.fn(async () => undefined)
    const verifyInstallation = vi.fn(async () => verified)
    const loadRegisteredInstallation = vi.fn(async () => verified)
    const io = cliIo()

    const result = await runAgentCli(
        ['daemon', '--installation-id', 'install-1'],
        {
          installationPaths: () => paths,
          releaseKeyRegistry,
          installationRegistry: registry,
          verifyInstallation,
          loadRegisteredInstallation,
          peerIdentityProvider: {
            async getPeerIdentity() {
              return { uid: 1 }
            }
          },
          createDaemon:
            createDaemon as unknown as NonNullable<
              AgentCliDependencies['createDaemon']
            >,
          createLifecycle: (() => ({
            recordCurrentDaemonReady
          })) as unknown as NonNullable<
            AgentCliDependencies['createLifecycle']
          >,
          waitForShutdown: async () => undefined,
          io
        }
      )
    expect(result, io.error.read()?.toString()).toBe(0)
    expect(createDaemon).toHaveBeenCalledWith(
      expect.objectContaining({
        installationId: 'install-1',
        binaryDigest: verified.binaryDigest,
        agentVersion: verified.manifest.agentVersion,
        protocol: verified.manifest.protocol
      })
    )
    expect(start).toHaveBeenCalledOnce()
    expect(stop).toHaveBeenCalledOnce()
    expect(recordCurrentDaemonReady).toHaveBeenCalledWith(
      'daemon-boot-1'
    )
    expect(loadRegisteredInstallation).toHaveBeenCalledOnce()
    expect(verifyInstallation).not.toHaveBeenCalled()
  })

  it('dispatches generated doctor and lifecycle argv through the real parser', async () => {
    const installationId = verifyAgentInstallationId('install-1')
    const registryRoot = privateTemporaryDirectory()
    const installationPaths = {
      executablePath: resolve(registryRoot, 'agent', 'goodbuddy-agent'),
      stateDirectory: resolve(registryRoot, 'state', 'install-1'),
      socketPath: resolve(registryRoot, 'run', 'install-1.sock')
    }
    const installationRegistry = new InstallationRegistry({
      storagePath: resolve(registryRoot, 'registry.json')
    })
    const releaseKeyRegistry = {
      formatVersion: 1 as const,
      keys: [],
      revocations: []
    }
    const verified = verifiedInstallation(
      installationPaths,
      installationId
    )
    installationRegistry.stageCandidate(verified)
    const status = vi.fn(async () => ({ state: 'absent' as const }))
    const bootstrap = vi.fn(async () => ({
      state: 'ready' as const,
      installationId
    }))
    const verifyInstallation = vi.fn(async () => verified)
    const dependencies: AgentCliDependencies = {
      installationPaths: () => installationPaths,
      releaseKeyRegistry,
      installationRegistry,
      verifyInstallation,
      loadRegisteredInstallation: async () => verified,
      createLifecycle: (() => ({
        status,
        bootstrap
      })) as unknown as NonNullable<
        AgentCliDependencies['createLifecycle']
      >
    }
    const lifecycleIo = cliIo()
    expect(
      await runAgentCli(
        buildFixedAgentCliArgv(installationId, { kind: 'doctor' }),
        { ...dependencies, io: cliIo() }
      )
    ).toBe(0)
    const lifecycleResult = await runAgentCli(
        buildFixedAgentCliArgv(installationId, {
          kind: 'lifecycle',
          action: 'bootstrap'
        }),
        {
          ...dependencies,
          io: lifecycleIo
        }
      )
    expect(
      lifecycleResult,
      lifecycleIo.error.read()?.toString()
    ).toBe(0)
    expect(status).toHaveBeenCalledOnce()
    expect(bootstrap).toHaveBeenCalledOnce()
    expect(
      installationRegistry.snapshot().current?.installationId
    ).toBe(installationId)

    expect(
      await runAgentCli(
        buildFixedAgentCliArgv(installationId, {
          kind: 'lifecycle',
          action: 'adopt'
        }),
        { ...dependencies, io: cliIo() }
      )
    ).toBe(0)
    expect(verifyInstallation).toHaveBeenCalledOnce()
    expect(bootstrap).toHaveBeenCalledTimes(2)
  })

  it('exports only bounded diagnostics for a fixed installation ID as JSONL', async () => {
    const root = privateTemporaryDirectory()
    const stateDirectory = resolve(root, 'state', 'install-1')
    mkdirSync(stateDirectory, { recursive: true, mode: 0o700 })
    if (process.platform !== 'win32') {
      chmodSync(resolve(root, 'state'), 0o700)
      chmodSync(stateDirectory, 0o700)
    }
    const log = new AgentDiagnosticLog(stateDirectory, {
      pid: 42
    })
    log.record('daemon.ready', {
      daemonBootId: 'boot-1'
    })
    log.record('runtime.start.failed', {
      runtimeId: 'opencode',
      error: new Error('private Prompt and /private/path')
    })
    await log.flush()
    const io = cliIo()

    const result = await runAgentCli(
      ['diagnostics', '--installation-id', 'install-1'],
      {
        installationPaths: () => ({
          executablePath: resolve(root, 'agent', 'goodbuddy-agent'),
          stateDirectory,
          socketPath: resolve(root, 'run', 'agent.sock')
        }),
        io
      }
    )

    expect(result, io.error.read()?.toString()).toBe(0)
    const output = io.output.read()!.toString()
    expect(output).not.toContain('private Prompt')
    expect(output).not.toContain('/private/path')
    expect(
      output.trimEnd().split('\n').map((line) => JSON.parse(line))
    ).toEqual([
      expect.objectContaining({
        event: 'daemon.ready',
        daemonBootId: 'boot-1'
      }),
      expect.objectContaining({
        event: 'runtime.start.failed',
        runtimeId: 'opencode',
        error: { name: 'Error' }
      })
    ])
  })

  it('dispatches generated attach argv using only derived managed paths', async () => {
    const root = privateTemporaryDirectory()
    const paths: ManagedInstallationPaths = {
      executablePath: resolve(root, 'goodbuddy-agent'),
      stateDirectory: resolve(root, 'state'),
      socketPath: resolve(root, 'run', 'agent.sock')
    }
    mkdirSync(paths.stateDirectory, { mode: 0o700 })
    if (process.platform !== 'win32') {
      chmodSync(paths.stateDirectory, 0o700)
    }
    writeFileSync(
      resolve(paths.stateDirectory, 'installation-identity'),
      Buffer.alloc(32, 7),
      { mode: 0o600 }
    )
    const attach = vi.fn(async (options) => {
      const connectionId = 'connection-diagnostic'
      writeFileSync(
        resolve(
          paths.stateDirectory,
          AGENT_PROTOCOL_FAILURE_RECORD_NAME
        ),
        `${JSON.stringify({
          formatVersion: 1,
          connectionId,
          category: 'dispatch/process',
          createdAt: 1
        })}\n`,
        { mode: 0o600 }
      )
      options.onWelcome?.({
        type: 'goodbuddy-agent-welcome',
        protocol: AGENT_PROTOCOL_VERSION,
        connectionId,
        generation: 1,
        installationId: 'install-1',
        binaryDigest: `sha256:${'a'.repeat(64)}`,
        daemonBootId: 'boot-1',
        serverNonce: 'nonce-1'
      })
    })
    const installationId = verifyAgentInstallationId('install-1')
    const releaseKeyRegistry = {
      formatVersion: 1 as const,
      keys: [],
      revocations: []
    }
    const verified = verifiedInstallation(paths, installationId)
    const installationRegistry = new InstallationRegistry({
      storagePath: resolve(root, 'registry.json')
    })
    installationRegistry.stageCandidate(verified)
    const verifyInstallation = vi.fn(async () => verified)
    const loadRegisteredInstallation = vi.fn(async () => verified)
    const io = cliIo()

    const attachResult = await runAgentCli(
        buildFixedAgentCliArgv(installationId, { kind: 'attach' }),
        {
          attach,
          installationPaths: () => paths,
          releaseKeyRegistry,
          installationRegistry,
          verifyInstallation,
          loadRegisteredInstallation,
          io
        }
      )
    expect(attachResult).toBe(0)
    expect(io.error.read()?.toString()).toBe(
      `${AGENT_PROTOCOL_FAILURE_STDERR_PREFIX}dispatch/process\n`
    )
    expect(attach).toHaveBeenCalledWith(
      expect.objectContaining({
        socketPath: paths.socketPath,
        secret: Buffer.alloc(32, 7)
      })
    )
    expect(loadRegisteredInstallation).toHaveBeenCalledOnce()
    expect(verifyInstallation).not.toHaveBeenCalled()
  })

  it('emits a fixed repair diagnostic when registered attach metadata is invalid', async () => {
    const installationId = verifyAgentInstallationId('install-1')
    const root = privateTemporaryDirectory()
    const paths = {
      executablePath: resolve(root, 'agent', 'goodbuddy-agent'),
      stateDirectory: resolve(root, 'state', 'install-1'),
      socketPath: resolve(root, 'run', 'install-1.sock')
    }
    const verified = verifiedInstallation(paths, installationId)
    const installationRegistry = new InstallationRegistry({
      storagePath: resolve(root, 'registry.json')
    })
    installationRegistry.stageCandidate(verified)
    const io = cliIo()

    const result = await runAgentCli(
      buildFixedAgentCliArgv(installationId, { kind: 'attach' }),
      {
        installationPaths: () => paths,
        installationRegistry,
        loadRegisteredInstallation: vi.fn(async () => {
          throw new RegisteredAgentBundleError(
            'private installation detail'
          )
        }),
        io
      }
    )

    expect(result).toBe(2)
    expect(io.error.read()?.toString()).toBe(
      `${AGENT_PROTOCOL_FAILURE_STDERR_PREFIX}installation-repair-required\n`
    )
  })

  it('derives fixed Linux paths and rejects untrusted installation IDs', () => {
    expect(
      deriveManagedInstallationPaths('install-1', {
        platform: 'linux',
        homeDirectory: '/home/tester',
        uid: 1234
      })
    ).toEqual({
      executablePath:
        '/home/tester/.goodbuddy/agent/installations/install-1/goodbuddy-agent',
      stateDirectory: '/home/tester/.goodbuddy/state/install-1',
      socketPath:
        '/tmp/goodbuddy-1234-33847abc68e72629c30d/caab28ec6ec9597dfdd5bc3c2398a893.sock'
    })
    expect(() =>
      deriveManagedInstallationPaths('../escape', {
        platform: 'linux',
        homeDirectory: '/home/tester',
        uid: 1234
      })
    ).toThrow('installation ID')
    expect(() =>
      deriveManagedInstallationPaths('install-1', {
        platform: 'win32',
        homeDirectory: 'C:\\Users\\tester',
        uid: 1234
      })
    ).toThrow('current Linux UID')
  })

  it('rejects injected installation IDs before lifecycle dispatch', async () => {
    const createLifecycle = vi.fn()
    expect(
      await runAgentCli(
        [
          'stop',
          '--installation-id',
          'install; shutdown'
        ],
        { createLifecycle, io: cliIo() }
      )
    ).toBe(2)
    expect(createLifecycle).not.toHaveBeenCalled()
  })

  it('verifies and atomically registers the fixed Runtime activation', async () => {
    const root = privateTemporaryDirectory()
    const runtimeRoot = resolve(root, 'runtimes')
    const bundleDigest = `sha256:${'f'.repeat(64)}`
    const paths = {
      runtimeRoot,
      bundleDirectory: resolve(
        runtimeRoot,
        'opencode',
        bundleDigest.slice('sha256:'.length)
      ),
      releaseKeyRegistryPath: resolve(
        runtimeRoot,
        'release-keys.json'
      ),
      runtimeLockPath: resolve(
        runtimeRoot,
        'remote-runtime-lock.json'
      ),
      registryPath: resolve(runtimeRoot, 'registry.json')
    }
    const releaseKeyRegistry = {
      formatVersion: 1 as const,
      keys: [],
      revocations: []
    }
    const registry = new RuntimeBundleRegistry({
      runtimeRoot
    })
    const verifyRuntime = vi.fn(async () =>
      verifiedRuntime(paths.bundleDirectory, bundleDigest)
    )
    const io = cliIo()

    expect(
      await runAgentCli(
        buildFixedAgentCliArgv(
          verifyAgentInstallationId('install-1'),
          {
            kind: 'runtime-activate',
            runtimeId: 'opencode',
            bundleDigest,
            architecture: 'x64'
          }
        ),
        {
          runtimePaths: () => paths,
          runtimeReleaseKeyRegistry: releaseKeyRegistry,
          runtimeLock: {} as RemoteRuntimeLock,
          runtimeRegistry: registry,
          verifyRuntime,
          currentArchitecture: () => 'x64',
          io
        }
      )
    ).toBe(0)
    expect(verifyRuntime).toHaveBeenCalledWith(
      paths.bundleDirectory,
      expect.objectContaining({
        architecture: 'x64',
        verificationEnvironment: 'production'
      })
    )
    expect(registry.current('x64')).toEqual([
      expect.objectContaining({
        runtimeId: 'opencode',
        bundleDigest,
        architecture: 'x64'
      })
    ])
    expect(JSON.parse(io.output.read()!.toString())).toEqual({
      activated: true,
      runtimeId: 'opencode',
      bundleDigest,
      architecture: 'x64',
      runtimeVersion: '1.18.9'
    })

    expect(
      await runAgentCli(
        buildFixedAgentCliArgv(
          verifyAgentInstallationId('install-1'),
          {
            kind: 'runtime-activate',
            runtimeId: 'opencode',
            bundleDigest,
            architecture: 'x64',
            forceVerification: true
          }
        ),
        {
          runtimePaths: () => paths,
          runtimeReleaseKeyRegistry: releaseKeyRegistry,
          runtimeLock: {} as RemoteRuntimeLock,
          runtimeRegistry: registry,
          verifyRuntime,
          currentArchitecture: () => 'x64',
          io: cliIo()
        }
      )
    ).toBe(0)
    expect(verifyRuntime).toHaveBeenCalledTimes(2)
  })

  it('derives Runtime paths and rejects activation argv injection', async () => {
    const digest = `sha256:${'a'.repeat(64)}`
    expect(
      deriveManagedRuntimePaths('install-1', 'opencode', digest, {
        homeDirectory: '/home/tester'
      })
    ).toEqual({
      runtimeRoot: '/home/tester/.goodbuddy/runtimes',
      bundleDirectory:
        `/home/tester/.goodbuddy/runtimes/opencode/${'a'.repeat(64)}`,
      releaseKeyRegistryPath:
        '/home/tester/.goodbuddy/runtimes/release-keys.json',
      runtimeLockPath:
        '/home/tester/.goodbuddy/runtimes/remote-runtime-lock.json',
      registryPath:
        '/home/tester/.goodbuddy/runtimes/registry.json'
    })
    const verifyRuntime = vi.fn()
    expect(
      await runAgentCli(
        [
          'runtime',
          'activate',
          '--installation-id',
          'install-1',
          '--runtime-id',
          'opencode;id',
          '--bundle-digest',
          digest,
          '--architecture',
          'x64'
        ],
        { verifyRuntime, io: cliIo() }
      )
    ).toBe(2)
    expect(verifyRuntime).not.toHaveBeenCalled()
  })
})

function verifiedInstallation(
  paths: ManagedInstallationPaths,
  installationId: string
): VerifiedInstalledAgentBundle {
  const manifestSha256 = 'a'.repeat(64)
  return {
    installationId,
    installationDirectory: resolve(paths.executablePath, '..'),
    executablePath: paths.executablePath,
    manifestSha256,
    binaryDigest: `sha256:${manifestSha256}`,
    manifest: {
      formatVersion: 1,
      product: 'GoodBuddy',
      agentVersion: '0.11.0',
      platform: 'linux',
      arch: process.arch === 'arm64' ? 'arm64' : 'x64',
      protocol: { major: 1, minor: 0 },
      signingKeyId: 'test-key',
      entrypoint: {
        path: 'goodbuddy-agent',
        runtimePath: 'node',
        scriptPath: 'lib/agent.cjs'
      },
      files: [
        {
          path: 'goodbuddy-agent',
          size: 1,
          sha256: 'b'.repeat(64),
          mode: '0755'
        },
        {
          path: 'node',
          size: 1,
          sha256: 'c'.repeat(64),
          mode: '0755'
        },
        {
          path: 'lib/agent.cjs',
          size: 1,
          sha256: 'd'.repeat(64),
          mode: '0644'
        },
        {
          path: 'licenses/GoodBuddy-0BSD.txt',
          size: 1,
          sha256: 'e'.repeat(64),
          mode: '0644'
        }
      ],
      licenses: [
        {
          package: 'GoodBuddy',
          version: '0.11.0',
          spdx: '0BSD',
          path: 'licenses/GoodBuddy-0BSD.txt'
        }
      ]
    }
  }
}

function cliIo(): {
  input: PassThrough
  output: PassThrough
  error: PassThrough
} {
  return {
    input: new PassThrough(),
    output: new PassThrough(),
    error: new PassThrough()
  }
}

function privateTemporaryDirectory(): string {
  const path = mkdtempSync(join(tmpdir(), 'goodbuddy-cli-'))
  temporaryPaths.push(path)
  if (process.platform !== 'win32') {
    chmodSync(path, 0o700)
  }
  return resolve(path)
}

function verifiedRuntime(
  bundleDirectory: string,
  bundleDigest: string
): VerifiedRuntimeBundle {
  return {
    bundleDirectory,
    executablePath: resolve(bundleDirectory, 'bin', 'opencode'),
    manifestDigest: `sha256:${'e'.repeat(64)}`,
    manifest: {
      runtimeId: 'opencode',
      provider: 'opencode',
      runtimeVersion: '1.18.9',
      architecture: 'x64',
      signingKeyId: 'test-key',
      bundleDigest,
      acpCapabilitiesDigest: `sha256:${'d'.repeat(64)}`
    }
  } as VerifiedRuntimeBundle
}

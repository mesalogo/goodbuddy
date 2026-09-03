import {
  chmodSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ControllerRegistry } from './controller-registry'
import { EventJournal } from './event-journal'
import { RuntimeBundleRegistry } from './runtime-bundle-registry'
import {
  createRuntimeBundleTestFixture,
  TEST_REMOTE_RUNTIME_LOCK
} from './runtime-bundle-test-fixture'
import { verifyRuntimeBundle } from './runtime-bundle-verifier'
import {
  createProductionRuntimeProtocol,
  derivePrivateModelBridgeDirectory,
  derivePrivateRuntimeScratchDirectory
} from './runtime-composition'
import {
  MODEL_BRIDGE_BROKER_SOCKET_NAME
} from './model-bridge-broker'
import { WorkspaceRegistry } from './workspace-registry'

const temporaryPaths: string[] = []

afterEach(() => {
  vi.restoreAllMocks()
  for (const path of temporaryPaths.splice(0)) {
    rmSync(path, { recursive: true, force: true })
  }
})

describe('production Runtime composition', () => {
  it('loads Runtime metadata independently of Ask-only Host prerequisites', async () => {
    const fixture = await createRuntimeBundleTestFixture()
    const root = fixture.root
    temporaryPaths.push(root)
    const runtimeRoot = root
    const stateDirectory = resolve(root, 'state')
    mkdirSync(stateDirectory, { mode: 0o700 })
    const agentExecutablePath = resolve(root, 'goodbuddy-agent')
    writeFileSync(agentExecutablePath, 'agent', { mode: 0o755 })
    const reportError = vi.fn()
    const events = new EventJournal(resolve(root, 'events.sqlite'))
    const workspaces = new WorkspaceRegistry({
      controllers: new ControllerRegistry()
    })

    const protocol = await createProductionRuntimeProtocol({
      runtimeRoot,
      stateDirectory,
      architecture: 'x64',
      events,
      workspaces,
      outputSink: async () => {},
      blobSink: async () => {},
      agentExecutablePath,
      reportError,
      verificationEnvironment: 'test',
      filesystemPlatform: 'win32'
    })

    expect(Object.keys(protocol.methods)).toContain(
      'runtime/openAcpChannel'
    )
    await expect(protocol.runtimes()).resolves.toEqual([])
    expect(reportError).toHaveBeenCalledWith(
      expect.stringContaining('Runtime metadata'),
      expect.anything()
    )

    writeFileSync(
      resolve(runtimeRoot, 'release-keys.json'),
      `${JSON.stringify(fixture.registry, null, 2)}\n`,
      { mode: 0o600 }
    )
    writeFileSync(
      resolve(runtimeRoot, 'remote-runtime-lock.json'),
      `${JSON.stringify(TEST_REMOTE_RUNTIME_LOCK, null, 2)}\n`,
      { mode: 0o600 }
    )
    const verified = await verifyRuntimeBundle(
      fixture.bundleDirectory,
      {
        architecture: 'x64',
        releaseKeyRegistry: fixture.registry,
        runtimeLock: TEST_REMOTE_RUNTIME_LOCK,
        verificationEnvironment: 'test',
        filesystemPlatform: 'win32'
      }
    )
    new RuntimeBundleRegistry({ runtimeRoot }).register(verified)
    reportError.mockClear()

    await expect(protocol.runtimes()).resolves.toEqual([
      {
        runtimeId: 'opencode',
        version: '1.18.9',
        bundleDigest: fixture.manifest.bundleDigest,
        acpCapabilitiesDigest:
          fixture.manifest.acpCapabilitiesDigest,
        sessionLoad: true,
        sessionResume: true
      }
    ])
    expect(reportError).not.toHaveBeenCalled()

    writeFileSync(
      resolve(runtimeRoot, 'release-keys.json'),
      `${JSON.stringify({
        formatVersion: 1,
        keys: [],
        revocations: []
      }, null, 2)}\n`,
      { mode: 0o600 }
    )
    await expect(protocol.runtimes()).resolves.toHaveLength(1)
    expect(reportError).not.toHaveBeenCalled()

    await expect(protocol.dispose()).resolves.toBeUndefined()
    events.close()
  })

  it('composes all autonomous ACP methods when no Runtime is installed', async () => {
    const root = temporaryDirectory()
    const runtimeRoot = resolve(root, 'runtimes')
    const stateDirectory = resolve(root, 'state')
    mkdirSync(stateDirectory, { mode: 0o700 })
    const releaseKeyRegistry = {
      formatVersion: 1 as const,
      keys: [],
      revocations: []
    }
    const registry = new RuntimeBundleRegistry({
      runtimeRoot
    })
    const events = new EventJournal(resolve(root, 'events.sqlite'))
    const workspaces = new WorkspaceRegistry({
      controllers: new ControllerRegistry()
    })
    const protocol = await createProductionRuntimeProtocol({
      runtimeRoot,
      stateDirectory,
      architecture: 'x64',
      events,
      workspaces,
      outputSink: async () => {},
      releaseKeyRegistry,
      runtimeLock: {} as RemoteRuntimeLock,
      registry,
      verificationEnvironment: 'test',
      filesystemPlatform: 'win32'
    })

    expect(Object.keys(protocol!.methods).sort()).toEqual([
      'runtime/ackPromptTranscript',
      'runtime/attachPrompt',
      'runtime/closeAcpChannel',
      'runtime/completePrompt',
      'runtime/escalateCancellation',
      'runtime/getAcpCursors',
      'runtime/openAcpChannel',
      'runtime/pagePromptTranscript',
      'runtime/preparePrompt',
      'runtime/reconcilePrompt',
      'runtime/replayAcpChannel',
      'runtime/resumeAcpChannel',
      'runtime/startPrompt'
    ])
    await expect(protocol!.runtimes()).resolves.toEqual([])
    await expect(protocol!.dispose()).resolves.toBeUndefined()
    events.close()
  })

  it('derives private binding scratch only beneath Agent state', () => {
    const root = temporaryDirectory()
    const stateDirectory = resolve(root, 'state')
    mkdirSync(stateDirectory, { mode: 0o700 })
    const binding = {
      bindingId: 'binding-1',
      runtimeBundleDigest: `sha256:${'a'.repeat(64)}`,
      workspaceIdentity: 'workspace-1',
      controllerId: 'controller-1',
      controllerGeneration: 1
    }
    const first = derivePrivateRuntimeScratchDirectory(
      stateDirectory,
      binding
    )
    const second = derivePrivateRuntimeScratchDirectory(
      stateDirectory,
      binding
    )
    const other = derivePrivateRuntimeScratchDirectory(
      stateDirectory,
      { ...binding, bindingId: 'binding-2' }
    )
    const nextGeneration = derivePrivateRuntimeScratchDirectory(
      stateDirectory,
      {
        ...binding,
        controllerGeneration: 2,
        controllerId: 'controller-2'
      }
    )

    expect(first).toBe(second)
    expect(first).not.toBe(other)
    expect(nextGeneration).toBe(first)
    expect(first.startsWith(resolve(stateDirectory, 'runtime-scratch'))).toBe(
      true
    )
    expect(lstatSync(first).isDirectory()).toBe(true)
    if (process.platform !== 'win32') {
      expect(lstatSync(first).mode & 0o777).toBe(0o700)
    }
  })

  it('keeps the Linux model bridge endpoint within the Unix socket limit', () => {
    const root = temporaryDirectory()
    const stateDirectory = resolve(root, 'state')
    mkdirSync(stateDirectory, { mode: 0o700 })
    const bridgeDirectory = derivePrivateModelBridgeDirectory(
      stateDirectory,
      {
        bindingId: 'binding-1',
        runtimeBundleDigest: `sha256:${'a'.repeat(64)}`,
        workspaceIdentity: 'workspace-1'
      }
    )

    if (process.platform === 'linux') {
      temporaryPaths.push(bridgeDirectory)
      expect(
        Buffer.byteLength(
          join(
            bridgeDirectory,
            MODEL_BRIDGE_BROKER_SOCKET_NAME
          ),
          'utf8'
        )
      ).toBeLessThanOrEqual(107)
      expect(bridgeDirectory).toMatch(
        /^\/tmp\/goodbuddy-[0-9]+-[0-9a-f]{20}\/mb\/[0-9a-f]{32}$/u
      )
    } else {
      expect(
        bridgeDirectory.startsWith(
          resolve(stateDirectory, 'model-bridges')
        )
      ).toBe(true)
    }
  })
})

function temporaryDirectory(): string {
  const path = mkdtempSync(
    join(tmpdir(), 'goodbuddy-runtime-composition-')
  )
  temporaryPaths.push(path)
  if (process.platform !== 'win32') {
    chmodSync(path, 0o700)
  }
  return path
}

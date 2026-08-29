import { describe, expect, it, vi } from 'vitest'
import type { SshConnectionPoolTarget } from '../ssh/ssh-connection-pool'
import {
  SshRemotePackageCommitIndeterminateError,
  type SshRemotePackageIdentity
} from '../ssh/ssh-remote-package-bootstrap'
import type { StagedSftp } from '../ssh/bounded-sftp'
import type {
  AgentPackageArchiveLease,
  VerifiedRemoteAgentInstallCandidate
} from './agent-package-manager'
import { REMOTE_ENVIRONMENT_METADATA_PATHS } from './remote-environment-metadata'
import type {
  PendingRemoteEnvironmentOperation
} from './remote-environment-operation-store'
import { RemoteEnvironmentPreparer } from './remote-environment-preparer'
import {
  remoteHostRecoveryIdentityKey
} from './remote-host-target-identity'

const HOST_ID = 'host-1'
const SHA256 = 'a'.repeat(64)
const NODE_SHA256 = 'b'.repeat(64)

function target(
  overrides: Partial<SshConnectionPoolTarget> = {}
): SshConnectionPoolTarget {
  return {
    host: {
      id: HOST_ID,
      name: 'Builder',
      hostname: 'builder.example',
      port: 22,
      username: 'goodbuddy',
      authentication: 'password',
      password: 'secret',
      hostKey: {
        algorithm: 'ssh-ed25519',
        publicKeyBase64: 'a2V5',
        fingerprintSha256: `SHA256:${'b'.repeat(43)}`,
        generation: 2
      }
    },
    hostRevision: 3,
    hostKeyGeneration: 2,
    ...overrides
  }
}

const candidate: VerifiedRemoteAgentInstallCandidate = {
  source: 'mirror',
  platform: 'linux',
  architecture: 'x64',
  version: '2.0.0',
  minimumDesktopVersion: '1.0.0',
  agentProtocol: { major: 2, minor: 1 },
  remoteRuntime: {
    runtimeId: 'opencode',
    provider: 'opencode',
    version: '1.2.3',
    bundleDigest: `sha256:${'c'.repeat(64)}`,
    protocol: { major: 1, minor: 0 }
  },
  archive: 'goodbuddy-agent-2.0.0-linux-x64.gbagent',
  size: 123,
  sha256: SHA256,
  urls: [
    'https://goodbuddy.oss-cn-beijing.aliyuncs.com/agent-releases/v2.0.0/package.gbagent'
  ]
}

const identity: SshRemotePackageIdentity = {
  archiveSha256: SHA256,
  agent: {
    installationId: `agent-${'d'.repeat(64)}`,
    agentVersion: '2.0.0',
    manifestSha256: 'd'.repeat(64),
    binaryDigest: `sha256:${'e'.repeat(64)}`,
    platform: 'linux',
    architecture: 'x64',
    protocol: { major: 2, minor: 1 },
    supervisor: 'detached-on-demand'
  },
  runtime: {
    runtimeId: 'opencode',
    runtimeVersion: '1.2.3',
    bundleDigest: `sha256:${'c'.repeat(64)}`,
    manifestDigest: `sha256:${'f'.repeat(64)}`,
    runtimeAdapterDigest: `sha256:${'1'.repeat(64)}`,
    acpCapabilitiesDigest: `sha256:${'2'.repeat(64)}`,
    platform: 'linux',
    architecture: 'x64',
    protocol: { major: 1, minor: 0 }
  }
}

type FixtureOptions = {
  targets?: SshConnectionPoolTarget[]
  probeAvailable?: boolean
  prepare?: ReturnType<typeof vi.fn>
  prepareUploaded?: ReturnType<typeof vi.fn>
  commit?: ReturnType<typeof vi.fn>
  uploadFile?: ReturnType<typeof vi.fn>
  activateAgent?: ReturnType<typeof vi.fn>
  activateRuntime?: ReturnType<typeof vi.fn>
  metadataFiles?: Map<string, Buffer>
  metadataReplaceFailure?: Error
  pendingOperation?: PendingRemoteEnvironmentOperation
}

function missingPath(): Error & { code: string } {
  return Object.assign(new Error('missing'), { code: 'ENOENT' })
}

function metadataSftp(
  files: Map<string, Buffer>,
  calls: string[],
  replaceFailure?: Error
): StagedSftp {
  const temporary = new Map<string, Buffer>()
  return {
    stagingDirectory: '/home/goodbuddy',
    mkdir: vi.fn(),
    uploadFile: vi.fn(),
    writeFile: vi.fn(async (path: string, contents: Buffer) => {
      temporary.set(path, Buffer.from(contents))
    }),
    readFile: vi.fn(async (path: string) => {
      const contents = files.get(path) ?? temporary.get(path)
      if (!contents) throw missingPath()
      return Buffer.from(contents)
    }),
    lstat: vi.fn(async (path: string) => {
      const contents = files.get(path) ?? temporary.get(path)
      if (!contents) throw missingPath()
      return {
        type: 'file' as const,
        size: contents.byteLength,
        mode: 0o600,
        uid: 1000,
        gid: 1000,
        atime: 0,
        mtime: 0
      }
    }),
    stat: vi.fn(),
    chmod: vi.fn(),
    setExecutable: vi.fn(),
    rename: vi.fn(),
    replaceFile: vi.fn(async (source: string, destination: string) => {
      if (replaceFailure) throw replaceFailure
      const contents = temporary.get(source)
      if (!contents) throw missingPath()
      files.set(destination, contents)
      temporary.delete(source)
    }),
    unlink: vi.fn(async (path: string) => {
      if (!files.delete(path) && !temporary.delete(path)) {
        throw missingPath()
      }
    }),
    rmdir: vi.fn(),
    close: vi.fn(() => calls.push('close-metadata'))
  }
}

function fixture(options: FixtureOptions = {}) {
  const calls: string[] = []
  const targets = options.targets ?? [target()]
  let resolveIndex = 0
  const resolver = {
    resolve: vi.fn(async () => {
      calls.push('resolve')
      return targets[Math.min(resolveIndex++, targets.length - 1)]!
    })
  }
  const leaseIdentity = {
    hostId: targets[0]!.host.id,
    hostRevision: targets[0]!.hostRevision,
    hostKeyGeneration: targets[0]!.hostKeyGeneration,
    authenticationIdentity: '3'.repeat(64)
  }
  const metadataFiles = options.metadataFiles ?? new Map<string, Buffer>()
  const metadata = metadataSftp(
    metadataFiles,
    calls,
    options.metadataReplaceFailure
  )
  const uploadFile = options.uploadFile ?? vi.fn(async (
    path: string
  ) => {
    calls.push(`upload:${path}`)
  })
  const uploadSftp = {
    stagingDirectory: '/home/goodbuddy/.goodbuddy/install-operations/op',
    uploadFile,
    setExecutable: vi.fn(async () => {
      calls.push('executable')
    }),
    close: vi.fn(() => calls.push('close-upload'))
  }
  const regularRelease = vi.fn(() => calls.push('release-probe'))
  const stopCandidate = vi.fn(async () => {
    calls.push('stop-candidate')
  })
  const regularLease = {
    identity: leaseIdentity,
    isUsable: vi.fn(() => true),
    runAgentBootstrapProbe: vi.fn(async () => {
      calls.push('platform-probe')
      return {
        ready: true,
        platform: 'linux',
        architecture: 'x64',
        canonicalHomeDirectory: '/home/goodbuddy',
        uid: 1000,
        shell: '/bin/sh',
        procfs: 'ready'
      }
    }),
    openStagedSftp: vi.fn(async (root: string) => {
      if (root.includes('install-operations')) {
        calls.push('open-upload')
        return uploadSftp
      }
      calls.push('open-metadata')
      return metadata
    }),
    runAgentLifecycleAction: stopCandidate,
    release: regularRelease
  }
  const prepare = options.prepare ?? vi.fn(async (
    input: { operationId: string },
    prepareOptions: {
      onProgress?: (progress: { phase: 'downloading' | 'verifying' }) => void
    }
  ) => {
    calls.push('prepare')
    prepareOptions.onProgress?.({ phase: 'downloading' })
    prepareOptions.onProgress?.({ phase: 'verifying' })
    return {
      prepared: true,
      operationId: input.operationId,
      identity
    }
  })
  const prepareUploaded = options.prepareUploaded ?? vi.fn(async (
    input: { operationId: string }
  ) => {
    calls.push('prepare-uploaded')
    return {
      prepared: true,
      operationId: input.operationId,
      identity
    }
  })
  const commit = options.commit ?? vi.fn(async (
    input: { operationId: string }
  ) => {
    calls.push('commit')
    return {
      committed: true,
      operationId: input.operationId,
      identity: structuredClone(identity)
    }
  })
  const cleanup = vi.fn(async (operationId: string) => {
    calls.push('cleanup')
    return { cleaned: true, operationId }
  })
  const commitStatus = vi.fn(async (
    input: { operationId: string }
  ) => ({
    committed: true,
    operationId: input.operationId,
    identity
  }))
  const bootstrapRelease = vi.fn(() => calls.push('release-bootstrap'))
  const probe = vi.fn(async () => {
    calls.push('method-probe')
    return options.probeAvailable === false
      ? { available: false, reason: 'curl-unavailable' }
      : { available: true }
  })
  const createUploadStaging = vi.fn(async (
    input: { operationId: string }
  ) => {
    calls.push('create-upload-staging')
    const root =
      `/home/goodbuddy/.goodbuddy/install-operations/${input.operationId}`
    return {
      created: true,
      operationId: input.operationId,
      archivePath: `${root}/package.gbagent`,
      bootstrapNodePath: `${root}/bootstrap/agent/node`
    }
  })
  const bootstrapLease = {
    identity: { ...leaseIdentity },
    isUsable: vi.fn(() => true),
    probe,
    createUploadStaging,
    prepare,
    prepareUploaded,
    commit,
    commitStatus,
    cleanup,
    release: bootstrapRelease
  }
  const archiveRelease = vi.fn(() => calls.push('release-archive'))
  const archive: AgentPackageArchiveLease = {
    candidate,
    path: 'C:/cache/package.gbagent',
    size: candidate.size,
    sha256: candidate.sha256,
    nodePath: 'C:/cache/node',
    nodeSize: 42,
    nodeSha256: NODE_SHA256,
    release: archiveRelease
  }
  const acquireInstallArchive = vi.fn(async () => {
    calls.push('acquire-archive')
    return archive
  })
  const acquireGoodBuddyInstallArchive = vi.fn(async () => {
    calls.push('acquire-archive')
    return archive
  })
  const activateAgent = options.activateAgent ?? vi.fn(async () => {
    calls.push('agent')
    return identity.agent
  })
  const activateRuntime = options.activateRuntime ?? vi.fn(async () => {
    calls.push('runtime')
  })
  let pendingOperation = options.pendingOperation
  const operationStore = {
    load: vi.fn(async () => pendingOperation),
    save: vi.fn(async (
      operation: PendingRemoteEnvironmentOperation
    ) => {
      calls.push('save-operation')
      pendingOperation = operation
    }),
    remove: vi.fn(async () => {
      calls.push('remove-operation')
      pendingOperation = undefined
    })
  }
  const preparer = new RemoteEnvironmentPreparer({
    resolver,
    sshPool: {
      acquire: vi.fn(async () => {
        calls.push('acquire-probe')
        return regularLease as never
      }),
      acquireRemotePackageBootstrap: vi.fn(async () => {
        calls.push('acquire-bootstrap')
        return bootstrapLease as never
      })
    },
    agentPackageManager: {
      getRemoteInstallCandidate: vi.fn(async () => {
        calls.push('candidate')
        return candidate
      }),
      acquireInstallArchive,
      acquireGoodBuddyInstallArchive
    },
    agentInstallationManager: {
      activatePublished: activateAgent
    } as never,
    runtimeInstallationManager: {
      activatePublished: activateRuntime
    } as never,
    operationStore
  })
  return {
    preparer,
    calls,
    resolver,
    regularLease,
    bootstrapLease,
    metadata,
    metadataFiles,
    uploadFile,
    probe,
    createUploadStaging,
    prepare,
    prepareUploaded,
    commit,
    cleanup,
    activateAgent,
    activateRuntime,
    acquireInstallArchive,
    archiveRelease,
    regularRelease,
    bootstrapRelease,
    stopCandidate,
    commitStatus,
    operationStore
  }
}

describe('RemoteEnvironmentPreparer', () => {
  it('runs the remote compound graph in order, verifies identity, cleans explicitly, and emits the resolved method', async () => {
    const value = fixture()
    const progress: Array<{ method: string; phase: string }> = []
    const controller = new AbortController()

    await value.preparer.prepare(
      HOST_ID,
      'remote-download',
      (event) => progress.push(event),
      controller.signal
    )

    expect(value.calls).toEqual([
      'resolve',
      'acquire-probe',
      'platform-probe',
      'candidate',
      'resolve',
      'acquire-bootstrap',
      'save-operation',
      'prepare',
      'open-metadata',
      'resolve',
      'commit',
      'resolve',
      'agent',
      'resolve',
      'runtime',
      'resolve',
      'cleanup',
      'remove-operation',
      'close-metadata',
      'release-bootstrap',
      'release-probe'
    ])
    const remoteCandidate = value.prepare.mock.calls[0]?.[0]
    expect(remoteCandidate).toMatchObject({
      urls: candidate.urls,
      size: candidate.size,
      sha256: candidate.sha256
    })
    expect(remoteCandidate.operationId).toMatch(/^[0-9a-f-]{36}$/u)
    expect(value.commit.mock.calls[0]?.[0]).toEqual(remoteCandidate)
    expect(value.activateAgent).toHaveBeenCalledWith(
      HOST_ID,
      identity.agent,
      expect.objectContaining({ signal: controller.signal })
    )
    expect(value.activateRuntime).toHaveBeenCalledWith(
      HOST_ID,
      identity.runtime,
      expect.objectContaining({
        agentInstallationId: identity.agent.installationId,
        signal: controller.signal
      })
    )
    expect(value.cleanup).toHaveBeenCalledWith(
      remoteCandidate.operationId,
      { signal: controller.signal }
    )
    expect(value.operationStore.save).toHaveBeenCalledOnce()
    expect(value.operationStore.remove).toHaveBeenCalledOnce()
    expect(progress.some((event) =>
      event.method === 'remote-download' &&
      event.phase === 'downloading'
    )).toBe(true)
    expect(progress.every((event) =>
      event.method === 'remote-download'
    )).toBe(true)
  })

  it('GoodBuddy uploads only the compound archive and bootstrap node, releases the archive, and never invokes remote acquisition', async () => {
    const value = fixture()

    await value.preparer.prepare(
      HOST_ID,
      'goodbuddy-transfer',
      undefined,
      new AbortController().signal
    )

    expect(value.probe).not.toHaveBeenCalled()
    expect(value.prepare).not.toHaveBeenCalled()
    expect(value.createUploadStaging).toHaveBeenCalledOnce()
    expect(value.uploadFile.mock.calls.map((call) => call[0])).toEqual([
      'package.gbagent',
      'bootstrap/agent/node'
    ])
    expect(value.prepareUploaded).toHaveBeenCalledOnce()
    expect(value.archiveRelease).toHaveBeenCalledOnce()
  })

  it('releases the archive and cleans the operation when a GoodBuddy upload fails', async () => {
    const uploadFailure = new Error('upload failed')
    const value = fixture({
      uploadFile: vi.fn(async () => {
        throw uploadFailure
      })
    })

    await expect(value.preparer.prepare(
      HOST_ID,
      'goodbuddy-transfer',
      undefined,
      new AbortController().signal
    )).rejects.toBe(uploadFailure)
    expect(value.cleanup).toHaveBeenCalledOnce()
    expect(value.prepareUploaded).not.toHaveBeenCalled()
    expect(value.archiveRelease).toHaveBeenCalledOnce()
  })

  it.each([
    {
      available: true,
      expectedPrepare: 1,
      expectedUpload: 0,
      resolved: 'remote-download'
    },
    {
      available: false,
      expectedPrepare: 0,
      expectedUpload: 2,
      resolved: 'goodbuddy-transfer'
    }
  ] as const)('auto resolves an availability result to $resolved', async ({
    available,
    expectedPrepare,
    expectedUpload,
    resolved
  }) => {
    const value = fixture({ probeAvailable: available })
    const methods: string[] = []

    await value.preparer.prepare(
      HOST_ID,
      'auto',
      (event) => methods.push(event.method),
      new AbortController().signal
    )

    expect(value.probe).toHaveBeenCalledOnce()
    expect(value.prepare).toHaveBeenCalledTimes(expectedPrepare)
    expect(value.uploadFile).toHaveBeenCalledTimes(expectedUpload)
    expect(methods).toContain(resolved)
  })

  it('does not cross acquisition methods after auto selected remote download', async () => {
    const value = fixture({
      probeAvailable: true,
      prepare: vi.fn(async () => ({
        prepared: false,
        unavailable: true,
        reason: 'curl-unavailable'
      }))
    })

    await expect(value.preparer.prepare(
      HOST_ID,
      'auto',
      undefined,
      new AbortController().signal
    )).rejects.toThrow('不可用')
    expect(value.acquireInstallArchive).not.toHaveBeenCalled()
    expect(value.createUploadStaging).not.toHaveBeenCalled()
    expect(value.cleanup).toHaveBeenCalledOnce()
  })

  it.each([
    {
      label: 'prepared operation',
      prepare: vi.fn(async () => ({
        prepared: true,
        operationId: 'wrong-operation',
        identity
      })),
      commit: undefined,
      message: '准备操作身份不匹配'
    },
    {
      label: 'prepared package',
      prepare: vi.fn(async (input: { operationId: string }) => ({
        prepared: true,
        operationId: input.operationId,
        identity: { ...identity, archiveSha256: '9'.repeat(64) }
      })),
      commit: undefined,
      message: '签名候选不匹配'
    },
    {
      label: 'committed identity',
      prepare: undefined,
      commit: vi.fn(async (input: { operationId: string }) => ({
        committed: true,
        operationId: input.operationId,
        identity: {
          ...identity,
          runtime: {
            ...identity.runtime,
            runtimeVersion: 'different'
          }
        }
      })),
      message: '提交身份与准备身份不匹配'
    }
  ])('rejects a $label mismatch and cleans staging', async ({
    prepare,
    commit,
    message
  }) => {
    const value = fixture({ prepare, commit })

    await expect(value.preparer.prepare(
      HOST_ID,
      'remote-download',
      undefined,
      new AbortController().signal
    )).rejects.toThrow(message)
    expect(value.cleanup).toHaveBeenCalledOnce()
    expect(value.activateAgent).not.toHaveBeenCalled()
  })

  it('rejects a Host identity change immediately before commit and cleans staging', async () => {
    const value = fixture({
      targets: [target(), target(), target({ hostRevision: 4 })]
    })

    await expect(value.preparer.prepare(
      HOST_ID,
      'remote-download',
      undefined,
      new AbortController().signal
    )).rejects.toThrow('身份')
    expect(value.commit).not.toHaveBeenCalled()
    expect(value.cleanup).toHaveBeenCalledOnce()
  })

  it('cleans deterministic cancellation and commit failures', async () => {
    const controller = new AbortController()
    const value = fixture({
      prepare: vi.fn(async () => {
        controller.abort(new DOMException('cancelled', 'AbortError'))
        throw controller.signal.reason
      })
    })
    await expect(value.preparer.prepare(
      HOST_ID,
      'remote-download',
      undefined,
      controller.signal
    )).rejects.toMatchObject({ name: 'AbortError' })
    expect(value.cleanup).toHaveBeenCalledOnce()

    const failed = fixture({
      commit: vi.fn(async () => ({
        committed: false,
        reason: 'installer-failed'
      }))
    })
    await expect(failed.preparer.prepare(
      HOST_ID,
      'remote-download',
      undefined,
      new AbortController().signal
    )).rejects.toThrow('提交失败')
    expect(failed.cleanup).toHaveBeenCalledOnce()
  })

  it('does not clean or adopt after an indeterminate commit', async () => {
    const value = fixture({
      commit: vi.fn(async () => {
        throw new SshRemotePackageCommitIndeterminateError()
      })
    })

    await expect(value.preparer.prepare(
      HOST_ID,
      'remote-download',
      undefined,
      new AbortController().signal
    )).rejects.toBeInstanceOf(SshRemotePackageCommitIndeterminateError)
    expect(value.cleanup).not.toHaveBeenCalled()
    expect(value.operationStore.save).toHaveBeenCalledOnce()
    expect(value.operationStore.remove).not.toHaveBeenCalled()
    expect(value.activateAgent).not.toHaveBeenCalled()
    expect(value.activateRuntime).not.toHaveBeenCalled()
  })

  it('keeps rollback-incomplete commits recoverable without cleanup', async () => {
    const value = fixture({
      commit: vi.fn(async () => ({
        committed: false,
        reason: 'installer-rollback-incomplete'
      }))
    })

    await expect(value.preparer.prepare(
      HOST_ID,
      'remote-download',
      undefined,
      new AbortController().signal
    )).rejects.toBeInstanceOf(
      SshRemotePackageCommitIndeterminateError
    )
    expect(value.cleanup).not.toHaveBeenCalled()
    expect(value.operationStore.remove).not.toHaveBeenCalled()
  })

  it('reconciles and cleans a pending commit before starting new work', async () => {
    const pendingOperationId =
      '00000000-0000-4000-8000-000000000777'
    const originalTarget = target()
    const renamedTarget = target({
      host: {
        ...originalTarget.host,
        name: 'Renamed builder'
      },
      hostRevision: 99
    })
    const value = fixture({
      targets: [renamedTarget],
      pendingOperation: {
        version: 1,
        hostId: HOST_ID,
        targetIdentity:
          remoteHostRecoveryIdentityKey(originalTarget),
        operationId: pendingOperationId,
        size: candidate.size,
        sha256: candidate.sha256,
        urls: candidate.urls
      }
    })

    await value.preparer.prepare(
      HOST_ID,
      'remote-download',
      undefined,
      new AbortController().signal
    )

    expect(value.commitStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        operationId: pendingOperationId
      }),
      expect.any(Object)
    )
    expect(value.cleanup.mock.calls[0]?.[0]).toBe(
      pendingOperationId
    )
    expect(value.prepare).toHaveBeenCalledOnce()
    expect(value.operationStore.remove).toHaveBeenCalledTimes(2)
  })

  it('retains pending recovery evidence when the real SSH target changes', async () => {
    const originalTarget = target()
    const changedTarget = target({
      host: {
        ...originalTarget.host,
        hostname: 'different.example'
      }
    })
    const value = fixture({
      targets: [changedTarget],
      pendingOperation: {
        version: 1,
        hostId: HOST_ID,
        targetIdentity:
          remoteHostRecoveryIdentityKey(originalTarget),
        operationId:
          '00000000-0000-4000-8000-000000000778',
        size: candidate.size,
        sha256: candidate.sha256,
        urls: candidate.urls
      }
    })

    await expect(value.preparer.prepare(
      HOST_ID,
      'remote-download',
      undefined,
      new AbortController().signal
    )).rejects.toBeInstanceOf(
      SshRemotePackageCommitIndeterminateError
    )
    expect(value.commitStatus).not.toHaveBeenCalled()
    expect(value.operationStore.remove).not.toHaveBeenCalled()
  })

  it('stops the committed Agent and restores all five metadata files when Runtime adoption fails', async () => {
    const originals = new Map<string, Buffer>()
    for (const [index, path] of REMOTE_ENVIRONMENT_METADATA_PATHS.entries()) {
      if (index !== 2) originals.set(path, Buffer.from(`original-${index}`))
    }
    const files = new Map(
      [...originals].map(([path, contents]) => [path, Buffer.from(contents)])
    )
    const runtimeFailure = new Error('runtime health failed')
    const value = fixture({
      metadataFiles: files,
      activateAgent: vi.fn(async () => {
        value.metadataFiles.clear()
        for (const path of REMOTE_ENVIRONMENT_METADATA_PATHS) {
          value.metadataFiles.set(path, Buffer.from('new'))
        }
        return identity.agent
        value.calls.push('agent')
      }),
      activateRuntime: vi.fn(async () => {
        throw runtimeFailure
      })
    })

    await expect(value.preparer.prepare(
      HOST_ID,
      'remote-download',
      undefined,
      new AbortController().signal
    )).rejects.toBe(runtimeFailure)
    expect(value.stopCandidate).toHaveBeenCalledWith(
      identity.agent.installationId,
      'stop'
    )
    expect([...value.metadataFiles]).toEqual([...originals])
    expect(value.cleanup).toHaveBeenCalledOnce()
  })

  it('throws AggregateError when adoption and metadata rollback both fail', async () => {
    const path = REMOTE_ENVIRONMENT_METADATA_PATHS[0]
    const files = new Map([[path, Buffer.from('original')]])
    const runtimeFailure = new Error('runtime failed')
    const rollbackFailure = new Error('replace failed')
    const value = fixture({
      metadataFiles: files,
      metadataReplaceFailure: rollbackFailure,
      activateAgent: vi.fn(async () => {
        files.set(path, Buffer.from('changed'))
        return identity.agent
      }),
      activateRuntime: vi.fn(async () => {
        throw runtimeFailure
      })
    })

    const caught = await value.preparer.prepare(
      HOST_ID,
      'remote-download',
      undefined,
      new AbortController().signal
    ).catch((error: unknown) => error)
    expect(caught).toBeInstanceOf(AggregateError)
    expect((caught as AggregateError).errors[0]).toBe(runtimeFailure)
    expect((caught as AggregateError).errors[1]).toBeInstanceOf(
      AggregateError
    )
    expect(value.stopCandidate).toHaveBeenCalledOnce()
  })
})

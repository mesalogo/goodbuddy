import { describe, expect, it, vi } from 'vitest'
import type {
  RemoteWorkspaceHandle,
  RemoteWorkspaceListRequest
} from '../../shared/remote-agent-contracts'
import {
  RemoteWorkspaceAccess,
  type RemoteWorkspaceProjectBinding,
  type RemoteWorkspaceTransport,
  type RemoteWorkspaceTransportLease
} from './remote-workspace-access'

const digest = `sha256:${'a'.repeat(64)}`
const binding: RemoteWorkspaceProjectBinding = {
  hostId: 'host-1',
  remoteRootPath: '/srv/project'
}
const handle: RemoteWorkspaceHandle = {
  workspaceId: 'workspace-1',
  workspaceIdentity: 'identity-1',
  canonicalDisplayPath: binding.remoteRootPath,
  access: 'read-only',
  git: 'available',
  capabilities: [
    'list',
    'stat',
    'read-text',
    'search',
    'git-status',
    'git-diff'
  ],
  generation: 5
}

function createLease(
  overrides: Partial<RemoteWorkspaceTransportLease> = {}
): RemoteWorkspaceTransportLease {
  return {
    binding: {
      hostId: binding.hostId,
      hostRevision: 2,
      hostKeyGeneration: 3,
      remoteUsername: 'builder',
      agentInstallationId: 'installation-1',
      agentBinaryDigest: digest,
      agentVersion: '0.11.0',
      agentArchitecture: 'x64',
      agentProtocolMajor: 1,
      capabilityGeneration: 6
    },
    validateWorkspace: vi.fn(async () => ({
      handle,
      validatedAt: '2026-08-21T00:00:00.000Z'
    })),
    closeWorkspace: vi.fn(async (request) => ({
      ...request,
      closed: true as const
    })),
    listWorkspace: vi.fn(async () => ({
      entries: [],
      nextCursor: undefined
    })),
    statWorkspace: vi.fn(async (request) => ({
      relativePath: request.relativePath,
      name: request.relativePath.split('/').at(-1) ?? 'project',
      kind: 'file' as const,
      byteLength: 5,
      modifiedAt: '2026-08-21T00:00:00.000Z',
      digest,
      executable: false
    })),
    readWorkspaceText: vi.fn(async (request) => ({
      relativePath: request.relativePath,
      content: 'hello',
      offsetBytes: request.offsetBytes,
      bytesRead: 5,
      totalBytes: 5,
      digest,
      truncated: false
    })),
    searchWorkspace: vi.fn(async () => ({
      matches: [],
      truncated: false
    })),
    getGitStatus: vi.fn(async () => ({
      repositoryIdentity: 'repository-1',
      branch: 'main',
      entries: [],
      truncated: false
    })),
    getGitDiff: vi.fn(async () => ({
      repositoryIdentity: 'repository-1',
      patch: '',
      byteLength: 0,
      truncated: false
    })),
    release: vi.fn(),
    ...overrides
  }
}

function createAccess(lease: RemoteWorkspaceTransportLease): {
  access: RemoteWorkspaceAccess
  transport: RemoteWorkspaceTransport
} {
  const transport: RemoteWorkspaceTransport = {
    acquireLease: vi.fn(async () => lease)
  }
  return {
    access: new RemoteWorkspaceAccess(binding, transport),
    transport
  }
}

describe('RemoteWorkspaceAccess', () => {
  it('lazily validates once and maps bounded workspace methods', async () => {
    const lease = createLease({
      listWorkspace: vi.fn(async () => ({
        entries: [
          {
            relativePath: 'src',
            name: 'src',
            kind: 'directory' as const,
            byteLength: 0,
            modifiedAt: '2026-08-21T00:00:00.000Z',
            executable: true
          }
        ],
        nextCursor: '2'
      })),
      searchWorkspace: vi.fn(async () => ({
        matches: [
          {
            relativePath: 'src/main.ts',
            line: 2,
            column: 3,
            snippet: '  target'
          }
        ],
        truncated: false
      }))
    })
    const { access, transport } = createAccess(lease)

    await expect(access.getIdentity()).resolves.toEqual({
      kind: 'remote',
      id: 'host-1:identity-1',
      canonicalDisplayPath: '/srv/project',
      access: 'read-only'
    })
    await expect(
      access.listDirectory({ path: '', maximumEntries: 10 })
    ).resolves.toEqual({
      path: '',
      entries: [{ name: 'src', path: 'src', type: 'directory' }],
      truncated: true
    })
    await expect(access.stat({ path: 'README.md' })).resolves.toEqual({
      name: 'README.md',
      path: 'README.md',
      type: 'file',
      size: 5,
      modifiedAt: '2026-08-21T00:00:00.000Z'
    })
    await expect(
      access.readText({ path: 'README.md', maximumBytes: 10 })
    ).resolves.toEqual({
      path: 'README.md',
      name: 'README.md',
      content: 'hello',
      size: 5,
      offsetBytes: 0,
      bytesRead: 5,
      truncated: false
    })
    await expect(
      access.search({
        query: 'target',
        path: 'src',
        maximumResults: 10
      })
    ).resolves.toEqual({
      matches: [
        {
          path: 'src/main.ts',
          line: 2,
          column: 3,
          preview: '  target'
        }
      ],
      truncated: false
    })

    expect(transport.acquireLease).toHaveBeenCalledOnce()
    expect(lease.validateWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({
        remoteRootPath: '/srv/project',
        requestedAccess: 'read-only'
      }),
      undefined
    )
    expect(lease.listWorkspace).toHaveBeenCalledWith(
      {
        workspaceId: 'workspace-1',
        generation: 5,
        relativePath: '',
        limit: 10
      } satisfies RemoteWorkspaceListRequest,
      undefined
    )
    expect(lease.searchWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: 'workspace-1',
        generation: 5,
        query: 'target',
        pathPrefix: 'src',
        limit: 10
      }),
      undefined
    )
  })

  it('lists a readable non-Git workspace without requiring Git capabilities', async () => {
    const nonGitHandle: RemoteWorkspaceHandle = {
      ...handle,
      git: 'not-a-repository',
      capabilities: ['list', 'stat', 'read-text', 'search']
    }
    const getGitStatus = vi.fn()
    const getGitDiff = vi.fn()
    const lease = createLease({
      validateWorkspace: vi.fn(async () => ({
        handle: nonGitHandle,
        validatedAt: '2026-08-21T00:00:00.000Z'
      })),
      getGitStatus,
      getGitDiff
    })
    const { access } = createAccess(lease)

    await expect(
      access.listDirectory({ path: '' })
    ).resolves.toEqual({
      path: '',
      entries: [],
      truncated: false
    })
    expect(lease.validateWorkspace).toHaveBeenCalledWith(
      {
        remoteRootPath: binding.remoteRootPath,
        requestedAccess: 'read-only',
        requiredCapabilities: [
          'list',
          'stat',
          'read-text',
          'search'
        ]
      },
      undefined
    )
    await expect(access.getChanges({})).resolves.toMatchObject({
      rootPath: binding.remoteRootPath,
      available: false,
      files: []
    })
    expect(getGitStatus).not.toHaveBeenCalled()
    expect(getGitDiff).not.toHaveBeenCalled()
  })

  it('validates the configured path instead of resuming persisted state', async () => {
    const lease = createLease()
    const { access } = createAccess(lease)

    await access.getIdentity()

    expect(lease.validateWorkspace).toHaveBeenCalledWith(
      {
        remoteRootPath: binding.remoteRootPath,
        requestedAccess: 'read-only',
        requiredCapabilities: [
          'list',
          'stat',
          'read-text',
          'search'
        ]
      },
      undefined
    )
  })

  it('uses live Agent identity but rejects a different Host or path', async () => {
    const currentAgent = createLease({
      binding: {
        ...createLease().binding,
        hostRevision: 99,
        agentBinaryDigest: `sha256:${'b'.repeat(64)}`,
        agentVersion: '0.11.1',
        agentArchitecture: 'arm64'
      }
    })
    await expect(
      createAccess(currentAgent).access.getIdentity()
    ).resolves.toMatchObject({
      kind: 'remote',
      canonicalDisplayPath: binding.remoteRootPath
    })

    const otherHost = createLease({
      binding: {
        ...createLease().binding,
        hostId: 'host-2'
      }
    })
    await expect(
      createAccess(otherHost).access.getIdentity()
    ).rejects.toThrow('绑定已失效')

    const identityMismatch = createLease({
      validateWorkspace: vi.fn(async () => ({
        handle: {
          ...handle,
          canonicalDisplayPath: '/srv/other'
        },
        validatedAt: '2026-08-21T00:00:00.000Z'
      }))
    })
    await expect(
      createAccess(identityMismatch).access.getIdentity()
    ).rejects.toThrow('身份绑定不匹配')
  })

  it('fails when the lease capability generation becomes stale', async () => {
    const mutableBinding = {
      ...createLease().binding
    }
    const lease = createLease({ binding: mutableBinding })
    const { access } = createAccess(lease)
    await access.getIdentity()
    mutableBinding.capabilityGeneration += 1

    await expect(
      access.listDirectory({ path: '' })
    ).rejects.toThrow('能力代际已失效')
  })

  it('enforces protocol limits before dispatching requests', async () => {
    const lease = createLease()
    const { access, transport } = createAccess(lease)

    await expect(
      access.listDirectory({ path: '', maximumEntries: 1001 })
    ).rejects.toThrow('条目上限')
    await expect(
      access.readText({
        path: 'file.txt',
        maximumBytes: 4 * 1024 * 1024 + 1
      })
    ).rejects.toThrow('读取上限')
    await expect(
      access.search({ query: 'x', maximumResults: 1001 })
    ).rejects.toThrow('搜索结果上限')
    await expect(
      access.search({ query: 'x', maximumFileBytes: 1 })
    ).rejects.toThrow('不支持本机扫描限额')
    await expect(
      access.writeTextAtomic({ path: 'x', content: 'x' })
    ).rejects.toThrow('持久 operation transport')
    expect(transport.acquireLease).not.toHaveBeenCalled()
  })

  it('returns remote file pages and keeps UTF-8 boundaries intact', async () => {
    const invalidBoundary = Object.assign(
      new Error('Workspace file is not valid UTF-8'),
      { data: { code: 'invalid-utf8' } }
    )
    const readWorkspaceText = vi
      .fn()
      .mockRejectedValueOnce(invalidBoundary)
      .mockResolvedValueOnce({
        relativePath: 'large.txt',
        content: '你a',
        offsetBytes: 0,
        bytesRead: 4,
        totalBytes: 7,
        digest,
        truncated: true
      })
      .mockResolvedValueOnce({
        relativePath: 'large.txt',
        content: '好',
        offsetBytes: 4,
        bytesRead: 3,
        totalBytes: 7,
        digest,
        truncated: false
      })
    const lease = createLease({ readWorkspaceText })
    const { access } = createAccess(lease)

    const first = await access.readText({
      path: 'large.txt',
      maximumBytes: 5,
      allowTruncated: true
    })
    const second = await access.readText({
      path: 'large.txt',
      offsetBytes: first.offsetBytes + first.bytesRead,
      maximumBytes: 5,
      allowTruncated: true
    })

    expect(first).toMatchObject({
      content: '你a',
      offsetBytes: 0,
      bytesRead: 4,
      truncated: true
    })
    expect(second).toMatchObject({
      content: '好',
      offsetBytes: 4,
      truncated: false
    })
    expect(
      readWorkspaceText.mock.calls.map(([request]) => ({
        offsetBytes: request.offsetBytes,
        maximumBytes: request.maximumBytes
      }))
    ).toEqual([
      { offsetBytes: 0, maximumBytes: 5 },
      { offsetBytes: 0, maximumBytes: 4 },
      { offsetBytes: 4, maximumBytes: 5 }
    ])
  })

  it('retries one inconsistent Git snapshot and maps status and diff', async () => {
    const getGitStatus = vi
      .fn()
      .mockResolvedValueOnce({
        repositoryIdentity: 'repository-1',
        branch: 'main',
        entries: [],
        truncated: false
      })
      .mockResolvedValueOnce({
        repositoryIdentity: 'repository-2',
        branch: 'main',
        entries: [
          {
            relativePath: 'new.txt',
            index: 'untracked',
            worktree: 'untracked'
          }
        ],
        truncated: false
      })
    const getGitDiff = vi
      .fn()
      .mockResolvedValueOnce({
        repositoryIdentity: 'repository-other',
        patch: 'old',
        byteLength: 3,
        truncated: false
      })
      .mockResolvedValueOnce({
        repositoryIdentity: 'repository-2',
        patch: '+new\n',
        byteLength: 5,
        truncated: false
      })
    const lease = createLease({ getGitStatus, getGitDiff })
    const { access } = createAccess(lease)

    await expect(access.getChanges({})).resolves.toMatchObject({
      available: true,
      status: '?? new.txt',
      patch: '+new\n',
      files: [{ path: 'new.txt', status: '??' }]
    })
    expect(getGitStatus).toHaveBeenCalledTimes(2)
    expect(getGitDiff).toHaveBeenCalledTimes(2)
  })

  it('fails closed after the bounded Git snapshot retry', async () => {
    const lease = createLease({
      getGitStatus: vi.fn(async () => ({
        repositoryIdentity: 'status-snapshot',
        branch: null,
        entries: [],
        truncated: false
      })),
      getGitDiff: vi.fn(async () => ({
        repositoryIdentity: 'diff-snapshot',
        patch: '',
        byteLength: 0,
        truncated: false
      }))
    })
    const { access } = createAccess(lease)

    await expect(access.getChanges({})).resolves.toMatchObject({
      available: false,
      error: 'Git 快照在读取期间持续变化'
    })
    expect(lease.getGitStatus).toHaveBeenCalledTimes(2)
    expect(lease.getGitDiff).toHaveBeenCalledTimes(2)
  })

  it('propagates cancellation to the transport', async () => {
    const controller = new AbortController()
    const listWorkspace = vi.fn(
      async (
        _request: RemoteWorkspaceListRequest,
        signal?: AbortSignal
      ) =>
        await new Promise<never>((_resolve, reject) => {
          signal?.addEventListener(
            'abort',
            () => reject(signal.reason),
            { once: true }
          )
        })
    )
    const lease = createLease({ listWorkspace })
    const { access } = createAccess(lease)
    const operation = access.listDirectory({
      path: '',
      signal: controller.signal
    })
    await vi.waitFor(() => expect(listWorkspace).toHaveBeenCalled())
    controller.abort(new Error('cancelled'))

    await expect(operation).rejects.toThrow('cancelled')
    expect(listWorkspace.mock.calls[0]?.[1]).toBe(controller.signal)
  })

  it('closes and releases exactly once even when close fails', async () => {
    const release = vi.fn()
    const closeWorkspace = vi.fn(async () => {
      throw new Error('close failed')
    })
    const lease = createLease({ release, closeWorkspace })
    const { access } = createAccess(lease)
    await access.getIdentity()

    await expect(access.dispose()).rejects.toThrow('close failed')
    await expect(access.dispose()).rejects.toThrow('close failed')
    expect(closeWorkspace).toHaveBeenCalledOnce()
    expect(release).toHaveBeenCalledOnce()
  })
})

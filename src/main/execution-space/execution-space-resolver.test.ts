import { describe, expect, it, vi } from 'vitest'
import type { AssistantProject } from '../../shared/assistant-contracts'
import {
  ExecutionSpaceResolver,
  REMOTE_EXECUTION_SPACE_UNAVAILABLE
} from './execution-space-resolver'

function project(
  overrides: Partial<AssistantProject> = {}
): AssistantProject {
  return {
    id: '00000000-0000-4000-8000-000000000101',
    name: 'Project',
    description: '',
    rootPath: 'C:\\Workspace',
    executionSpace: {
      kind: 'local',
      rootPath: 'C:\\Workspace'
    },
    defaultWorkMode: 'ask',
    kind: 'user',
    status: 'active',
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
    ...overrides
  }
}

describe('ExecutionSpaceResolver', () => {
  it('uses a stable local cache identity without accessing the workspace', () => {
    const resolver = new ExecutionSpaceResolver()
    const first = resolver.resolveProject(project())
    const second = resolver.resolveProject(project())

    expect(first.kind).toBe('local')
    expect(second.cacheIdentity).toBe(first.cacheIdentity)
    expect(first.workspaceAccess).not.toBe(second.workspaceAccess)
  })

  it('keeps remote workspace operations unavailable without a factory', async () => {
    const descriptor = new ExecutionSpaceResolver().resolveProject(
      remoteProject()
    )

    expect(descriptor.kind).toBe('ssh')
    await expect(
      descriptor.workspaceAccess.listDirectory({ path: '' })
    ).rejects.toThrow(REMOTE_EXECUTION_SPACE_UNAVAILABLE)
  })

  it('binds remote access only to the configured Host and path', () => {
    const workspaceAccess = {
      getIdentity: vi.fn(),
      listDirectory: vi.fn(),
      stat: vi.fn(),
      readText: vi.fn(),
      writeTextAtomic: vi.fn(),
      search: vi.fn(),
      getChanges: vi.fn(),
      dispose: vi.fn()
    }
    const factory = {
      create: vi.fn(() => workspaceAccess)
    }
    const resolver = new ExecutionSpaceResolver(factory)
    const first = resolver.resolveProject(remoteProject())
    const second = resolver.resolveProject(remoteProject())

    expect(first.workspaceAccess).toBe(workspaceAccess)
    expect(first.cacheIdentity).toBe(second.cacheIdentity)
    expect(factory.create).toHaveBeenCalledWith({
      hostId: '00000000-0000-4000-8000-000000000201',
      remoteRootPath: '/srv/project'
    })
  })

  it('changes remote identities only with stable project configuration', () => {
    const resolver = new ExecutionSpaceResolver()
    const first = resolver.resolveProject(remoteProject())
    const nextPath = resolver.resolveProject(
      remoteProject({
        rootPath: '/srv/other',
        executionSpace: {
          kind: 'ssh',
          hostId: '00000000-0000-4000-8000-000000000201',
          remoteRootPath: '/srv/other'
        }
      })
    )
    const nextProject = resolver.resolveProject(
      remoteProject({
        id: '00000000-0000-4000-8000-000000000102'
      })
    )

    expect(nextPath.cacheIdentity).not.toBe(first.cacheIdentity)
    expect(nextProject.cacheIdentity).toBe(first.cacheIdentity)
    expect(nextProject.routeIdentity).not.toBe(first.routeIdentity)
  })
})

function remoteProject(
  overrides: Partial<AssistantProject> = {}
): AssistantProject {
  return project({
    rootPath: '/srv/project',
    executionSpace: {
      kind: 'ssh',
      hostId: '00000000-0000-4000-8000-000000000201',
      remoteRootPath: '/srv/project'
    },
    runtimeSelection: { provider: 'opencode' },
    ...overrides
  })
}

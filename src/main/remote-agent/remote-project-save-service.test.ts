import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AssistantProject } from '../../shared/assistant-contracts'
import type { AgentRuntimeSelection } from '../../shared/runtime-selection-contracts'
import type { SshConnectionTarget } from '../ssh/ssh-host-store'
import { verifyAgentInstallationId } from '../ssh/ssh-agent-command'
import type { AgentInstallationIdentity } from './agent-installation-manager'
import type { RemoteAgentConnection } from './remote-agent-connection-manager'
import {
  RemoteProjectSaveService,
  type RemoteProjectSaveOwner,
  type RemoteProjectSaveServiceOptions,
  type RemoteProjectRuntimeValidationLease
} from './remote-project-save-service'

const hostId = '00000000-0000-4000-8000-000000000001'
const projectId = '00000000-0000-4000-8000-000000000002'
const root = '/srv/project'
const digest = `sha256:${'a'.repeat(64)}`
const services: RemoteProjectSaveService[] = []

afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.dispose()))
})

class Owner extends EventEmitter implements RemoteProjectSaveOwner {
  destroyed = false

  constructor(readonly id: number) {
    super()
  }

  isDestroyed(): boolean {
    return this.destroyed
  }

  destroy(): void {
    this.destroyed = true
    this.emit('destroyed')
  }
}

const draft = {
  name: 'Remote',
  description: 'Validated remotely',
  defaultWorkMode: 'ask' as const,
  runtimeSelection: { provider: 'opencode' as const },
  hostId,
  remoteRootPath: root
}

const installation: AgentInstallationIdentity = {
  installationId: verifyAgentInstallationId('agent-installation'),
  binaryDigest: digest,
  agentVersion: '1.2.3',
  protocol: { major: 1, minor: 0 },
  platform: 'linux',
  architecture: 'x64',
  supervisor: 'detached-on-demand'
}

function project(
  overrides: Partial<AssistantProject> = {}
): AssistantProject {
  return {
    id: projectId,
    name: draft.name,
    description: draft.description,
    rootPath: root,
    defaultWorkMode: draft.defaultWorkMode,
    runtimeSelection: draft.runtimeSelection,
    kind: 'user',
    executionSpace: {
      kind: 'ssh',
      hostId,
      remoteRootPath: root
    },
    status: 'active',
    createdAt: '2030-01-01T00:00:00.000Z',
    updatedAt: '2030-01-01T00:00:00.000Z',
    ...overrides
  }
}

function target(): SshConnectionTarget {
  return {
    host: {
      id: hostId,
      name: 'Build host',
      hostname: 'build.example.com',
      port: 22,
      username: 'builder',
      authentication: 'system-agent',
      hostKey: {
        algorithm: 'ssh-ed25519',
        publicKeyBase64: Buffer.from('key').toString('base64'),
        fingerprintSha256: `SHA256:${'A'.repeat(43)}`,
        acceptedAt: '2030-01-01T00:00:00.000Z',
        generation: 2
      }
    },
    hostRevision: 3,
    hostKeyGeneration: 2
  }
}

type HarnessOptions = {
  getProject?: () => AssistantProject
  validateWorkspace?: (signal?: AbortSignal) => unknown | Promise<unknown>
  create?: () => AssistantProject
  update?: () => AssistantProject
  resolveRuntimeSelection?: (
    selection: AgentRuntimeSelection
  ) => Promise<AgentRuntimeSelection>
}

function harness(options: HarnessOptions = {}) {
  const calls: string[] = []
  const progress: string[] = []
  const workspace = {
    workspaceId: 'workspace-id',
    workspaceIdentity: 'workspace-identity',
    canonicalDisplayPath: root,
    access: 'read-only' as const,
    git: 'available' as const,
    capabilities: [
      'list',
      'stat',
      'read-text',
      'search',
      'git-status',
      'git-diff'
    ],
    generation: 1
  }
  const request = vi.fn(
    async (method: string, _params: unknown, requestOptions?: {
      signal?: AbortSignal
    }) => {
      calls.push(method)
      if (method === 'workspace/validate') {
        return options.validateWorkspace
          ? await options.validateWorkspace(requestOptions?.signal)
          : {
              handle: workspace,
              validatedAt: '2030-01-01T00:00:01.000Z'
            }
      }
      if (method === 'workspace/close') {
        return {
          workspaceId: workspace.workspaceId,
          generation: workspace.generation,
          closed: true
        }
      }
      throw new Error(`Unexpected method: ${method}`)
    }
  )
  const connectionRelease = vi.fn(() => {
    calls.push('connection-release')
  })
  const connection = {
    identity: {
      cacheKey: 'cache',
      hostId,
      hostRevision: 3,
      hostKeyGeneration: 2,
      remoteUsername: 'builder',
      installationId: installation.installationId,
      binaryDigest: digest,
      protocolMajor: 1,
      protocolMinor: 0
    },
    status: {
      state: 'ready',
      installationId: installation.installationId,
      binaryDigest: digest,
      daemonBootId: 'boot',
      agentVersion: installation.agentVersion,
      protocol: { major: 1, minor: 0 },
      platform: 'linux',
      architecture: 'x64',
      supervisor: 'detached-on-demand',
      remoteUserIdentity: 'user',
      draining: false
    },
    capabilities: {
      generation: 1,
      capabilities: [
        { name: 'workspace/read', version: 1, critical: true },
        { name: 'runtime/acp', version: 3, critical: true },
        {
          name: 'runtime/model-bridge',
          version: 1,
          critical: true
        }
      ],
      runtimes: []
    },
    client: { request },
    state: 'ready',
    release: connectionRelease
  } as unknown as RemoteAgentConnection
  const runtimeRelease = vi.fn(() => {
    calls.push('runtime-release')
  })
  const runtimeLease: RemoteProjectRuntimeValidationLease = {
    assertCurrent: vi.fn(() => calls.push('runtime-current')),
    release: runtimeRelease
  }
  const writes: Array<
    Parameters<
      RemoteProjectSaveServiceOptions['database']['createSshProject']
    >[0]
  > = []
  const persist = (
    operation: 'database-create' | 'database-update',
    write: (typeof writes)[number],
    result: AssistantProject
  ): AssistantProject => {
    calls.push(operation)
    writes.push(write)
    write.assertCurrent()
    return result
  }
  const createProject = vi.fn((write: (typeof writes)[number]) =>
    persist('database-create', write, options.create?.() ?? project())
  )
  const updateProject = vi.fn(
    (
      _id: string,
      _updatedAt: string,
      write: (typeof writes)[number]
    ) => persist('database-update', write, options.update?.() ?? project())
  )
  const service = new RemoteProjectSaveService({
    database: {
      getProject: vi.fn(() => options.getProject?.() ?? project()),
      createSshProject: createProject,
      updateSshProject: updateProject
    },
    sshHosts: {
      resolveConnectionTarget: vi.fn(async () => {
        calls.push('host')
        return target()
      }),
      assertConnectionTargetCurrent: vi.fn(() =>
        calls.push('host-current')
      )
    },
    installationManager: {
      activateInstalled: vi.fn(async () => {
        calls.push('activate')
        return installation
      })
    },
    connectionManager: {
      acquire: vi.fn(async () => {
        calls.push('attach')
        return connection
      })
    },
    resolveRuntimeSelection:
      options.resolveRuntimeSelection ??
      (async (selection) => selection),
    runtimeValidator: {
      validate: vi.fn(async () => {
        calls.push('runtime')
        return runtimeLease
      })
    },
    notify: (_owner, value) => progress.push(value.phase)
  })
  services.push(service)
  return {
    service,
    calls,
    progress,
    writes,
    createProject,
    updateProject,
    request,
    connectionRelease,
    runtimeRelease
  }
}

describe('RemoteProjectSaveService', () => {
  it('prepares the current Host and creates one stable project record', async () => {
    const value = harness()

    await expect(
      value.service.save(new Owner(1), { intent: 'create', draft })
    ).resolves.toMatchObject({ id: projectId })

    expect(value.progress).toEqual([
      'host',
      'agent',
      'workspace',
      'runtime',
      'saving'
    ])
    expect(value.writes[0]).toMatchObject({
      project: {
        rootPath: root,
        runtimeSelection: { provider: 'opencode' }
      },
      executionSpace: {
        kind: 'ssh',
        hostId,
        remoteRootPath: root
      }
    })
    expect(value.calls).toEqual([
      'host',
      'activate',
      'attach',
      'workspace/validate',
      'runtime',
      'runtime-current',
      'database-create',
      'host-current',
      'runtime-current',
      'runtime-release',
      'workspace/close',
      'connection-release'
    ])
  })

  it('persists the resolved Runtime selection', async () => {
    const selection = {
      provider: 'opencode' as const,
      profileId: '00000000-0000-4000-8000-000000000099'
    }
    const value = harness({
      resolveRuntimeSelection: vi.fn(async () => selection)
    })

    await value.service.save(new Owner(2), {
      intent: 'create',
      draft
    })

    expect(value.writes[0]?.project.runtimeSelection).toEqual(selection)
  })

  it('uses the preflight project revision for updates', async () => {
    const value = harness()

    await value.service.save(new Owner(3), {
      intent: 'update',
      draft: { ...draft, projectId }
    })

    expect(value.updateProject).toHaveBeenCalledWith(
      projectId,
      '2030-01-01T00:00:00.000Z',
      expect.any(Object)
    )
  })

  it('does not write when workspace validation fails', async () => {
    const value = harness({
      validateWorkspace: () => {
        throw new Error('workspace denied')
      }
    })

    await expect(
      value.service.save(new Owner(7), { intent: 'create', draft })
    ).rejects.toThrow('workspace denied')
    expect(value.createProject).not.toHaveBeenCalled()
    expect(value.connectionRelease).toHaveBeenCalledOnce()
  })

  it('cancels the active owner request', async () => {
    const value = harness({
      validateWorkspace: async (signal) =>
        await new Promise((_, reject) => {
          signal?.addEventListener(
            'abort',
            () => reject(signal.reason),
            { once: true }
          )
        })
    })
    const owner = new Owner(8)
    const pending = value.service.save(owner, {
      intent: 'create',
      draft
    })
    await vi.waitFor(() => {
      expect(value.calls).toContain('workspace/validate')
    })

    value.service.cancelCurrent(owner)

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    expect(value.createProject).not.toHaveBeenCalled()
  })

  it('cancels when the owner is destroyed', async () => {
    const value = harness({
      validateWorkspace: async (signal) =>
        await new Promise((_, reject) => {
          signal?.addEventListener(
            'abort',
            () => reject(signal.reason),
            { once: true }
          )
        })
    })
    const owner = new Owner(9)
    const pending = value.service.save(owner, {
      intent: 'create',
      draft
    })
    await vi.waitFor(() => {
      expect(value.calls).toContain('workspace/validate')
    })

    owner.destroy()

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
  })
})

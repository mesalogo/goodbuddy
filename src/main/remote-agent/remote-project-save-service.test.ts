import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AssistantProject } from '../../shared/assistant-contracts'
import { agentRuntimeSelectionKey } from '../../shared/runtime-selection-contracts'
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

const installation: AgentInstallationIdentity = {
  installationId: verifyAgentInstallationId('agent-installation'),
  binaryDigest: digest,
  agentVersion: '1.2.3',
  protocol: { major: 1, minor: 0 },
  platform: 'linux',
  architecture: 'x64',
  supervisor: 'detached-on-demand'
}

function project(): AssistantProject {
  return {
    id: projectId,
    ...draft,
    rootPath: root,
    kind: 'user',
    executionSpace: { kind: 'ssh', hostId, remoteRootPath: root },
    status: 'active',
    createdAt: '2030-01-01T00:00:00.000Z',
    updatedAt: '2030-01-01T00:00:00.000Z'
  }
}

function harness(options: {
  ensureInstalled?: (signal: AbortSignal) => Promise<AgentInstallationIdentity>
  validateWorkspace?: () => unknown
  create?: () => AssistantProject
  getProject?: () => AssistantProject
  resolveRuntimeSelection?: (
    selection: AgentRuntimeSelection
  ) => Promise<AgentRuntimeSelection>
} = {}) {
  const calls: string[] = []
  const currentTarget = target()
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
  const connectionRelease = vi.fn(() => calls.push('connection-release'))
  const request = vi.fn(async (method: string) => {
    calls.push(method)
    if (method === 'workspace/validate') {
      return (
        options.validateWorkspace?.() ?? {
          handle: workspace,
          validatedAt: '2030-01-01T00:00:01.000Z'
        }
      )
    }
    if (method === 'workspace/close') {
      return {
        workspaceId: workspace.workspaceId,
        generation: workspace.generation,
        closed: true
      }
    }
    throw new Error(`Unexpected method: ${method}`)
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
      agentVersion: '1.2.3',
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
        { name: 'workspace/read', version: 1, critical: true }
      ],
      runtimes: []
    },
    client: { request },
    state: 'ready',
    release: connectionRelease
  } as unknown as RemoteAgentConnection
  const runtimeRelease = vi.fn(() => calls.push('runtime-release'))
  const runtimeLease: RemoteProjectRuntimeValidationLease = {
    evidence: {
      runtimeSelectionKey: agentRuntimeSelectionKey(
        draft.runtimeSelection
      ),
      runtimeBundleDigest: digest,
      runtimeAdapterDigest: `sha256:${'b'.repeat(64)}`,
      agentInstallationIdAtValidation: installation.installationId,
      validatedAt: '2030-01-01T00:00:02.000Z',
      workMode: 'ask'
    },
    assertCurrent: vi.fn(() => calls.push('runtime-current')),
    release: runtimeRelease
  }
  const assertWrite = (write: Parameters<
    RemoteProjectSaveServiceOptions['database']['createValidatedSshProject']
  >[0]) => {
    write.assertSshHostCurrent({
      hostId,
      hostRevision: 3,
      hostKeyGeneration: 2,
      remoteUsername: 'builder',
      remoteRootPath: root,
      workspaceIdentity: workspace.workspaceIdentity,
      agentProtocolMajor: 1,
      agentInstallationId: installation.installationId,
      agentBinaryDigest: digest,
      agentVersion: '1.2.3',
      agentArchitecture: 'x64'
    })
  }
  const createProject = vi.fn((write) => {
    calls.push('database-create')
    assertWrite(write)
    return options.create?.() ?? project()
  })
  const updateProject = vi.fn((_id, _updatedAt, write) => {
    calls.push('database-update')
    assertWrite(write)
    return project()
  })
  const progress: string[] = []
  const service = new RemoteProjectSaveService({
    database: {
      getProject: vi.fn(() => options.getProject?.() ?? project()),
      createValidatedSshProject: createProject,
      updateValidatedSshProject: updateProject
    },
    sshHosts: {
      resolveConnectionTarget: vi.fn(async () => {
        calls.push('host')
        return structuredClone(currentTarget)
      }),
      assertConnectionTargetCurrent: vi.fn(() => calls.push('host-current'))
    },
    installationManager: {
      ensureInstalled: vi.fn(async (_hostId, requestOptions) => {
        calls.push('install')
        return options.ensureInstalled
          ? options.ensureInstalled(requestOptions.signal!)
          : installation
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
      validate: vi.fn(async (input) => {
        calls.push('runtime')
        return {
          ...runtimeLease,
          evidence: {
            ...runtimeLease.evidence,
            runtimeSelectionKey: input.runtimeSelectionKey
          }
        }
      })
    },
    notify: (_owner, value) => progress.push(value.phase)
  })
  services.push(service)
  return {
    service,
    calls,
    createProject,
    updateProject,
    runtimeRelease,
    connectionRelease,
    progress
  }
}

describe('RemoteProjectSaveService awaited save', () => {
  it('validates and creates in one awaited request, then cleans up in reverse order', async () => {
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
    expect(value.createProject).toHaveBeenCalledOnce()
    expect(value.calls.slice(-3)).toEqual([
      'runtime-release',
      'workspace/close',
      'connection-release'
    ])
  })

  it('accepts a readable non-Git remote workspace', async () => {
    const value = harness({
      validateWorkspace: () => ({
        handle: {
          workspaceId: 'workspace-id',
          workspaceIdentity: 'workspace-identity',
          canonicalDisplayPath: root,
          access: 'read-only' as const,
          git: 'not-a-repository' as const,
          capabilities: [
            'list',
            'stat',
            'read-text',
            'search'
          ] as const,
          generation: 1
        },
        validatedAt: '2030-01-01T00:00:01.000Z'
      })
    })

    await expect(
      value.service.save(new Owner(1), {
        intent: 'create',
        draft
      })
    ).resolves.toMatchObject({ id: projectId })
    expect(value.createProject).toHaveBeenCalledOnce()
  })

  it('updates using the project revision captured before remote validation', async () => {
    const value = harness()
    await value.service.save(new Owner(1), {
      intent: 'update',
      draft: { projectId, ...draft }
    })
    expect(value.updateProject).toHaveBeenCalledWith(
      projectId,
      '2030-01-01T00:00:00.000Z',
      expect.any(Object)
    )
  })

  it('validates and persists the configured Runtime profile selection', async () => {
    const configuredSelection = {
      provider: 'opencode' as const,
      profileId: '00000000-0000-4000-8000-000000000003'
    }
    const value = harness({
      resolveRuntimeSelection: vi.fn(async () => configuredSelection)
    })

    await value.service.save(new Owner(1), {
      intent: 'create',
      draft
    })

    expect(value.createProject).toHaveBeenCalledWith(
      expect.objectContaining({
        project: expect.objectContaining({
          runtimeSelection: configuredSelection
        })
      })
    )
  })

  it('activates a persisted SSH project through the full update pipeline', async () => {
    const value = harness()

    await expect(
      value.service.activate(new Owner(1), projectId)
    ).resolves.toMatchObject({ id: projectId })

    expect(value.updateProject).toHaveBeenCalledWith(
      projectId,
      '2030-01-01T00:00:00.000Z',
      expect.objectContaining({
        project: expect.objectContaining({
          name: draft.name,
          description: draft.description,
          defaultWorkMode: draft.defaultWorkMode,
          runtimeSelection: draft.runtimeSelection
        }),
        executionSpace: expect.objectContaining({
          hostId,
          remoteRootPath: root
        })
      })
    )
    expect(value.calls).toEqual(expect.arrayContaining([
      'host',
      'install',
      'attach',
      'workspace/validate',
      'runtime',
      'database-update'
    ]))
  })

  it('coalesces repeated activation for the same owner and project', async () => {
    let releaseInstallation!: () => void
    const installationGate = new Promise<void>((resolve) => {
      releaseInstallation = resolve
    })
    const value = harness({
      ensureInstalled: async () => {
        await installationGate
        return installation
      }
    })
    const owner = new Owner(1)

    const first = value.service.activate(owner, projectId)
    await vi.waitFor(() => expect(value.calls).toContain('install'))
    const second = value.service.activate(owner, projectId)
    await expect(
      value.service.save(owner, { intent: 'create', draft })
    ).rejects.toThrow('already in progress')

    expect(
      value.calls.filter((call) => call === 'install')
    ).toHaveLength(1)
    releaseInstallation()
    await expect(Promise.all([first, second])).resolves.toEqual([
      expect.objectContaining({ id: projectId }),
      expect.objectContaining({ id: projectId })
    ])
    expect(value.updateProject).toHaveBeenCalledOnce()
  })

  it('rejects activation for a local project before remote work starts', async () => {
    const value = harness({
      getProject: () => ({
        ...project(),
        rootPath: 'C:\\workspace',
        executionSpace: {
          kind: 'local',
          rootPath: 'C:\\workspace'
        }
      })
    })

    await expect(
      value.service.activate(new Owner(1), projectId)
    ).rejects.toThrow('active managed SSH projects')
    expect(value.calls).toEqual([])
    expect(value.updateProject).not.toHaveBeenCalled()
  })

  it('does not write when workspace validation fails', async () => {
    const value = harness({
      validateWorkspace: () => {
        throw new Error('workspace unavailable')
      }
    })
    await expect(
      value.service.save(new Owner(1), { intent: 'create', draft })
    ).rejects.toThrow('workspace unavailable')
    expect(value.createProject).not.toHaveBeenCalled()
    expect(value.connectionRelease).toHaveBeenCalledOnce()
  })

  it('cancels the current owner save without an operation id', async () => {
    const value = harness({
      ensureInstalled: (signal) =>
        new Promise((_, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), {
            once: true
          })
        })
    })
    const owner = new Owner(1)
    const saving = value.service.save(owner, { intent: 'create', draft })
    await vi.waitFor(() => expect(value.calls).toContain('install'))
    value.service.cancelCurrent(owner)
    await expect(saving).rejects.toMatchObject({ name: 'AbortError' })
    expect(value.createProject).not.toHaveBeenCalled()
  })

  it('cancels when the renderer owner is destroyed', async () => {
    const value = harness({
      ensureInstalled: (signal) =>
        new Promise((_, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), {
            once: true
          })
        })
    })
    const owner = new Owner(1)
    const saving = value.service.save(owner, { intent: 'create', draft })
    await vi.waitFor(() => expect(value.calls).toContain('install'))
    owner.destroy()
    await expect(saving).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('surfaces transactional conflicts and permits a later retry', async () => {
    const value = harness({
      create: () => {
        throw new Error('project conflict')
      }
    })
    const owner = new Owner(1)
    await expect(
      value.service.save(owner, { intent: 'create', draft })
    ).rejects.toThrow('project conflict')
    await expect(
      value.service.save(owner, {
        intent: 'update',
        draft: { projectId, ...draft }
      })
    ).resolves.toMatchObject({ id: projectId })
  })
})

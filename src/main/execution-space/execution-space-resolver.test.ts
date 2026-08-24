import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it, vi } from 'vitest'
import type { AssistantProject } from '../../shared/assistant-contracts'
import { AssistantDatabase } from '../assistant/assistant-database'
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

  it('keeps every remote workspace operation fail closed', async () => {
    const resolver = new ExecutionSpaceResolver()
    const descriptor = resolver.resolveProject(
      project({
        rootPath: '/srv/project',
        executionSpace: {
          kind: 'ssh',
          hostId: '00000000-0000-4000-8000-000000000201',
          remoteRootPath: '/srv/project'
        }
      })
    )

    expect(descriptor.kind).toBe('ssh')
    await expect(
      descriptor.workspaceAccess.listDirectory({ path: '' })
    ).rejects.toThrow(REMOTE_EXECUTION_SPACE_UNAVAILABLE)
    await expect(
      descriptor.workspaceAccess.getChanges({})
    ).rejects.toThrow(REMOTE_EXECUTION_SPACE_UNAVAILABLE)
    await expect(
      descriptor.workspaceAccess.writeTextAtomic({
        path: 'file.txt',
        content: 'no'
      })
    ).rejects.toThrow(REMOTE_EXECUTION_SPACE_UNAVAILABLE)
  })

  it('uses an injected remote factory only for complete matching validation', async () => {
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
    const validation = {
      hostRevision: 1,
      hostKeyGeneration: 2,
      remoteUsername: 'builder',
      workspaceIdentity: 'workspace-1',
      agentProtocolMajor: 1,
      agentInstallationIdAtValidation: 'agent-1',
      agentBinaryDigestAtValidation: `sha256:${'a'.repeat(64)}`,
      agentVersionAtValidation: '0.11.0',
      agentArchitectureAtValidation: 'x64' as const,
      validatedAt: '2026-08-01T00:00:00.000Z'
    }
    const runtimeValidation = {
      runtimeSelectionKey: 'opencode',
      runtimeBundleDigest: `sha256:${'b'.repeat(64)}`,
      runtimeAdapterDigest: `sha256:${'c'.repeat(64)}`,
      agentInstallationIdAtValidation: 'agent-1',
      validatedAt: '2026-08-01T00:00:00.000Z',
      workMode: 'ask' as const
    }
    const resolver = new ExecutionSpaceResolver(factory)
    const descriptor = resolver.resolveProject(
      project({
        rootPath: '/srv/project',
        executionSpace: {
          kind: 'ssh',
          hostId: '00000000-0000-4000-8000-000000000201',
          remoteRootPath: '/srv/project',
          validation
        },
        runtimeValidation
      })
    )

    expect(descriptor.workspaceAccess).toBe(workspaceAccess)
    expect(descriptor).toMatchObject({
      kind: 'ssh',
      validation: {
        agentInstallationIdAtValidation: 'agent-1',
        agentBinaryDigestAtValidation: `sha256:${'a'.repeat(64)}`,
        agentVersionAtValidation: '0.11.0',
        agentArchitectureAtValidation: 'x64'
      },
      runtimeValidation
    })
    expect(factory.create).toHaveBeenCalledWith({
      hostId: '00000000-0000-4000-8000-000000000201',
      remoteRootPath: '/srv/project',
      hostRevision: 1,
      hostKeyGeneration: 2,
      remoteUsername: 'builder',
      workspaceIdentity: 'workspace-1',
      agentProtocolMajor: 1,
      agentInstallationId: 'agent-1',
      agentBinaryDigest: `sha256:${'a'.repeat(64)}`,
      agentVersion: '0.11.0',
      agentArchitecture: 'x64'
    })

    const stale = resolver.resolveProject(
      project({
        rootPath: '/srv/project',
        executionSpace: {
          kind: 'ssh',
          hostId: '00000000-0000-4000-8000-000000000201',
          remoteRootPath: '/srv/project',
          validation
        },
        runtimeValidation: {
          ...runtimeValidation,
          agentInstallationIdAtValidation: 'agent-2'
        }
      })
    )
    await expect(stale.workspaceAccess.getIdentity()).rejects.toThrow(
      REMOTE_EXECUTION_SPACE_UNAVAILABLE
    )

    expect(factory.create).toHaveBeenCalledOnce()
  })

  it('includes remote Host, Agent, Runtime, and work-mode identities in the cache identity', () => {
    const resolver = new ExecutionSpaceResolver()
    const baseValidation = {
      hostRevision: 1,
      hostKeyGeneration: 2,
      remoteUsername: 'builder',
      workspaceIdentity: 'workspace-1',
      agentProtocolMajor: 1,
      agentInstallationIdAtValidation: 'agent-1',
      agentBinaryDigestAtValidation: `sha256:${'a'.repeat(64)}`,
      agentVersionAtValidation: '0.11.0',
      agentArchitectureAtValidation: 'x64' as const,
      validatedAt: '2026-08-01T00:00:00.000Z'
    }
    const runtimeValidation = {
      runtimeSelectionKey: 'opencode',
      runtimeBundleDigest: `sha256:${'b'.repeat(64)}`,
      runtimeAdapterDigest: `sha256:${'c'.repeat(64)}`,
      agentInstallationIdAtValidation: 'agent-1',
      validatedAt: '2026-08-01T00:00:00.000Z',
      workMode: 'ask' as const
    }
    const first = resolver.resolveProject(
      project({
        rootPath: '/srv/project',
        executionSpace: {
          kind: 'ssh',
          hostId: '00000000-0000-4000-8000-000000000201',
          remoteRootPath: '/srv/project',
          validation: baseValidation
        },
        runtimeValidation
      })
    )
    const second = resolver.resolveProject(
      project({
        rootPath: '/srv/project',
        executionSpace: {
          kind: 'ssh',
          hostId: '00000000-0000-4000-8000-000000000201',
          remoteRootPath: '/srv/project',
          validation: {
            ...baseValidation,
            hostRevision: 2
          }
        },
        runtimeValidation
      })
    )

    expect(second.cacheIdentity).not.toBe(first.cacheIdentity)

    for (const validation of [
      {
        ...baseValidation,
        agentBinaryDigestAtValidation: `sha256:${'b'.repeat(64)}`
      },
      {
        ...baseValidation,
        agentVersionAtValidation: '0.11.1'
      },
      {
        ...baseValidation,
        agentArchitectureAtValidation: 'arm64' as const
      }
    ]) {
      const changed = resolver.resolveProject(
        project({
          rootPath: '/srv/project',
          executionSpace: {
            kind: 'ssh',
            hostId: '00000000-0000-4000-8000-000000000201',
            remoteRootPath: '/srv/project',
            validation
          },
          runtimeValidation
        })
      )
      expect(changed.cacheIdentity).not.toBe(first.cacheIdentity)
    }

    for (const changedRuntimeValidation of [
      {
        ...runtimeValidation,
        workMode: 'execute' as const
      }
    ]) {
      const changed = resolver.resolveProject(
        project({
          rootPath: '/srv/project',
          executionSpace: {
            kind: 'ssh',
            hostId: '00000000-0000-4000-8000-000000000201',
            remoteRootPath: '/srv/project',
            validation: baseValidation
          },
          runtimeValidation: changedRuntimeValidation
        })
      )
      expect(changed.cacheIdentity).not.toBe(first.cacheIdentity)
    }
  })

  it('changes DB-backed cache identity for host and Runtime generations', async () => {
    const directory = await mkdtemp(
      join(tmpdir(), 'goodbuddy-execution-resolver-')
    )
    const databasePath = join(directory, 'assistant.sqlite')
    const database = new AssistantDatabase(databasePath)
    const raw = new DatabaseSync(databasePath)
    try {
      database.initialize('C:\\Workspace')
      const projectId = database.listProjects()[0]!.id
      raw
        .prepare(
          `UPDATE project_execution_spaces
           SET kind = 'ssh', root_path = ?, ssh_host_id = ?,
               host_revision = ?, host_key_generation = ?,
               remote_username = ?, workspace_identity = ?,
               agent_installation_id_at_validation = ?,
               agent_binary_digest_at_validation = ?,
               agent_version_at_validation = ?,
               agent_architecture_at_validation = ?,
               agent_protocol_major = ?,
               trust_attestation_revision = ?, validated_at = ?
           WHERE project_id = ?`
        )
        .run(
          '/srv/project',
          '00000000-0000-4000-8000-000000000201',
          1,
          1,
          'builder',
          'workspace-1',
          'agent-1',
          `sha256:${'a'.repeat(64)}`,
          '0.11.0',
          'x64',
          1,
          0,
          '2026-08-01T00:00:00.000Z',
          projectId
        )
      raw
        .prepare(
          `INSERT INTO project_runtime_validations
            (project_id, runtime_selection_key,
             runtime_bundle_digest, runtime_adapter_digest,
             confinement_policy_digest, approval_bridge_version,
             agent_installation_id_at_validation, validated_at,
             work_mode, trust_tier, trust_attestation_revision)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          projectId,
          'opencode',
          `sha256:${'b'.repeat(64)}`,
          `sha256:${'c'.repeat(64)}`,
          `sha256:${'c'.repeat(64)}`,
          'unused',
          'agent-1',
          '2026-08-01T00:00:00.000Z',
          'ask',
          null,
          null
        )

      const resolver = new ExecutionSpaceResolver()
      const baseline = resolver.resolveProject(
        database.getProject(projectId)
      )
      raw
        .prepare(
          `UPDATE project_execution_spaces
           SET host_key_generation = 2
           WHERE project_id = ?`
        )
        .run(projectId)
      const nextHostGeneration = resolver.resolveProject(
        database.getProject(projectId)
      )
      raw
        .prepare(
          `UPDATE project_runtime_validations
           SET runtime_bundle_digest = ?
           WHERE project_id = ?`
        )
        .run(`sha256:${'e'.repeat(64)}`, projectId)
      const nextRuntimeGeneration = resolver.resolveProject(
        database.getProject(projectId)
      )

      expect(nextHostGeneration.cacheIdentity).not.toBe(
        baseline.cacheIdentity
      )
      expect(nextRuntimeGeneration.cacheIdentity).not.toBe(
        nextHostGeneration.cacheIdentity
      )
    } finally {
      raw.close()
      database.close()
      await rm(directory, { recursive: true, force: true })
    }
  })
})

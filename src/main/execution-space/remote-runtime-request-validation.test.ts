import { describe, expect, it } from 'vitest'
import type { SshExecutionSpaceDescriptor } from './execution-space-resolver'
import { assertRemoteRuntimeRequestValidated } from './remote-runtime-request-validation'

const digest = `sha256:${'a'.repeat(64)}`

function descriptor(): SshExecutionSpaceDescriptor {
  return {
    kind: 'ssh',
    hostId: 'host-1',
    remoteRootPath: '/srv/project',
    validation: {
      hostRevision: 1,
      hostKeyGeneration: 1,
      remoteUsername: 'builder',
      workspaceIdentity: 'workspace-1',
      agentProtocolMajor: 1,
      agentInstallationIdAtValidation: 'installation-1',
      agentBinaryDigestAtValidation: digest,
      agentVersionAtValidation: '1.0.0',
      agentArchitectureAtValidation: 'x64',
      validatedAt: '2026-08-21T00:00:00.000Z'
    },
    runtimeValidation: {
      runtimeSelectionKey: 'opencode:default',
      runtimeBundleDigest: digest,
      runtimeAdapterDigest: digest,
      agentInstallationIdAtValidation: 'installation-1',
      validatedAt: '2026-08-21T00:00:00.000Z',
      workMode: 'ask'
    },
    cacheIdentity: 'ssh-cache',
    routeIdentity: 'ssh-route',
    workspaceAccess: {} as SshExecutionSpaceDescriptor['workspaceAccess']
  }
}

describe('assertRemoteRuntimeRequestValidated', () => {
  it('accepts complete evidence from the current Agent installation', () => {
    expect(() =>
      assertRemoteRuntimeRequestValidated(descriptor())
    ).not.toThrow()
  })

  it('does not couple current requests to a persisted model profile or work mode', () => {
    const changedRequestEvidence = descriptor()
    changedRequestEvidence.runtimeValidation = {
      ...changedRequestEvidence.runtimeValidation!,
      runtimeSelectionKey:
        'opencode:00000000-0000-4000-8000-000000000099',
      workMode: 'execute'
    }

    expect(() =>
      assertRemoteRuntimeRequestValidated(changedRequestEvidence)
    ).not.toThrow()
  })

  it('rejects missing or cross-installation evidence', () => {
    expect(() =>
      assertRemoteRuntimeRequestValidated(
        { ...descriptor(), runtimeValidation: undefined }
      )
    ).toThrow('缺少完整')
    expect(() =>
      assertRemoteRuntimeRequestValidated(
        {
          ...descriptor(),
          runtimeValidation: {
            ...descriptor().runtimeValidation!,
            agentInstallationIdAtValidation: 'installation-2'
          }
        }
      )
    ).toThrow('缺少完整')
  })
})

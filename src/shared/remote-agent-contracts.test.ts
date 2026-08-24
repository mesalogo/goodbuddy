import { describe, expect, it } from 'vitest'
import {
  REMOTE_WORKSPACE_LIMITS,
  acpJournalCursorSchema,
  assertRemoteWorkspaceWriteTextAtomicDigest,
  createRemoteWorkspaceWriteTextAtomicRequest,
  remoteAbsolutePathSchema,
  remoteGitDiffResultSchema,
  assertRemotePromptAcceptanceMatchesPreparation,
  remotePromptOperationAcceptanceSchema,
  remotePromptOperationPreparationSchema,
  remoteRelativePathSchema,
  remoteWorkspaceApplyChangeSetRequestSchema,
  remoteWorkspaceHandleSchema,
  remoteWorkspaceReadTextResultSchema,
  remoteWorkspaceValidateRequestSchema,
  remoteWorkspaceWriteResultSchema,
  runtimeSessionBindingSchema
} from './remote-agent-contracts'

const digest = `sha256:${'a'.repeat(64)}`

const binding = {
  bindingId: 'binding-1',
  controllerId: 'controller-1',
  controllerGeneration: 1,
  conversationId: 'conversation-1',
  hostId: 'host-1',
  hostRevision: 1,
  hostKeyGeneration: 1,
  workspaceIdentity: 'workspace-1',
  agentInstallationId: 'installation-1',
  daemonBootIdAtOpen: 'boot-1',
  runtimeId: 'runtime-1',
  runtimeBundleDigest: digest,
  runtimeAdapterDigest: digest,
  acpSessionId: 'session-1',
  acpCapabilitiesDigest: digest,
  state: 'ready' as const,
  promptSequence: 0,
  channelEpoch: '1',
  lastOutboundJournaledSequence: '2',
  lastOutboundDeliveredSequence: '1',
  lastInboundJournaledSequence: '3',
  lastMainAckSequence: '2'
}

describe('remote Agent contracts', () => {
  it('accepts a consistent durable Runtime binding', () => {
    expect(runtimeSessionBindingSchema.parse(binding)).toEqual(binding)
  })

  it('requires prompt operation identity while a prompt is running', () => {
    expect(() =>
      runtimeSessionBindingSchema.parse({
        ...binding,
        state: 'prompt-running'
      })
    ).toThrow(/operation identity/iu)
  })

  it('retains operation identity for reconciliation and unknown outcomes', () => {
    for (const state of ['reconciling', 'outcome-unknown'] as const) {
      expect(() =>
        runtimeSessionBindingSchema.parse({
          ...binding,
          state
        })
      ).toThrow(/operation identity/iu)
      expect(
        runtimeSessionBindingSchema.parse({
          ...binding,
          state,
          activePromptOperationId: 'operation-1'
        }).activePromptOperationId
      ).toBe('operation-1')
    }
  })

  it('uses workMode as the complete prompt authorization contract', () => {
    const common = {
      bindingId: 'binding-1',
      operationId: 'operation-1',
      requestId: 'operation-1',
      controllerId: 'controller-1',
      controllerGeneration: 1,
      connectionGeneration: 1,
      channelEpoch: '1',
      hostId: 'host-1',
      hostRevision: 1,
      hostKeyGeneration: 1,
      workspaceIdentity: 'workspace-1',
      agentInstallationId: 'installation-1',
      runtimeId: 'runtime-1',
      runtimeBundleDigest: digest,
      runtimeAdapterDigest: digest,
      deadlineAt: '2030-01-01T00:00:00.000Z',
      budget: {
        maximumInputBytes: 10,
        maximumOutputBytes: 100
      }
    }
    const execute = remotePromptOperationPreparationSchema.parse({
      ...common,
      workMode: 'execute'
    })
    expect(execute.workMode).toBe('execute')
    expect(execute).not.toHaveProperty('trustTier')
    expect(execute).not.toHaveProperty('capabilities')
    expect(execute.budget).not.toHaveProperty('maximumToolCalls')
    const acceptance = remotePromptOperationAcceptanceSchema.parse({
      bindingId: execute.bindingId,
      operationId: execute.operationId,
      requestId: execute.requestId,
      workMode: execute.workMode,
      deadlineAt: execute.deadlineAt,
      acceptedAt: '2029-01-01T00:00:00.000Z'
    })
    expect(() =>
      assertRemotePromptAcceptanceMatchesPreparation(execute, acceptance)
    ).not.toThrow()
    expect(() =>
      assertRemotePromptAcceptanceMatchesPreparation(execute, {
        ...acceptance,
        workMode: 'ask'
      })
    ).toThrow(/does not match/iu)
  })

  it('rejects delivered and ACK cursors ahead of durable journals', () => {
    expect(() =>
      runtimeSessionBindingSchema.parse({
        ...binding,
        lastOutboundDeliveredSequence: '3'
      })
    ).toThrow(/Delivered cursor/iu)
    expect(() =>
      acpJournalCursorSchema.parse({
        bindingId: 'binding-1',
        channelEpoch: '1',
        direction: 'runtime-to-main',
        journaledSequence: '1',
        deliveredSequence: '0',
        mainAckSequence: '2'
      })
    ).toThrow(/ACK cursor/iu)
  })

  it('validates UTF-8 path bytes and prevents traversal', () => {
    expect(remoteAbsolutePathSchema.parse('/srv/项目')).toBe('/srv/项目')
    expect(remoteRelativePathSchema.parse('')).toBe('')
    expect(remoteRelativePathSchema.parse('src/文件.ts')).toBe(
      'src/文件.ts'
    )
    for (const path of [
      '../secret',
      'src/../secret',
      '/etc/passwd',
      'C:/Windows',
      'src\\secret',
      'src//secret',
      'src/\0secret'
    ]) {
      expect(() => remoteRelativePathSchema.parse(path)).toThrow()
    }
    expect(() =>
      remoteRelativePathSchema.parse(
        `${'界'.repeat(
          Math.floor(
            REMOTE_WORKSPACE_LIMITS.maximumPathSegmentBytes / 3
          ) + 1
        )}`
      )
    ).toThrow(/oversized/iu)
  })

  it('keeps validate and handle contracts strict and capability-safe', () => {
    const request = {
      remoteRootPath: '/srv/project',
      requestedAccess: 'read-only' as const,
      requiredCapabilities: ['list', 'read-text'] as const
    }
    expect(remoteWorkspaceValidateRequestSchema.parse(request)).toEqual(
      request
    )
    expect(() =>
      remoteWorkspaceValidateRequestSchema.parse({
        ...request,
        controllerId: 'controller-must-come-from-connection'
      })
    ).toThrow()
    expect(() =>
      remoteWorkspaceHandleSchema.parse({
        workspaceId: 'workspace-1',
        workspaceIdentity: 'identity-1',
        canonicalDisplayPath: '/srv/project',
        access: 'read-only',
        git: 'available',
        capabilities: ['list', 'write-text-atomic'],
        generation: 1
      })
    ).toThrow(/Read-only/iu)
  })

  it('checks response byte counts instead of UTF-16 character counts', () => {
    expect(
      remoteWorkspaceReadTextResultSchema.parse({
        relativePath: '你好.txt',
        content: '你好',
        offsetBytes: 0,
        bytesRead: 6,
        totalBytes: 6,
        digest,
        truncated: false
      }).bytesRead
    ).toBe(6)
    expect(() =>
      remoteWorkspaceReadTextResultSchema.parse({
        relativePath: '你好.txt',
        content: '你好',
        offsetBytes: 0,
        bytesRead: 2,
        totalBytes: 6,
        digest,
        truncated: false
      })
    ).toThrow(/UTF-8/iu)
    expect(() =>
      remoteGitDiffResultSchema.parse({
        repositoryIdentity: 'repository-1',
        patch: '你好',
        byteLength: 2,
        truncated: false
      })
    ).toThrow(/UTF-8/iu)
  })

  it('creates a stable write digest without accepting a controller identity', async () => {
    const request = await createRemoteWorkspaceWriteTextAtomicRequest({
      operationId: 'operation-1',
      workspaceIdentity: 'identity-1',
      workspaceId: 'workspace-1',
      generation: 1,
      relativePath: 'src/a.ts',
      content: '你好',
      expectedDigest: 'absent',
      executable: false
    })
    expect(request.payloadDigest).toBe(
      'sha256:0cf6995c6aa406a5bb1b6a0d2e15955ca3b89ddec26a20f47eaacef02339bea6'
    )
    const reordered = await createRemoteWorkspaceWriteTextAtomicRequest({
      content: '你好',
      relativePath: 'src/a.ts',
      generation: 1,
      workspaceId: 'workspace-1',
      executable: false,
      expectedDigest: 'absent',
      workspaceIdentity: 'identity-1',
      operationId: 'operation-1'
    })
    expect(reordered).toEqual(request)
    expect(request).not.toHaveProperty('controllerId')
    await expect(
      assertRemoteWorkspaceWriteTextAtomicDigest(
        { ...request, content: 'changed after digest' },
        'identity-1'
      )
    ).rejects.toThrow(/digest/iu)
  })

  it('enforces idempotent write terminal metadata and bounded unique change sets', () => {
    expect(
      remoteWorkspaceWriteResultSchema.parse({
        operationId: 'operation-1',
        payloadDigest: digest,
        status: 'completed',
        relativePath: 'src/a.ts',
        previousDigest: 'absent',
        resultDigest: digest,
        byteLength: 3
      }).status
    ).toBe('completed')
    expect(() =>
      remoteWorkspaceWriteResultSchema.parse({
        operationId: 'operation-1',
        payloadDigest: digest,
        status: 'completed',
        relativePath: 'src/a.ts'
      })
    ).toThrow(/metadata/iu)
    expect(() =>
      remoteWorkspaceApplyChangeSetRequestSchema.parse({
        operationId: 'operation-1',
        payloadDigest: digest,
        workspaceId: 'workspace-1',
        generation: 1,
        workspaceIdentity: 'identity-1',
        changes: [
          {
            relativePath: 'a.ts',
            action: 'delete',
            expectedDigest: digest
          },
          {
            relativePath: 'a.ts',
            action: 'delete',
            expectedDigest: digest
          }
        ]
      })
    ).toThrow(/unique/iu)
  })
})

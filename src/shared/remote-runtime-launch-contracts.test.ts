import { describe, expect, it } from 'vitest'
import { createOperationIdentity } from './agent-protocol/canonical'
import {
  REMOTE_RUNTIME_LAUNCH_LIMITS,
  assertDetachedRemoteRuntimeBundleDigest,
  assertRemoteRuntimeOperationDigest,
  createRemoteRuntimeQueryRequest,
  createRemoteRuntimeStartRequest,
  createRemoteRuntimeStopRequest,
  detachedSignedRemoteRuntimeBundleSchema,
  digestRemoteRuntimeBundleIdentity,
  digestRemoteRuntimeBundleManifest,
  remoteRuntimeQueryRequestSchema,
  remoteRuntimeQueryResultSchema,
  remoteRuntimeStartRequestSchema,
  remoteRuntimeStartResultSchema,
  remoteRuntimeStopRequestSchema,
  remoteRuntimeStopResultSchema
} from './remote-runtime-launch-contracts'

const digest = `sha256:${'a'.repeat(64)}`
const rawDigest = 'a'.repeat(64)
const deadlineAt = '2030-01-01T00:00:00.000Z'

const manifest = {
  formatVersion: 2 as const,
  product: 'GoodBuddy' as const,
  runtimeId: 'runtime-1',
  runtimeVersion: '1.0.0',
  provider: 'opencode' as const,
  platform: 'linux' as const,
  architecture: 'x64' as const,
  signingKeyId: 'release-1',
  bundleDigest: digest,
  adapterDigest: digest,
  sourcePackage: {
    name: 'opencode-linux-x64-baseline',
    integrity:
      'sha512-x4KiJk9EF7ktM18Ru5Jue4kTntxMvlhWb7tHniQGGRvY2KeoK1iIkyAFd7ri5H/fSkM22hNv/Gg1Jk6/h9IlxQ=='
  },
  entrypoint: {
    identity: 'opencode-acp',
    path: 'bin/opencode-acp',
    sha256: rawDigest,
    argvPrefix: ['acp']
  },
  files: [
    {
      path: 'bin/opencode-acp',
      size: 100,
      sha256: rawDigest,
      mode: '0755' as const
    },
    {
      path: 'licenses/runtime.txt',
      size: 10,
      sha256: rawDigest,
      mode: '0644' as const
    }
  ],
  licenses: [
    {
      package: 'runtime',
      version: '1.0.0',
      spdx: 'MIT',
      path: 'licenses/runtime.txt'
    }
  ],
  allowedEnvironmentNames: ['HOME', 'LANG'] as const,
  protocol: { major: 1, minor: 0 },
  acpCapabilitiesDigest: digest,
  limits: {
    maximumPromptRuntimeMilliseconds: 60_000,
    maximumPromptInputBytes: 4096,
    maximumPromptOutputBytes: 1024
  }
}

const signedBundle = {
  manifest,
  detachedSignature: {
    manifestDigest: digest,
    algorithm: 'ed25519' as const,
    keyId: 'release-1',
    signatureBase64: `${'A'.repeat(86)}==`
  }
}

const commonPreparation = {
  bindingId: 'binding-1',
  operationId: 'operation-1',
  requestId: 'request-1',
  workMode: 'ask' as const,
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
  deadlineAt,
  budget: {
    maximumInputBytes: 10,
    maximumOutputBytes: 100
  }
}

const startPayload = {
  bindingId: 'binding-1',
  requestId: 'request-1',
  workMode: 'ask' as const,
  runtimeId: 'runtime-1',
  adapterParameters: [
    { name: 'modelProfileId' as const, value: 'model-1' }
  ],
  deadlineAt,
  budget: commonPreparation.budget
}

async function operationRequest<T>(
  method: string,
  operationId: string,
  requestId: string,
  payload: T
) {
  return {
    identity: await createOperationIdentity({
      controllerId: 'controller-1',
      operationId,
      scope: {
        kind: 'run',
        sessionId: 'binding-1',
        requestId
      },
      method,
      payload
    }),
    payload
  }
}

const forbiddenLaunchFields = [
  { executable: '/bin/sh' },
  { cwd: '/tmp' },
  { env: { TOKEN: 'secret' } },
  { unit: 'runtime.service' },
  { systemdProperties: ['Delegate=yes'] },
  { network: 'host' },
  { mount: '/etc:/host' },
  { mounts: ['/etc:/host'] },
  { shell: true },
  { pid: 123 },
  { signal: 'SIGKILL' }
]

describe('remote Runtime launch contracts', () => {
  it.each(['deepseek-harness', 'opencode', 'continue'] as const)(
    'accepts a detached-signed %s bundle without signature metadata in signed bytes',
    (provider) => {
      const parsed = detachedSignedRemoteRuntimeBundleSchema.parse({
        ...signedBundle,
        manifest: { ...manifest, provider }
      })
      expect(parsed.manifest.provider).toBe(provider)
      expect(parsed.manifest).not.toHaveProperty('manifestDigest')
      expect(parsed.manifest).not.toHaveProperty('signature')
    }
  )

  it('binds detached keys, entrypoint files, licenses, and unique environment names', () => {
    expect(() =>
      detachedSignedRemoteRuntimeBundleSchema.parse({
        ...signedBundle,
        detachedSignature: {
          ...signedBundle.detachedSignature,
          keyId: 'other-key'
        }
      })
    ).toThrow(/key/iu)
    expect(() =>
      detachedSignedRemoteRuntimeBundleSchema.parse({
        ...signedBundle,
        manifest: {
          ...manifest,
          entrypoint: { ...manifest.entrypoint, sha256: 'b'.repeat(64) }
        }
      })
    ).toThrow(/entrypoint/iu)
    expect(() =>
      detachedSignedRemoteRuntimeBundleSchema.parse({
        ...signedBundle,
        manifest: {
          ...manifest,
          licenses: [
            { ...manifest.licenses[0], path: 'licenses/missing.txt' }
          ]
        }
      })
    ).toThrow(/licenses/iu)
    expect(() =>
      detachedSignedRemoteRuntimeBundleSchema.parse({
        ...signedBundle,
        manifest: {
          ...manifest,
          allowedEnvironmentNames: ['HOME', 'HOME']
        }
      })
    ).toThrow(/unique/iu)
  })

  it('bounds prompt limits and fixed argv', () => {
    expect(
      detachedSignedRemoteRuntimeBundleSchema.parse(signedBundle)
    ).toEqual(signedBundle)
    expect(() =>
      detachedSignedRemoteRuntimeBundleSchema.parse({
        ...signedBundle,
        manifest: {
          ...manifest,
          limits: {
            ...manifest.limits,
            maximumPromptInputBytes:
              REMOTE_RUNTIME_LAUNCH_LIMITS.maximumPromptInputBytes + 1
          }
        }
      })
    ).toThrow()
    expect(() =>
      detachedSignedRemoteRuntimeBundleSchema.parse({
        ...signedBundle,
        manifest: {
          ...manifest,
          entrypoint: {
            ...manifest.entrypoint,
            argvPrefix: Array(
              REMOTE_RUNTIME_LAUNCH_LIMITS.maximumFixedArgumentCount + 1
            ).fill('x')
          }
        }
      })
    ).toThrow()
  })

  it('keeps one current prompt-limits manifest contract', () => {
    const parsed = detachedSignedRemoteRuntimeBundleSchema.parse({
      ...signedBundle,
      manifest
    })
    expect(parsed.manifest.formatVersion).toBe(2)
    expect(parsed.manifest).toHaveProperty('limits')
    expect(Object.keys(parsed.manifest)).not.toContain('quotas')
  })

  it('verifies the detached digest over manifest bytes only', async () => {
    const bundleDigest =
      await digestRemoteRuntimeBundleIdentity(manifest)
    const digestBoundManifest = { ...manifest, bundleDigest }
    const manifestDigest =
      await digestRemoteRuntimeBundleManifest(digestBoundManifest)
    const validBundle = {
      ...signedBundle,
      manifest: digestBoundManifest,
      detachedSignature: {
        ...signedBundle.detachedSignature,
        manifestDigest
      }
    }
    await expect(
      assertDetachedRemoteRuntimeBundleDigest(validBundle)
    ).resolves.toEqual(validBundle)
    await expect(
      assertDetachedRemoteRuntimeBundleDigest(signedBundle)
    ).rejects.toThrow(/digest does not match/iu)
  })

  it('constructs the exact start operation identity and canonical digest', async () => {
    const request = await createRemoteRuntimeStartRequest({
      controllerId: 'controller-1',
      operationId: 'start-operation-1',
      prompt: commonPreparation,
      adapterParameters: startPayload.adapterParameters,
      deadlineAt
    })
    expect(request.identity.method).toBe('runtime/startPrompt')
    expect(request.identity.scope).toEqual({
      kind: 'run',
      sessionId: 'binding-1',
      requestId: 'request-1'
    })
    const expected = await createOperationIdentity({
      controllerId: 'controller-1',
      operationId: 'start-operation-1',
      scope: request.identity.scope,
      method: 'runtime/startPrompt',
      payload: request.payload
    })
    expect(request.identity.payloadDigest).toBe(expected.payloadDigest)
    expect(request.payload.workMode).toBe('ask')
    await expect(
      createRemoteRuntimeStartRequest({
        controllerId: 'controller-1',
        operationId: commonPreparation.operationId,
        prompt: commonPreparation,
        deadlineAt: '2031-01-01T00:00:00.000Z'
      })
    ).rejects.toThrow(/prompt deadline/iu)
  })

  it('rejects caller digest mismatches', async () => {
    const valid = await operationRequest(
      'runtime/startPrompt',
      'start-operation-1',
      'request-1',
      startPayload
    )
    const changedPayload = {
      ...startPayload,
      runtimeId: 'runtime-2'
    }
    await expect(
      assertRemoteRuntimeOperationDigest({
        ...valid,
        payload: changedPayload
      })
    ).rejects.toThrow(/digest does not match/iu)
    await expect(
      assertRemoteRuntimeOperationDigest(valid)
    ).resolves.toBeUndefined()
    await expect(
      assertRemoteRuntimeOperationDigest({
        ...valid,
        identity: { ...valid.identity, payloadDigest: digest }
      })
    ).rejects.toThrow(/digest does not match/iu)
  })

  it('rejects adapter flag and path tunneling plus all process-control fields', async () => {
    for (const value of [
      '--flag',
      '/tmp/model',
      'models/model',
      'models\\model',
      '..'
    ]) {
      await expect(
        createRemoteRuntimeStartRequest({
          controllerId: 'controller-1',
          operationId: 'start-operation-1',
          prompt: commonPreparation,
          adapterParameters: [
            { name: 'modelProfileId', value }
          ],
          deadlineAt
        })
      ).rejects.toThrow()
    }
    const valid = await operationRequest(
      'runtime/startPrompt',
      'start-operation-1',
      'request-1',
      startPayload
    )
    for (const forbidden of forbiddenLaunchFields) {
      expect(() =>
        remoteRuntimeStartRequestSchema.parse({
          ...valid,
          payload: { ...startPayload, ...forbidden }
        })
      ).toThrow()
    }
  })

  it('operation-binds start results and canonical stop/query requests', async () => {
    const startResult = {
      launchId: 'launch-1',
      processId: 'process-opaque-1',
      startOperationId: 'start-operation-1',
      bindingId: 'binding-1',
      runtimeId: 'runtime-1',
      supervisorIdentityDigest: digest,
      state: 'running' as const,
      acceptedAt: deadlineAt
    }
    expect(remoteRuntimeStartResultSchema.parse(startResult)).toEqual(
      startResult
    )
    const stopPayload = {
      launchId: 'launch-1',
      bindingId: 'binding-1',
      runtimeId: 'runtime-1',
      startOperationId: 'start-operation-1',
      requestId: 'stop-request-1',
      reason: 'user-cancelled' as const,
      deadlineAt
    }
    const stop = await createRemoteRuntimeStopRequest({
      controllerId: 'controller-1',
      operationId: 'stop-1',
      payload: stopPayload
    })
    expect(remoteRuntimeStopRequestSchema.parse(stop)).toEqual(stop)
    const query = await createRemoteRuntimeQueryRequest({
      controllerId: 'controller-1',
      operationId: 'query-1',
      payload: {
        launchId: 'launch-1',
        bindingId: 'binding-1',
        runtimeId: 'runtime-1',
        startOperationId: 'start-operation-1',
        requestId: 'query-request-1'
      }
    })
    expect(remoteRuntimeQueryRequestSchema.parse(query)).toEqual(query)
    expect(() =>
      remoteRuntimeStopRequestSchema.parse({
        ...stop,
        identity: { ...stop.identity, method: 'runtime/startPrompt' }
      })
    ).toThrow(/method/iu)
    expect(() =>
      remoteRuntimeQueryRequestSchema.parse({
        ...query,
        payload: { ...query.payload, bindingId: 'other-binding' }
      })
    ).toThrow(/scope/iu)
    for (const forbidden of forbiddenLaunchFields) {
      expect(() =>
        remoteRuntimeStopRequestSchema.parse({
          ...stop,
          payload: { ...stop.payload, ...forbidden }
        })
      ).toThrow()
      expect(() =>
        remoteRuntimeQueryRequestSchema.parse({
          ...query,
          payload: { ...query.payload, ...forbidden }
        })
      ).toThrow()
    }
  })

  it('requires ownership identity in stop results and finite reconciliation state', () => {
    const stopResult = {
      launchId: 'launch-1',
      operationId: 'stop-1',
      startOperationId: 'start-operation-1',
      bindingId: 'binding-1',
      runtimeId: 'runtime-1',
      supervisorIdentityDigest: digest,
      state: 'stopped' as const,
      acceptedAt: deadlineAt
    }
    expect(remoteRuntimeStopResultSchema.parse(stopResult)).toEqual(
      stopResult
    )
    const baseQueryResult = {
      launchId: 'launch-1',
      queryOperationId: 'query-1',
      startOperationId: 'start-operation-1',
      bindingId: 'binding-1',
      runtimeId: 'runtime-1',
      supervisorIdentityDigest: digest,
      output: {
        effectiveCapturedOutputLimitBytes: 1024,
        stdoutBytes: 10,
        stderrBytes: 2,
        truncated: false
      }
    }
    expect(
      remoteRuntimeQueryResultSchema.parse({
        ...baseQueryResult,
        state: 'interrupted',
        processTreeState: 'orphaned',
        errorCode: 'process-tree-orphaned'
      }).state
    ).toBe('interrupted')
    expect(
      remoteRuntimeQueryResultSchema.parse({
        ...baseQueryResult,
        state: 'outcome-unknown',
        processTreeState: 'outcome-unknown',
        errorCode: 'supervisor-unavailable'
      }).state
    ).toBe('outcome-unknown')
    expect(() =>
      remoteRuntimeQueryResultSchema.parse({
        ...baseQueryResult,
        state: 'identity-conflict',
        processTreeState: 'reconciled',
        errorCode: 'identity-mismatch'
      })
    ).toThrow(/inconsistent/iu)
    for (const invalid of [
      { state: 'running', processTreeState: 'terminated' },
      { state: 'stopped', processTreeState: 'pending' },
      { state: 'stopped', processTreeState: 'orphaned' }
    ] as const) {
      expect(() =>
        remoteRuntimeQueryResultSchema.parse({
          ...baseQueryResult,
          ...invalid
        })
      ).toThrow(/inconsistent/iu)
    }
    expect(() =>
      remoteRuntimeQueryResultSchema.parse({
        ...baseQueryResult,
        state: 'running',
        processTreeState: 'reconciled',
        output: {
          effectiveCapturedOutputLimitBytes: 10,
          stdoutBytes: 8,
          stderrBytes: 3,
          truncated: true
        }
      })
    ).toThrow(/aggregate limit/iu)
    expect(() =>
      remoteRuntimeQueryResultSchema.parse({
        ...baseQueryResult,
        state: 'running',
        processTreeState: 'reconciled',
        output: {
          effectiveCapturedOutputLimitBytes:
            REMOTE_RUNTIME_LAUNCH_LIMITS.maximumCapturedOutputBytes,
          stdoutBytes:
            REMOTE_RUNTIME_LAUNCH_LIMITS.maximumCapturedOutputBytes,
          stderrBytes: 1,
          truncated: true
        }
      })
    ).toThrow(/aggregate limit/iu)
    expect(() =>
      remoteRuntimeQueryResultSchema.parse({
        ...baseQueryResult,
        state: 'running',
        processTreeState: 'reconciled',
        diagnostic: 'arbitrary process text'
      })
    ).toThrow()
  })
})

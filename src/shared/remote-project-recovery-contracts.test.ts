import { describe, expect, it } from 'vitest'
import {
  REMOTE_PROJECT_RECOVERY_LIMITS,
  remoteProjectRecoveryStateSchema
} from './remote-project-recovery-contracts'

const projectId = '00000000-0000-4000-8000-000000000101'
const requestId = '00000000-0000-4000-8000-000000000201'

describe('remote project recovery contracts', () => {
  it('accepts decimal cursor progress', () => {
    expect(
      remoteProjectRecoveryStateSchema.parse({
        projectId,
        requestId,
        stage: 'cursor',
        current: '125'
      })
    ).toEqual({
      projectId,
      requestId,
      stage: 'cursor',
      current: '125'
    })
  })

  it('rejects extra fields', () => {
    expect(
      remoteProjectRecoveryStateSchema.safeParse({
        projectId,
        requestId,
        stage: 'agent',
        detail: 'not part of the renderer contract'
      }).success
    ).toBe(false)
    expect(
      remoteProjectRecoveryStateSchema.safeParse({
        projectId,
        requestId,
        stage: 'cursor',
        current: '3',
        total: '2'
      }).success
    ).toBe(false)
  })

  it('bounds failure messages and requires retryability', () => {
    expect(
      remoteProjectRecoveryStateSchema.safeParse({
        projectId,
        requestId,
        stage: 'failed',
        message: 'x'.repeat(
          REMOTE_PROJECT_RECOVERY_LIMITS.maximumFailureMessageLength + 1
        ),
        retryable: true
      }).success
    ).toBe(false)
    expect(
      remoteProjectRecoveryStateSchema.safeParse({
        projectId,
        requestId,
        stage: 'failed',
        message: 'Host unavailable'
      }).success
    ).toBe(false)
  })
})

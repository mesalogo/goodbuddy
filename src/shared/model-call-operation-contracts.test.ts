import { describe, expect, it } from 'vitest'
import {
  completeModelCallEvidenceSchema,
  failModelCallEvidenceSchema,
  modelCallDispatchMetadataSchema,
  modelCallRecordSchema,
  prepareModelCallSchema
} from './model-call-operation-contracts'

const identity = {
  callOperationId: 'call-1',
  requestId: 'request-1',
  bindingId: 'binding-1',
  promptOperationId: 'prompt-1',
  promptSequence: 0,
  roundIndex: 0,
  provider: 'provider',
  profile: 'default',
  model: 'model',
  protocol: 'responses-v1'
}
const policy = {
  modelProfileDigest: `sha256:${'b'.repeat(64)}`
}

describe('model call operation contracts', () => {
  it('rejects secret or payload fields at every persistence boundary', () => {
    const digest = `sha256:${'a'.repeat(64)}`
    expect(() =>
      prepareModelCallSchema.parse({
        identity,
        requestDigest: digest,
        ...policy,
        prompt: 'secret prompt'
      })
    ).toThrow()
    expect(() =>
      prepareModelCallSchema.parse({
        identity: { ...identity, apiKey: 'secret-key' },
        requestDigest: digest,
        ...policy
      })
    ).toThrow()
    expect(() =>
      modelCallDispatchMetadataSchema.parse({
        providerIdempotencyKey: 'safe-id',
        requestBody: { messages: [] }
      })
    ).toThrow()
    expect(() =>
      completeModelCallEvidenceSchema.parse({
        status: 'completed',
        providerResponseId: 'response-1',
        responseBody: 'secret response'
      })
    ).toThrow()
    expect(() =>
      failModelCallEvidenceSchema.parse({
        status: 'failed-definitive',
        error: {
          code: 'authentication',
          retryable: false,
          message: 'credential was secret-value'
        }
      })
    ).toThrow()
  })

  it('bounds provider identifiers and safe terminal metadata', () => {
    expect(() =>
      modelCallDispatchMetadataSchema.parse({
        providerRequestId: 'x'.repeat(257)
      })
    ).toThrow()
    expect(() =>
      completeModelCallEvidenceSchema.parse({
        status: 'completed',
        result: { finishReason: 'x'.repeat(129) }
      })
    ).toThrow()
  })

  it('tags terminal evidence and enforces record state consistency', () => {
    const base = {
      identity,
      requestDigest: `sha256:${'a'.repeat(64)}`,
      ...policy,
      preparedAt: 1,
      updatedAt: 3,
      dispatchedAt: 2,
      dispatchMetadata: {}
    }
    expect(() =>
      modelCallRecordSchema.parse({
        ...base,
        status: 'completed',
        terminalAt: 3,
        terminalEvidence: {
          status: 'failed-definitive',
          error: { code: 'authentication', retryable: false }
        }
      })
    ).toThrow()
    expect(() =>
      modelCallRecordSchema.parse({
        ...base,
        status: 'prepared'
      })
    ).toThrow()
    expect(() =>
      modelCallRecordSchema.parse({
        ...base,
        status: 'dispatched',
        updatedAt: 1
      })
    ).toThrow()
  })

  it('rejects prompt-wide quota fields', () => {
    const request = {
      identity,
      requestDigest: `sha256:${'a'.repeat(64)}`,
      ...policy
    }
    expect(prepareModelCallSchema.parse(request)).toEqual(request)
    expect(() =>
      prepareModelCallSchema.parse({
        ...request,
        maximumOutputTokens: 65_537,
        maximumModelCalls: 100_000,
        maximumTotalOutputTokens: 1_000_000_000
      })
    ).toThrow()
  })
})

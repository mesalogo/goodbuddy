import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import type {
  ModelCallIdentity,
  PrepareModelCall
} from '../../shared/model-call-operation-contracts'
import {
  ModelCallCapacityError,
  ModelCallConflictError,
  ModelCallOperationStore,
  ModelCallStateError
} from './model-call-operation-store'

const directories: string[] = []
const digestA = `sha256:${'a'.repeat(64)}`
const digestB = `sha256:${'b'.repeat(64)}`
const profileDigest = `sha256:${'c'.repeat(64)}`
const policy = {
  modelProfileDigest: profileDigest
}
const identity: ModelCallIdentity = {
  callOperationId: 'call-1',
  requestId: 'request-1',
  bindingId: 'binding-1',
  promptOperationId: 'prompt-1',
  promptSequence: 0,
  roundIndex: 0,
  provider: 'openai',
  profile: 'work',
  model: 'gpt-model',
  protocol: 'responses-v1'
}
const prepared: PrepareModelCall = {
  identity,
  requestDigest: digestA,
  ...policy
}

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })
    )
  )
})

async function createPath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'goodbuddy-model-calls-'))
  directories.push(directory)
  return join(directory, 'model-calls.sqlite')
}

function operation(callOperationId: string, roundIndex: number): PrepareModelCall {
  return {
    identity: {
      ...identity,
      callOperationId,
      promptOperationId: `prompt-${callOperationId}`,
      roundIndex: 0
    },
    requestDigest: roundIndex % 2 === 0 ? digestA : digestB,
    ...policy
  }
}

function completeCall(
  store: ModelCallOperationStore,
  callOperationId: string
): void {
  store.beginDispatch(callOperationId)
  store.complete(callOperationId, { status: 'completed' })
  store.markResponseDelivered(callOperationId)
}

describe('ModelCallOperationStore', () => {
  it('durably preserves prepared and dispatched crash states in WAL mode', async () => {
    const path = await createPath()
    const store = new ModelCallOperationStore(path)
    store.prepare(prepared)
    store.prepare({
      identity: {
        ...identity,
        callOperationId: 'call-2',
        promptOperationId: 'prompt-2',
        roundIndex: 0
      },
      requestDigest: digestB,
      ...policy
    })
    expect(store.beginDispatch('call-2').permitted).toBe(true)
    store.close()

    const check = new DatabaseSync(path)
    expect(
      (check.prepare('PRAGMA journal_mode').get() as { journal_mode: string })
        .journal_mode
    ).toBe('wal')
    check.close()

    const reopened = new ModelCallOperationStore(path)
    expect(reopened.get('call-1')?.status).toBe('prepared')
    expect(reopened.get('call-1')?.dispatchMetadata).toBeUndefined()
    expect(reopened.get('call-2')?.status).toBe('dispatched')
    expect(reopened.beginDispatch('call-2').permitted).toBe(false)
    expect(reopened.listUnresolved().map((record) => record.status)).toEqual([
      'prepared',
      'dispatched'
    ])
    reopened.close()
  })

  it('idempotently prepares the same digest and conflicts on changed identity or digest', async () => {
    const store = new ModelCallOperationStore(await createPath())
    expect(store.prepare(prepared).created).toBe(true)
    expect(store.prepare(prepared).created).toBe(false)
    expect(() =>
      store.prepare({ ...prepared, requestDigest: digestB })
    ).toThrow(ModelCallConflictError)
    expect(() =>
      store.prepare({
        ...prepared,
        identity: { ...identity, model: 'different-model' }
      })
    ).toThrow(ModelCallConflictError)
    store.close()
  })

  it('grants only one dispatch permit across concurrent store instances', async () => {
    const path = await createPath()
    const first = new ModelCallOperationStore(path)
    const second = new ModelCallOperationStore(path)
    first.prepare(prepared)

    const claims = await Promise.all([
      Promise.resolve().then(() => first.beginDispatch('call-1')),
      Promise.resolve().then(() => second.beginDispatch('call-1'))
    ])
    expect(claims.filter((claim) => claim.permitted)).toHaveLength(1)
    expect(claims.every((claim) => claim.record.status === 'dispatched')).toBe(
      true
    )
    first.close()
    second.close()
  })

  it('blocks replay after an outcome becomes unknown, including after reopen', async () => {
    const path = await createPath()
    const store = new ModelCallOperationStore(path)
    store.prepare(prepared)
    store.beginDispatch('call-1', {
      providerIdempotencyKey: 'provider-key-1'
    })
    store.markOutcomeUnknown('call-1', {
      status: 'outcome-unknown',
      providerRequestId: 'provider-request-1',
      reason: {
        code: 'connection-lost',
        retryable: false
      }
    })
    expect(store.beginDispatch('call-1').permitted).toBe(false)
    store.close()

    const reopened = new ModelCallOperationStore(path)
    expect(reopened.beginDispatch('call-1').permitted).toBe(false)
    expect(reopened.listUnresolved()).toHaveLength(1)
    expect(reopened.listUnresolved()[0]?.status).toBe('outcome-unknown')
    reopened.close()
  })

  it('makes identical completion idempotent and rejects changed evidence', async () => {
    const store = new ModelCallOperationStore(await createPath(), {
      now: () => 42
    })
    store.prepare(prepared)
    store.beginDispatch('call-1')
    const evidence = {
      status: 'completed' as const,
      providerRequestId: 'request-provider-1',
      providerResponseId: 'response-provider-1',
      result: { finishReason: 'stop', outputDigest: digestB },
      usage: { inputTokens: 10, outputTokens: 5 }
    }
    const completed = store.complete('call-1', evidence)
    expect(store.complete('call-1', evidence)).toEqual(completed)
    expect(() =>
      store.complete('call-1', {
        ...evidence,
        providerResponseId: 'different-response'
      })
    ).toThrow(ModelCallConflictError)
    expect(store.listUnresolved()).toEqual([])
    store.close()
  })

  it('strictly rejects invalid transitions and different terminal outcomes', async () => {
    const store = new ModelCallOperationStore(await createPath())
    store.prepare(prepared)
    expect(() =>
      store.complete('call-1', { status: 'completed' })
    ).toThrow(ModelCallStateError)
    store.beginDispatch('call-1')
    store.failDefinitive('call-1', {
      status: 'failed-definitive',
      error: {
        code: 'authentication',
        retryable: false
      }
    })
    expect(() =>
      store.complete('call-1', { status: 'completed' })
    ).toThrow(ModelCallStateError)
    expect(() =>
      store.markOutcomeUnknown('call-1', {
        status: 'outcome-unknown',
        reason: {
          code: 'uncertain',
          retryable: false
        }
      })
    ).toThrow(ModelCallStateError)
    store.close()
  })

  it('guards closed stores and makes close and dispose idempotent', async () => {
    const store = new ModelCallOperationStore(await createPath())
    store.prepare(prepared)
    store.close()
    expect(() => store.get('call-1')).toThrow(ModelCallStateError)
    expect(() => store.prepare(prepared)).toThrow(ModelCallStateError)
    expect(() => store.beginDispatch('call-1')).toThrow(ModelCallStateError)
    expect(() => store.listUnresolved()).toThrow(ModelCallStateError)
    expect(() => store.close()).not.toThrow()
    expect(() => store.dispose()).not.toThrow()
  })

  it('fails safely when persisted JSON is corrupt', async () => {
    const path = await createPath()
    const store = new ModelCallOperationStore(path)
    store.prepare(prepared)
    store.close()

    const corrupt = new DatabaseSync(path)
    corrupt.exec(`
      PRAGMA ignore_check_constraints = ON;
      UPDATE model_call_operations SET identity_json = '{broken';
    `)
    corrupt.close()

    const reopened = new ModelCallOperationStore(path)
    expect(() => reopened.get('call-1')).toThrow(ModelCallStateError)
    reopened.close()
  })

  it('enforces the hard record cap without dispatching prepared calls', async () => {
    const store = new ModelCallOperationStore(await createPath(), {
      maximumRecords: 2
    })
    store.prepare(operation('call-1', 0))
    store.prepare(operation('call-2', 1))

    expect(() => store.prepare(operation('call-3', 2))).toThrow(
      ModelCallCapacityError
    )
    expect(store.get('call-1')?.status).toBe('prepared')
    expect(store.get('call-2')?.status).toBe('prepared')
    expect(store.get('call-3')).toBeUndefined()
    store.close()
  })

  it('automatically prunes only definitive terminal rows for capacity', async () => {
    const store = new ModelCallOperationStore(await createPath(), {
      maximumRecords: 3
    })
    store.prepare(operation('call-1', 0))
    completeCall(store, 'call-1')
    store.prepare(operation('call-2', 1))
    store.beginDispatch('call-2')
    store.failDefinitive('call-2', {
      status: 'failed-definitive',
      error: { code: 'provider-rejected', retryable: false }
    })
    store.prepare(operation('call-3', 2))
    store.beginDispatch('call-3')

    store.prepare(operation('call-4', 3))
    expect(store.get('call-1')).toBeUndefined()
    expect(store.get('call-2')?.status).toBe('failed-definitive')
    expect(store.get('call-3')?.status).toBe('dispatched')
    expect(store.get('call-4')?.status).toBe('prepared')

    store.prepare(operation('call-5', 4))
    expect(store.get('call-2')).toBeUndefined()
    expect(store.get('call-3')?.status).toBe('dispatched')
    expect(store.get('call-4')?.status).toBe('prepared')
    expect(store.get('call-5')?.status).toBe('prepared')
    store.close()
  })

  it('never prunes dispatched or outcome-unknown rows for capacity', async () => {
    const store = new ModelCallOperationStore(await createPath(), {
      maximumRecords: 2
    })
    store.prepare(operation('call-1', 0))
    store.beginDispatch('call-1')
    store.prepare(operation('call-2', 1))
    store.beginDispatch('call-2')
    store.markOutcomeUnknown('call-2', {
      status: 'outcome-unknown',
      reason: { code: 'transport-uncertain', retryable: false }
    })

    expect(() => store.prepare(operation('call-3', 2))).toThrow(
      ModelCallCapacityError
    )
    expect(store.get('call-1')?.status).toBe('dispatched')
    expect(store.get('call-2')?.status).toBe('outcome-unknown')
    store.close()
  })

  it('reapplies capacity and terminal pruning after reopen', async () => {
    const path = await createPath()
    const first = new ModelCallOperationStore(path, { maximumRecords: 3 })
    for (let index = 1; index <= 3; index += 1) {
      first.prepare(operation(`call-${index}`, index))
    }
    completeCall(first, 'call-1')
    completeCall(first, 'call-2')
    first.close()

    const reopened = new ModelCallOperationStore(path, { maximumRecords: 2 })
    reopened.prepare(operation('call-4', 4))
    expect(reopened.get('call-1')).toBeUndefined()
    expect(reopened.get('call-2')).toBeUndefined()
    expect(reopened.get('call-3')?.status).toBe('prepared')
    expect(reopened.get('call-4')?.status).toBe('prepared')
    reopened.close()
  })

  it('prunes terminal records deterministically with bounded options', async () => {
    let now = 0
    const store = new ModelCallOperationStore(await createPath(), {
      now: () => ++now
    })
    store.prepare(operation('call-1', 0))
    completeCall(store, 'call-1')
    store.prepare(operation('call-2', 1))
    completeCall(store, 'call-2')
    store.prepare(operation('call-3', 2))
    store.beginDispatch('call-3')
    store.markOutcomeUnknown('call-3', {
      status: 'outcome-unknown',
      reason: { code: 'transport-uncertain', retryable: false }
    })

    expect(store.pruneTerminal(1, 6)).toBe(1)
    expect(store.get('call-1')).toBeUndefined()
    expect(store.get('call-2')?.status).toBe('completed')
    expect(store.get('call-3')?.status).toBe('outcome-unknown')
    expect(() => store.pruneTerminal(1_001)).toThrow()
    store.close()
  })

  it('atomically grants one strictly monotonic next round across stores', async () => {
    const path = await createPath()
    const first = new ModelCallOperationStore(path)
    const second = new ModelCallOperationStore(path)
    first.prepare(prepared)
    completeCall(first, 'call-1')
    const next = {
      identity: {
        ...identity,
        callOperationId: 'call-round-1-a',
        roundIndex: 1
      },
      requestDigest: digestB,
      ...policy
    }
    const competing = {
      ...next,
      identity: {
        ...next.identity,
        callOperationId: 'call-round-1-b'
      }
    }

    const results = await Promise.allSettled([
      Promise.resolve().then(() => first.prepare(next)),
      Promise.resolve().then(() => second.prepare(competing))
    ])
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1)
    first.close()
    second.close()
  })

  it('retains replay authority after delivered records are pruned and reopened', async () => {
    const path = await createPath()
    const first = new ModelCallOperationStore(path)
    first.prepare(prepared)
    completeCall(first, 'call-1')
    first.finalizePrompt({
      bindingId: 'binding-1',
      promptOperationId: 'prompt-1',
      promptSequence: 0
    })
    expect(first.pruneTerminal(1)).toBe(1)
    expect(first.get('call-1')).toBeUndefined()
    first.close()

    const reopened = new ModelCallOperationStore(path)
    expect(() => reopened.prepare(prepared)).toThrow(ModelCallConflictError)
    expect(
      reopened.prepare({
        ...prepared,
        identity: {
          ...prepared.identity,
          callOperationId: 'call-next-prompt',
          requestId: 'request-2',
          promptOperationId: 'prompt-2',
          promptSequence: 1,
          roundIndex: 0
        },
        requestDigest: digestB
      }).created
    ).toBe(true)
    expect(() =>
      reopened.prepare({
        ...prepared,
        identity: {
          ...prepared.identity,
          callOperationId: 'call-skipped-prompt',
          requestId: 'request-3',
          promptOperationId: 'prompt-3',
          promptSequence: 3,
          roundIndex: 0
        }
      })
    ).toThrow(ModelCallConflictError)
    reopened.close()
  })

  it('compacts finalized prompt authorities below the hard authority cap', async () => {
    const store = new ModelCallOperationStore(await createPath(), {
      maximumAuthorities: 1
    })
    for (let promptSequence = 0; promptSequence < 3; promptSequence += 1) {
      const callOperationId = `call-prompt-${promptSequence}`
      const promptOperationId = `prompt-${promptSequence}`
      store.prepare({
        ...prepared,
        identity: {
          ...identity,
          callOperationId,
          requestId: `request-${promptSequence}`,
          promptOperationId,
          promptSequence,
          roundIndex: 0
        }
      })
      completeCall(store, callOperationId)
      store.finalizePrompt({
        bindingId: identity.bindingId,
        promptOperationId,
        promptSequence
      })
    }
    expect(() =>
      store.prepare({
        ...prepared,
        identity: {
          ...identity,
          callOperationId: 'replayed-finalized-prompt',
          promptOperationId: 'prompt-1',
          promptSequence: 1,
          roundIndex: 0
        }
      })
    ).toThrow(ModelCallConflictError)
    store.close()
  })

  it('rejects skipped, lower, and profile-swapped rounds', async () => {
    const store = new ModelCallOperationStore(await createPath())
    store.prepare(prepared)
    completeCall(store, 'call-1')
    expect(() =>
      store.prepare({
        ...prepared,
        identity: {
          ...identity,
          callOperationId: 'call-skipped',
          roundIndex: 2
        }
      })
    ).toThrow(ModelCallStateError)
    expect(() =>
      store.prepare({
        ...prepared,
        identity: {
          ...identity,
          callOperationId: 'call-profile-swap',
          roundIndex: 1,
          profile: 'other'
        },
        modelProfileDigest: digestB
      })
    ).toThrow(ModelCallConflictError)
    expect(() =>
      store.prepare({
        ...prepared,
        identity: {
          ...identity,
          callOperationId: 'call-lower',
          roundIndex: 0
        }
      })
    ).toThrow(ModelCallConflictError)
    store.close()
  })

  it('permits sequential rounds without a call-count or cumulative-token quota', async () => {
    const store = new ModelCallOperationStore(await createPath())
    for (let roundIndex = 0; roundIndex < 12; roundIndex += 1) {
      const callOperationId = `call-unbounded-${roundIndex}`
      store.prepare({
        ...prepared,
        identity: {
          ...identity,
          callOperationId,
          requestId: `request-${roundIndex}`,
          roundIndex
        }
      })
      completeCall(store, callOperationId)
    }
    expect(store.get('call-unbounded-11')).toMatchObject({
      status: 'completed',
      responseDeliveredAt: expect.any(Number)
    })
    store.close()
  })

  it('requires explicit response delivery before the next round', async () => {
    const store = new ModelCallOperationStore(await createPath(), {
      now: () => 42
    })
    store.prepare(prepared)
    store.beginDispatch('call-1')
    store.complete('call-1', { status: 'completed' })
    const next = {
      ...prepared,
      identity: {
        ...identity,
        callOperationId: 'call-2',
        roundIndex: 1
      },
      requestDigest: digestB
    }
    expect(() => store.prepare(next)).toThrow(ModelCallStateError)
    expect(store.pruneTerminal(1)).toBe(0)
    const pending = store.listStartupRecords().records
    expect(pending).toMatchObject([{ status: 'completed' }])
    expect(pending[0]).not.toHaveProperty('responseDeliveredAt')
    const delivered = store.markResponseDelivered('call-1')
    expect(delivered.responseDeliveredAt).toBe(42)
    expect(store.markResponseDelivered('call-1')).toEqual(delivered)
    expect(store.prepare(next).created).toBe(true)
    store.close()
  })

  it('paginates startup and status-filtered records without starvation', async () => {
    let now = 0
    const store = new ModelCallOperationStore(await createPath(), {
      now: () => ++now
    })
    for (const id of ['call-a', 'call-b', 'call-c']) {
      store.prepare(operation(id, 0))
      store.beginDispatch(id)
    }
    store.complete('call-b', { status: 'completed' })
    completeCall(store, 'call-c')

    const first = store.listStartupRecords({ limit: 1 })
    expect(first.records).toHaveLength(1)
    expect(first.nextCursor).toBeDefined()
    const second = store.listStartupRecords({
      limit: 1,
      cursor: first.nextCursor
    })
    expect([
      ...first.records,
      ...second.records
    ].map((record) => record.identity.callOperationId)).toEqual([
      'call-a',
      'call-b'
    ])
    expect(
      store.list({
        statuses: ['completed'],
        delivery: 'pending-response',
        limit: 10
      }).records.map((record) => record.identity.callOperationId)
    ).toEqual(['call-b'])
    store.close()
  })

  it('includes prepared records in startup reconciliation', async () => {
    const store = new ModelCallOperationStore(await createPath())
    store.prepare(operation('call-prepared', 0))

    expect(store.listStartupRecords().records).toMatchObject([
      {
        identity: { callOperationId: 'call-prepared' },
        status: 'prepared'
      }
    ])
    store.close()
  })

  it('uses the verified private SQLite path opener before initialization', async () => {
    const path = await createPath()
    const store = new ModelCallOperationStore(path)
    store.close()
    const databaseStats = await stat(path)
    expect(databaseStats.isFile()).toBe(true)
    if (process.platform !== 'win32') {
      expect(databaseStats.mode & 0o777).toBe(0o600)
    }
    expect(() => new ModelCallOperationStore(':memory:')).toThrow(
      'SQLite database must be a filesystem path'
    )

    const invalidPath = join(
      join(path, '..'),
      'invalid-capacity-must-not-exist.sqlite'
    )
    expect(
      () =>
        new ModelCallOperationStore(invalidPath, {
          maximumRecords: 0
        })
    ).toThrow()
    await expect(stat(invalidPath)).rejects.toMatchObject({ code: 'ENOENT' })
  })
})

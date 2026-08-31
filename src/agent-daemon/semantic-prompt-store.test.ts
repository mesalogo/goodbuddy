import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  REMOTE_SEMANTIC_TRANSCRIPT_LIMITS
} from '../shared/remote-agent-contracts'
import { SemanticPromptStore } from './semantic-prompt-store'

const temporary: string[] = []

function store(options: {
  maximumEventsPerPrompt?: number
  maximumTranscriptBytes?: number
  maximumRetainedAcknowledgedOperations?: number
} = {}): SemanticPromptStore {
  const root = mkdtempSync(join(tmpdir(), 'goodbuddy-semantic-prompt-'))
  temporary.push(root)
  mkdirSync(join(root, 'state'), { mode: 0o700 })
  return new SemanticPromptStore(join(root, 'state', 'prompts.sqlite'), {
    now: () => 1_000,
    ...options
  })
}

afterEach(() => {
  for (const path of temporary.splice(0)) {
    rmSync(path, { recursive: true, force: true })
  }
})

describe('SemanticPromptStore', () => {
  it('replays unacknowledged output and prunes it after durable acknowledgement', () => {
    const first = store()
    first.prepare({
      bindingId: 'binding-1',
      operationId: 'operation-1',
      requestId: 'operation-1',
      controllerId: 'controller-1',
      preparationDigest: `sha256:${'a'.repeat(64)}`,
      promptSequence: 0
    })
    first.begin({
      bindingId: 'binding-1',
      operationId: 'operation-1',
      startDigest: `sha256:${'b'.repeat(64)}`,
      sessionId: 'session-1'
    })
    first.append({
      bindingId: 'binding-1',
      operationId: 'operation-1',
      kind: 'session-update',
      payload: { update: { sessionUpdate: 'agent_message_chunk' } }
    })
    first.append({
      bindingId: 'binding-1',
      operationId: 'operation-1',
      kind: 'prompt-terminal',
      payload: {
        status: 'completed',
        response: { stopReason: 'end_turn' }
      },
      terminalState: 'completed'
    })
    expect(
      first.page({
        bindingId: 'binding-1',
        operationId: 'operation-1',
        controllerId: 'controller-1',
        afterSequence: '1',
        limit: 10
      }).events.map((event) => event.sequence)
    ).toEqual(['2'])
    expect(
      first.acknowledge({
        bindingId: 'binding-1',
        operationId: 'operation-1',
        controllerId: 'controller-1',
        acknowledgedSequence: '2'
      })
    ).toMatchObject({ acknowledgedSequence: '2' })
    const path = (first as unknown as { close(): void })
    path.close()

    // Reopen the durable authority as a brand-new Desktop-facing owner.
    const root = temporary[0]!
    const second = new SemanticPromptStore(
      join(root, 'state', 'prompts.sqlite')
    )
    expect(
      second.attach('binding-1', 'operation-1', 'controller-1')
    ).toMatchObject({
      state: 'completed',
      sessionId: 'session-1',
      latestSemanticSequence: '2'
    })
    expect(
      second.page({
        bindingId: 'binding-1',
        operationId: 'operation-1',
        controllerId: 'controller-1',
        afterSequence: '0',
        limit: 10
      })
    ).toMatchObject({
      events: [],
      acknowledgedSequence: '2',
      latestSequence: '2',
      state: 'completed'
    })
    second.close()
  })

  it('is idempotent for one canonical operation and rejects divergent starts', () => {
    const prompts = store()
    const preparation = {
      bindingId: 'binding-1',
      operationId: 'operation-1',
      requestId: 'operation-1',
      controllerId: 'controller-1',
      preparationDigest: `sha256:${'a'.repeat(64)}`,
      promptSequence: 0
    }
    expect(prompts.prepare(preparation)).toEqual({ created: true })
    expect(prompts.prepare(preparation)).toEqual({ created: false })
    const start = {
      bindingId: 'binding-1',
      operationId: 'operation-1',
      startDigest: `sha256:${'b'.repeat(64)}`,
      sessionId: 'session-1'
    }
    expect(prompts.begin(start).created).toBe(true)
    expect(prompts.begin(start).created).toBe(false)
    expect(
      prompts.findStarted({
        bindingId: 'binding-1',
        operationId: 'operation-1',
        controllerId: 'controller-1',
        startDigest: start.startDigest
      })
    ).toMatchObject({ state: 'running', sessionId: 'session-1' })
    expect(() =>
      prompts.begin({
        ...start,
        startDigest: `sha256:${'c'.repeat(64)}`
      })
    ).toThrow(/conflicts/u)
    prompts.close()
  })

  it('rejects transcript events beyond the per-event bound', () => {
    const prompts = store()
    prompts.prepare({
      bindingId: 'binding-1',
      operationId: 'operation-1',
      requestId: 'operation-1',
      controllerId: 'controller-1',
      preparationDigest: `sha256:${'a'.repeat(64)}`,
      promptSequence: 0
    })
    prompts.begin({
      bindingId: 'binding-1',
      operationId: 'operation-1',
      startDigest: `sha256:${'b'.repeat(64)}`,
      sessionId: 'session-1'
    })
    expect(() =>
      prompts.append({
        bindingId: 'binding-1',
        operationId: 'operation-1',
        kind: 'session-update',
        payload: { text: 'x'.repeat(1024 * 1024) }
      })
    ).toThrow(/byte limit/u)
    prompts.close()
  })

  it('reserves event-count capacity for durable terminal evidence', () => {
    const prompts = store({ maximumEventsPerPrompt: 3 })
    prompts.prepare({
      bindingId: 'binding-1',
      operationId: 'operation-1',
      requestId: 'operation-1',
      controllerId: 'controller-1',
      preparationDigest: `sha256:${'a'.repeat(64)}`,
      promptSequence: 0
    })
    prompts.begin({
      bindingId: 'binding-1',
      operationId: 'operation-1',
      startDigest: `sha256:${'b'.repeat(64)}`,
      sessionId: 'session-1'
    })
    for (let index = 0; index < 2; index += 1) {
      prompts.append({
        bindingId: 'binding-1',
        operationId: 'operation-1',
        kind: 'session-update',
        payload: { index }
      })
    }
    expect(() =>
      prompts.append({
        bindingId: 'binding-1',
        operationId: 'operation-1',
        kind: 'session-update',
        payload: { index: 3 }
      })
    ).toThrow(/quota/u)
    expect(
      prompts.append({
        bindingId: 'binding-1',
        operationId: 'operation-1',
        kind: 'prompt-terminal',
        payload: { status: 'completed' },
        terminalState: 'completed'
      })
    ).toMatchObject({ sequence: '3', kind: 'prompt-terminal' })
    prompts.close()
  })

  it('reserves byte capacity for terminal evidence across restart', () => {
    const first = store({
      maximumTranscriptBytes:
        REMOTE_SEMANTIC_TRANSCRIPT_LIMITS.maximumEventBytes + 256
    })
    first.prepare({
      bindingId: 'binding-1',
      operationId: 'operation-1',
      requestId: 'operation-1',
      controllerId: 'controller-1',
      preparationDigest: `sha256:${'a'.repeat(64)}`,
      promptSequence: 0
    })
    first.begin({
      bindingId: 'binding-1',
      operationId: 'operation-1',
      startDigest: `sha256:${'b'.repeat(64)}`,
      sessionId: 'session-1'
    })
    expect(() =>
      first.append({
        bindingId: 'binding-1',
        operationId: 'operation-1',
        kind: 'session-update',
        payload: { text: 'x'.repeat(512) }
      })
    ).toThrow(/quota/u)
    first.close()

    const reopened = new SemanticPromptStore(
      join(temporary[0]!, 'state', 'prompts.sqlite'),
      {
        maximumTranscriptBytes:
          REMOTE_SEMANTIC_TRANSCRIPT_LIMITS.maximumEventBytes + 256
      }
    )
    expect(
      reopened.attach('binding-1', 'operation-1', 'controller-1')
    ).toMatchObject({ state: 'outcome-unknown' })
    reopened.close()
  })

  it('keeps the first terminal transition authoritative', () => {
    const prompts = store()
    prompts.prepare({
      bindingId: 'binding-1',
      operationId: 'operation-1',
      requestId: 'operation-1',
      controllerId: 'controller-1',
      preparationDigest: `sha256:${'a'.repeat(64)}`,
      promptSequence: 0
    })
    prompts.begin({
      bindingId: 'binding-1',
      operationId: 'operation-1',
      startDigest: `sha256:${'b'.repeat(64)}`,
      sessionId: 'session-1'
    })
    prompts.append({
      bindingId: 'binding-1',
      operationId: 'operation-1',
      kind: 'prompt-terminal',
      payload: { status: 'cancelled' },
      terminalState: 'cancelled'
    })

    expect(() =>
      prompts.append({
        bindingId: 'binding-1',
        operationId: 'operation-1',
        kind: 'prompt-terminal',
        payload: { status: 'completed' },
        terminalState: 'completed'
      })
    ).toThrow(/terminal evidence/u)
    expect(
      prompts.attach('binding-1', 'operation-1', 'controller-1')
    ).toMatchObject({ state: 'cancelled' })
    prompts.close()
  })

  it('marks nonterminal operations outcome-unknown after Agent restart', () => {
    const first = store()
    first.prepare({
      bindingId: 'binding-1',
      operationId: 'operation-1',
      requestId: 'operation-1',
      controllerId: 'controller-1',
      preparationDigest: `sha256:${'a'.repeat(64)}`,
      promptSequence: 0
    })
    first.begin({
      bindingId: 'binding-1',
      operationId: 'operation-1',
      startDigest: `sha256:${'b'.repeat(64)}`,
      sessionId: 'session-1'
    })
    first.close()

    const second = new SemanticPromptStore(
      join(temporary[0]!, 'state', 'prompts.sqlite')
    )
    expect(
      second.attach('binding-1', 'operation-1', 'controller-1')
    ).toMatchObject({ state: 'outcome-unknown' })
    expect(
      second.page({
        bindingId: 'binding-1',
        operationId: 'operation-1',
        controllerId: 'controller-1',
        afterSequence: '0',
        limit: 10
      }).events
    ).toEqual([
      expect.objectContaining({
        kind: 'prompt-terminal',
        payload: expect.objectContaining({
          status: 'outcome-unknown'
        })
      })
    ])
    second.close()
  })

  it('bounds transcript pages by aggregate control-frame bytes', () => {
    const prompts = store()
    prompts.prepare({
      bindingId: 'binding-1',
      operationId: 'operation-1',
      requestId: 'operation-1',
      controllerId: 'controller-1',
      preparationDigest: `sha256:${'a'.repeat(64)}`,
      promptSequence: 0
    })
    prompts.begin({
      bindingId: 'binding-1',
      operationId: 'operation-1',
      startDigest: `sha256:${'b'.repeat(64)}`,
      sessionId: 'session-1'
    })
    for (let index = 0; index < 2; index += 1) {
      prompts.append({
        bindingId: 'binding-1',
        operationId: 'operation-1',
        kind: 'session-update',
        payload: { text: 'x'.repeat(400 * 1024), index }
      })
    }

    const first = prompts.page({
      bindingId: 'binding-1',
      operationId: 'operation-1',
      controllerId: 'controller-1',
      afterSequence: '0',
      limit: 10
    })
    expect(first.events).toHaveLength(1)
    expect(first.hasMore).toBe(true)
    expect(Buffer.byteLength(JSON.stringify(first), 'utf8')).toBeLessThan(
      768 * 1024
    )
    prompts.close()
  })

  it('prunes acknowledged terminal operations while the daemon remains running', () => {
    const prompts = store({
      maximumRetainedAcknowledgedOperations: 2
    })
    for (let index = 1; index <= 3; index += 1) {
      const operationId = `operation-${index}`
      prompts.prepare({
        bindingId: 'binding-1',
        operationId,
        requestId: operationId,
        controllerId: 'controller-1',
        preparationDigest: `sha256:${String(index).repeat(64)}`,
        promptSequence: index
      })
      prompts.begin({
        bindingId: 'binding-1',
        operationId,
        startDigest: `sha256:${'b'.repeat(64)}`,
        sessionId: `session-${index}`
      })
      prompts.append({
        bindingId: 'binding-1',
        operationId,
        kind: 'prompt-terminal',
        payload: {
          status: 'completed',
          response: { stopReason: 'end_turn' }
        },
        terminalState: 'completed'
      })
      prompts.acknowledge({
        bindingId: 'binding-1',
        operationId,
        controllerId: 'controller-1',
        acknowledgedSequence: '1'
      })
    }

    expect(() =>
      prompts.attach('binding-1', 'operation-1', 'controller-1')
    ).toThrow(/does not exist/u)
    expect(
      prompts.attach('binding-1', 'operation-2', 'controller-1')
    ).toMatchObject({ state: 'completed' })
    expect(
      prompts.attach('binding-1', 'operation-3', 'controller-1')
    ).toMatchObject({ state: 'completed' })
    prompts.close()
  })
})

import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentPromptModelProfile } from '../shared/model-bridge-contracts'
import {
  AgentModelCallLedger,
  AgentModelGateway
} from './agent-model-gateway'

const temporary: string[] = []
const secret = 'provider-secret-never-persist'

function setup(fetcher: typeof fetch) {
  const root = mkdtempSync(join(tmpdir(), 'goodbuddy-agent-model-'))
  temporary.push(root)
  mkdirSync(join(root, 'state'), { mode: 0o700 })
  const path = join(root, 'state', 'calls.sqlite')
  const ledger = new AgentModelCallLedger(path)
  return {
    path,
    ledger,
    gateway: new AgentModelGateway({ ledger, fetcher })
  }
}

const profile: AgentPromptModelProfile = {
  profileId: 'profile-1',
  modelProfileDigest: `sha256:${'a'.repeat(64)}`,
  provider: 'openai',
  baseUrl: 'https://provider.example/v1',
  model: 'model-1',
  protocol: 'openai-responses',
  authentication: 'api-key',
  apiKey: secret,
  capabilities: { imageInput: false },
  limits: {
    maximumOutputTokens: 4_096,
    requestTimeoutMilliseconds: 5_000
  }
}

const request = {
  method: 'POST' as const,
  path: '/v1/responses' as const,
  headers: { 'content-type': 'application/json' },
  bodyBase64: Buffer.from(JSON.stringify({ model: 'model-1' })).toString(
    'base64'
  )
}

const context = {
  bindingId: 'binding-1',
  operationId: 'operation-1',
  promptSequence: 0,
  roundIndex: 0,
  profileDigest: profile.modelProfileDigest,
  profile
}

afterEach(() => {
  for (const path of temporary.splice(0)) {
    rmSync(path, { recursive: true, force: true })
  }
})

describe('AgentModelGateway', () => {
  it('dispatches a stable call exactly once and records delivery ACK without persisting credentials', async () => {
    const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
      expect(new Headers(init?.headers).get('authorization')).toBe(
        `Bearer ${secret}`
      )
      expect(JSON.parse(String(init?.body))).toMatchObject({
        max_output_tokens: 4_096
      })
      return new Response(JSON.stringify({ id: 'response-1' }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    })
    const { gateway, ledger, path } = setup(fetcher)
    const result = await gateway.dispatch(
      context,
      request,
      new AbortController().signal
    )
    await result.acknowledgeDelivery()
    await expect(
      gateway.dispatch(context, request, new AbortController().signal)
    ).rejects.toMatchObject({ code: 'already-dispatched' })
    expect(fetcher).toHaveBeenCalledOnce()
    ledger.close()
    expect(readFileSync(path).includes(Buffer.from(secret))).toBe(false)
  })

  it('caps provider output hints at the prompt-scoped limit', async () => {
    const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
      expect(JSON.parse(String(init?.body))).toMatchObject({
        max_output_tokens: 4_096
      })
      return new Response(JSON.stringify({ id: 'response-1' }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    })
    const { gateway, ledger } = setup(fetcher)
    const result = await gateway.dispatch(
      context,
      {
        ...request,
        bodyBase64: Buffer.from(
          JSON.stringify({
            model: 'model-1',
            max_output_tokens: 32_000
          })
        ).toString('base64')
      },
      new AbortController().signal
    )
    await result.acknowledgeDelivery()
    expect(fetcher).toHaveBeenCalledOnce()
    ledger.close()
  })

  it('does not impose prompt-wide model-call or output-token quotas', async () => {
    const fetcher = vi.fn<typeof fetch>(async () =>
      new Response(
        JSON.stringify({
          id: 'response',
          usage: { output_tokens: 4_096 }
        }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' }
        }
      )
    )
    const { gateway, ledger } = setup(fetcher)

    for (let roundIndex = 0; roundIndex < 101; roundIndex += 1) {
      const result = await gateway.dispatch(
        { ...context, roundIndex },
        request,
        new AbortController().signal
      )
      await result.acknowledgeDelivery()
    }

    expect(fetcher).toHaveBeenCalledTimes(101)
    ledger.close()
  })

  it('caps OpenCode chat-completions max_tokens before dispatch', async () => {
    const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
      expect(JSON.parse(String(init?.body))).toMatchObject({
        max_tokens: 4_096
      })
      return new Response(JSON.stringify({ id: 'response-1' }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    })
    const { gateway, ledger } = setup(fetcher)
    const result = await gateway.dispatch(
      {
        ...context,
        profile: {
          ...profile,
          protocol: 'openai-chat-completions'
        }
      },
      {
        method: 'POST',
        path: '/v1/chat/completions',
        headers: { 'content-type': 'application/json' },
        bodyBase64: Buffer.from(
          JSON.stringify({
            model: 'model-1',
            max_tokens: 32_000
          })
        ).toString('base64')
      },
      new AbortController().signal
    )
    await result.acknowledgeDelivery()
    expect(fetcher).toHaveBeenCalledOnce()
    ledger.close()
  })

  it.each([
    { background: true },
    { store: true },
    { web_search_options: {} },
    { mcp_servers: [] },
    { previous_response_id: 'response-previous' },
    { tools: [{ type: 'web_search' }] },
    { include: ['web_search_call.results'] },
    { modalities: ['text', 'audio'] }
  ])('rejects independently billed provider capabilities %#', async (extra) => {
    const fetcher = vi.fn<typeof fetch>()
    const { gateway, ledger } = setup(fetcher)
    await expect(
      gateway.dispatch(
        context,
        {
          ...request,
          bodyBase64: Buffer.from(
            JSON.stringify({ model: 'model-1', ...extra })
          ).toString('base64')
        },
        new AbortController().signal
      )
    ).rejects.toMatchObject({ code: 'policy' })
    expect(fetcher).not.toHaveBeenCalled()
    ledger.close()
  })

  it('marks an in-flight provider failure outcome-unknown and never retries it', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => {
      throw new Error('connection lost after write')
    })
    const { gateway, ledger } = setup(fetcher)
    await expect(
      gateway.dispatch(context, request, new AbortController().signal)
    ).rejects.toMatchObject({ code: 'outcome-unknown' })
    await expect(
      gateway.dispatch(context, request, new AbortController().signal)
    ).rejects.toMatchObject({ code: 'outcome-unknown' })
    expect(fetcher).toHaveBeenCalledOnce()
    ledger.close()
  })

  it('rejects an oversized declared provider response before buffering it', async () => {
    const fetcher = vi.fn<typeof fetch>(async () =>
      new Response('{}', {
        status: 200,
        headers: {
          'content-length': String(768 * 1024 + 1)
        }
      })
    )
    const { gateway, ledger } = setup(fetcher)
    await expect(
      gateway.dispatch(context, request, new AbortController().signal)
    ).rejects.toMatchObject({ code: 'response-too-large' })
    ledger.close()
  })

  it('marks a truncated provider response outcome-unknown', async () => {
    const fetcher = vi.fn<typeof fetch>(async () =>
      new Response('{}', {
        status: 200,
        headers: { 'content-length': '100' }
      })
    )
    const { gateway, ledger } = setup(fetcher)
    await expect(
      gateway.dispatch(context, request, new AbortController().signal)
    ).rejects.toMatchObject({ code: 'outcome-unknown' })
    ledger.close()
  })
})

describe('AgentModelCallLedger', () => {
  it('prunes delivered terminal calls while the daemon remains running', () => {
    const root = mkdtempSync(join(tmpdir(), 'goodbuddy-agent-ledger-'))
    temporary.push(root)
    const ledger = new AgentModelCallLedger(
      join(root, 'calls.sqlite'),
      { maximumRetainedTerminalCalls: 2 }
    )
    for (let index = 1; index <= 3; index += 1) {
      const callId = `call-${index}`
      ledger.claim({
        callId,
        bindingId: 'binding-1',
        operationId: `operation-${index}`,
        promptSequence: index,
        roundIndex: 0,
        profileDigest: `sha256:${'a'.repeat(64)}`,
        requestDigest: `sha256:${String(index).repeat(64)}`
      })
      ledger.complete(callId)
      ledger.delivered(callId)
    }

    expect(ledger.get('call-1')).toBeUndefined()
    expect(ledger.get('call-2')).toMatchObject({ status: 'completed' })
    expect(ledger.get('call-3')).toMatchObject({ status: 'completed' })
    ledger.close()
  })
})

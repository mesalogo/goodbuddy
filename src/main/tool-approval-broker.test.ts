import { describe, expect, it, vi } from 'vitest'
import type { AgentEvent } from '../shared/contracts'
import { ToolApprovalBroker } from './tool-approval-broker'

describe('ToolApprovalBroker', () => {
  it('reuses a session grant for different requests in the same tool scope', async () => {
    const broker = new ToolApprovalBroker()
    const send = vi.fn<(event: AgentEvent) => void>()
    const firstApproval = broker.request(
      {
        requestId: 'cf725fa7-709f-4417-81f7-40d0aa84da78',
        conversationId: 'conversation-1',
        scopeKey: 'opencode:bash',
        title: 'OpenCode 请求调用 bash',
        description: 'npm test'
      },
      new AbortController().signal,
      send
    )
    const event = send.mock.calls[0]?.[0]
    expect(event).toMatchObject({ type: 'approval' })
    if (!event || event.type !== 'approval') {
      throw new Error('Approval event was not emitted')
    }

    broker.respond(event.approvalId, 'session')
    await expect(firstApproval).resolves.toBe('session')

    await expect(
      broker.request(
        {
          requestId: '90536266-3db8-4d64-969d-552635c3172e',
          conversationId: 'conversation-1',
          scopeKey: 'opencode:bash',
          title: 'OpenCode 请求调用 bash',
          description: 'npm run lint'
        },
        new AbortController().signal,
        send
      )
    ).resolves.toBe('session')
    expect(send).toHaveBeenCalledOnce()
  })

  it('isolates session grants across tool scopes and conversations', async () => {
    const broker = new ToolApprovalBroker()
    const send = vi.fn<(event: AgentEvent) => void>()
    const firstApproval = broker.request(
      {
        requestId: 'cf725fa7-709f-4417-81f7-40d0aa84da78',
        conversationId: 'conversation-1',
        scopeKey: 'opencode:bash',
        title: 'OpenCode 请求调用 bash',
        description: 'npm test'
      },
      new AbortController().signal,
      send
    )
    const firstEvent = send.mock.calls[0]?.[0]
    if (!firstEvent || firstEvent.type !== 'approval') {
      throw new Error('Approval event was not emitted')
    }
    broker.respond(firstEvent.approvalId, 'session')
    await expect(firstApproval).resolves.toBe('session')

    const otherToolApproval = broker.request(
      {
        requestId: '90536266-3db8-4d64-969d-552635c3172e',
        conversationId: 'conversation-1',
        scopeKey: 'opencode:write',
        title: 'OpenCode 请求调用 write',
        description: '/tmp/output.txt'
      },
      new AbortController().signal,
      send
    )
    const otherToolEvent = send.mock.calls[1]?.[0]
    if (!otherToolEvent || otherToolEvent.type !== 'approval') {
      throw new Error('Approval event was not emitted')
    }
    broker.respond(otherToolEvent.approvalId, 'deny')
    await expect(otherToolApproval).resolves.toBe('deny')

    const otherConversationApproval = broker.request(
      {
        requestId: 'bf41982c-da06-44ae-b55a-8872fe35645b',
        conversationId: 'conversation-2',
        scopeKey: 'opencode:bash',
        title: 'OpenCode 请求调用 bash',
        description: 'npm test'
      },
      new AbortController().signal,
      send
    )
    const otherConversationEvent = send.mock.calls[2]?.[0]
    if (
      !otherConversationEvent ||
      otherConversationEvent.type !== 'approval'
    ) {
      throw new Error('Approval event was not emitted')
    }
    broker.respond(otherConversationEvent.approvalId, 'deny')
    await expect(otherConversationApproval).resolves.toBe('deny')

    expect(send).toHaveBeenCalledTimes(3)
  })

  it('caches only session decisions and expires grants on clear', async () => {
    const broker = new ToolApprovalBroker()
    const send = vi.fn<(event: AgentEvent) => void>()
    const request = {
      requestId: 'cf725fa7-709f-4417-81f7-40d0aa84da78',
      conversationId: 'conversation-1',
      scopeKey: 'opencode:bash',
      title: 'OpenCode 请求调用 bash',
      description: 'npm test'
    }
    const permanentApproval = broker.request(
      request,
      new AbortController().signal,
      send
    )
    const permanentEvent = send.mock.calls[0]?.[0]
    if (!permanentEvent || permanentEvent.type !== 'approval') {
      throw new Error('Approval event was not emitted')
    }
    broker.respond(permanentEvent.approvalId, 'permanent')
    await expect(permanentApproval).resolves.toBe('permanent')

    const sessionApproval = broker.request(
      { ...request, requestId: '90536266-3db8-4d64-969d-552635c3172e' },
      new AbortController().signal,
      send
    )
    const sessionEvent = send.mock.calls[1]?.[0]
    if (!sessionEvent || sessionEvent.type !== 'approval') {
      throw new Error('Approval event was not emitted')
    }
    broker.respond(sessionEvent.approvalId, 'session')
    await expect(sessionApproval).resolves.toBe('session')

    broker.clear()
    const afterClearApproval = broker.request(
      { ...request, requestId: 'bf41982c-da06-44ae-b55a-8872fe35645b' },
      new AbortController().signal,
      send
    )
    const afterClearEvent = send.mock.calls[2]?.[0]
    if (!afterClearEvent || afterClearEvent.type !== 'approval') {
      throw new Error('Approval event was not emitted')
    }
    broker.respond(afterClearEvent.approvalId, 'deny')
    await expect(afterClearApproval).resolves.toBe('deny')

    expect(send).toHaveBeenCalledTimes(3)
  })

  it('evaluates policy before a cached session grant', async () => {
    const broker = new ToolApprovalBroker()
    const send = vi.fn<(event: AgentEvent) => void>()
    const firstApproval = broker.request(
      {
        requestId: 'cf725fa7-709f-4417-81f7-40d0aa84da78',
        conversationId: 'conversation-1',
        scopeKey: 'opencode:bash',
        title: 'OpenCode 请求调用 bash',
        description: 'npm test'
      },
      new AbortController().signal,
      send
    )
    const event = send.mock.calls[0]?.[0]
    if (!event || event.type !== 'approval') {
      throw new Error('Approval event was not emitted')
    }
    broker.respond(event.approvalId, 'session')
    await expect(firstApproval).resolves.toBe('session')

    await expect(
      broker.request(
        {
          policy: 'policy',
          requestId: '90536266-3db8-4d64-969d-552635c3172e',
          conversationId: 'conversation-1',
          scopeKey: 'opencode:bash',
          title: 'OpenCode 请求调用 bash',
          description: 'npm test'
        },
        new AbortController().signal,
        send
      )
    ).rejects.toThrow('当前策略已禁止')
    expect(send).toHaveBeenCalledOnce()
  })
})

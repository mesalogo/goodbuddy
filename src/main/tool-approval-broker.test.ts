import { describe, expect, it, vi } from 'vitest'
import type { AgentEvent } from '../shared/contracts'
import { ToolApprovalBroker } from './tool-approval-broker'

describe('ToolApprovalBroker', () => {
  it('supports configurable session grants without bypassing the first prompt', async () => {
    const broker = new ToolApprovalBroker()
    const send = vi.fn<(event: AgentEvent) => void>()
    const firstApproval = broker.request(
      {
        requestId: 'cf725fa7-709f-4417-81f7-40d0aa84da78',
        conversationId: 'conversation-1',
        scopeKey: 'continue:Bash(git status)',
        title: 'Continue 请求调用 Bash',
        description: 'git status',
        allowPermanent: true
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
          scopeKey: 'continue:Bash(git status)',
          title: 'Continue 请求调用 Bash',
          description: 'git status'
        },
        new AbortController().signal,
        send
      )
    ).resolves.toBe('session')
    expect(send).toHaveBeenCalledOnce()
  })

  it('denies tool execution when enterprise policy has not authorized it', async () => {
    const broker = new ToolApprovalBroker()
    await expect(
      broker.request(
        {
          policy: 'policy',
          requestId: '90536266-3db8-4d64-969d-552635c3172e',
          conversationId: 'conversation-1',
          scopeKey: 'runtime:whole-run',
          title: 'Agent',
          description: '工具执行'
        },
        new AbortController().signal,
        vi.fn()
      )
    ).rejects.toThrow('当前策略已禁止')
  })
})

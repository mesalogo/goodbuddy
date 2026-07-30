import { describe, expect, it, vi } from 'vitest'
import type { AgentEvent } from '../shared/contracts'
import { ToolApprovalBroker } from './tool-approval-broker'

describe('ToolApprovalBroker', () => {
  it('supports configurable session grants without bypassing the first prompt', async () => {
    const broker = new ToolApprovalBroker()
    const send = vi.fn<(event: AgentEvent) => void>()
    const firstApproval = broker.request(
      'session',
      'cf725fa7-709f-4417-81f7-40d0aa84da78',
      'workspace',
      new AbortController().signal,
      send
    )
    const event = send.mock.calls[0]?.[0]
    expect(event).toMatchObject({ type: 'approval' })
    if (!event || event.type !== 'approval') {
      throw new Error('Approval event was not emitted')
    }

    broker.respond(event.approvalId, true)
    await expect(firstApproval).resolves.toBeUndefined()

    await expect(
      broker.request(
        'session',
        '90536266-3db8-4d64-969d-552635c3172e',
        'workspace',
        new AbortController().signal,
        send
      )
    ).resolves.toBeUndefined()
    expect(send).toHaveBeenCalledOnce()
  })

  it('denies tool execution when enterprise policy has not authorized it', async () => {
    const broker = new ToolApprovalBroker()
    await expect(
      broker.request(
        'policy',
        '90536266-3db8-4d64-969d-552635c3172e',
        'workspace',
        new AbortController().signal,
        vi.fn()
      )
    ).rejects.toThrow('企业策略尚未授权')
  })
})

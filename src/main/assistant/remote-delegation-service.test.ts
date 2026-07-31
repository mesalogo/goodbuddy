import { describe, expect, it, vi } from 'vitest'
import { RemoteDelegationService } from './remote-delegation-service'

describe('RemoteDelegationService', () => {
  it('polls a public HTTPS endpoint and posts a bounded result', async () => {
    const transport = vi
      .fn()
      .mockResolvedValueOnce({
        status: 200,
        body: JSON.stringify({
          id: '00000000-0000-4000-8000-000000000301',
          title: '远程摘要',
          prompt: '整理状态',
          workMode: 'ask'
        })
      })
      .mockResolvedValueOnce({ status: 204, body: '' })
    const onTask = vi.fn(async () => ({
      status: 'completed' as const,
      output: '完成'
    }))
    const service = new RemoteDelegationService({
      endpoint: 'https://delegate.example',
      token: 'test-token',
      lookup: async () => [{ address: '203.0.113.10', family: 4 }],
      transport,
      onTask
    })

    await service.pollOnce()

    expect(onTask).toHaveBeenCalledOnce()
    expect(transport).toHaveBeenLastCalledWith(
      expect.objectContaining({
        pathname:
          '/goodbuddy/tasks/00000000-0000-4000-8000-000000000301/result'
      }),
      expect.any(Object),
      'test-token',
      'POST',
      expect.any(AbortSignal),
      expect.stringContaining('"completed"')
    )
  })

  it('retries result delivery without executing the task twice', async () => {
    const task = {
      id: '00000000-0000-4000-8000-000000000302',
      title: '远程摘要',
      prompt: '整理状态',
      workMode: 'plan'
    }
    const transport = vi
      .fn()
      .mockResolvedValueOnce({
        status: 200,
        body: JSON.stringify(task)
      })
      .mockResolvedValueOnce({ status: 503, body: '' })
      .mockResolvedValueOnce({ status: 204, body: '' })
      .mockResolvedValueOnce({ status: 204, body: '' })
    const onTask = vi.fn(async () => ({
      status: 'completed' as const,
      output: '完成'
    }))
    const service = new RemoteDelegationService({
      endpoint: 'https://delegate.example',
      token: 'test-token',
      lookup: async () => [{ address: '203.0.113.10', family: 4 }],
      transport,
      onTask
    })

    await expect(service.pollOnce()).rejects.toThrow('结果提交失败')
    await service.pollOnce()

    expect(onTask).toHaveBeenCalledOnce()
    expect(
      transport.mock.calls.filter((call) => call[3] === 'POST')
    ).toHaveLength(2)
  })

  it('drains a durable outbox before accepting another task', async () => {
    const records = new Map<
      string,
      {
        status: 'pending' | 'delivered'
        result: {
          status: 'completed' | 'failed'
          output?: string
          error?: string
        }
      }
    >([
      [
        '00000000-0000-4000-8000-000000000303',
        {
          status: 'pending',
          result: { status: 'completed', output: '持久结果' }
        }
      ]
    ])
    const outbox = {
      listPending: () =>
        [...records.entries()]
          .filter(([, value]) => value.status === 'pending')
          .map(([taskId, value]) => ({ taskId, result: value.result })),
      getStatus: (taskId: string) => records.get(taskId)?.status,
      save: vi.fn(),
      markDelivered: (taskId: string) => {
        const value = records.get(taskId)
        if (value) {
          value.status = 'delivered'
        }
      }
    }
    const transport = vi
      .fn()
      .mockResolvedValueOnce({ status: 204, body: '' })
      .mockResolvedValueOnce({ status: 204, body: '' })
    const onTask = vi.fn()
    const service = new RemoteDelegationService({
      endpoint: 'https://delegate.example',
      token: 'test-token',
      lookup: async () => [{ address: '203.0.113.10', family: 4 }],
      transport,
      onTask,
      outbox
    })

    await service.pollOnce()

    expect(onTask).not.toHaveBeenCalled()
    expect(records.values().next().value?.status).toBe('delivered')
    expect(transport.mock.calls[0]?.[3]).toBe('POST')
  })

  it('aborts an active request when stopped', async () => {
    let observedSignal: AbortSignal | undefined
    const service = new RemoteDelegationService({
      endpoint: 'https://delegate.example',
      token: 'test-token',
      lookup: async () => [{ address: '203.0.113.10', family: 4 }],
      transport: async (_url, _address, _token, _method, signal) => {
        observedSignal = signal
        await new Promise<void>((_resolve, reject) => {
          signal.addEventListener(
            'abort',
            () => reject(signal.reason),
            { once: true }
          )
        })
        return { status: 204, body: '' }
      },
      onTask: vi.fn()
    })

    const polling = service.pollOnce()
    await vi.waitFor(() => expect(observedSignal).toBeDefined())
    service.stop()

    await expect(polling).rejects.toBeDefined()
    expect(observedSignal?.aborted).toBe(true)
  })

  it('rejects endpoints resolving to private networks', async () => {
    const service = new RemoteDelegationService({
      endpoint: 'https://delegate.example',
      token: 'test-token',
      lookup: async () => [{ address: '127.0.0.1', family: 4 }],
      transport: vi.fn(),
      onTask: vi.fn()
    })

    await expect(service.pollOnce()).rejects.toThrow('私有或不安全网络')
  })
})

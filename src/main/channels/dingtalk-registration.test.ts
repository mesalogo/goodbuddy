import { describe, expect, it, vi } from 'vitest'
import type { ChannelSettingsSnapshot } from '../../shared/channel-settings-contracts'
import { beginDingTalkRegistration, DingTalkRegistrationController, pollDingTalkRegistration } from './dingtalk-registration'

const session = { device_code: 'test-device', verification_uri_complete: 'https://login.dingtalk.com/test', interval: 0.001, expires_in: 30 }
const channels = { dingtalk: { clientId: 'ding-test', enabled: true, secretConfigured: true } } as ChannelSettingsSnapshot
function server(result: object) {
  return vi.fn<typeof fetch>(async input => new Response(JSON.stringify({ errcode: 0,
    ...(String(input).endsWith('/init') ? { nonce: 'test-nonce' } : String(input).endsWith('/begin') ? session : result)
  })))
}

describe('DingTalk registration', () => {
  it('uses the official device flow and only sends public state to the renderer', async () => {
    const fetchImpl = server({ status: 'SUCCESS', client_id: 'ding-test', client_secret: 'test-secret' })
    const save = vi.fn(async () => channels)
    const onChanged = vi.fn()
    const controller = new DingTalkRegistrationController({ fetch: fetchImpl, save, onChanged, assertWritable: async () => undefined })
    expect(await controller.start()).toMatchObject({ state: 'waiting', url: session.verification_uri_complete })
    await vi.waitFor(() => expect(controller.snapshot()).toMatchObject({ state: 'completed', channels }))
    expect(save).toHaveBeenCalledWith({ clientId: 'ding-test', clientSecret: 'test-secret' })
    expect(JSON.stringify(onChanged.mock.calls)).not.toContain('test-secret')
    expect(JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body))).toEqual({ source: 'DING_DWS_CLAW' })
    expect(JSON.parse(String(fetchImpl.mock.calls[1]?.[1]?.body))).toEqual({ nonce: 'test-nonce' })
    expect(JSON.parse(String(fetchImpl.mock.calls[2]?.[1]?.body))).toEqual({ device_code: 'test-device' })
    await controller.dispose()
  })

  it.each(['EXPIRED', 'FAIL', 'unknown'])('reports %s without saving credentials', async status => {
    await expect(pollDingTalkRegistration(server({ status }), session, new AbortController().signal)).rejects.toThrow()
  })

  it('rejects success without credentials', async () => {
    await expect(pollDingTalkRegistration(server({ status: 'SUCCESS' }), session, new AbortController().signal)).rejects.toThrow('未返回完整应用凭据')
  })

  it('cancels waiting and ignores late success', async () => {
    let respond!: (response: Response) => void
    const fetchImpl = server({})
    fetchImpl.mockImplementation(async input => String(input).endsWith('/poll')
      ? new Promise(resolve => { respond = resolve })
      : new Response(JSON.stringify({ errcode: 0, ...(String(input).endsWith('/init') ? { nonce: 'n' } : session) })))
    const save = vi.fn(async () => channels)
    const controller = new DingTalkRegistrationController({ fetch: fetchImpl, save, onChanged: vi.fn(), assertWritable: async () => undefined })
    await controller.start()
    await vi.waitFor(() => expect(respond).toBeTypeOf('function'))
    await controller.cancel()
    respond(new Response(JSON.stringify({ errcode: 0, status: 'SUCCESS', client_id: 'ding-test', client_secret: 'secret' })))
    await controller.dispose()
    expect(controller.snapshot().state).toBe('idle')
    expect(save).not.toHaveBeenCalled()
  })

  it('waits for an in-progress save before cancellation settles and redacts errors', async () => {
    let rejectSave!: (error: Error) => void
    const controller = new DingTalkRegistrationController({ fetch: server({ status: 'SUCCESS', client_id: 'ding-test', client_secret: 'test-secret' }),
      save: () => new Promise((_, reject) => { rejectSave = reject }), onChanged: vi.fn(), assertWritable: async () => undefined })
    await controller.start()
    await vi.waitFor(() => expect(controller.snapshot().state).toBe('saving'))
    const cancelled = controller.cancel()
    rejectSave(new Error('cannot save test-secret'))
    expect(await cancelled).toMatchObject({ state: 'failed', message: 'cannot save ***' })
    await controller.dispose()
  })

  it('does not request a code for environment-owned settings', async () => {
    const fetchImpl = server({})
    const controller = new DingTalkRegistrationController({ fetch: fetchImpl, save: vi.fn(), onChanged: vi.fn(),
      assertWritable: async () => { throw new Error('由环境变量配置') } })
    expect(await controller.start()).toMatchObject({ state: 'failed', message: '由环境变量配置' })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('retains HTTP and provider failure context', async () => {
    await expect(beginDingTalkRegistration(vi.fn(async () => new Response('', { status: 503 })), new AbortController().signal)).rejects.toThrow('503')
    await expect(beginDingTalkRegistration(vi.fn(async () => new Response(JSON.stringify({ errcode: 42, errmsg: 'registration unavailable' }))), new AbortController().signal)).rejects.toThrow('registration unavailable')
  })
})

import { describe, expect, it, vi } from 'vitest'
import { beginWecomBotRegistration, pollWecomBotRegistration, registeredBotFromQuery } from './wecom-bot-registration'
import { wecomWhoamiUserId } from './wecom-cli-service'

describe('WeCom bot registration', () => {
  it('starts a session with the same request as wecom-cli and falls back to the native scan URL', async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ data: { scode: 'S1-x' } })))
    const session = await beginWecomBotRegistration(fetch, 'win32')
    expect(fetch).toHaveBeenCalledWith('https://work.weixin.qq.com/ai/qc/generate?source=wecom_cli_external&plat=win', expect.anything())
    expect(session).toEqual({
      scode: 'S1-x',
      url: 'https://work.weixin.qq.com/ai/qc/c?s=S1-x&hide_more_btn=true&for_native=true',
      webUrl: 'https://work.weixin.qq.com/ai/qc/gen?source=wecom_cli_external&scode=S1-x'
    })
  })

  it('rejects a foreign auth_url and a missing scan code', async () => {
    const foreign = vi.fn(async () => new Response(JSON.stringify({ data: { scode: 'abcd', auth_url: 'https://evil.example/x' } })))
    expect((await beginWecomBotRegistration(foreign, 'linux')).url).toBe('https://work.weixin.qq.com/ai/qc/c?s=abcd&hide_more_btn=true&for_native=true')
    const empty = vi.fn(async () => new Response(JSON.stringify({ data: {} })))
    await expect(beginWecomBotRegistration(empty, 'darwin')).rejects.toThrow('扫码会话')
  })

  it('reads the bot from either field name', () => {
    expect(registeredBotFromQuery({ data: { bot_info: { botid: 'a', secret: 'b' } } })).toEqual({ botId: 'a', secret: 'b' })
    expect(registeredBotFromQuery({ data: { bot_info: { bot_id: 'a', secret: 'b' } } })).toEqual({ botId: 'a', secret: 'b' })
    expect(registeredBotFromQuery({ data: { status: 'init' } })).toBeUndefined()
  })

  it('keeps polling through network errors until the bot arrives', async () => {
    let calls = 0
    const fetch = vi.fn(async () => {
      calls += 1
      if (calls === 1) throw new Error('offline')
      if (calls === 2) return new Response(JSON.stringify({ data: { status: 'init' } }))
      return new Response(JSON.stringify({ data: { bot_info: { botid: 'a', secret: 'b' } } }))
    })
    const outcome = await pollWecomBotRegistration({ fetch, scode: 'x', signal: new AbortController().signal, intervalMs: 1 })
    expect(outcome).toEqual({ status: 'success', bot: { botId: 'a', secret: 'b' } })
  })

  it('finds the authorizer userid in whoami output', () => {
    expect(wecomWhoamiUserId('{"user":{"userid":"zhangsan"}}')).toBe('zhangsan')
    expect(wecomWhoamiUserId('{"data":{"user_id":"li.si"}}')).toBe('li.si')
    expect(wecomWhoamiUserId('not json')).toBeUndefined()
  })
})

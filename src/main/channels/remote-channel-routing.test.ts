import { describe, expect, it } from 'vitest'
import {
  parseRemoteChannelPrompt,
  requestsRemoteResultFile
} from './remote-channel-routing'
import { projectChannelLabels } from '../../shared/assistant-contracts'

describe('parseRemoteChannelPrompt', () => {
  it('trims the prompt without adding a mode', () => {
    expect(
      parseRemoteChannelPrompt('  请整理下载目录  ')
    ).toEqual({
      prompt: '请整理下载目录'
    })
    expect(parseRemoteChannelPrompt('总结进展')).toEqual({
      prompt: '总结进展'
    })
  })

  it.each([
    '/ask 请只读分析',
    '/execute: 创建文件',
    '/exec 执行测试',
    '对话：解释错误',
    '问答：解释错误',
    '执行: 更新依赖',
    '/ask',
    '/execute'
  ] as const)(
    'preserves former mode prefix as literal text: %s',
    (text) => {
      expect(parseRemoteChannelPrompt(text)).toEqual({
        prompt: text
      })
    }
  )

  it('rejects an empty request', () => {
    expect(() => parseRemoteChannelPrompt('  ')).toThrow(
      '远程请求内容不能为空'
    )
  })

  it('requires an explicit downloadable file request', () => {
    expect(requestsRemoteResultFile('请生成一个文件，总结今天的进展')).toBe(
      true
    )
    expect(
      requestsRemoteResultFile('Please export the result as a file')
    ).toBe(true)
    expect(requestsRemoteResultFile('请总结今天的进展')).toBe(false)
  })

  it('defines a stable product label for every managed channel', () => {
    expect(projectChannelLabels).toEqual({
      weixin: '微信 ClawBot',
      wecom: '企业微信',
      dingtalk: '钉钉',
      telegram: 'Telegram'
    })
  })
})

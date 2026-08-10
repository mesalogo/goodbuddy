import { describe, expect, it } from 'vitest'
import {
  parseRemoteChannelPrompt,
  requestsRemoteResultFile
} from './remote-channel-routing'
import { projectChannelLabels } from '../../shared/assistant-contracts'

describe('parseRemoteChannelPrompt', () => {
  it('uses the channel project default mode without changing the prompt', () => {
    expect(
      parseRemoteChannelPrompt('  请整理下载目录  ', 'execute')
    ).toEqual({
      workMode: 'execute',
      prompt: '请整理下载目录'
    })
    expect(parseRemoteChannelPrompt('总结进展', 'ask')).toEqual({
      workMode: 'ask',
      prompt: '总结进展'
    })
  })

  it.each([
    ['/ask 请只读分析', 'ask', '请只读分析'],
    ['/execute: 创建文件', 'execute', '创建文件'],
    ['/exec 执行测试', 'execute', '执行测试'],
    ['对话：解释错误', 'ask', '解释错误'],
    ['执行: 更新依赖', 'execute', '更新依赖']
  ] as const)(
    'parses explicit mode prefix %s',
    (text, workMode, prompt) => {
      expect(parseRemoteChannelPrompt(text, 'ask')).toEqual({
        workMode,
        prompt
      })
    }
  )

  it('rejects a prefix without a request body', () => {
    expect(() => parseRemoteChannelPrompt('/execute', 'ask')).toThrow(
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
      dingtalk: '钉钉'
    })
  })
})

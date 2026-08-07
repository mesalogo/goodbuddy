import { describe, expect, it } from 'vitest'
import { ReasoningTagStreamParser } from './reasoning-stream'

describe('ReasoningTagStreamParser', () => {
  it('separates think and thinking blocks from final text', () => {
    const parser = new ReasoningTagStreamParser()

    expect(
      parser.push(
        '开头<think>分析一</think>中间<thinking>分析二</thinking>结尾'
      )
    ).toEqual([
      { type: 'text', delta: '开头' },
      { type: 'reasoning', delta: '分析一' },
      { type: 'text', delta: '中间' },
      { type: 'reasoning', delta: '分析二' },
      { type: 'text', delta: '结尾' }
    ])
    expect(parser.finish()).toEqual([])
  })

  it('handles tags split across streaming chunks', () => {
    const parser = new ReasoningTagStreamParser()

    expect(parser.push('回答前<thi')).toEqual([
      { type: 'text', delta: '回答前' }
    ])
    expect(parser.push('nk>逐步分析</th')).toEqual([
      { type: 'reasoning', delta: '逐步分析' }
    ])
    expect(parser.push('ink>最终答案')).toEqual([
      { type: 'text', delta: '最终答案' }
    ])
    expect(parser.finish()).toEqual([])
  })

  it('keeps an unclosed reasoning block as reasoning', () => {
    const parser = new ReasoningTagStreamParser()

    expect(parser.push('<THINKING>仍在分析')).toEqual([
      { type: 'reasoning', delta: '仍在分析' }
    ])
    expect(parser.finish()).toEqual([])
  })
})

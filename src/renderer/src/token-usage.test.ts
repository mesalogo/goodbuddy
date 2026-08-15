import { describe, expect, it } from 'vitest'
import type { TokenUsageSummary } from '../../shared/assistant-contracts'
import {
  getTokenUsageTotals,
  groupTokenUsage
} from './token-usage'

function makeTokenUsage(): TokenUsageSummary {
  return {
    totals: {
      callCount: 2,
      input: 112,
      output: 23,
      cacheRead: 40,
      cacheWrite: 10,
      totalTokens: 999
    },
    records: [
      {
        requestId: 'request-1',
        projectId: 'project-1',
        projectName: '项目一',
        conversationId: 'conversation-1',
        conversationTitle: '会话一',
        runtime: 'model',
        provider: 'openai',
        model: 'gpt-5',
        callCount: 1,
        input: 100,
        output: 20,
        cacheRead: 40,
        cacheWrite: 10,
        totalTokens: 999
      },
      {
        requestId: 'request-2',
        projectId: 'project-1',
        projectName: '项目一',
        conversationId: 'conversation-2',
        conversationTitle: '会话二',
        runtime: 'model',
        provider: 'openai',
        model: 'gpt-5',
        callCount: 1,
        input: 12,
        output: 3,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 999
      }
    ]
  }
}

describe('token usage aggregation', () => {
  it('groups records and keeps cache tokens out of total tokens', () => {
    const usage = makeTokenUsage()

    expect(getTokenUsageTotals(usage)).toEqual({
      inputTokens: 112,
      outputTokens: 23,
      cacheReadTokens: 40,
      cacheWriteTokens: 10,
      cacheInputTokens: 112,
      cacheHitRate: 40 / 112,
      totalTokens: 135
    })
    expect(groupTokenUsage(usage, 'project')).toEqual([
      {
        key: 'project:project-1:runtime:model:model:gpt-5',
        label: '项目一',
        model: 'gpt-5',
        runtime: 'model',
        inputTokens: 112,
        outputTokens: 23,
        cacheReadTokens: 40,
        cacheWriteTokens: 10,
        cacheInputTokens: 112,
        cacheHitRate: 40 / 112,
        totalTokens: 135
      }
    ])
    expect(groupTokenUsage(usage, 'conversation')).toHaveLength(2)
    expect(groupTokenUsage(usage, 'model')).toEqual([
      expect.objectContaining({
        label: 'gpt-5',
        runtime: 'model',
        totalTokens: 135
      })
    ])
  })

  it('normalizes cache hit rate for OpenAI and Anthropic input usage', () => {
    const usage = makeTokenUsage()
    usage.records = [
      {
        ...usage.records[0]!,
        provider: 'openai',
        input: 100,
        cacheRead: 40,
        cacheWrite: 10
      },
      {
        ...usage.records[1]!,
        provider: 'goodbuddy-anthropic',
        model: 'claude-sonnet',
        input: 50,
        cacheRead: 30,
        cacheWrite: 20
      }
    ]

    const rows = groupTokenUsage(usage, 'model')

    expect(rows.find((row) => row.label === 'gpt-5')).toMatchObject({
      cacheInputTokens: 100,
      cacheHitRate: 0.4
    })
    expect(
      rows.find((row) => row.label === 'claude-sonnet')
    ).toMatchObject({
      cacheInputTokens: 100,
      cacheHitRate: 0.3
    })
  })

  it('uses fallback labels when grouping metadata is unavailable', () => {
    const usage = makeTokenUsage()
    usage.records = [
      {
        ...usage.records[0]!,
        projectId: undefined,
        projectName: undefined,
        conversationId: '',
        conversationTitle: undefined,
        provider: '',
        model: ''
      }
    ]

    expect(groupTokenUsage(usage, 'project')[0]?.label).toBe('')
    expect(groupTokenUsage(usage, 'conversation')[0]?.label).toBe('')
    expect(groupTokenUsage(usage, 'model')[0]?.label).toBe('')
  })

  it('keeps project and conversation totals separated by model', () => {
    const usage = makeTokenUsage()
    usage.records.push({
      ...usage.records[0]!,
      requestId: 'request-3',
      provider: 'anthropic',
      model: 'claude-sonnet',
      input: 7,
      output: 2
    })

    expect(groupTokenUsage(usage, 'project')).toHaveLength(2)
    expect(groupTokenUsage(usage, 'conversation')).toHaveLength(3)
  })

  it('groups identical model names by Runtime instead of provider', () => {
    const usage = makeTokenUsage()
    usage.records = [
      {
        ...usage.records[0]!,
        provider: 'openai',
        runtime: 'model',
        model: 'deepseek-v4-flash'
      },
      {
        ...usage.records[1]!,
        provider: 'goodbuddy',
        runtime: 'deepseek-harness',
        model: 'deepseek-v4-flash'
      }
    ]

    expect(groupTokenUsage(usage, 'model')).toEqual([
      expect.objectContaining({
        key: 'runtime:model:model:deepseek-v4-flash',
        label: 'deepseek-v4-flash',
        runtime: 'model'
      }),
      expect.objectContaining({
        key: 'runtime:deepseek-harness:model:deepseek-v4-flash',
        label: 'deepseek-v4-flash',
        runtime: 'deepseek-harness'
      })
    ])
  })
})

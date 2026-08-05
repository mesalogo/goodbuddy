import { describe, expect, it } from 'vitest'
import type { AssistantExpert } from '../../shared/assistant-contracts'
import { routeSubagent } from './subagent-router'

function expert(
  id: string,
  createdAt: string,
  routingKeywords: string[]
): AssistantExpert {
  return {
    id,
    name: id,
    description: '',
    systemInstructions: 'Be helpful.',
    routingKeywords,
    enabled: true,
    createdAt,
    updatedAt: createdAt
  }
}

describe('routeSubagent', () => {
  it('normalizes NFKC text and scores first-line English tokens', () => {
    const writing = expert(
      '00000000-0000-4000-8000-000000000001',
      '2026-01-01T00:00:00.000Z',
      ['write']
    )
    expect(routeSubagent('ＷＲＩＴＥ a release note', [writing])).toEqual({
      expert: writing,
      score: 6,
      matches: 1
    })
  })

  it('routes a strong Chinese substring match and requires a clear lead', () => {
    const research = expert(
      '00000000-0000-4000-8000-000000000001',
      '2026-01-01T00:00:00.000Z',
      ['资料分析']
    )
    const planning = expert(
      '00000000-0000-4000-8000-000000000002',
      '2026-01-02T00:00:00.000Z',
      ['项目规划']
    )
    expect(routeSubagent('请做资料分析\n并说明证据', [
      planning,
      research
    ])?.expert).toBe(research)
    expect(routeSubagent('资料分析和项目规划', [
      research,
      planning
    ])).toBeUndefined()
  })

  it('uses deterministic createdAt and id ordering before applying ambiguity', () => {
    const first = expert(
      '00000000-0000-4000-8000-000000000001',
      '2026-01-01T00:00:00.000Z',
      ['research']
    )
    const second = expert(
      '00000000-0000-4000-8000-000000000002',
      '2026-01-02T00:00:00.000Z',
      ['research']
    )
    expect(routeSubagent('research this', [second, first])).toBeUndefined()
  })
})

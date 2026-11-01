import { describe, expect, it, vi } from 'vitest'
import { selectRoleWithSystemOne } from './system-one-role-selector'

vi.mock('../agent/system-one-service', () => ({
  requestSystemOne: vi.fn()
}))

import { requestSystemOne } from '../agent/system-one-service'

const experts = [
  { id: 'programming', name: '编程', description: '编写和排查代码', systemInstructions: 'code', routingKeywords: [], enabled: true, createdAt: '', updatedAt: '' },
  { id: 'research', name: '研究', description: '检索和分析资料', systemInstructions: 'research', routingKeywords: [], enabled: true, createdAt: '', updatedAt: '' }
]

describe('selectRoleWithSystemOne', () => {
  it('accepts a confident valid role', async () => {
    vi.mocked(requestSystemOne).mockResolvedValueOnce({
      model: 'd3',
      answers: { role: { type: 'choice', choice: 'programming', probabilities: { programming: 0.9, research: 0.1 }, confidence: 0.9 } },
      usage: { input_tokens: 10, output_tokens: 0 }
    })
    const result = await selectRoleWithSystemOne('fix this bug', experts, {
      roleSelectionModelProfileId: 'system-one',
      modelProfiles: [{ id: 'system-one', name: 'd3', baseUrl: 'http://localhost', modelName: 'd3', protocol: 'system-one', authentication: 'none' }]
    }, new AbortController().signal)
    expect(result?.expert.id).toBe('programming')
  })

  it('falls back when the choice is uncertain', async () => {
    vi.mocked(requestSystemOne).mockResolvedValueOnce({
      model: 'd3',
      answers: { role: { type: 'choice', choice: 'programming', probabilities: { programming: 0.51, research: 0.49 }, confidence: 0.51 } },
      usage: { input_tokens: 10, output_tokens: 0 }
    })
    await expect(selectRoleWithSystemOne('ambiguous task', experts, {
      roleSelectionModelProfileId: 'system-one',
      modelProfiles: [{ id: 'system-one', name: 'd3', baseUrl: 'http://localhost', modelName: 'd3', protocol: 'system-one', authentication: 'none' }]
    }, new AbortController().signal)).resolves.toBeUndefined()
  })
})

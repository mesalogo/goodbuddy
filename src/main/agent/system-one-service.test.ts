import { describe, expect, it, vi } from 'vitest'
import { requestSystemOne } from './system-one-service'

const profile = {
  id: 'profile', name: 'System One', baseUrl: 'http://127.0.0.1:11434',
  modelName: 'd3', protocol: 'system-one' as const, authentication: 'none' as const
}

describe('requestSystemOne', () => {
  it('posts a typed request and parses the structured response', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => Response.json({
      model: 'd3', answers: { role: { type: 'choice', choice: 'programming', probabilities: { programming: 1 }, confidence: 1 } },
      usage: { input_tokens: 4, output_tokens: 0 }
    }))
    const result = await requestSystemOne(profile, {
      model: 'ignored', state: 'write code', questions: {
        role: { type: 'choice', instructions: 'choose', criteria: { programming: 'code', research: 'research' } }
      }
    }, new AbortController().signal, fetcher)
    expect(result.answers.role?.choice).toBe('programming')
    expect(fetcher).toHaveBeenCalledWith(
      'http://127.0.0.1:11434/v1/systemone',
      expect.objectContaining({ method: 'POST' })
    )
    const init = fetcher.mock.calls[0]![1]!
    expect(JSON.parse(String(init.body)).model).toBe('d3')
  })
})

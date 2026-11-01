import { describe, expect, it } from 'vitest'
import {
  systemOneEndpoint,
  systemOneRequestSchema,
  systemOneResponseSchema
} from './system-one-contracts'

describe('System One contracts', () => {
  it('normalizes root and v1 endpoints', () => {
    expect(systemOneEndpoint('http://127.0.0.1:11434')).toBe(
      'http://127.0.0.1:11434/v1/systemone'
    )
    expect(systemOneEndpoint('http://127.0.0.1:11434/v1')).toBe(
      'http://127.0.0.1:11434/v1/systemone'
    )
  })

  it('validates typed questions and responses', () => {
    expect(systemOneRequestSchema.safeParse({
      model: 'd3',
      state: '重复扣费，请退款',
      questions: {
        refund: {
          type: 'noul',
          instructions: '用户是否在申请退款？'
        }
      }
    }).success).toBe(true)
    expect(systemOneResponseSchema.safeParse({
      model: 'd3',
      answers: { refund: { type: 'noul', noul: 0.99 } },
      usage: { input_tokens: 10, output_tokens: 0 }
    }).success).toBe(true)
  })
})

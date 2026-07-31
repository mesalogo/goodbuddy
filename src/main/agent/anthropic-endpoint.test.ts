import { describe, expect, it } from 'vitest'
import {
  createAnthropicApiBaseUrl,
  createAnthropicMessagesUrl
} from './anthropic-endpoint'

describe('Anthropic endpoint normalization', () => {
  it.each([
    ['https://model.example', 'https://model.example/v1'],
    ['https://model.example/', 'https://model.example/v1'],
    ['https://model.example/v1', 'https://model.example/v1'],
    ['https://model.example/proxy/', 'https://model.example/proxy/v1']
  ])('normalizes %s to an API root', (input, expected) => {
    expect(createAnthropicApiBaseUrl(input)).toBe(expected)
  })

  it('creates the messages endpoint without duplicating v1', () => {
    expect(
      createAnthropicMessagesUrl('https://model.example/v1').toString()
    ).toBe('https://model.example/v1/messages')
  })
})

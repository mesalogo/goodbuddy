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

  it('keeps a gateway query and intranet path prefix on the request URL', () => {
    expect(
      createAnthropicMessagesUrl(
        'http://10.0.0.5:8000/gateway?api-version=2024-02-01'
      ).toString()
    ).toBe(
      'http://10.0.0.5:8000/gateway/v1/messages?api-version=2024-02-01'
    )
  })
})

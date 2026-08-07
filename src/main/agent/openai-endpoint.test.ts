import { describe, expect, it } from 'vitest'
import {
  createOpenAIApiBaseUrl,
  createOpenAIChatCompletionsUrl,
  createOpenAIImagesGenerationsUrl,
  createOpenAIResponsesUrl
} from './openai-endpoint'

describe('OpenAI endpoint normalization', () => {
  it.each([
    ['https://model.example/v1', 'https://model.example/v1'],
    ['https://model.example/v1/', 'https://model.example/v1'],
    ['http://10.0.0.5:8000/proxy/v1', 'http://10.0.0.5:8000/proxy/v1']
  ])('normalizes %s to an API root', (input, expected) => {
    expect(createOpenAIApiBaseUrl(input)).toBe(expected)
  })

  it('appends API paths onto an intranet path prefix', () => {
    const baseUrl = 'http://192.168.1.50:8000/openai/v1'
    expect(createOpenAIChatCompletionsUrl(baseUrl).toString()).toBe(
      'http://192.168.1.50:8000/openai/v1/chat/completions'
    )
    expect(createOpenAIResponsesUrl(baseUrl).toString()).toBe(
      'http://192.168.1.50:8000/openai/v1/responses'
    )
    expect(createOpenAIImagesGenerationsUrl(baseUrl).toString()).toBe(
      'http://192.168.1.50:8000/openai/v1/images/generations'
    )
  })

  it('preserves a gateway query on base and request URLs', () => {
    const baseUrl = 'https://gateway.example/v1?api-version=2024-02-01'
    expect(createOpenAIApiBaseUrl(baseUrl)).toBe(
      'https://gateway.example/v1?api-version=2024-02-01'
    )
    expect(createOpenAIChatCompletionsUrl(baseUrl).toString()).toBe(
      'https://gateway.example/v1/chat/completions?api-version=2024-02-01'
    )
  })
})

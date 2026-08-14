import { describe, expect, it } from 'vitest'
import {
  isDeepSeekHarnessCompatibleBaseUrl,
  isDeepSeekHarnessModelProfile
} from './deepseek-harness-compatibility'

describe('DeepSeek Harness model compatibility', () => {
  it.each([
    'https://api.deepseek.com',
    'https://gateway.example/openai/v1',
    'https://gateway.example:8443/v1',
    'http://127.0.0.1:11434/v1',
    'http://localhost:1234/v1',
    'http://[::1]:8080/v1'
  ])('accepts OpenAI-compatible base URL %s', (baseUrl) => {
    expect(isDeepSeekHarnessCompatibleBaseUrl(baseUrl)).toBe(true)
    expect(
      isDeepSeekHarnessModelProfile({
        baseUrl,
        protocol: 'openai-chat-completions',
        authentication: 'api-key'
      })
    ).toBe(true)
  })

  it.each([
    'http://gateway.example/v1',
    'file:///private/config',
    'https://user:secret@gateway.example/v1',
    'https://gateway.example/v1?api-version=2025-01-01',
    'https://gateway.example/v1#chat'
  ])('rejects unsafe or unsupported base URL %s', (baseUrl) => {
    expect(isDeepSeekHarnessCompatibleBaseUrl(baseUrl)).toBe(false)
  })

  it('rejects other protocols and unauthenticated profiles', () => {
    expect(
      isDeepSeekHarnessModelProfile({
        baseUrl: 'https://gateway.example/v1',
        protocol: 'openai-responses',
        authentication: 'api-key'
      })
    ).toBe(false)
    expect(
      isDeepSeekHarnessModelProfile({
        baseUrl: 'https://gateway.example/v1',
        protocol: 'openai-chat-completions',
        authentication: 'none'
      })
    ).toBe(false)
  })
})

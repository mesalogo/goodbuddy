import { describe, expect, it } from 'vitest'
import { safeToolArgumentSummary } from './approval-summary'

describe('safeToolArgumentSummary', () => {
  it('redacts nested sensitive fields', () => {
    expect(
      safeToolArgumentSummary({
        command: 'deploy',
        options: {
          apiKey: 'secret-value',
          nested: { authorization: 'Bearer token-value' }
        }
      })
    ).toBe(
      '{"command":"deploy","options":{"apiKey":"[REDACTED]","nested":{"authorization":"[REDACTED]"}}}'
    )
  })

  it('redacts secrets in tool previews and bounds output', () => {
    expect(
      safeToolArgumentSummary(
        {},
        [{ content: 'curl -H "Authorization: Bearer secret-token"' }],
        80
      )
    ).not.toContain('secret-token')
  })
})

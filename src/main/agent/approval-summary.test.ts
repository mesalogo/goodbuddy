import { describe, expect, it } from 'vitest'
import {
  safeToolArgumentSummary,
  safeToolErrorDetail
} from './approval-summary'

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

describe('safeToolErrorDetail', () => {
  it('extracts nested runtime errors while redacting secrets', () => {
    expect(
      safeToolErrorDetail([
        {
          content:
            'exit code 1\nAuthorization: Bearer secret-token'
        }
      ])
    ).toBe('exit code 1\nAuthorization: [REDACTED]')
    expect(
      safeToolErrorDetail({
        message:
          '{"token":"json-secret","authorization":"Basic abc123"}'
      })
    ).toBe(
      '{"token":"[REDACTED]","authorization":"[REDACTED]"}'
    )
  })

  it('bounds output and ignores unrelated provider payload fields', () => {
    expect(
      safeToolErrorDetail(
        {
          content: 'parser failure '.repeat(20),
          privateDocument: 'must not be returned'
        },
        40
      )
    ).toHaveLength(40)
    expect(
      safeToolErrorDetail({
        privateDocument: 'must not be returned'
      })
    ).toBeUndefined()
  })
})

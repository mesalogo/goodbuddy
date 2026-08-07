import { describe, expect, it } from 'vitest'
import {
  boundedToolDetail,
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

describe('boundedToolDetail', () => {
  it('preserves conversation details verbatim while bounding output', () => {
    expect(
      boundedToolDetail(
        {
          command: 'npm test',
          token: 'secret-token',
          output: 'Authorization: Bearer inline-secret'
        },
        1_000
      )
    ).toBe(
      '{\n  "command": "npm test",\n  "token": "secret-token",\n  "output": "Authorization: Bearer inline-secret"\n}'
    )
    expect(
      boundedToolDetail('  exact output\r\n', 1_000)
    ).toBe('  exact output\r\n')
    expect(boundedToolDetail('x'.repeat(100), 20)).toHaveLength(20)
  })
})

describe('safeToolErrorDetail', () => {
  it('extracts nested runtime errors without rewriting their contents', () => {
    expect(
      safeToolErrorDetail([
        {
          content:
            'exit code 1\nAuthorization: Bearer secret-token'
        }
      ])
    ).toBe('exit code 1\nAuthorization: Bearer secret-token')
    expect(
      safeToolErrorDetail({
        message:
          '{"token":"json-secret","authorization":"Basic abc123"}'
      })
    ).toBe(
      '{"token":"json-secret","authorization":"Basic abc123"}'
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

  it('includes nested fetch causes and network diagnostics', () => {
    const cause = Object.assign(
      new Error('connect ECONNREFUSED 127.0.0.1:11434'),
      {
        code: 'ECONNREFUSED',
        errno: -4078,
        syscall: 'connect',
        address: '127.0.0.1',
        port: 11434
      }
    )
    const error = new TypeError('fetch failed', { cause })

    expect(safeToolErrorDetail(error)).toBe(
      [
        'fetch failed',
        'cause:',
        'connect ECONNREFUSED 127.0.0.1:11434',
        'code: ECONNREFUSED',
        'errno: -4078',
        'syscall: connect',
        'address: 127.0.0.1',
        'port: 11434'
      ].join('\n')
    )
  })
})

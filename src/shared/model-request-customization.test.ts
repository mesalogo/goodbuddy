import { describe, expect, it } from 'vitest'
import {
  canonicalModelRequestHeaders,
  mergeModelRequestBody,
  mergeModelRequestHeaders,
  modelRequestBodySchema,
  modelRequestHeadersSchema
} from './model-request-customization'

describe('model request customization', () => {
  it('accepts bounded custom headers and rejects reserved or ambiguous names', () => {
    expect(
      modelRequestHeadersSchema.parse({
        'x-tenant-id': 'tenant-a',
        'x-routing-mode': ''
      })
    ).toEqual({
      'x-tenant-id': 'tenant-a',
      'x-routing-mode': ''
    })
    expect(() =>
      modelRequestHeadersSchema.parse({
        Authorization: 'Bearer replacement'
      })
    ).toThrow()
    expect(() =>
      modelRequestHeadersSchema.parse({
        'X-Tenant': 'one',
        'x-tenant': 'two'
      })
    ).toThrow()
  })

  it('accepts bounded JSON bodies and rejects reserved top-level fields', () => {
    expect(
      modelRequestBodySchema.parse({
        temperature: 0.2,
        metadata: {
          trace: true,
          tags: ['internal', null]
        }
      })
    ).toMatchObject({
      temperature: 0.2,
      metadata: { trace: true }
    })
    expect(() =>
      modelRequestBodySchema.parse({ model: 'replacement' })
    ).toThrow()
    expect(() =>
      modelRequestBodySchema.parse({ tools: [] })
    ).toThrow()
    expect(() =>
      modelRequestBodySchema.parse({
        oversized: 'x'.repeat(32_769)
      })
    ).toThrow()
    expect(() =>
      modelRequestHeadersSchema.parse(
        Object.fromEntries(
          Array.from({ length: 65 }, (_, index) => [
            `x-header-${index}`,
            'value'
          ])
        )
      )
    ).toThrow()
  })

  it('lets runtime headers and top-level body fields take precedence', () => {
    const headers = mergeModelRequestHeaders(
      {
        'x-tenant': 'custom',
        accept: 'text/plain'
      },
      {
        Accept: 'application/json',
        'content-type': 'application/json'
      }
    )
    expect(Object.fromEntries(headers.entries())).toEqual({
      accept: 'application/json',
      'content-type': 'application/json',
      'x-tenant': 'custom'
    })
    expect(canonicalModelRequestHeaders(headers)).toEqual({
      accept: 'application/json',
      'content-type': 'application/json',
      'x-tenant': 'custom'
    })

    expect(
      mergeModelRequestBody(
        {
          temperature: 0.2,
          metadata: { source: 'custom' }
        },
        {
          temperature: 0.8,
          model: 'runtime-model'
        }
      )
    ).toEqual({
      temperature: 0.8,
      metadata: { source: 'custom' },
      model: 'runtime-model'
    })
  })
})

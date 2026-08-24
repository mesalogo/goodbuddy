import { describe, expect, it } from 'vitest'
import {
  REMOTE_MODEL_GATEWAY_LIMITS,
  remoteModelGatewayRequestSchema,
  remoteModelGatewayResponseSchema
} from './remote-model-gateway-contracts'

const validRequest = {
  method: 'POST',
  path: '/v1/messages',
  headers: {
    accept: 'application/json',
    'content-type': 'application/json'
  },
  bodyBase64: Buffer.from('{"messages":[]}').toString('base64')
} as const

describe('remote model gateway contracts', () => {
  it('accepts only POST requests to fixed provider API paths', () => {
    expect(remoteModelGatewayRequestSchema.parse(validRequest)).toEqual(
      validRequest
    )
    for (const path of [
      'https://api.example/v1/messages',
      '//api.example/v1/messages',
      '/v1/messages?key=secret',
      '/v1/messages#fragment',
      '/v1/../messages',
      '/images/generations'
    ]) {
      expect(() =>
        remoteModelGatewayRequestSchema.parse({ ...validRequest, path })
      ).toThrow()
    }
    expect(() =>
      remoteModelGatewayRequestSchema.parse({
        ...validRequest,
        method: 'GET'
      })
    ).toThrow()
  })

  it('rejects credentials and arbitrary headers', () => {
    for (const headers of [
      { authorization: 'Bearer remote-secret' },
      { 'x-api-key': 'remote-secret' },
      { cookie: 'private=value' },
      { Accept: 'application/json' },
      { accept: 'ok\r\nx-injected: true' }
    ]) {
      expect(() =>
        remoteModelGatewayRequestSchema.parse({ ...validRequest, headers })
      ).toThrow()
    }
  })

  it('enforces decoded byte limits and canonical base64', () => {
    expect(() =>
      remoteModelGatewayRequestSchema.parse({
        ...validRequest,
        bodyBase64: Buffer.alloc(
          REMOTE_MODEL_GATEWAY_LIMITS.maximumRequestBodyBytes + 1
        ).toString('base64')
      })
    ).toThrow()
    expect(() =>
      remoteModelGatewayRequestSchema.parse({
        ...validRequest,
        bodyBase64: 'not base64'
      })
    ).toThrow()
    expect(() =>
      remoteModelGatewayResponseSchema.parse({
        status: 200,
        headers: { authorization: 'Bearer secret' },
        bodyBase64: ''
      })
    ).toThrow()
  })
})
